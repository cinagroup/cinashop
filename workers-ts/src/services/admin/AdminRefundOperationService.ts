import { eq } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import { storeOrderRefundPayment } from '@/models/schema';
import { HttpApiException, ValidateException } from '@/utils/errors';
import { normalizeOutRequestKey, outRequestHash } from '@/services/out/OutIdempotency';
import { centsToDecimal } from '@/services/order/OrderBrokerageService';
import { approveStoreOrderReturn, StoreOrderRefundService, type RefundExecutionResult } from '@/services/order/StoreOrderRefundService';
import { adminRefundDecisionScope, authorizeAdminRefundActor, type AdminRefundDecisionActor } from './AdminRefundDecisionService';
import { appendAdminRefundOperation, checkAdminRefundOperation, findAdminRefundOperation,
  type AdminRefundOperationAction, type AdminRefundOperationIdentity, type AdminRefundOperationReceipt } from './AdminRefundOperationLedger';

export interface AdminRefundOperationResult {
  receipt: AdminRefundOperationReceipt;
  replayed: boolean;
  execution?: RefundExecutionResult;
}
class OperationReplay extends Error {
  constructor(readonly receipt: AdminRefundOperationReceipt, readonly execution?: RefundExecutionResult) { super('Refund operation replay'); }
}
const replay = (receipt: AdminRefundOperationReceipt, execution?: RefundExecutionResult): AdminRefundOperationResult => ({
  receipt, replayed: true, execution: execution ?? (receipt.outcome === 'balance-settled' ? {completed:true,status:'BALANCE_SUCCESS'} : undefined),
});

/** Normalize and copy everything before hashing/awaiting. The actor is trusted
 * request context, never a body field. Hash no session token/password version. */
async function prepare(actorInput: AdminRefundDecisionActor, refundId: number, requestKey: unknown,
  action: AdminRefundOperationAction, value: unknown) {
  if (!Number.isSafeInteger(refundId) || refundId <= 0 || refundId > 2_147_483_647
    || !['return','refuse','refund'].includes(action)) throw new ValidateException('退款操作无效');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('退款操作内容无效');
  const body = value as Record<string, unknown>;
  const actor = Object.freeze({...actorInput});
  const scope = adminRefundDecisionScope(body.review, body.decision, action, actor);
  const decision = body.decision as {applyType:number;refundType:number;received:boolean};
  const reason = action === 'refuse' && typeof body.reason === 'string' ? body.reason.trim() : '';
  if (action === 'refuse' && (!reason || reason.length > 255)) throw new ValidateException('请输入有效的拒绝原因');
  const key = normalizeOutRequestKey(requestKey);
  const input = { version:'admin-refund-operation-v1', refundId, action, reason,
    review:{uid:scope.expectedUid,storeId:scope.expectedStoreId,supplierId:scope.expectedSupplierId,
      storeOrderId:scope.expectedStoreOrderId,orderId:scope.expectedRefundOrderId,
      refundPrice:centsToDecimal(scope.expectedRefundAmountCents!)},
    decision:{applyType:decision.applyType,refundType:decision.refundType,received:decision.received} };
  const requestHash = await outRequestHash(input);
  const operation: AdminRefundOperationIdentity = Object.freeze({adminId:actor.id,refundId,action,requestKey:key,requestHash});
  return { actor, scope, operation, reason };
}

/** SQL-only owner lookup. Current authorization is checked again in the same
 * bounded transaction; this is evidence lookup, never provider dispatch. */
export async function lookupAdminRefundOperation(container: Container, actorInput: AdminRefundDecisionActor, requestKey: unknown) {
  const actor = Object.freeze({...actorInput}), key = normalizeOutRequestKey(requestKey);
  return withTx(container, async tx => {
    await authorizeAdminRefundActor(tx,actor);
    return findAdminRefundOperation(createContainerFromDb(tx),actor.id,key);
  });
}

/** Permanently fence only an as-yet-uncommitted original key. A prior accepted
 * operation wins unchanged; provider admission cannot be undone or labelled
 * not-executed. Late senders check this same fence before business writes. */
export async function abandonAdminRefundOperation(container: Container, actor: AdminRefundDecisionActor, refundId: number,
  requestKey: unknown, action: AdminRefundOperationAction, body: unknown): Promise<AdminRefundOperationReceipt> {
  const prepared = await prepare(actor,refundId,requestKey,action,body);
  return withTx(container,async tx => {
    await authorizeAdminRefundActor(tx,prepared.actor);
    const prior=await checkAdminRefundOperation(tx,prepared.operation);
    return prior ?? appendAdminRefundOperation(tx,prepared.operation,'abandoned');
  });
}

/** The core owns each short SQL phase. Never wrap the gateway call in an outer
 * transaction. Admission receipts are committed BEFORE external I/O, while
 * local settlement/refusal/return evidence shares its business commit. Only an
 * explicit same-key POST may resume the existing provider state machine. */
export async function executeAdminRefundOperation(container: Container, env: Env, actor: AdminRefundDecisionActor, refundId: number,
  requestKey: unknown, action: AdminRefundOperationAction, body: unknown): Promise<AdminRefundOperationResult> {
  // Nested withTx creates savepoints, not durable commits. An outer caller
  // transaction would keep provider admission uncommitted during gateway I/O.
  if (!Object.hasOwn(container.db, '$client')) throw new Error('Refund operation execution requires a root database client');
  const prepared=await prepare(actor,refundId,requestKey,action,body);
  const {operation,scope}=prepared;
  const prior=await withTx(container,async tx => {
    await authorizeAdminRefundActor(tx,prepared.actor);
    return checkAdminRefundOperation(tx,operation);
  });
  if(prior && prior.outcome!=='provider-admitted')return replay(prior);
  let admitted:AdminRefundOperationReceipt|null=null;
  scope.authorizeBeforeRefundLock=async tx=>{
    await authorizeAdminRefundActor(tx,prepared.actor);
    admitted=await checkAdminRefundOperation(tx,operation);
    if(admitted && admitted.outcome!=='provider-admitted')throw new OperationReplay(admitted);
  };
  const validate=scope.authorizeLockedDecision!;
  scope.authorizeLockedDecision=async(tx,refund,order)=>{
    await authorizeAdminRefundActor(tx,prepared.actor);
    if(admitted?.outcome==='provider-admitted' && refund.refundType===6){
      const payments=await tx.select().from(storeOrderRefundPayment).where(eq(storeOrderRefundPayment.refundId,refund.id)).limit(2);
      const payment=payments[0];
      if(payments.length!==1 || payment.providerStatus!=='SUCCESS' || payment.storeOrderId!==order.id
        || payment.requestAmount!==scope.expectedRefundAmountCents
        || payment.provider!==(order.payType==='weixin'?'wechat':order.payType==='alipay'?'alipay':'')) {
        throw new HttpApiException('已受理退款的结算凭据不一致，请人工核对',503,503);
      }
      throw new OperationReplay(admitted,{completed:true,status:'SUCCESS'});
    }
    await validate(tx,refund,order);
  };
  scope.recordLockedDecision=async(tx,outcome)=>{await appendAdminRefundOperation(tx,operation,outcome);};
  let execution:RefundExecutionResult|undefined;
  try {
    if(action==='return')await approveStoreOrderReturn(container,refundId,scope);
    else if(action==='refuse')await new StoreOrderRefundService(container,env).refuseRefund(refundId,prepared.reason,scope);
    else execution=await new StoreOrderRefundService(container,env).agreeRefund(refundId,scope);
  }catch(error){
    if(error instanceof OperationReplay)return replay(error.receipt,error.execution);
    throw error;
  }
  const receipt=await findAdminRefundOperation(container,operation.adminId,operation.requestKey);
  if(!receipt || receipt.requestHash!==operation.requestHash || receipt.refundId!==refundId || receipt.action!==action) {
    throw new HttpApiException('退款操作回执暂不可核对，请查询原操作，不要新建请求',503,503);
  }
  return {receipt,replayed:false,execution};
}
