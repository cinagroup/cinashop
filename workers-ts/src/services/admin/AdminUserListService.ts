import { and, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import { user } from '@/models/schema/user';
import { ValidateException } from '@/utils/errors';

const maximumId = 2_147_483_647;
const allowed = new Set(['page', 'limit', 'uid', 'phone', 'nickname', 'group_id', 'status']);

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d{1,10}$/.test(String(value))) {
    throw new ValidateException('用户查询整数参数错误');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new ValidateException('用户查询整数参数错误');
  return parsed;
}

function text(value: unknown, maximum: number): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > maximum * 2 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ValidateException('用户查询文本参数错误');
  }
  const normalized = value.trim().normalize('NFC');
  if ([...normalized].length > maximum) throw new ValidateException('用户查询文本过长');
  return normalized;
}

export function parseAdminUserListQuery(query: Record<string, unknown>) {
  if (Object.keys(query).some(key => !allowed.has(key))) throw new ValidateException('不支持的用户查询字段');
  return {
    page: integer(query.page, 1, 1, 10_000),
    limit: integer(query.limit, 10, 1, 100),
    uid: integer(query.uid, 0, 1, maximumId),
    groupId: integer(query.group_id, -1, 0, maximumId),
    status: integer(query.status, -1, 0, 1),
    phone: text(query.phone, 15),
    nickname: text(query.nickname, 100),
  };
}

// An explicit SQL projection, not select(*) followed by a password blacklist.
// These bounded schema fields serve the current desktop list and buyer picker.
// Do not add credentials, login metadata, personal documents or arbitrary JSON.
const listColumns = {
  uid: user.uid, account: user.account, nickname: user.nickname, phone: user.phone, avatar: user.avatar,
  integral: user.integral, level: user.level, status: user.status, nowMoney: user.nowMoney,
  addTime: user.addTime, spreadUid: user.spreadUid, groupId: user.groupId,
};

/** Both existing Admin list routes retain user.view authorization. This is a
 * directory read, not authorization to purchase for the returned buyer. */
export async function listAdminUsers(container: Container, raw: Record<string, unknown>) {
  const query = parseAdminUserListQuery(raw);
  const conditions: SQL[] = [eq(user.isDel, 0), isNull(user.deleteTime)];
  if (query.uid) conditions.push(eq(user.uid, query.uid));
  if (query.groupId >= 0) conditions.push(eq(user.groupId, query.groupId));
  if (query.status >= 0) conditions.push(eq(user.status, query.status));
  if (query.phone) conditions.push(eq(user.phone, query.phone));
  if (query.nickname) {
    // The legacy picker calls its nickname/phone/UID search `nickname`.
    // Escape LIKE syntax: a literal '%' must not turn into a directory dump.
    const pattern = `%${query.nickname.replace(/[\\%_]/g, '\\$&')}%`;
    const numericUid = /^\d{1,10}$/.test(query.nickname) ? Number(query.nickname) : 0;
    conditions.push(or(ilike(user.nickname, pattern), ilike(user.phone, pattern),
      numericUid > 0 && numericUid <= maximumId ? eq(user.uid, numericUid) : undefined)!);
  }
  return withTx(container, async db => {
    await db.execute(sql`SET TRANSACTION READ ONLY`);
    // Keep a stricter caller limit; 0 means unbounded, not zero milliseconds.
    await db.execute(sql`SELECT set_config('statement_timeout',
      LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true)`);
    const rows = await db.select(listColumns).from(user).where(and(...conditions))
      .orderBy(desc(user.uid)).limit(query.limit).offset((query.page - 1) * query.limit);
    // Explicit transitional aliases preserve existing camel-case consumers and
    // provide the snake-case names already used by the Admin/legacy templates.
    const list = rows.map(row => ({ ...row, now_money: row.nowMoney, add_time: row.addTime,
      spread_uid: row.spreadUid, group_id: row.groupId }));
    return { list, page: query.page, limit: query.limit };
  });
}
