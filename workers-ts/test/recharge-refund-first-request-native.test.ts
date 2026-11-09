/** Genuine payment/hold -> first request CLAIM only. No merchant refund HTTP
 * or signed refund SUCCESS is performed or claimed by these cases. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll,afterEach,beforeAll,describe,expect,it,vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { assertRechargeRefundRuntimeTx } from '@/migrations/rechargeRefund';
import { readRechargeRefundOperationByIdTx } from '@/services/payment/RechargeRefundLedger';
import { readRechargeRefundStateTx } from '@/services/payment/RechargeRefundAccounting';
import { appendRechargeRoutineRefundAccountPolicy } from '@/services/payment/RechargeRoutineRefundAccount';
import { claimAdminRechargeRefundFirstRequest,consumeRechargeRefundFirstRequest,parseRechargeRefundFirstRequest } from '@/services/payment/RechargeRefundFirstRequest';
import { rechargeRefundAdminAuthorFixture,rechargeAuthorUids,type RechargeRefundAdminAuthorFixture } from './helpers/rechargeRefundAdminAuthorNative';

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

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('genuine recharge first-request commit and one-consumption authority',()=>{
 let f:RechargeRefundAdminAuthorFixture,nextUid=0,setup:Promise<void>|undefined,pending:Promise<unknown>|undefined,busy=false;
 const start=<T>(run:()=>Promise<T>):Promise<T>=>{
  if(busy)throw Error('Previous real first claim is still pending');busy=true;
  const work=run().finally(()=>{busy=false;});pending=work;void work.catch(()=>undefined);return work;
 };
 async function reserved(){
  const uid=rechargeAuthorUids[nextUid++];if(!uid)throw Error('Distinct genuine buyer exhausted');
  await f.approve();const paid=await f.paid(uid),q=await f.quote(paid.order),key=randomUUID();
  const request=f.body(paid.order,q,true),admitted=await f.admit(key,request);return{...paid,key,request,operation:admitted.operation};
 }
 const claim=(id:unknown,actor=f.actor())=>claimAdminRechargeRefundFirstRequest(f.adminContainer,f.env,actor,id);
 const inspect=(id:unknown)=>f.adminRuntime.db.transaction(async raw=>{
  const tx=raw as unknown as DbClient,scope=await assertRechargeRefundRuntimeTx(tx,'admin','read');
  const operation=await readRechargeRefundOperationByIdTx(tx,f.env,'admin',id,'read'),state=await readRechargeRefundStateTx(tx,operation,false);
  const rows=await tx.execute(sql`SELECT * FROM public.recharge_refund_attempt WHERE operation_id=${id}::uuid ORDER BY ordinal`);
  const attempts=Array.from(rows,row=>parseRechargeRefundFirstRequest(f.env,scope,operation,row));
  const results=await tx.execute(sql`SELECT result_id FROM public.recharge_refund_result WHERE operation_id=${id}::uuid`);
  return{operation,state,attempts,resultCount:results.length};
 },{isolationLevel:'repeatable read',accessMode:'read only'});
 beforeAll(async()=>{
  setup=(async()=>{f=await rechargeRefundAdminAuthorFixture(transport.values);f.env.ROUTINE_REFUND_NOTIFY_ORIGIN='https://recharge-refund.example';})();await setup;
 },240000);
 afterAll(async()=>{
  try{if(setup)await Promise.allSettled([setup]);if(pending)await Promise.allSettled([pending]);}
  finally{try{await f?.close();}finally{vi.restoreAllMocks();}}
 },30000);
 afterEach(()=>{
  if(!f)return;expect(f.calls).toHaveLength(rechargeAuthorUids.length);
  expect(f.calls.every(call=>{const u=new URL(call.url);return call.method==='GET'&&u.origin==='https://api.weixin.qq.com'&&u.pathname==='/sns/jscode2session';})).toBe(true);
 });

 it('commits exactly one authenticated request and SUBMITTING projection before returning a secret-free token',()=>start(async()=>{
  const r=await reserved(),token=await claim(r.operation.operation_id),saved=await inspect(r.operation.operation_id);
  expect(token).toMatchObject({operationId:r.operation.operation_id});expect(Object.isFrozen(token)).toBe(true);
  expect(Object.keys(token).sort()).toEqual(['attemptId','expiresAt','operationId']);
  expect(saved.operation).toEqual(r.operation);expect(saved.attempts).toHaveLength(1);expect(saved.resultCount).toBe(0);
  const request=saved.attempts[0];expect(request.attempt).toMatchObject({attempt_id:token.attemptId,kind:'request',ordinal:1});
  expect(request.payload.request).toMatchObject({outTradeNo:r.order.orderId,transactionId:r.transaction,refundAmount:1000,totalAmount:1000});
  expect(saved.state).toMatchObject({status:'SUBMITTING',wallet_state:'held',version:1,attempt_count:1,
   lease_id:request.payload.leaseId,lease_until:request.payload.leaseUntil,next_query_at:request.payload.issuedAt+60});
  expect(await f.wallet(r.order.uid)).toBe('0.00');
 }),5000);

 it('rejects a spread/JSON copy and consumes the actual committed token exactly once',()=>start(async()=>{
  const r=await reserved(),token=await claim(r.operation.operation_id);
  expect(()=>consumeRechargeRefundFirstRequest(f.env,{...token})).toThrow();
  expect(()=>consumeRechargeRefundFirstRequest(f.env,JSON.parse(JSON.stringify(token)))).toThrow();
  const consumed=consumeRechargeRefundFirstRequest(f.env,token);
  expect(consumed.binding.attempt.attempt_id).toBe(token.attemptId);expect(consumed.materials.appId).toBe(consumed.binding.payload.approval.appId);
  expect(()=>consumeRechargeRefundFirstRequest(f.env,token)).toThrow();
  expect((await inspect(r.operation.operation_id)).attempts).toHaveLength(1);
 }),5000);

 it('allows one of two actual claims and never mints a replay token or a second immutable request',()=>start(async()=>{
  const r=await reserved(),outcomes=await Promise.allSettled([claim(r.operation.operation_id),claim(r.operation.operation_id)]);
  expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(x=>x.status==='rejected')).toHaveLength(1);
  const token=outcomes.find((x):x is PromiseFulfilledResult<Awaited<ReturnType<typeof claim>>>=>x.status==='fulfilled')!.value;
  await expect(claim(r.operation.operation_id)).rejects.toThrow();
  const saved=await inspect(r.operation.operation_id);expect(saved.attempts).toHaveLength(1);expect(saved.state.attempt_count).toBe(1);
  consumeRechargeRefundFirstRequest(f.env,token);
 }),5000);

 it('leaves a claimed-but-unsent operation query-only and rejects the old local cancellation path',()=>start(async()=>{
  const r=await reserved();await claim(r.operation.operation_id);const before=await f.snapshot(r.order);
  await expect(f.cancel(r.order,r.key)).rejects.toThrow();expect(await f.snapshot(r.order)).toBe(before);
  await expect(claim(r.operation.operation_id)).rejects.toThrow();expect(await f.snapshot(r.order)).toBe(before);
  expect((await f.admit(r.key,r.request)).operation).toEqual(r.operation);
 }),5000);

 it('rolls actual attempt and state back on a late SQL failure before COMMIT and permits a later first claim',()=>start(async()=>{
  const r=await reserved(),before=await f.snapshot(r.order),transaction=f.adminRuntime.db.transaction.bind(f.adminRuntime.db);
  const observed=new Proxy(f.adminRuntime.db,{get(target,key,receiver){
   if(key!=='transaction')return Reflect.get(target,key,receiver);
   return(callback:(tx:DbClient)=>Promise<unknown>,options:Parameters<DbClient['transaction']>[1])=>transaction(async actual=>{
    const result=await callback(actual as unknown as DbClient);await actual.execute(sql`SELECT 1/0`);return result;
   },options);
  }});
  await expect(claimAdminRechargeRefundFirstRequest({...f.adminContainer,db:observed},f.env,f.actor(),r.operation.operation_id)).rejects.toThrow();
  expect(await f.snapshot(r.order)).toBe(before);expect((await inspect(r.operation.operation_id)).attempts).toEqual([]);
  const token=await claim(r.operation.operation_id);expect((await inspect(r.operation.operation_id)).attempts).toHaveLength(1);
  consumeRechargeRefundFirstRequest(f.env,token);
 }),5000);

 it('burns the token on an APP_KEY mismatch and retains the committed request and hold',()=>start(async()=>{
  const r=await reserved(),token=await claim(r.operation.operation_id),before=await f.snapshot(r.order);
  expect(()=>consumeRechargeRefundFirstRequest({...f.env,APP_KEY:'synthetic-different-integrity-key'},token)).toThrow();
  expect(()=>consumeRechargeRefundFirstRequest(f.env,token)).toThrow();expect(await f.snapshot(r.order)).toBe(before);
 }),5000);

 it('burns the token after merchant registry retirement without reverting the committed request to resendable',()=>start(async()=>{
  const r=await reserved(),token=await claim(r.operation.operation_id),before=await f.snapshot(r.order);
  expect(()=>consumeRechargeRefundFirstRequest({...f.env,ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:'{}'},token)).toThrow();
  expect(()=>consumeRechargeRefundFirstRequest(f.env,token)).toThrow();await expect(claim(r.operation.operation_id)).rejects.toThrow();
  expect(await f.snapshot(r.order)).toBe(before);
 }),5000);

 it('rejects a post-commit consume at its elapsed lease deadline without sleeping or provider IO',()=>start(async()=>{
  const r=await reserved(),token=await claim(r.operation.operation_id);
  const clock=vi.spyOn(Date,'now').mockReturnValue(token.expiresAt*1000);
  try{expect(()=>consumeRechargeRefundFirstRequest(f.env,token)).toThrow();}finally{clock.mockRestore();}
  expect(()=>consumeRechargeRefundFirstRequest(f.env,token)).toThrow();expect((await inspect(r.operation.operation_id)).state.status).toBe('SUBMITTING');
 }),5000);

 it('caps usable token authority at the actual Admin expiry even while the SQL request lease remains live',()=>start(async()=>{
  const r=await reserved(),expiresAt=Math.floor(Date.now()/1000)+15,actor={...f.actor(),expiresAt},token=await claim(r.operation.operation_id,actor);
  expect((await inspect(r.operation.operation_id)).state.lease_until).toBeGreaterThan(expiresAt);
  const clock=vi.spyOn(Date,'now').mockReturnValue(expiresAt*1000);
  try{expect(()=>consumeRechargeRefundFirstRequest(f.env,token)).toThrow();}finally{clock.mockRestore();}
  expect((await inspect(r.operation.operation_id)).attempts).toHaveLength(1);
 }),5000);

 // Deliberately last: this formal append advances the fixture's private
 // refund-policy revision counter. No later case calls its approve wrapper.
 it('caps usable token authority at the actual approved refund_request deadline',()=>start(async()=>{
  const r=await reserved(),previous=await f.approve(),validUntil=Math.floor(Date.now()/1000)+15;
  await appendRechargeRoutineRefundAccountPolicy(f.maintenanceDb,f.env,f.binding,{operationId:randomUUID(),expectedRevision:previous.revision,
   data:{...previous.data,validUntil}});
  const token=await claim(r.operation.operation_id);expect((await inspect(r.operation.operation_id)).state.lease_until).toBeGreaterThan(validUntil);
  const clock=vi.spyOn(Date,'now').mockReturnValue(validUntil*1000);
  try{expect(()=>consumeRechargeRefundFirstRequest(f.env,token)).toThrow();}finally{clock.mockRestore();}
  expect((await inspect(r.operation.operation_id)).attempts).toHaveLength(1);
 }),5000);
});
