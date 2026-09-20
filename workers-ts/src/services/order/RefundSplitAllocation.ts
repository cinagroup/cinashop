import { ValidateException } from '@/utils/errors';

/** Line totals, not unit prices. Keep the PHP spelling: these fields are also
 * persisted in checkout snapshots. This is NOT an order-total weight split. */
export const REFUND_SPLIT_LINE_FIELDS = [
  'coupon_price', 'integral_price', 'postage_price', 'use_integral',
  'one_brokerage', 'two_brokerage', 'sum_true_price', 'first_order_price',
  'division_staff_brokerage', 'division_agent_brokerage', 'division_brokerage',
] as const;

const invalid = () => new ValidateException('退款拆单商品快照不一致，请人工核对');
const MAX_INT = 2147483647;
function quantity(value: number, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > MAX_INT) throw invalid();
  return value;
}

/** Bounded, nonnegative decimal input. No floating-point money operations,
 * exponent notation, coercion of booleans, or silent malformed-value -> zero. */
function decimal(value: unknown): { coefficient: bigint; places: number } {
  if (typeof value !== 'string' && typeof value !== 'number') throw invalid();
  const text = String(value);
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,8})?$/.test(text)) throw invalid();
  const [whole, fraction = ''] = text.split('.');
  return { coefficient: BigInt(whole + fraction), places: fraction.length };
}
function fixed(value: bigint, places: number): string {
  const power = 10n ** BigInt(places);
  return places ? `${value / power}.${String(value % power).padStart(places, '0')}` : String(value);
}

/** PHP slpitComputeOrderCart: bcdiv(total, quantity, 4), THEN bcmul(...,
 * selected, scale). Combining those operations into a single ratio loses
 * fidelity (1.00 / 6 * 3 is 0.49, not 0.50). The remainder owns the residue. */
export function allocateRefundLineTotal(
  value: unknown, totalQty: number, selectedQty: number, scale: 0 | 2 = 2,
): { selected: string; remaining: string } {
  quantity(totalQty); quantity(selectedQty, true);
  if (selectedQty > totalQty || (scale !== 0 && scale !== 2)) throw invalid();
  const { coefficient, places } = decimal(value);
  const denominator = 10n ** BigInt(places);
  const units = coefficient * (10n ** BigInt(scale)) / denominator;
  const perUnitFourPlaces = coefficient * 10000n / (denominator * BigInt(totalQty));
  const selected = selectedQty === totalQty ? units
    : perUnitFourPlaces * BigInt(selectedQty) / (10n ** BigInt(4 - scale));
  return { selected: fixed(selected, scale), remaining: fixed(units - selected, scale) };
}

function money(value: unknown): bigint {
  const { coefficient, places } = decimal(value);
  const denominator = 10n ** BigInt(places);
  if (coefficient * 100n % denominator !== 0n) throw invalid();
  return coefficient * 100n / denominator;
}

/** Reprice a PARTIAL order split from reconstructed raw child amounts, not
 * merchandise weights. PHP splitComputeOrder truncates actual/raw to 4 places.
 * A zero selected price is still an allocation: unlike PHP's truthiness test
 * on pre_pay_price, it must not lose the parent's final cent or gift ownership.
 * Caller decides gift ownership by selected/remaining role, never by price. */
export function allocateRefundSplitPayment(
  actualPayment: unknown, originalRawPayment: unknown, selectedRawPayment: unknown,
): { selected: string; remaining: string } {
  const actual = money(actualPayment), raw = money(originalRawPayment), selectedRaw = money(selectedRawPayment);
  if (selectedRaw > raw || (raw === 0n && actual !== 0n)) throw invalid();
  const ratioFourPlaces = raw ? actual * 10000n / raw : 0n;
  const selected = ratioFourPlaces * selectedRaw / 10000n;
  return { selected: fixed(selected, 2), remaining: fixed(actual - selected, 2) };
}

function snapshotObject(value: string): Record<string, unknown> {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > 65536) throw invalid();
  let result: unknown;
  try { result = JSON.parse(value); } catch { throw invalid(); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw invalid();
  return result as Record<string, unknown>;
}

/** Pure partition only: no IDs, reservation claims, order amounts or payment
 * associations are invented here. The materializer must replace snapshot.id
 * when allocating each new cart identity and must validate missing monetary
 * fields against authoritative order/checkout evidence before writing orders. */
export function partitionRefundCartSnapshot(
  value: string, totalQty: number, selectedQty: number, isGift: boolean,
): { selected: string | null; remaining: string | null; missingFields: string[] } {
  quantity(totalQty); quantity(selectedQty, true);
  if (selectedQty > totalQty || typeof isGift !== 'boolean') throw invalid();
  const source = snapshotObject(value);
  // Older modern checkout omitted cart_num. If present it must agree with the SQL row,
  // including numeric strings stored by PHP after BCMath quantity operations.
  if (Object.hasOwn(source, 'cart_num') && source.cart_num !== totalQty && source.cart_num !== String(totalQty)) throw invalid();
  const missingFields: string[] = REFUND_SPLIT_LINE_FIELDS.filter(field => source[field] === undefined || source[field] === null);
  // New checkout raw freight and derived gift-point residues are optional for
  // legacy snapshots, but must be partitioned whenever their evidence exists.
  const fields = [...REFUND_SPLIT_LINE_FIELDS,
    ...['raw_postage_price', 'gain_integral', 'member_postage_price', 'member_coupon_price'].filter(field => Object.hasOwn(source, field))];
  // Validate even gifts/whole lines: a branch must not hide corrupt amounts.
  for (const field of fields) if (!missingFields.includes(field)) decimal(source[field]);
  const selected = structuredClone(source), remaining = structuredClone(source);
  selected.cart_num = selectedQty; remaining.cart_num = totalQty - selectedQty;
  if (selectedQty > 0 && selectedQty < totalQty) {
    for (const field of fields) {
      if (missingFields.includes(field) || isGift || decimal(source[field]).coefficient === 0n) {
        selected[field] = remaining[field] = 0;
      } else {
        const part = allocateRefundLineTotal(source[field], totalQty, selectedQty,
          field === 'use_integral' || field === 'gain_integral' ? 0 : 2);
        selected[field] = part.selected; remaining[field] = part.remaining;
      }
    }
    // A member freight saving is the difference between the original and
    // charged line freight, not an independently rounded third allocation.
    // For 0.02 raw / 0.01 charged split in two, the selected child saves the
    // cent while the remainder pays it. Keep that identity and conservation.
    if (Object.hasOwn(source, 'member_postage_price') && money(source.member_postage_price) > 0n) {
      if (money(source.member_postage_price) !== money(source.raw_postage_price) - money(source.postage_price)) throw invalid();
      for (const child of [selected, remaining]) {
        const saving = money(child.raw_postage_price) - money(child.postage_price);
        if (saving < 0n) throw invalid();
        child.member_postage_price = fixed(saving, 2);
      }
    }
  }
  return { selected: selectedQty ? JSON.stringify(selected) : null,
    remaining: selectedQty < totalQty ? JSON.stringify(remaining) : null, missingFields };
}

export interface RefundWriteoffState {
  cartNum: number;
  writeTimes: number;
  writeSurplusTimes: number;
  writeoffTime: number;
  isWriteoff: number;
}

/** PHP splitV2 takes unredeemed units into the selected child first. The unit
 * entitlement must come from the persisted snapshot (or exact SQL quotient),
 * never a current mutable SKU. Inconsistent counters fail before allocation. */
export function partitionRefundWriteoff(
  source: RefundWriteoffState, selectedQty: number, unitWriteTimes: number,
): { selected: RefundWriteoffState | null; remaining: RefundWriteoffState | null } {
  quantity(source.cartNum); quantity(selectedQty, true); quantity(unitWriteTimes);
  quantity(source.writeTimes); quantity(source.writeSurplusTimes, true); quantity(source.writeoffTime, true);
  if (selectedQty > source.cartNum || source.writeTimes !== source.cartNum * unitWriteTimes
    || source.writeSurplusTimes > source.writeTimes || ![0, 1].includes(source.isWriteoff)
    || (source.isWriteoff === 1) !== (source.writeSurplusTimes === 0)
    || (source.writeoffTime === 0) !== (source.writeSurplusTimes === source.writeTimes)) throw invalid();
  const consumed = source.writeTimes - source.writeSurplusTimes;
  const make = (cartNum: number, selected: boolean): RefundWriteoffState | null => {
    if (!cartNum) return null;
    const writeTimes = cartNum * unitWriteTimes;
    const writeSurplusTimes = selected ? Math.min(source.writeSurplusTimes, writeTimes) : Math.max(writeTimes - consumed, 0);
    return { cartNum, writeTimes, writeSurplusTimes,
      writeoffTime: writeSurplusTimes === writeTimes ? 0 : source.writeoffTime,
      isWriteoff: writeSurplusTimes === 0 ? 1 : 0 };
  };
  return { selected: make(selectedQty, true), remaining: make(source.cartNum - selectedQty, false) };
}

/** Return an explicit decision, not an expanded selector or an authorization
 * to refund gifts. PHP equalSplit uses whole-order treatment only when an
 * unshipped refund would leave gifts alone. Shipped gifts may remain separate. */
export function refundSplitDisposition(
  orderStatus: number,
  rows: readonly { cartId: string; cartNum: number; isGift: number }[],
  selected: readonly { cartId: string; cartNum: number }[],
): 'split' | 'whole-order' | 'whole-order-gift-remainder' {
  if (!Number.isInteger(orderStatus) || orderStatus < 0 || orderStatus > 5
    || !Array.isArray(rows) || !rows.length || rows.length > 200
    || !Array.isArray(selected) || !selected.length || selected.length > 100) throw invalid();
  const byId = new Map<string, { cartNum: number; isGift: number }>();
  for (const row of rows) {
    if (typeof row.cartId !== 'string' || !row.cartId || row.cartId.length > 50 || byId.has(row.cartId)
      || ![0, 1].includes(row.isGift)) throw invalid();
    quantity(row.cartNum); byId.set(row.cartId, row);
  }
  const quantities = new Map<string, number>();
  for (const item of selected) {
    const row = byId.get(item.cartId);
    quantity(item.cartNum);
    if (!row || quantities.has(item.cartId) || item.cartNum > row.cartNum) throw invalid();
    quantities.set(item.cartId, item.cartNum);
  }
  const remaining = rows.filter(row => row.cartNum > (quantities.get(row.cartId) ?? 0));
  if (!remaining.length) return 'whole-order';
  return orderStatus === 0 && remaining.every(row => row.isGift === 1) ? 'whole-order-gift-remainder' : 'split';
}
