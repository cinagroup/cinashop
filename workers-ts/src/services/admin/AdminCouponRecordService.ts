import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { storeCouponIssue, storeCouponUser, user } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

export interface AdminCouponRecordQuery {
  page: number;
  limit: number;
  status?: 0 | 1 | 2 | 3;
  nickname: string;
  couponTitle: string;
}

const sourceLabels: Readonly<Record<string, string>> = {
  send: "后台发放",
  get: "手动领取",
  newcomer: "新人礼赠送",
  activate_level: "会员卡激活赠送",
  user_first: "用户注册赠送",
  order: "下单赠送",
  luck_lottery: "抽奖赠送",
  lottery: "抽奖赠送",
};
const statusLabels: Readonly<Record<number, string>> = {
  0: "未使用", 1: "已使用", 2: "已过期", 3: "未支付订单占用中",
};

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number, field: string): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/u.test(raw)) throw new ValidateException(`${field}无效`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ValidateException(`${field}无效`);
  return value;
}

function keyword(raw: string | undefined, field: string): string {
  const value = (raw ?? "").trim();
  if (value.length > 100 || /[\u0000-\u001f\u007f]/u.test(value)) throw new ValidateException(`${field}无效`);
  return value;
}

export function parseAdminCouponRecordQuery(raw: Record<string, string>): AdminCouponRecordQuery {
  const statusRaw = raw.status?.trim();
  if (statusRaw && !["0", "1", "2", "3"].includes(statusRaw)) throw new ValidateException("优惠券状态无效");
  return {
    page: boundedInteger(raw.page, 1, 1, 10_000, "页码"),
    limit: boundedInteger(raw.limit, 15, 1, 100, "每页数量"),
    status: statusRaw ? Number(statusRaw) as 0 | 1 | 2 | 3 : undefined,
    nickname: keyword(raw.nickname, "领取人"),
    couponTitle: keyword(raw.coupon_title, "优惠券名称"),
  };
}

function literalLike(value: string): string {
  return `%${value.replace(/[\\%_]/gu, "\\$&")}%`;
}

/** Global, read-only claim history. Its status is independent of is_fail and live wallet usability. */
export class AdminCouponRecordService {
  constructor(private readonly container: Container) {}

  async list(query: AdminCouponRecordQuery) {
    const predicates: SQL[] = [];
    if (query.status !== undefined) predicates.push(eq(storeCouponUser.status, query.status));
    if (query.couponTitle) predicates.push(ilike(storeCouponUser.couponTitle, literalLike(query.couponTitle)));
    if (query.nickname) {
      const pattern = literalLike(query.nickname);
      // PHP's member filter searches the user table, so an orphan claim remains visible
      // in the unfiltered list but cannot match a member keyword.
      predicates.push(or(
        sql`${user.uid}::text ILIKE ${pattern}`,
        ilike(user.realName, pattern),
        ilike(user.nickname, pattern),
        ilike(user.account, pattern),
        ilike(user.phone, pattern),
      )!);
    }
    const where = predicates.length ? and(...predicates) : undefined;
    const [rows, totals] = await Promise.all([
      this.container.db.select({
        id: storeCouponUser.id,
        uid: storeCouponUser.uid,
        couponTitle: storeCouponUser.couponTitle,
        nickname: sql<string>`COALESCE(${user.nickname}, '')`,
        couponPrice: storeCouponUser.couponPrice,
        useMinPrice: storeCouponUser.useMinPrice,
        couponType: sql<number | null>`CASE WHEN ${storeCouponIssue.type} IN (1, 2) THEN ${storeCouponIssue.type} ELSE NULL END`,
        startTime: storeCouponUser.startTime,
        endTime: storeCouponUser.endTime,
        receiveSource: storeCouponUser.receiveSource,
        isFail: storeCouponUser.isFail,
        status: storeCouponUser.status,
      }).from(storeCouponUser)
        .leftJoin(user, eq(user.uid, storeCouponUser.uid))
        .leftJoin(storeCouponIssue, eq(storeCouponIssue.id, storeCouponUser.issueCouponId))
        .where(where).orderBy(desc(storeCouponUser.id))
        .limit(query.limit).offset((query.page - 1) * query.limit),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` }).from(storeCouponUser)
        .leftJoin(user, eq(user.uid, storeCouponUser.uid)).where(where),
    ]);
    return {
      list: rows.map((row) => ({
        id: row.id,
        uid: row.uid,
        coupon_title: row.couponTitle,
        nickname: row.nickname,
        coupon_price: row.couponPrice,
        use_min_price: row.useMinPrice,
        coupon_type: row.couponType,
        start_time: row.startTime?.toISOString() ?? null,
        end_time: row.endTime?.toISOString() ?? null,
        receive_source: row.receiveSource,
        receive_source_label: sourceLabels[row.receiveSource] ?? "其他获取方式",
        is_fail: row.isFail,
        status: row.status,
        status_label: statusLabels[row.status] ?? "未知状态",
      })),
      count: totals[0]?.count ?? 0,
      page: query.page,
      limit: query.limit,
    };
  }
}
