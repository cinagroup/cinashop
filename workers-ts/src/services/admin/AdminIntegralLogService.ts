import { and, desc, eq, gte, ilike, lte, or, sql, type SQL } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { user as userTable, userBill } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

export interface AdminIntegralLogQuery {
  page: number;
  limit: number;
  keyword: string;
  type: string;
  start: number;
  stop: number;
}

function boundedInteger(value: string | undefined, field: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new ValidateException(`${field}无效`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new ValidateException(`${field}无效`);
  return parsed;
}

export function parseAdminIntegralLogQuery(raw: Record<string, string>): AdminIntegralLogQuery {
  const keyword = (raw.keyword ?? "").trim();
  const type = (raw.type ?? "").trim();
  if (keyword.length > 100 || /[\u0000-\u001f\u007f]/u.test(keyword)) throw new ValidateException("搜索词无效");
  if (type && !/^[A-Za-z0-9_-]{1,64}$/u.test(type)) throw new ValidateException("积分类型无效");
  const start = boundedInteger(raw.start, "开始时间", 0, 0, 2_147_483_647);
  const stop = boundedInteger(raw.stop, "结束时间", 0, 0, 2_147_483_647);
  if (start && stop && start > stop) throw new ValidateException("时间范围无效");
  return {
    page: boundedInteger(raw.page, "页码", 1, 1, 10_000),
    limit: boundedInteger(raw.limit, "每页数量", 15, 1, 100),
    keyword,
    type,
    start,
    stop,
  };
}

function literalLike(value: string): string {
  return `%${value.replace(/[\\%_]/gu, "\\$&")}%`;
}

/** Read-only global integral ledger. Every query fixes the category before any user filter. */
export class AdminIntegralLogService {
  constructor(private readonly container: Container) {}

  private filters(query: AdminIntegralLogQuery): SQL {
    const conditions: SQL[] = [eq(userBill.category, "integral")];
    if (query.start) conditions.push(gte(userBill.addTime, query.start));
    if (query.stop) conditions.push(lte(userBill.addTime, query.stop));
    if (query.type) conditions.push(eq(userBill.type, query.type));
    if (query.keyword) {
      const pattern = literalLike(query.keyword);
      conditions.push(or(
        sql`${userBill.id}::text ILIKE ${pattern}`,
        sql`${userBill.uid}::text ILIKE ${pattern}`,
        ilike(userBill.title, pattern),
        ilike(userTable.nickname, pattern),
        ilike(userTable.account, pattern),
        ilike(userTable.phone, pattern),
      )!);
    }
    return and(...conditions)!;
  }

  async list(query: AdminIntegralLogQuery) {
    const where = this.filters(query);
    const [rows, totals] = await Promise.all([
      this.container.db.select({
        id: userBill.id,
        uid: userBill.uid,
        title: userBill.title,
        type: userBill.type,
        pm: userBill.pm,
        number: sql<string>`TRUNC(${userBill.number})::text`,
        balance: sql<string>`TRUNC(${userBill.balance})::text`,
        mark: userBill.mark,
        nickname: sql<string>`COALESCE(${userTable.nickname}, '')`,
        add_time: userBill.addTime,
      }).from(userBill).leftJoin(userTable, eq(userTable.uid, userBill.uid))
        .where(where).orderBy(desc(userBill.id))
        .limit(query.limit).offset((query.page - 1) * query.limit),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` })
        .from(userBill).leftJoin(userTable, eq(userTable.uid, userBill.uid)).where(where),
    ]);
    return { list: rows, count: totals[0]?.count ?? 0, page: query.page, limit: query.limit };
  }

  async statistics(query: AdminIntegralLogQuery) {
    const rows = await this.container.db.select({
      total_integral: sql<string>`TRUNC(COALESCE(SUM(${userBill.number}) FILTER (
        WHERE ${userBill.pm} = 1 AND ${userBill.type} NOT IN ('integral_refund', 'order_integral_refund', 'pay_product_integral_back')
      ), 0))::text`,
      sign_count: sql<string>`COUNT(*) FILTER (WHERE ${userBill.type} = 'sign')::text`,
      sign_integral: sql<string>`TRUNC(COALESCE(SUM(${userBill.number}) FILTER (WHERE ${userBill.type} = 'sign'), 0))::text`,
      used_integral: sql<string>`TRUNC(COALESCE(SUM(${userBill.number}) FILTER (WHERE ${userBill.pm} = 0), 0))::text`,
    }).from(userBill).leftJoin(userTable, eq(userTable.uid, userBill.uid)).where(this.filters(query));
    return rows[0] ?? { total_integral: "0", sign_count: "0", sign_integral: "0", used_integral: "0" };
  }
}
