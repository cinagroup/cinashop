/** Authenticated first provider recharge. A writable bill alone is not authority. */
import {and,eq,sql} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {userRecharge,userBill,storeOrderOutbox,paymentCallbackEvent,paymentReconciliationCase} from '@/models/schema';
import {ServiceUnavailableException} from '@/utils/errors';
import {subscriptionMac,subscriptionEqual,subscriptionSame} from '@/services/wechat/RoutineSubscriptionAccount';
import {captureRechargePaidNoticeBusiness,rechargePaidNoticeObject,rechargePaidSettlementKey,type RechargePaidNoticeBusiness} from './RechargePaidNoticeCodec';
import {assertRechargeRefundRuntimeTx,type RechargeRefundRuntimeRole} from '@/migrations/rechargeRefund';
export type RechargeNoticeSigning=Readonly<{APP_KEY?:string}>;
export type RechargeNoticeProvider={kind:'callback'|'signed-query';id:number;replayKey:string};
export function rechargeNoticeSigning(env:RechargeNoticeSigning|undefined):Readonly<{APP_KEY:string}>{const d=env&&Object.getOwnPropertyDescriptor(env,'APP_KEY');if(!d?.enumerable||!('value'in d)||typeof d.value!=='string'||!d.value||d.value.length>8192)throw new ServiceUnavailableException('充值付款通知签名尚未就绪');return Object.freeze({APP_KEY:d.value});}
async function scopeTx(tx:DbClient){const[s]=await tx.execute<{database:string;databaseOid:string;maintenance:string;maintenanceOid:string}>(sql`SELECT pg_catalog.current_database() AS database,(SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS "databaseOid",pg_catalog.pg_get_userbyid(c.relowner) AS maintenance,c.relowner::text AS "maintenanceOid" FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.store_order_outbox') AND pg_catalog.to_regclass('store_order_outbox')=c.oid AND pg_catalog.to_regclass('user_recharge')=pg_catalog.to_regclass('public.user_recharge') AND pg_catalog.to_regclass('user_bill')=pg_catalog.to_regclass('public.user_bill') AND pg_catalog.to_regclass('user')=pg_catalog.to_regclass('public.user')`);if(!s||!s.database||!s.maintenance||!/^[1-9]\d*$/u.test(s.databaseOid)||!/^[1-9]\d*$/u.test(s.maintenanceOid))throw new ServiceUnavailableException('充值付款通知数据库来源无效');return s;}
const unavailable=():never=>{throw new ServiceUnavailableException('充值付款通知真实结算来源无效');};
async function providerTx(tx:DbClient,input:RechargeNoticeProvider,body:RechargePaidNoticeBusiness,fresh:boolean,lockRows=true){
 const r=rechargePaidNoticeObject(input,['kind','id','replayKey']);if((typeof r.kind!=='string'||!['callback','signed-query'].includes(r.kind))||!Number.isSafeInteger(r.id)||Number(r.id)<1||typeof r.replayKey!=='string'||!/^[a-f0-9-]{36}$/u.test(r.replayKey))return unavailable();
 const provider=body.payType==='weixin'?'wechat':'alipay',amount=Number(BigInt(body.payPrice.replace('.','')));
 if(r.kind==='callback'){
  const query=tx.select().from(paymentCallbackEvent).where(eq(paymentCallbackEvent.id,Number(r.id))).limit(2);
  const rows=await(lockRows?query.for('share',{noWait:true}):query),p=rows[0];
  if(rows.length!==1||p.replayKey!==r.replayKey||p.provider!==provider||p.orderNo!==body.orderNo||p.transactionId!==body.tradeNo||p.amountCents!==amount||p.currency!=='CNY'||!(provider==='wechat'?p.tradeState==='SUCCESS':['TRADE_SUCCESS','TRADE_FINISHED'].includes(p.tradeState))||!['','recharge'].includes(p.orderDomain)||!(fresh?['PROCESSING']:['PROCESSING','COMPLETED']).includes(p.status))return unavailable();
  return{kind:'callback',id:p.id,replayKey:p.replayKey,provider:p.provider,profile:p.profile,providerEventId:p.providerEventId,payloadHash:p.payloadHash,orderNo:p.orderNo,transactionId:p.transactionId,tradeState:p.tradeState,amountCents:p.amountCents,currency:p.currency};
 }
 const query=tx.select().from(paymentReconciliationCase).where(eq(paymentReconciliationCase.id,Number(r.id))).limit(2);
 const rows=await(lockRows?query.for('share',{noWait:true}):query),p=rows[0];
 if(rows.length!==1||p.replayKey!==r.replayKey||p.provider!==provider||p.orderNo!==body.orderNo||p.providerTransactionId!==body.tradeNo||p.expectedAmountCents!==amount||!['','recharge'].includes(p.orderDomain)||!(fresh?['QUERYING']:['QUERYING','SETTLED','CONFIRMED']).includes(p.status))return unavailable();
 return{kind:'signed-query',id:p.id,replayKey:p.replayKey,provider:p.provider,profile:p.profile,orderNo:p.orderNo,transactionId:p.providerTransactionId,amountCents:p.expectedAmountCents,initiatedTime:p.initiatedTime};
}
async function physicalTx(tx:DbClient,body:RechargePaidNoticeBusiness,lockRows=true){
 const orderQuery=tx.select().from(userRecharge).where(eq(userRecharge.id,body.orderId)).limit(2);
 const orders=await(lockRows?orderQuery.for('share',{noWait:true}):orderQuery),order=orders[0];
 if(orders.length!==1||order.orderId!==body.orderNo||order.uid!==body.userId||order.paid!==1||order.price!==body.payPrice||order.givePrice!==body.giftPrice||order.rechargeType!==body.payType||order.payTime!==body.payTime||order.addTime!==body.creationTime||order.tradeNo!==body.tradeNo)return unavailable();
 const billQuery=tx.select().from(userBill).where(and(eq(userBill.linkId,body.orderNo),eq(userBill.eventKey,'recharge_external_payment'))).limit(2);
 const bills=await(lockRows?billQuery.for('share',{noWait:true}):billQuery),bill=bills[0];
 if(bills.length!==1||bill.id!==body.billId||bill.uid!==body.userId||bill.pm!==1||bill.category!=='now_money'||bill.type!=='recharge'||bill.number!==body.creditedAmount||bill.balance!==body.postBalance||bill.status!==1||bill.addTime!==body.payTime)return unavailable();
 return{order,bill:{id:bill.id,uid:bill.uid,linkId:bill.linkId,eventKey:bill.eventKey,pm:bill.pm,category:bill.category,type:bill.type,number:bill.number,balance:bill.balance,status:bill.status,addTime:bill.addTime}};
}
export async function rechargePaidSettlementPayload(
  tx: DbClient,
  env: RechargeNoticeSigning,
  input: RechargePaidNoticeBusiness,
  authority: RechargeNoticeProvider
) {
  const business = captureRechargePaidNoticeBusiness(input),
    signing = rechargeNoticeSigning(env),
    scope = await scopeTx(tx),
    { bill } = await physicalTx(tx, business),
    provider = await providerTx(tx, authority, business, true);
  const unsigned = { scope, business, bill, provider };
  return { ...unsigned, signature: subscriptionMac(signing, 'recharge-paid-settlement-v1', unsigned) };
}

export async function readRechargePaidSettlementTx(
  tx: DbClient,
  env: RechargeNoticeSigning,
  input: RechargePaidNoticeBusiness
) {
  return readSettlementTx(tx,env,input,true);
}

/** Purpose-specific historical reader under actual recharge commissioning.
 * No UPDATE is granted on provider or settled-payment evidence just to acquire
 * a read lock. The refund author has already pinned the recharge/payment
 * boundary; read-only recovery uses one RR snapshot. Every original scalar,
 * provider row, bill and scope is still checked against the full settlement MAC.
 * The existing settlement/notice reader keeps its original locking behavior. */
export async function readRechargePaidSettlementForRefundTx(
  tx:DbClient,env:RechargeNoticeSigning,input:RechargePaidNoticeBusiness,
  role:RechargeRefundRuntimeRole,mode:'write'|'read'='write'
) {
  await assertRechargeRefundRuntimeTx(tx,role,mode);
  const [resolution]=await tx.execute<{ready:boolean}>(sql`SELECT
    pg_catalog.to_regclass('payment_callback_event')=pg_catalog.to_regclass('public.payment_callback_event')
    AND pg_catalog.to_regclass('payment_reconciliation_case')=pg_catalog.to_regclass('public.payment_reconciliation_case') AS ready`);
  if(resolution?.ready!==true)return unavailable();
  return readSettlementTx(tx,env,input,false);
}

async function readSettlementTx(tx:DbClient,env:RechargeNoticeSigning,input:RechargePaidNoticeBusiness,lockRows:boolean) {
  const body = captureRechargePaidNoticeBusiness(input),
    signing = rechargeNoticeSigning(env),
    scope = await scopeTx(tx);
  const query = tx.select().from(storeOrderOutbox)
    .where(eq(storeOrderOutbox.eventKey, rechargePaidSettlementKey(body.orderId)))
    .limit(2);
  const rows = await(lockRows?query.for('share', { noWait: true }):query),
    event = rows[0];
  if (rows.length !== 1 || event.eventType !== 'recharge.settled' || event.aggregateType !== 'recharge'
    || event.aggregateId !== body.orderId || event.status !== 'COMPLETED'
    || event.addTime !== body.occurredAt || event.processedTime !== body.occurredAt) return unavailable();
  const p = rechargePaidNoticeObject(event.payload, ['scope', 'business', 'bill', 'provider', 'signature']);
  const { order, bill } = await physicalTx(tx, body,lockRows);
  if (!p.provider || typeof p.provider !== 'object') return unavailable();
  const ds = Object.getOwnPropertyDescriptors(p.provider);
  const fields = ds.kind?.value === 'callback'
    ? ['kind', 'id', 'replayKey', 'provider', 'profile', 'providerEventId', 'payloadHash', 'orderNo', 'transactionId', 'tradeState', 'amountCents', 'currency']
    : ['kind', 'id', 'replayKey', 'provider', 'profile', 'orderNo', 'transactionId', 'amountCents', 'initiatedTime'];
  const authority = rechargePaidNoticeObject(p.provider, fields);
  const provider = await providerTx(tx, {
    kind: authority.kind as RechargeNoticeProvider['kind'],
    id: Number(authority.id),
    replayKey: String(authority.replayKey)
  }, body, false,lockRows);
  const unsigned = { scope, business: body, bill, provider };
  if (!subscriptionSame(p.scope, scope) || !subscriptionSame(p.business, body)
    || !subscriptionSame(p.bill, bill) || !subscriptionSame(p.provider, provider)
    || !subscriptionEqual(p.signature, subscriptionMac(signing, 'recharge-paid-settlement-v1', unsigned))) return unavailable();
  return { event, order, bill };
}
