/** Synthetic MAC codec contracts only. Nothing here proves physical funds,
 * an actual provider response, committed capture or notification permission. */
import { signRechargeRefundRecord } from '@/services/payment/RechargeRefundLedger';
import { captureRechargeRefundCaptureFacts, signRechargeRefundSuccessNoticeIntent,
  signRechargeRefundLocalCaptureResult } from '@/services/payment/RechargeRefundLocalCaptureCodec';
import type { RechargeRefundFirstProviderStatus } from '@/services/payment/RechargeRefundFirstProviderResult';
import { routineEvidenceHmac } from '@/services/payment/RoutineProviderObservation';
import { rechargeFirstResultPureFixture, firstResultScope as scope, firstResultSigning as env } from './rechargeFirstProviderResultPure';
import { operationSourceUuid } from './rechargeRefundOperationSourcePure';
export { firstResultScope as localCaptureScope, firstResultSigning as localCaptureSigning } from './rechargeFirstProviderResultPure';

export function rechargeLocalCapturePureFixture(reclaimGift = true, status: RechargeRefundFirstProviderStatus = 'SUCCESS', operationPatch: Record<string, unknown> = {}) {
  const source = rechargeFirstResultPureFixture(status), { signature: _op, ...oldOperation } = source.operation;
  const operation = signRechargeRefundRecord(env, scope, 'recharge_refund_operation', { ...oldOperation,
    reclaim_gift: reclaimGift, debit_cents: reclaimGift ? 1150 : 1000, wallet_after: reclaimGift ? 0 : 150, ...operationPatch });
  const { signature: _attempt, ...oldAttempt } = source.attempt;
  const attempt = signRechargeRefundRecord(env, scope, 'recharge_refund_attempt', { ...oldAttempt,
    payload: { ...(source.attempt.payload as Record<string, unknown>), operationSignature: operation.signature } });
  const { signature: _result, ...oldResult } = source.result();
  const providerResult = signRechargeRefundRecord(env, scope, 'recharge_refund_result', { ...oldResult,
    evidence: { ...source.evidence, operationSignature: operation.signature, attemptSignature: attempt.signature } });
  const history = { operation, attempt, providerResult, approval: source.approval };
  const facts = (patch: Record<string, unknown> = {}) => ({ format: 1, purpose: 'recharge-refund-capture-facts-v1', scope,
    localResultId: operationSourceUuid(9), operation: { id: operation.operation_id, signature: operation.signature, paymentSignature: operation.payment_signature },
    request: { attemptId: attempt.attempt_id, signature: attempt.signature, requestHash: attempt.request_hash },
    provider: { resultId: providerResult.result_id, signature: providerResult.signature, refundId: source.evidence.result.providerRefundId,
      successTime: source.evidence.result.successTime, observedAt: source.evidence.verification.observedAt },
    recharge: { id: operation.recharge_id, buyerUid: operation.buyer_uid, orderNo: operation.order_no,
      transactionId: operation.transaction_id, appId: 'wx_original_a', merchantId: '1234567890', principalCents: operation.principal_cents,
      giftCents: operation.gift_cents, reclaimGift: operation.reclaim_gift, debitCents: operation.debit_cents,
      refundBeforeCents: 0, refundAfterCents: operation.principal_cents, postReservationBalanceCents: operation.wallet_after },
    holdBillId: 72, wallet: { beforeCents: 1700, afterCents: 1700 },
    flow: { id: 91, eventKey: 'recharge.refund:' + String(operation.operation_id), flowId: String(operation.operation_id).replaceAll('-', ''),
      orderId: operation.order_no, storeId: 1, uid: operation.buyer_uid, priceCents: -Number(operation.principal_cents), tradingType: 4,
      payType: 'weixin', addTime: 1103, nickname: '退款快照', phone: '13800138000', mark: '充值原路退款' },
    projection: { beforeVersion: 1, afterVersion: 2 }, capturedAt: 1103, ...patch });
  const capture = (value: unknown = facts()) => captureRechargeRefundCaptureFacts(env, scope, history, value);
  const notice = (value: unknown = facts()) => signRechargeRefundSuccessNoticeIntent(env, scope, history, value);
  const row = (value: unknown = facts(), id = 92) => ({ id, eventKey: 'recharge.refund.success.notice:' + String(operation.operation_id),
    aggregateType: 'recharge', aggregateId: operation.recharge_id, eventType: 'recharge.refund.success.notice', payload: notice(value), addTime: 1103 });
  const local = (value: unknown = facts(), actualRow: unknown = row(value)) => signRechargeRefundLocalCaptureResult(env, scope, history, value, actualRow);
  function signedNotice(patch: Record<string, unknown>) {
    const { signature: _, ...body } = notice(), changed = { ...body, ...patch };
    return { ...changed, signature: routineEvidenceHmac(env, 'recharge-refund-success-notice-intent-v1', changed) };
  }
  function signedLocal(evidencePatch: Record<string, unknown> = {}, recordPatch: Record<string, unknown> = {}) {
    const { signature: _, ...base } = local();
    return signRechargeRefundRecord(env, scope, 'recharge_refund_result', { ...base,
      evidence: { ...(base.evidence as Record<string, unknown>), ...evidencePatch }, ...recordPatch });
  }
  return { history, facts, capture, notice, row, local, signedNotice, signedLocal };
}
