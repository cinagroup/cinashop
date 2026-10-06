import { and, desc, eq, gte, ilike, inArray, lte, not, or, sql, type SQL } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { user as userTable, userMoney } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

// The old UserMoneyServices::getMoneyList excludes these business-only entries.
// Its not_category argument has no effect: user_money has no category column.
export const USER_MONEY_LEDGER_EXCLUDED_TYPES = ["gain", "system_sub", "deduction", "sign"] as const;

export interface AdminUserMoneyLedgerQuery {
  page: number;
  limit: number;
  keyword: string;
  type: string;
  start: number;
  stop: number;
}

function integerParameter(value: string | null, label: string, fallback: number, maximum: number): number {
  if (value === null) return fallback;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new ValidateException(`${label}无效`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) throw new ValidateException(`${label}无效`);
  return number;
}

export function parseAdminUserMoneyLedgerQuery(parameters: URLSearchParams, exportPage = false): AdminUserMoneyLedgerQuery {
  const allowed = new Set(["page", "limit", "keyword", "type", "start", "stop", ...(exportPage ? ["snapshot"] : [])]);
  for (const key of parameters.keys()) {
    if (!allowed.has(key) || parameters.getAll(key).length !== 1) {
      throw new ValidateException("不支持或重复的资金流水参数");
    }
  }
  const page = integerParameter(parameters.get("page"), "页码", 1, 2_147_483_647);
  const limit = integerParameter(parameters.get("limit"), "每页数量", exportPage ? 1_000 : 20, exportPage ? 1_000 : 20);
  if (page === 0 || limit === 0 || (!exportPage && limit !== 20) || (page - 1) * limit > 2_147_483_647) {
    throw new ValidateException("资金流水分页超出范围");
  }
  const keyword = (parameters.get("keyword") ?? "").trim();
  const type = (parameters.get("type") ?? "").trim();
  if ([...keyword].length > 100 || /[\u0000-\u001f\u007f]/u.test(keyword)) throw new ValidateException("资金流水搜索词无效");
  if ([...type].length > 64 || /[\u0000-\u001f\u007f]/u.test(type)) throw new ValidateException("资金流水类型无效");
  const start = integerParameter(parameters.get("start"), "开始时间", 0, 2_147_483_647);
  const stop = integerParameter(parameters.get("stop"), "结束时间", 0, 2_147_483_647);
  if ((start === 0) !== (stop === 0) || (start && start > stop)) throw new ValidateException("资金流水时间范围无效");
  return { page, limit, keyword, type, start, stop };
}

function literalLike(value: string): string {
  return `%${value.replace(/[\\%_]/gu, "\\$&")}%`;
}

export class AdminUserMoneyLedgerService {
  constructor(private readonly container: Container) {}

  filterPredicate(query: AdminUserMoneyLedgerQuery): SQL {
    const conditions: SQL[] = [not(inArray(userMoney.type, [...USER_MONEY_LEDGER_EXCLUDED_TYPES]))];
    if (query.type) conditions.push(eq(userMoney.type, query.type));
    if (query.start) conditions.push(gte(userMoney.addTime, query.start));
    if (query.stop) conditions.push(lte(userMoney.addTime, query.stop));
    if (query.keyword) {
      const pattern = literalLike(query.keyword);
      conditions.push(or(
        sql`${userMoney.uid}::text ILIKE ${pattern}`,
        ilike(userMoney.title, pattern),
        sql`${userTable.uid}::text ILIKE ${pattern}`,
        ilike(userTable.account, pattern),
        ilike(userTable.nickname, pattern),
        ilike(userTable.phone, pattern),
      )!);
    }
    return and(...conditions)!;
  }

  async list(query: AdminUserMoneyLedgerQuery) {
    const where = this.filterPredicate(query);
    const [rows, totals] = await Promise.all([
      this.container.db.select({
        id: userMoney.id,
        uid: userMoney.uid,
        nickname: sql<string>`COALESCE(${userTable.nickname}, '')`,
        pm: userMoney.pm,
        number: userMoney.number,
        title: userMoney.title,
        type: userMoney.type,
        mark: userMoney.mark,
        add_time: sql<string>`CASE WHEN ${userMoney.addTime}=0 THEN '' ELSE to_char(to_timestamp(${userMoney.addTime}) AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') END`,
      }).from(userMoney).leftJoin(userTable, eq(userTable.uid, userMoney.uid))
        .where(where).orderBy(desc(userMoney.id)).limit(query.limit).offset((query.page - 1) * query.limit),
      this.container.db.select({ count: sql<string>`COUNT(*)::text` })
        .from(userMoney).leftJoin(userTable, eq(userTable.uid, userMoney.uid)).where(where),
    ]);
    const count = Number(totals[0]?.count ?? 0);
    if (!Number.isSafeInteger(count)) throw new ValidateException("资金流水总数无效");
    return { list: rows, count, page: query.page, limit: query.limit };
  }

  async types() {
    // Old getMoneyType([]) reads the whole ledger, including types excluded by
    // the page list. DISTINCT ON makes its otherwise arbitrary title stable.
    const rows = await this.container.db.execute(sql`SELECT DISTINCT ON (type) type, title
      FROM user_money ORDER BY type, id DESC`);
    return { list: rows.map(row => ({ type: String(row.type), title: String(row.title) })) };
  }
}
