import { expect, it } from 'vitest';
import { readRefundEarnedIncomeScope, refundEarnedIncomeCompensation } from '../src/services/order/RefundEarnedIncome';
import { targetLineCompensation, type RefundLineCompensation } from '../src/services/order/OrderSplitFinance';

const scope = () => ({ version: 'refund-earned-income-v1', refundId: 10, orderId: 8, uid: 11,
  productIntegral: 200, payment: 5500, brokerage: { self_brokerage: 360, one_brokerage: 360,
    two_brokerage: 180, staff_brokerage: 90, agent_brokerage: 60, division_brokerage: 30 } });
const plan = (): RefundLineCompensation => ({ usedIntegral: 20, payIntegral: 7,
  returnedPointBillIds: [11, 12], materializedRefundIds: [10],
  productIntegral: { total: 100, refunded: 100 }, payment: { total: 4220, refunded: 1280 },
  brokerage: { self_brokerage: { total: 330, refunded: 30 }, one_brokerage: { total: 330, refunded: 30 },
    two_brokerage: { total: 165, refunded: 15 }, staff_brokerage: { total: 82, refunded: 7 },
    agent_brokerage: { total: 55, refunded: 5 }, division_brokerage: { total: 27, refunded: 2 } } });

it('rebases each earned-income type independently without changing current spent-point/cash evidence', () => {
  const input = plan(), before = structuredClone(input), owner = readRefundEarnedIncomeScope(scope())!;
  const earned = refundEarnedIncomeCompensation(input, owner);
  expect(earned).toEqual({ orderId: 8, productIntegral: { total: 200, refunded: 200 }, payment: { total: 5500, refunded: 2560 },
    brokerage: { self_brokerage: { total: 360, refunded: 60 }, one_brokerage: { total: 360, refunded: 60 },
      two_brokerage: { total: 180, refunded: 30 }, staff_brokerage: { total: 90, refunded: 15 },
      agent_brokerage: { total: 60, refunded: 10 }, division_brokerage: { total: 30, refunded: 5 } } });
  expect(targetLineCompensation(165, earned.payment)).toBe(76);
  expect(targetLineCompensation(180, earned.brokerage.one_brokerage)).toBe(30);
  expect(input).toEqual(before);
});

it('returns every credited residual unit at full allocation, regardless of today\'s reward rates', () => {
  const input = plan();
  const full = { ...input, payment: { total: 2940, refunded: 2940 }, productIntegral: { total: 0, refunded: 0 },
    brokerage: Object.fromEntries(Object.entries(input.brokerage).map(([type, basis]) => [type, { ...basis, refunded: basis.total }])) };
  const earned = refundEarnedIncomeCompensation(full, readRefundEarnedIncomeScope(scope())!);
  for (const basis of [earned.payment, earned.productIntegral, ...Object.values(earned.brokerage)]) {
    expect(targetLineCompensation(17, basis)).toBe(17);
  }
});

it('keeps a pending-income scope explicitly null', () => { expect(readRefundEarnedIncomeScope(null)).toBeNull(); });

it.each(['version', 'id-zero', 'uid-string', 'fraction', 'overflow', 'missing', 'extra', 'array', 'alias-mismatch', 'missing-type'])
  ('rejects malformed income scope %s', kind => {
  const input: Record<string, unknown> = scope();
  if (kind === 'version') input.version = 'v2';
  if (kind === 'id-zero') input.orderId = 0;
  if (kind === 'uid-string') input.uid = '11';
  if (kind === 'fraction') input.productIntegral = 0.5;
  if (kind === 'overflow') input.payment = Number.MAX_SAFE_INTEGER;
  if (kind === 'missing') delete input.refundId;
  if (kind === 'extra') input.unproven = true;
  if (kind === 'alias-mismatch') input.brokerage = { ...scope().brokerage, self_brokerage: 9 };
  if (kind === 'missing-type') { const { staff_brokerage: omitted, ...other } = scope().brokerage; expect(omitted).toBe(90); input.brokerage = other; }
  expect(() => readRefundEarnedIncomeScope(kind === 'array' ? [input] : input)).toThrow('证据');
});

it.each([{ total: 5501, refunded: 1 }, { total: 10, refunded: 11 }, { total: 10.1, refunded: 1 }, { total: 10, refunded: -1 }])
  ('rejects invalid current-generation basis %j', payment => {
  expect(() => refundEarnedIncomeCompensation({ ...plan(), payment }, readRefundEarnedIncomeScope(scope())!)).toThrow('证据');
});
