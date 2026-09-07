import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { storeCouponIssue, storeCouponUser } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

type Coupon = typeof storeCouponUser.$inferSelect;
type Issue = typeof storeCouponIssue.$inferSelect;

export type WalletFilter = -1 | 0 | 1 | 2 | 3 | null;
export function couponWalletFilter(query: Record<string, string | undefined>): WalletFilter {
  const parse = (value: string | undefined): WalletFilter => {
    if (value === undefined || value === "") return null;
    if (!["-1", "0", "1", "2", "3"].includes(value)) throw new ValidateException("优惠券筛选参数无效");
    return Number(value) as Exclude<WalletFilter, null>;
  };
  const type = parse(query.type), alias = parse(query.issue_type);
  if (query.type !== undefined && query.issue_type !== undefined && type !== alias) throw new ValidateException("优惠券筛选参数冲突");
  return query.type !== undefined ? type : alias;
}

function walletStatusWhere(status: number, now: Date): SQL {
  if (status === 0) return sql`${storeCouponUser.status} = 0 AND ${storeCouponUser.isFail} = 0
    AND ${storeCouponIssue.id} IS NOT NULL AND ${storeCouponIssue.type} IN (1, 2) AND ${storeCouponIssue.couponType} IN (0, 1, 2, 3)
    AND (${storeCouponUser.endTime} IS NULL OR ${storeCouponUser.endTime} >= ${now.toISOString()})`;
  if (status === 2) return sql`${storeCouponUser.status} NOT IN (1, 3) AND
    (${storeCouponUser.status} <> 0 OR ${storeCouponUser.isFail} <> 0 OR ${storeCouponUser.endTime} < ${now.toISOString()}
    OR ${storeCouponIssue.id} IS NULL OR ${storeCouponIssue.type} NOT IN (1, 2) OR ${storeCouponIssue.couponType} NOT IN (0, 1, 2, 3))`;
  return eq(storeCouponUser.status, status);
}

function walletFilterWhere(filter: WalletFilter, now: Date): SQL {
  if (filter === null) return sql`true`;
  // Correct the PHP DAO's reversed >= tomorrow predicate. Expired and unlimited coupons are not imminent.
  if (filter === -1) return sql`${storeCouponUser.endTime} >= ${now.toISOString()}
    AND ${storeCouponUser.endTime} <= ${new Date(now.getTime() + 86400000).toISOString()}`;
  return eq(storeCouponIssue.couponType, filter);
}

export function couponWalletQuery(pathStatus: unknown, query: Record<string, string | undefined>) {
  const integer = (value: unknown, fallback: number, min: number, max: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^\d+$/.test(value)) throw new ValidateException("优惠券查询参数无效");
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < min || result > max) throw new ValidateException("优惠券查询参数无效");
    return result;
  };
  // Existing UniApp uses /user/0?status=1; preserve that explicit override.
  const status = integer(query.status ?? pathStatus, 0, 0, 3);
  const limit = integer(query.limit, 20, 1, 100);
  const before = integer(query.before, 0, 0, Number.MAX_SAFE_INTEGER);
  const page = integer(query.page, 1, 1, 1000);
  if (before && page !== 1) throw new ValidateException("优惠券分页方式不能混用");
  return { status, limit, before, page, filter: couponWalletFilter(query) };
}

export function projectOwnedCoupon(coupon: Coupon, issue: Issue | null, now = new Date()) {
  // Used/reserved are not made reusable when the validity window passes.
  const state = coupon.status === 1 ? "used" : coupon.status === 3 ? "reserved"
    : coupon.status === 2 ? "expired" : coupon.status !== 0 || coupon.isFail !== 0 ? "invalid"
    : coupon.endTime && coupon.endTime.getTime() < now.getTime() ? "expired"
    : !issue || ![0, 1, 2, 3].includes(issue.couponType) || ![1, 2].includes(issue.type) ? "invalid"
    : coupon.startTime && coupon.startTime.getTime() > now.getTime() ? "future" : "available";
  const message = { used: "已使用", reserved: "未支付订单占用中", invalid: "已失效", expired: "已过期", future: "未开始", available: "未使用，适用范围以结算报价为准" }[state];
  const start = coupon.startTime?.toISOString() ?? null;
  const end = coupon.endTime?.toISOString() ?? null;
  return {
    // Preserve existing camelCase consumers; v1 user-coupon snake_case follows PHP, not v2 catalogue meanings.
    ...coupon,
    coupon_title: coupon.couponTitle, coupon_price: coupon.couponPrice, use_min_price: coupon.useMinPrice,
    coupon_type: issue?.type ?? coupon.type, applicable_type: issue?.couponType ?? -1,
    start_time: start, end_time: end, add_time: start, receive_type: issue?.receiveType ?? 0,
    receive_source: coupon.receiveSource, is_fail: coupon.isFail,
    rule: issue?.rule?.slice(0, 8000) ?? "", rule_truncated: (issue?.rule?.length ?? 0) > 8000,
    availability: state, availability_message: message, pc_type: state === "available" || state === "future" ? 1 : 0, pc_msg: message,
  };
}

/** Read-only, owner-bound wallet. The checkout service remains authoritative for scope, thresholds and consumption. */
export class UserCouponWalletService {
  constructor(private readonly container: Container) {}
  async list(uid: number, options: ReturnType<typeof couponWalletQuery>, now = new Date()) {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("请先登录");
    const { status, limit, before, page, filter } = options;
    const where: SQL[] = [eq(storeCouponUser.uid, uid), walletStatusWhere(status, now), walletFilterWhere(filter, now)];
    if (before) where.push(lt(storeCouponUser.id, before));
    const rows = await this.container.db.select({ coupon: storeCouponUser, issue: storeCouponIssue })
      .from(storeCouponUser).leftJoin(storeCouponIssue, eq(storeCouponIssue.id, storeCouponUser.issueCouponId))
      .where(and(...where)).orderBy(desc(storeCouponUser.id)).limit(limit + 1).offset((page - 1) * limit);
    const visible = rows.slice(0, limit);
    return { list: visible.map(({ coupon, issue }) => projectOwnedCoupon(coupon, issue, now)),
      nextCursor: rows.length > limit ? visible[visible.length - 1]!.coupon.id : null };
  }
  async counts(uid: number, filter: WalletFilter = null, now = new Date()) {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("请先登录");
    const count = (status: number) => sql<number>`count(*) filter (where ${walletStatusWhere(status, now)})`.mapWith(Number);
    const [result] = await this.container.db.select({ not_used: count(0), used: count(1), expired: count(2), reserved: count(3) })
      .from(storeCouponUser).leftJoin(storeCouponIssue, eq(storeCouponIssue.id, storeCouponUser.issueCouponId))
      .where(and(eq(storeCouponUser.uid, uid), walletFilterWhere(filter, now)));
    return result!;
  }
}
