/** Pure synthetic MAC contracts. No SQL bill, wallet credit, real provider or
 * local projection has been executed or established by these fixtures. */
import { describe, expect, it } from 'vitest';
import { captureRechargeRefundReleaseFacts, parseRechargeRefundLocalReleaseResult } from '@/services/payment/RechargeRefundLocalReleaseCodec';
import { rechargeLocalReleasePureFixture, localReleaseScope as scope, localReleaseSigning as env } from './helpers/rechargeLocalReleasePure';
import { operationSourceUuid, sourceClone } from './helpers/rechargeRefundOperationSourcePure';
type Fixture = ReturnType<typeof rechargeLocalReleasePureFixture>;
const parse = (f: Fixture, row: unknown = f.local()) => parseRechargeRefundLocalReleaseResult(env, scope, f.history, row);

describe('closed first-provider CLOSED release history', () => {
  it.each([true, false])('returns the held amount for reclaimGift=%s, preserving later wallet activity', gift => {
    const f = rechargeLocalReleasePureFixture(gift), p = parse(f);
    expect(p.facts.wallet).toEqual({ beforeCents: 1700, afterCents: gift ? 2850 : 2700 });
    expect(p.facts.bill.numberCents).toBe(gift ? 1150 : 1000); expect(p.facts.recharge.refundAfterCents).toBe(0);
    expect(p.record).toMatchObject({ source: 'local_release', status: 'SUCCESS', attempt_id: null, caused_by_result_id: f.history.providerResult.result_id });
    expect(Object.isFrozen(p.facts.bill)).toBe(true); expect(p.facts).not.toHaveProperty('flow'); expect(p.facts).not.toHaveProperty('noticeIntent');
  });
  it.each([0, -150, -999999999999, 999999998849])('uses current locked balance %s plus immutable debit without a clamp', before => {
    const f = rechargeLocalReleasePureFixture(), p = parse(f, f.local(f.facts(before)));
    expect(p.facts.wallet.afterCents).toBe(before + 1150); expect(p.facts.bill.balanceCents).toBe(before + 1150);
  });
  it('accepts the exact numeric upper bound and refuses overflow or underflow directly', () => {
    const f = rechargeLocalReleasePureFixture(); expect(f.release(f.facts(999999998849)).wallet.afterCents).toBe(999999999999);
    expect(() => f.release(f.facts(999999998850))).toThrow(); expect(() => f.release(f.facts(-1000000000000))).toThrow();
  });
  it.each(['SUCCESS', 'PROCESSING', 'ABNORMAL', 'UNKNOWN'] as const)('never releases on authenticated %s', status => {
    const f = rechargeLocalReleasePureFixture(true, status); expect(() => f.release()).toThrow(); expect(() => f.local()).toThrow();
  });
  const mutations: Array<[string, (f: Fixture) => unknown]> = [
    ['extra cash flow', f => f.facts(1700, { flow: { priceCents: -1000 } })],
    ['extra success notice', f => f.facts(1700, { noticeIntent: {} })],
    ['wrong purpose', f => f.facts(1700, { purpose: 'recharge-refund-capture-facts-v1' })],
    ['cross scope', f => f.facts(1700, { scope: { ...scope, adminOid: '56' } })],
    ['reused provider result UUID', f => f.facts(1700, { localResultId: f.history.providerResult.result_id })],
    ['wrong operation signature', f => f.facts(1700, { operation: { ...f.facts().operation, signature: '0'.repeat(64) } })],
    ['wrong first settlement signature', f => f.facts(1700, { operation: { ...f.facts().operation, paymentSignature: '0'.repeat(64) } })],
    ['wrong request UUID', f => f.facts(1700, { request: { ...f.facts().request, attemptId: operationSourceUuid(10) } })],
    ['wrong request hash', f => f.facts(1700, { request: { ...f.facts().request, requestHash: '0'.repeat(64) } })],
    ['wrong provider cause', f => f.facts(1700, { provider: { ...f.facts().provider, resultId: operationSourceUuid(10) } })],
    ['wrong provider MAC', f => f.facts(1700, { provider: { ...f.facts().provider, signature: '0'.repeat(64) } })],
    ['wrong provider refund ID', f => f.facts(1700, { provider: { ...f.facts().provider, refundId: 'another' } })],
    ['wrong buyer', f => f.facts(1700, { recharge: { ...f.facts().recharge, buyerUid: 99 } })],
    ['current account substituted', f => f.facts(1700, { recharge: { ...f.facts().recharge, appId: 'wx_current_b' } })],
    ['refund principal marked as returned', f => f.facts(1700, { recharge: { ...f.facts().recharge, refundAfterCents: 1000 } })],
    ['prior partial channel refund', f => f.facts(1700, { recharge: { ...f.facts().recharge, refundBeforeCents: 100 } })],
    ['gift choice rewritten', f => f.facts(1700, { recharge: { ...f.facts().recharge, reclaimGift: false } })],
    ['wrong hold', f => f.facts(1700, { holdBillId: 73 })],
    ['only principal returned despite gift hold', f => f.facts(1700, { wallet: { beforeCents: 1700, afterCents: 2700 } })],
    ['admission wallet restored over later activity', f => f.facts(1700, { wallet: { beforeCents: 1700, afterCents: 1150 } })],
    ['negative zero', f => f.facts(-0)],
    ['hold reused as release bill', f => f.facts(1700, { bill: { ...f.facts().bill, id: 72 } })],
    ['wrong release bill key', f => f.facts(1700, { bill: { ...f.facts().bill, eventKey: 'recharge_refund_release:other' } })],
    ['debit bill', f => f.facts(1700, { bill: { ...f.facts().bill, pm: 0 } })],
    ['principal only bill', f => f.facts(1700, { bill: { ...f.facts().bill, numberCents: 1000 } })],
    ['wrong bill balance', f => f.facts(1700, { bill: { ...f.facts().bill, balanceCents: 1150 } })],
    ['unusable bill', f => f.facts(1700, { bill: { ...f.facts().bill, status: 0 } })],
    ['cancel-before-POST label', f => f.facts(1700, { bill: { ...f.facts().bill, title: '取消充值退款退回预留' } })],
    ['wrong bill clock', f => f.facts(1700, { bill: { ...f.facts().bill, addTime: 1104 } })],
    ['release predates provider', f => f.facts(1700, { releasedAt: 1100, bill: { ...f.facts().bill, addTime: 1100 } })],
    ['wrong projection increment', f => f.facts(1700, { projection: { beforeVersion: 1, afterVersion: 3 } })],
    ['projection overflow', f => f.facts(1700, { projection: { beforeVersion: 2147483647, afterVersion: 2147483648 } })],
  ];
  it.each(mutations)('refuses %s before a local result is signed', (_name, mutate) => {
    const f = rechargeLocalReleasePureFixture(); expect(() => f.release(mutate(f))).toThrow();
  });
  it.each([{ debit_cents: 1000 }, { reclaim_gift: false }, { gift_cents: -1 }, { wallet_before: 1000 }, { wallet_after: -1 }])
  ('valid enclosing MACs cannot replace correct reservation arithmetic %#', patch => {
    const f = rechargeLocalReleasePureFixture(true, 'CLOSED', patch); expect(() => f.release()).toThrow();
  });
  it.each([{ purpose: 'recharge-refund-local-capture-v1' }, { extra: true }, { scope: { ...scope, databaseOid: '99' } }])
  ('rejects a valid MAC with a different closed local purpose/scope %#', patch => {
    const f = rechargeLocalReleasePureFixture(); expect(() => parse(f, f.signedLocal(patch))).toThrow();
  });
  it.each([{ operation_id: operationSourceUuid(10) }, { result_id: operationSourceUuid(10) }, { attempt_id: operationSourceUuid(6) },
    { source: 'local_settlement' }, { source_id: 'release:other' }, { status: 'CLOSED' }, { caused_by_result_id: operationSourceUuid(10) }, { created_at: 1104 }])
  ('rejects a valid local MAC with a different physical row relation %#', patch => {
    const f = rechargeLocalReleasePureFixture(); expect(() => parse(f, f.signedLocal({}, patch))).toThrow();
  });
  it('rejects changed provider or local MAC without relying on the signing fixture', () => {
    const f = rechargeLocalReleasePureFixture(); expect(() => parse(f, { ...f.local(), signature: '0'.repeat(64) })).toThrow();
    expect(() => captureRechargeRefundReleaseFacts(env, scope, { ...f.history, providerResult: { ...f.history.providerResult, signature: '0'.repeat(64) } }, f.facts())).toThrow();
  });
  it('rejects getters at history, facts and result boundaries without invoking them', () => {
    const f = rechargeLocalReleasePureFixture(); let invoked = 0;
    const getter = { enumerable: true, get() { invoked++; throw Error('must not run'); } };
    const facts = sourceClone(f.facts()), h = { ...f.history }, row = sourceClone(f.local());
    Object.defineProperty(facts, 'bill', getter); Object.defineProperty(h, 'providerResult', getter); Object.defineProperty(row, 'evidence', getter);
    expect(() => f.release(facts)).toThrow(); expect(() => captureRechargeRefundReleaseFacts(env, scope, h, f.facts())).toThrow();
    expect(() => parse(f, row)).toThrow(); expect(invoked).toBe(0);
  });
  it('enforces finite JSON directly at the parse boundary', () => {
    const f = rechargeLocalReleasePureFixture(), fractional = sourceClone(f.facts()), oversized = sourceClone(f.facts());
    fractional.bill.id = 93.5; oversized.bill.mark = 'x'.repeat(16385);
    expect(() => f.release(fractional)).toThrow(); expect(() => f.release(oversized)).toThrow();
  });
});
