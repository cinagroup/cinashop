import type { CheckoutCartItem as CartItem } from "./checkoutSelection";
import { quoteMoney } from "./checkoutQuote";
import { normalizeCouponPage, type OwnedCoupon } from "./couponWallet";

export interface OrderCouponScope {
  cartIds: number[];
  isNew: 0 | 1;
  shippingType: 1 | 2;
  storeId: number;
  fingerprint: string;
}
export interface OrderCoupon extends OwnedCoupon { estimatedDiscount: string; eligibleSubtotal: string }
export interface OrderCouponPage { list: OrderCoupon[]; nextCursor: number | null }
export interface OrderCouponState extends OrderCouponPage { fingerprint: string; loading: boolean; error: string }

/** Only IDs/mode/delivery leave the client. Quantities and SKU identity invalidate local snapshots, never supply a price. */
export function orderCouponScope(items: readonly CartItem[], shippingType: number, storeId: number): OrderCouponScope {
  if (!items.length || items.length > 200 || new Set(items.map((item) => item.id)).size !== items.length
    || items.some((item) => !Number.isSafeInteger(item.id) || item.id <= 0 || !item.isValid || !item.productInfo
      || item.type !== 0 || ![0, 1].includes(item.isNew) || item.isNew !== items[0].isNew
      || !Number.isSafeInteger(item.cartNum) || item.cartNum <= 0 || !item.unique)) throw new Error("订单筛券商品范围无效");
  if (![1, 2].includes(shippingType) || !Number.isSafeInteger(storeId) || storeId < 0) throw new Error("订单筛券配送参数无效");
  const sorted = [...items].sort((a, b) => a.id - b.id);
  const scope = { cartIds: sorted.map((item) => item.id), isNew: items[0].isNew as 0 | 1,
    shippingType: shippingType as 1 | 2, storeId: shippingType === 2 ? storeId : 0 };
  return { ...scope, fingerprint: JSON.stringify([scope, sorted.map((item) => [item.id, item.productId, item.unique, item.cartNum])]) };
}

export function orderCouponRequest(scope: OrderCouponScope, before?: number) {
  if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) throw new Error("优惠券分页标识无效");
  return { cartId: scope.cartIds.join(","), new: scope.isNew, shipping_type: scope.shippingType,
    store_id: scope.storeId, limit: 20, ...(before === undefined ? {} : { before }) };
}

/** Unlike the wallet, the cursor is the last SCANNED candidate, not necessarily a returned/eligible coupon. */
export function normalizeOrderCouponPage(value: unknown, cursor: unknown, before?: number): OrderCouponPage {
  const base = normalizeCouponPage(value, "");
  const rows = value as Record<string, unknown>[]; // The shared normalizer has validated the array and every object.
  const cents = (amount: string) => BigInt(amount.replace(".", ""));
  const list = base.list.map((coupon, index): OrderCoupon => {
    const estimatedDiscount = quoteMoney(rows[index].estimated_discount);
    const eligibleSubtotal = quoteMoney(rows[index].eligible_subtotal);
    if (coupon.availability !== "available" || cents(eligibleSubtotal) <= 0n
      || cents(estimatedDiscount) > cents(eligibleSubtotal) || cents(coupon.minimum) > cents(eligibleSubtotal)) throw new Error("订单优惠券适用金额无效");
    return { ...coupon, estimatedDiscount, eligibleSubtotal };
  });
  let nextCursor: number | null = null;
  if (cursor !== undefined && cursor !== null && cursor !== "") {
    if (typeof cursor !== "string" || !/^\d+$/.test(cursor)) throw new Error("优惠券分页标识无效");
    nextCursor = Number(cursor);
    if (!Number.isSafeInteger(nextCursor) || nextCursor <= 0) throw new Error("优惠券分页标识无效");
  }
  assertPageProgress({ list, nextCursor }, before);
  return { list, nextCursor };
}

function assertPageProgress(page: OrderCouponPage, before?: number) {
  if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) throw new Error("优惠券分页标识无效");
  if (page.list.some((row, index) => (before !== undefined && row.id >= before) || (index > 0 && row.id >= page.list[index - 1].id))
    || (page.nextCursor !== null && ((before !== undefined && page.nextCursor >= before)
      || (page.list.length > 0 && page.nextCursor > page.list[page.list.length - 1].id)))) throw new Error("订单优惠券分页顺序无效");
}

export class OrderCouponSession {
  private generation = 0;
  private state: OrderCouponState = { list: [], nextCursor: null, fingerprint: "", loading: false, error: "" };
  constructor(private readonly fetchPage: (scope: OrderCouponScope, before?: number) => Promise<OrderCouponPage>,
    private readonly publish: (state: OrderCouponState) => void) {}
  reset() {
    this.generation++;
    this.state = { list: [], nextCursor: null, fingerprint: "", loading: false, error: "" };
    this.publish(this.state);
  }
  /** Freeze visible selection while an order result is unknown; late reads cannot alter that snapshot. */
  pause() { this.generation++; this.state = { ...this.state, loading: false }; this.publish(this.state); }
  async load(scope: OrderCouponScope, append = false) {
    if (append && (scope.fingerprint !== this.state.fingerprint || this.state.loading || this.state.nextCursor === null)) return;
    const generation = ++this.generation;
    const before = append ? this.state.nextCursor! : undefined;
    const prior = append ? this.state.list : [];
    const snapshot = { ...scope, cartIds: [...scope.cartIds] };
    this.state = { list: prior, nextCursor: before ?? null, fingerprint: snapshot.fingerprint, loading: true, error: "" };
    this.publish(this.state);
    try {
      const page = await this.fetchPage(snapshot, before);
      if (generation !== this.generation) return;
      assertPageProgress(page, before);
      this.state = { ...this.state, list: [...prior, ...page.list], nextCursor: page.nextCursor, loading: false, error: "" };
    } catch (error) {
      if (generation !== this.generation) return;
      this.state = { ...this.state, list: prior, nextCursor: before ?? null, loading: false,
        error: error instanceof Error ? error.message : "订单优惠券加载失败" };
    }
    this.publish(this.state);
  }
}
