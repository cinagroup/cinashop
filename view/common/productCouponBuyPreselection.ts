import type { CheckoutCartItem } from './checkoutSelection';
import { orderCouponScope, type OrderCouponScope, type OrderCouponState } from './orderCoupons';
import { productCouponBuyAttempt, ProductCouponBuyJournal, type ProductCouponBuyIntent } from './productCouponBuyIntent';

export interface ProductCouponBuySelection { attempt: string; cartId: number }
export interface ProductCouponBuyOwner { uid: number; version: number }
const invalid = () => Error('原领券购买与当前结算不匹配，请返回原商品核对');
const own = (row: object, key: string) => Object.prototype.hasOwnProperty.call(row, key);

/** A route contains only an opaque recovery attempt and the original cart ID.
 * It never supplies an issue/owned coupon ID or authority to grant a coupon. */
export function parseProductCouponBuySelection(query: Record<string, unknown>): ProductCouponBuySelection | null {
  if (!own(query, 'couponBuy')) return null;
  if (!productCouponBuyAttempt(query.couponBuy) || query.mode !== 'buy' || own(query, 'couponId') || own(query, 'cartIds')
    || typeof query.cartId !== 'string' || !/^[1-9]\d{0,9}$/u.test(query.cartId) || Number(query.cartId) > 2147483647) throw invalid();
  return { attempt: query.couponBuy, cartId: Number(query.cartId) };
}

/** Revalidate current-account server rows, including SKU and quantity, rather
 * than treating a stored session epoch or a route parameter as permission. */
export function assertProductCouponBuyRows(intent: ProductCouponBuyIntent, selection: ProductCouponBuySelection,
  uid: number, rows: readonly CheckoutCartItem[]) {
  const row = rows[0];
  if (intent.uid !== uid || intent.attempt !== selection.attempt || intent.phase !== 'ready' || intent.evidence === 'none'
    || intent.cartId !== selection.cartId || rows.length !== 1 || !row || row.id !== intent.cartId
    || row.type !== 0 || row.isNew !== 1 || row.isValid !== true || !row.productInfo
    || row.productId !== intent.productId || row.unique !== intent.unique || row.cartNum !== intent.quantity) throw invalid();
}

/** Purchase suggestions are repeatable read-only validations. The only write
 * here records a real picker-owned identity or the user's explicit decision;
 * this class never creates a cart, receives a coupon, or creates an order. */
export class ProductCouponBuyPreselection {
  private fingerprint = '';
  private pages = 0;
  private intent: ProductCouponBuyIntent | null = null;
  constructor(readonly selection: ProductCouponBuySelection, private readonly journal: ProductCouponBuyJournal,
    private readonly owner: ProductCouponBuyOwner) {}

  invalidate() { this.fingerprint = ''; this.pages = 0; this.intent = null; }
  private current(owner: ProductCouponBuyOwner) {
    if (owner.uid !== this.owner.uid || owner.version !== this.owner.version || !this.intent || !this.fingerprint) throw invalid();
    return this.journal.assertCurrent(this.intent);
  }
  bind(scope: OrderCouponScope, owner: ProductCouponBuyOwner, rows: readonly CheckoutCartItem[]) {
    this.invalidate();
    if (owner.uid !== this.owner.uid || owner.version !== this.owner.version || !Number.isSafeInteger(owner.uid) || owner.uid <= 0
      || !Number.isSafeInteger(owner.version) || owner.version < 0) throw invalid();
    const intent = this.journal.read(owner.uid);
    if (!intent) throw invalid();
    assertProductCouponBuyRows(intent, this.selection, owner.uid, rows);
    if (scope.isNew !== 1 || scope.cartIds.length !== 1 || scope.cartIds[0] !== intent.cartId
      || scope.fingerprint !== orderCouponScope(rows, scope.shippingType, scope.storeId).fingerprint
      || scope.shippingType === 2 && scope.storeId <= 0) throw invalid();
    this.intent = intent; this.fingerprint = scope.fingerprint;
    return intent;
  }
  accept(page: OrderCouponState, owner: ProductCouponBuyOwner): { couponId: number | null; loadMore: boolean; declined: boolean } {
    const intent = this.current(owner);
    if (page.fingerprint !== this.fingerprint || page.loading) return { couponId: null, loadMore: false, declined: intent.decision === 'declined' };
    if (intent.decision === 'declined') return { couponId: null, loadMore: false, declined: true };
    if (page.error) throw Error(`原优惠券尚未核实：${page.error}。请重试或明确选择不用原优惠券`);
    const coupon = page.list.find(row => row.issueId === intent.issueId && row.availability === 'available'
      && (intent.ownedId === null || row.id === intent.ownedId));
    if (coupon) {
      if (intent.ownedId === null) this.intent = this.journal.update(intent, { ownedId: coupon.id });
      return { couponId: coupon.id, loadMore: false, declined: false };
    }
    if (page.nextCursor !== null && ++this.pages < 50) return { couponId: null, loadMore: true, declined: false };
    throw Error('原优惠券当前不适用于这笔订单，请重新选券或明确选择不用原优惠券');
  }
  decline(owner: ProductCouponBuyOwner) {
    const intent = this.current(owner);
    this.intent = intent.decision === 'declined' ? intent : this.journal.update(intent, { decision: 'declined' });
  }
  assertSelection(owner: ProductCouponBuyOwner, scope: OrderCouponScope | null, page: OrderCouponState, couponId: number) {
    const intent = this.current(owner);
    if (!scope || scope.fingerprint !== this.fingerprint) throw invalid();
    if (intent.decision === 'declined' && couponId === 0) return;
    if (page.loading || page.error || page.fingerprint !== this.fingerprint) throw Error('请先核对当前订单的优惠券');
    const selected = page.list.find(row => row.id === couponId && row.availability === 'available');
    if (!selected || intent.decision === 'apply' && (intent.ownedId !== selected.id || intent.issueId !== selected.issueId)) {
      throw Error('原优惠券尚未核实，请重试或明确重新选择');
    }
  }
}
