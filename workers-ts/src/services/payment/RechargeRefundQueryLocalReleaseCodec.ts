/** Query-specific closed receipt. Original POST and query/approval are distinct bound causes.
 * Pure MAC closure alone never establishes physical rows or money authority. */
/** Pure authenticated history only. No physical-row, provider, wallet-write
 * or projection authority. An owning SQL author must independently establish
 * the actual source/hold/cause, locks, positive bill and atomic projection. */
import type { Env } from '@/env';
import { ServiceUnavailableException } from '@/utils/errors';
import { parseRechargeRefundQueryEconomicBasis } from './RechargeRefundQueryEconomicHistory';
import { authenticateRechargeRefundRecord, signRechargeRefundRecord } from './RechargeRefundLedger';
import { captureRechargeRefundJson, captureRechargeRefundScope, type RechargeRefundScope } from './RechargeRefundJournalCodec';
import type { RechargeRefundQueryCaptureHistoryInput } from './RechargeRefundQueryLocalCaptureCodec';
import { routineEvidenceCanonical } from './RoutineProviderObservation';

type Signing = Pick<Env, 'APP_KEY'>;
export interface RechargeRefundQueryReleaseFacts {
  readonly format: 1;
  readonly purpose: 'recharge-refund-query-closed-release-facts-v1';
  readonly scope: Readonly<RechargeRefundScope>;
  readonly localResultId: string;
  readonly operation: { readonly id: string; readonly signature: string; readonly paymentSignature: string };
  readonly request: { readonly attemptId: string; readonly signature: string; readonly requestHash: string };
  readonly query: {readonly attemptId:string;readonly signature:string;readonly requestHash:string;readonly ordinal:number;
    readonly approvalId:string;readonly approvalSignature:string};
  readonly provider: { readonly resultId: string; readonly signature: string; readonly refundId: string; readonly observedAt: number };
  readonly recharge: { readonly id: number; readonly buyerUid: number; readonly orderNo: string; readonly transactionId: string;
    readonly appId: string; readonly merchantId: string; readonly principalCents: number; readonly giftCents: number;
    readonly reclaimGift: boolean; readonly debitCents: number; readonly refundBeforeCents: 0; readonly refundAfterCents: 0 };
  readonly holdBillId: number;
  readonly wallet: { readonly beforeCents: number; readonly afterCents: number };
  readonly bill: { readonly id: number; readonly uid: number; readonly linkId: string; readonly eventKey: string;
    readonly pm: 1; readonly category: 'now_money'; readonly type: 'recharge_refund_release';
    readonly title: '渠道关闭充值退款退回预留'; readonly numberCents: number; readonly balanceCents: number;
    readonly status: 1; readonly take: 0; readonly frozenTime: 0; readonly addTime: number;
    readonly mark: '渠道已确认关闭，退回原充值退款预留' };
  readonly projection: { readonly beforeVersion: number; readonly afterVersion: number; readonly totalAttempts:number };
  readonly releasedAt: number;
}
const MAX_CENTS = 999_999_999_999, MAX_INT = 2_147_483_647;
const fail = (): never => { throw new ServiceUnavailableException('充值退款渠道关闭解冻回执暂不可核对'); };
const uuid = (v: unknown): v is string => typeof v === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= MAX_INT;
const money = (v: unknown, signed = false): v is number => typeof v === 'number' && Number.isSafeInteger(v)
  && !Object.is(v, -0) && v >= (signed ? -MAX_CENTS : 0) && v <= MAX_CENTS;
const same = (a: unknown, b: unknown) => routineEvidenceCanonical(a) === routineEvidenceCanonical(b);
function object(input: unknown, keys: readonly string[], copy = true): Record<string, unknown> {
  const value = copy ? captureRechargeRefundJson(input) : input;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length
    || keys.some(key => !descriptors[key]?.enumerable || !('value' in descriptors[key]))) return fail();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}

/** Only the complete authenticated query CLOSED universe describes this
 * return. First POST and query/approval remain distinct links. The
 * wallet uses current locked before+original held debit, never op.wallet_after
 * or a clamp; neither a cash flow nor a success notice belongs in this form. */
export function captureRechargeRefundQueryReleaseFacts(env: Signing, expectedScope: RechargeRefundScope,
  inputHistory: RechargeRefundQueryCaptureHistoryInput, input: unknown) {
  const scope = captureRechargeRefundScope(expectedScope);
  // Independently bounded journals/batches retain their own limits.
  const h=parseRechargeRefundQueryEconomicBasis(env,scope,inputHistory),op=h.operation;
  const r = object(input, ['format', 'purpose', 'scope', 'localResultId', 'operation', 'request', 'provider', 'query', 'recharge',
    'holdBillId', 'wallet', 'bill', 'projection', 'releasedAt']);
  const operation = object(r.operation, ['id', 'signature', 'paymentSignature']);
  const request = object(r.request, ['attemptId', 'signature', 'requestHash']);
  const provider = object(r.provider, ['resultId', 'signature', 'refundId', 'observedAt']);
  const recharge = object(r.recharge, ['id', 'buyerUid', 'orderNo', 'transactionId', 'appId', 'merchantId', 'principalCents',
    'giftCents', 'reclaimGift', 'debitCents', 'refundBeforeCents', 'refundAfterCents']);
  const wallet = object(r.wallet, ['beforeCents', 'afterCents']);
  const bill = object(r.bill, ['id', 'uid', 'linkId', 'eventKey', 'pm', 'category', 'type', 'title', 'numberCents',
    'balanceCents', 'status', 'take', 'frozenTime', 'addTime', 'mark']);
  const projection = object(r.projection, ['beforeVersion', 'afterVersion', 'totalAttempts']);
  const query=object(r.query,['attemptId','signature','requestHash','ordinal','approvalId','approvalSignature']);
  if (h.observation.status !== 'CLOSED' || r.format !== 1 || r.purpose !== 'recharge-refund-query-closed-release-facts-v1'
    || !same(captureRechargeRefundScope(r.scope), scope) || !uuid(r.localResultId) || r.localResultId === h.record.result_id
    || operation.id !== op.operation_id || operation.signature !== op.signature || operation.paymentSignature !== op.payment_signature
    || request.attemptId !== h.attempt.attempt_id || request.signature !== h.attempt.signature || request.requestHash !== h.attempt.request_hash
    || query.attemptId!==h.query.attempt.attempt_id||query.signature!==h.query.attempt.signature||query.requestHash!==h.query.attempt.request_hash
    || query.ordinal!==h.query.payload.ordinal||query.approvalId!==h.query.approval.record_id||query.approvalSignature!==h.query.approval.signature
    || projection.totalAttempts!==h.history.totalAttempts||projection.beforeVersion!==h.history.totalAttempts
    || !integer(r.releasedAt) || r.releasedAt<Number(h.history.attempts.at(-1)!.created_at)
    || provider.resultId !== h.record.result_id || provider.signature !== h.record.signature
    || provider.refundId !== h.observation.providerRefundId || provider.observedAt !== h.observation.observedAt
    || !money(op.principal_cents) || op.principal_cents <= 0 || !money(op.gift_cents) || typeof op.reclaim_gift !== 'boolean'
    || !money(op.debit_cents) || op.debit_cents !== op.principal_cents + (op.reclaim_gift ? op.gift_cents : 0)
    || !money(op.wallet_before) || !money(op.wallet_after) || op.wallet_before < op.debit_cents
    || op.wallet_before - op.debit_cents !== op.wallet_after
    || recharge.id !== op.recharge_id || recharge.buyerUid !== op.buyer_uid || recharge.orderNo !== op.order_no
    || recharge.transactionId !== op.transaction_id || recharge.appId !== h.request.approval.appId
    || recharge.merchantId !== h.request.approval.merchantId || recharge.principalCents !== op.principal_cents
    || recharge.giftCents !== op.gift_cents || recharge.reclaimGift !== op.reclaim_gift || recharge.debitCents !== op.debit_cents
    || recharge.refundBeforeCents !== 0 || recharge.refundAfterCents !== 0 || r.holdBillId !== h.request.holdBillId
    || !money(wallet.beforeCents, true) || !money(wallet.afterCents, true) || wallet.afterCents !== wallet.beforeCents + op.debit_cents
    || !integer(bill.id) || bill.id === r.holdBillId || bill.uid !== op.buyer_uid || bill.linkId !== op.order_no
    || bill.eventKey !== 'recharge_refund_release:' + String(op.operation_id) || bill.pm !== 1 || bill.category !== 'now_money'
    || bill.type !== 'recharge_refund_release' || bill.title !== '渠道关闭充值退款退回预留' || bill.numberCents !== op.debit_cents
    || bill.balanceCents !== wallet.afterCents || bill.status !== 1 || bill.take !== 0 || bill.frozenTime !== 0
    || bill.mark !== '渠道已确认关闭，退回原充值退款预留' || bill.addTime !== r.releasedAt
    || r.releasedAt < Number(op.created_at) || r.releasedAt < h.request.issuedAt
    || r.releasedAt < h.observation.observedAt - 1 || !integer(projection.beforeVersion) || !integer(projection.afterVersion)
    || projection.afterVersion !== projection.beforeVersion + 1) return fail();
  return captureRechargeRefundJson(r) as unknown as Readonly<RechargeRefundQueryReleaseFacts>;
}

/** Use only after the actual release bill INSERT/readback in the owning TX.
 * The existing local-result MAC purpose is separate from provider attestation;
 * status SUCCESS means local return, not successful channel refund. */
export function signRechargeRefundQueryLocalReleaseResult(env: Signing, expectedScope: RechargeRefundScope,
  h: RechargeRefundQueryCaptureHistoryInput, inputFacts: unknown) {
  const scope = captureRechargeRefundScope(expectedScope), facts = captureRechargeRefundQueryReleaseFacts(env, scope, h, inputFacts);
  return signRechargeRefundRecord(env, scope, 'recharge_refund_result', {
    result_id: facts.localResultId, operation_id: facts.operation.id, attempt_id: null, source: 'local_release',
    source_id: 'release:' + facts.operation.id, status: 'SUCCESS', created_at: facts.releasedAt, caused_by_result_id: facts.provider.resultId,
    evidence: { format: 1, purpose: 'recharge-refund-query-closed-release-v1', scope, release: facts } });
}
export function parseRechargeRefundQueryLocalReleaseResult(env: Signing, expectedScope: RechargeRefundScope,
  h: RechargeRefundQueryCaptureHistoryInput, input: unknown) {
  const scope = captureRechargeRefundScope(expectedScope), record = authenticateRechargeRefundRecord(env, scope, 'recharge_refund_result', input);
  const e = object(record.evidence, ['format', 'purpose', 'scope', 'release']);
  const facts = captureRechargeRefundQueryReleaseFacts(env, scope, h, e.release);
  if (e.format !== 1 || e.purpose !== 'recharge-refund-query-closed-release-v1' || !same(captureRechargeRefundScope(e.scope), scope)
    || record.result_id !== facts.localResultId || record.operation_id !== facts.operation.id || record.attempt_id !== null
    || record.source !== 'local_release' || record.source_id !== 'release:' + facts.operation.id || record.status !== 'SUCCESS'
    || record.created_at !== facts.releasedAt || record.caused_by_result_id !== facts.provider.resultId) return fail();
  return Object.freeze({ facts, record });
}
