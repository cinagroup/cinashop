/** Actual provider-payment -> immutable history -> fresh Admin SQL basis.
 * No merchant refund IO, callback refund ingress or result persistence claimed. */
import { randomUUID } from 'node:crypto';
import { eq,sql } from 'drizzle-orm';
import { afterAll,afterEach,beforeAll,describe,expect,it,vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { userRecharge,storeOrderOutbox } from '@/models/schema';
import { appendRoutinePaymentAccountPolicy,routinePaymentCredentialCommitment } from '@/services/payment/RoutineApprovedPaymentAccount';
import { parseRechargeRefundOperationSource,readRechargeRefundOperationHistoryTx,readAdminRechargeRefundFirstRequestBasisTx } from '@/services/payment/RechargeRefundOperationSource';
import { rechargeRefundAdminAuthorFixture,rechargeAuthorOriginal,rechargeAuthorUids,
 type RechargeRefundAdminAuthorFixture } from './helpers/rechargeRefundAdminAuthorNative';
import { appendRechargeOperationSourceCallback } from './helpers/rechargeOperationSourceCallbackNative';

const transport=vi.hoisted(()=>{
 const values=new Map<string,unknown>();
 const get=vi.fn(async(key:string)=>values.get(key)??null),set=vi.fn(async(key:string,value:unknown)=>{values.set(key,value);return true;});
 const remove=vi.fn(async(key:string)=>values.delete(key)),take=vi.fn(async(key:string)=>{const value=values.get(key)??null;values.delete(key);return value;});
 const setIfAbsent=vi.fn(async(key:string,value:unknown)=>{if(values.has(key))return false;values.set(key,value);return true;});
 const redis={eval:vi.fn(async()=>1),get,set:vi.fn(async(key:string,value:unknown)=>{await set(key,value);return'OK';}),del:vi.fn(async(key:string)=>Number(await remove(key)))};
 return{values,get,set,remove,take,setIfAbsent,redis};
});
vi.mock('@/utils/cache',async original=>({...await original<typeof import('@/utils/cache')>(),getRedis:()=>transport.redis,
 cacheGet:transport.get,cacheSet:transport.set,cacheTake:transport.take,cacheDelete:transport.remove,cacheSetIfAbsent:transport.setIfAbsent,
 setTokenBucket:vi.fn(async()=>true),clearToken:vi.fn(async()=>true)}));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual recharge operation historical source and fresh first-request basis',()=>{
 let f:RechargeRefundAdminAuthorFixture,nextUid=0,setup:Promise<void>|undefined,pending:Promise<unknown>|undefined,busy=false;
 const start=<T>(run:()=>Promise<T>):Promise<T>=>{
  if(busy)throw Error('Previous actual author is still pending');busy=true;
  const work=run().finally(()=>{busy=false;});pending=work;void work.catch(()=>undefined);return work;
 };
 const history=(operationId:unknown,role:'admin'|'app'|'financial'='admin',env=f.env)=>
  f.profilePeers[role].db.transaction(tx=>readRechargeRefundOperationHistoryTx(tx as unknown as DbClient,env,role,operationId),
   {isolationLevel:'repeatable read',accessMode:'read only'});
 const fresh=(operationId:unknown,env=f.env)=>f.adminRuntime.db.transaction(tx=>
  readAdminRechargeRefundFirstRequestBasisTx(tx as unknown as DbClient,env,f.actor(),operationId),{isolationLevel:'read committed',accessMode:'read write'});
 async function reserved(recoverGift=true){
  const uid=rechargeAuthorUids[nextUid++];if(!uid)throw Error('Distinct real buyer exhausted');
  await f.approve();const paid=await f.paid(uid),key=randomUUID(),q=await f.quote(paid.order);
  const admitted=await f.admit(key,f.body(paid.order,q,recoverGift));
  return{...paid,key,operation:admitted.operation};
 }
 beforeAll(async()=>{setup=(async()=>{f=await rechargeRefundAdminAuthorFixture(transport.values);})();await setup;},240000);
 afterAll(async()=>{
  try{if(setup)await Promise.allSettled([setup]);if(pending)await Promise.allSettled([pending]);}
  finally{try{await f?.close();}finally{vi.restoreAllMocks();}}
 },30000);
 afterEach(()=>{
  if(!f)return;expect(f.calls).toHaveLength(rechargeAuthorUids.length);
  expect(f.calls.every(call=>{const u=new URL(call.url);return call.method==='GET'&&u.origin==='https://api.weixin.qq.com'&&u.pathname==='/sns/jscode2session';})).toBe(true);
 });

 it('reads real immutable history and first-request basis after the wallet has already been fully reserved',()=>start(async()=>{
  const r=await reserved();expect(await f.wallet(r.order.uid)).toBe('0.00');const before=await f.snapshot(r.order);
  for(const role of ['admin','app','financial'] as const){const h=await history(r.operation.operation_id,role);expect(h.pinned.operation).toEqual(r.operation);expect(h.pinnedUses).toHaveLength(1);}
  const basis=await fresh(r.operation.operation_id);expect(basis.hold.billId).toBe(basis.history.pinned.holdBillId);
  expect(basis.state).toMatchObject({status:'RESERVED',attempt_count:0});expect(await f.snapshot(r.order)).toBe(before);
  await f.cancel(r.order,r.key);
 }),5000);

 it('keeps the original source unchanged after a later genuine wallet credit and never reuses the quote wallet as a dispatch balance',()=>start(async()=>{
  const r=await reserved();await f.paid(r.order.uid);expect(await f.wallet(r.order.uid)).toBe('11.50');
  const before=await f.snapshot(r.order),basis=await fresh(r.operation.operation_id);
  expect(basis.history.pinned.operation.wallet_before).toBe(1150);expect(basis.history.pinned.operation.wallet_after).toBe(0);
  expect(await f.snapshot(r.order)).toBe(before);await f.cancel(r.order,r.key);expect(await f.wallet(r.order.uid)).toBe('23.00');
 }),5000);

 it('retains pure and immutable history after outbox tamper or merchant registry retirement while fresh dispatch refuses',()=>start(async()=>{
  const r=await reserved(),retired={...f.env,ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:'{}'},original=r.event.payload;
  expect(parseRechargeRefundOperationSource(retired,f.binding,r.operation).operation).toEqual(r.operation);
  await f.maintenanceDb.update(storeOrderOutbox).set({payload:{...original,signature:'0'.repeat(64)} as typeof original}).where(eq(storeOrderOutbox.id,r.event.id));
  try{
   expect((await history(r.operation.operation_id,'financial',retired)).pinned.operation).toEqual(r.operation);
   await expect(fresh(r.operation.operation_id,retired)).rejects.toThrow();
  }finally{await f.maintenanceDb.update(storeOrderOutbox).set({payload:original}).where(eq(storeOrderOutbox.id,r.event.id));}
  await expect(fresh(r.operation.operation_id,retired)).rejects.toThrow();await f.cancel(r.order,r.key);
 }),5000);

 it('keeps immutable history readable after a mutable paid scalar changes but refuses the fresh physical source',()=>start(async()=>{
  const r=await reserved();await f.maintenanceDb.update(userRecharge).set({paid:0}).where(eq(userRecharge.id,r.order.id));
  try{expect((await history(r.operation.operation_id)).pinned.operation).toEqual(r.operation);await expect(fresh(r.operation.operation_id)).rejects.toThrow();}
  finally{await f.maintenanceDb.update(userRecharge).set({paid:1}).where(eq(userRecharge.id,r.order.id));}
  await f.cancel(r.order,r.key);
 }),5000);

 it('does not confuse historical source validity with the exact current hold bill needed for a first request',()=>start(async()=>{
  const r=await reserved(),p=parseRechargeRefundOperationSource(f.env,f.binding,r.operation);
  await f.maintenanceDb.execute(sql`UPDATE public.user_bill SET number='0.01' WHERE id=${p.holdBillId}`);
  try{expect((await history(r.operation.operation_id)).pinned.operation).toEqual(r.operation);await expect(fresh(r.operation.operation_id)).rejects.toThrow();}
  finally{await f.maintenanceDb.execute(sql`UPDATE public.user_bill SET number='11.50' WHERE id=${p.holdBillId}`);}
  await f.cancel(r.order,r.key);
 }),5000);

 it('requires fresh actual Admin capability and active request approval without erasing the original immutable history',()=>start(async()=>{
  const r=await reserved();await f.rules('recharge_order.view,refund.manage');
  try{await expect(fresh(r.operation.operation_id)).rejects.toThrow();expect((await history(r.operation.operation_id)).pinned.operation).toEqual(r.operation);}
  finally{await f.rules('recharge_order.refund');}
  await f.approve(1,'revoked');expect((await history(r.operation.operation_id)).pinned.operation).toEqual(r.operation);
  await expect(fresh(r.operation.operation_id)).rejects.toThrow();await f.cancel(r.order,r.key);
 }),5000);

 it('requires cancel and re-admission after credential-version change while allowing a fresh revision of the same commitment',()=>start(async()=>{
  const r=await reserved(),p=parseRechargeRefundOperationSource(f.env,f.binding,r.operation),same=await f.approve(1);
  expect((await fresh(r.operation.operation_id)).latestApproval.record_id).toBe(same.recordId);
  expect((await history(r.operation.operation_id)).pinned.refundApproval).toEqual(p.refundApproval);
  await f.approve(2);await expect(fresh(r.operation.operation_id)).rejects.toThrow();
  expect((await history(r.operation.operation_id)).pinned.operation).toEqual(r.operation);await f.cancel(r.order,r.key);
 }),5000);

 it('accepts actual later original/use appends and another approved use for the SAME old original without replacing the pinned subset',()=>start(async()=>{
  const r=await reserved(),p=parseRechargeRefundOperationSource(f.env,f.binding,r.operation),A=rechargeAuthorOriginal;
  await appendRechargeOperationSourceCallback(f,p,randomUUID());
  const now=Math.floor(Date.now()/1000);
  await appendRoutinePaymentAccountPolicy(f.maintenanceDb,f.env,f.target,{operationId:randomUUID(),expectedRevision:1,kind:'account',data:{
   accountId:A.paymentAccount,state:'active',...routinePaymentCredentialCommitment(f.env,A.credentialRef,2),credentialRef:A.credentialRef,
   credentialVersion:2,purposes:['query','notify'],validFrom:now-60,validUntil:now+7200}});
  await appendRechargeOperationSourceCallback(f,p,p.originals[0].source_id);
  const h=await history(r.operation.operation_id);expect(h.originals).toHaveLength(2);expect(h.uses).toHaveLength(3);expect(h.pinnedUses).toHaveLength(1);
  expect(h.pinned.original).toEqual(p.original);expect(h.pinned.operation.payment_signature).toBe(r.operation.payment_signature);
  expect(await f.wallet(r.order.uid)).toBe('0.00');expect((await fresh(r.operation.operation_id)).history.pinned.original).toEqual(p.original);
  await f.cancel(r.order,r.key);
 }),5000);
});
