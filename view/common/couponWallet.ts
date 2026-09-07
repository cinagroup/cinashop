import { quoteMoney } from "./checkoutQuote";

export interface OwnedCoupon {
  id: number;
  title: string;
  benefit: string;
  minimum: string;
  scope: string;
  validity: string;
  availability: "available" | "future" | "used" | "expired" | "invalid" | "reserved";
  message: string;
  rule?: string;
  ruleTruncated?: boolean;
  /** Present only for an order-specific server preview, never a client-calculated total. */
  estimatedDiscount?: string;
  eligibleSubtotal?: string;
}
export interface CouponCounts { not_used: number; used: number; expired: number; reserved: number }
export interface CouponPage { list: OwnedCoupon[]; nextCursor: number | null; counts?: CouponCounts }

export function normalizeCouponCounts(value: unknown): CouponCounts {
  const row = record(value);
  for (const key of ["not_used", "used", "expired", "reserved"]) {
    if (typeof row[key] !== "number" || !Number.isSafeInteger(row[key]) || row[key] < 0) throw new Error("优惠券数量无效");
  }
  return { not_used: Number(row.not_used), used: Number(row.used), expired: Number(row.expired), reserved: Number(row.reserved) };
}

const states = ["available", "future", "used", "expired", "invalid", "reserved"] as const;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("优惠券数据无效");
  return value as Record<string, unknown>;
}
function id(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("优惠券标识无效");
  return value;
}
function date(value: unknown): string {
  if (value === null) return "不限";
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("优惠券有效期无效");
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}
export function normalizeCouponPage(value: unknown, cursor: unknown): CouponPage {
  if (!Array.isArray(value) || value.length > 100) throw new Error("优惠券列表无效");
  const list = value.map((entry): OwnedCoupon => {
    const row = record(entry);
    const amount = quoteMoney(row.coupon_price);
    const minimum = quoteMoney(row.use_min_price);
    if (typeof row.availability !== "string" || !states.includes(row.availability as OwnedCoupon["availability"])) throw new Error("优惠券状态无效");
    if (typeof row.coupon_type !== "number" || ![1, 2].includes(row.coupon_type)) throw new Error("优惠券类型无效");
    const discount = row.coupon_type === 2;
    const percentage = BigInt(amount.split(".")[0]);
    if (discount && (Number(amount) <= 0 || Number(amount) > 100)) throw new Error("优惠券折扣无效");
    const benefit = discount ? `${Number(percentage) / 10}折` : `¥${amount}`;
    const scope = ["通用券", "品类券", "商品券", "品牌券"][Number(row.applicable_type)] ?? "范围配置异常";
    if (typeof row.coupon_title !== "string" || typeof row.availability_message !== "string") throw new Error("优惠券说明无效");
    if (row.rule !== undefined && (typeof row.rule !== "string" || row.rule.length > 8000)) throw new Error("优惠券规则无效");
    if (row.rule_truncated !== undefined && typeof row.rule_truncated !== "boolean") throw new Error("优惠券规则无效");
    return { id: id(row.id), title: row.coupon_title, benefit, minimum, scope,
      ...(row.rule !== undefined ? { rule: row.rule as string, ruleTruncated: row.rule_truncated === true } : {}),
      validity: `${date(row.start_time)} 至 ${date(row.end_time)}`, availability: row.availability as OwnedCoupon["availability"], message: row.availability_message };
  });
  if (new Set(list.map((row) => row.id)).size !== list.length) throw new Error("优惠券列表重复");
  let nextCursor: number | null = null;
  if (cursor !== undefined && cursor !== null && cursor !== "") {
    if (typeof cursor !== "string" || !/^\d+$/.test(cursor)) throw new Error("优惠券分页标识无效");
    nextCursor = id(Number(cursor));
    if (list[list.length - 1]?.id !== nextCursor) throw new Error("优惠券分页标识不匹配");
  }
  return { list, nextCursor };
}

export interface CouponWalletState extends CouponPage { loading: boolean; error: string }
/** Both tab switches and page changes discard late responses, including late failures. */
export class CouponWalletSession {
  private generation = 0;
  private status = 0;
  private state: CouponWalletState = { list: [], nextCursor: null, loading: false, error: "" };
  constructor(private readonly fetchPage: (status: number, before?: number) => Promise<CouponPage>, private readonly publish: (state: CouponWalletState) => void) {}
  reset() { this.generation++; this.state = { list: [], nextCursor: null, loading: false, error: "" }; this.publish(this.state); }
  async load(status: number, append = false) {
    if (append && (status !== this.status || this.state.loading || this.state.nextCursor === null)) return;
    const generation = ++this.generation;
    const prior = append ? this.state.list : [];
    const before = append ? this.state.nextCursor! : undefined;
    this.status = status;
    const counts = append ? this.state.counts : undefined;
    this.state = { list: prior, nextCursor: before ?? null, loading: true, error: "", ...(counts ? { counts } : {}) }; this.publish(this.state);
    try {
      const page = await this.fetchPage(status, before);
      if (generation !== this.generation) return;
      if (before && page.list.some((row) => row.id >= before)) throw new Error("优惠券分页顺序无效");
      this.state = { list: [...prior, ...page.list], nextCursor: page.nextCursor, loading: false, error: "", ...(page.counts || counts ? { counts: page.counts ?? counts } : {}) };
    } catch (error) {
      if (generation !== this.generation) return;
      this.state = { list: prior, nextCursor: before ?? null, loading: false, error: error instanceof Error ? error.message : "优惠券加载失败", ...(counts ? { counts } : {}) };
    }
    this.publish(this.state);
  }
}
