import { sql, type SQL } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { systemAdmin, systemMenus, systemRole } from '@/models/schema';
import { ApiErrorCode, AuthException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { AdminPermissionService, hasAdminPermission } from './AdminPermissionService';

export interface AdminLegacySystemListActor { id: number; authVersion: string; expiresAt: number }
interface ListQuery { page: number; limit: number; status?: number; pattern?: string }
interface AdminListQuery extends ListQuery { roleId?: number }
export interface LegacyAdminListRow {
  id: number; account: string; real_name: string; phone: string; roles: string; level: number;
  status: number; last_ip: string; last_time: number; add_time: number; _add_time: string; _last_time: string;
}
export interface LegacyRoleListRow {
  id: number; type: number; relation_id: number; role_name: string; rules: string; level: number; status: number;
}

function listQuery(query: URLSearchParams, allowed: readonly string[], keywordKey: string): ListQuery {
  for (const key of query.keys()) {
    if (!allowed.includes(key) || query.getAll(key).length !== 1) throw new ValidateException('列表查询参数错误');
  }
  const integer = (key: string, fallback: number, max: number) => {
    const value = query.get(key);
    if (value === null) return fallback;
    if (!/^[1-9]\d*$/.test(value) || value.length > 3 || Number(value) > max) {
      throw new ValidateException(`${key} 必须为 1 到 ${max} 的整数`);
    }
    return Number(value);
  };
  const keyword = query.get(keywordKey) ?? '';
  if (keyword.length > 64 || /[\u0000-\u001f\u007f]/u.test(keyword)) throw new ValidateException('关键词最多 64 个字符且不能包含控制字符');
  const status = query.get('status') ?? '';
  if (!['', '0', '1'].includes(status)) throw new ValidateException('状态只能为 0 或 1');
  const page = integer('page', 1, 500), limit = integer('limit', 20, 100);
  if ((page - 1) * limit > 10_000) throw new ValidateException('列表分页偏移最多为 10000');
  const trimmed = keyword.trim();
  return { page, limit, status: status === '' ? undefined : Number(status),
    pattern: trimmed ? `%${trimmed.replace(/[\\%_]/g, '\\$&')}%` : undefined };
}

export function parseLegacyAdminListQuery(query: URLSearchParams): AdminListQuery {
  const parsed = listQuery(query, ['name', 'roles', 'status', 'page', 'limit', 'is_del'], 'name');
  // PHP's model forces is_del=0 even when the old page passes is_del=1.
  if (!['', '0', '1'].includes(query.get('is_del') ?? '')) throw new ValidateException('删除状态参数错误');
  const roles = query.get('roles') ?? '';
  if (roles === '' || roles === '0') return parsed;
  if (!/^[1-9]\d*$/.test(roles) || roles.length > 10 || Number(roles) > 2147483647) throw new ValidateException('角色筛选必须为有效角色 ID');
  return { ...parsed, roleId: Number(roles) };
}

export function parseLegacyRoleListQuery(query: URLSearchParams): ListQuery {
  return listQuery(query, ['role_name', 'status', 'page', 'limit'], 'role_name');
}

function assertActorClaims(actor: AdminLegacySystemListActor): void {
  if (!Number.isSafeInteger(actor.id) || actor.id <= 0 || actor.id > 2147483647
    || typeof actor.authVersion !== 'string' || !/^[a-f0-9]{32}$/.test(actor.authVersion)
    || !Number.isSafeInteger(actor.expiresAt) || actor.expiresAt <= 0) throw new AuthException('请重新登录', ApiErrorCode.ERR_LOGIN);
  if (actor.expiresAt <= Math.floor(Date.now() / 1000)) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
}

type LegacyReadPermission = 'system.legacy_admin_view' | 'system.legacy_role_view';
async function liveActorLevel(tx: DbClient, actor: AdminLegacySystemListActor, required: LegacyReadPermission): Promise<number> {
  const [live] = await tx.execute(sql`SELECT id,pwd,admin_type,status,is_del,level,roles FROM ${systemAdmin} WHERE id=${actor.id} LIMIT 1`) as unknown as Array<{
    id: number; pwd: string; admin_type: number; status: number; is_del: number; level: number; roles: string;
  }>;
  if (!live || live.admin_type !== 1 || live.status !== 1 || live.is_del !== 0
    || !Number.isInteger(live.level) || live.level < 0 || live.level > 9) throw new AuthException('管理员已禁用或身份已变化', ApiErrorCode.ERR_BANNED);
  const encoder = new TextEncoder();
  if (!timingSafeEqual(encoder.encode(md5(live.pwd)), encoder.encode(actor.authVersion))) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
  if (live.level !== 0) {
    const { keys } = await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(live.roles);
    if (!hasAdminPermission(keys, required)) throw new AuthException('管理员列表权限已变化', ApiErrorCode.ERR_AUTH);
  }
  assertActorClaims(actor);
  return live.level;
}

const shanghaiDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function legacyDate(seconds: number): string {
  const parts = Object.fromEntries(shanghaiDate.formatToParts(new Date(seconds * 1000)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
function numericIds(value: string): number[] {
  return [...new Set(value.split(',').map(token => token.trim()).filter(token => /^[1-9]\d*$/.test(token)
    && token.length <= 10 && Number(token) <= 2147483647).map(Number))];
}
async function countRows(tx: DbClient, table: typeof systemAdmin | typeof systemRole, where: SQL): Promise<number> {
  const [row] = await tx.execute(sql`SELECT count(*)::integer AS count FROM ${table} WHERE ${where}`) as unknown as Array<{ count: number }>;
  if (!row || !Number.isSafeInteger(row.count) || row.count < 0) throw new Error('Invalid Admin list count');
  return row.count;
}

/** Legacy display DTOs. Every identity, count, row and label shares one bounded
 * read-only snapshot; the modern list/directory DTOs are separate contracts. */
export class AdminLegacySystemListService {
  constructor(private readonly container: Container) {}

  private async snapshot<T>(actor: AdminLegacySystemListActor, required: LegacyReadPermission, read: (tx: DbClient, level: number) => Promise<T>): Promise<T> {
    assertActorClaims(actor);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
      await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
      const result = await read(tx, await liveActorLevel(tx, actor, required));
      assertActorClaims(actor);
      return result;
    });
  }

  async adminList(query: URLSearchParams, actor: AdminLegacySystemListActor): Promise<{ list: LegacyAdminListRow[]; count: number }> {
    const filter = parseLegacyAdminListQuery(query);
    return this.snapshot(actor, 'system.legacy_admin_view', async (tx, level) => {
      const predicates = [sql`admin_type=1`, sql`is_del=0`, sql`status>=0`, sql`level=${level + 1}`];
      if (filter.status !== undefined) predicates.push(sql`status=${filter.status}`);
      if (filter.pattern) predicates.push(sql`(account ILIKE ${filter.pattern} OR real_name ILIKE ${filter.pattern})`);
      if (filter.roleId !== undefined) predicates.push(sql`${String(filter.roleId)} = ANY(string_to_array(roles, ','))`);
      const where = sql.join(predicates, sql` AND `);
      const count = await countRows(tx, systemAdmin, where);
      const rows = await tx.execute(sql`SELECT id,account,real_name,phone,roles,level,status,last_ip,last_time,add_time
        FROM ${systemAdmin} WHERE ${where} ORDER BY id DESC LIMIT ${filter.limit} OFFSET ${(filter.page - 1) * filter.limit}`) as unknown as Array<Omit<LegacyAdminListRow, '_add_time' | '_last_time'>>;
      const ids = [...new Set(rows.flatMap(row => numericIds(row.roles)))];
      const names = ids.length ? await tx.execute(sql`SELECT id,role_name FROM ${systemRole}
        WHERE id IN (${sql.join(ids.map(id => sql`${id}`), sql`,`)}) AND type IN (0,1) AND relation_id=0 AND status>=0`) as unknown as Array<{ id: number; role_name: string }> : [];
      const nameById = new Map(names.map(row => [row.id, row.role_name]));
      return { count, list: rows.map(row => ({ ...row, roles: numericIds(row.roles).map(id => nameById.get(id)).filter(Boolean).join(','),
        _add_time: legacyDate(row.add_time), _last_time: row.last_time ? legacyDate(row.last_time) : '' })) };
    });
  }

  async roleList(query: URLSearchParams, actor: AdminLegacySystemListActor): Promise<{ list: LegacyRoleListRow[]; count: number }> {
    const filter = parseLegacyRoleListQuery(query);
    return this.snapshot(actor, 'system.legacy_role_view', async (tx, level) => {
      const predicates = [sql`type IN (0,1)`, sql`relation_id=0`, sql`status>=0`, sql`level=${level + 1}`];
      if (filter.status !== undefined) predicates.push(sql`status=${filter.status}`);
      if (filter.pattern) predicates.push(sql`role_name ILIKE ${filter.pattern}`);
      const where = sql.join(predicates, sql` AND `);
      const count = await countRows(tx, systemRole, where);
      const rows = await tx.execute(sql`SELECT id,type,relation_id,role_name,rules,level,status FROM ${systemRole}
        WHERE ${where} ORDER BY id DESC LIMIT ${filter.limit} OFFSET ${(filter.page - 1) * filter.limit}`) as unknown as LegacyRoleListRow[];
      // Bound legacy TEXT fan-out explicitly instead of silently truncating permissions.
      if (rows.some(row => row.rules.length > 16384)) throw new ServiceUnavailableException('角色权限展示数据过大');
      const tokens = rows.map(row => [...new Set(row.rules.split(',').map(token => token.trim()).filter(Boolean))]);
      const ids = [...new Set(tokens.flatMap(row => numericIds(row.join(','))))];
      if (tokens.reduce((total, row) => total + row.length, 0) > 10000) throw new ServiceUnavailableException('角色权限展示数量过大');
      const names = ids.length ? await tx.execute(sql`SELECT id,menu_name FROM ${systemMenus}
        WHERE id IN (${sql.join(ids.map(id => sql`${id}`), sql`,`)}) AND type=1 AND is_del=0`) as unknown as Array<{ id: number; menu_name: string }> : [];
      const labels = new Map(names.map(row => [String(row.id), row.menu_name]));
      for (const group of new AdminPermissionService(createContainerFromDb(tx)).permissionTree()) {
        for (const child of group.children) labels.set(child.key, `${group.label}：${child.label}`);
      }
      return { count, list: rows.map((row, index) => ({ ...row, rules: tokens[index].map(token => labels.get(token)
        ?? (/^[1-9]\d*$/.test(token) ? `未迁移菜单 #${token}` : '未识别权限')).join(',') })) };
    });
  }
}
