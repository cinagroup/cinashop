/** Synthetic MAC-only evidence. Nothing here proves RSA/AES, SQL existence,
 * current credentials, a live callback, COMMIT or permission to settle funds. */
import { signRechargeRefundRecord, type RechargeRefundRecord } from '@/services/payment/RechargeRefundLedger';
import { parseRechargeRefundFirstRequest, rechargeRefundTransportApproval } from '@/services/payment/RechargeRefundFirstRequest';
import { signRechargeRoutineRefundAccountJournal } from '@/services/payment/RechargeRoutineRefundAccountCodec';
import type { RechargeRefundCallbackStatus } from '@/services/payment/RechargeRefundCallbackCodec';
import { historyScope as scope, historySigning as env, rechargeQueryHistoryPureFixture } from './rechargeRefundQueryHistoryPure';
import { operationSourceUuid } from './rechargeRefundOperationSourcePure';
export { historyScope as callbackScope, historySigning as callbackSigning } from './rechargeRefundQueryHistoryPure';

export function rechargeRefundCallbackPureFixture(status: RechargeRefundCallbackStatus = 'SUCCESS', count = 2) {
  const history = rechargeQueryHistoryPureFixture(count);
  const first = parseRechargeRefundFirstRequest(env, scope, history.operation, history.attempts[0]), p = first.payload;
  const last = history.policies.at(-1)!;
  const approval = signRechargeRoutineRefundAccountJournal(env, scope, {
    record_id: operationSourceUuid(501), account_id: last.account_id, revision: last.revision + 1,
    payload: { format: 1, purpose: 'recharge_routine_refund_account', scope, previousRecordId: last.record_id,
      data: { ...last.payload.data, purposes: ['refund_notify'], credentialRef: 'synthetic_callback_rotated',
        credentialVersion: 3, credentialStamp: 'e'.repeat(64), validFrom: 2300, validUntil: 8000 } }, created_at: 2400,
  });
  const evidence = { format: 1, purpose: 'recharge-refund-callback-provider-result-v1', scope,
    operationSignature: history.operation.signature, firstAttemptId: first.attempt.attempt_id,
    firstAttemptSignature: first.attempt.signature, firstRequestHash: first.attempt.request_hash,
    approval: rechargeRefundTransportApproval(approval), original: { outTradeNo: p.request.outTradeNo,
      transactionId: p.request.transactionId, outRefundNo: p.request.outRefundNo,
      refundAmount: p.request.refundAmount, totalAmount: p.request.totalAmount, currency: 'CNY' },
    event: { eventId: 'EV-SYNTHETIC-CALLBACK-1', eventType: 'REFUND.' + status, createdAt: 2500 },
    result: { status, providerRefundId: 'synthetic_callback_refund', successTime: status === 'SUCCESS' ? 1102 : 0,
      amount: { total: p.request.totalAmount, refund: p.request.refundAmount,
        payerTotal: p.request.totalAmount, payerRefund: p.request.totalAmount } },
    verification: { requestDigest: 'f'.repeat(64), plaintextDigest: 'd'.repeat(64), verifierKey: 'SYNTHETIC_CALLBACK_KEY',
      signedAt: 2501, receivedAt: 2501 },
  };
  const result = (patch: Record<string, unknown> = {}, rowPatch: Record<string, unknown> = {}): RechargeRefundRecord =>
    signRechargeRefundRecord(env, scope, 'recharge_refund_result', {
      result_id: operationSourceUuid(502), operation_id: history.operation.operation_id,
      attempt_id: null, source: 'callback', source_id: evidence.event.eventId, status,
      evidence: { ...evidence, ...patch }, created_at: evidence.verification.receivedAt, caused_by_result_id: null, ...rowPatch,
    });
  const wireEnvelope = { id: evidence.event.eventId, create_time: new Date(2500 * 1000).toISOString().replace('.000Z', 'Z'),
    event_type: evidence.event.eventType, resource_type: 'encrypt-resource', summary: '退款通知',
    resource: { algorithm: 'AEAD_AES_256_GCM', original_type: 'refund', ciphertext: Buffer.alloc(32, 1).toString('base64'),
      nonce: 'synthetic_iv', associated_data: '' } };
  const wirePlaintext = { mchid: p.approval.merchantId, out_trade_no: p.request.outTradeNo,
    transaction_id: p.request.transactionId, out_refund_no: p.request.outRefundNo,
    refund_id: evidence.result.providerRefundId, refund_status: status,
    ...(status === 'SUCCESS' ? { success_time: new Date(1102 * 1000).toISOString().replace('.000Z', 'Z') } : {}),
    user_received_account: 'synthetic destination', amount: { total: p.request.totalAmount, refund: p.request.refundAmount,
      payer_total: p.request.totalAmount, payer_refund: p.request.totalAmount } };
  return { history, first, approval, evidence, result, wireEnvelope, wirePlaintext,
    policies: [...history.policies, approval] };
}
export type RechargeRefundCallbackPureFixture = ReturnType<typeof rechargeRefundCallbackPureFixture>;
