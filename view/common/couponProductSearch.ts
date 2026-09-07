import { couponProductId, normalizeCouponProduct, type CouponProduct } from "./couponProducts";

export const couponSearchSorts = [
  { value: "recommended", label: "综合排序" }, { value: "rating", label: "好评优先" }, { value: "newest", label: "新品优先" },
  { value: "price_asc", label: "价格从低到高" }, { value: "price_desc", label: "价格从高到低" },
  { value: "sales_desc", label: "目录销量从高到低" }, { value: "sales_asc", label: "目录销量从低到高" },
] as const;
export type CouponSearchSort = typeof couponSearchSorts[number]["value"];
export interface CouponSearchOptions { keyword: string; sort: CouponSearchSort }
export const defaultCouponSearch = (): CouponSearchOptions => ({ keyword: "", sort: "recommended" });
export function couponSearchOptions(keyword: unknown, sort: unknown): CouponSearchOptions {
  if (typeof keyword !== "string" || keyword.length > 100 || /[\u0000-\u001f\u007f]/.test(keyword)
    || !couponSearchSorts.some(option => option.value === sort)) throw new Error("搜索名称或排序无效，请检查后重试");
  return { keyword: keyword.trim(), sort: sort as CouponSearchSort };
}
export function couponSearchCursor(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new Error("券范围搜索游标无效，请刷新");
  return value;
}
export interface CouponSearchPage extends CouponSearchOptions {
  couponId: number; title: string; scopeType: number; list: CouponProduct[]; nextCursor: string | null;
  scannedCount: number; scanLimitReached: boolean;
}
export interface CouponSearchState extends CouponSearchPage { loading: boolean; loaded: boolean; error: string; totalScanned: number }
export function normalizeCouponSearch(value: unknown, couponId: number, options: CouponSearchOptions, cursor?: string): CouponSearchPage {
  couponProductId(couponId); const expected = couponSearchOptions(options.keyword, options.sort);
  if (cursor !== undefined) couponSearchCursor(cursor);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("券范围搜索数据无效");
  const row = value as Record<string, unknown>;
  if (row.coupon_id !== couponId || row.scope_only !== true || typeof row.coupon_title !== "string" || row.coupon_title.length > 1000
    || typeof row.scope_type !== "number" || ![0, 1, 2, 3].includes(row.scope_type) || !Array.isArray(row.list) || row.list.length > 20
    || row.keyword !== expected.keyword || row.sort !== expected.sort
    || typeof row.scanned_count !== "number" || !Number.isInteger(row.scanned_count) || row.scanned_count < row.list.length || row.scanned_count > 500
    || typeof row.scan_limit_reached !== "boolean") throw new Error("券范围搜索合同不匹配");
  const list = row.list.map(normalizeCouponProduct), ids = new Set(list.map(item => item.id));
  if (ids.size !== list.length) throw new Error("商品目录已变化，请刷新后重试");
  const nextCursor = row.next_cursor === null ? null : couponSearchCursor(row.next_cursor);
  if ((nextCursor !== null && (row.scanned_count === 0 || nextCursor === cursor))
    || (row.scan_limit_reached && (row.scanned_count !== 500 || nextCursor === null || list.length === 20))) throw new Error("券范围搜索游标不匹配");
  return { couponId, title: row.coupon_title, scopeType: row.scope_type, ...expected, list, nextCursor,
    scannedCount: row.scanned_count, scanLimitReached: row.scan_limit_reached };
}
export const emptyCouponSearch = (): CouponSearchState => ({ couponId: 0, title: "", scopeType: 0, ...defaultCouponSearch(), list: [], nextCursor: null,
  scannedCount: 0, totalScanned: 0, scanLimitReached: false, loading: false, loaded: false, error: "" });

/** Query changes invalidate outstanding work. Opaque cursors are positions, never client-side sort keys. */
export class CouponSearchSession {
  private generation = 0;
  private state = emptyCouponSearch();
  private cursors = new Set<string>();
  constructor(private readonly fetch: (id: number, options: CouponSearchOptions, cursor?: string) => Promise<CouponSearchPage>,
    private readonly publish: (state: CouponSearchState) => void) {}
  reset() { this.generation++; this.cursors.clear(); this.state = emptyCouponSearch(); this.publish(this.state); }
  async load(couponId: number, options: CouponSearchOptions, append = false) {
    if (append && (this.state.couponId !== couponId || this.state.loading || this.state.nextCursor === null
      || options.keyword !== this.state.keyword || options.sort !== this.state.sort)) return;
    const generation = ++this.generation, prior = append ? this.state : emptyCouponSearch(), cursor = append ? prior.nextCursor! : undefined;
    if (!append) this.cursors.clear();
    this.state = { ...prior, ...options, couponId, loading: true, error: "" }; this.publish(this.state);
    try {
      couponProductId(couponId); const expected = couponSearchOptions(options.keyword, options.sort);
      const page = await this.fetch(couponId, expected, cursor);
      if (generation !== this.generation) return;
      if (page.couponId !== couponId || page.keyword !== expected.keyword || page.sort !== expected.sort
        || (append && (page.title !== prior.title || page.scopeType !== prior.scopeType))) throw new Error("优惠券搜索条件已变化，请刷新");
      const seenIds = new Set(prior.list.map(item => item.id));
      if (page.list.some(item => seenIds.has(item.id)) || (page.nextCursor !== null && this.cursors.has(page.nextCursor))) throw new Error("商品目录或游标已变化，请刷新后重试");
      if (page.nextCursor !== null) this.cursors.add(page.nextCursor);
      this.state = { ...page, list: [...prior.list, ...page.list], totalScanned: prior.totalScanned + page.scannedCount, loading: false, loaded: true, error: "" };
    } catch (error) {
      if (generation !== this.generation) return;
      this.state = { ...prior, ...options, couponId, loading: false, error: error instanceof Error ? error.message : "券范围搜索失败" };
    }
    this.publish(this.state);
  }
}
