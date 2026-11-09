import { describe, expect, it } from 'vitest';
import { captureRechargeRefundBasis, rechargeRefundAmounts, rechargeRefundCents,
  rechargeRefundDecimal, rechargeRefundIntent, type RechargeRefundBasis } from '@/services/payment/RechargeRefundMoney';
import { captureRechargeRefundRequest, rechargeRefundIdentity, RECHARGE_REFUND_VERSION } from '@/services/payment/RechargeRefundRequest';

const basis = () => ({ id: 11, uid: 22, orderId: 'czRefundOriginal', price: '100.00', givePrice: '20.00',
  refundPrice: '0.00', paid: 1, nowMoney: '125.35', rechargeType: 'weixin' });
const request = () => ({ version: RECHARGE_REFUND_VERSION, rechargeId: 11,
  quoteFingerprint: 'a7'.repeat(32), recoverGift: true });
const key = '506cad85-26d2-42e2-9c49-e900643dc4ee';
const blockedBases: Array<[Partial<RechargeRefundBasis>, string]> = [
  [{ paid: 0 }, '未支付'], [{ rechargeType: 'balance' }, '佣金'],
  [{ refundPrice: '100.00' }, '已全部退款'], [{ refundPrice: '1.00' }, '历史部分退款'],
  [{ refundPrice: '100.01' }, '金额异常'], [{ price: '0.00' }, '金额异常'],
];

describe('recharge full-principal refund money contract', () => {
  it('preserves an insufficient rejection without inventing a zero or negative debit', () => {
    expect(rechargeRefundIntent({ ...basis(), nowMoney: '110.00' }, true)).toMatchObject({
      sufficient: false, walletDebitCents: 12000, walletBeforeCents: 11000, walletAfterCents: 11000,
    });
    expect(rechargeRefundIntent({ ...basis(), nowMoney: '110.00' }, false)).toMatchObject({
      sufficient: true, walletDebitCents: 10000, walletAfterCents: 1000,
    });
  });
  it('retains an exact oversized requested debit only as an insufficient rejection', () => {
    expect(rechargeRefundIntent({ ...basis(), price: '9999999999.99', givePrice: '9999999999.99', nowMoney: '9999999999.99' }, true))
      .toMatchObject({ sufficient: false, walletDebitCents: 1999999999998, walletAfterCents: 999999999999 });
    expect(() => rechargeRefundAmounts({ ...basis(), price: '9999999999.99', givePrice: '9999999999.99', nowMoney: '9999999999.99' }, true)).toThrow('余额不足');
  });
  it('refunds principal to the provider while recovering principal and gift from the wallet', () => {
    expect(rechargeRefundAmounts(basis(), true)).toMatchObject({ providerRefund: '100.00', walletDebit: '120.00',
      walletBefore: '125.35', walletAfter: '5.35', principalCents: 10_000, giftCents: 2_000 });
  });
  it('keeps the original gift when the operator does not select gift recovery', () => {
    expect(rechargeRefundAmounts(basis(), false)).toMatchObject({ providerRefund: '100.00', walletDebit: '100.00', walletAfter: '25.35' });
  });
  it('allows an exact available balance and reserves it down to zero', () => {
    expect(rechargeRefundAmounts({ ...basis(), nowMoney: '120.00' }, true).walletAfter).toBe('0.00');
  });
  it.each(['119.99', '60.00', '0.00', '-0.01'])('rejects insufficient balance %s rather than clamping or allowing debt', nowMoney => {
    expect(() => rechargeRefundAmounts({ ...basis(), nowMoney }, true)).toThrow('钱包余额不足');
  });
  it('checks the selected debit rather than rejecting principal-only recovery for an unneeded gift', () => {
    expect(rechargeRefundAmounts({ ...basis(), nowMoney: '100.00' }, false).walletAfter).toBe('0.00');
  });
  it('handles a recharge with no gift through the same contract', () => {
    expect(rechargeRefundAmounts({ ...basis(), givePrice: '0.00' }, true).walletDebit).toBe('100.00');
  });
  it.each(blockedBases)('does not authorize an unpaid, transferred, completed or ambiguous historical basis %#', (patch, message) => {
    expect(() => rechargeRefundAmounts({ ...basis(), ...patch }, true)).toThrow(message);
  });
  it('does not reinterpret the PHP mode flag as an arbitrary partial amount', () => {
    expect(() => rechargeRefundAmounts(basis(), 1)).toThrow('选项');
    expect(() => rechargeRefundAmounts(basis(), '100.00')).toThrow('选项');
  });
  it.each(['1e2', '01.00', '1.0', '1.000', '+1.00', '-0.00', ' 1.00', '1.00\n', '10000000000.00', 'NaN'])('rejects noncanonical money %j', value => {
    expect(() => rechargeRefundCents(value)).toThrow();
  });
  it('round-trips the complete numeric(12,2) limit without floating-point rounding', () => {
    const cents = rechargeRefundCents('9999999999.99');
    expect(cents).toBe(999_999_999_999);
    expect(rechargeRefundDecimal(cents)).toBe('9999999999.99');
    expect(rechargeRefundDecimal(rechargeRefundCents('-9999999999.99', true))).toBe('-9999999999.99');
  });
  it('copies the basis and rejects getters, inherited fields and trailing newline identities', () => {
    const source = basis(), captured = captureRechargeRefundBasis(source);
    source.price = '1.00'; expect(captured.price).toBe('100.00'); expect(Object.isFrozen(captured)).toBe(true);
    let read = false;
    expect(() => captureRechargeRefundBasis({ ...basis(), get price() { read = true; return '100.00'; } })).toThrow();
    expect(read).toBe(false);
    const inherited = Object.assign(Object.create({ id: 11 }), basis()); delete inherited.id;
    expect(() => captureRechargeRefundBasis(inherited)).toThrow();
    expect(() => captureRechargeRefundBasis({ ...basis(), orderId: 'czOriginal\n' })).toThrow();
  });
});

describe('recharge refund operation identity', () => {
  it('binds the stable authenticated admin, selected recharge, quote and gift decision', async () => {
    const original = await rechargeRefundIdentity(3, key, request());
    expect(original).toMatchObject({ adminId: 3, requestKey: key, request: request() });
    for (const [adminId, value] of [[4, request()], [3, { ...request(), rechargeId: 12 }],
      [3, { ...request(), recoverGift: false }], [3, { ...request(), quoteFingerprint: 'b8'.repeat(32) }]] as const) {
      expect((await rechargeRefundIdentity(adminId, key, value)).requestHash).not.toBe(original.requestHash);
    }
  });
  it('captures the request before the asynchronous request hash can observe caller mutation', async () => {
    const value = request(), pending = rechargeRefundIdentity(3, key, value); value.rechargeId = 99;
    expect((await pending).request.rechargeId).toBe(11);
    expect(Object.isFrozen((await pending).request)).toBe(true);
  });
  it.each(['refundId', 'storeOrderId', 'amount', 'uid', 'adminId', 'appId'])('does not accept client authority through %s', field => {
    expect(() => captureRechargeRefundRequest({ ...request(), [field]: 12 })).toThrow('字段');
  });
  it('rejects legacy mode/amount aliases, stale versions and malformed quote hashes', () => {
    expect(() => captureRechargeRefundRequest({ ...request(), refund_price: 1 })).toThrow();
    expect(() => captureRechargeRefundRequest({ ...request(), version: 'admin-refund-operation-v1' })).toThrow();
    expect(() => captureRechargeRefundRequest({ ...request(), quoteFingerprint: request().quoteFingerprint + '\n' })).toThrow();
  });
});
