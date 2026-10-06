import { and, desc, eq, gte, inArray, like, lte, sql, type SQL } from "drizzle-orm";
import { withTx, type Container, type DbClient } from "@/lib/di";
import { systemAdmin, systemLog } from "@/models/schema";
import { ValidateException } from "@/utils/errors";
import { CITY_DELIVERY_PRIVATE_LOG_TYPES } from '@/services/delivery/CityDeliverySettingsResolver';

const allowed = new Set(["page", "limit", "admin_id", "path", "ip", "start_time", "end_time"]);

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^\d{1,10}$/.test(value)) throw new ValidateException("日志查询参数错误");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new ValidateException("日志查询参数错误");
  return number;
}

function queryValues(search: URLSearchParams): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of search) {
    if (!allowed.has(key) || Object.hasOwn(values, key)) throw new ValidateException("日志查询参数错误");
    values[key] = value;
  }
  return values;
}

function contains(value: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\x00-\x1f\x7f]/.test(trimmed)) throw new ValidateException("日志查询参数错误");
  // Old search uses LIKE %value%; treat user input as literal text, not wildcards.
  return `%${trimmed.replace(/[\\%_]/g, "\\$&")}%`;
}

/** Server-side operation log only; the old browser Vuex event log is separate. */
export class AdminSystemLogReadService {
  constructor(private readonly container: Container) {}

  private snapshot<T>(read: (db: DbClient) => Promise<T>): Promise<T> {
    return withTx(this.container, async db => {
      await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await db.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      return read(db);
    });
  }

  async adminOptions(actorLevel: number) {
    if (!Number.isInteger(actorLevel) || actorLevel < 0) throw new ValidateException("管理员身份错误");
    return this.snapshot(async db => {
      const options = await db.select({ id: systemAdmin.id, real_name: systemAdmin.realName })
        .from(systemAdmin).where(gte(systemAdmin.level, actorLevel))
        .orderBy(systemAdmin.id).limit(1001);
      if (options.length > 1000) throw new ValidateException("管理员数量过多，请联系管理员");
      return { info: options };
    });
  }

  async list(search: URLSearchParams, actorLevel: number) {
    if (!Number.isInteger(actorLevel) || actorLevel < 0) throw new ValidateException("管理员身份错误");
    const query = queryValues(search);
    const page = integer(query.page, 1, 1, 1001);
    const limit = integer(query.limit, 20, 1, 100);
    if ((page - 1) * limit > 20_000) throw new ValidateException("日志查询页码过大");
    const start = query.start_time === undefined ? undefined : integer(query.start_time, 0, 0, 2_147_483_647);
    const end = query.end_time === undefined ? undefined : integer(query.end_time, 0, 0, 2_147_483_647);
    if ((start === undefined) !== (end === undefined) || (start !== undefined && end !== undefined && start > end)) {
      throw new ValidateException("日志时间范围错误");
    }
    const conditions: SQL[] = [sql`${systemLog.type} NOT IN (${sql.join(CITY_DELIVERY_PRIVATE_LOG_TYPES.map(type => sql`${type}`), sql`, `)})`, inArray(systemLog.adminId, this.container.db.select({ id: systemAdmin.id })
      .from(systemAdmin).where(gte(systemAdmin.level, actorLevel)))];
    if (query.admin_id !== undefined && query.admin_id !== "") {
      conditions.push(eq(systemLog.adminId, integer(query.admin_id, 0, 1, 2_147_483_647)));
    }
    if (query.path !== undefined && query.path !== "") conditions.push(like(systemLog.path, contains(query.path, 128)));
    if (query.ip !== undefined && query.ip !== "") conditions.push(like(systemLog.ip, contains(query.ip, 45)));
    if (start !== undefined) conditions.push(gte(systemLog.addTime, start));
    if (end !== undefined) conditions.push(lte(systemLog.addTime, end));
    const predicate = and(...conditions);
    return this.snapshot(async db => {
      const list = await db.select({
        id: systemLog.id,
        admin_id: systemLog.adminId,
        admin_name: systemLog.adminName,
        path: systemLog.path,
        page: systemLog.page,
        action: systemLog.action,
        ip: systemLog.ip,
        type: systemLog.type,
        add_time: systemLog.addTime,
      }).from(systemLog).where(predicate)
        .orderBy(desc(systemLog.addTime), desc(systemLog.id)).limit(limit).offset((page - 1) * limit);
      const [count] = await db.select({ total: sql<number>`COUNT(*)::integer` }).from(systemLog).where(predicate);
      return { list, total: count?.total ?? 0, count: count?.total ?? 0, page, limit };
    });
  }
}
