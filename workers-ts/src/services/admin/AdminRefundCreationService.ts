import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { ValidateException } from '@/utils/errors';
import { normalizeOutRequestKey, outRequestHash } from '@/services/out/OutIdempotency';
import { amountToCents } from '@/services/payment/RefundGateway';
import { applyOrderRefund } from '@/services/order/StoreOrderRefundService';
import { authorizeAdminRefundActor, type AdminRefundDecisionActor } from './AdminRefundDecisionService';
import { parseAdminRefundCreation, adminRefundCreationNumber } from './AdminRefundCreationProtocol';
import { appendRefundCreation, checkRefundCreation, readRefundCreation } from './AdminRefundCreationLedger';
import { executeAdminRefundOperation } from './AdminRefundOperationService';
import { adminRefundQuoteFingerprint, lockAdminRefundQuoteCarts, lockAdminRefundWindow } from './AdminRefundQuotePolicy';

async function prepare(actorInput:AdminRefundDecisionActor,keyInput:unknown,value:unknown) {
  const actor=Object.freeze({...actorInput}),body=parseAdminRefundCreation(value),key=normalizeOutRequestKey(keyInput);
  const requestHash=await outRequestHash(body);
  return {actor,body,operation:Object.freeze({adminId:actor.id,requestKey:key,requestHash,orderId:body.review.id})};
}
function root(container:Container) {
  if(!Object.hasOwn(container.db,'$client'))throw Error('Admin proactive refund requires a root database client');
}

/** SQL-only creation. The application and its creation receipt share ONE outer
 * commit. No funds/provider work may be run in this transaction. */
export async function createAdminRefundApplication(container:Container,actorInput:AdminRefundDecisionActor,key:unknown,value:unknown) {
  root(container);const {actor,body,operation}=await prepare(actorInput,key,value);
  return withTx(container,async tx=>{
    await authorizeAdminRefundActor(tx,actor);
    const prior=await checkRefundCreation(tx,operation);
    if(prior)return {receipt:prior,replayed:true};
    const result=await applyOrderRefund(createContainerFromDb(tx),{
      uid:body.review.uid,orderId:body.review.orderId,applyType:4,privilegedActor:'admin',
      resolveRefundTimeDays:lockAdminRefundWindow,
      refundReason:body.reason,refundExplain:body.reason,
      applicationOrderId:adminRefundCreationNumber(actor.id,operation.requestKey),requireNewApplication:true,
      expectedRefundAmountCents:amountToCents(body.quotedPrice)!,requestedRefundAmountCents:amountToCents(body.refundPrice)!,
      ...(body.mode==='items'?{cartSelections:body.items.map(row=>({...row}))}:{}),
      authorizeApplication:async(lockedTx,order)=>{
        // Recheck expiry after order lock waits, even though actor/role rows
        // stay locked from the outer admission until this transaction commits.
        await authorizeAdminRefundActor(lockedTx,actor);
        const r=body.review;
        if(order.id!==r.id || order.orderId!==r.orderId || order.uid!==r.uid || order.storeId!==r.storeId || order.supplierId!==r.supplierId
          || order.payPrice!==r.payPrice || order.totalNum!==r.totalNum || order.status!==r.status || order.refundPrice!==r.refundPrice || order.payType!==r.payType)
          throw new ValidateException('订单身份、金额或状态已变化，请重新核对主动退款');
        await lockAdminRefundQuoteCarts(lockedTx,order.id,body.items);
      },
      authorizePreparedApplication:async(_tx,quote)=>{
        if(await adminRefundQuoteFingerprint(quote)!==body.quoteFingerprint)throw new ValidateException('主动退款报价依据已变化，请重新读取并确认');
      },
      audit:{changeType:'admin_refund_create',changeMessage:`管理员 ${actor.id} 确认主动退款申请`},
    });
    return {receipt:await appendRefundCreation(tx,operation,result.refundId),replayed:false};
  });
}

/** Owner-only SQL evidence, independent of mutable/deleted order/refund rows. */
export async function lookupAdminRefundCreation(container:Container,actorInput:AdminRefundDecisionActor,keyInput:unknown) {
  root(container);const actor=Object.freeze({...actorInput}),key=normalizeOutRequestKey(keyInput);
  return withTx(container,async tx=>{await authorizeAdminRefundActor(tx,actor);return readRefundCreation(tx,actor.id,key);});
}

/** Only fences an uncreated key. A committed application wins unchanged;
 * creation abandonment is NOT refund cancellation or payment cancellation. */
export async function abandonAdminRefundCreation(container:Container,actorInput:AdminRefundDecisionActor,key:unknown,value:unknown) {
  root(container);const {actor,operation}=await prepare(actorInput,key,value);
  return withTx(container,async tx=>{await authorizeAdminRefundActor(tx,actor);
    return await checkRefundCreation(tx,operation) ?? await appendRefundCreation(tx,operation,null);});
}

/** The complete proactive financial call composes two existing short phases:
 * durable creation commit -> durable payment admission/local settlement. Same
 * original key/body is reused on explicit recovery; never wrap this in withTx.
 * Creation accepted but execution rejected/unknown is a resumable state, not a
 * rollback of the creation or evidence that no refund can occur. */
export async function executeAdminProactiveRefund(container:Container,env:Env,actorInput:AdminRefundDecisionActor,keyInput:unknown,value:unknown) {
  root(container);
  // Capture again here before any await: later execution must use the original
  // actor/body even if the caller mutates its objects while creation is pending.
  const actor=Object.freeze({...actorInput}),body=parseAdminRefundCreation(value),key=normalizeOutRequestKey(keyInput);
  const creation=await createAdminRefundApplication(container,actor,key,body);
  if(creation.receipt.outcome==='abandoned')return {creation,operation:null};
  const operation=await executeAdminRefundOperation(container,env,actor,creation.receipt.refundId,key,'refund',{
    review:{uid:body.review.uid,storeId:body.review.storeId,supplierId:body.review.supplierId,storeOrderId:body.review.id,
      orderId:adminRefundCreationNumber(actor.id,key),refundPrice:body.refundPrice},
    decision:{applyType:4,refundType:0,received:false},
  });
  return {creation,operation};
}
