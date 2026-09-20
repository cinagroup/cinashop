import type { storeOrder, storeOrderCartInfo, storeOrderRefund } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { allocateRefundLineTotal, allocateRefundSplitPayment, partitionRefundCartSnapshot, partitionRefundWriteoff,
  REFUND_SPLIT_LINE_FIELDS, type RefundWriteoffState } from './RefundSplitAllocation';
import { readRefundQuantityReservation } from './RefundQuantityReservation';
import type { RefundEarnedIncomeCompensation } from './RefundEarnedIncome';
import { readRefundGenerationMarker } from './RefundGenerationMarker';
import { orderMembershipSavings } from './OrderMembershipSavings';

type Order = typeof storeOrder.$inferSelect;
type Cart = typeof storeOrderCartInfo.$inferSelect;
const mapped = {
  couponPrice: 'coupon_price', deductionPrice: 'integral_price', firstOrderPrice: 'first_order_price',
  payPostage: 'postage_price', totalPostage: 'raw_postage_price', oneBrokerage: 'one_brokerage', twoBrokerage: 'two_brokerage',
  divisionStaffBrokerage: 'division_staff_brokerage', divisionAgentBrokerage: 'division_agent_brokerage', divisionBrokerage: 'division_brokerage',
} as const;
type Monetary = keyof typeof mapped | 'totalPrice' | 'payPrice' | 'cost' | 'promotionsPrice' | 'useIntegral' | 'gainIntegral';
type Amounts = Record<Monetary, bigint> & { totalNum: bigint; payIntegral: bigint };
interface Line { source: Cart; info: Record<string, unknown> }
export interface FinancialCartPartition {
  selected: string | null;
  remaining: string | null;
  selectedWriteoff: RefundWriteoffState | null;
  remainingWriteoff: RefundWriteoffState | null;
}
const invalid = () => new ValidateException('拆单财务快照不一致，请先核对订单');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function parse(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  if (new TextEncoder().encode(value).length > 65536) throw invalid();
  try { return object(JSON.parse(value)); } catch { throw invalid(); }
}
function money(value: unknown, signed = false): bigint {
  if (typeof value !== 'number' && typeof value !== 'string') throw invalid();
  const text = String(value), negative = signed && text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(unsigned)) throw invalid();
  const [whole, fraction = ''] = unsigned.split('.');
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -result : result;
}
function points(value: unknown): bigint {
  const valueCents = money(value);
  if (valueCents % 100n) throw invalid();
  return valueCents / 100n;
}
function integer(value: number, zero = false): bigint {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > 2147483647) throw invalid();
  return BigInt(value);
}
function decimal(value: bigint): string {
  const sign = value < 0n ? '-' : '', absolute = value < 0n ? -value : value;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
function readLine(source: Cart, info: Record<string, unknown>): Line {
  if (!['checkout-line-finance-v1', 'refund-order-line-finance-v1'].includes(String(info.financial_version)) || info.id !== source.cartId
    || (info.cart_num !== source.cartNum && info.cart_num !== String(source.cartNum))
    || ![0, 1].includes(source.isGift)) throw invalid();
  if (info.financial_version === 'refund-order-line-finance-v1') {
    readRefundGenerationMarker(info.refund_order_generation);
  }
  integer(source.cartNum);
  for (const field of [...REFUND_SPLIT_LINE_FIELDS, 'raw_postage_price', 'sum_price', 'costPrice', 'promotions_true_price']) money(info[field]);
  points(info.use_integral); integer(Number(points(info.integral)), true);
  const unitWriteTimes = Number(points(object(info.sku).write_times)); integer(unitWriteTimes);
  // A fractional per-unit gift grant must be rounded once at its original line,
  // not once per future child. Persist the remaining integer grant on partition.
  const gain = info.gain_integral === undefined
    ? money(object(info.product).giveIntegral) * BigInt(source.cartNum) / 100n : points(info.gain_integral);
  const enriched: Record<string, unknown> = { ...info, gain_integral: String(gain) };
  if (source.isGift === 1 && [...REFUND_SPLIT_LINE_FIELDS, 'raw_postage_price', 'gain_integral']
    .some(field => money(enriched[field]) !== 0n)) throw invalid();
  return { source, info: enriched };
}
function aggregate(lines: Line[]): Amounts {
  const result: Amounts = { couponPrice: 0n, deductionPrice: 0n, firstOrderPrice: 0n, payPostage: 0n, totalPostage: 0n,
    oneBrokerage: 0n, twoBrokerage: 0n, divisionStaffBrokerage: 0n, divisionAgentBrokerage: 0n, divisionBrokerage: 0n,
    totalPrice: 0n, payPrice: 0n, cost: 0n, promotionsPrice: 0n, useIntegral: 0n, gainIntegral: 0n, totalNum: 0n, payIntegral: 0n };
  for (const { source, info } of lines) {
    const quantity = integer(source.cartNum); result.totalNum += quantity;
    if (source.isGift) continue;
    for (const key of Object.keys(mapped) as (keyof typeof mapped)[]) result[key] += money(info[mapped[key]]);
    result.totalPrice += money(info.sum_price) * quantity;
    result.cost += money(info.costPrice) * quantity;
    result.payPrice += money(info.sum_true_price) + money(info.postage_price);
    result.promotionsPrice += money(info.promotions_true_price) * quantity;
    result.payIntegral += integer(Number(info.integral), true) * quantity;
    result.useIntegral += points(info.use_integral) * 100n;
    result.gainIntegral += points(info.gain_integral) * 100n;
  }
  if (result.totalNum > 2147483647n || result.payIntegral > 2147483647n) throw invalid();
  for (const value of Object.values(result)) if (value > 999999999999n) throw invalid();
  return result;
}
function persisted(amounts: Amounts): Partial<typeof storeOrder.$inferInsert> {
  const result: Partial<typeof storeOrder.$inferInsert> = {};
  for (const key of Object.keys(amounts) as (keyof Amounts)[]) {
    if (key === 'totalNum' || key === 'payIntegral') result[key] = Number(amounts[key]);
    else result[key] = decimal(amounts[key]);
  }
  return result;
}

/** Financial evidence only. Fulfillment and refund quotation separately check
 * their lifecycle/claims: a valid financial snapshot is never authorization. */
function checkedOrderLines(order: Order, rows: Cart[]): Line[] | null {
  if (!rows.length || rows.length > 200) throw invalid();
  const parsed = rows.map(row => parse(row.cartInfo));
  if (parsed.every(info => !info || !['financial_version', 'raw_postage_price', 'gain_integral'].some(key => Object.hasOwn(info, key)))) return null;
  if (rows.some(row => row.oid !== order.id || row.uid !== order.uid)) throw invalid();
  const ids = new Set(rows.map(row => row.cartId));
  if (ids.size !== rows.length) throw invalid();
  const originals = rows.map((row, index) => readLine(row, object(parsed[index])));
  orderMembershipSavings(order, rows);
  const original = aggregate(originals);
  for (const key of Object.keys(original) as (keyof Amounts)[]) {
    if (key === 'payPrice') continue;
    const stored = key === 'totalNum' || key === 'payIntegral' ? integer(order[key], key === 'payIntegral') : money(order[key]);
    if (stored !== original[key]) throw invalid();
  }
  if (money(order.payPrice) + money(order.changePrice, true) !== original.payPrice) throw invalid();
  return originals;
}

/** A checked plan, not authorization to deliver/refund. Null means entirely
 * unversioned legacy evidence: never silently downgrade mixed/invalid v1 rows.
 * Caller holds the order and all cart locks, supplies every active cart, and
 * assigns each new row identity after planning. No database or provider I/O. */
export function planOrderFinancialSplit(order: Order, rows: Cart[], selections: ReadonlyMap<string, number>): {
  selected: Partial<typeof storeOrder.$inferInsert>;
  remaining: Partial<typeof storeOrder.$inferInsert>;
  carts: Map<string, FinancialCartPartition>;
} | null {
  const originals = checkedOrderLines(order, rows);
  if (!originals) return null;
  if (selections.size === 0 || selections.size > 200
    || rows.some(row => row.splitSurplusNum !== row.cartNum || row.splitStatus >= 2 || row.refundNum !== 0)
    || money(order.refundPrice) !== 0n || points(order.backIntegral) !== 0n) throw invalid();
  const ids = new Set(rows.map(row => row.cartId));
  for (const [id, quantity] of selections) { integer(quantity); if (!ids.has(id)) throw invalid(); }
  const original = aggregate(originals);
  const selectedLines: Line[] = [], remainingLines: Line[] = [];
  const carts = new Map<string, FinancialCartPartition>();
  for (const { source, info } of originals) {
    const quantity = selections.get(source.cartId) ?? 0;
    const parts = partitionRefundCartSnapshot(JSON.stringify(info), source.cartNum, quantity, source.isGift === 1);
    if (parts.missingFields.length) throw invalid();
    const writeoff = partitionRefundWriteoff(source, quantity, Number(object(info.sku).write_times));
    carts.set(source.cartId, { selected: parts.selected, remaining: parts.remaining,
      selectedWriteoff: writeoff.selected, remainingWriteoff: writeoff.remaining });
    if (parts.selected) selectedLines.push({ source: { ...source, cartNum: quantity }, info: object(parse(parts.selected)) });
    if (parts.remaining) remainingLines.push({ source: { ...source, cartNum: source.cartNum - quantity }, info: object(parse(parts.remaining)) });
  }
  const selected = aggregate(selectedLines), remaining = aggregate(remainingLines);
  for (const key of Object.keys(original) as (keyof Amounts)[]) if (selected[key] + remaining[key] !== original[key]) throw invalid();
  const payment = remaining.totalNum === 0n ? { selected: order.payPrice, remaining: '0.00' }
    : allocateRefundSplitPayment(order.payPrice, decimal(original.payPrice), decimal(selected.payPrice));
  const whole = remaining.totalNum === 0n;
  return {
    selected: { ...persisted(selected), payPrice: payment.selected, changePrice: decimal(selected.payPrice - money(payment.selected)),
      giveIntegral: whole ? order.giveIntegral : 0, giveCoupon: whole ? order.giveCoupon : null, promotionsGive: whole ? order.promotionsGive : null },
    remaining: { ...persisted(remaining), payPrice: payment.remaining, changePrice: decimal(remaining.payPrice - money(payment.remaining)),
      giveIntegral: whole ? 0 : order.giveIntegral, giveCoupon: whole ? null : order.giveCoupon, promotionsGive: whole ? null : order.promotionsGive },
    carts,
  };
}

/** Quote the same line partition as physical splitting, without materializing
 * children. Completed, strictly validated quantity claims are replayed in
 * application order so each remaining line/payment retains its own rounding
 * residue. Cash concessions consume the goods allocation, not only cash paid:
 * another item's quote must not inherit the concession difference.
 * Caller supplies locked order/cart evidence and no open refund. No SQL/I/O. */
export function quoteOrderRefundLineFinance(
  order: Order, rows: Cart[], completed: Array<typeof storeOrderRefund.$inferSelect>,
  selections: ReadonlyMap<string, number>,
): string | null {
  const originals = checkedOrderLines(order, rows);
  if (!originals) return null;
  if (completed.length > 200 || order.pid === -1) throw invalid();
  const byId = new Map(rows.map(row => [row.cartId, row]));
  const consumed = new Map<string, number>();
  // Keep only the two cash components for history replay. Do not repeatedly
  // parse/copy up to 200 full product snapshots for every completed claim.
  const cash = new Map(originals.map(({ source, info }) => {
    partitionRefundWriteoff(source, 0, Number(object(info.sku).write_times));
    return [source.cartId, { quantity: source.cartNum, net: decimal(money(info.sum_true_price)), postage: decimal(money(info.postage_price)) }];
  }));
  let remainingPayment = money(order.payPrice), refundedPayment = 0n;
  const take = (selected: ReadonlyMap<string, number>): bigint => {
    if (!selected.size || selected.size > 200) throw invalid();
    const raw = [...cash.values()].reduce((sum, line) => sum + money(line.net) + money(line.postage), 0n);
    let selectedRaw = 0n;
    for (const [id, quantity] of selected) {
      integer(quantity);
      const line = cash.get(id);
      if (!line || quantity > line.quantity) throw invalid();
      const net = allocateRefundLineTotal(line.net, line.quantity, quantity);
      const postage = allocateRefundLineTotal(line.postage, line.quantity, quantity);
      selectedRaw += money(net.selected) + money(postage.selected);
      if (quantity === line.quantity) cash.delete(id);
      else cash.set(id, { quantity: line.quantity - quantity, net: net.remaining, postage: postage.remaining });
    }
    const allocated = cash.size === 0 ? remainingPayment
      : money(allocateRefundSplitPayment(decimal(remainingPayment), decimal(raw), decimal(selectedRaw)).selected);
    remainingPayment -= allocated;
    return allocated;
  };
  const history = [...completed].sort((a, b) => a.id - b.id);
  let previousId = 0;
  for (const refund of history) {
    integer(refund.id);
    if (refund.id <= previousId || refund.storeOrderId !== order.id || refund.uid !== order.uid
      || refund.supplierId !== order.supplierId || refund.storeId !== order.storeId
      || refund.refundType !== 6 || refund.isCancel || refund.isDel) throw invalid();
    previousId = refund.id;
    const claim = readRefundQuantityReservation(refund);
    if (!claim) throw invalid();
    const selected = new Map<string, number>();
    for (const item of claim.items) {
      const id = String(item.cartId), row = byId.get(id), prior = consumed.get(id) ?? 0;
      if (!row || item.rowId !== row.id || item.totalNum !== row.cartNum || item.beforeRefundNum !== prior) throw invalid();
      selected.set(id, item.cartNum); consumed.set(id, prior + item.cartNum);
    }
    const allocated = take(selected), paid = money(refund.refundedPrice);
    if (paid !== money(refund.refundPrice) || paid > allocated || (refund.applyType !== 4 && paid !== allocated)) throw invalid();
    refundedPayment += paid;
  }
  if (money(order.refundPrice) !== refundedPayment
    || rows.some(row => row.refundNum !== (consumed.get(row.cartId) ?? 0))) throw invalid();
  points(order.backIntegral); // Returned points are compensation state, not cash allocation.
  return decimal(take(selections));
}

export interface RefundCompensationBasis { readonly total: number; readonly refunded: number }
export interface RefundLineCompensation {
  readonly earnedIncome?: RefundEarnedIncomeCompensation;
  /** Actual supplier entitlement on completed goods, independently of customer
   * cash concessions. Missing only for platform-owned/legacy evidence. */
  readonly supplierSettlement?: RefundCompensationBasis & { readonly fullyRefunded: boolean };
  /** Exact prior-generation bill identities, supplied only by the locked SQL
   * generation resolver. They are excluded from this generation's delta. */
  readonly returnedPointBillIds?: readonly number[];
  readonly materializedRefundIds?: readonly number[];
  readonly usedIntegral: number;
  readonly payIntegral: number;
  readonly productIntegral: RefundCompensationBasis;
  readonly payment: RefundCompensationBasis;
  readonly brokerage: Readonly<Record<string, RefundCompensationBasis>>;
}
const compensationFields = ['use_integral', 'gain_integral', 'one_brokerage', 'two_brokerage',
  'division_staff_brokerage', 'division_agent_brokerage', 'division_brokerage', 'sum_true_price', 'postage_price'] as const;
type CompensationField = typeof compensationFields[number];

/** Apply an immutable line-allocation fraction to the income actually credited.
 * Do not reprice earned income from today's settings. Zero original evidence
 * cannot explain a positive income; full allocation retains the exact residue. */
export function targetLineCompensation(income: number, basis: RefundCompensationBasis | undefined): number {
  if (!basis || [income, basis.total, basis.refunded].some(n => !Number.isSafeInteger(n) || n < 0)
    || basis.refunded > basis.total || (income > 0 && basis.total === 0)) throw invalid();
  if (income === 0 || basis.refunded === 0) return 0;
  return Number(BigInt(income) * BigInt(basis.refunded) / BigInt(basis.total));
}

/** Compensation for completed claims, before physical child materialization.
 * Keeps original ledger/operation/payment identities and replays only compact
 * immutable line totals. Additional held quantities may belong to an open
 * application at receipt; they must never increase completed compensation. */
export function planCompletedRefundLineCompensation(
  order: Order, rows: Cart[], completed: Array<typeof storeOrderRefund.$inferSelect>,
): RefundLineCompensation | null {
  const originals = checkedOrderLines(order, rows);
  if (!originals) return null;
  if (completed.length > 201 || order.pid === -1) throw invalid();
  const byId = new Map(rows.map(row => [row.cartId, row]));
  const consumed = new Map<string, number>();
  const accumulated = Object.fromEntries(compensationFields.map(field => [field, 0n])) as Record<CompensationField, bigint>;
  const lines = new Map(originals.map(({ source, info }) => {
    partitionRefundWriteoff(source, 0, Number(object(info.sku).write_times));
    const totals = Object.fromEntries(compensationFields.map(field => [field, String(info[field])])) as Record<CompensationField, string>;
    return [source.cartId, { quantity: source.cartNum, integral: Number(points(info.integral)), totals }];
  }));
  let remainingPayment = money(order.payPrice), refundedPayment = 0n, paidIntegral = 0n, previousId = 0;
  for (const refund of [...completed].sort((a, b) => a.id - b.id)) {
    integer(refund.id);
    if (refund.id <= previousId || refund.storeOrderId !== order.id || refund.uid !== order.uid
      || refund.supplierId !== order.supplierId || refund.storeId !== order.storeId
      || refund.refundType !== 6 || refund.isCancel || refund.isDel) throw invalid();
    previousId = refund.id;
    const claim = readRefundQuantityReservation(refund);
    if (!claim) throw invalid();
    const raw = [...lines.values()].reduce((sum, line) => sum + money(line.totals.sum_true_price) + money(line.totals.postage_price), 0n);
    let selectedRaw = 0n;
    for (const item of claim.items) {
      const id = String(item.cartId), row = byId.get(id), line = lines.get(id), prior = consumed.get(id) ?? 0;
      if (!row || !line || item.rowId !== row.id || item.totalNum !== row.cartNum || item.beforeRefundNum !== prior
        || item.cartNum > line.quantity) throw invalid();
      for (const field of compensationFields) {
        const integral = field === 'use_integral' || field === 'gain_integral';
        const parts = allocateRefundLineTotal(line.totals[field], line.quantity, item.cartNum, integral ? 0 : 2);
        accumulated[field] += integral ? points(parts.selected) : money(parts.selected);
        if (field === 'sum_true_price' || field === 'postage_price') selectedRaw += money(parts.selected);
        line.totals[field] = parts.remaining;
      }
      paidIntegral += BigInt(line.integral) * BigInt(item.cartNum);
      line.quantity -= item.cartNum;
      if (line.quantity === 0) lines.delete(id);
      consumed.set(id, prior + item.cartNum);
    }
    const allocated = lines.size === 0 ? remainingPayment
      : money(allocateRefundSplitPayment(decimal(remainingPayment), decimal(raw), decimal(selectedRaw)).selected);
    const paid = money(refund.refundedPrice);
    // A mandatory automatic full recovery may also return earlier cash
    // concessions. It consumes all remaining goods, not additional points.
    const fullRecovery = lines.size === 0 && paid === money(order.payPrice) - refundedPayment;
    if (paid !== money(refund.refundPrice) || (!fullRecovery && (paid > allocated || (refund.applyType !== 4 && paid !== allocated)))) throw invalid();
    remainingPayment -= allocated;
    refundedPayment += paid;
  }
  if (refundedPayment !== money(order.refundPrice) || refundedPayment > money(order.payPrice)
    || rows.some(row => { integer(row.refundNum, true); return row.refundNum < (consumed.get(row.cartId) ?? 0) || row.refundNum > row.cartNum; })) throw invalid();
  integer(Number(accumulated.use_integral), true); integer(Number(paidIntegral), true);
  const basis = (total: bigint, refunded: bigint): RefundCompensationBasis => {
    if (refunded > total) throw invalid();
    return { total: Number(total), refunded: Number(refunded) };
  };
  const one = basis(money(order.oneBrokerage), accumulated.one_brokerage);
  let supplierSettlement: RefundLineCompensation['supplierSettlement'];
  if (order.supplierId > 0) {
    let goods = 0n, refundedGoods = 0n;
    for (const row of rows) {
      const unit = money(row.settlePrice);
      goods += unit * BigInt(row.cartNum);
      refundedGoods += unit * BigInt(consumed.get(row.cartId) ?? 0);
    }
    const includePostage = ![2, 4].includes(order.shippingType);
    const total = goods + (includePostage ? money(order.payPostage) : 0n);
    const refunded = refundedGoods + (includePostage ? accumulated.postage_price : 0n);
    if (total > 999999999999n) throw invalid();
    supplierSettlement = { ...basis(total, refunded), fullyRefunded: rows.every(row => consumed.get(row.cartId) === row.cartNum) };
  }
  return {
    ...(supplierSettlement ? { supplierSettlement } : {}),
    usedIntegral: Number(accumulated.use_integral), payIntegral: Number(paidIntegral),
    productIntegral: basis(points(order.gainIntegral), accumulated.gain_integral),
    payment: basis(money(order.payPrice), money(order.payPrice) - remainingPayment),
    brokerage: { self_brokerage: one, one_brokerage: one,
      two_brokerage: basis(money(order.twoBrokerage), accumulated.two_brokerage),
      staff_brokerage: basis(money(order.divisionStaffBrokerage), accumulated.division_staff_brokerage),
      agent_brokerage: basis(money(order.divisionAgentBrokerage), accumulated.division_agent_brokerage),
      division_brokerage: basis(money(order.divisionBrokerage), accumulated.division_brokerage) },
  };
}
