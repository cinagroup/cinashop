/** Actual persisted first RSA SUCCESS -> one SQL capture. No owner seeds
 * provider/payment/hold truth. Explicit adversarial projection/catalog/physical
 * mutations are negative specimens, never accepted financial producers. */
import { randomUUID } from 'node:crypto';
import { eq,sql } from 'drizzle-orm';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { capitalFlow,storeOrderOutbox,user,userBill,userRecharge } from '@/models/schema';
import { captureRechargeRefundSuccessFirstResult } from '@/services/payment/RechargeRefundSuccessCapture';
import { parseRechargeRefundOperationSource } from '@/services/payment/RechargeRefundOperationSource';
import { appendRechargeOperationSourceCallback } from './helpers/rechargeOperationSourceCallbackNative';
import { rechargeSuccessCaptureNativeFixture,type RechargeSuccessCaptureNativeFixture } from './helpers/rechargeSuccessCaptureNative';
import { rechargeAuthorUids } from './helpers/rechargeRefundAdminAuthorNative';

const transport=vi.hoisted(()=>{
 const values=new Map<string,unknown>(),get=vi.fn(async(key:string)=>values.get(key)??null),set=vi.fn(async(key:string,value:unknown)=>{values.set(key,value);return true;}),
  remove=vi.fn(async(key:string)=>values.delete(key)),take=vi.fn(async(key:string)=>{const v=values.get(key)??null;values.delete(key);return v;}),
  setIfAbsent=vi.fn(async(key:string,value:unknown)=>{if(values.has(key))return false;values.set(key,value);return true;});
 const redis={eval:vi.fn(async()=>1),get,set:vi.fn(async(key:string,value:unknown)=>{await set(key,value);return'OK';}),del:vi.fn(async(key:string)=>Number(await remove(key)))};
 return{values,get,set,remove,take,setIfAbsent,redis};
});
vi.mock('@/utils/cache',async original=>({...await original<typeof import('@/utils/cache')>(),getRedis:()=>transport.redis,
 cacheGet:transport.get,cacheSet:transport.set,cacheTake:transport.take,cacheDelete:transport.remove,cacheSetIfAbsent:transport.setIfAbsent,
 setTokenBucket:vi.fn(async()=>true),clearToken:vi.fn(async()=>true)}));
const code=(error:unknown):string|null=>{
 const seen=new Set<object>();for(let n=0;n<7&&error&&typeof error==='object'&&!seen.has(error);n++){
  seen.add(error);const c=Object.getOwnPropertyDescriptor(error,'code');if(c&&'value'in c&&c.value!==undefined)return typeof c.value==='string'?c.value:null;
  const cause=Object.getOwnPropertyDescriptor(error,'cause');if(!cause||!('value'in cause))return null;error=cause.value;
 }return null;
};
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('genuine first SUCCESS local principal capture and passive intent',()=>{
 let f:RechargeSuccessCaptureNativeFixture,setup:Promise<void>|undefined,pending:Promise<unknown>|undefined,busy=false;
 type Paid=Awaited<ReturnType<RechargeSuccessCaptureNativeFixture['persisted']>>;
 let completed:Paid|undefined,held:Paid|undefined;
 const start=<T>(run:()=>Promise<T>)=>{if(busy)throw Error('Previous genuine capture case pending');busy=true;
  const p=run().finally(()=>{busy=false;});pending=p;void p.catch(()=>undefined);return p;};
 beforeAll(async()=>{setup=(async()=>{f=await rechargeSuccessCaptureNativeFixture(transport.values);})();await setup;},240000);
 afterAll(async()=>{try{if(setup)await Promise.allSettled([setup]);if(pending)await Promise.allSettled([pending]);}
  finally{try{await f?.close();}finally{vi.restoreAllMocks();}}},30000);
 const records=(r:Paid)=>f.adminRuntime.db.execute(sql`SELECT * FROM public.recharge_refund_result WHERE operation_id=${r.operation.operation_id}::uuid`);
 const projection=(r:Paid)=>f.adminRuntime.db.execute(sql`SELECT * FROM public.recharge_refund_state WHERE operation_id=${r.operation.operation_id}::uuid`);
 const noWrite=async(r:Paid,run:()=>Promise<unknown>)=>{
  const before=await f.economicSnapshot(r.order),posts=f.posts.length,messages=f.messages.length;
  await expect(run()).rejects.toThrow();expect(await f.economicSnapshot(r.order)).toBe(before);
  expect((await records(r)).some(row=>row.result_id===r.receipt.resultId&&row.source==='request')).toBe(true);
  expect(f.posts).toHaveLength(posts);expect(f.messages).toHaveLength(messages);
 };
 const strictReplay=async(r:Paid,role:'app'|'admin'|'financial'='admin')=>{
  const before=await f.economicSnapshot(r.order),posts=f.posts.length,messages=f.messages.length;
  const receipt=await f.capture(r.operation.operation_id,r.receipt.resultId,role);expect(receipt.replayed).toBe(true);
  expect(await f.economicSnapshot(r.order)).toBe(before);expect(f.posts).toHaveLength(posts);expect(f.messages).toHaveLength(messages);return receipt;
 };
 const completedOperation=()=>{if(!completed)throw Error('Actual initial Admin capture missing');return completed;};
 const heldOperation=()=>{if(!held)throw Error('Actual preceding late rollback missing');return held;};

 for(const [role,recoverGift]of[['app',true],['admin',false],['financial',true]]as const)
  it('captures principal once on actual '+role+' LOGIN, recoverGift='+recoverGift,()=>start(async()=>{
   const r=await f.persisted('SUCCESS',recoverGift),before=JSON.parse(await f.economicSnapshot(r.order))as Record<string,unknown>,posts=f.posts.length,messages=f.messages.length;
   const balance=recoverGift?'0.00':'1.50';expect(await f.wallet(r.order.uid)).toBe(balance);
   const receipt=await f.capture(r.operation.operation_id,r.receipt.resultId,role);
   expect(receipt).toMatchObject({operationId:r.operation.operation_id,providerResultId:r.receipt.resultId,captured:true,replayed:false});
   expect(await f.wallet(r.order.uid)).toBe(balance);expect(f.posts).toHaveLength(posts);expect(f.messages).toHaveLength(messages);
   const flows=await f.flow(String(r.operation.operation_id));expect(flows).toHaveLength(1);
   expect(flows[0]).toMatchObject({id:receipt.flowId,eventKey:'recharge.refund:'+r.operation.operation_id,flowId:String(r.operation.operation_id).replaceAll('-',''),
    orderId:r.order.orderId,uid:r.order.uid,price:'-10.00',tradingType:4,payType:'weixin'});
   const notices=await f.notice(String(r.operation.operation_id));expect(notices).toHaveLength(1);
   expect(notices[0]).toMatchObject({id:receipt.noticeId,eventType:'recharge.refund.success.notice',aggregateType:'recharge',aggregateId:r.order.id,status:'PENDING',
    payload:{localResultId:receipt.localResultId,business:{principalCents:1000,postBalanceCents:recoverGift?0:150}}});
   const rows=await records(r);expect(rows).toHaveLength(2);expect(rows.find(row=>row.source==='local_settlement')).toMatchObject({result_id:receipt.localResultId,
    source_id:'settle:'+r.operation.operation_id,status:'SUCCESS',attempt_id:null,caused_by_result_id:r.receipt.resultId,
    evidence:{settlement:{recharge:{postReservationBalanceCents:recoverGift?0:150},wallet:{beforeCents:recoverGift?0:150,afterCents:recoverGift?0:150}}}});
   expect((await projection(r))[0]).toMatchObject({status:'SUCCEEDED',wallet_state:'captured',version:2,attempt_count:1,last_result_id:receipt.localResultId,
    lease_id:null,lease_until:null,next_query_at:null,provider_refund_id:expect.any(String)});
   const after=JSON.parse(await f.economicSnapshot(r.order))as Record<string,unknown>;
   for(const name of['wallet','bills','operations','attempts','originals','uses','settlement','callbacks'])expect(after[name],name).toEqual(before[name]);
   expect(after.recharge).toMatchObject({refund_price:'10.00'});
   if(role==='admin')completed=r;
  }),5000);

 it('allows the existing real Admin setMark API then replays with no new economic write',()=>start(async()=>{
  const r=completedOperation(),flows=await f.flow(String(r.operation.operation_id));expect(flows).toHaveLength(1);
  expect(await f.editMark(flows[0].id,'actual Admin presentation edit')).toEqual({id:flows[0].id,mark:'actual Admin presentation edit'});
  await strictReplay(r,'financial');expect((await f.flow(String(r.operation.operation_id)))[0].mark).toBe('actual Admin presentation edit');
  expect((await records(r)).find(row=>row.source==='local_settlement')).toMatchObject({evidence:{settlement:{flow:{mark:'充值原路退款'}}}});
 }),5000);
 it('keeps notice amount at immutable1.50 after a later genuine recharge credit',()=>start(async()=>{
  const r=completedOperation();await f.paid(r.order.uid);expect(await f.wallet(r.order.uid)).toBe('13.00');await strictReplay(r,'app');
  expect((await f.notice(String(r.operation.operation_id)))[0]).toMatchObject({payload:{business:{postBalanceCents:150}}});
 }),5000);
 it('replays after later genuine wallet spending without recapturing principal',()=>start(async()=>{
  const r=completedOperation();await f.spend(r.order.uid);expect(await f.wallet(r.order.uid)).toBe('6.00');await strictReplay(r,'financial');
 }),5000);
 it('accepts actual later signed callback original/use appends without replacing the pinned source',()=>start(async()=>{
  const r=completedOperation(),pinned=parseRechargeRefundOperationSource(f.env,f.binding,r.operation);
  await appendRechargeOperationSourceCallback(f,pinned,randomUUID());
  const originals=await f.adminRuntime.db.execute(sql`SELECT evidence_id FROM public.routine_original_payment_evidence WHERE order_no=${r.order.orderId}`);
  expect(originals).toHaveLength(2);await strictReplay(r,'app');
  expect((await records(r)).find(row=>row.source==='local_settlement')).toMatchObject({evidence:{settlement:{operation:{paymentSignature:r.operation.payment_signature}}}});
 }),5000);
 it('historical replay ignores retired credentials/revoked current approval and later mutable paid/refund/store/settlement',()=>start(async()=>{
  const r=completedOperation(),registry=f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS,event=await f.settlement(r.order);
  const [current]=await f.adminRuntime.db.select().from(userRecharge).where(eq(userRecharge.id,r.order.id));
  await f.approve(2,'revoked');await f.adminRuntime.db.update(userRecharge).set({paid:0,refundPrice:'0.00',storeId:99}).where(eq(userRecharge.id,r.order.id));
  await f.adminRuntime.db.execute(sql`UPDATE public.store_order_outbox SET payload=pg_catalog.jsonb_set(payload,'{signature}',pg_catalog.to_jsonb(pg_catalog.repeat('0',64))) WHERE id=${event.id}`);
  f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS='';
  try{await strictReplay(r,'financial');}finally{f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=registry;
   await f.adminRuntime.db.update(userRecharge).set({paid:current.paid,refundPrice:current.refundPrice,storeId:current.storeId}).where(eq(userRecharge.id,r.order.id));
   await f.adminRuntime.db.update(storeOrderOutbox).set({payload:event.payload}).where(eq(storeOrderOutbox.id,event.id));}
 }),5000);
 it('never dispatches the new signed PENDING intent through the old Queue route',()=>start(async()=>{
  const r=completedOperation(),notices=await f.notice(String(r.operation.operation_id)),before=await f.economicSnapshot(r.order),n=f.messages.length;
  expect(await f.dispatchNotice(notices[0].id)).toEqual({claimed:0,enqueued:0});expect(await f.economicSnapshot(r.order)).toBe(before);expect(f.messages).toHaveLength(n);
 }),5000);
 it('refuses wrong actual LOGIN, root/owner execution and local receipt substituted for provider cause',()=>start(async()=>{
  const r=completedOperation(),local=(await records(r)).find(row=>row.source==='local_settlement');if(!local)throw Error('Actual local missing');
  await noWrite(r,()=>captureRechargeRefundSuccessFirstResult({...f.adminContainer,db:f.profilePeers.financial.db},f.env,'admin',r.operation.operation_id,r.receipt.resultId));
  await noWrite(r,()=>captureRechargeRefundSuccessFirstResult({...f.adminContainer,db:f.maintenanceDb},f.env,'admin',r.operation.operation_id,r.receipt.resultId));
  await noWrite(r,()=>f.capture(r.operation.operation_id,local.result_id));
 }),5000);
 for(const status of['CLOSED','PROCESSING','ABNORMAL','UNKNOWN']as const)
  it('keeps held funds and independently committed '+status+' truth without capturing',()=>start(async()=>{
   const r=await f.persisted(status,false);await noWrite(r,()=>f.capture(r.operation.operation_id,r.receipt.resultId));expect(await records(r)).toHaveLength(1);
  }),5000);
 it('does not adopt a SUCCEEDED scalar without local receipt or actual cash flow/notice',()=>start(async()=>{
  const r=await f.persisted('SUCCESS',false);await f.adminRuntime.db.execute(sql`UPDATE public.recharge_refund_state SET status='SUCCEEDED',wallet_state='captured',
   version=2,lease_id=NULL,lease_until=NULL,next_query_at=NULL,last_result_id=${r.receipt.resultId}::uuid WHERE operation_id=${r.operation.operation_id}::uuid`);
  await noWrite(r,()=>f.capture(r.operation.operation_id,r.receipt.resultId));
 }),5000);
 it('refuses actual hold tamper while preserving the committed provider SUCCESS',()=>start(async()=>{
  const r=await f.persisted('SUCCESS',true);await f.adminRuntime.db.update(userBill).set({mark:'controlled hold tamper'})
   .where(eq(userBill.eventKey,'recharge_refund_hold:'+r.operation.operation_id));await noWrite(r,()=>f.capture(r.operation.operation_id,r.receipt.resultId));
 }),5000);
 it('rolls real refund/negativeflow/intent/localreceipt/state back after a late SQL failure while provider SUCCESS remains committed',()=>start(async()=>{
  const r=await f.persisted('SUCCESS',false),before=await f.economicSnapshot(r.order),transaction=f.adminRuntime.db.transaction.bind(f.adminRuntime.db);let reached=false;
  const wrapped=new Proxy(f.adminRuntime.db,{get(target,key,receiver){if(key!=='transaction')return Reflect.get(target,key,receiver);
   return(callback:(tx:DbClient)=>Promise<unknown>,options:Parameters<DbClient['transaction']>[1])=>transaction(async actual=>{
    const result=await callback(actual as unknown as DbClient);
    const [observed]=await actual.execute(sql`SELECT
     (SELECT refund_price::text FROM public.user_recharge WHERE id=${r.order.id}) AS refund,
     (SELECT now_money::text FROM public."user" WHERE uid=${r.order.uid}) AS wallet,
     (SELECT count(*)::integer FROM public.capital_flow WHERE event_key=${'recharge.refund:'+r.operation.operation_id}) AS flow,
     (SELECT count(*)::integer FROM public.store_order_outbox WHERE event_key=${'recharge.refund.success.notice:'+r.operation.operation_id}) AS notice,
     (SELECT count(*)::integer FROM public.recharge_refund_result WHERE operation_id=${r.operation.operation_id}::uuid AND source='local_settlement') AS local,
     (SELECT status FROM public.recharge_refund_state WHERE operation_id=${r.operation.operation_id}::uuid) AS status`);
    expect(observed).toEqual({refund:'10.00',wallet:'1.50',flow:1,notice:1,local:1,status:'SUCCEEDED'});reached=true;
    await actual.execute(sql`SELECT 1/0`);return result;
   },options);}});
  await expect(captureRechargeRefundSuccessFirstResult({...f.adminContainer,db:wrapped},f.env,'admin',r.operation.operation_id,r.receipt.resultId)).rejects.toThrow();
  expect(reached).toBe(true);expect(await f.economicSnapshot(r.order)).toBe(before);expect(await records(r)).toHaveLength(1);held=r;
 }),5000);

 for(const alias of['event_key','flow_id']as const)it('refuses a fresh orphan cash-flow '+alias+' instead of adopting it',()=>start(async()=>{
  const r=heldOperation(),[row]=await f.adminRuntime.db.insert(capitalFlow).values({eventKey:alias==='event_key'?'recharge.refund:'+r.operation.operation_id:null,
   flowId:alias==='flow_id'?String(r.operation.operation_id).replaceAll('-',''):'controlled_orphan',orderId:r.order.orderId,uid:r.order.uid,price:'-10.00',tradingType:4}).returning({id:capitalFlow.id});
  try{await noWrite(r,()=>f.capture(r.operation.operation_id,r.receipt.resultId));}finally{await f.maintenanceDb.delete(capitalFlow).where(eq(capitalFlow.id,row.id));}
 }),5000);
 it('refuses a fresh notice orphan disguised as an allowed old event type',()=>start(async()=>{
  const r=heldOperation(),[row]=await f.adminRuntime.db.insert(storeOrderOutbox).values({eventKey:'recharge.refund.success.notice:'+r.operation.operation_id,
   aggregateType:'recharge',aggregateId:r.order.id,eventType:'order.paid',status:'DEAD'}).returning({id:storeOrderOutbox.id});
  try{await noWrite(r,()=>f.capture(r.operation.operation_id,r.receipt.resultId));}finally{await f.maintenanceDb.delete(storeOrderOutbox).where(eq(storeOrderOutbox.id,row.id));}
 }),5000);
 it('refuses an orphan release bill for the same operation',()=>start(async()=>{
  const r=heldOperation(),[row]=await f.adminRuntime.db.insert(userBill).values({uid:r.order.uid,linkId:r.order.orderId,eventKey:'recharge_refund_release:'+r.operation.operation_id,
   pm:1,number:'0.00',balance:'1.50',category:'now_money',type:'recharge_refund_release',mark:'controlled contradiction'}).returning({id:userBill.id});
  try{await noWrite(r,()=>f.capture(r.operation.operation_id,r.receipt.resultId));}finally{await f.maintenanceDb.delete(userBill).where(eq(userBill.id,row.id));}
 }),5000);
 it('refuses changed physical first-settlement source before fresh capture',()=>start(async()=>{
  const r=heldOperation(),event=await f.settlement(r.order);await f.adminRuntime.db.execute(sql`UPDATE public.store_order_outbox
   SET payload=pg_catalog.jsonb_set(payload,'{signature}',pg_catalog.to_jsonb(pg_catalog.repeat('0',64))) WHERE id=${event.id}`);
  try{await noWrite(r,()=>f.capture(r.operation.operation_id,r.receipt.resultId));}finally{await f.adminRuntime.db.update(storeOrderOutbox).set({payload:event.payload}).where(eq(storeOrderOutbox.id,event.id));}
 }),5000);
 it('keeps terminal history readable while an unknown new cash-flow write index refuses the still-held fresh operation',()=>start(async()=>{
  const r=heldOperation();await f.ddl('CREATE INDEX capture_success_unknown_index ON public.capital_flow(uid)');
  try{await noWrite(r,()=>f.capture(r.operation.operation_id,r.receipt.resultId));await strictReplay(completedOperation(),'app');}
  finally{await f.ddl('DROP INDEX public.capture_success_unknown_index');}
 }),5000);
 for(const kind of['trigger','flow_sequence','outbox_sequence']as const)
  it('holds actual '+kind+' DDL fence until the real owning capture transaction ends',()=>start(async()=>{
   const r=heldOperation(),before=await f.economicSnapshot(r.order),transaction=f.adminRuntime.db.transaction.bind(f.adminRuntime.db);let reached=false,blocked=false;
   if(kind==='trigger')await f.ddl("CREATE FUNCTION public.capture_success_lock_probe() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'",
    'REVOKE ALL ON FUNCTION public.capture_success_lock_probe() FROM PUBLIC');
   const command=kind==='trigger'?'CREATE TRIGGER capture_success_lock_probe BEFORE UPDATE ON public.user_recharge FOR EACH ROW EXECUTE FUNCTION public.capture_success_lock_probe()'
    :kind==='flow_sequence'?'ALTER SEQUENCE public.capital_flow_id_seq OWNED BY NONE':'ALTER SEQUENCE public.store_order_outbox_id_seq CACHE 2';
   const wrapped=new Proxy(f.adminRuntime.db,{get(target,key,receiver){if(key!=='transaction')return Reflect.get(target,key,receiver);
    return(callback:(tx:DbClient)=>Promise<unknown>,options:Parameters<DbClient['transaction']>[1])=>transaction(async actual=>{
     const result=await callback(actual as unknown as DbClient);reached=true;let error:unknown;try{await f.ddl(command);}catch(e){error=e;}
     expect(code(error)).toBe('55P03');blocked=true;await actual.execute(sql`SELECT 1/0`);return result;
    },options);}});
   try{await expect(captureRechargeRefundSuccessFirstResult({...f.adminContainer,db:wrapped},f.env,'admin',r.operation.operation_id,r.receipt.resultId)).rejects.toThrow();
    expect(reached).toBe(true);expect(blocked).toBe(true);expect(await f.economicSnapshot(r.order)).toBe(before);
   }finally{if(kind==='trigger')await f.ddl('DROP TRIGGER IF EXISTS capture_success_lock_probe ON public.user_recharge','DROP FUNCTION public.capture_success_lock_probe()');
    else if(kind==='flow_sequence')await f.ddl('ALTER SEQUENCE public.capital_flow_id_seq OWNED BY public.capital_flow.id');
    else await f.ddl('ALTER SEQUENCE public.store_order_outbox_id_seq CACHE 1');}
  }),5000);
 it('recovers the real rolled-back operation under two actual role contenders with one capture and no repeat POST',()=>start(async()=>{
  const r=heldOperation(),posts=f.posts.length,balance=await f.wallet(r.order.uid);
  const roles=['financial','app']as const;
  // A bounded key waiter may return55P03 before the winner commits. Settle
  // both owning transactions before observing history or starting another case.
  const outcomes=await Promise.allSettled(roles.map(role=>f.capture(r.operation.operation_id,r.receipt.resultId,role)));
  expect(outcomes.some(row=>row.status==='fulfilled')).toBe(true);
  const receipts=[];
  for(const [index,outcome]of outcomes.entries()){
   if(outcome.status==='fulfilled')receipts.push(outcome.value);
   else{expect(code(outcome.reason)).toBe('55P03');
    receipts.push(await f.capture(r.operation.operation_id,r.receipt.resultId,roles[index]));}
  }
  expect(receipts.map(row=>row.replayed).sort()).toEqual([false,true]);expect(receipts[0].localResultId).toBe(receipts[1].localResultId);
  expect(receipts[0].flowId).toBe(receipts[1].flowId);expect(receipts[0].noticeId).toBe(receipts[1].noticeId);
  expect(await f.wallet(r.order.uid)).toBe(balance);expect(await f.flow(String(r.operation.operation_id))).toHaveLength(1);
  expect(await f.notice(String(r.operation.operation_id))).toHaveLength(1);expect(await records(r)).toHaveLength(2);expect(f.posts).toHaveLength(posts);
 }),5000);
 it('captures principal with controlled negative current wallet and settlement-time store snapshot, without debiting wallet again',()=>start(async()=>{
  const r=await f.persisted('SUCCESS',false);await f.adminRuntime.db.update(user).set({nowMoney:'-0.25'}).where(eq(user.uid,r.order.uid));
  await f.adminRuntime.db.update(userRecharge).set({storeId:23}).where(eq(userRecharge.id,r.order.id));
  await f.capture(r.operation.operation_id,r.receipt.resultId,'app');expect(await f.wallet(r.order.uid)).toBe('-0.25');
  expect((await f.flow(String(r.operation.operation_id)))[0]).toMatchObject({storeId:23,price:'-10.00'});
  expect((await f.notice(String(r.operation.operation_id)))[0]).toMatchObject({payload:{business:{postBalanceCents:150}}});
  expect((await records(r)).find(row=>row.source==='local_settlement')).toMatchObject({evidence:{settlement:{wallet:{beforeCents:-25,afterCents:-25}}}});
 }),5000);
 it('recovers an actually committed capture after a controlled lost COMMIT acknowledgement using another real role',()=>start(async()=>{
  const r=await f.persisted('SUCCESS',false),transaction=f.adminRuntime.db.transaction.bind(f.adminRuntime.db),posts=f.posts.length,messages=f.messages.length;
  let committed=false;
  const wrapped=new Proxy(f.adminRuntime.db,{get(target,key,receiver){if(key!=='transaction')return Reflect.get(target,key,receiver);
   return async(callback:(tx:DbClient)=>Promise<unknown>,options:Parameters<DbClient['transaction']>[1])=>{
    // This await includes the actual PostgreSQL COMMIT. The controlled error
    // is outside its callback/transaction; no1/0 or SQL rollback substitutes.
    await transaction(actual=>callback(actual as unknown as DbClient),options);committed=true;
    throw Error('Controlled lost COMMIT acknowledgement');
   };}});
  await expect(captureRechargeRefundSuccessFirstResult({...f.adminContainer,db:wrapped},f.env,'admin',r.operation.operation_id,r.receipt.resultId))
   .rejects.toThrow('Controlled lost COMMIT acknowledgement');expect(committed).toBe(true);
  const flows=await f.flow(String(r.operation.operation_id)),notices=await f.notice(String(r.operation.operation_id)),rows=await records(r);
  expect(flows).toHaveLength(1);expect(notices).toHaveLength(1);expect(rows).toHaveLength(2);
  const local=rows.find(row=>row.source==='local_settlement');if(!local)throw Error('Actual committed local capture missing');
  const [recharge]=await f.adminRuntime.db.select({refund:userRecharge.refundPrice}).from(userRecharge).where(eq(userRecharge.id,r.order.id));
  expect(recharge.refund).toBe('10.00');expect(await f.wallet(r.order.uid)).toBe('1.50');
  expect((await projection(r))[0]).toMatchObject({status:'SUCCEEDED',wallet_state:'captured',version:2,last_result_id:local.result_id});
  const replay=await strictReplay(r,'financial');expect(replay.localResultId).toBe(local.result_id);
  expect(replay.flowId).toBe(flows[0].id);expect(replay.noticeId).toBe(notices[0].id);
  expect(f.posts).toHaveLength(posts);expect(f.messages).toHaveLength(messages);
 }),5000);

 for(const [field,value]of[['price','-9.99'],['nickname','controlled changed snapshot'],['store_id',99],['flow_id','controlled_changed_flow']]as const)
  it('refuses terminal physical '+field+' tamper while keeping provider/local history durable',()=>start(async()=>{
   const r=completedOperation(),[original]=await f.flow(String(r.operation.operation_id));if(!original)throw Error('Actual flow missing');
   const originalValue=field==='price'?original.price:field==='nickname'?original.nickname:field==='store_id'?original.storeId:original.flowId;
   await f.adminRuntime.db.execute(sql`UPDATE public.capital_flow SET ${sql.identifier(field)}=${value} WHERE id=${original.id}`);
   try{await noWrite(r,()=>f.capture(r.operation.operation_id,r.receipt.resultId));}finally{await f.adminRuntime.db.execute(sql`UPDATE public.capital_flow SET ${sql.identifier(field)}=${originalValue} WHERE id=${original.id}`);}
  }),5000);
 for(const kind of['payload','aggregate_id']as const)it('refuses terminal physical notice '+kind+' tamper',()=>start(async()=>{
  const r=completedOperation(),[original]=await f.notice(String(r.operation.operation_id));if(!original)throw Error('Actual notice missing');
  if(kind==='payload')await f.adminRuntime.db.execute(sql`UPDATE public.store_order_outbox SET payload=pg_catalog.jsonb_set(payload,'{signature}',pg_catalog.to_jsonb(pg_catalog.repeat('0',64))) WHERE id=${original.id}`);
  else await f.adminRuntime.db.update(storeOrderOutbox).set({aggregateId:r.order.id+1}).where(eq(storeOrderOutbox.id,original.id));
  try{await noWrite(r,()=>f.capture(r.operation.operation_id,r.receipt.resultId));}finally{await f.adminRuntime.db.update(storeOrderOutbox).set({payload:original.payload,aggregateId:original.aggregateId}).where(eq(storeOrderOutbox.id,original.id));}
 }),5000);
 it('refuses a second physical flow alias instead of choosing the apparently correct row',()=>start(async()=>{
  const r=completedOperation(),[original]=await f.flow(String(r.operation.operation_id));if(!original)throw Error('Actual flow missing');
  const{id:_id,...body}=original,[duplicate]=await f.adminRuntime.db.insert(capitalFlow).values({...body,eventKey:null}).returning({id:capitalFlow.id});
  try{await noWrite(r,()=>f.capture(r.operation.operation_id,r.receipt.resultId));}finally{await f.maintenanceDb.delete(capitalFlow).where(eq(capitalFlow.id,duplicate.id));}
 }),5000);
 it('does not reinterpret a terminal state pointer to the provider row as a local settlement receipt',()=>start(async()=>{
  const r=completedOperation(),[old]=await projection(r);expect(old.status).toBe('SUCCEEDED');expect(old.last_result_id).not.toBe(r.receipt.resultId);
  let blocked:unknown;try{await f.adminRuntime.db.execute(sql`UPDATE public.recharge_refund_state SET last_result_id=${r.receipt.resultId}::uuid WHERE operation_id=${r.operation.operation_id}::uuid`);}catch(error){blocked=error;}
  expect(code(blocked)).toBe('23514');expect((await projection(r))[0].last_result_id).toBe(old.last_result_id);
  // Owner-only negative specimen, never accepted financial truth. Restore the
  // exact row trigger before COMMIT, so the real role sees the complete catalog.
  const writePointer=async(pointer:string)=>f.maintenanceDb.transaction(async tx=>{
   await tx.execute(sql`ALTER TABLE public.recharge_refund_state DISABLE TRIGGER rcrs_guard_rows`);
   const rows=await tx.execute(sql`UPDATE public.recharge_refund_state SET last_result_id=${pointer}::uuid WHERE operation_id=${r.operation.operation_id}::uuid RETURNING last_result_id`);
   expect(rows).toHaveLength(1);expect(rows[0].last_result_id).toBe(pointer);
   await tx.execute(sql`ALTER TABLE public.recharge_refund_state ENABLE TRIGGER rcrs_guard_rows`);
  });
  await writePointer(r.receipt.resultId);
  try{await noWrite(r,()=>f.capture(r.operation.operation_id,r.receipt.resultId));}finally{await writePointer(String(old.last_result_id));}
  await strictReplay(r,'financial');
 }),5000);
 it('refuses terminal hold tamper without consulting the current wallet or recapturing',()=>start(async()=>{
  const r=completedOperation(),rows=await f.adminRuntime.db.select().from(userBill).where(eq(userBill.eventKey,'recharge_refund_hold:'+r.operation.operation_id));
  expect(rows).toHaveLength(1);await f.adminRuntime.db.update(userBill).set({mark:'controlled terminal hold tamper'}).where(eq(userBill.id,rows[0].id));
  try{await noWrite(r,()=>f.capture(r.operation.operation_id,r.receipt.resultId));}finally{await f.adminRuntime.db.update(userBill).set({mark:rows[0].mark}).where(eq(userBill.id,rows[0].id));}
 }),5000);
 it('does not confuse an actual pre-POST cancellation with a persisted provider SUCCESS',()=>start(async()=>{
  // Distinct unused fixture buyer, not an extension of the shared20-user pool.
  const uid=rechargeAuthorUids[19];await f.approve();const paid=await f.paid(uid),q=await f.quote(paid.order),key=randomUUID();
  const op=(await f.admit(key,f.body(paid.order,q,true))).operation;await f.cancel(paid.order,key);
  const rows=await f.adminRuntime.db.execute(sql`SELECT * FROM public.recharge_refund_result WHERE operation_id=${op.operation_id}::uuid`);
  const cancel=rows.find(row=>row.source==='local_cancel');if(!cancel)throw Error('Actual cancellation cause missing');
  const before=await f.economicSnapshot(paid.order);await expect(f.capture(op.operation_id,cancel.result_id)).rejects.toThrow();expect(await f.economicSnapshot(paid.order)).toBe(before);
 }),5000);
});
