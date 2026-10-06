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

export const PROMOTION_QUOTE_VERSION = 'order-promotion-quote-v1';
interface PromotionAllocation {
  promotionId: number; rootId: number; type: number; savingsCents: number;
  discountQuantity: number; labelIds: number[]; name: string;
}
interface PromotionSegment {
  quantity: number; rawGrossCents: number; totalPriceCents: number;
  unitPriceCents: number | null; membershipSavingsCents: number;
  promotionIds: number[]; promotionAllocations: PromotionAllocation[];
  couponEligibleGrossCents: number;
}
export interface PromotionLineEvidence {
  priceCents: number; savingsCents: number; memberSavingsCents: number;
  discountQuantity: number; segments: PromotionSegment[];
  allocations: PromotionAllocation[];
}
const cents = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 999999999999) throw invalid();
  return value;
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
const listIds = (value: unknown): number[] => {
  if (!Array.isArray(value) || value.length > 100) throw invalid();
  const result = value.map((id) => quantity(id));
  if (new Set(result).size !== result.length) throw invalid();
  return result;
};
function allocation(value: unknown): PromotionAllocation {
  const row = record(value);
  const promotionId = quantity(row.promotionId as number), rootId = quantity(row.rootId as number);
  if (rootId !== promotionId || ![1, 2, 3].includes(row.type as number)
    || typeof row.name !== 'string' || row.name.length > 255) throw invalid();
  return { promotionId, rootId, type: row.type as number, savingsCents: cents(row.savingsCents),
    discountQuantity: quantity(row.discountQuantity as number, true), labelIds: listIds(row.labelIds), name: row.name };
}
function segment(value: unknown): PromotionSegment {
  const row = record(value), count = quantity(row.quantity as number);
  const rawGrossCents = cents(row.rawGrossCents), totalPriceCents = cents(row.totalPriceCents);
  const membershipSavingsCents = cents(row.membershipSavingsCents);
  const couponEligibleGrossCents = cents(row.couponEligibleGrossCents);
  const promotionIds = listIds(row.promotionIds);
  if (!Array.isArray(row.promotionAllocations) || row.promotionAllocations.length > 3) throw invalid();
  const promotionAllocations = row.promotionAllocations.map(allocation);
  const savings = promotionAllocations.reduce((sum, item) => sum + item.savingsCents, 0);
  if (rawGrossCents - membershipSavingsCents - savings !== totalPriceCents
    || couponEligibleGrossCents !== 0 && couponEligibleGrossCents !== totalPriceCents
    || promotionIds.length !== promotionAllocations.length
    || promotionIds.some((id, index) => id !== promotionAllocations[index].promotionId)
    || promotionAllocations.some((item) => item.discountQuantity !== count)
    || (row.unitPriceCents !== null && cents(row.unitPriceCents) * count !== totalPriceCents)) throw invalid();
  return { quantity: count, rawGrossCents, totalPriceCents,
    unitPriceCents: row.unitPriceCents === null ? null : cents(row.unitPriceCents),
    membershipSavingsCents, promotionIds, promotionAllocations, couponEligibleGrossCents };
}
function foldedAllocations(segments: readonly PromotionSegment[]): PromotionAllocation[] {
  const byId = new Map<number, PromotionAllocation>();
  for (const part of segments) for (const item of part.promotionAllocations) {
    const previous = byId.get(item.promotionId);
    if (previous && (previous.type !== item.type || previous.name !== item.name
      || JSON.stringify(previous.labelIds) !== JSON.stringify(item.labelIds))) throw invalid();
    byId.set(item.promotionId, { ...item,
      savingsCents: (previous?.savingsCents ?? 0) + item.savingsCents,
      discountQuantity: (previous?.discountQuantity ?? 0) + item.discountQuantity });
  }
  return [...byId.values()].sort((a, b) => a.promotionId - b.promotionId);
}

/** Validate exact promotion line evidence without interpreting a rounded unit price. */
export function readPromotionLineEvidence(source: Record<string, unknown>, totalQty: number): PromotionLineEvidence | null {
  const fields = ['promotion_quote_version', 'promotion_line_price', 'promotion_line_savings',
    'promotion_line_member_savings', 'promotion_discount_quantity', 'promotion_allocations', 'promotion_segments'];
  const present = fields.some((field) => Object.hasOwn(source, field));
  if (!present) return null;
  if (source.promotion_quote_version !== PROMOTION_QUOTE_VERSION) throw invalid();
  quantity(totalQty);
  if (!Array.isArray(source.promotion_segments) || source.promotion_segments.length > 200
    || !Array.isArray(source.promotion_allocations) || source.promotion_allocations.length > 3) throw invalid();
  const segments = source.promotion_segments.map(segment);
  if (!segments.length || segments.reduce((sum, part) => sum + part.quantity, 0) !== totalQty) throw invalid();
  const allocations = source.promotion_allocations.map(allocation).sort((a, b) => a.promotionId - b.promotionId);
  if (JSON.stringify(allocations) !== JSON.stringify(foldedAllocations(segments))) throw invalid();
  const priceCents = Number(money(source.promotion_line_price));
  const savingsCents = Number(money(source.promotion_line_savings));
  const memberSavingsCents = Number(money(source.promotion_line_member_savings));
  const discountQuantity = quantity(source.promotion_discount_quantity as number, true);
  if (segments.reduce((sum, part) => sum + part.totalPriceCents, 0) !== priceCents
    || allocations.reduce((sum, item) => sum + item.savingsCents, 0) !== savingsCents
    || segments.reduce((sum, part) => sum + part.membershipSavingsCents, 0) !== memberSavingsCents
    || allocations.filter((item) => item.type === 1).reduce((sum, item) => sum + item.discountQuantity, 0) !== discountQuantity
    || discountQuantity > totalQty
    || Number(money(source.coupon_price)) > segments.reduce((sum, part) => sum + part.couponEligibleGrossCents, 0)
    || priceCents - Number(money(source.coupon_price)) - Number(money(source.integral_price))
      - Number(money(source.first_order_price)) !== Number(money(source.sum_true_price))) throw invalid();
  return { priceCents, savingsCents, memberSavingsCents, discountQuantity, allocations, segments };
}

function allocatePromotionCents(total: number, selectedWeight: number, remainingWeight: number,
  selectedCapacity: number, remainingCapacity: number): { selected: number; remaining: number } {
  const weight = selectedWeight + remainingWeight;
  if (!weight && total === 0) return { selected: 0, remaining: 0 };
  if (!weight || total < 0 || total > selectedCapacity + remainingCapacity) throw invalid();
  const ideal = Math.trunc(total * selectedWeight / weight);
  const selected = Math.max(total - remainingCapacity, Math.min(selectedCapacity, ideal));
  return { selected, remaining: total - selected };
}

function partitionPromotionSegments(evidence: PromotionLineEvidence, selectedQty: number) {
  let toSelect = selectedQty;
  const selected: PromotionSegment[] = [], remaining: PromotionSegment[] = [];
  for (const part of evidence.segments) {
    const count = Math.min(part.quantity, toSelect);
    toSelect -= count;
    if (!count) { remaining.push(structuredClone(part)); continue; }
    if (count === part.quantity) { selected.push(structuredClone(part)); continue; }
    const raw = allocateRefundLineTotal(fixed(BigInt(part.rawGrossCents), 2), part.quantity, count);
    const member = allocateRefundLineTotal(fixed(BigInt(part.membershipSavingsCents), 2), part.quantity, count);
    const rawSelected = Number(money(raw.selected));
    let memberSelected = Number(money(member.selected));
    const allocParts = part.promotionAllocations.map((item) => {
      const split = allocateRefundLineTotal(fixed(BigInt(item.savingsCents), 2), part.quantity, count);
      return { selected: { ...item, savingsCents: Number(money(split.selected)), discountQuantity: count },
        remaining: { ...item, savingsCents: Number(money(split.remaining)), discountQuantity: part.quantity - count } };
    });
    // Dividing every savings component independently can put a rounding cent
    // onto the remaining child after its entire raw price has gone to the
    // selected child (for example two one-cent type-2/3 savings on a 2-cent
    // two-piece segment). Transfer that cent within its original allocation.
    const sourceNet = part.totalPriceCents;
    const selectedSavings = () => memberSelected + allocParts.reduce((sum, item) =>
      sum + item.selected.savingsCents, 0);
    let selectedNet = rawSelected - selectedSavings();
    const rebalance = (from: 'selected' | 'remaining', amount: number) => {
      let left = amount;
      for (const item of [...allocParts].sort((a, b) => Number(a.selected.type === 1) - Number(b.selected.type === 1))) {
        const transferred = Math.min(left, item[from].savingsCents);
        item[from].savingsCents -= transferred;
        item[from === 'selected' ? 'remaining' : 'selected'].savingsCents += transferred;
        left -= transferred;
        if (!left) break;
      }
      if (left) {
        const available = from === 'selected' ? memberSelected : part.membershipSavingsCents - memberSelected;
        const transferred = Math.min(left, available);
        memberSelected += from === 'selected' ? -transferred : transferred;
        left -= transferred;
      }
      if (left) throw invalid();
    };
    if (selectedNet < 0) rebalance('selected', -selectedNet);
    else if (selectedNet > sourceNet) rebalance('remaining', selectedNet - sourceNet);
    selectedNet = rawSelected - selectedSavings();
    if (selectedNet < 0 || selectedNet > sourceNet) throw invalid();
    const make = (quantity: number, gross: number, membership: number, allocations: PromotionAllocation[]): PromotionSegment => {
      const totalPriceCents = gross - membership - allocations.reduce((sum, item) => sum + item.savingsCents, 0);
      if (totalPriceCents < 0) throw invalid();
      return { quantity, rawGrossCents: gross, membershipSavingsCents: membership, totalPriceCents,
        unitPriceCents: totalPriceCents % quantity === 0 ? totalPriceCents / quantity : null,
        promotionIds: [...part.promotionIds], promotionAllocations: allocations,
        couponEligibleGrossCents: part.couponEligibleGrossCents ? totalPriceCents : 0 };
    };
    selected.push(make(count, rawSelected, memberSelected, allocParts.map((item) => item.selected)));
    remaining.push(make(part.quantity - count, part.rawGrossCents - rawSelected,
      part.membershipSavingsCents - memberSelected, allocParts.map((item) => item.remaining)));
  }
  if (toSelect) throw invalid();
  return { selected, remaining };
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
  const promotion = readPromotionLineEvidence(source, totalQty);
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
    if (promotion) {
      const parts = partitionPromotionSegments(promotion, selectedQty);
      const selectedPrice = parts.selected.reduce((sum, part) => sum + part.totalPriceCents, 0);
      const remainingPrice = parts.remaining.reduce((sum, part) => sum + part.totalPriceCents, 0);
      const selectedEligible = parts.selected.reduce((sum, part) => sum + part.couponEligibleGrossCents, 0);
      const remainingEligible = parts.remaining.reduce((sum, part) => sum + part.couponEligibleGrossCents, 0);
      const coupon = allocatePromotionCents(Number(money(source.coupon_price)), selectedEligible, remainingEligible,
        selectedEligible, remainingEligible);
      const firstOrder = allocatePromotionCents(Number(money(source.first_order_price)),
        selectedPrice - coupon.selected, remainingPrice - coupon.remaining,
        selectedPrice - coupon.selected, remainingPrice - coupon.remaining);
      const integral = allocatePromotionCents(Number(money(source.integral_price)),
        selectedPrice - coupon.selected - firstOrder.selected,
        remainingPrice - coupon.remaining - firstOrder.remaining,
        selectedPrice - coupon.selected - firstOrder.selected,
        remainingPrice - coupon.remaining - firstOrder.remaining);
      const memberCoupon = Number(money(source.member_coupon_price ?? 0));
      if (memberCoupon !== 0 && memberCoupon !== Number(money(source.coupon_price))) throw invalid();
      const assign = (child: Record<string, unknown>, segments: PromotionSegment[], price: number,
        couponCents: number, firstCents: number, integralCents: number) => {
        child.promotion_segments = segments;
        child.promotion_allocations = foldedAllocations(segments);
        child.promotion_line_price = fixed(BigInt(price), 2);
        child.promotion_line_savings = fixed(BigInt(segments.reduce((sum, part) =>
          sum + part.promotionAllocations.reduce((inner, item) => inner + item.savingsCents, 0), 0)), 2);
        child.promotion_line_member_savings = fixed(BigInt(segments.reduce((sum, part) =>
          sum + part.membershipSavingsCents, 0)), 2);
        child.promotion_discount_quantity = segments.reduce((sum, part) => sum +
          part.promotionAllocations.filter((item) => item.type === 1)
            .reduce((inner, item) => inner + item.discountQuantity, 0), 0);
        child.coupon_price = fixed(BigInt(couponCents), 2);
        child.first_order_price = fixed(BigInt(firstCents), 2);
        child.integral_price = fixed(BigInt(integralCents), 2);
        child.sum_true_price = fixed(BigInt(price - couponCents - firstCents - integralCents), 2);
        if (Object.hasOwn(source, 'member_coupon_price')) {
          child.member_coupon_price = fixed(BigInt(memberCoupon ? couponCents : 0), 2);
        }
        readPromotionLineEvidence(child, Number(child.cart_num));
      };
      assign(selected, parts.selected, selectedPrice, coupon.selected, firstOrder.selected, integral.selected);
      assign(remaining, parts.remaining, remainingPrice, coupon.remaining, firstOrder.remaining, integral.remaining);
      if (Number(money(selected.sum_true_price)) + Number(money(remaining.sum_true_price))
        !== Number(money(source.sum_true_price))) throw invalid();
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
