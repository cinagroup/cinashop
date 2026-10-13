import {eq} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {storeOrder,storeOrderRefund,storeOrderOutbox,user,userBill,userBrokerage,type OrderRefundRefusedNoticeOutboxPayload} from '@/models/schema';
import {amountToCents} from '@/services/payment/RefundGateway';
import {outRequestHash} from '@/services/out/OutIdempotency';
import {CUSTOMER_ROW_REFUND_VERSION,readRefundQuantityReservation} from './RefundQuantityReservation';

/** Buyer zero has no inbox/WeChat account. A refusal notice belongs to the
 * actual global-customer physical-row application, never a caller's guest flag
 * or the creator/channel policy of an unrelated delivery notice. */
export async function assertGuestRefundRefusedNoticeSource(db:DbClient,payload:OrderRefundRefusedNoticeOutboxPayload,enqueue=false):Promise<void>{
 if(payload.userId!==0)throw Error('Guest refund notice requires numeric buyer zero');
 const orders=await db.select().from(storeOrder).where(eq(storeOrder.id,payload.orderId)).limit(2),refunds=await db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,payload.refundId)).limit(2);
 if(orders.length!==1||refunds.length!==1)throw Error('Guest refusal source unavailable');const order=orders[0],refund=refunds[0],claim=readRefundQuantityReservation(refund);
 const noticeCents=amountToCents(payload.payPrice);
 if(order.uid!==0||order.orderId!==payload.orderNo||refund.uid!==0||refund.storeOrderId!==order.id||refund.storeId!==order.storeId||refund.supplierId!==order.supplierId
 ||refund.refundType!==3||refund.isCancel||refund.isDel||!refund.refuseReason.trim()||refund.refundedTime<=0||claim?.version!==CUSTOMER_ROW_REFUND_VERSION||claim.uid!==0
 ||noticeCents===null||noticeCents<0||(enqueue&&payload.payPrice!==order.payPrice))throw Error('Guest refusal source inconsistent');
 // A literal lazy import avoids Notification -> Origin -> Cashier -> Outbox
 // initialization cycles and reuses the full reviewed payment/accountless
 // contract for both genuine TS and original PHP sources.
 if(enqueue){const{manualRefundPaymentFacts}=await import('./CustomerManualRefund');await manualRefundPaymentFacts(db,order);}
 else{
  const rootId=order.pid>0?order.pid:order.id,roots=await db.select().from(storeOrder).where(eq(storeOrder.id,rootId)).limit(2),root=roots[0];
  const rootCents=root&&amountToCents(root.payPrice),currentCents=amountToCents(order.payPrice);
  if(roots.length!==1||!root||root.uid!==0||root.paid!==1||order.paid!==1||!['cash','offline'].includes(order.payType)||root.payType!==order.payType||root.payTime<=0||root.payTime!==order.payTime
   ||refund.refundedTime<root.payTime||order.pid>0&&root.pid!==-1||rootCents===null||rootCents===undefined||currentCents===null||rootCents<0||currentCents<0||rootCents<currentCents
   ||(root.storeId!==order.storeId&&root.supplierAllocationStatus!==2)||(root.supplierId!==order.supplierId&&!(root.supplierId===0&&root.supplierAllocationStatus===2))
   ||order.couponId!==0||amountToCents(order.useIntegral)!==0||order.payIntegral!==0||amountToCents(order.deductionPrice)!==0||amountToCents(order.gainIntegral)!==0)throw Error('Guest refusal paid identity inconsistent');
  const event=await db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,`order.refund.refused.notice:${refund.id}`)).limit(2);
  if(event.length!==1||event[0].aggregateType!=='order'||event[0].aggregateId!==order.id||event[0].eventType!=='order.refund.refused.notice'||await outRequestHash(event[0].payload)!==await outRequestHash(payload))throw Error('Guest refusal immutable event inconsistent');
  const accounts=await db.select({uid:user.uid}).from(user).where(eq(user.uid,0)).limit(1),bills=await db.select({id:userBill.id}).from(userBill).where(eq(userBill.uid,0)).limit(1),brokerages=await db.select({id:userBrokerage.id}).from(userBrokerage).where(eq(userBrokerage.uid,0)).limit(1);
  if(accounts.length||bills.length||brokerages.length)throw Error('Guest refusal account identity contradictory');
 }
 // Later lawful applications/generations may hold the same cart or change the
 // remaining price. Their counters/current price are not this old refusal.
}
