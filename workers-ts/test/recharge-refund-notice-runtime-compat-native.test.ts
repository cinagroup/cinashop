/** Complete real LOGIN compatibility after schema-only commissioning. No new
 * business notice/source row, source authority mock or permission grant. */
import { sql } from 'drizzle-orm';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { NOTICE_MAINTENANCE_BUDGET_SQL,runPaidNoticeUpgrade } from '@/migrations/paidNotice';
import { assertRechargeRefundRuntimeTx } from '@/migrations/rechargeRefund';
import { reviewedRuntimePricingCapabilities } from '@/migrations/reviewedRuntimePricingCapabilities';
import type { RechargeRefundPricingDeclaration } from '@/migrations/checkoutPricingLock';
import type { RoutinePaymentRuntimeTarget } from '@/migrations/routinePaymentRuntime';
import { runMembershipPaidNoticeUpgrade } from '@/migrations/membershipPaidNotice';
import { runRechargePaidNoticeUpgrade } from '@/migrations/rechargePaidNotice';
import { rechargeRefundNoticeCommissionedTx,runRechargeRefundNoticeUpgrade } from '@/migrations/rechargeRefundNotice';
import { inspectWithdrawalEffectsUpgrade,runWithdrawalEffectsUpgrade } from '@/migrations/runWithdrawalEffectsUpgrade';
import { runRoutineVirtualShippingSubjectsUpgrade } from '@/migrations/runRoutineVirtualShippingSubjectsUpgrade';
import { rechargeProfileKinds } from './helpers/rechargeRefundRuntimeProfileNative';
import { rechargeRefundNoticeStorageRuntimeFixture,type RechargeRefundNoticeStorageRuntimeFixture } from './helpers/rechargeRefundNoticeStorageRuntimeNative';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('recharge refund notice complete runtime compatibility',()=>{
 let f:RechargeRefundNoticeStorageRuntimeFixture,setup:Promise<void>|undefined,pending:Promise<unknown>|undefined,busy=false;
 let network:ReturnType<typeof vi.spyOn<typeof globalThis,'fetch'>>;
 const start=<T>(run:()=>Promise<T>)=>{if(busy)throw Error('Previous notice compatibility case pending');busy=true;
  const p=run().finally(()=>{busy=false;});pending=p;void p.catch(()=>undefined);return p;};
 beforeAll(async()=>{setup=(async()=>{network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No network in schema-only compatibility'));
  f=await rechargeRefundNoticeStorageRuntimeFixture();})();await setup;},240000);
 afterAll(async()=>{try{if(setup)await Promise.allSettled([setup]);if(pending)await Promise.allSettled([pending]);}
  finally{try{await f?.close();}finally{network?.mockRestore();}}},30000);

 // The commissioning fixture carries pricingOwner for its broader owner plan.
 // Direct pricing declarations contain only the explicit routine target contract.
 const target=():RoutinePaymentRuntimeTarget=>({
  database:f.target.database,maintenance:f.target.maintenance,app:f.target.app,admin:f.target.admin,
  ...(f.target.local?{local:[...f.target.local]}:{}),
  ...(f.target.caseLock?{caseLock:{owner:f.target.caseLock.owner,runtimeRoles:[...f.target.caseLock.runtimeRoles]}}:{}),
 });
 const declaration=():RechargeRefundPricingDeclaration=>({target:target(),addon:{rechargeRefund:true}});
 const pricing=(db:DbClient,scope:'shared-shop'|'isolated',declared?:RechargeRefundPricingDeclaration)=>db.transaction(async actual=>{
  const tx=actual as unknown as DbClient;await tx.execute(sql.raw(NOTICE_MAINTENANCE_BUDGET_SQL));
  return reviewedRuntimePricingCapabilities(tx,'public',scope,declared);
 },{isolationLevel:'repeatable read',accessMode:'read only'});
 it('requires explicit full recharge declaration in actual App nested pricing and retains exact original pricing OIDs',()=>start(async()=>{
  const before=await f.noticeSnapshot();
  expect(await pricing(f.appRuntime.db,'shared-shop')).toEqual({checkout:null,offline:null});
  const [oids]=await f.maintenanceDb.execute<{checkout:string;offline:string}>(sql`SELECT
   pg_catalog.to_regprocedure('public.checkout_lock_pricing_v1()')::oid::text AS checkout,
   pg_catalog.to_regprocedure('public.ooa_lock_pricing()')::oid::text AS offline`);
  expect(oids.checkout).toMatch(/^[0-9]+$/u);expect(oids.offline).toMatch(/^[0-9]+$/u);
  expect(await pricing(f.appRuntime.db,'shared-shop',declaration())).toEqual(oids);
  expect(await f.noticeSnapshot()).toBe(before);
 }),5000);
 it('refuses a differently bound recharge target without changing actual catalog or grants',()=>start(async()=>{
  const before=await f.noticeSnapshot(),declared=declaration();
  expect(await pricing(f.appRuntime.db,'shared-shop',{...declared,target:{...declared.target,database:'recharge_wrong_database'}})).toEqual({checkout:null,offline:null});
  expect(await f.noticeSnapshot()).toBe(before);
 }),5000);
 it('never widens isolated pricing from a recharge successor declaration',()=>start(async()=>{
  const before=await f.noticeSnapshot();expect(await pricing(f.appRuntime.db,'isolated',declaration())).toEqual({checkout:null,offline:null});
  expect(await f.noticeSnapshot()).toBe(before);
 }),5000);
 it('cannot replace the actual runtime LOGIN with maintenance even under the exact declaration',()=>start(async()=>{
  const before=await f.noticeSnapshot();expect(await pricing(f.maintenanceDb,'shared-shop',declaration())).toEqual({checkout:null,offline:null});
  expect(await f.noticeSnapshot()).toBe(before);
 }),5000);
 it('captures a wrong target before the first await and refuses later mutation to the valid target',()=>start(async()=>{
  const before=await f.noticeSnapshot();
  await f.appRuntime.db.transaction(async actual=>{
   const tx=actual as unknown as DbClient;await tx.execute(sql.raw(NOTICE_MAINTENANCE_BUDGET_SQL));
   const declared:RechargeRefundPricingDeclaration={...declaration(),target:{...target(),database:'recharge_wrong_database'}};
   const pending=reviewedRuntimePricingCapabilities(tx,'public','shared-shop',declared);
   declared.target.database=f.target.database;
   expect(await pending).toEqual({checkout:null,offline:null});
  },{isolationLevel:'repeatable read',accessMode:'read only'});
  expect(await f.noticeSnapshot()).toBe(before);
 }),5000);
 it('retains the actual valid target snapshot despite later caller mutation during the first await',()=>start(async()=>{
  const before=await f.noticeSnapshot();
  await f.appRuntime.db.transaction(async actual=>{
   const tx=actual as unknown as DbClient;await tx.execute(sql.raw(NOTICE_MAINTENANCE_BUDGET_SQL));
   const [oids]=await tx.execute<{checkout:string;offline:string}>(sql`SELECT
    pg_catalog.to_regprocedure('public.checkout_lock_pricing_v1()')::oid::text AS checkout,
    pg_catalog.to_regprocedure('public.ooa_lock_pricing()')::oid::text AS offline`);
   const declared:RechargeRefundPricingDeclaration={...declaration(),target:{...target(),local:[...f.target.local!]}};
   const pending=reviewedRuntimePricingCapabilities(tx,'public','shared-shop',declared);
   declared.target.database='recharge_wrong_database';declared.target.local=[];
   expect(await pending).toEqual(oids);
  },{isolationLevel:'repeatable read',accessMode:'read only'});
  expect(await f.noticeSnapshot()).toBe(before);
 }),5000);
 it('rejects getter, custom iterator and sparse local arrays without reading their executable properties',()=>start(async()=>{
  const before=await f.noticeSnapshot();let reads=0;
  const getter:string[]=[];Object.defineProperty(getter,'0',{enumerable:true,get(){reads++;return f.appRuntime.role;}});
  const iterator=[...f.target.local!];Object.defineProperty(iterator,Symbol.iterator,{value(){reads++;throw Error('Untrusted iterator executed');}});
  const sparse=new Array<string>(2);sparse[1]=f.appRuntime.role;
  for(const local of [getter,iterator,sparse])await expect(pricing(f.appRuntime.db,'shared-shop',{...declaration(),target:{...target(),local}})).rejects.toThrow(/recharge pricing local/iu);
  expect(reads).toBe(0);expect(await f.noticeSnapshot()).toBe(before);
 }),5000);
 for(const role of ['app','admin','financial'] as const)it('actual '+role+' LOGIN reads complete new storage under its registered read guard',()=>start(async()=>{
  const before=await f.noticeSnapshot(),peer=f.profilePeers[role];
  expect(await peer.verify()).toBe(f.identities[role].pid);
  await peer.db.transaction(async actual=>{const tx=actual as unknown as DbClient;
   await tx.execute(sql.raw(NOTICE_MAINTENANCE_BUDGET_SQL));
   expect(await assertRechargeRefundRuntimeTx(tx,role,'read')).toEqual(f.binding);
   expect(await rechargeRefundNoticeCommissionedTx(tx)).toBe(true);
  },{isolationLevel:'repeatable read',accessMode:'read only'});
  expect(await f.noticeSnapshot()).toBe(before);
 }),5000);
 for(const role of ['app','admin','financial'] as const)it('refuses actual '+role+' LOGIN as maintenance owner without catalog changes',()=>start(async()=>{
  const before=await f.noticeSnapshot();await expect(runRechargeRefundNoticeUpgrade(f.profilePeers[role].db)).rejects.toThrow();
  expect(await f.noticeSnapshot()).toBe(before);
 }),5000);
 for(const kind of rechargeProfileKinds)it('preserves complete live '+kind+' profile including dynamic owner restrictions',()=>start(async()=>{
  const before=await f.noticeSnapshot(),result=await f.audit(kind,true);
  expect(result.ready,result.failures.join(',')).toBe(true);expect(await f.noticeSnapshot()).toBe(before);
 }),5000);
 it('actual DB007 inspector and replay preserve the new pair without DDL or business mutations',()=>start(async()=>{
  const before=await f.noticeSnapshot();expect(await inspectWithdrawalEffectsUpgrade(f.maintenanceDb)).toMatchObject({supported:true,ready:true,withinBudget:true});
  expect(await runWithdrawalEffectsUpgrade(f.maintenanceDb)).toMatchObject({applied:false,ready:true});expect(await f.noticeSnapshot()).toBe(before);
 }),5000);
 for(const [name,run] of [['paid',runPaidNoticeUpgrade],['membership',runMembershipPaidNoticeUpgrade],['recharge',runRechargePaidNoticeUpgrade]] as const)
  it('actual full-profile '+name+' owner replay retains old and new exact storage',()=>start(async()=>{
   const before=await f.noticeSnapshot();await run(f.maintenanceDb);expect(await f.noticeSnapshot()).toBe(before);
  }),5000);
 it('adds no runnable new notice, Queue message or network call',()=>start(async()=>{
  const [r]=await f.appRuntime.db.execute<{count:number}>(sql`SELECT count(*)::integer AS count FROM public.store_order_outbox
   WHERE event_type='recharge.refund.success.notice'`);
  expect(r.count).toBe(0);expect(f.messages).toHaveLength(f.noticeQueueBaseline);expect(network).not.toHaveBeenCalled();
 }),5000);
 it('actual virtual-subject owner replay retains the pair and complete declared peer checks',()=>start(async()=>{
  const began=performance.now();let phase='before-snapshot';
  let beforeSnapshotMs:number|undefined,wrapperMs:number|undefined,afterSnapshotMs:number|undefined;
  let wrapperOutcome:'not-started'|'pending'|'fulfilled'|'rejected'='not-started';
  try{
   let phaseBegan=performance.now();const before=await f.noticeSnapshot();beforeSnapshotMs=performance.now()-phaseBegan;
   phase='wrapper';phaseBegan=performance.now();wrapperOutcome='pending';
   let result:Awaited<ReturnType<typeof runRoutineVirtualShippingSubjectsUpgrade>>;
   try{result=await runRoutineVirtualShippingSubjectsUpgrade(f.maintenanceDb,f.target,f.afterPeers,f.appReaders);wrapperOutcome='fulfilled';}
   catch(error){wrapperOutcome='rejected';throw error;}
   finally{wrapperMs=performance.now()-phaseBegan;}
   expect(result).toMatchObject({applied:false});
   phase='after-snapshot';phaseBegan=performance.now();
   let after:string;
   try{after=await f.noticeSnapshot();}finally{afterSnapshotMs=performance.now()-phaseBegan;}
   expect(after).toBe(before);phase='complete';
  }finally{const elapsedMs=performance.now()-began;
   console.info('RECHARGE_NOTICE_VIRTUAL_REPLAY_TIMING '+JSON.stringify({beforeSnapshotMs,wrapperMs,afterSnapshotMs,elapsedMs,
    wrapperOutcome,lastPhase:phase,caseBudgetMs:5000,observedAfterCaseBudget:elapsedMs>5000}));}
 }),5000);
});
