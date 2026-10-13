import { sql, type SQL } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { systemAdmin, systemLog } from '@/models/schema';
import { ApiErrorCode, AuthException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { AdminPermissionService, hasAdminPermission } from './AdminPermissionService';
import { CITY_DELIVERY_PRIVATE_LOG_TYPES } from '@/services/delivery/CityDeliverySettingsResolver';

export interface AdminLegacySystemLogActor { id: number; authVersion: string; expiresAt: number }
export interface LegacySystemLogRow {
  id: number; store_id: number; admin_id: number; admin_name: string; path: string; page: string;
  method: string; ip: string; type: string; add_time: number;
}
interface LogQuery { page: number; limit: number; offset: number; adminId?: number;
  pages?: string; path?: string; ip?: string; start?: number; end?: number }
const MAX_ID = 2_147_483_647;
const DAY = 86_400;

function invalid(): never { throw new ValidateException('系统日志查询参数错误'); }
function positiveInteger(value: string, max: number): number {
  if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > max) invalid();
  return Number(value);
}
function literalPattern(raw: string, max: number): string | undefined {
  if (raw.length > max || /[\u0000-\u001f\u007f]/u.test(raw)) invalid();
  const value = raw.trim();
  return value ? `%${value.replace(/[\\%_]/g, '\\$&')}%` : undefined;
}
type ShanghaiWall = { year: number; month: number; day: number; hour: number; minute: number; second: number };
const shanghaiClock = new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', { timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function shanghaiWallAt(seconds: number): ShanghaiWall {
  const parts = Object.fromEntries(shanghaiClock.formatToParts(new Date(seconds * 1000)).map(part => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}
function nominalSecond(wall: ShanghaiWall): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) / 1000;
}
/** A bounded inverse of named-zone formatting for the supported 1970–2038
 * log timestamps. Shanghai's historical DST offsets are sampled on both sides
 * of the wall date; every candidate must roundtrip exactly. Never pick one of
 * two repeated clocks, or normalize a clock in a spring-forward gap. */
function shanghaiWallSecond(wall: ShanghaiWall): number {
  const nominal = nominalSecond(wall), offsets = new Set<number>(), candidates = new Set<number>();
  for (const day of [-2, -1, 0, 1, 2]) {
    const probe = nominal + day * DAY;
    offsets.add(nominalSecond(shanghaiWallAt(probe)) - probe);
  }
  for (const offset of offsets) {
    const candidate = nominal - offset, actual = shanghaiWallAt(candidate);
    if ((Object.keys(wall) as Array<keyof ShanghaiWall>).every(key => actual[key] === wall[key])) candidates.add(candidate);
  }
  if (candidates.size !== 1) throw new ValidateException('系统日志时间不存在或不唯一');
  return [...candidates][0];
}
function shanghaiCalendarSecond(year: number, zeroMonth: number, day: number, hour = 0, minute = 0, second = 0): number {
  const date = new Date(Date.UTC(year, zeroMonth, day));
  return shanghaiWallSecond({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1,
    day: date.getUTCDate(), hour, minute, second });
}
function dateValue(raw: string): { seconds: number; midnight: boolean } {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw.trim());
  if (!match) invalid();
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const hour = Number(match[4] ?? 0), minute = Number(match[5] ?? 0), second = Number(match[6] ?? 0);
  const utc = Date.UTC(year, month - 1, day, hour, minute, second), date = new Date(utc);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59 || year < 1970 || year > 2038) invalid();
  const seconds = shanghaiWallSecond({ year, month, day, hour, minute, second });
  if (seconds < 0 || seconds > MAX_ID) invalid();
  return { seconds, midnight: hour === 0 && minute === 0 && second === 0 };
}

/** Old DatePicker sends yyyy/MM/dd-yyyy/MM/dd; calendar periods use Asia/Shanghai. */
function timeBounds(value: string, now: number): Pick<LogQuery, 'start' | 'end'> {
  if (!value) return {};
  const local = shanghaiWallAt(now);
  const year = local.year, month = local.month - 1, day = local.day;
  const boundary = shanghaiCalendarSecond;
  if (value === 'lately7' || value === 'lately30') {
    const days = value === 'lately7' ? 7 : 30;
    return { start: Math.max(0, boundary(year, month, day - days, local.hour, local.minute, local.second)), end: now + 1 };
  }
  const monday = day - ((new Date(Date.UTC(year, month, day)).getUTCDay() + 6) % 7);
  const periods: Record<string, () => [number, number]> = {
    today: () => [boundary(year, month, day), boundary(year, month, day + 1)],
    yesterday: () => [boundary(year, month, day - 1), boundary(year, month, day)],
    week: () => [boundary(year, month, monday), boundary(year, month, monday + 7)],
    'last week': () => [boundary(year, month, monday - 7), boundary(year, month, monday)],
    month: () => [boundary(year, month, 1), boundary(year, month + 1, 1)],
    'last month': () => [boundary(year, month - 1, 1), boundary(year, month, 1)],
    year: () => [boundary(year, 0, 1), boundary(year + 1, 0, 1)],
    'last year': () => [boundary(year - 1, 0, 1), boundary(year, 0, 1)],
    // ModelTrait::getMonth() ends at the last calendar day's midnight, and
    // whereBetween includes that exact second rather than the whole last day.
    quarter: () => [boundary(year, Math.floor(month / 3) * 3, 1), boundary(year, Math.floor(month / 3) * 3 + 3, 0) + 1],
  };
  if (Object.hasOwn(periods, value)) {
    const [start, end] = periods[value]();
    return { start, end };
  }
  const match = /^((?:\d{4}\/\d{2}\/\d{2})(?: \d{2}:\d{2}(?::\d{2})?)?)?-((?:\d{4}\/\d{2}\/\d{2})(?: \d{2}:\d{2}(?::\d{2})?)?)?$/.exec(value);
  if (!match || (!match[1] && !match[2])) invalid();
  // strtotime's epoch zero is false in the PHP searcher's bound checks.
  const first = match[1] ? dateValue(match[1]).seconds : undefined;
  const final = match[2] ? dateValue(match[2]) : undefined;
  const start = first === 0 ? undefined : first;
  const last = final?.seconds === 0 ? undefined : final;
  // Reject explicitly reversed nonzero endpoints before PHP's day expansion.
  if (start !== undefined && last && last.seconds < start) invalid();
  // The legacy two-ended query uses inclusive BETWEEN after expanding an
  // equal or midnight endpoint by one day. An end-only query instead always
  // adds one day and uses strict <, including when the endpoint has a time.
  const end = last ? start === undefined ? last.seconds + DAY
    : last.seconds + (last.midnight || last.seconds === start ? DAY : 0) + 1 : undefined;
  if (end !== undefined && (end > MAX_ID + 1 || start !== undefined && end <= start)) invalid();
  return { start, end };
}

export function parseLegacySystemLogQuery(query: URLSearchParams, now = Math.floor(Date.now() / 1000)): LogQuery {
  const allowed = ['page', 'limit', 'pages', 'path', 'ip', 'admin_id', 'data'];
  for (const key of query.keys()) if (!allowed.includes(key) || query.getAll(key).length !== 1) invalid();
  const page = query.has('page') ? positiveInteger(query.get('page')!, 1001) : 1;
  const limit = query.has('limit') ? positiveInteger(query.get('limit')!, 100) : 20;
  const offset = (page - 1) * limit;
  if (offset > 20_000) invalid();
  const rawAdmin = query.get('admin_id') ?? '', rawTime = query.get('data') ?? '';
  if (rawTime.length > 64 || /[\u0000-\u001f\u007f]/u.test(rawTime)) invalid();
  return { page, limit, offset, adminId: rawAdmin && rawAdmin !== '0' ? positiveInteger(rawAdmin, MAX_ID) : undefined,
    pages: literalPattern(query.get('pages') ?? '', 64), path: literalPattern(query.get('path') ?? '', 128),
    ip: literalPattern(query.get('ip') ?? '', 45), ...timeBounds(rawTime, now) };
}

function assertClaims(actor: AdminLegacySystemLogActor): void {
  if (!Number.isSafeInteger(actor.id) || actor.id <= 0 || actor.id > MAX_ID
    || typeof actor.authVersion !== 'string' || !/^[a-f0-9]{32}$/.test(actor.authVersion)
    || !Number.isSafeInteger(actor.expiresAt) || actor.expiresAt <= 0) throw new AuthException('请重新登录', ApiErrorCode.ERR_LOGIN);
  if (actor.expiresAt <= Math.floor(Date.now() / 1000)) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
}

/** Separate legacy DTO, with no retention cleanup or other GET side effects. */
export class AdminLegacySystemLogService {
  constructor(private readonly container: Container) {}

  private async snapshot<T>(actor: AdminLegacySystemLogActor, read: (tx: DbClient, level: number) => Promise<T>): Promise<T> {
    assertClaims(actor);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
      await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
      const [live] = await tx.execute(sql`SELECT id,pwd,admin_type,relation_id,status,is_del,level,roles FROM ${systemAdmin}
        WHERE id=${actor.id} LIMIT 1`) as unknown as Array<{
          id: number; pwd: string; admin_type: number; relation_id: number; status: number; is_del: number; level: number; roles: string;
        }>;
      if (!live || live.admin_type !== 1 || live.relation_id !== 0 || live.status !== 1 || live.is_del !== 0
        || !Number.isInteger(live.level) || live.level < 0 || live.level > 9) throw new AuthException('管理员身份已变化', ApiErrorCode.ERR_BANNED);
      const encoder = new TextEncoder();
      if (!timingSafeEqual(encoder.encode(md5(live.pwd)), encoder.encode(actor.authVersion))) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
      if (live.level !== 0) {
        const { keys } = await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(live.roles);
        if (!hasAdminPermission(keys, 'log.view')) throw new AuthException('系统日志权限已变化', ApiErrorCode.ERR_AUTH);
      }
      assertClaims(actor);
      const result = await read(tx, live.level);
      assertClaims(actor);
      return result;
    });
  }

  async adminOptions(query: URLSearchParams, actor: AdminLegacySystemLogActor): Promise<{ info: Array<{ id: number; real_name: string }> }> {
    if ([...query.keys()].length) invalid();
    return this.snapshot(actor, async (tx, level) => {
      const info = await tx.execute(sql`SELECT id,real_name FROM ${systemAdmin}
        WHERE level>=${level} AND admin_type=1 AND relation_id=0 ORDER BY id LIMIT 1001`) as unknown as Array<{ id: number; real_name: string }>;
      if (info.length > 1000) throw new ServiceUnavailableException('管理员搜索条件超出读取上限');
      return { info };
    });
  }

  async list(query: URLSearchParams, actor: AdminLegacySystemLogActor): Promise<{ list: LegacySystemLogRow[]; count: number }> {
    const filter = parseLegacySystemLogQuery(query);
    return this.snapshot(actor, async (tx, level) => {
      const conditions: SQL[] = [sql`admin_id IN (SELECT id FROM ${systemAdmin} WHERE level>=${level} AND admin_type=1 AND relation_id=0)`,
        sql`store_id=0`, sql`merchant_id=0`, sql`type NOT IN (${sql.join(CITY_DELIVERY_PRIVATE_LOG_TYPES.map(type => sql`${type}`), sql`,`)})`];
      if (filter.adminId !== undefined) conditions.push(sql`admin_id=${filter.adminId}`);
      if (filter.pages) conditions.push(sql`page LIKE ${filter.pages}`);
      if (filter.path) conditions.push(sql`path LIKE ${filter.path}`);
      if (filter.ip) conditions.push(sql`ip LIKE ${filter.ip}`);
      if (filter.start !== undefined) conditions.push(sql`add_time>=${filter.start}`);
      if (filter.end !== undefined) conditions.push(sql`add_time<${filter.end}`);
      const where = sql.join(conditions, sql` AND `);
      const [countRow] = await tx.execute(sql`SELECT count(*)::integer AS count FROM ${systemLog} WHERE ${where}`) as unknown as Array<{ count: number }>;
      if (!countRow || !Number.isSafeInteger(countRow.count) || countRow.count < 0) throw new Error('Invalid system log count');
      const list = await tx.execute(sql`SELECT id,store_id,admin_id,admin_name,path,page,method,ip,type,add_time
        FROM ${systemLog} WHERE ${where} ORDER BY add_time DESC,id DESC LIMIT ${filter.limit} OFFSET ${filter.offset}`) as unknown as LegacySystemLogRow[];
      return { list, count: countRow.count };
    });
  }
}
