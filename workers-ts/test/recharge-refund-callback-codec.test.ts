/** Synthetic MAC and wire-shape contracts; NOT actual provider/SQL acceptance. */
import { describe, expect, it } from 'vitest';
import { captureRechargeRefundCallbackAmount, parseRechargeRefundCallbackResult } from '@/services/payment/RechargeRefundCallbackCodec';
import { parseRechargeRefundCallbackEnvelope, parseRechargeRefundCallbackPayload, rechargeRefundCallbackRfc3339 } from '@/services/payment/RechargeRefundCallbackPayload';
import { rechargeRoutineRefundAccountId, signRechargeRoutineRefundAccountJournal } from '@/services/payment/RechargeRoutineRefundAccountCodec';
import { rechargeRefundTransportApproval } from '@/services/payment/RechargeRefundFirstRequest';
import { callbackScope as scope, callbackSigning as env, rechargeRefundCallbackPureFixture } from './helpers/rechargeRefundCallbackPure';
import { operationSourceUuid } from './helpers/rechargeRefundOperationSourcePure';

type Fixture = ReturnType<typeof rechargeRefundCallbackPureFixture>;
const read = (f: Fixture, result: unknown = f.result(), approval: unknown = f.approval) =>
  parseRechargeRefundCallbackResult(env, scope, f.history.operation, f.first.attempt, f.history.first.approval, approval, result);
const payload = (f: Fixture, envelope: unknown = f.wireEnvelope, plaintext: unknown = f.wirePlaintext) =>
  parseRechargeRefundCallbackPayload(f.first.payload, envelope, plaintext, 2501);
function policy(f: Fixture, patch: Record<string, unknown> = {}, row: Record<string, unknown> = {}) {
  const { signature: _, ...raw } = f.approval;
  return signRechargeRoutineRefundAccountJournal(env, scope, { ...raw,
    payload: { ...raw.payload, data: { ...raw.payload.data, ...patch } }, ...row });
}

describe('recharge refund independent callback attestation', () => {
  it.each(['SUCCESS', 'CLOSED', 'ABNORMAL'] as const)('retains %s with no query attempt or invented HTTP response', status => {
    const f = rechargeRefundCallbackPureFixture(status), p = read(f);
    expect(p.observation.status).toBe(status); expect(p.record.attempt_id).toBeNull();
    expect(p.observation.eventType).toBe('REFUND.' + status); expect(p.approval.payload.data.credentialVersion).toBe(3);
    expect(Object.hasOwn(p.observation, 'httpStatus')).toBe(false); expect(Object.hasOwn(p, 'capability')).toBe(false);
    expect(Object.isFrozen(p)).toBe(true); expect(Object.isFrozen(p.observation.amount)).toBe(true);
  });
  it('uses a separate notify approval after first-request approval expiry without current credentials', () => {
    const f = rechargeRefundCallbackPureFixture();
    expect(f.history.first.approval.payload.data.validUntil).toBeLessThan(f.evidence.verification.receivedAt);
    expect(read(f).observation.verifierKey).toBe('SYNTHETIC_CALLBACK_KEY');
  });
  it.each([
    ['attempt_id', operationSourceUuid(6)], ['source', 'query'], ['source_id', 'different-event'],
    ['status', 'PROCESSING'], ['operation_id', operationSourceUuid(999)], ['created_at', 2502],
    ['caused_by_result_id', operationSourceUuid(503)],
  ])('rejects freshly MACed callback row mutation %s', (key, value) => {
    const f = rechargeRefundCallbackPureFixture(); expect(() => read(f, f.result({}, { [key]: value }))).toThrow();
  });
  it.each([
    ['format', 2], ['purpose', 'recharge-refund-query-provider-result-v1'], ['operationSignature', '0'.repeat(64)],
    ['firstAttemptId', operationSourceUuid(888)], ['firstAttemptSignature', '0'.repeat(64)], ['firstRequestHash', '0'.repeat(64)],
    ['extra', true],
  ])('rejects independently MACed callback binding mutation %s', (key, value) => {
    const f = rechargeRefundCallbackPureFixture(); expect(() => read(f, f.result({ [key]: value }))).toThrow();
  });
  it.each(['outTradeNo', 'transactionId', 'outRefundNo', 'refundAmount', 'totalAmount', 'currency'])('rejects original %s substitution', key => {
    const f = rechargeRefundCallbackPureFixture();
    expect(() => read(f, f.result({ original: { ...f.evidence.original, [key]: key.endsWith('Amount') ? 1 : 'other' } }))).toThrow();
  });
  it.each([
    { eventId: 'a'.repeat(37) }, { eventId: 'EV/invalid' }, { eventType: 'REFUND.CLOSED' },
    { createdAt: 800 }, { createdAt: 2802 }, { createdAt: 0 },
  ])('rejects callback event mutation %j', change => {
    const f = rechargeRefundCallbackPureFixture(), e = { ...f.evidence.event, ...change };
    expect(() => read(f, f.result({ event: e }, { source_id: e.eventId }))).toThrow();
  });
  it.each([
    { status: 'PROCESSING' }, { status: 'NOT_FOUND' }, { providerRefundId: '' }, { providerRefundId: 'a'.repeat(33) },
    { successTime: 800 }, { successTime: 2802 }, { successTime: 0 }, { successTime: '1102' },
  ])('rejects callback result mutation %j', change => {
    const f = rechargeRefundCallbackPureFixture(); expect(() => read(f, f.result({ result: { ...f.evidence.result, ...change } }))).toThrow();
  });
  it.each(['CLOSED', 'ABNORMAL'] as const)('rejects fabricated success time on %s', status => {
    const f = rechargeRefundCallbackPureFixture(status);
    expect(() => read(f, f.result({ result: { ...f.evidence.result, successTime: 1102 } }))).toThrow();
  });
  it.each([
    { requestDigest: '' }, { plaintextDigest: 'f'.repeat(63) }, { verifierKey: '' }, { signedAt: 2200 },
    { signedAt: 2802 }, { signedAt: '2501' }, { receivedAt: 0 }, { receivedAt: 2502 }, { extra: 'ready' },
  ])('rejects verification mutation %j', change => {
    const f = rechargeRefundCallbackPureFixture();
    expect(() => read(f, f.result({ verification: { ...f.evidence.verification, ...change } }))).toThrow();
  });
  it.each([2201, 2801])('accepts exact 300-second signature boundary %s as historical data', signedAt => {
    const f = rechargeRefundCallbackPureFixture();
    expect(read(f, f.result({ verification: { ...f.evidence.verification, signedAt } })).observation.signedAt).toBe(signedAt);
  });
  it.each([
    { purposes: ['refund_query'] }, { purposes: ['refund_request'] }, { state: 'revoked' },
    { validFrom: 2502 }, { validUntil: 2501 }, { appId: 'different_app' },
  ])('rejects unapproved notify policy %j', change => {
    const f = rechargeRefundCallbackPureFixture();
    expect(() => {
      const a = policy(f, change); return read(f, f.result({ approval: rechargeRefundTransportApproval(a) }), a);
    }).toThrow();
  });
  it('rejects a notify approval recorded after receipt', () => {
    const f = rechargeRefundCallbackPureFixture(), a = policy(f, {}, { created_at: 2502 });
    expect(() => read(f, f.result({ approval: rechargeRefundTransportApproval(a) }), a)).toThrow();
  });
  it.each(['app', 'merchant'])('rejects a well-formed separately signed notify policy for another %s', field => {
    const f = rechargeRefundCallbackPureFixture();
    const appId = field === 'app' ? 'different_synthetic_app' : f.approval.payload.data.appId;
    const merchantId = field === 'merchant' ? '99999999' : f.approval.payload.data.merchantId;
    const accountId = rechargeRoutineRefundAccountId(env, appId, merchantId);
    const a = policy(f, { appId, merchantId, accountId }, { account_id: accountId });
    expect(() => read(f, f.result({ approval: rechargeRefundTransportApproval(a) }), a)).toThrow();
  });
  it('rejects cross-database replay', () => {
    const f = rechargeRefundCallbackPureFixture();
    expect(() => parseRechargeRefundCallbackResult(env, { ...scope, databaseOid: '9999' }, f.history.operation,
      f.first.attempt, f.history.first.approval, f.approval, f.result())).toThrow();
  });
  it('rejects tampered MAC without refreshing it', () => {
    const f = rechargeRefundCallbackPureFixture(); expect(() => read(f, { ...f.result(), signature: '0'.repeat(64) })).toThrow();
  });
  it('copies historical input and never invokes an evidence getter', () => {
    const f = rechargeRefundCallbackPureFixture(), row = { ...f.result() }; let calls = 0;
    Object.defineProperty(row, 'evidence', { enumerable: true, get() { calls++; throw Error('executed'); } });
    expect(() => read(f, row)).toThrow(); expect(calls).toBe(0);
  });
});

describe('full principal versus provider cash amount', () => {
  it.each([0, 80, 100])('allows provider cash %s of principal100 without changing wallet principal', cash => {
    expect(captureRechargeRefundCallbackAmount({ total: 100, refund: 100, payerTotal: cash, payerRefund: cash }, 100))
      .toEqual({ total: 100, refund: 100, payerTotal: cash, payerRefund: cash });
  });
  it.each([
    { total: 99 }, { refund: 99 }, { payerTotal: 101, payerRefund: 101 }, { payerRefund: 99 },
    { payerTotal: -1, payerRefund: -1 }, { payerTotal: '100' }, { payerTotal: 0.1 }, { extra: 'CNY' },
  ])('rejects amount mutation %j', patch => {
    expect(() => captureRechargeRefundCallbackAmount({ total: 100, refund: 100, payerTotal: 100, payerRefund: 100, ...patch }, 100)).toThrow();
  });
});

describe('direct merchant wire payload without provider verification claims', () => {
  it.each(['SUCCESS', 'CLOSED', 'ABNORMAL'] as const)('parses official %s fields and omits destination PII', status => {
    const f = rechargeRefundCallbackPureFixture(status), p = payload(f);
    expect(p.status).toBe(status); expect(p.eventType).toBe('REFUND.' + status);
    expect(Object.hasOwn(p, 'user_received_account')).toBe(false); expect(Object.hasOwn(p, 'verified')).toBe(false);
  });
  it('accepts absent optional AAD as empty while copying bounded unknown external data', () => {
    const f = rechargeRefundCallbackPureFixture(), { associated_data: _, ...resource } = f.wireEnvelope.resource;
    const envelope = { ...f.wireEnvelope, resource, future: { safe: true } };
    expect(parseRechargeRefundCallbackEnvelope(envelope).resource.associatedData).toBe('');
    expect(payload(f, envelope, { ...f.wirePlaintext, future: [1, 2] }).status).toBe('SUCCESS');
  });
  it('uses refund_status and refuses a response-style status field as a substitute', () => {
    const f = rechargeRefundCallbackPureFixture(), { refund_status: _, ...raw } = f.wirePlaintext;
    expect(() => payload(f, f.wireEnvelope, { ...raw, status: 'SUCCESS' })).toThrow();
  });
  it.each(['mchid', 'out_trade_no', 'transaction_id', 'out_refund_no', 'appid'])('rejects substituted wire %s', field => {
    const f = rechargeRefundCallbackPureFixture(); expect(() => payload(f, f.wireEnvelope, { ...f.wirePlaintext, [field]: 'other' })).toThrow();
  });
  it.each(['total', 'refund', 'payer_total', 'payer_refund', 'currency'])('rejects bad wire amount %s', field => {
    const f = rechargeRefundCallbackPureFixture(); expect(() => payload(f, f.wireEnvelope, { ...f.wirePlaintext,
      amount: { ...f.wirePlaintext.amount, [field]: field === 'currency' ? 'USD' : -1 } })).toThrow();
  });
  it.each([
    { resource_type: 'plain' }, { event_type: 'REFUND.PROCESSING' }, { event_type: 'REFUND.CLOSED' },
    { create_time: '1970-02-30T00:00:00Z' }, { id: '' }, { summary: '' },
  ])('rejects outer wire mutation %j', change => {
    const f = rechargeRefundCallbackPureFixture(); expect(() => payload(f, { ...f.wireEnvelope, ...change })).toThrow();
  });
  it.each([
    { algorithm: 'AES' }, { original_type: 'transaction' }, { nonce: '' }, { nonce: 'a'.repeat(33) },
    { associated_data: 'a'.repeat(17) }, { associated_data: null }, { ciphertext: '' }, { ciphertext: '!!!!' },
    { ciphertext: 'AQ==' },
  ])('rejects invalid encrypted resource shape %j', change => {
    const f = rechargeRefundCallbackPureFixture();
    expect(() => payload(f, { ...f.wireEnvelope, resource: { ...f.wireEnvelope.resource, ...change } })).toThrow();
  });
  it('rejects an encrypted envelope beyond the local finite JSON ceiling', () => {
    const f = rechargeRefundCallbackPureFixture();
    expect(() => payload(f, { ...f.wireEnvelope, resource: { ...f.wireEnvelope.resource, ciphertext: 'A'.repeat(16400) } })).toThrow();
  });
  it('accepts optional matching appid/currency and discounted cash without requiring these optional fields', () => {
    const f = rechargeRefundCallbackPureFixture(), cash = Math.floor(f.wirePlaintext.amount.total / 2);
    const p = payload(f, f.wireEnvelope, { ...f.wirePlaintext, appid: f.first.payload.approval.appId,
      amount: { ...f.wirePlaintext.amount, currency: 'CNY', payer_total: cash, payer_refund: cash } });
    expect(p.amount.total).toBe(f.first.payload.request.totalAmount); expect(p.amount.payerRefund).toBe(cash);
  });
  it('never executes unknown external toJSON or getters', () => {
    const f = rechargeRefundCallbackPureFixture(); let calls = 0;
    const raw = { ...f.wirePlaintext, toJSON() { calls++; throw Error('executed'); } };
    expect(() => payload(f, f.wireEnvelope, raw)).toThrow();
    const getter = { ...f.wirePlaintext }; Object.defineProperty(getter, 'future', { enumerable: true, get() { calls++; return 'x'; } });
    expect(() => payload(f, f.wireEnvelope, getter)).toThrow(); expect(calls).toBe(0);
  });
  it.each(['issuedAt', 'request', 'approval'])('checks copied first-request %s instead of trusting a TS type', field => {
    const f = rechargeRefundCallbackPureFixture();
    expect(() => parseRechargeRefundCallbackPayload({ ...f.first.payload, [field]: {} }, f.wireEnvelope, f.wirePlaintext, 2501)).toThrow();
  });
  it.each(['outTradeNo', 'transactionId', 'outRefundNo', 'totalAmount', 'refundAmount'])('rejects missing expected first-request %s', field => {
    const f = rechargeRefundCallbackPureFixture(), q: Record<string, unknown> = { ...f.first.payload.request }; delete q[field];
    expect(() => parseRechargeRefundCallbackPayload({ ...f.first.payload, request: q }, f.wireEnvelope, f.wirePlaintext, 2501)).toThrow();
  });
  it('does not accept matching absent wire/original identity fields', () => {
    const f = rechargeRefundCallbackPureFixture();
    const { mchid: _, out_trade_no: _o, transaction_id: _t, out_refund_no: _r, ...raw } = f.wirePlaintext;
    expect(() => parseRechargeRefundCallbackPayload({ request: { totalAmount: 1000, refundAmount: 1000 }, approval: {} }, f.wireEnvelope, raw, 2501)).toThrow();
  });
  it('never executes a getter on the supplied first-request payload', () => {
    const f = rechargeRefundCallbackPureFixture(); let calls = 0;
    const first = { ...f.first.payload }; Object.defineProperty(first, 'request', { enumerable: true, get() { calls++; return f.first.payload.request; } });
    expect(() => parseRechargeRefundCallbackPayload(first, f.wireEnvelope, f.wirePlaintext, 2501)).toThrow(); expect(calls).toBe(0);
  });
  it('never executes a getter nested inside the expected original tuple', () => {
    const f = rechargeRefundCallbackPureFixture(); let calls = 0;
    const q = { ...f.first.payload.request }; Object.defineProperty(q, 'totalAmount', { enumerable: true, get() { calls++; return 1000; } });
    expect(() => parseRechargeRefundCallbackPayload({ ...f.first.payload, request: q }, f.wireEnvelope, f.wirePlaintext, 2501)).toThrow(); expect(calls).toBe(0);
  });
  it.each([
    '2025-02-29T00:00:00Z', '2024-04-31T00:00:00Z', '2024-01-01T24:00:00Z', '2024-01-01T00:60:00Z',
    '2024-01-01T00:00:60Z', '2024-01-01T00:00:00', '2024-01-01T00:00:00.1Z', '2024-01-01T00:00:00+24:00',
    '2024-01-01T00:00:00+00:60', '2038-01-19T03:14:08Z', '1970-01-01T00:00:00Z',
  ])('rejects unsupported or invalid exact timestamp %s', value => {
    expect(() => rechargeRefundCallbackRfc3339(value)).toThrow();
  });
  it.each(['2024-02-29T08:00:00+08:00', '2024-02-28T19:00:00-05:00', '2024-02-29T00:00:00Z'])('normalizes actual timezone %s', value => {
    expect(rechargeRefundCallbackRfc3339(value)).toBe(Date.UTC(2024, 1, 29) / 1000);
  });
});
