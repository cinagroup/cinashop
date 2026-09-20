import type { storeOrder } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import type { RefundCompensationBasis, RefundLineCompensation } from './OrderSplitFinance';

const fields = {
  self_brokerage: 'oneBrokerage', one_brokerage: 'oneBrokerage', two_brokerage: 'twoBrokerage',
  staff_brokerage: 'divisionStaffBrokerage', agent_brokerage: 'divisionAgentBrokerage', division_brokerage: 'divisionBrokerage',
} as const;
type IncomeType = keyof typeof fields;
export interface RefundEarnedIncomeScope {
  readonly version: 'refund-earned-income-v1';
  readonly refundId: number;
  readonly orderId: number;
  readonly uid: number;
  readonly productIntegral: number;
  readonly payment: number;
  readonly brokerage: Readonly<Record<IncomeType, number>>;
}
export interface RefundEarnedIncomeCompensation {
  readonly orderId: number;
  readonly productIntegral: RefundCompensationBasis;
  readonly payment: RefundCompensationBasis;
  readonly brokerage: Readonly<Record<string, RefundCompensationBasis>>;
}
const invalid = () => new ValidateException('退款原入账归属证据不一致，请先核对订单');
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) throw invalid();
  return record;
}
function units(value: unknown, id = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (id ? 1 : 0)
    || value > (id ? 2147483647 : 999999999999)) throw invalid();
  return value;
}
function amount(value: string, points = false): number {
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value)) throw invalid();
  const [whole, fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (points && cents % 100) throw invalid();
  return units(points ? cents / 100 : cents);
}

/** Compact immutable evidence, never a new grant or a reassignment of a bill.
 * Null explicitly means the source had not received its income at this split. */
export function readRefundEarnedIncomeScope(value: unknown): RefundEarnedIncomeScope | null {
  if (value === null) return null;
  const record = object(value, ['version', 'refundId', 'orderId', 'uid', 'productIntegral', 'payment', 'brokerage']);
  if (record.version !== 'refund-earned-income-v1') throw invalid();
  const input = object(record.brokerage, Object.keys(fields));
  const brokerage = Object.fromEntries(Object.keys(fields).map(type => [type, units(input[type])])) as Record<IncomeType, number>;
  if (brokerage.self_brokerage !== brokerage.one_brokerage) throw invalid();
  return { version: record.version, refundId: units(record.refundId, true), orderId: units(record.orderId, true),
    uid: units(record.uid, true), productIntegral: units(record.productIntegral), payment: units(record.payment), brokerage };
}

/** Freeze the first received source BEFORE shrinking its totals. A child can
 * be the income owner even though its provider payment belongs to the root. */
export function captureRefundEarnedIncomeScope(order: typeof storeOrder.$inferSelect, refundId: number,
  previous: RefundEarnedIncomeScope | null): RefundEarnedIncomeScope | null {
  if (previous) {
    if (previous.uid !== order.uid || ![2, 3].includes(order.status)) throw invalid();
    if (amount(order.gainIntegral, true) > previous.productIntegral || amount(order.payPrice) > previous.payment
      || Object.entries(fields).some(([type, field]) => amount(order[field]) > previous.brokerage[type as IncomeType])) throw invalid();
    return previous;
  }
  if ([0, 1].includes(order.status)) return null;
  if (![2, 3].includes(order.status)) throw invalid();
  return readRefundEarnedIncomeScope({ version: 'refund-earned-income-v1', refundId, orderId: order.id, uid: order.uid,
    productIntegral: amount(order.gainIntegral, true), payment: amount(order.payPrice),
    brokerage: Object.fromEntries(Object.entries(fields).map(([type, field]) => [type, amount(order[field])])) });
}

/** Only earned-income fractions are rebased. Spent/returned points and cash
 * remain current-generation amounts. Prior allocations include concessions,
 * not merely cash paid; the final fraction includes every rounding residue. */
export function refundEarnedIncomeCompensation(plan: RefundLineCompensation, scope: RefundEarnedIncomeScope): RefundEarnedIncomeCompensation {
  const rebase = (original: number, current: RefundCompensationBasis | undefined): RefundCompensationBasis => {
    units(original);
    if (!current || units(current.total) > original || units(current.refunded) > current.total) throw invalid();
    return { total: original, refunded: original - current.total + current.refunded };
  };
  const brokerage = Object.fromEntries(Object.keys(fields).map(type =>
    [type, rebase(scope.brokerage[type as IncomeType], plan.brokerage[type])])) as Record<IncomeType, RefundCompensationBasis>;
  return { orderId: scope.orderId, productIntegral: rebase(scope.productIntegral, plan.productIntegral),
    payment: rebase(scope.payment, plan.payment), brokerage };
}
