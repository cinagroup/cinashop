/** Historical callback attestation, deliberately distinct from POST/GET.
 * This pure decoder proves neither RSA/AES, physical rows, current approval,
 * a callback acknowledgement nor permission to change money. */
import type { Env } from '@/env';
import { ServiceUnavailableException } from '@/utils/errors';
import { authenticateRechargeRefundRecord } from './RechargeRefundLedger';
import { captureRechargeRefundJson, captureRechargeRefundScope, type RechargeRefundScope } from './RechargeRefundJournalCodec';
import { parseRechargeRefundFirstRequest, rechargeRefundTransportApproval } from './RechargeRefundFirstRequest';
import { parseRechargeRoutineRefundAccountJournal, requireRechargeRoutineRefundPurpose } from './RechargeRoutineRefundAccountCodec';
import { routineEvidenceCanonical } from './RoutineProviderObservation';

type Signing = Pick<Env, 'APP_KEY'>;
export type RechargeRefundCallbackStatus = 'SUCCESS' | 'CLOSED' | 'ABNORMAL';
export type RechargeRefundCallbackEventType = `REFUND.${RechargeRefundCallbackStatus}`;
export interface RechargeRefundCallbackAmount {
  readonly total: number; readonly refund: number; readonly payerTotal: number; readonly payerRefund: number;
}
export interface RechargeRefundCallbackObservation {
  readonly status: RechargeRefundCallbackStatus; readonly providerRefundId: string; readonly successTime: number;
  readonly eventId: string; readonly eventType: RechargeRefundCallbackEventType; readonly eventCreatedAt: number;
  readonly amount: Readonly<RechargeRefundCallbackAmount>;
  readonly requestDigest: string; readonly plaintextDigest: string; readonly verifierKey: string;
  readonly signedAt: number; readonly receivedAt: number;
}
const fail = (): never => { throw new ServiceUnavailableException('充值退款回调历史证据暂不可核对，请保留原操作'); };
const time = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= 2_147_483_647;
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const token = (v: unknown, max: number): v is string => typeof v === 'string'
  && new RegExp('^[A-Za-z0-9._:-]{1,' + max + '}$', 'u').test(v);
const same = (a: unknown, b: unknown) => routineEvidenceCanonical(a) === routineEvidenceCanonical(b);
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  const r = captureRechargeRefundJson(input);
  if (!r || typeof r !== 'object' || Array.isArray(r) || Reflect.ownKeys(r).length !== keys.length
    || keys.some(k => !Object.hasOwn(r, k))) return fail();
  return r as Record<string, unknown>;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const d of Object.values(Object.getOwnPropertyDescriptors(value))) if ('value' in d) freeze(d.value);
    Object.freeze(value);
  }
  return value;
}

/** Full principal refunds can contain provider-funded discounts. The provider
 * order/refund totals must equal the original principal. Cash returned equals
 * cash originally paid, which may be smaller; it never sets the wallet debit.
 * The direct-merchant callback has no required appid or currency field. */
export function captureRechargeRefundCallbackAmount(input: unknown, principal: number): Readonly<RechargeRefundCallbackAmount> {
  const r = object(input, ['total', 'refund', 'payerTotal', 'payerRefund']);
  if (!Number.isSafeInteger(principal) || principal < 1 || principal > 999_999_999_999
    || r.total !== principal || r.refund !== principal
    || !Number.isSafeInteger(r.payerTotal) || Number(r.payerTotal) < 0 || Number(r.payerTotal) > principal
    || r.payerRefund !== r.payerTotal) return fail();
  return r as unknown as Readonly<RechargeRefundCallbackAmount>;
}

/** Approvals are checked at their own historical issuance/receipt time. A
 * later revocation or credential rotation cannot erase a retained observation.
 * A future live verifier must independently commission the current notify
 * policy and credentials before RSA/AES, then COMMIT the actual result. */
export function parseRechargeRefundCallbackResult(env: Signing, expectedScope: RechargeRefundScope,
  rawOperation: unknown, rawFirstAttempt: unknown, rawFirstApproval: unknown, rawNotifyApproval: unknown, rawResult: unknown) {
  const scope = captureRechargeRefundScope(expectedScope);
  const operation = authenticateRechargeRefundRecord(env, scope, 'recharge_refund_operation', rawOperation);
  const first = parseRechargeRefundFirstRequest(env, scope, operation, rawFirstAttempt), p = first.payload;
  const firstApproval = parseRechargeRoutineRefundAccountJournal(env, scope, rawFirstApproval);
  requireRechargeRoutineRefundPurpose(firstApproval, 'refund_request', p.issuedAt);
  if (firstApproval.created_at > p.issuedAt || !same(rechargeRefundTransportApproval(firstApproval), p.approval)) return fail();
  const approval = parseRechargeRoutineRefundAccountJournal(env, scope, rawNotifyApproval);
  const record = authenticateRechargeRefundRecord(env, scope, 'recharge_refund_result', rawResult);
  const e = object(record.evidence, ['format', 'purpose', 'scope', 'operationSignature', 'firstAttemptId',
    'firstAttemptSignature', 'firstRequestHash', 'approval', 'original', 'event', 'result', 'verification']);
  const approved = object(e.approval, ['recordId', 'signature', 'accountId', 'appId', 'merchantId',
    'credentialRef', 'credentialVersion', 'credentialStamp']);
  const original = object(e.original, ['outTradeNo', 'transactionId', 'outRefundNo', 'refundAmount', 'totalAmount', 'currency']);
  const event = object(e.event, ['eventId', 'eventType', 'createdAt']);
  const result = object(e.result, ['status', 'providerRefundId', 'successTime', 'amount']);
  const verified = object(e.verification, ['requestDigest', 'plaintextDigest', 'verifierKey', 'signedAt', 'receivedAt']);
  if (!time(verified.receivedAt)) return fail();
  requireRechargeRoutineRefundPurpose(approval, 'refund_notify', verified.receivedAt);
  const selected = rechargeRefundTransportApproval(approval);
  if (record.operation_id !== operation.operation_id || record.source !== 'callback' || record.attempt_id !== null
    || record.caused_by_result_id !== null || record.source_id !== event.eventId || !token(event.eventId, 36)
    || !time(record.created_at) || record.created_at !== verified.receivedAt
    || e.format !== 1 || e.purpose !== 'recharge-refund-callback-provider-result-v1'
    || !same(captureRechargeRefundScope(e.scope), scope) || e.operationSignature !== operation.signature
    || e.firstAttemptId !== first.attempt.attempt_id || e.firstAttemptSignature !== first.attempt.signature
    || e.firstRequestHash !== first.attempt.request_hash || !same(approved, selected)
    || approval.created_at > verified.receivedAt || selected.accountId !== p.approval.accountId
    || selected.appId !== p.approval.appId || selected.merchantId !== p.approval.merchantId
    || original.outTradeNo !== p.request.outTradeNo || original.transactionId !== p.request.transactionId
    || original.outRefundNo !== p.request.outRefundNo || original.refundAmount !== p.request.refundAmount
    || original.totalAmount !== p.request.totalAmount || original.currency !== 'CNY'
    || record.status !== result.status || !['SUCCESS', 'CLOSED', 'ABNORMAL'].includes(String(result.status))
    || event.eventType !== 'REFUND.' + String(result.status) || !token(result.providerRefundId, 32)
    || !time(event.createdAt) || event.createdAt < p.issuedAt - 300 || event.createdAt > verified.receivedAt + 300
    || verified.receivedAt < p.issuedAt - 1 || !time(verified.signedAt)
    || Math.abs(verified.signedAt - verified.receivedAt) > 300
    || !hex(verified.requestDigest) || !hex(verified.plaintextDigest) || !token(verified.verifierKey, 128)) return fail();
  if (result.status === 'SUCCESS') {
    if (!time(result.successTime) || result.successTime < p.issuedAt - 300
      || result.successTime > event.createdAt + 300 || result.successTime > verified.receivedAt + 300) return fail();
  } else if (result.successTime !== 0) return fail();
  const amount = captureRechargeRefundCallbackAmount(result.amount, p.request.totalAmount);
  const observation: RechargeRefundCallbackObservation = {
    status: result.status as RechargeRefundCallbackStatus, providerRefundId: result.providerRefundId,
    successTime: result.successTime as number, eventId: event.eventId,
    eventType: event.eventType as RechargeRefundCallbackEventType, eventCreatedAt: event.createdAt,
    amount, requestDigest: verified.requestDigest, plaintextDigest: verified.plaintextDigest,
    verifierKey: verified.verifierKey, signedAt: verified.signedAt, receivedAt: verified.receivedAt,
  };
  return freeze({ scope, operation, first, firstApproval, approval, record, observation });
}
export type RechargeRefundCallbackResult = ReturnType<typeof parseRechargeRefundCallbackResult>;
