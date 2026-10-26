import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { user, userGroup, userLabel, systemUserLevel, cityArea } from '@/models/schema';
import { PublicLocationStoreService } from '@/services/system/PublicLocationStoreService';
import { ValidateException } from '@/utils/errors';

const maximumId = 2_147_483_647;
const allowed = new Set(['page', 'limit', 'uid', 'phone', 'nickname', 'group_id', 'status', 'field_key',
  'label_ids', 'label_id', 'sex', 'level', 'isMember', 'is_promoter', 'user_time', 'user_time_type',
  'pay_count', 'country', 'province', 'city', 'user_type']);
function keys(query: Record<string, unknown>, allowedKeys: ReadonlySet<string>) {
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !allowedKeys.has(key))) {
    throw new ValidateException('不支持的用户查询字段');
  }
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d{1,10}$/.test(String(value))) throw new ValidateException('用户查询整数参数错误');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new ValidateException('用户查询整数参数错误');
  return parsed;
}
function text(value: unknown, maximum: number): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > maximum * 2 || /[\u0000-\u001f\u007f]/.test(value)) throw new ValidateException('用户查询文本参数错误');
  const normalized = value.trim().normalize('NFC');
  if ([...normalized].length > maximum) throw new ValidateException('用户查询文本过长');
  return normalized;
}
function choice(value: unknown, values: readonly string[]) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || !values.includes(value)) throw new ValidateException('用户查询枚举参数错误');
  return value;
}
function ids(value: unknown) {
  if (value === undefined || value === '') return [];
  if (typeof value !== 'string' || value.length > 1099) throw new ValidateException('用户标签编号参数错误');
  const parts = value.split(',');
  if (parts.length > 100 || parts.some(part => !/^[1-9]\d{0,9}$/.test(part))) throw new ValidateException('用户标签最多100个唯一正整数');
  const result = parts.map(part => integer(part, 0, 1, maximumId));
  if (new Set(result).size !== result.length) throw new ValidateException('用户标签编号不能重复');
  return result;
}
function range(value: string, mode: string) {
  if (!value && !mode) return null;
  const match = /^(\d{4})\/(\d{2})\/(\d{2})-(\d{4})\/(\d{2})\/(\d{2})$/.exec(value);
  if (!mode || !match) throw new ValidateException('访问时间类型和日期区间须同时提供');
  const day = (offset: number) => {
    const year = Number(match[offset]), month = Number(match[offset + 1]), date = Number(match[offset + 2]);
    const utc = new Date(Date.UTC(year, month - 1, date));
    if (year < 1901 || year > 2038 || utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== date) throw new ValidateException('用户查询日期无效');
    return utc.getTime() / 1000 - 28_800;
  };
  const start = day(1), end = day(4) + 86_400;
  if (start >= end || start < -2_147_483_648 || end > maximumId) throw new ValidateException('用户查询日期区间无效');
  return { start, end };
}
export function parseAdminUserListQuery(query: Record<string, unknown>) {
  keys(query, allowed);
  if (query.label_ids !== undefined && query.label_id !== undefined) throw new ValidateException('用户标签查询别名不能同时提供');
  const fieldKey = query.field_key === undefined ? null : choice(query.field_key, ['', 'all', 'uid', 'phone', 'nickname']);
  const nickname = text(query.nickname, 100), time = text(query.user_time, 21), timeType = choice(query.user_time_type, ['', 'visitno', 'visit', 'add_time']);
  const searchUid = fieldKey === 'uid' && nickname ? integer(nickname, 0, 1, maximumId) : 0;
  return {
    page: integer(query.page, 1, 1, 10_000), limit: integer(query.limit, 10, 1, 100),
    uid: integer(query.uid, 0, 1, maximumId), groupId: integer(query.group_id, -1, 0, maximumId),
    status: integer(query.status, -1, 0, 1), phone: text(query.phone, 15), nickname, fieldKey, searchUid,
    labels: ids(query.label_ids ?? query.label_id), sex: choice(query.sex, ['', '0', '1', '2']),
    level: integer(query.level, 0, 0, maximumId), member: choice(query.isMember, ['', '0', '1']),
    promoter: choice(query.is_promoter, ['', '0', '1']), timeType, range: range(time, timeType),
    payCount: choice(query.pay_count, ['', '-1', '0', '1', '2', '3', '4']),
    country: choice(query.country, ['', 'domestic', 'abroad']), province: text(query.province, 100), city: text(query.city, 100),
    source: choice(query.user_type, ['', 'wechat', 'routine', 'h5', 'pc', 'app']),
  };
}
const pattern = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
// Explicit twelve columns + four transitional aliases. Never widen this DTO to
// credentials, documents, IP/login metadata or arbitrary imported JSON.
const listColumns = {
  uid: user.uid, account: user.account, nickname: user.nickname, phone: user.phone, avatar: user.avatar,
  integral: user.integral, level: user.level, status: user.status, nowMoney: user.nowMoney,
  addTime: user.addTime, spreadUid: user.spreadUid, groupId: user.groupId,
};
async function snapshot<T>(container: Container, read: (db: DbClient) => Promise<T>): Promise<T> {
  return withTx(container, async db => {
    await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    await db.execute(sql`SELECT set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true)`);
    return read(db);
  });
}
/** PHP fixed-source filter semantics, preserving existing TS picker/direct-ID
 * compatibility. label_ids repairs the old PHP label_id/d first-ID truncation;
 * LIKE metacharacters remain literals and explicit group0 stays ungrouped. */
export async function listAdminUsers(container: Container, raw: Record<string, unknown>) {
  const q = parseAdminUserListQuery(raw), conditions: SQL[] = [eq(user.isDel, 0), isNull(user.deleteTime)];
  if (q.uid) conditions.push(eq(user.uid, q.uid));
  if (q.groupId >= 0) conditions.push(eq(user.groupId, q.groupId));
  if (q.status >= 0) conditions.push(eq(user.status, q.status));
  if (q.phone) conditions.push(eq(user.phone, q.phone));
  if (q.nickname) {
    const value = pattern(q.nickname);
    if (q.fieldKey === 'uid') conditions.push(eq(user.uid, q.searchUid));
    else if (q.fieldKey === 'phone') conditions.push(ilike(user.phone, value));
    else if (q.fieldKey === 'nickname') conditions.push(ilike(user.nickname, value));
    else if (q.fieldKey !== null) conditions.push(or(ilike(user.nickname, value), ilike(user.phone, value), sql`${user.uid}::text LIKE ${value} ESCAPE '\\'`)!);
    else {
      const numeric = /^\d{1,10}$/.test(q.nickname) ? Number(q.nickname) : 0;
      conditions.push(or(ilike(user.nickname, value), ilike(user.phone, value), numeric > 0 && numeric <= maximumId ? eq(user.uid, numeric) : undefined)!);
    }
  }
  if (q.labels.length) conditions.push(sql`EXISTS (SELECT 1 FROM user_label_relation r WHERE r.uid=${user.uid} AND r.type=0 AND r.relation_id=0 AND r.label_id IN (${sql.join(q.labels.map(id => sql`${id}`), sql`, `)}))`);
  if (q.sex !== '') conditions.push(eq(user.sex, Number(q.sex)));
  if (q.level) conditions.push(eq(user.level, q.level));
  if (q.member === '1') conditions.push(gt(user.isMoneyLevel, 0));
  if (q.member === '0') conditions.push(eq(user.isMoneyLevel, 0));
  if (q.promoter !== '') conditions.push(eq(user.isPromoter, Number(q.promoter)));
  if (q.payCount !== '') conditions.push(q.payCount === '-1' ? eq(user.payCount, 0) : gt(user.payCount, Number(q.payCount)));
  if (q.source) conditions.push(eq(user.userType, q.source));
  if (q.range) {
    const column = q.timeType === 'add_time' ? user.addTime : user.lastTime;
    conditions.push(q.timeType === 'visitno' ? or(lt(column, q.range.start), gt(column, q.range.end))! : and(gt(column, q.range.start), lt(column, q.range.end))!);
  }
  // The original parenthesized geo block is OR within the country/province/city
  // group, then AND with every other filter. EXISTS avoids WeChat join fanout.
  const geo: SQL[] = [];
  if (q.country === 'domestic') geo.push(sql`EXISTS (SELECT 1 FROM wechat_user w WHERE w.uid=${user.uid} AND w.country IN ('中国','China'))`);
  if (q.country === 'abroad') geo.push(eq(user.addres, ''));
  if (q.province) geo.push(sql`(EXISTS (SELECT 1 FROM wechat_user w WHERE w.uid=${user.uid} AND w.province=${q.province}) OR ${user.provincials} LIKE ${pattern(q.province)} ESCAPE '\\' OR ${user.addres} LIKE ${pattern(q.province)} ESCAPE '\\')`);
  if (q.city) geo.push(sql`(EXISTS (SELECT 1 FROM wechat_user w WHERE w.uid=${user.uid} AND w.city=${q.city}) OR ${user.provincials} LIKE ${pattern(q.city)} ESCAPE '\\' OR ${user.addres} LIKE ${pattern(q.city)} ESCAPE '\\')`);
  if (geo.length) conditions.push(or(...geo)!);
  return snapshot(container, async db => {
    const where = and(...conditions);
    const [total] = await db.select({ count: sql<number>`count(*)::int` }).from(user).where(where);
    const rows = await db.select(listColumns).from(user).where(where).orderBy(desc(user.uid)).limit(q.limit).offset((q.page - 1) * q.limit);
    const list = rows.map(row => ({ ...row, now_money: row.nowMoney, add_time: row.addTime, spread_uid: row.spreadUid, group_id: row.groupId }));
    return { list, count: total.count, page: q.page, limit: q.limit };
  });
}
export function parseAdminUserOptionsQuery(raw: Record<string, unknown>) {
  keys(raw, new Set(['kind', 'page', 'limit', 'keyword', 'selected_ids']));
  const kind = choice(raw.kind, ['groups', 'labels', 'levels']);
  if (!kind) throw new ValidateException('用户筛选目录类型必填');
  return { kind, page: integer(raw.page, 1, 1, 10_000), limit: integer(raw.limit, 20, 1, 100), keyword: text(raw.keyword, 100), selected: ids(raw.selected_ids) };
}
/** Narrow read-only option catalogs under user.view; no user.manage, level or
 * supplier capability is introduced by these id/name-only projections. */
export async function adminUserFilterOptions(container: Container, raw: Record<string, unknown>) {
  const q = parseAdminUserOptionsQuery(raw);
  return snapshot(container, async db => {
    const source = q.kind === 'groups' ? { table: userGroup, id: userGroup.id, name: userGroup.groupName, scope: [] as SQL[] }
      : q.kind === 'labels' ? { table: userLabel, id: userLabel.id, name: userLabel.name, scope: [eq(userLabel.type, 0), eq(userLabel.relationId, 0), eq(userLabel.status, 1)] }
      : { table: systemUserLevel, id: systemUserLevel.id, name: systemUserLevel.name, scope: [eq(systemUserLevel.isShow, 1), eq(systemUserLevel.isDel, 0)] };
    const conditions = [...source.scope];
    if (q.keyword) conditions.push(ilike(source.name, pattern(q.keyword)));
    const [total] = await db.select({ count: sql<number>`count(*)::int` }).from(source.table).where(and(...conditions));
    const list = await db.select({ id: source.id, name: source.name }).from(source.table).where(and(...conditions)).orderBy(asc(source.id)).limit(q.limit).offset((q.page - 1) * q.limit);
    const selectedRows = q.selected.length ? await db.select({ id: source.id, name: source.name }).from(source.table).where(and(...source.scope, inArray(source.id, q.selected))) : [];
    const byId = new Map(selectedRows.map(row => [row.id, row]));
    return { list, count: total.count, page: q.page, limit: q.limit, selected: q.selected.flatMap(id => byId.has(id) ? [byId.get(id)!] : []), missing_ids: q.selected.filter(id => !byId.has(id)) };
  });
}
/** Reuse public city's bounded side-effect-free city_area reader, adapting only
 * id/label to this two-level user filter. District/street IDs cannot expand. */
export async function adminUserFilterRegions(container: Container, env: Env, raw: Record<string, unknown>) {
  keys(raw, new Set(['pid']));
  const pid = integer(raw.pid, 0, 0, maximumId);
  return snapshot(container, async db => {
    if (pid) {
      const [parent] = await db.select({ level: cityArea.level }).from(cityArea).where(eq(cityArea.id, pid)).limit(1);
      if (!parent || parent.level !== 1) throw new ValidateException('用户筛选地区父级必须为省份');
    }
    const rows = await new PublicLocationStoreService({ ...container, db }, env).city(String(pid));
    if (rows.some(row => row.level !== (pid ? 2 : 1))) throw new ValidateException('用户筛选地区层级无效');
    return rows.map(row => ({ id: row.id, name: row.label, ...(!pid && 'children' in row ? { children: [] as never[] } : {}) }));
  });
}
