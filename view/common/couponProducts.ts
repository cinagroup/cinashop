import { quoteMoney } from "./checkoutQuote";

export interface CouponProduct { id: number; title: string; image: string; catalogPrice: string }
export interface CouponProductsPage { couponId: number; title: string; scopeType: number; list: CouponProduct[]; nextCursor: number | null }
export interface CouponProductsState extends CouponProductsPage { loading: boolean; loaded: boolean; error: string }
export const couponScopeLabels = ["通用券范围", "指定品类及其下级商品", "指定商品及其关联子商品", "指定品牌及其下级商品"];
export function couponProductId(value: unknown): number {
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) value = Number(value);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("优惠券标识无效");
  return value;
}
export function normalizeCouponProducts(value: unknown, couponId: number, before?: number): CouponProductsPage {
  couponProductId(couponId); if (before !== undefined) couponProductId(before);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("券范围商品数据无效");
  const row = value as Record<string, unknown>;
  if (row.coupon_id !== couponId || row.scope_only !== true || typeof row.coupon_title !== "string" || row.coupon_title.length > 1000
    || typeof row.scope_type !== "number" || ![0, 1, 2, 3].includes(row.scope_type) || !Array.isArray(row.list) || row.list.length > 100) throw new Error("券范围商品合同不匹配");
  let previous = before ?? Infinity;
  const list = row.list.map((entry): CouponProduct => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("券范围商品无效");
    const product = entry as Record<string, unknown>;
    if (typeof product.id !== "number") throw new Error("商品标识无效");
    const id = couponProductId(product.id);
    if (id >= previous) throw new Error("券范围商品分页顺序无效"); previous = id;
    if (typeof product.store_name !== "string" || product.store_name.length > 1000 || typeof product.image !== "string" || product.image.length > 4096) throw new Error("商品说明无效");
    // Only display public HTTP(S) or same-origin images; never interpret URLs as navigation or markup.
    const image = /^(https?:\/\/|\/(?!\/))/.test(product.image) && !/[\\\u0000-\u001f\u007f]/.test(product.image) ? product.image : "";
    return { id, title: product.store_name, image, catalogPrice: quoteMoney(product.catalog_price) };
  });
  const nextCursor = row.next_cursor === null ? null : typeof row.next_cursor === "number" ? couponProductId(row.next_cursor) : (() => { throw new Error("券范围分页标识无效"); })();
  if (nextCursor !== null && ((before !== undefined && nextCursor >= before) || (list.length && nextCursor > list[list.length - 1]!.id))) throw new Error("券范围分页标识不匹配");
  return { couponId, title: row.coupon_title, scopeType: row.scope_type, list, nextCursor };
}

export const emptyCouponProducts = (): CouponProductsState => ({ couponId: 0, title: "", scopeType: 0, list: [], nextCursor: null, loading: false, loaded: false, error: "" });
/** A scanned empty page can continue. Reset/refresh cancels both late success and late failure. */
export class CouponProductsSession {
  private generation = 0;
  private state = emptyCouponProducts();
  constructor(private readonly fetch: (couponId: number, before?: number) => Promise<CouponProductsPage>, private readonly publish: (state: CouponProductsState) => void) {}
  reset() { this.generation++; this.state = emptyCouponProducts(); this.publish(this.state); }
  async load(couponId: number, append = false) {
    if (append && (this.state.couponId !== couponId || this.state.loading || this.state.nextCursor === null)) return;
    const generation = ++this.generation, prior = append ? this.state : emptyCouponProducts();
    const before = append ? prior.nextCursor! : undefined;
    this.state = { ...prior, couponId, loading: true, error: "" }; this.publish(this.state);
    try {
      couponProductId(couponId);
      const page = await this.fetch(couponId, before);
      if (generation !== this.generation) return;
      if (page.couponId !== couponId || (append && (page.scopeType !== prior.scopeType || page.title !== prior.title))) throw new Error("优惠券范围已变化，请刷新后重试");
      this.state = { ...page, list: [...prior.list, ...page.list], loading: false, loaded: true, error: "" };
    } catch (error) {
      if (generation !== this.generation) return;
      this.state = { ...prior, couponId, loading: false, error: error instanceof Error ? error.message : "券范围商品加载失败" };
    }
    this.publish(this.state);
  }
}
