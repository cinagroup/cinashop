/** Synthetic closed-MAC routing examples, never SQL/crypto/funds authority. */
import { parseRechargeRefundProviderHistory } from '@/services/payment/RechargeRefundQueryHistoryCodec';
import { parseRechargeRefundCallbackProviderUniverse, type RechargeRefundCallbackProviderUniverse } from '@/services/payment/RechargeRefundCallbackHistoryCodec';
import { rechargeRefundTransportApproval } from '@/services/payment/RechargeRefundFirstRequest';
import { signRechargeRoutineRefundAccountJournal } from '@/services/payment/RechargeRoutineRefundAccountCodec';
import { signRechargeRefundRecord, type RechargeRefundRecord } from '@/services/payment/RechargeRefundLedger';
import type { RechargeRefundStateRow } from '@/services/payment/RechargeRefundAccounting';
import type { RechargeRefundCallbackStatus } from '@/services/payment/RechargeRefundCallbackCodec';
import { rechargeRefundCallbackPureFixture, callbackScope as scope, callbackSigning as env } from './rechargeRefundCallbackPure';
import { operationSourceUuid } from './rechargeRefundOperationSourcePure';
export { callbackScope as mixedScope, callbackSigning as mixedSigning } from './rechargeRefundCallbackPure';
export interface PureProviderBatch { readonly operation: unknown; readonly attempts: unknown; readonly policies: unknown; readonly results: unknown; }
export const mixedUniverse = (h: PureProviderBatch) => parseRechargeRefundCallbackProviderUniverse(env, scope, h.operation, h.attempts, h.policies, h.results);
export function appendPureCallback(raw: PureProviderBatch, status: RechargeRefundCallbackStatus, resultPatch: Record<string, unknown> = {}) {
  const h = parseRechargeRefundProviderHistory(env, scope, raw.operation, raw.attempts, raw.policies, raw.results), last = h.approvals.at(-1)!;
  const approval = signRechargeRoutineRefundAccountJournal(env, scope, { record_id: operationSourceUuid(991), account_id: last.account_id, revision: last.revision + 1,
    payload: { format: 1, purpose: 'recharge_routine_refund_account', scope, previousRecordId: last.record_id,
      data: { ...last.payload.data, purposes: ['refund_notify'], credentialRef: 'synthetic_mixed_notify', credentialVersion: 3,
        credentialStamp: 'e'.repeat(64), validFrom: 2300, validUntil: 8000 } }, created_at: 2400 });
  const base = rechargeRefundCallbackPureFixture(status, h.totalAttempts), q = h.first.payload.request;
  const terminal = h.results.find(r => r.observation.status === status), positive = h.results.find(r => r.observation.providerRefundId);
  const evidence = { ...base.evidence, operationSignature: h.operation.signature, firstAttemptId: h.first.attempt.attempt_id,
    firstAttemptSignature: h.first.attempt.signature, firstRequestHash: h.first.attempt.request_hash, approval: rechargeRefundTransportApproval(approval),
    original: { outTradeNo: q.outTradeNo, transactionId: q.transactionId, outRefundNo: q.outRefundNo, refundAmount: q.refundAmount, totalAmount: q.totalAmount, currency: 'CNY' },
    result: { ...base.evidence.result, providerRefundId: positive?.observation.providerRefundId ?? 'synthetic_mixed_refund',
      successTime: status === 'SUCCESS' ? terminal?.observation.successTime ?? 1102 : 0, ...resultPatch } };
  const callback = signRechargeRefundRecord(env, scope, 'recharge_refund_result', { result_id: operationSourceUuid(992), operation_id: h.operation.operation_id,
    attempt_id: null, source: 'callback', source_id: evidence.event.eventId, status, evidence, created_at: evidence.verification.receivedAt, caused_by_result_id: null });
  return { operation: h.operation, attempts: h.attempts, policies: [...h.approvals, approval], results: [...h.results.map(r => r.record), callback], callback };
}
export function mixedHeldState(u: RechargeRefundCallbackProviderUniverse): RechargeRefundStateRow {
  const h = u.requestQueryHistory, tail = h.attempts.at(-1)!;
  return { operation_id: String(h.operation.operation_id), recharge_id: Number(h.operation.recharge_id), admission: 'reserved', status: h.totalAttempts === 1 ? 'SUBMITTING' : 'UNKNOWN',
    wallet_state: 'held', version: h.totalAttempts, attempt_count: h.totalAttempts, lease_id: String(tail.lease_id), lease_until: Number(tail.created_at) + 30,
    next_query_at: Number(tail.created_at) + 60, last_result_id: null, provider_refund_id: null, created_at: Number(h.operation.created_at), updated_at: Number(tail.created_at) };
}
export function mixedTerminalState(u: RechargeRefundCallbackProviderUniverse, local: RechargeRefundRecord): RechargeRefundStateRow {
  const cause = [...u.requestQueryHistory.results, ...u.callbacks].find(r => r.record.result_id === local.caused_by_result_id);
  if (!cause) throw Error('Synthetic original cause missing'); const capture = local.source === 'local_settlement';
  return { ...mixedHeldState(u), status: capture ? 'SUCCEEDED' : 'FAILED', wallet_state: capture ? 'captured' : 'released', version: u.requestQueryHistory.totalAttempts + 1,
    lease_id: null, lease_until: null, next_query_at: null, last_result_id: String(local.result_id), provider_refund_id: cause.observation.providerRefundId, updated_at: Number(local.created_at) };
}
