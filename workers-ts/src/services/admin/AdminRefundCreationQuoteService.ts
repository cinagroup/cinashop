import { eq } from 'drizzle-orm';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import { storeOrder } from '@/models/schema';
import { NotFoundException } from '@/utils/errors';
import { quoteOrderRefundApplication } from '@/services/order/StoreOrderRefundService';
import { authorizeAdminRefundActor, type AdminRefundDecisionActor } from './AdminRefundDecisionService';
import { adminRefundCreationReview, parseAdminRefundCreationQuote } from './AdminRefundCreationProtocol';
import { adminRefundQuoteFingerprint, limitAdminRefundQuoteTransaction, lockAdminRefundQuoteCarts, lockAdminRefundWindow } from './AdminRefundQuotePolicy';

/** No ledger, application, sequence, audit, cache or financial write. The
 * shared preparation acquires short-lived locks; it is not a reservation. */
export async function quoteAdminRefundCreation(container:Container,actorInput:AdminRefundDecisionActor,value:unknown) {
  if(!Object.hasOwn(container.db,'$client'))throw Error('Admin refund quote requires a root database client');
  const actor=Object.freeze({...actorInput}),input=parseAdminRefundCreationQuote(value);
  return withTx(container,async tx=>{
    await authorizeAdminRefundActor(tx,actor);
    await limitAdminRefundQuoteTransaction(tx);
    const [candidate]=await tx.select({uid:storeOrder.uid,orderId:storeOrder.orderId}).from(storeOrder).where(eq(storeOrder.id,input.orderId)).limit(1);
    if(!candidate)throw new NotFoundException('订单不存在');
    const quote=await quoteOrderRefundApplication(createContainerFromDb(tx),{
      uid:candidate.uid,orderId:candidate.orderId,applyType:4,privilegedActor:'admin',
      resolveRefundTimeDays:lockAdminRefundWindow,
      ...(input.mode==='items'?{cartSelections:input.items.map(row=>({...row}))}:{}),
      authorizeApplication:async(lockedTx,order)=>{
        await authorizeAdminRefundActor(lockedTx,actor);
        if(order.id!==input.orderId)throw new NotFoundException('订单身份已变化');
        await lockAdminRefundQuoteCarts(lockedTx,order.id,input.items);
      },
    },0);
    const o=quote.order;
    return {version:input.version,review:adminRefundCreationReview({id:o.id,orderId:o.orderId,uid:o.uid,storeId:o.storeId,
      supplierId:o.supplierId,payPrice:o.payPrice,totalNum:o.totalNum,status:o.status,refundPrice:o.refundPrice,payType:o.payType}),
      mode:input.mode,items:quote.items,quotedPrice:quote.quotedPrice,refundNum:quote.refundNum,
      refundTimeDays:quote.refundTimeDays,receivedAt:quote.receivedAt,quoteFingerprint:await adminRefundQuoteFingerprint(quote)};
  });
}
