import { Buffer } from 'node:buffer';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderOutbox, systemConfig } from '@/models/schema';
import { normalizeConfigScalar } from '@/utils/config';
import { amountToCents } from '@/services/payment/RefundGateway';
import { shippingInteger, shippingSame, routineShippingUnavailable } from '@/services/payment/RoutineShippingAccount';
import { routineShippingItemDescription } from '@/services/payment/RoutineShippingItems';
import { createImmutableDelivery, type OrderNotificationOutboxEvent } from './OrderNotificationOutboxService';
import { isOrderPaidSourcePayload } from './OrderPaidNoticeCodec';

export const ROUTINE_PAID_PICKUP_MARK='paid_pickup_shipping';
type Order=typeof storeOrder.$inferSelect;
type PaidEvent=typeof storeOrderOutbox.$inferSelect;

/** Status, verifyCode and writeoff counters are deliberately absent: PHP emits
 * this at payment, and a later genuine pickup must not rewrite that intent. */
function physical(order:Order){
  return{id:order.id,pid:order.pid,uid:order.uid,orderId:order.orderId,payPrice:order.payPrice,totalNum:order.totalNum,
    paid:order.paid,payType:order.payType,tradeNo:order.tradeNo,payTime:order.payTime,isChannel:order.isChannel,
    shippingType:order.shippingType,supplierId:order.supplierId,storeId:order.storeId,
    supplierAllocationStatus:order.supplierAllocationStatus,productType:order.productType,type:order.type};
}
export function paidPickupEventIdentity(event:PaidEvent){
  return{id:event.id,key:event.eventKey,type:event.eventType,aggregateId:event.aggregateId,
    aggregateType:event.aggregateType,payload:event.payload,addTime:event.addTime};
}

/** Read and lock the complete actual payment family. Supplier partitions are
 * one pickup, not express parcels; all physical quantities form one item_desc. */
export async function readRoutinePaidPickupSource(tx:DbClient,rootId:number,state:'PROCESSING'|'COMPLETED'){
  if(!shippingInteger(rootId))return routineShippingUnavailable();
  const family=await tx.select().from(storeOrder).where(or(eq(storeOrder.id,rootId),eq(storeOrder.pid,rootId)))
    .orderBy(asc(storeOrder.id)).limit(66).for('update',{noWait:true});
  const parent=family.find(o=>o.id===rootId);
  if(!parent||!family.length||family.length>65||![0,-1].includes(parent.pid)||!shippingInteger(parent.uid)
    ||parent.shippingType!==2||parent.supplierAllocationStatus!==2||!parent.tradeNo.trim())return routineShippingUnavailable();
  const leaves=parent.pid===-1?family.filter(o=>o.pid===parent.id):[parent];
  if(parent.pid===-1?(leaves.length<2||family.length!==leaves.length+1):family.length!==1)return routineShippingUnavailable();
  if(family.some(o=>o.uid!==parent.uid||o.paid!==1||o.payType!=='weixin'||o.shippingType!==2||o.storeId!==parent.storeId
    ||o.isDel!==0||o.isSystemDel!==0||o.refundStatus===2||o.refundStatus===3||o.refundType===6
    ||!shippingInteger(o.payTime)||!shippingInteger(o.totalNum)))return routineShippingUnavailable();
  const total=amountToCents(parent.payPrice),amounts=leaves.map(o=>amountToCents(o.payPrice));
  if(total===null||total<=0||amounts.some(n=>n===null||n<0)||amounts.reduce<number>((n,v)=>n+(v??0),0)!==total)return routineShippingUnavailable();
  const events=await tx.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateId,parent.id),
    eq(storeOrderOutbox.eventType,'order.paid'))).limit(2).for('share',{noWait:true});
  const event=events[0];
  if(events.length!==1||!event||event.aggregateType!=='order'||event.eventKey!==`order.paid:${parent.id}`||event.status!==state)return routineShippingUnavailable();
  if(!isOrderPaidSourcePayload(event.payload))return routineShippingUnavailable();
  const payload=event.payload;
  if(payload.orderId!==parent.id||payload.orderNo!==parent.orderId)return routineShippingUnavailable();
  const carts=await tx.select().from(storeOrderCartInfo).where(inArray(storeOrderCartInfo.oid,leaves.map(o=>o.id)))
    .orderBy(asc(storeOrderCartInfo.id)).limit(201).for('share',{noWait:true});
  if(!carts.length||carts.length>200||Buffer.byteLength(JSON.stringify(carts),'utf8')>1048576
    ||carts.some(c=>c.uid!==parent.uid||!shippingInteger(c.cartNum)))return routineShippingUnavailable();
  for(const leaf of leaves){
    const lines=carts.filter(c=>c.oid===leaf.id);
    if(!lines.length||lines.reduce((n,c)=>n+c.cartNum,0)!==leaf.totalNum)return routineShippingUnavailable();
  }
  if(carts.reduce((n,c)=>n+c.cartNum,0)!==parent.totalNum)return routineShippingUnavailable();
  return{parent,leaves,carts,event,total,description:routineShippingItemDescription(carts),
    facts:[family.map(physical),carts.map(c=>[c.id,c.oid,c.uid,c.cartId,c.cartNum,c.cartInfo]),paidPickupEventIdentity(event)]};
}

/** Called inside the real paid-outbox effects transaction after allocation.
 * No provider I/O, new outbox type, fabricated delivery notice or order-state
 * mutation. A failed payment effect rolls this pending delivery back too. */
export async function stageRoutinePaidPickupShipping(tx:DbClient,event:OrderNotificationOutboxEvent,order:Order,now:number){
  if(order.shippingType!==2||order.payType!=='weixin'||order.paid!==1||order.uid<=0)return;
  // The real payment service also uses this rail label for a free order. That
  // local completion has no provider transaction to report and keeps its paid
  // effects; it must never be promoted to an original WeChat payment.
  if(amountToCents(order.payPrice)===0)return;
  const configs=await tx.select({value:systemConfig.value}).from(systemConfig).where(eq(systemConfig.menuName,'order_shipping_open'))
    .orderBy(asc(systemConfig.id)).limit(2);
  if(configs.length>1)throw Error('小程序发货开关存在重复配置来源');
  if(!['1','true'].includes(normalizeConfigScalar(configs[0]?.value).toLowerCase()))return;
  const source=await readRoutinePaidPickupSource(tx,order.id,'PROCESSING');
  if(source.event.id!==event.id||source.event.eventKey!==event.eventKey||source.event.eventType!==event.eventType
    ||source.event.aggregateId!==event.aggregateId||!shippingSame(source.event.payload,event.payload))return routineShippingUnavailable();
  await createImmutableDelivery(tx,{event,payload:{orderId:source.parent.id,userId:source.parent.uid},mark:ROUTINE_PAID_PICKUP_MARK,
    channel:'wechat_shipping',target:'',templateCode:'',now,deliveryPayload:{kind:'wechat_shipping',transactionId:source.parent.tradeNo.trim(),
      logisticsType:4,deliveryMode:1,isAllDelivered:true,itemDescription:source.description,
      trackingNumber:'',expressCompanyName:'',receiverContact:'',path:`pages/goods/order_details/index?order_id=${source.parent.orderId}`}});
}
