import { describe, expect, it } from 'vitest';
import { MEMBER_SAVINGS_VERSION, orderMembershipSavings } from '../src/services/order/OrderMembershipSavings';
import { partitionRefundCartSnapshot, REFUND_SPLIT_LINE_FIELDS } from '../src/services/order/RefundSplitAllocation';

const order = { id: 7, uid: 11, totalNum: 2 };
const info = () => ({ ...Object.fromEntries(REFUND_SPLIT_LINE_FIELDS.map(key => [key, '0.00'])),
  financial_version: 'checkout-line-finance-v1', member_savings_version: MEMBER_SAVINGS_VERSION,
  id: '1', cart_num: 2, paid_member: 1, price_type: 'member', vip_truePrice: '0.10',
  raw_postage_price: '0.02', postage_price: '0.01', member_postage_price: '0.01', member_coupon_price: '0.00' });
const row = (overrides: Record<string, unknown> = {}) => ({ oid: 7, uid: 11, cartId: '1', cartNum: 2,
  cartInfo: JSON.stringify({ ...info(), ...overrides }) });
describe('bounded membership savings evidence and quantity partitioning', () => {
  it('keeps the final freight cent on the branch that actually received that member saving', () => {
    const parts = partitionRefundCartSnapshot(row().cartInfo, 2, 1, false);
    expect(orderMembershipSavings({ ...order, totalNum: 1 }, [{ ...row(), cartNum: 1, cartInfo: parts.selected }]))
      .toMatchObject({ memberPrice: '0.10', postagePrice: '0.01' });
    expect(orderMembershipSavings({ ...order, totalNum: 1 }, [{ ...row(), cartNum: 1, cartInfo: parts.remaining }]))
      .toMatchObject({ memberPrice: '0.10', postagePrice: '0.00' });
  });
  it('does not infer an old order benefit from a retail price or previous unversioned VIP fields', () => {
    expect(orderMembershipSavings(order, [{ ...row(), cartInfo: JSON.stringify({ vip_truePrice: '99.00', price_type: 'member' }) }])).toBeNull();
  });
  it('conserves small-cent freight savings across every partial quantity split', () => {
    const decimal = (cents: number) => (cents / 100).toFixed(2);
    for (let quantity = 2; quantity <= 9; quantity++) for (let raw = 1; raw <= 9; raw++)
      for (let charged = 0; charged < raw; charged++) for (let selected = 1; selected < quantity; selected++) {
        const source = row({ cart_num: quantity, raw_postage_price: decimal(raw), postage_price: decimal(charged),
          member_postage_price: decimal(raw - charged) });
        const parts = partitionRefundCartSnapshot(source.cartInfo, quantity, selected, false);
        const values = [[selected, parts.selected], [quantity - selected, parts.remaining]] as const;
        const savings = values.map(([cartNum, cartInfo]) => orderMembershipSavings({ ...order, totalNum: cartNum },
          [{ ...source, cartNum, cartInfo }])!);
        expect(Math.round(Number(savings[0].postagePrice) * 100) + Math.round(Number(savings[1].postagePrice) * 100)).toBe(raw - charged);
      }
  });
  it.each([undefined, null, true, {}, '-0.01', 'NaN', '1e3', '0.001', '10000000000.00'])('rejects invalid unit money %s', value => {
    expect(() => orderMembershipSavings(order, [row({ vip_truePrice: value })])).toThrow('会员');
  });
  it.each([
    { paid_member: false }, { paid_member: 2 }, { paid_member: 0 }, { price_type: 'activity' },
    { price_type: '' }, { member_savings_version: 'future' }, { id: 'another' }, { cart_num: 1 },
    { member_postage_price: '0.02' }, { member_coupon_price: '0.01' },
    { raw_postage_price: '0.03' }, { coupon_price: '0.02', member_coupon_price: '0.01' },
    { price_type: [] }, { price_type: ['member'] }, { financial_version: ['checkout-line-finance-v1'] },
  ])('rejects inconsistent membership metadata %j', changes => {
    expect(() => orderMembershipSavings(order, [row(changes)])).toThrow('会员');
  });
  it.each([{ uid: 22 }, { oid: 8 }, { cartNum: 0 }, { cartNum: 1.5 }])('rejects inconsistent SQL identity or quantity %j', changes => {
    expect(() => orderMembershipSavings(order, [{ ...row(), ...changes }])).toThrow('会员');
  });
  it('rejects partial-version downgrade, duplicate rows and aggregate quantity mismatch', () => {
    const legacy = { ...row(), cartId: '2', cartInfo: '{}' };
    expect(() => orderMembershipSavings({ ...order, totalNum: 4 }, [row(), legacy])).toThrow('会员');
    expect(() => orderMembershipSavings({ ...order, totalNum: 4 }, [row(), row()])).toThrow('会员');
    expect(() => orderMembershipSavings({ ...order, totalNum: 1 }, [row()])).toThrow('会员');
  });
  it('requires every new line to agree on paid membership eligibility', () => {
    const noMember = { ...row({ id: '2', paid_member: 0, price_type: 'level', member_postage_price: '0.00' }), cartId: '2' };
    expect(() => orderMembershipSavings({ ...order, totalNum: 4 }, [row(), noMember])).toThrow('会员');
  });
  it('bounds rows, snapshot bytes and final decimal totals', () => {
    expect(() => orderMembershipSavings(order, Array.from({ length: 201 }, () => row()))).toThrow('会员');
    expect(() => orderMembershipSavings(order, [row({ extra: 'x'.repeat(65536) })])).toThrow('会员');
    expect(() => orderMembershipSavings(order, [row({ vip_truePrice: '9999999999.99' })])).toThrow('会员');
    expect(() => orderMembershipSavings({ ...order, totalNum: 280 }, Array.from({ length: 140 }, (_, index) => ({
      ...row({ id: String(index), extra: 'x'.repeat(60_000) }), cartId: String(index),
    })))).toThrow('会员');
  });
});
