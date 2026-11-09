import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { claimAdminRechargeRefundQuery,claimRechargeRefundServiceQuery,consumeRechargeRefundQuery,type PreparedRechargeRefundQuery } from '@/services/payment/RechargeRefundQueryClaim';
import type { AuthorRecharge } from './helpers/rechargeRefundAdminAuthorNative';
import { RECHARGE_QUERY_NATIVE_STAGES as stages } from './helpers/rechargeRefundQueryStages';
import { claimAdminRechargeRefundFirstRequest } from '@/services/payment/RechargeRefundFirstRequest';
import { readRechargeRefundQueryHistoryTx,readRechargeRefundQueryAttemptTx } from '@/services/payment/RechargeRefundQueryHistory';
/** Actual provider history is produced by real payment/claim/RSA sender and
 * SQL result writer. No owner-seeded provider result or local money writer. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll,afterEach,beforeAll,describe,expect,it,vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { abandonAdminRechargeRefund } from '@/services/admin/AdminRechargeRefundAdmission';
import { parseRechargeRefundFirstProviderResult,readRechargeRefundFirstProviderResultTx } from '@/services/payment/RechargeRefundFirstProviderResult';
import { rechargeFirstProviderHistoryFixture,type RechargeFirstProviderHistoryFixture } from './helpers/rechargeFirstProviderHistoryNative';
import { rechargeAuthorUids } from './helpers/rechargeRefundAdminAuthorNative';

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

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('genuine first provider immutable historical result reader',()=>{
 let f:RechargeFirstProviderHistoryFixture,setup:Promise<void>|undefined,pending:Promise<unknown>|undefined,busy=false;
 const start=<T>(run:()=>Promise<T>):Promise<T>=>{
  if(busy)throw Error('Previous genuine historical reader still pending');busy=true;
  const work=run().finally(()=>{busy=false;});pending=work;void work.catch(()=>undefined);return work;
 };
 beforeAll(async()=>{setup=(async()=>{f=await rechargeFirstProviderHistoryFixture(transport.values);})();await setup;},240000);
 afterAll(async()=>{
  try{if(setup)await Promise.allSettled([setup]);if(pending)await Promise.allSettled([pending]);}
  finally{try{await f?.close();}finally{vi.restoreAllMocks();}}
 },30000);
 afterEach(()=>{
  if(!f)return;expect(f.calls).toHaveLength(rechargeAuthorUids.length);
  expect(f.calls.every(call=>{const u=new URL(call.url);return call.method==='GET'&&u.origin==='https://api.weixin.qq.com'&&u.pathname==='/sns/jscode2session';})).toBe(true);
 });

 it.each(['SUCCESS','PROCESSING','CLOSED','ABNORMAL','UNKNOWN'] as const)('reads actual %s as each real App/Admin/Financial role without economic writes',status=>start(async()=>{
  const r=await f.persisted(status,status!=='SUCCESS'),before=await f.snapshot(r.order),postCount=f.posts.length;
  for(const role of ['app','admin','financial'] as const){
   const result=await f.read(r.operation.operation_id,r.receipt.resultId,role);
   expect(result.record).toMatchObject({result_id:r.receipt.resultId,attempt_id:r.claim.attemptId,source:'request',source_id:r.claim.attemptId,status});
   expect(result.observation).toMatchObject({status,verifierKey:'TEST_RECHARGE_REFUND_PUBLIC_KEY',httpStatus:status==='UNKNOWN'?500:200});
   expect(result.operation).toEqual(r.operation);expect(result.request.request).toMatchObject({refundAmount:1000,totalAmount:1000});
   expect(Object.isFrozen(result.observation)).toBe(true);
  }
  expect(f.posts).toHaveLength(postCount);expect(await f.snapshot(r.order)).toBe(before);
  expect(await f.wallet(r.order.uid)).toBe(status==='SUCCESS'?'1.50':'0.00');
 }),5000);

 it('supports the explicit read-write transaction guard for all three future owning authors while still making no writes',()=>start(async()=>{
  const r=await f.persisted(),before=await f.snapshot(r.order);
  for(const role of ['app','admin','financial'] as const)expect((await f.read(r.operation.operation_id,r.receipt.resultId,role,'write')).record.result_id).toBe(r.receipt.resultId);
  expect(await f.snapshot(r.order)).toBe(before);
 }),5000);

 it('rejects actual wrong role, Manager, and mismatched transaction mode',()=>start(async()=>{
  const r=await f.persisted(),before=await f.snapshot(r.order),id=r.operation.operation_id,resultId=r.receipt.resultId;
  await expect(f.profilePeers.financial.db.transaction(tx=>readRechargeRefundFirstProviderResultTx(tx as unknown as DbClient,f.env,'admin',id,resultId),
   {isolationLevel:'repeatable read',accessMode:'read only'})).rejects.toThrow();
  await expect(f.profilePeers.manager.db.transaction(tx=>readRechargeRefundFirstProviderResultTx(tx as unknown as DbClient,f.env,'admin',id,resultId),
   {isolationLevel:'repeatable read',accessMode:'read only'})).rejects.toThrow();
  await expect(f.adminRuntime.db.transaction(tx=>readRechargeRefundFirstProviderResultTx(tx as unknown as DbClient,f.env,'admin',id,resultId,'write'),
   {isolationLevel:'repeatable read',accessMode:'read only'})).rejects.toThrow();
  await expect(f.adminRuntime.db.transaction(tx=>readRechargeRefundFirstProviderResultTx(tx as unknown as DbClient,f.env,'admin',id,resultId,'read'),
   {isolationLevel:'read committed',accessMode:'read write'})).rejects.toThrow();
  expect(await f.snapshot(r.order)).toBe(before);
 }),5000);

 it('requires the exact physical operation/result relation and refuses missing/malformed identities',()=>start(async()=>{
  const first=await f.persisted();
  // This relation counterexample needs another physical authenticated operation,
  // not a second provider result. Author the ordinary no-send abandonment via
  // the real Admin service; the first result still comes from actual RSA + SQL.
  const other=await abandonAdminRechargeRefund(f.adminContainer,f.env,f.actor(),randomUUID(),{
   version:'admin-recharge-refund-v1',rechargeId:first.order.id,quoteFingerprint:'a'.repeat(64),recoverGift:false});
  expect(other.admission).toBe('abandoned');expect(other.operation_id).not.toBe(first.operation.operation_id);
  const before=await f.snapshot(first.order);
  await expect(f.read(other.operation_id,first.receipt.resultId)).rejects.toThrow();
  await expect(f.read(randomUUID(),first.receipt.resultId)).rejects.toThrow();
  await expect(f.read(first.operation.operation_id,randomUUID())).rejects.toThrow();
  await expect(f.read('not-a-uuid',first.receipt.resultId)).rejects.toThrow();
  expect(await f.snapshot(first.order)).toBe(before);
 }),5000);

 it('reads committed provider truth after mutable source/hold/actor/policy/registry changes and expiry',()=>start(async()=>{
  const r=await f.persisted(),registry=f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS;
  await f.maintenanceDb.execute(sql`UPDATE public."user" SET now_money=17 WHERE uid=${r.order.uid}`);
  await f.maintenanceDb.execute(sql`UPDATE public.user_recharge SET paid=0,refund_price=10 WHERE id=${r.order.id}`);
  await f.maintenanceDb.execute(sql`UPDATE public.user_bill SET status=0 WHERE event_key=${'recharge_refund_hold:'+r.operation.operation_id}`);
  await f.maintenanceDb.execute(sql`UPDATE public.store_order_outbox SET payload=payload||jsonb_build_object('signature',repeat('0',64)) WHERE id=${r.event.id}`);
  await f.rules('');await f.approve(1,'revoked');f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS='{}';
  const before=await f.snapshot(r.order),clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+86400*1000);
  try{
   for(const role of ['app','admin','financial'] as const){const result=await f.read(r.operation.operation_id,r.receipt.resultId,role);expect(result.observation.status).toBe('SUCCESS');}
   expect(await f.snapshot(r.order)).toBe(before);
  }finally{clock.mockRestore();f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=registry;await f.rules('recharge_order.refund');}
 }),5000);

 it('applies the pure strict decoder to genuine immutable rows and rejects raw MAC/getter tamper without owner-seeding truth',()=>start(async()=>{
  const r=await f.persisted(),raw=await f.raw(r.operation.operation_id,r.receipt.resultId),before=await f.snapshot(r.order);
  expect(parseRechargeRefundFirstProviderResult(f.env,f.binding,r.operation,raw.attempt,raw.result,raw.approval).observation.status).toBe('SUCCESS');
  expect(()=>parseRechargeRefundFirstProviderResult(f.env,f.binding,r.operation,raw.attempt,{...raw.result,signature:'0'.repeat(64)},raw.approval)).toThrow();
  const cloned=JSON.parse(JSON.stringify(raw.result)) as Record<string,unknown>,evidence=cloned.evidence as Record<string,unknown>;let invoked=0;
  Object.defineProperty(evidence,'verification',{enumerable:true,get(){invoked++;throw Error('must not invoke');}});
  expect(()=>parseRechargeRefundFirstProviderResult(f.env,f.binding,r.operation,raw.attempt,cloned,raw.approval)).toThrow();expect(invoked).toBe(0);
  expect(await f.snapshot(r.order)).toBe(before);
 }),5000);

 const read=(id:unknown,role:'app'|'admin'|'financial'='admin',mode:'read'|'write'='read')=>
  f.profilePeers[role].db.transaction(tx=>readRechargeRefundQueryHistoryTx(tx as unknown as DbClient,f.env,role,id,mode),
   {isolationLevel:mode==='read'?'repeatable read':'read committed',accessMode:mode==='read'?'read only':'read write'});

 it('reads complete genuine signedUNKNOWN history as each real LOGIN without wallet/state/catalog writes',()=>start(async()=>{
  const r=await f.persisted('UNKNOWN'),before=await f.snapshot(r.order),posts=f.posts.length;
  for(const role of ['app','admin','financial'] as const){
   const h=await read(r.operation.operation_id,role);
   expect(h.totalAttempts).toBe(1);expect(h.requestAttempts).toBe(1);expect(h.queryAttempts).toBe(0);
   expect(h.results[0].observation.status).toBe('UNKNOWN');expect(h.results[0].record.result_id).toBe(r.receipt.resultId);
   expect(h.queryDisposition).toBe('unresolved');expect(h.state.wallet_state).toBe('held');
  }
  expect(await f.snapshot(r.order)).toBe(before);expect(f.posts.length).toBe(posts);
 }),5000);
 it('performs read-only work within explicit RC/RW owning transactions for all three roles',()=>start(async()=>{
  const r=await f.persisted('PROCESSING'),before=await f.snapshot(r.order);
  for(const role of ['app','admin','financial'] as const)expect((await read(r.operation.operation_id,role,'write')).results[0].observation.status).toBe('PROCESSING');
  expect(await f.snapshot(r.order)).toBe(before);
 }),5000);
 it.each(['SUCCESS','CLOSED'] as const)('retains actual %s while refusing to call the held projection local accounting',status=>start(async()=>{
  const r=await f.persisted(status),before=await f.snapshot(r.order),h=await read(r.operation.operation_id);
  expect(h.queryDisposition).toBe('terminal_evidence');expect(h.state.wallet_state).toBe('held');
  expect(h.results[0].observation.status).toBe(status);expect(await f.snapshot(r.order)).toBe(before);
 }),5000);
 it('reads a committed but never-sent first attempt without minting another POST or provider result',()=>start(async()=>{
  await f.approve();const paid=await f.paid(rechargeAuthorUids[19]),q=await f.quote(paid.order),key=randomUUID();
  const {operation}=await f.admit(key,f.body(paid.order,q,false));
  await claimAdminRechargeRefundFirstRequest(f.adminContainer,f.env,f.actor(),operation.operation_id);
  const before=await f.snapshot(paid.order),posts=f.posts.length,h=await read(operation.operation_id);
  expect(h.results.length).toBe(0);expect(h.requestAttempts).toBe(1);expect(h.queryDisposition).toBe('unresolved');
  expect(await f.snapshot(paid.order)).toBe(before);expect(f.posts.length).toBe(posts);
 }),5000);
 it('rejects bare roots, Manager and a mismatched actual service identity',()=>start(async()=>{
  const r=await f.persisted('UNKNOWN'),before=await f.snapshot(r.order),id=r.operation.operation_id;
  await expect(readRechargeRefundQueryHistoryTx(f.adminRuntime.db,f.env,'admin',id)).rejects.toThrow();
  for(const db of [f.profilePeers.manager.db,f.profilePeers.financial.db])
   await expect(db.transaction(tx=>readRechargeRefundQueryHistoryTx(tx as unknown as DbClient,f.env,'admin',id),
    {isolationLevel:'repeatable read',accessMode:'read only'})).rejects.toThrow();
  expect(await f.snapshot(r.order)).toBe(before);
 }),5000);
 it('rejects changed transaction modes without silently altering their settings',()=>start(async()=>{
  const r=await f.persisted('UNKNOWN'),before=await f.snapshot(r.order),id=r.operation.operation_id;
  await expect(f.adminRuntime.db.transaction(tx=>readRechargeRefundQueryHistoryTx(tx as unknown as DbClient,f.env,'admin',id,'read'),
   {isolationLevel:'read committed',accessMode:'read write'})).rejects.toThrow();
  await expect(f.adminRuntime.db.transaction(tx=>readRechargeRefundQueryHistoryTx(tx as unknown as DbClient,f.env,'admin',id,'write'),
   {isolationLevel:'repeatable read',accessMode:'read only'})).rejects.toThrow();
  expect(await f.snapshot(r.order)).toBe(before);
 }),5000);
 it('rejects maintenance execution and same-name SET ROLE rather than treating it as a fresh LOGIN',()=>start(async()=>{
  const r=await f.persisted('UNKNOWN'),before=await f.snapshot(r.order),id=r.operation.operation_id;
  await expect(f.maintenanceDb.transaction(tx=>readRechargeRefundQueryHistoryTx(tx as unknown as DbClient,f.env,'admin',id),
   {isolationLevel:'repeatable read',accessMode:'read only'})).rejects.toThrow();
  await expect(f.adminRuntime.db.transaction(async raw=>{const tx=raw as unknown as DbClient;
   await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(f.binding.admin)}`);return readRechargeRefundQueryHistoryTx(tx,f.env,'admin',id);
  },{isolationLevel:'repeatable read',accessMode:'read only'})).rejects.toThrow();
  expect(await f.snapshot(r.order)).toBe(before);
 }),5000);
 it('does not depend on current wallet, hold bill, user status, admin grant or live credentials to read past truth',()=>start(async()=>{
  const r=await f.persisted('UNKNOWN'),registry=f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS;
  await f.maintenanceDb.execute(sql`UPDATE public."user" SET now_money=-3 WHERE uid=${r.order.uid}`);
  await f.maintenanceDb.execute(sql`UPDATE public.user_recharge SET paid=0,refund_price=10 WHERE id=${r.order.id}`);
  await f.maintenanceDb.execute(sql`UPDATE public.user_bill SET status=0 WHERE event_key=${'recharge_refund_hold:'+r.operation.operation_id}`);
  await f.rules('');await f.approve(1,'revoked');f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS='{}';
  const before=await f.snapshot(r.order);
  try{for(const role of ['app','admin','financial'] as const)expect((await read(r.operation.operation_id,role)).requestAttempts).toBe(1);
   expect(await f.snapshot(r.order)).toBe(before);
  }finally{f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=registry;await f.rules('recharge_order.refund');}
 }),5000);
 it('requires actual operation identity and refuses using a firstPOST as a query point',()=>start(async()=>{
  const r=await f.persisted('UNKNOWN'),before=await f.snapshot(r.order);
  for(const id of [randomUUID(),'invalid'])await expect(read(id)).rejects.toThrow();
  await expect(f.adminRuntime.db.transaction(tx=>readRechargeRefundQueryAttemptTx(tx as unknown as DbClient,f.env,'admin',r.operation.operation_id,r.claim.attemptId),
   {isolationLevel:'repeatable read',accessMode:'read only'})).rejects.toThrow();
  expect(await f.snapshot(r.order)).toBe(before);
 }),5000);
 interface Specimen {id:string;order:AuthorRecharge}
 let primary:Specimen,rollback:Specimen,lostAck:Specimen,query2Complete=false,postsBeforeQueries=0;
 function economic(snapshot:string){return Object.fromEntries(Object.entries(JSON.parse(snapshot) as Record<string,unknown>).filter(([key])=>!['states','attempts'].includes(key)));}
 /** Transport ACK fault only: the same actual root executes real BEGIN/body/
  * rollback or COMMIT. No SQL/role/MAC/history response is mocked or seeded. */
 function interrupted(root:DbClient,fault:Error,when:'rollback'|'after-commit'):DbClient{
  const wrapper=Object.create(root) as object,descriptor=Object.getOwnPropertyDescriptor(root,'$client');
  if(!descriptor||!('value'in descriptor))throw Error('Genuine root required');
  Object.defineProperty(wrapper,'$client',{value:descriptor.value});
  Object.defineProperty(wrapper,'transaction',{value:async(work:(tx:DbClient)=>Promise<unknown>,options:unknown)=>{
   expect(options).toEqual({isolationLevel:'read committed',accessMode:'read write'});
   const value=await root.transaction(async tx=>{const result=await work(tx as unknown as DbClient);if(when==='rollback')throw fault;return result;},
    {isolationLevel:'read committed',accessMode:'read write'});
   if(when==='after-commit')throw fault;return value;
  }});
  return wrapper as DbClient;
 }
 it(stages[0],()=>start(async()=>{
  postsBeforeQueries=f.posts.length;const r=await f.persisted('UNKNOWN',false,rechargeAuthorUids[0]);primary={id:String(r.operation.operation_id),order:r.order};
  const before=await f.snapshot(r.order),h=await read(primary.id);
  expect(h.totalAttempts).toBe(1);expect(h.requestAttempts).toBe(1);expect(h.results[0].observation.status).toBe('UNKNOWN');
  await expect(claimRechargeRefundServiceQuery(f.appRuntime.db,f.env,'app',primary.id)).rejects.toThrow();
  await expect(claimAdminRechargeRefundQuery(f.adminRuntime.db,f.env,{...f.actor(),expiresAt:Math.floor(Date.now()/1000)-1},primary.id)).rejects.toThrow();
  expect(await f.snapshot(r.order)).toBe(before);expect(f.posts.length).toBe(postsBeforeQueries+1);
 }),5000);
 it(stages[1],()=>start(async()=>{
  const r=await f.persisted('UNKNOWN',false,rechargeAuthorUids[1]);rollback={id:String(r.operation.operation_id),order:r.order};
  expect((await read(rollback.id)).requestAttempts).toBe(1);expect(f.posts.length).toBe(postsBeforeQueries+2);
 }),5000);
 it(stages[2],()=>start(async()=>{
  const r=await f.persisted('UNKNOWN',false,rechargeAuthorUids[2]);lostAck={id:String(r.operation.operation_id),order:r.order};
  expect((await read(lostAck.id)).requestAttempts).toBe(1);expect(f.posts.length).toBe(postsBeforeQueries+3);
 }),5000);

 describe('query2 after a real elapsed interval',()=>{
  beforeAll(async()=>{
   if(busy||!primary||!rollback||!lostAck)throw Error('Incomplete preceding real business phase');
   const began=performance.now();await delay(61000);const elapsed=performance.now()-began;
   expect(elapsed).toBeGreaterThanOrEqual(61000);
   console.log('RECHARGE_QUERY_REAL_WAIT '+JSON.stringify({beforeStage:4,elapsedMs:Math.floor(elapsed)}));
  },240000);
 it(stages[3],()=>start(async()=>{
  const before=await f.snapshot(primary.order);
  await f.approve(1,'revoked');await expect(claimRechargeRefundServiceQuery(f.appRuntime.db,f.env,'app',primary.id)).rejects.toThrow();
  await f.approve(1,'active',['refund_request']);await expect(claimRechargeRefundServiceQuery(f.appRuntime.db,f.env,'app',primary.id)).rejects.toThrow();
  expect(await f.snapshot(primary.order)).toBe(before);
  const approval=await f.approve(1,'active',['refund_query']);
  const token=await claimRechargeRefundServiceQuery(f.appRuntime.db,f.env,'app',primary.id);
  expect(token.ordinal).toBe(2);expect(Object.isFrozen(token)).toBe(true);
  expect(()=>consumeRechargeRefundQuery(f.appRuntime.db,f.env,'app',{...token} as PreparedRechargeRefundQuery)).toThrow();
  const consumed=consumeRechargeRefundQuery(f.appRuntime.db,f.env,'app',token);
  expect(consumed.binding.approval.record_id).toBe(approval.recordId);expect(consumed.binding.payload.approval.credentialVersion).toBe(1);
  expect(consumed.binding.payload.request).toMatchObject({method:'GET',body:null});
  expect(()=>consumeRechargeRefundQuery(f.appRuntime.db,f.env,'app',token)).toThrow();
  const h=await read(primary.id);expect(h.totalAttempts).toBe(2);expect(h.requestAttempts).toBe(1);expect(h.results.length).toBe(1);
  expect(Number(h.attempts[1].created_at)-Number(h.attempts[0].created_at)).toBeGreaterThanOrEqual(60);
  expect(economic(await f.snapshot(primary.order))).toEqual(economic(before));expect(f.posts.length).toBe(postsBeforeQueries+3);
 }),5000);
 it(stages[4],()=>start(async()=>{
  const before=await f.snapshot(rollback.order),fault=Error('Synthetic rollback after actual complete query body');
  await expect(claimRechargeRefundServiceQuery(interrupted(f.profilePeers.financial.db,fault,'rollback'),f.env,'financial',rollback.id)).rejects.toBe(fault);
  expect(await f.snapshot(rollback.order)).toBe(before);
  const token=await claimRechargeRefundServiceQuery(f.profilePeers.financial.db,f.env,'financial',rollback.id);
  expect(token.ordinal).toBe(2);
  expect(()=>consumeRechargeRefundQuery(f.appRuntime.db,f.env,'financial',token)).toThrow();
  expect(()=>consumeRechargeRefundQuery(f.profilePeers.financial.db,f.env,'financial',token)).toThrow();
  const h=await read(rollback.id);expect(h.totalAttempts).toBe(2);expect(h.results.length).toBe(1);expect(h.requestAttempts).toBe(1);
  expect(economic(await f.snapshot(rollback.order))).toEqual(economic(before));expect(f.posts.length).toBe(postsBeforeQueries+3);
 }),5000);
 it(stages[5],()=>start(async()=>{
  const before=await f.snapshot(lostAck.order),fault=Error('Synthetic ACK loss after actual query COMMIT');
  await expect(claimAdminRechargeRefundQuery(interrupted(f.adminRuntime.db,fault,'after-commit'),f.env,f.actor(),lostAck.id)).rejects.toBe(fault);
  const h=await read(lostAck.id);expect(h.totalAttempts).toBe(2);expect(h.requestAttempts).toBe(1);expect(h.state.status).toBe('UNKNOWN');
  const committed=await f.snapshot(lostAck.order);
  await expect(claimAdminRechargeRefundQuery(f.adminRuntime.db,f.env,f.actor(),lostAck.id)).rejects.toThrow();
  expect(await f.snapshot(lostAck.order)).toBe(committed);expect(economic(committed)).toEqual(economic(before));expect(f.posts.length).toBe(postsBeforeQueries+3);query2Complete=true;
 }),5000);

 });
 describe('query3 after a second real elapsed interval',()=>{
  beforeAll(async()=>{
   if(busy||!query2Complete)throw Error('Incomplete preceding query COMMIT/ACK phase');
   const began=performance.now();await delay(61000);const elapsed=performance.now()-began;
   expect(elapsed).toBeGreaterThanOrEqual(61000);
   console.log('RECHARGE_QUERY_REAL_WAIT '+JSON.stringify({beforeStage:7,elapsedMs:Math.floor(elapsed)}));
  },240000);
 it(stages[6],()=>start(async()=>{
  const registry=f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS;
  await f.approve(2,'active',['refund_query']);
  const parsed=JSON.parse(registry!) as {format:number;credentials:Array<{version:number}>};
  f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=JSON.stringify({...parsed,credentials:parsed.credentials.filter(row=>row.version===2)});
  await f.rules('');
  await f.maintenanceDb.execute(sql`UPDATE public."user" SET now_money=-3 WHERE uid=${primary.order.uid}`);
  await f.maintenanceDb.execute(sql`UPDATE public.user_recharge SET paid=0,refund_price=10 WHERE id=${primary.order.id}`);
  await f.maintenanceDb.execute(sql`UPDATE public.user_bill SET status=0 WHERE event_key=${'recharge_refund_hold:'+primary.id}`);
  const before=await f.snapshot(primary.order);
  try{
   const roles=['financial','app'] as const;
   const claims=await Promise.allSettled(roles.map(role=>claimRechargeRefundServiceQuery(f.profilePeers[role].db,f.env,role,primary.id)));
   const winners=claims.flatMap((out,index)=>out.status==='fulfilled'?[{role:roles[index],token:out.value}]:[]);
   expect(winners.length).toBe(1);expect(claims.filter(out=>out.status==='rejected').length).toBe(1);
   const win=winners[0],consumed=consumeRechargeRefundQuery(f.profilePeers[win.role].db,f.env,win.role,win.token);
   expect(consumed.binding.payload.approval.credentialVersion).toBe(2);expect(win.token.ordinal).toBe(3);
   expect(()=>consumeRechargeRefundQuery(f.profilePeers[win.role].db,f.env,win.role,win.token)).toThrow();
   const h=await read(primary.id,'financial');expect(h.totalAttempts).toBe(3);expect(h.requestAttempts).toBe(1);expect(h.queryAttempts).toBe(2);
   expect(h.state).toMatchObject({status:'UNKNOWN',wallet_state:'held',version:3,attempt_count:3});
   expect(h.queries.map(row=>row.payload.approval.credentialVersion)).toEqual([1,2]);expect(h.results.length).toBe(1);
   for(const index of [1,2])expect(Number(h.attempts[index].created_at)-Number(h.attempts[index-1].created_at)).toBeGreaterThanOrEqual(60);
   for(const [index,role] of [[1,'app'],[2,'financial']] as const){
    const point=await f.profilePeers[role].db.transaction(tx=>readRechargeRefundQueryAttemptTx(tx as unknown as DbClient,f.env,role,primary.id,h.attempts[index].attempt_id),
     {isolationLevel:'repeatable read',accessMode:'read only'});expect(point.attempt.signature).toBe(h.attempts[index].signature);
   }
   expect(economic(await f.snapshot(primary.order))).toEqual(economic(before));expect(await f.wallet(primary.order.uid)).toBe('-3.00');
   expect(f.posts.filter(post=>post.body.out_refund_no===h.first.payload.request.outRefundNo)).toHaveLength(1);expect(f.posts.length).toBe(postsBeforeQueries+3);
   expect(f.network.mock.calls.filter(([url,init])=>new URL(String(url)).origin==='https://api.mch.weixin.qq.com'&&init?.method==='GET')).toHaveLength(0);
   console.log('RECHARGE_QUERY_CLAIM_NATIVE_PROOF '+JSON.stringify({ordinals:h.attempts.map(row=>row.ordinal),issuedAt:h.attempts.map(row=>row.created_at),
    requestAttempts:h.requestAttempts,queryAttempts:h.queryAttempts,primaryPosts:1,totalSpecimenPosts:3,merchantGets:0,oneConcurrentWinner:true,
    credentials:[1,2],walletUnchangedDespiteCurrentNegative:true,queryResultWriterCovered:false}));
  }finally{f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=registry;await f.rules('recharge_order.refund');}
 }),5000);
 });

});
