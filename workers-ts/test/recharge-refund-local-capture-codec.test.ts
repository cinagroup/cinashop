/** Pure synthetic history/receipt contracts only. No real RSA, SQL funds,
 * physical notice row or sending authority is established by this file. */
import { describe, expect, it } from 'vitest';
import { captureRechargeRefundCaptureFacts, parseRechargeRefundLocalCaptureResult,
  parseRechargeRefundSuccessNoticeIntent } from '@/services/payment/RechargeRefundLocalCaptureCodec';
import { rechargeLocalCapturePureFixture, localCaptureScope as scope, localCaptureSigning as env } from './helpers/rechargeLocalCapturePure';
import { operationSourceUuid, sourceClone } from './helpers/rechargeRefundOperationSourcePure';
type Fixture = ReturnType<typeof rechargeLocalCapturePureFixture>;
const parse = (f: Fixture, row: unknown = f.local(), notice: unknown = f.row()) =>
  parseRechargeRefundLocalCaptureResult(env, scope, f.history, row, notice);

describe('closed recharge capture and acyclic refund-success intent codecs', () => {
  it.each([true, false])('roundtrips gift recovery=%s with a later changed wallet but the original notice balance', reclaimGift => {
    const f = rechargeLocalCapturePureFixture(reclaimGift), parsed = parse(f);
    expect(parsed.facts.wallet).toEqual({ beforeCents: 1700, afterCents: 1700 });
    expect(parsed.facts.recharge.debitCents).toBe(reclaimGift ? 1150 : 1000);
    expect(parsed.notice.payload.business.postBalanceCents).toBe(reclaimGift ? 0 : 150);
    expect(parsed.facts.flow.priceCents).toBe(-1000); expect(parsed.facts.flow.flowId).toHaveLength(32);
    expect(parsed.record).toMatchObject({ source: 'local_settlement', status: 'SUCCESS', caused_by_result_id: f.history.providerResult.result_id });
    expect(Object.isFrozen(parsed.facts.flow)).toBe(true); expect(Object.isFrozen(parsed.notice.payload.business)).toBe(true);
    expect(parsed.notice.payload).not.toHaveProperty('localResultSignature');
  });
  it.each([0, -150, 999999999999])('records actual capture-time balance %s without another wallet debit', balance => {
    const f = rechargeLocalCapturePureFixture(), facts = f.facts({ wallet: { beforeCents: balance, afterCents: balance } });
    expect(parse(f, f.local(facts), f.row(facts)).facts.wallet.afterCents).toBe(balance);
  });
  it.each(['PROCESSING', 'CLOSED', 'ABNORMAL', 'UNKNOWN'] as const)('cannot build a SUCCESS capture from authenticated %s', status => {
    const f = rechargeLocalCapturePureFixture(true, status); expect(() => f.capture()).toThrow(); expect(() => f.notice()).toThrow();
  });
  const mutations: Array<[string, (f: Fixture) => unknown]> = [
    ['extra field', f => f.facts({ extra: true })], ['wrong purpose', f => f.facts({ purpose: 'recharge-paid' })],
    ['wrong scope', f => f.facts({ scope: { ...scope, adminOid: '56' } })],
    ['provider result UUID reused', f => f.facts({ localResultId: f.history.providerResult.result_id })],
    ['wrong operation reference', f => f.facts({ operation: { ...f.facts().operation, id: operationSourceUuid(10) } })],
    ['wrong operation signature', f => f.facts({ operation: { ...f.facts().operation, signature: '0'.repeat(64) } })],
    ['wrong payment signature', f => f.facts({ operation: { ...f.facts().operation, paymentSignature: '0'.repeat(64) } })],
    ['wrong attempt', f => f.facts({ request: { ...f.facts().request, attemptId: operationSourceUuid(10) } })],
    ['wrong request hash', f => f.facts({ request: { ...f.facts().request, requestHash: '0'.repeat(64) } })],
    ['wrong provider signature', f => f.facts({ provider: { ...f.facts().provider, signature: '0'.repeat(64) } })],
    ['wrong provider refund ID', f => f.facts({ provider: { ...f.facts().provider, refundId: 'other_refund' } })],
    ['wrong provider time', f => f.facts({ provider: { ...f.facts().provider, successTime: 1101 } })],
    ['wrong buyer', f => f.facts({ recharge: { ...f.facts().recharge, buyerUid: 99 } })],
    ['wrong original pair', f => f.facts({ recharge: { ...f.facts().recharge, appId: 'wx_current_b' } })],
    ['gift included in external cash', f => f.facts({ recharge: { ...f.facts().recharge, refundAfterCents: 1150 } })],
    ['wrong gift choice', f => f.facts({ recharge: { ...f.facts().recharge, reclaimGift: false } })],
    ['partial prior refund', f => f.facts({ recharge: { ...f.facts().recharge, refundBeforeCents: 100 } })],
    ['later wallet used for notice balance', f => f.facts({ recharge: { ...f.facts().recharge, postReservationBalanceCents: 1700 } })],
    ['wrong hold', f => f.facts({ holdBillId: 73 })],
    ['second wallet debit', f => f.facts({ wallet: { beforeCents: 1700, afterCents: 550 } })],
    ['wrong flow key', f => f.facts({ flow: { ...f.facts().flow, eventKey: 'refund:other' } })],
    ['oversized merchant refund number used as flow ID', f => f.facts({ flow: { ...f.facts().flow, flowId: f.history.operation.out_refund_no } })],
    ['wrong flow amount', f => f.facts({ flow: { ...f.facts().flow, priceCents: -1150 } })],
    ['wrong flow buyer', f => f.facts({ flow: { ...f.facts().flow, uid: 99 } })],
    ['wrong flow type', f => f.facts({ flow: { ...f.facts().flow, tradingType: 2 } })],
    ['wrong flow channel', f => f.facts({ flow: { ...f.facts().flow, payType: 'alipay' } })],
    ['negative store snapshot', f => f.facts({ flow: { ...f.facts().flow, storeId: -1 } })],
    ['wrong flow clock', f => f.facts({ flow: { ...f.facts().flow, addTime: 1102 } })],
    ['capture predates request', f => f.facts({ capturedAt: 1100, flow: { ...f.facts().flow, addTime: 1100 } })],
    ['wrong projection increment', f => f.facts({ projection: { beforeVersion: 1, afterVersion: 3 } })],
    ['projection overflow', f => f.facts({ projection: { beforeVersion: 2147483647, afterVersion: 2147483648 } })],
    ['notice included in capture commitment', f => f.facts({ noticeIntent: f.row() })],
  ];
  it.each(mutations)('refuses %s', (_name, mutate) => { const f = rechargeLocalCapturePureFixture(); expect(() => f.capture(mutate(f))).toThrow(); });
  it.each([
    { debit_cents: 1000 }, { gift_cents: -1 }, { reclaim_gift: false }, { wallet_before: 1000 },
    { wallet_after: -1 }, { wallet_before: 1000000000000, wallet_after: 999999998850 },
  ])('valid enclosing MACs do not substitute for reserved-operation amount arithmetic %#', patch => {
    const f = rechargeLocalCapturePureFixture(true, 'SUCCESS', patch); expect(() => f.capture()).toThrow();
  });
  it.each(['nickname', 'phone', 'mark'] as const)('enforces actual Unicode capacity, NUL and surrogate safety for %s', field => {
    const f = rechargeLocalCapturePureFixture(), max = field === 'nickname' ? 255 : field === 'phone' ? 20 : 500;
    expect(() => f.capture(f.facts({ flow: { ...f.facts().flow, [field]: '😀'.repeat(max) } }))).not.toThrow();
    for (const value of ['😀'.repeat(max + 1), '\ud800', 'a\0b']) expect(() => f.capture(f.facts({ flow: { ...f.facts().flow, [field]: value } }))).toThrow();
  });
  it.each([
    { format: 2 }, { purpose: 'recharge_success' }, { extra: true }, { localResultSignature: '0'.repeat(64) },
    { settlementCommitment: '0'.repeat(64) }, { localResultId: operationSourceUuid(10) },
  ])('rejects another valid notice MAC whose body breaks the exact capture link %#', patch => {
    const f = rechargeLocalCapturePureFixture(); expect(() => parseRechargeRefundSuccessNoticeIntent(env, scope, f.history, f.facts(), f.signedNotice(patch))).toThrow();
  });
  it('refuses a newly signed notice that uses current wallet or another provider cause', () => {
    const f = rechargeLocalCapturePureFixture(), n = f.notice();
    for (const patch of [{ business: { ...n.business, postBalanceCents: 1700 } }, { providerResult: { ...n.providerResult, id: operationSourceUuid(10) } }])
      expect(() => parseRechargeRefundSuccessNoticeIntent(env, scope, f.history, f.facts(), f.signedNotice(patch))).toThrow();
  });
  it.each([
    { id: 93 }, { eventKey: 'other' }, { aggregateType: 'order' }, { aggregateId: 32 }, { eventType: 'recharge.pay.success.notice' }, { addTime: 1104 },
  ])('refuses physical notice projection swap or metadata drift %#', patch => {
    const f = rechargeLocalCapturePureFixture(); expect(() => parse(f, f.local(), { ...f.row(), ...patch })).toThrow();
  });
  it('refuses a different valid intent even when its operation matches', () => {
    const f = rechargeLocalCapturePureFixture(), otherFacts = f.facts({ localResultId: operationSourceUuid(10) });
    expect(() => parse(f, f.local(), f.row(otherFacts))).toThrow();
  });
  it.each([
    { purpose: 'recharge-paid' }, { settlementCommitment: '0'.repeat(64) }, { extra: true },
    { noticeIntent: { id: 93, eventKey: 'wrong', payloadSignature: '0'.repeat(64) } },
  ])('refuses a valid local MAC with incorrect closed evidence %#', patch => {
    const f = rechargeLocalCapturePureFixture(); expect(() => parse(f, f.signedLocal(patch))).toThrow();
  });
  it.each([
    { operation_id: operationSourceUuid(10) }, { result_id: operationSourceUuid(10) }, { source: 'local_release' },
    { source_id: 'settle:other' }, { attempt_id: operationSourceUuid(6) }, { status: 'CLOSED' },
    { caused_by_result_id: operationSourceUuid(10) }, { created_at: 1104 },
  ])('refuses a valid local MAC with incorrect row relation %#', patch => {
    const f = rechargeLocalCapturePureFixture(); expect(() => parse(f, f.signedLocal({}, patch))).toThrow();
  });
  it('rejects independent provider/local/notice MAC tampering', () => {
    const f = rechargeLocalCapturePureFixture(); expect(() => parse(f, { ...f.local(), signature: '0'.repeat(64) })).toThrow();
    expect(() => parse(f, f.local(), { ...f.row(), payload: { ...f.notice(), signature: '0'.repeat(64) } })).toThrow();
    expect(() => captureRechargeRefundCaptureFacts(env, scope, { ...f.history, providerResult: { ...f.history.providerResult, signature: '0'.repeat(64) } }, f.facts())).toThrow();
  });
  it('rejects getters before access or any fixture signing, on all new boundaries', () => {
    const f = rechargeLocalCapturePureFixture(); let invoked = 0;
    const getter = { enumerable: true, get() { invoked++; throw Error('must not run'); } };
    const facts = sourceClone(f.facts()); Object.defineProperty(facts, 'flow', getter);
    expect(() => f.capture(facts)).toThrow();
    const h = { ...f.history }; Object.defineProperty(h, 'providerResult', getter);
    expect(() => captureRechargeRefundCaptureFacts(env, scope, h, f.facts())).toThrow();
    const row = sourceClone(f.row()); Object.defineProperty(row, 'payload', getter);
    expect(() => parse(f, f.local(), row)).toThrow();
    const local = sourceClone(f.local()); Object.defineProperty(local, 'evidence', getter);
    expect(() => parse(f, local)).toThrow(); expect(invoked).toBe(0);
  });
  it('applies finite JSON bounds directly, without a fixture signer refusing first', () => {
    const f = rechargeLocalCapturePureFixture(), fractional = sourceClone(f.facts()), oversized = sourceClone(f.facts());
    fractional.flow.id = 91.5; oversized.flow.mark = 'x'.repeat(16385);
    expect(() => f.capture(fractional)).toThrow(); expect(() => f.capture(oversized)).toThrow();
  });
});
