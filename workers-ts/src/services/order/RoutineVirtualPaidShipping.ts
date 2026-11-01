import { and, asc, eq, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { otherOrder, storeOrderOutbox, systemConfig, userRecharge, type WechatShippingNotificationPayload } from '@/models/schema';
import { assertRoutineVirtualShippingSubjectsReadTx, assertRoutineVirtualShippingSubjectsStageTx } from '@/migrations/routineVirtualShippingSubjects';
import { amountToCents } from '@/services/payment/RefundGateway';
import { captureRoutineShippingEnv, routineShippingClockTx, routineShippingUnavailable, shippingEqual, shippingInteger, shippingMac, shippingObject, shippingSame } from '@/services/payment/RoutineShippingAccount';
import { readRoutineShippingOriginalTx } from '@/services/payment/RoutineShippingOriginal';
import { normalizeConfigScalar } from '@/utils/config';

export type RoutineVirtualShippingDomain='recharge'|'membership';
export const ROUTINE_VIRTUAL_PAID_MARK='paid_virtual_shipping';
export const ROUTINE_VIRTUAL_PAID_DELAY=10;
type Signing=Pick<Env,'APP_KEY'>;
export function routineVirtualPaidKey(value:unknown):{domain:RoutineVirtualShippingDomain;id:number}|null{
  if(typeof value!=='string')return null;
  const m=/^(recharge|membership)\.paid\.shipping:([1-9]\d*)$/u.exec(value);
  if(!m||!shippingInteger(Number(m[2])))return null;
  return{domain:m[1] as RoutineVirtualShippingDomain,id:Number(m[2])};
}
export interface RoutineVirtualPaidSource {
  format:1;domain:RoutineVirtualShippingDomain;subjectId:number;buyerUid:number;orderNo:string;
  transactionId:string;totalAmount:number;payTime:number;description:string;path:string;facts:unknown;
}
async function physical(tx:DbClient,domain:RoutineVirtualShippingDomain,id:number):Promise<RoutineVirtualPaidSource>{
  if(!shippingInteger(id))return routineShippingUnavailable();
  const table=domain==='recharge'?'user_recharge':domain==='membership'?'other_order':null;
  if(!table)return routineShippingUnavailable();
  const [resolution]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.to_regclass(${table})=pg_catalog.to_regclass(${'public.'+table})
    AND pg_catalog.to_regclass('store_order_outbox')=pg_catalog.to_regclass('public.store_order_outbox') AS ready`);
  if(resolution?.ready!==true)return routineShippingUnavailable();
  if(domain==='recharge'){
    const rows=await tx.select().from(userRecharge).where(eq(userRecharge.id,id)).limit(2).for('update',{noWait:true}),r=rows[0];
    const amount=r&&amountToCents(r.price);
    if(rows.length!==1||!shippingInteger(r.uid)||r.paid!==1||r.rechargeType!=='weixin'||!r.tradeNo.trim()
      ||!shippingInteger(r.payTime)||amount===null||!shippingInteger(amount)||amountToCents(r.refundPrice)!==0)return routineShippingUnavailable();
    return{format:1,domain,subjectId:r.id,buyerUid:r.uid,orderNo:r.orderId,transactionId:r.tradeNo,totalAmount:amount,payTime:r.payTime,
      description:`用户充值${(amount/100).toFixed(2)}`,path:'/pages/users/user_bill/index?type=2',
      facts:{id:r.id,uid:r.uid,orderNo:r.orderId,price:r.price,givePrice:r.givePrice,payTime:r.payTime,paid:r.paid,payType:r.rechargeType,tradeNo:r.tradeNo}};
  }
  if(domain!=='membership')return routineShippingUnavailable();
  const rows=await tx.select().from(otherOrder).where(eq(otherOrder.id,id)).limit(2).for('update',{noWait:true}),r=rows[0];
  const amount=r&&amountToCents(r.payPrice);
  if(rows.length!==1||!shippingInteger(r.uid)||r.paid!==1||r.payType!=='weixin'||!r.tradeNo.trim()||r.type!==1||r.isFree!==0||r.isDel!==0
    ||!shippingInteger(r.payTime)||amount===null||!shippingInteger(amount)||![0,1].includes(r.isPermanent)
    ||r.isPermanent===0&&!shippingInteger(r.vipDay))return routineShippingUnavailable();
  // memberType is a plan ID in TS, not PHP's resolved plan.type. Describe the
  // actual saved right rather than consulting today's mutable plan or user.
  return{format:1,domain,subjectId:r.id,buyerUid:r.uid,orderNo:r.orderId,transactionId:r.tradeNo,totalAmount:amount,payTime:r.payTime,
    description:`用户购买${r.isPermanent===1?'永久':`${r.vipDay}天`}会员卡`,path:'/pages/annex/vip_paid/index',
    facts:{id:r.id,uid:r.uid,orderNo:r.orderId,price:r.payPrice,payTime:r.payTime,paid:r.paid,payType:r.payType,tradeNo:r.tradeNo,
      type:r.type,memberType:r.memberType,isFree:r.isFree,isPermanent:r.isPermanent,vipDay:r.vipDay,overdueTime:r.overdueTime}};
}
export function routineVirtualPaidPayload(source:RoutineVirtualPaidSource):WechatShippingNotificationPayload{
  return{kind:'wechat_shipping',transactionId:source.transactionId,logisticsType:3,deliveryMode:1,isAllDelivered:true,
    itemDescription:source.description,trackingNumber:'',expressCompanyName:'',receiverContact:'',path:source.path};
}

/** Only the fresh real provider-settlement transaction calls this author.
 * The original guard, wallet/rights, source and delivery commit together. */
export async function stageRoutineVirtualPaidShippingTx(tx:DbClient,signing:Signing|undefined,domain:RoutineVirtualShippingDomain,id:number,now:number):Promise<string|null>{
  if(signing===undefined)return null;
  const signingSnapshot={APP_KEY:signing.APP_KEY};
  if(!shippingInteger(now)||!shippingInteger(id)||domain!=='recharge'&&domain!=='membership')return routineShippingUnavailable();
  const configs=await tx.select({value:systemConfig.value}).from(systemConfig).where(eq(systemConfig.menuName,'order_shipping_open')).orderBy(asc(systemConfig.id)).limit(2);
  if(configs.length>1)return routineShippingUnavailable();
  if(!['1','true'].includes(normalizeConfigScalar(configs[0]?.value).toLowerCase()))return null;
  if(!await assertRoutineVirtualShippingSubjectsStageTx(tx))return null;
  const env=captureRoutineShippingEnv(signingSnapshot);
  const source=await physical(tx,domain,id);
  await readRoutineShippingOriginalTx(tx,env,{domain,rootId:id,buyerUid:source.buyerUid,orderNo:source.orderNo,
    transactionId:source.transactionId,totalAmount:source.totalAmount});
  // Defer from the successful author, not the earlier payment entry clock;
  // waiting for financial locks must not consume PHP's ten-second delay.
  const stagedAt=await routineShippingClockTx(tx);
  const key=`${domain}.paid.shipping:${id}`,payload={source,signature:shippingMac(env,'virtual-paid-source',source)};
  // This completed source witnesses the financial commit; its replay must
  // never execute financial effects again. Only its delivery is dispatched.
  const rows=await tx.execute<{id:number}>(sql`INSERT INTO public.store_order_outbox
    (event_key,aggregate_type,aggregate_id,event_type,payload,status,available_time,processed_time,add_time,update_time)
    VALUES(${key},${domain},${id},${domain+'.paid.shipping'},${JSON.stringify(payload)}::text::jsonb,'COMPLETED',${stagedAt},${stagedAt},${stagedAt},${stagedAt}) RETURNING id`);
  if(rows.length!==1)return routineShippingUnavailable();
  const deliveryPayload=routineVirtualPaidPayload(source);
  await tx.execute(sql`INSERT INTO public.order_notification_delivery
    (outbox_id,event_key,order_id,withdrawal_id,subject_domain,subject_id,user_id,notice_mark,channel,target,template_code,payload,status,available_time,add_time,update_time)
    VALUES(${rows[0].id},${key},NULL,NULL,${domain},${id},${source.buyerUid},${ROUTINE_VIRTUAL_PAID_MARK},'wechat_shipping','','',
      ${JSON.stringify(deliveryPayload)}::text::jsonb,'PENDING',${stagedAt+ROUTINE_VIRTUAL_PAID_DELAY},${stagedAt},${stagedAt})`);
  return key;
}

/** Consumer locks the real physical domain before its source/delivery. */
export async function readRoutineVirtualPaidSourceTx(tx:DbClient,env:Signing,eventKey:string){
  const key=routineVirtualPaidKey(eventKey);if(!key||!await assertRoutineVirtualShippingSubjectsReadTx(tx))return routineShippingUnavailable();
  const source=await physical(tx,key.domain,key.id);
  const events=await tx.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateId,key.id),eq(storeOrderOutbox.eventType,key.domain+'.paid.shipping')))
    .limit(2).for('share',{noWait:true}),event=events[0];
  if(events.length!==1||event.eventKey!==eventKey||event.aggregateType!==key.domain||event.status!=='COMPLETED')return routineShippingUnavailable();
  const p=shippingObject(event.payload,['source','signature']);
  if(typeof p.signature!=='string'||!shippingEqual(p.signature,shippingMac(env,'virtual-paid-source',p.source))||!shippingSame(p.source,source))return routineShippingUnavailable();
  return{source,event};
}
