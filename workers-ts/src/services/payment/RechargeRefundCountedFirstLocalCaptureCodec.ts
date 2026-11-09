/** Counted original-first receipt. The actual POST result is the cause;
 * claimTail only binds the last real GET claim/count and never grants I/O or
 * substitutes a query observation. Pure MAC facts are not physical money proof. */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Env } from '@/env';
import { ServiceUnavailableException } from '@/utils/errors';
import { parseRechargeRefundCountedFirstEconomicBasis,type RechargeRefundCountedFirstEconomicHistoryInput,type RechargeRefundCountedFirstEconomicBasis } from './RechargeRefundCountedFirstEconomicHistory';
import { authenticateRechargeRefundRecord, signRechargeRefundRecord } from './RechargeRefundLedger';
import { captureRechargeRefundJson, captureRechargeRefundScope, type RechargeRefundScope } from './RechargeRefundJournalCodec';
import { routineEvidenceCanonical, routineEvidenceHmac } from './RoutineProviderObservation';

type Signing = Pick<Env, 'APP_KEY'>;
/** Supplied historical rows are authenticated, not established as physical by
 * this interface. Real consumers must read them in their own SQL transaction. */
export type RechargeRefundCountedFirstCaptureHistoryInput=RechargeRefundCountedFirstEconomicHistoryInput;
export interface RechargeRefundCountedFirstCaptureFacts {
  readonly format: 1;
  readonly purpose: 'recharge-refund-counted-first-capture-facts-v1';
  readonly scope: Readonly<RechargeRefundScope>;
  readonly localResultId: string;
  readonly operation: { readonly id: string; readonly signature: string; readonly paymentSignature: string };
  readonly request: { readonly attemptId: string; readonly signature: string; readonly requestHash: string };
  readonly claimTail: {readonly attemptId:string;readonly signature:string;readonly requestHash:string;readonly ordinal:number;
    readonly approvalId:string;readonly approvalSignature:string};
  readonly provider: { readonly resultId: string; readonly signature: string; readonly refundId: string;
    readonly successTime: number; readonly observedAt: number };
  readonly recharge: { readonly id: number; readonly buyerUid: number; readonly orderNo: string;
    readonly transactionId: string; readonly appId: string; readonly merchantId: string;
    readonly principalCents: number; readonly giftCents: number; readonly reclaimGift: boolean;
    readonly debitCents: number; readonly refundBeforeCents: 0; readonly refundAfterCents: number;
    readonly postReservationBalanceCents: number };
  readonly holdBillId: number;
  readonly wallet: { readonly beforeCents: number; readonly afterCents: number };
  readonly flow: { readonly id: number; readonly eventKey: string; readonly flowId: string; readonly orderId: string;
    readonly storeId: number; readonly uid: number; readonly priceCents: number; readonly tradingType: 4;
    readonly payType: 'weixin'; readonly addTime: number; readonly nickname: string; readonly phone: string; readonly mark: string };
  readonly projection: { readonly beforeVersion: number; readonly afterVersion: number; readonly totalAttempts:number };
  readonly capturedAt: number;
}
const MAX_CENTS = 999_999_999_999;
const MAX_INT = 2_147_483_647;
const fail = (): never => { throw new ServiceUnavailableException('充值退款本地结算回执或通知关联暂不可核对'); };
const uuid = (v: unknown): v is string => typeof v === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const integer = (v: unknown, minimum = 1): v is number => typeof v === 'number'
  && Number.isSafeInteger(v) && v >= minimum && v <= MAX_INT;
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
function text(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value.length > max * 2 || value.includes('\0')) return false;
  let length = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (++length > max || point >= 0xd800 && point <= 0xdfff) return false;
  }
  return true;
}
function history(env:Signing,scope:RechargeRefundScope,input:RechargeRefundCountedFirstCaptureHistoryInput):RechargeRefundCountedFirstEconomicBasis{
  return parseRechargeRefundCountedFirstEconomicBasis(env,scope,input);
}

/** Exact canonical capture facts, tied to authenticated original POST SUCCESS.
 * Current wallet audit values can differ from the admission balance. Notice
 * amount4 is always the immutable operation's post-reservation balance. */
export function captureRechargeRefundCountedFirstCaptureFacts(env: Signing, expectedScope: RechargeRefundScope,
  inputHistory: RechargeRefundCountedFirstCaptureHistoryInput, input: unknown) {
  const scope = captureRechargeRefundScope(expectedScope), h = history(env, scope, inputHistory), op = h.operation;
  const r = object(input, ['format', 'purpose', 'scope', 'localResultId', 'operation', 'request', 'provider', 'claimTail',
    'recharge', 'holdBillId', 'wallet', 'flow', 'projection', 'capturedAt']);
  const operation = object(r.operation, ['id', 'signature', 'paymentSignature']);
  const request = object(r.request, ['attemptId', 'signature', 'requestHash']);
  const provider = object(r.provider, ['resultId', 'signature', 'refundId', 'successTime', 'observedAt']);
  const recharge = object(r.recharge, ['id', 'buyerUid', 'orderNo', 'transactionId', 'appId', 'merchantId',
    'principalCents', 'giftCents', 'reclaimGift', 'debitCents', 'refundBeforeCents', 'refundAfterCents', 'postReservationBalanceCents']);
  const wallet = object(r.wallet, ['beforeCents', 'afterCents']);
  const flow = object(r.flow, ['id', 'eventKey', 'flowId', 'orderId', 'storeId', 'uid', 'priceCents', 'tradingType',
    'payType', 'addTime', 'nickname', 'phone', 'mark']);
  const projection = object(r.projection, ['beforeVersion', 'afterVersion', 'totalAttempts']);
  const claimTail=object(r.claimTail,['attemptId','signature','requestHash','ordinal','approvalId','approvalSignature']);
  if (h.observation.status !== 'SUCCESS' || r.format !== 1 || r.purpose !== 'recharge-refund-counted-first-capture-facts-v1'
    || !same(captureRechargeRefundScope(r.scope), scope) || !uuid(r.localResultId) || r.localResultId === h.record.result_id
    || operation.id !== op.operation_id || operation.signature !== op.signature || operation.paymentSignature !== op.payment_signature
    || request.attemptId !== h.attempt.attempt_id || request.signature !== h.attempt.signature || request.requestHash !== h.attempt.request_hash
    || claimTail.attemptId!==h.claimTail.attempt.attempt_id||claimTail.signature!==h.claimTail.attempt.signature||claimTail.requestHash!==h.claimTail.attempt.request_hash
    || claimTail.ordinal!==h.claimTail.payload.ordinal||claimTail.approvalId!==h.claimTail.approval.record_id||claimTail.approvalSignature!==h.claimTail.approval.signature
    || projection.totalAttempts!==h.history.totalAttempts||projection.beforeVersion!==h.history.totalAttempts
    || !integer(r.capturedAt) || r.capturedAt<Number(h.history.attempts.at(-1)!.created_at)
    || provider.resultId !== h.record.result_id || provider.signature !== h.record.signature
    || provider.refundId !== h.observation.providerRefundId || provider.successTime !== h.observation.successTime
    || provider.observedAt !== h.observation.observedAt
    || !money(op.principal_cents) || op.principal_cents <= 0 || !money(op.gift_cents) || typeof op.reclaim_gift !== 'boolean'
    || !money(op.debit_cents) || op.debit_cents !== op.principal_cents + (op.reclaim_gift ? op.gift_cents : 0)
    || !money(op.wallet_before) || !money(op.wallet_after) || op.wallet_before < op.debit_cents
    || op.wallet_before - op.debit_cents !== op.wallet_after
    || recharge.id !== op.recharge_id || recharge.buyerUid !== op.buyer_uid || recharge.orderNo !== op.order_no
    || recharge.transactionId !== op.transaction_id || recharge.appId !== h.request.approval.appId
    || recharge.merchantId !== h.request.approval.merchantId || recharge.principalCents !== op.principal_cents
    || recharge.giftCents !== op.gift_cents || recharge.reclaimGift !== op.reclaim_gift || recharge.debitCents !== op.debit_cents
    || recharge.refundBeforeCents !== 0 || recharge.refundAfterCents !== op.principal_cents
    || recharge.postReservationBalanceCents !== op.wallet_after || r.holdBillId !== h.request.holdBillId
    || !money(wallet.beforeCents, true) || wallet.afterCents !== wallet.beforeCents
    || !integer(flow.id) || flow.eventKey !== 'recharge.refund:' + String(op.operation_id)
    || flow.flowId !== String(op.operation_id).replaceAll('-', '') || flow.orderId !== op.order_no || !integer(flow.storeId, 0)
    || flow.uid !== op.buyer_uid || flow.priceCents !== -op.principal_cents || flow.tradingType !== 4 || flow.payType !== 'weixin'
    || r.capturedAt < Number(op.created_at) || r.capturedAt < h.request.issuedAt
    || r.capturedAt < h.observation.observedAt - 1 || flow.addTime !== r.capturedAt
    || !text(flow.nickname, 255) || !text(flow.phone, 20) || flow.phone.trim() !== flow.phone || !text(flow.mark, 500)
    || !integer(projection.beforeVersion) || !integer(projection.afterVersion)
    || projection.afterVersion !== projection.beforeVersion + 1) return fail();
  const facts = captureRechargeRefundJson(r) as unknown as RechargeRefundCountedFirstCaptureFacts;
  const settlementCommitment = createHash('sha256').update('recharge-refund-counted-first-capture-commitment-v1\n'
    + routineEvidenceCanonical(facts)).digest('hex');
  return Object.freeze({ facts, settlementCommitment });
}

export const RECHARGE_REFUND_COUNTED_FIRST_SUCCESS_NOTICE_TYPE = 'recharge.refund.success.notice' as const;
function noticeBody(f: RechargeRefundCountedFirstCaptureFacts, settlementCommitment: string) {
  return { format: 1 as const, purpose: 'recharge-refund-counted-first-success-notice-intent-v1' as const, scope: f.scope,
    event: { type: RECHARGE_REFUND_COUNTED_FIRST_SUCCESS_NOTICE_TYPE, key: RECHARGE_REFUND_COUNTED_FIRST_SUCCESS_NOTICE_TYPE + ':' + f.operation.id,
      aggregateType: 'recharge' as const, aggregateId: f.recharge.id, occurredAt: f.capturedAt },
    localResultId: f.localResultId, claimTail:f.claimTail, operation: { id: f.operation.id, signature: f.operation.signature },
    providerResult: { id: f.provider.resultId, signature: f.provider.signature }, settlementCommitment,
    business: { domain: 'recharge' as const, rechargeId: f.recharge.id, orderNo: f.recharge.orderNo, buyerUid: f.recharge.buyerUid,
      appId: f.recharge.appId, merchantId: f.recharge.merchantId, principalCents: f.recharge.principalCents,
      postBalanceCents: f.recharge.postReservationBalanceCents, occurredAt: f.capturedAt } };
}
/** Internal pure builder only; no physical capture or sending authority. The
 * notice names the preselected local UUID, never its not-yet-created MAC. */
export function signRechargeRefundCountedFirstSuccessNoticeIntent(env: Signing, scope: RechargeRefundScope,
  inputHistory: RechargeRefundCountedFirstCaptureHistoryInput, inputFacts: unknown) {
  const captured = captureRechargeRefundCountedFirstCaptureFacts(env, scope, inputHistory, inputFacts);
  const body = noticeBody(captured.facts, captured.settlementCommitment);
  return captureRechargeRefundJson({ ...body,
    signature: routineEvidenceHmac(env, 'recharge-refund-counted-first-success-notice-intent-v1', body) }) as unknown as
    Readonly<ReturnType<typeof noticeBody> & { readonly signature: string }>;
}
export function parseRechargeRefundCountedFirstSuccessNoticeIntent(env: Signing, scope: RechargeRefundScope,
  inputHistory: RechargeRefundCountedFirstCaptureHistoryInput, inputFacts: unknown, input: unknown) {
  const expected = signRechargeRefundCountedFirstSuccessNoticeIntent(env, scope, inputHistory, inputFacts);
  const r = object(input, ['format', 'purpose', 'scope', 'event', 'localResultId', 'operation', 'providerResult',
    'settlementCommitment', 'business', 'claimTail', 'signature']);
  const { signature, ...body } = r, { signature: expectedSignature, ...expectedBody } = expected;
  if (!hex(signature) || !same(body, expectedBody)
    || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'))) return fail();
  return expected;
}

/** Exact immutable projection of an actual outbox row, excluding mutable
 * dispatch status/counters/leases. Callers must obtain this row physically. */
export interface RechargeRefundCountedFirstCaptureNoticeRow {
  readonly id: number; readonly eventKey: string; readonly aggregateType: 'recharge'; readonly aggregateId: number;
  readonly eventType: typeof RECHARGE_REFUND_COUNTED_FIRST_SUCCESS_NOTICE_TYPE; readonly payload: unknown; readonly addTime: number;
}
function noticeRow(env: Signing, scope: RechargeRefundScope, h: RechargeRefundCountedFirstCaptureHistoryInput,
  facts: RechargeRefundCountedFirstCaptureFacts, input: unknown) {
  const r = object(input, ['id', 'eventKey', 'aggregateType', 'aggregateId', 'eventType', 'payload', 'addTime']);
  const payload = parseRechargeRefundCountedFirstSuccessNoticeIntent(env, scope, h, facts, r.payload);
  if (!integer(r.id) || r.eventKey !== payload.event.key || r.aggregateType !== 'recharge'
    || r.aggregateId !== facts.recharge.id || r.eventType !== RECHARGE_REFUND_COUNTED_FIRST_SUCCESS_NOTICE_TYPE || r.addTime !== facts.capturedAt) return fail();
  return Object.freeze({ id: r.id, eventKey: payload.event.key, aggregateType: 'recharge' as const,
    aggregateId: facts.recharge.id, eventType: RECHARGE_REFUND_COUNTED_FIRST_SUCCESS_NOTICE_TYPE, payload, addTime: facts.capturedAt });
}
/** Sign only after the actual flow and notice INSERT/readbacks in the owning
 * transaction. That author must still commit receipt+projection atomically. */
export function signRechargeRefundCountedFirstLocalCaptureResult(env: Signing, expectedScope: RechargeRefundScope,
  h: RechargeRefundCountedFirstCaptureHistoryInput, inputFacts: unknown, inputNoticeRow: unknown) {
  const scope = captureRechargeRefundScope(expectedScope), { facts, settlementCommitment } = captureRechargeRefundCountedFirstCaptureFacts(env, scope, h, inputFacts);
  const notice = noticeRow(env, scope, h, facts, inputNoticeRow);
  return signRechargeRefundRecord(env, scope, 'recharge_refund_result', {
    result_id: facts.localResultId, operation_id: facts.operation.id, attempt_id: null, source: 'local_settlement',
    source_id: 'settle:' + facts.operation.id, status: 'SUCCESS', created_at: facts.capturedAt, caused_by_result_id: facts.provider.resultId,
    evidence: { format: 1, purpose: 'recharge-refund-counted-first-local-capture-v1', scope, settlement: facts, settlementCommitment,
      noticeIntent: { id: notice.id, eventKey: notice.eventKey, payloadSignature: notice.payload.signature } } });
}
/** Authenticated historical closure, not proof of current physical cash flow,
 * original source/hold, projection or an actual committed notice pair. */
export function parseRechargeRefundCountedFirstLocalCaptureResult(env: Signing, expectedScope: RechargeRefundScope,
  h: RechargeRefundCountedFirstCaptureHistoryInput, input: unknown, inputNoticeRow: unknown) {
  const scope = captureRechargeRefundScope(expectedScope), record = authenticateRechargeRefundRecord(env, scope, 'recharge_refund_result', input);
  const e = object(record.evidence, ['format', 'purpose', 'scope', 'settlement', 'settlementCommitment', 'noticeIntent']);
  const { facts, settlementCommitment } = captureRechargeRefundCountedFirstCaptureFacts(env, scope, h, e.settlement);
  const notice = noticeRow(env, scope, h, facts, inputNoticeRow);
  const link = object(e.noticeIntent, ['id', 'eventKey', 'payloadSignature']);
  if (e.format !== 1 || e.purpose !== 'recharge-refund-counted-first-local-capture-v1' || !same(captureRechargeRefundScope(e.scope), scope)
    || e.settlementCommitment !== settlementCommitment || link.id !== notice.id || link.eventKey !== notice.eventKey
    || link.payloadSignature !== notice.payload.signature || record.result_id !== facts.localResultId
    || record.operation_id !== facts.operation.id || record.attempt_id !== null || record.source !== 'local_settlement'
    || record.source_id !== 'settle:' + facts.operation.id || record.status !== 'SUCCESS'
    || record.created_at !== facts.capturedAt || record.caused_by_result_id !== facts.provider.resultId) return fail();
  return Object.freeze({ facts, settlementCommitment, notice, record });
}
