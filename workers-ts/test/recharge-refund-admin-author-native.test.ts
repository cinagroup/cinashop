/** Author acceptance, not refund HTTP or merchant-refund acceptance. Actual
 * JWT recharge producer, local signed archived-account callback and App paid
 * consumer feed actual non-level0 Admin quote/admit/cancel on formal profiles. */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { systemAdmin, storeOrderOutbox, paymentCallbackEvent } from '@/models/schema';
import { quoteAdminRechargeRefund } from '@/services/admin/AdminRechargeRefundAdmission';
import { authenticateRechargeRefundRecord } from '@/services/payment/RechargeRefundLedger';
import { rechargeRefundDecimal } from '@/services/payment/RechargeRefundMoney';
import { ApiErrorCode } from '@/utils/errors';
import { rechargeRefundAdminAuthorFixture, rechargeAuthorUids,
 type RechargeRefundAdminAuthorFixture, type AuthorRecharge } from './helpers/rechargeRefundAdminAuthorNative';

// Only external Redis/cache I/O is replaced. All actor, owner, provider crypto,
// source, SQL catalog, business author and journaling code executes unchanged.
const transport=vi.hoisted(()=>{
 const values=new Map<string,unknown>();
 const get=vi.fn(async(key:string)=>values.get(key)??null);
 const set=vi.fn(async(key:string,value:unknown)=>{values.set(key,value);return true;});
 const remove=vi.fn(async(key:string)=>values.delete(key));
 const take=vi.fn(async(key:string)=>{const value=values.get(key)??null;values.delete(key);return value;});
 const setIfAbsent=vi.fn(async(key:string,value:unknown)=>{if(values.has(key))return false;values.set(key,value);return true;});
 const redis={eval:vi.fn(async()=>1),get,set:vi.fn(async(key:string,value:unknown)=>{await set(key,value);return 'OK';}),del:vi.fn(async(key:string)=>Number(await remove(key)))};
 return{values,get,set,remove,take,setIfAbsent,redis};
});
vi.mock('@/utils/cache',async original=>({...await original<typeof import('@/utils/cache')>(),getRedis:()=>transport.redis,
 cacheGet:transport.get,cacheSet:transport.set,cacheTake:transport.take,cacheDelete:transport.remove,cacheSetIfAbsent:transport.setIfAbsent,
 setTokenBucket:vi.fn(async()=>true),clearToken:vi.fn(async()=>true)}));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual recharge payment to Admin refund authors on full PG16 profiles',()=>{
 let f:RechargeRefundAdminAuthorFixture,nextUid=0;
 const uid=()=>{const value=rechargeAuthorUids[nextUid++];if(!value)throw Error('Distinct actual buyer fixture exhausted');return value;};
 const facts=async(order:AuthorRecharge)=>JSON.parse(await f.snapshot(order));
 beforeAll(async()=>{f=await rechargeRefundAdminAuthorFixture(transport.values);},240000);
 afterAll(async()=>{try{await f?.close();}finally{vi.restoreAllMocks();}},30000);
 afterEach(()=>{
  if(!f)return;
  // Unexpected requests also fail when an existing best-effort delivery catches
  // its transport exception. In particular, NO merchant refund POST is claimed.
  expect(f.calls).toHaveLength(rechargeAuthorUids.length);
  expect(f.calls.every(call=>{const url=new URL(call.url);return call.method==='GET'&&url.origin==='https://api.weixin.qq.com'&&url.pathname==='/sns/jscode2session';})).toBe(true);
 });

 it('keeps five independent LOGINs and the real non-level0 dedicated capability',async()=>{
  expect(new Set(Object.values(f.identities).map(identity=>identity.pid)).size).toBe(5);
  expect(new Set(Object.values(f.identities).map(identity=>identity.oid)).size).toBe(5);
  const [admin]=await f.maintenanceDb.select().from(systemAdmin).where(eq(systemAdmin.id,f.actor().id));
  expect(admin).toMatchObject({adminType:1,level:1,status:1,isDel:0});
  // The fixture's real complete commissioner already accepts ALL five before
  // and after profiles in setup. Do not repeat five whole catalog audits in a
  // single 5s business case; inspect its independently observed predecessors.
  for(const kind of ['app','admin','financial','manager','cashier'] as const)expect(f.beforeAudits[kind]).toMatchObject({ready:true});
 },5000);

 // Deliberately first financial case: the fixture commissions the account
 // TABLE but never creates its independent recharge-refund approval.
 it('does not infer refund approval from the actual archived A payment approval or current B configuration',async()=>{
  const {order}=await f.paid(uid());expect(await f.wallet(order.uid)).toBe('11.50');
  const before=await f.snapshot(order);
  await expect(f.quote(order)).rejects.toThrow('批准');
  await expect(f.admit(randomUUID(),{version:'admin-recharge-refund-v1',rechargeId:order.id,quoteFingerprint:'0'.repeat(64),recoverGift:false})).rejects.toThrow('批准');
  expect(await f.snapshot(order)).toBe(before);
 },5000);

 for(const recoverGift of [false,true]) {
  it('admits the real '+(recoverGift?'principal-plus-gift':'principal-only')+' hold once and cancels using immutable local results',async()=>{
   const approval=await f.approve(),{order,transaction}=await f.paid(uid()),q=await f.quote(order);
   expect(q).toMatchObject({version:'admin-recharge-refund-v1',rechargeId:order.id,buyerUid:order.uid,orderNo:order.orderId});
   const debit=recoverGift?1150:1000,remaining=recoverGift?'0.00':'1.50';
   expect(q.options.find(option=>option.recoverGift===recoverGift)).toMatchObject({sufficient:true,principal:'10.00',gift:'1.50',walletDebitCents:debit,availableBalance:'11.50',postBalance:remaining});
   const key=randomUUID(),request=f.body(order,q,recoverGift),first=await f.admit(key,request),op=first.operation;
   expect(first.replayed).toBe(false);expect(op).toMatchObject({admission:'reserved',admin_id:f.actor().id,recharge_id:order.id,buyer_uid:order.uid,
    provider:'wechat',payment_profile:'routine',transaction_id:transaction,principal_cents:1000,gift_cents:150,reclaim_gift:recoverGift,
    debit_cents:debit,wallet_before:1150,wallet_after:1150-debit,payment_source:{refundApproval:{recordId:approval.recordId}}});
   expect(op.out_refund_no).toBe('CNSCR'+String(op.operation_id).replaceAll('-',''));
   const held=await facts(order);expect(held.wallet.now_money).toBe(remaining);expect(held.recharge).toMatchObject({paid:1,refund_price:'0.00',trade_no:transaction});
   expect(held.states).toHaveLength(1);expect(held.states[0]).toMatchObject({status:'RESERVED',wallet_state:'held',version:0,attempt_count:0});
   expect(held.attempts).toEqual([]);expect(held.results).toEqual([]);
   const holds=held.bills.filter((bill:{type:string})=>bill.type==='recharge_refund');expect(holds).toHaveLength(1);
   expect(holds[0]).toMatchObject({uid:order.uid,event_key:'recharge_refund_hold:'+op.operation_id,pm:0,type:'recharge_refund',number:rechargeRefundDecimal(debit),balance:remaining});
   const exact=await f.snapshot(order);expect(await f.admit(key,request)).toEqual({operation:op,replayed:true});expect(await f.snapshot(order)).toBe(exact);
   const cancelled=await f.cancel(order,key);expect(cancelled).toMatchObject({operation:op,released:true});
   const released=await facts(order);expect(released.wallet.now_money).toBe('11.50');expect(released.recharge).toEqual(held.recharge);
   expect(released.operations).toEqual(held.operations);expect(released.attempts).toEqual([]);
   expect(released.states[0]).toMatchObject({status:'FAILED',wallet_state:'released',version:1,attempt_count:0});
   const results=await f.maintenanceDb.execute(sql`SELECT * FROM public.recharge_refund_result WHERE operation_id=${op.operation_id}::uuid ORDER BY source`);
   const authenticated=Array.from(results,row=>authenticateRechargeRefundRecord(f.env,f.binding,'recharge_refund_result',row));
   expect(authenticated).toHaveLength(2);expect(authenticated[0]).toMatchObject({source:'local_cancel',status:'CLOSED',attempt_id:null,caused_by_result_id:null});
   expect(authenticated[1]).toMatchObject({source:'local_release',status:'SUCCESS',attempt_id:null,caused_by_result_id:authenticated[0].result_id,
    evidence:{holdBillId:holds[0].id,debitCents:debit,walletBeforeCents:1150-debit,walletAfterCents:1150}});
   const releases=released.bills.filter((bill:{type:string})=>bill.type==='recharge_refund_release');expect(releases).toHaveLength(1);
   expect(releases[0]).toMatchObject({event_key:'recharge_refund_release:'+op.operation_id,pm:1,number:rechargeRefundDecimal(debit),balance:'11.50'});
  },5000);
 }

 it('rechecks actual approval revocation before new quote/admission and still safely releases an unused earlier hold',async()=>{
  await f.approve();const {order}=await f.paid(uid()),q=await f.quote(order),key=randomUUID(),request=f.body(order,q,true);
  const admitted=await f.admit(key,request);await f.approve(1,'revoked');
  const before=await f.snapshot(order);await expect(f.quote(order)).rejects.toThrow('批准');
  await expect(f.admit(randomUUID(),request)).rejects.toThrow('批准');expect(await f.snapshot(order)).toBe(before);
  expect(await f.admit(key,request)).toEqual({operation:admitted.operation,replayed:true});expect(await f.snapshot(order)).toBe(before);
  expect((await f.cancel(order,key)).released).toBe(true);expect(await f.wallet(order.uid)).toBe('11.50');
 },5000);

 it('invalidates the old quote on explicit credential-version change and binds fresh admission to the new approval',async()=>{
  await f.approve(1);const {order}=await f.paid(uid()),oldQuote=await f.quote(order),request=f.body(order,oldQuote,false);
  const rotated=await f.approve(2),before=await f.snapshot(order);
  await expect(f.admit(randomUUID(),request)).rejects.toMatchObject({httpStatus:409});expect(await f.snapshot(order)).toBe(before);
  const fresh=await f.quote(order);expect(fresh.options[0].quoteFingerprint).not.toBe(oldQuote.options[0].quoteFingerprint);
  const key=randomUUID(),admitted=await f.admit(key,f.body(order,fresh,false));
  expect(admitted.operation.payment_source).toMatchObject({refundApproval:{recordId:rotated.recordId}});
  expect((await f.cancel(order,key)).released).toBe(true);
 },5000);

 it('does not turn an explicit query-only approval into refund-request authority',async()=>{
  await f.approve(1,'active',['refund_query']);const {order}=await f.paid(uid()),before=await f.snapshot(order);
  await expect(f.quote(order)).rejects.toThrow('批准');expect(await f.snapshot(order)).toBe(before);
 },5000);

 it('fails closed on a retired credential registry despite valid original payment and current approval',async()=>{
  await f.approve(2);const {order}=await f.paid(uid()),q=await f.quote(order),before=await f.snapshot(order);
  const retired={...f.env,ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:'{}'};
  await expect(quoteAdminRechargeRefund(f.adminContainer,retired,f.actor(),order.id)).rejects.toThrow();
  await expect(f.admit(randomUUID(),f.body(order,q,true),f.actor(),retired)).rejects.toThrow();
  expect(await f.snapshot(order)).toBe(before);
 },5000);

 it('rechecks non-level0 dedicated capability and never accepts broad refund/order/user permissions',async()=>{
  await f.approve();const {order}=await f.paid(uid()),q=await f.quote(order),key=randomUUID(),request=f.body(order,q,false);
  await f.rules('refund.manage,order.manage,user.manage,recharge_order.view');
  try {
   const before=await f.snapshot(order);await expect(f.quote(order)).rejects.toMatchObject({code:ApiErrorCode.ERR_AUTH});
   await expect(f.admit(key,request)).rejects.toMatchObject({code:ApiErrorCode.ERR_AUTH});expect(await f.snapshot(order)).toBe(before);
  }finally{await f.rules('recharge_order.refund');}
  const admitted=await f.admit(key,request);expect(admitted.operation.admission).toBe('reserved');await f.cancel(order,key);
 },5000);

 it('rejects a stale quote after a second genuine recharge changes the wallet, with no attempted hold',async()=>{
  await f.approve();const {order}=await f.paid(uid()),q=await f.quote(order),request=f.body(order,q,true);
  await f.paid(order.uid);expect(await f.wallet(order.uid)).toBe('23.00');const before=await f.snapshot(order);
  await expect(f.admit(randomUUID(),request)).rejects.toMatchObject({httpStatus:409});expect(await f.snapshot(order)).toBe(before);
 },5000);

 for(const recoverGift of [false,true]) {
  it('persists insufficient '+(recoverGift?'principal-plus-gift':'principal-only')+' rejection after real wallet checkout and never upgrades the same key after real top-up',async()=>{
   await f.approve();const {order}=await f.paid(uid()),spent=await f.spend(order.uid);expect(await f.wallet(order.uid)).toBe('4.50');
   const spentProof=await facts(order);expect(spentProof.bills.some((bill:{link_id:string;pm:number;number:string})=>bill.link_id===spent.orderId&&bill.pm===0&&bill.number==='7.00')).toBe(true);
   const q=await f.quote(order);expect(q.options.every(option=>!option.sufficient&&option.availableBalance==='4.50'&&option.postBalance==='4.50')).toBe(true);
   const key=randomUUID(),request=f.body(order,q,recoverGift),before=await facts(order),rejected=await f.admit(key,request);
   expect(rejected).toMatchObject({replayed:false,operation:{admission:'rejected_insufficient',provider:null,payment_source:null,out_refund_no:null,
    wallet_before:450,wallet_after:450,debit_cents:recoverGift?1150:1000}});
   const after=await facts(order);expect(after.wallet).toEqual(before.wallet);expect(after.recharge).toEqual(before.recharge);expect(after.bills).toEqual(before.bills);
   expect(after.states).toEqual([]);expect(after.attempts).toEqual([]);expect(after.results).toEqual([]);expect(after.operations).toHaveLength(1);
   expect((await f.cancel(order,key)).released).toBe(false);
   await f.paid(order.uid);expect(await f.wallet(order.uid)).toBe('16.00');const topped=await f.snapshot(order);
   expect(await f.admit(key,request)).toEqual({operation:rejected.operation,replayed:true});expect(await f.snapshot(order)).toBe(topped);
  },5000);
 }

 it('never credits a second time on repeated actual cancellation or exact admission replay after release',async()=>{
  await f.approve();const {order}=await f.paid(uid()),key=randomUUID(),request=f.body(order,await f.quote(order),true),admitted=await f.admit(key,request);
  expect((await f.cancel(order,key)).released).toBe(true);const released=await f.snapshot(order);
  await expect(f.cancel(order,key)).rejects.toThrow('原操作已有执行证据');expect(await f.snapshot(order)).toBe(released);
  expect(await f.admit(key,request)).toEqual({operation:admitted.operation,replayed:true});expect(await f.snapshot(order)).toBe(released);
 },5000);

 it('refuses a second request key while the original actual hold remains unused and reserved',async()=>{
  await f.approve();const {order}=await f.paid(uid()),firstKey=randomUUID();await f.admit(firstKey,f.body(order,await f.quote(order),false));
  const fresh=await f.quote(order),before=await f.snapshot(order);
  await expect(f.admit(randomUUID(),f.body(order,fresh,false))).rejects.toThrow('已有预留');expect(await f.snapshot(order)).toBe(before);
  await f.cancel(order,firstKey);
 },5000);

 it('rejects an altered first-settlement signature without manufacturing a new source from paid/trade/bill fields',async()=>{
  await f.approve();const {order,event}=await f.paid(uid()),request=f.body(order,await f.quote(order),true);
  const original=event.payload;
  await f.maintenanceDb.update(storeOrderOutbox).set({payload:{...original,signature:'0'.repeat(64)} as typeof original}).where(eq(storeOrderOutbox.id,event.id));
  try {
   const before=await f.snapshot(order);await expect(f.quote(order)).rejects.toMatchObject({httpStatus:503});
   await expect(f.admit(randomUUID(),request)).rejects.toMatchObject({httpStatus:503});expect(await f.snapshot(order)).toBe(before);
  }finally{await f.maintenanceDb.update(storeOrderOutbox).set({payload:original}).where(eq(storeOrderOutbox.id,event.id));}
  expect((await f.quote(order)).options[0].sufficient).toBe(true);
 },5000);

 it('rejects a changed actual callback amount even while its original first-settlement MAC remains unchanged',async()=>{
  await f.approve();const {order}=await f.paid(uid()),request=f.body(order,await f.quote(order),false);
  const [callback]=await f.maintenanceDb.select().from(paymentCallbackEvent).where(eq(paymentCallbackEvent.orderNo,order.orderId));
  await f.maintenanceDb.update(paymentCallbackEvent).set({amountCents:999}).where(eq(paymentCallbackEvent.id,callback.id));
  try {
   const before=await f.snapshot(order);await expect(f.quote(order)).rejects.toMatchObject({httpStatus:503});
   await expect(f.admit(randomUUID(),request)).rejects.toMatchObject({httpStatus:503});expect(await f.snapshot(order)).toBe(before);
  }finally{await f.maintenanceDb.update(paymentCallbackEvent).set({amountCents:callback.amountCents}).where(eq(paymentCallbackEvent.id,callback.id));}
  expect((await f.quote(order)).options[0].sufficient).toBe(true);
 },5000);

 it('prevents maintenance from rewriting actual immutable original evidence and leaves the authenticated source readable',async()=>{
  await f.approve();const {order}=await f.paid(uid()),before=await f.snapshot(order);
  await expect(f.maintenanceDb.$client.unsafe("UPDATE public.routine_original_payment_evidence SET signature=repeat('0',64) WHERE order_no=$1",[order.orderId])).rejects.toThrow('immutable');
  expect(await f.snapshot(order)).toBe(before);expect((await f.quote(order)).options[0].sufficient).toBe(true);
 },5000);

 it('never adopts a real but unpaid UserJWT recharge as a refund source',async()=>{
  await f.approve();const order=await f.create(uid()),before=await f.snapshot(order);
  await expect(f.quote(order)).rejects.toThrow();expect(await f.snapshot(order)).toBe(before);
 },5000);
});
