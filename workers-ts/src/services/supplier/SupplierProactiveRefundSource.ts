import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderRefundPayment, storeOrderInvoice, storeOrderStatus, storeOrderOutbox, userBill } from '@/models/schema';
import { storeOrderRefundSplit } from '@/models/schema/order_refund_split';
import { amountToCents } from '@/services/payment/RefundGateway';
import { readPurchaseOriginEvidence } from '@/services/order/PurchaseOriginEvidence';
import { readRefundQuantityReservation } from '@/services/order/RefundQuantityReservation';
import { refundOrderSplitFingerprint } from '@/services/order/RefundOrderSplitIdentity';
import { assertStoredManualInvoiceAllocation } from '@/services/order/InvoiceManualRedNoteEvidence';
import { isManualRefundOrder } from '@/services/order/CustomerManualRefund';
import { readSupplierManualRefundSource, readBoundManualRefundProof } from './SupplierManualRefundProof';
import { assertSupplierManualRefundLineOwnership } from './SupplierManualRefundLineOwnership';
import { supplierProactiveRefundJson, supplierProactiveRefundConflict } from './SupplierProactiveRefundInput';

type Order=typeof storeOrder.$inferSelect;type Cart=typeof storeOrderCartInfo.$inferSelect;type Refund=typeof storeOrderRefund.$inferSelect;
const fact=(condition:unknown):void=>{if(!condition)throw supplierProactiveRefundConflict('供应商主动退款的完整购买、付款或租户来源无法核对');};
function object(value:unknown):Record<string,unknown> {fact(value&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;}
function bounded(value:unknown,max=16777216) {fact(new TextEncoder().encode(supplierProactiveRefundJson(value)).length<=max);}

/** This is a genuine completed ancestor reader, never a fabricated Customer or
 * a cash capability for an online purchase. The ownership mapper separately
 * replays its exact financial/physical partitions to the original PHP source. */
async function readAncestor(tx:DbClient,refund:Refund,order:Order):Promise<{source:{carts:unknown}}> {
  if(isManualRefundOrder(order))return readBoundManualRefundProof(tx,refund,order);
  const [receipt]=await tx.select().from(storeOrderRefundSplit).where(and(eq(storeOrderRefundSplit.refundId,refund.id),
    sql`octet_length(${storeOrderRefundSplit.sourceSnapshot})<=16777216`)).limit(1);
  fact(receipt&&refund.refundType===6&&!refund.isCancel&&!refund.isDel&&refund.refundedPrice===refund.refundPrice
    &&readRefundQuantityReservation(refund)&&receipt.fingerprint===await refundOrderSplitFingerprint(refund));
  if(!receipt)throw supplierProactiveRefundConflict();
  const source=object(JSON.parse(receipt.sourceSnapshot)),original=object(source.source),payment=object(source.payment),frozenRefund=object(source.refund);
  const [root]=await tx.select().from(storeOrder).where(eq(storeOrder.id,receipt.paymentOrderId)).limit(1);
  fact(source.version==='refund-order-materialization-v1'&&original.id===order.id&&original.uid===order.uid
    &&original.supplierId===order.supplierId&&original.storeId===order.storeId&&receipt.sourceOrderId===order.id
    &&receipt.uid===order.uid&&receipt.supplierId===order.supplierId&&receipt.storeId===order.storeId
    &&root&&root.paid===1&&root.uid===order.uid&&root.payType===order.payType
    &&payment.id===root.id&&payment.orderId===root.orderId&&payment.tradeNo===root.tradeNo&&payment.payPrice===root.payPrice
    &&payment.payType===root.payType&&frozenRefund.refundType===6&&frozenRefund.refundedPrice===refund.refundPrice
    &&await refundOrderSplitFingerprint(frozenRefund as unknown as Refund)===receipt.fingerprint
    &&Array.isArray(source.carts)&&source.carts.length>0&&source.carts.length<=200);
  if(order.payType==='yue'&&amountToCents(refund.refundPrice)!>0) {
    const bills=await tx.select().from(userBill).where(and(eq(userBill.uid,refund.uid),eq(userBill.linkId,refund.orderId),eq(userBill.type,'pay_product_refund'))).limit(2);
    fact(bills.length===1&&bills[0].number===refund.refundPrice&&bills[0].category==='now_money'&&bills[0].pm===1&&bills[0].status===1);
  } else if(amountToCents(refund.refundPrice)!>0) {
    const payments=await tx.select().from(storeOrderRefundPayment).where(eq(storeOrderRefundPayment.refundId,refund.id)).limit(2);
    const p=payments[0];fact(payments.length===1&&p.storeOrderId===order.id&&p.providerStatus==='SUCCESS'
      &&p.provider===(order.payType==='weixin'?'wechat':'alipay')&&p.outRefundNo===`CNSR${refund.id}`
      &&p.requestAmount===amountToCents(refund.refundPrice)&&p.totalAmount===amountToCents(root!.payPrice));
    fact(Array.isArray(source.payments)&&source.payments.length===1);
    const originalPayment=object((source.payments as unknown[])[0]);
    fact(['id','refundId','storeOrderId','provider','outRefundNo','requestAmount','totalAmount','providerRefundId','providerStatus']
      .every(key=>originalPayment[key]===(p as unknown as Record<string,unknown>)[key]));
  }
  await assertStoredManualInvoiceAllocation(tx,receipt.invoiceAllocation,receipt.uid,receipt.paymentOrderId);
  return {source:{carts:source.carts}};
}

export async function readSupplierProactiveRefundSource(tx:DbClient,order:Order,supplied?:Cart[]) {
  if(Object.hasOwn(tx,'$client'))throw supplierProactiveRefundConflict('主动退款来源须在原业务事务核对');
  fact(order.paid===1&&!order.isDel&&!order.isSystemDel&&order.pid>=0&&order.supplierId>0&&order.payTime>0
    &&order.supplierAllocationStatus!==1&&['cash','offline','yue','weixin','alipay','integral'].includes(order.payType));
  const [root]=await tx.select().from(storeOrder).where(and(eq(storeOrder.id,order.pid||order.id),
    sql`octet_length(to_jsonb(${storeOrder})::text)<=262144`)).limit(1);
  const paid=amountToCents(order.payPrice),rootPaid=root?amountToCents(root.payPrice):null;
  const allocated=root?.pid===-1&&root.supplierId===0&&root.supplierAllocationStatus===2;
  fact(root&&root.paid===1&&!root.isDel&&!root.isSystemDel&&root.payTime===order.payTime&&root.uid===order.uid
    &&root.payType===order.payType&&(!order.pid||root.pid===-1)&&(root.supplierId===order.supplierId||allocated)
    &&(root.storeId===order.storeId||allocated)&&paid!==null&&rootPaid!==null&&paid>=0&&rootPaid>=paid
    &&(order.payType!=='integral'||paid===0));
  if(!root)throw supplierProactiveRefundConflict();
  const carts=supplied??await tx.select().from(storeOrderCartInfo).where(and(eq(storeOrderCartInfo.oid,order.id),
    sql`COALESCE(octet_length(${storeOrderCartInfo.cartInfo}),0)<=65536`)).orderBy(asc(storeOrderCartInfo.id)).limit(201);
  const [count]=await tx.execute<{n:number}>(sql`SELECT count(*)::integer AS n FROM public.store_order_cart_info WHERE oid=${order.id}`);
  fact(carts.length>0&&carts.length<=200&&count.n===carts.length&&carts.every(row=>row.oid===order.id&&row.uid===order.uid)
    &&carts.every(row=>new TextEncoder().encode(row.cartInfo??'').length<=65536)
    &&new Set(carts.map(row=>row.id)).size===carts.length&&new Set(carts.map(row=>row.cartId)).size===carts.length);
  fact(carts.reduce((n,row)=>n+new TextEncoder().encode(row.cartInfo??'').length,0)<=8388608);
  let payment:unknown;
  if(isManualRefundOrder(order)) {
    payment=(await readSupplierManualRefundSource(tx,order,undefined,carts)).payment;
  } else {
    fact(order.uid>0);
    const origin=await readPurchaseOriginEvidence(tx,{orderId:root.id,buyerId:root.uid});
    const events=await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,`order.paid:${root.id}`)).limit(2);
    const audits=await tx.select().from(storeOrderStatus).where(and(eq(storeOrderStatus.oid,root.id),eq(storeOrderStatus.changeType,'pay_success')))
      .orderBy(asc(storeOrderStatus.id)).limit(201);
    fact(events.length<=1&&audits.length>0&&audits.length<=200&&audits.every(row=>row.changeTime>=root.payTime));
    if(events.length) {
      const event=events[0],payload=object(event.payload);
      fact(event.aggregateType==='order'&&event.aggregateId===root.id&&event.eventType==='order.paid'&&event.status==='COMPLETED'
        &&payload.orderId===root.id&&payload.orderNo===root.orderId&&audits.length===1&&event.processedTime===audits[0].changeTime);
      if(allocated) {
        const match=/^订单支付成功，已生成 ([1-9][0-9]*) 个履约子单$/.exec(audits[0].changeMessage);
        fact(match&&Number(match[1])<=200);
        const children=await tx.select({order:storeOrder,audit:storeOrderStatus}).from(storeOrder).innerJoin(storeOrderStatus,eq(storeOrderStatus.oid,storeOrder.id))
          .where(and(eq(storeOrder.pid,root.id),eq(storeOrderStatus.changeType,'supplier_split_create_order'))).orderBy(asc(storeOrder.id)).limit(201);
        fact(children.length===Number(match![1])&&new Set(children.map(row=>row.order.id)).size===children.length
          &&children.some(row=>row.order.id===order.id)&&children.every(({order:child,audit})=>child.uid===root.uid&&child.payType===root.payType
            &&child.payTime===root.payTime&&child.paid===1&&child.supplierAllocationStatus===2&&audit.changeTime===event.processedTime
            &&audit.changeMessage===(child.supplierId>0?'支付后按供应商自动拆单':'支付后拆出平台履约订单')));
      } else fact(audits[0].changeMessage==='订单支付成功，后置任务处理完成');
    } else fact(!origin&&audits.every(row=>row.changeMessage==='用户付款成功'));
    const debits=order.payType==='yue'&&events.length&&rootPaid!>0?await tx.select().from(userBill).where(and(eq(userBill.uid,root.uid),
      eq(userBill.linkId,root.orderId),eq(userBill.type,'pay_product'))).limit(2):[];
    if(order.payType==='yue'&&events.length&&rootPaid!>0)fact(debits.length===1&&debits[0].pm===0&&debits[0].category==='now_money'
      &&debits[0].status===1&&debits[0].number===root.payPrice&&debits[0].addTime===root.payTime);
    if(origin)fact(carts.every(row=>row.type===2&&row.relationId===order.supplierId));
    await assertSupplierManualRefundLineOwnership(tx,order,carts,{root_id:root.id},readAncestor);
    payment={root_id:root.id,root,origin,events,audits,debits};
  }
  const refunds=await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId,order.id)).orderBy(asc(storeOrderRefund.id)).limit(201);
  fact(refunds.length<=200&&refunds.every(row=>row.uid===order.uid&&row.supplierId===order.supplierId&&row.storeId===order.storeId));
  const refund_payments=refunds.length?await tx.select().from(storeOrderRefundPayment).where(inArray(storeOrderRefundPayment.refundId,refunds.map(row=>row.id)))
    .orderBy(asc(storeOrderRefundPayment.id)).limit(201):[];
  fact(refund_payments.length<=200&&new Set(refund_payments.map(row=>row.refundId)).size===refund_payments.length);
  const invoices=await tx.select().from(storeOrderInvoice).where(inArray(storeOrderInvoice.orderId,[root.id,order.id])).orderBy(asc(storeOrderInvoice.id)).limit(201);
  const promotion_rows=await tx.execute(sql`SELECT id,oid,uid,promotions_id,product_id,promotions_price::text AS promotions_price,add_time
    FROM public.store_order_promotions WHERE oid=${order.id} ORDER BY id LIMIT 201`);
  fact(invoices.length<=200&&invoices.every(row=>row.uid===order.uid)&&promotion_rows.length<=200&&promotion_rows.every(row=>row.uid===order.uid));
  const source={version:'supplier-proactive-refund-source-v1' as const,order,carts,payment,refunds,refund_payments,invoices,promotion_rows:[...promotion_rows]};
  bounded(source);return source;
}
