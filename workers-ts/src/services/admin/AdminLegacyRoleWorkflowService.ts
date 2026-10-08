import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { systemAdmin, systemMenus, systemRole } from '@/models/schema';
import { ApiErrorCode, AuthException, HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { AdminPermissionService, canRetainOpaqueLegacyMenu, hasAdminPermission } from './AdminPermissionService';
import { inspectAdminRoleMutationImpact, requireAdminRoleImpactConfirmation, withAdminAuthorityWriteTx } from './AdminAuthorityWriteService';

export const MAX_LEGACY_ROLE_MENU_ROWS = 10_000;
export const MAX_LEGACY_ROLE_SELECTED_MENUS = 2_048;
export const MAX_LEGACY_ROLE_MENU_DEPTH = 64;
export const MAX_LEGACY_ROLE_MENU_LABEL_CHARACTERS = 4_096;
export interface AdminLegacyRoleActor { id: number; authVersion: string; expiresAt: number }
export interface LegacyRoleMenuNode { id: number; pid: number; title: string; children: LegacyRoleMenuNode[]; expand?: true }
export interface LegacyRoleFormRow { id: number; type: number; relation_id: number; role_name: string; rules: string; level: number; status: number }
type RoleRow = typeof systemRole.$inferSelect;
type MenuRow = typeof systemMenus.$inferSelect;
interface LiveActor { level: number; roleIds: number[]; legacyIds: Set<number>; keys: Set<string> }
interface MenuCatalogue { menus: LegacyRoleMenuNode[]; rows: Map<number, MenuRow>; grants: Set<number>; knownGrants: Set<number> }
const conflict = (message: string) => new HttpApiException(message, 409, 409);

function assertActor(actor: AdminLegacyRoleActor): void {
  if (!Number.isSafeInteger(actor.id) || actor.id <= 0 || actor.id > 2147483647
    || typeof actor.authVersion !== 'string' || !/^[a-f0-9]{32}$/.test(actor.authVersion)
    || !Number.isSafeInteger(actor.expiresAt) || actor.expiresAt <= 0) throw new AuthException('请重新登录', ApiErrorCode.ERR_LOGIN);
  if (actor.expiresAt <= Math.floor(Date.now() / 1000)) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
}

export function parseLegacyRolePathId(value: string, allowCreate = false): number {
  if (allowCreate && value === '0') return 0;
  if (!/^[1-9]\d*$/.test(value) || value.length > 10 || Number(value) > 2147483647) throw new ValidateException('角色ID必须为有效整数');
  return Number(value);
}
function noQuery(query: URLSearchParams): void {
  if (query.size) throw new ValidateException('角色表单不接受查询参数');
}
function numericRules(value: string): number[] {
  if (!value || value.length > 16384) throw conflict('角色权限不能由旧菜单表单完整表达');
  const tokens = value.split(',').map(token => token.trim());
  if (tokens.length > MAX_LEGACY_ROLE_SELECTED_MENUS || tokens.some(token => !/^[1-9]\d*$/.test(token)
    || token.length > 10 || Number(token) > 2147483647)) throw conflict('角色权限不能由旧菜单表单完整表达');
  return [...new Set(tokens.map(Number))];
}
function assignedRoleIds(value: string): number[] {
  if (!value) return [];
  const tokens = value.split(',').map(token => token.trim());
  if (tokens.some(token => !/^[1-9]\d*$/.test(token) || token.length > 10 || Number(token) > 2147483647)) {
    throw new AuthException('管理员角色已变化', ApiErrorCode.ERR_AUTH);
  }
  return [...new Set(tokens.map(Number))];
}

export function parseLegacyRoleSave(pathId: string, body: unknown): { id: number; roleName: string; status: 0 | 1; menuIds: number[] } {
  const id = parseLegacyRolePathId(pathId, true);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidateException('角色提交数据错误');
  const row = body as Record<string, unknown>;
  const fields = new Set(['id', 'role_name', 'status', 'checked_menus', 'type', 'relation_id', 'level', 'rules']);
  if (Object.keys(row).some(key => !fields.has(key))) throw new ValidateException('角色提交包含未知字段');
  if (row.id !== undefined && (typeof row.id !== 'number' || !Number.isInteger(row.id) || row.id !== id)) throw new ValidateException('角色ID参数冲突');
  if (typeof row.role_name !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(row.role_name)) throw new ValidateException('身份名称不能包含控制字符');
  const roleName = row.role_name.trim();
  if (!roleName || [...roleName].length > 32) throw new ValidateException('身份名称必须为1到32个字符');
  const status = row.status === undefined ? 0 : row.status;
  if (status !== 0 && status !== 1) throw new ValidateException('角色状态只能为0或1');
  if (!Array.isArray(row.checked_menus) || !row.checked_menus.length || row.checked_menus.length > MAX_LEGACY_ROLE_SELECTED_MENUS
    || [...row.checked_menus].some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 2147483647)) {
    throw new ValidateException('请选择1到2048个有效菜单ID');
  }
  // The old page resubmits the seven-column role and retains these fields when
  // switching from edit to add. They are bounded echoes, never write authority.
  for (const key of ['type', 'relation_id', 'level']) {
    if (row[key] !== undefined && (typeof row[key] !== 'number' || !Number.isSafeInteger(row[key]))) throw new ValidateException('角色回显字段错误');
  }
  if (row.rules !== undefined && (typeof row.rules !== 'string' || row.rules.length > 16384)) throw new ValidateException('角色权限回显字段错误');
  const menuIds = [...new Set(row.checked_menus as number[])].sort((a, b) => a - b);
  if (menuIds.join(',').length > 16384) throw new ValidateException('角色权限数据过大');
  return { id, roleName, status, menuIds };
}

async function deadlines(tx: DbClient): Promise<void> {
  await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
  await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
  await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
}
async function liveActor(tx: DbClient, actor: AdminLegacyRoleActor, write: boolean): Promise<LiveActor> {
  const query = tx.select({ pwd: systemAdmin.pwd, adminType: systemAdmin.adminType, relationId: systemAdmin.relationId,
    status: systemAdmin.status, isDel: systemAdmin.isDel, level: systemAdmin.level, roles: systemAdmin.roles })
    .from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
  const [live] = write ? await query.for('share', { noWait: true }) : await query;
  if (!live || live.adminType !== 1 || live.relationId !== 0 || live.status !== 1 || live.isDel !== 0
    || !Number.isInteger(live.level) || live.level < 0 || live.level > 9) throw new AuthException('管理员已禁用或身份已变化', ApiErrorCode.ERR_BANNED);
  const encoder = new TextEncoder();
  if (!timingSafeEqual(encoder.encode(md5(live.pwd)), encoder.encode(actor.authVersion))) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
  const roleIds = assignedRoleIds(live.roles);
  const roleQuery = tx.select({ id: systemRole.id, rules: systemRole.rules }).from(systemRole)
    .where(and(inArray(systemRole.id, roleIds), inArray(systemRole.type, [0, 1]), eq(systemRole.relationId, 0), eq(systemRole.status, 1))).orderBy(asc(systemRole.id));
  const roles = roleIds.length ? write ? await roleQuery.for('share', { noWait: true }) : await roleQuery : [];
  if (roles.some(role => role.rules.length > 16384 || role.rules.split(',').length > MAX_LEGACY_ROLE_SELECTED_MENUS)) {
    throw new ServiceUnavailableException('管理员权限数据过大');
  }
  const permissions = new AdminPermissionService(createContainerFromDb(tx));
  const assignment = await permissions.resolveRoleAssignment(live.roles, write);
  if (live.level !== 0 && (assignment.missingRoleIds.length || !hasAdminPermission(assignment.keys,
    write ? 'system.legacy_role_manage' : 'system.legacy_role_form_view'))) throw new AuthException('角色表单权限已变化', ApiErrorCode.ERR_AUTH);
  assertActor(actor);
  return { level: live.level, roleIds, legacyIds: new Set(assignment.legacyRuleIds), keys: assignment.keys };
}
function pureStructure(row: MenuRow): boolean {
  return row.authType === 0 && !row.apiUrl.trim() && !row.menuPath.trim() && !row.uniqueAuth.trim();
}
function validGrantMetadata(row: MenuRow): boolean {
  if (row.authType === 1) return !!row.menuPath.trim();
  if (row.authType !== 2 || !row.apiUrl.trim()) return false;
  const methods = row.methods.split(/[\s,|]+/).filter(Boolean).map(method => method.toUpperCase());
  return methods.length > 0 && methods.every(method => ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method));
}
async function catalogue(tx: DbClient, actor: LiveActor, write: boolean): Promise<MenuCatalogue> {
  const query = tx.select().from(systemMenus).where(and(eq(systemMenus.type, 1), eq(systemMenus.access, 1), eq(systemMenus.isDel, 0)))
    .orderBy(asc(systemMenus.id)).limit(MAX_LEGACY_ROLE_MENU_ROWS + 1);
  const rows = write ? await query.for('share', { noWait: true }) : await query;
  if (rows.length > MAX_LEGACY_ROLE_MENU_ROWS) throw new ServiceUnavailableException('角色菜单超过10000，请先整理目录');
  const permissions = new AdminPermissionService(createContainerFromDb(tx));
  const footprints = await permissions.resolveManyRulePermissionKeys(rows.map(row => String(row.id)));
  const byId = new Map(rows.map(row => [row.id, row]));
  const knownGrants = new Set(rows.filter((row, index) => validGrantMetadata(row)
    && (footprints[index].length || canRetainOpaqueLegacyMenu(row))).map(row => row.id));
  const grants = new Set(rows.filter((row, index) => validGrantMetadata(row) && (footprints[index].length
    ? actor.level === 0 || footprints[index].every(key => hasAdminPermission(actor.keys, key))
    : canRetainOpaqueLegacyMenu(row) && (actor.level === 0 || actor.legacyIds.has(row.id)))).map(row => row.id));
  const validPath = new Map<number, boolean>();
  for (const row of rows) {
    if (validPath.has(row.id)) continue;
    const path: number[] = [], visiting = new Set<number>();
    let next = row.id, valid = true;
    while (next !== 0) {
      if (validPath.has(next)) { valid = validPath.get(next)!; break; }
      const node = byId.get(next);
      if (!node || visiting.has(next) || node.pid < 0) { valid = false; break; }
      visiting.add(next); path.push(next); next = node.pid;
    }
    for (const id of path) validPath.set(id, valid);
  }
  for (const id of grants) if (!validPath.get(id)) grants.delete(id);
  // One genuine grant per leaf: the old Vue initializes checked state only on
  // leaves and submits indeterminate ancestors. Nested grant nodes would lose
  // parent-only grants or add a parent's authority on a name-only save.
  const menus = rows.filter(row => grants.has(row.id)).sort((a, b) => b.sort - a.sort || b.id - a.id).map(row => {
    const labels: string[] = [];
    let next = row.id;
    while (next) {
      if (labels.length >= MAX_LEGACY_ROLE_MENU_DEPTH) throw new ServiceUnavailableException('角色菜单层级超过64，请先整理目录');
      const node = byId.get(next)!; labels.push(node.menuName); next = node.pid;
    }
    const title = labels.reverse().join(' / ');
    if ([...title].length > MAX_LEGACY_ROLE_MENU_LABEL_CHARACTERS) throw new ServiceUnavailableException('角色菜单标签过长，请先整理目录');
    return { id: row.id, pid: row.pid, title, children: [] };
  });
  return { menus, rows: new Map(rows.filter(row => validPath.get(row.id)).map(row => [row.id, row])), grants, knownGrants };
}

function canonicalSelection(ids: number[], directory: MenuCatalogue): number[] {
  for (const id of ids) if (!directory.rows.has(id)) throw conflict('菜单不存在、不可授权或不能在旧菜单树中完整表达');
  for (const id of ids) if (directory.knownGrants.has(id) && !directory.grants.has(id)) throw new AuthException('菜单权限超出可委派范围', ApiErrorCode.ERR_AUTH);
  const selected = new Set(ids.filter(id => directory.grants.has(id)));
  if (!selected.size) throw conflict('角色未包含可由旧表单完整表达的权限');
  const ancestors = new Set<number>();
  for (const id of selected) {
    let next = directory.rows.get(id)!.pid;
    while (next && !ancestors.has(next)) { ancestors.add(next); next = directory.rows.get(next)!.pid; }
  }
  for (const id of ids) if (!selected.has(id) && (!pureStructure(directory.rows.get(id)!) || !ancestors.has(id))) {
    throw conflict('菜单不可授权；结构菜单必须是已选权限的上级');
  }
  return [...selected].sort((a, b) => a - b);
}
function formRow(row: RoleRow): LegacyRoleFormRow {
  return { id: row.id, type: row.type, relation_id: row.relationId, role_name: row.roleName, rules: row.rules, level: row.level, status: row.status };
}
async function targetRole(tx: DbClient, id: number, actor: LiveActor, write: boolean): Promise<RoleRow> {
  if (actor.roleIds.includes(id)) throw conflict('不能修改本人正在使用的角色');
  const query = tx.select().from(systemRole).where(and(eq(systemRole.id, id), inArray(systemRole.type, [0, 1]),
    eq(systemRole.relationId, 0), eq(systemRole.level, actor.level + 1), inArray(systemRole.status, [0, 1]))).limit(1);
  const [row] = write ? await query.for('update', { noWait: true }) : await query;
  if (!row) throw new NotFoundException('修改的角色不存在');
  return row;
}
function lockError(error: unknown): never {
  let cause = error;
  for (let depth = 0; depth < 6 && cause && typeof cause === 'object'; depth++) {
    if ('code' in cause && ['55P03', '40P01'].includes(String(cause.code))) throw conflict('角色或授权权限正在变化，请刷新后重新确认');
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}

/** The legacy numeric-menu contract is separate from modern string-key saves.
 * No automatic retry or durable replay is implied by the old POST protocol. */
export class AdminLegacyRoleWorkflowService {
  constructor(private readonly container: Container) {}
  private async read<T>(query: URLSearchParams, actor: AdminLegacyRoleActor, callback: (tx: DbClient, live: LiveActor) => Promise<T>): Promise<T> {
    noQuery(query); assertActor(actor);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await deadlines(tx);
      const result = await callback(tx, await liveActor(tx, actor, false)); assertActor(actor); return result;
    });
  }
  async createForm(query: URLSearchParams, actor: AdminLegacyRoleActor): Promise<{ menus: LegacyRoleMenuNode[] }> {
    return this.read(query, actor, async (tx, live) => ({ menus: (await catalogue(tx, live, false)).menus }));
  }
  async editForm(pathId: string, query: URLSearchParams, actor: AdminLegacyRoleActor): Promise<{ role: LegacyRoleFormRow; menus: LegacyRoleMenuNode[] }> {
    const id = parseLegacyRolePathId(pathId);
    return this.read(query, actor, async (tx, live) => {
      const row = await targetRole(tx, id, live, false), directory = await catalogue(tx, live, false);
      canonicalSelection(numericRules(row.rules), directory);
      return { role: formRow(row), menus: directory.menus };
    });
  }
  async save(pathId: string, body: unknown, actor: AdminLegacyRoleActor): Promise<{ id: number; created: boolean }> {
    const input = parseLegacyRoleSave(pathId, body); assertActor(actor);
    try {
      return await withAdminAuthorityWriteTx(this.container, actor, 'system.legacy_role_manage', async (tx, authorityActor) => {
        const live = await liveActor(tx, actor, true);
        const current = input.id ? await targetRole(tx, input.id, live, true) : undefined;
        const directory = await catalogue(tx, live, true);
        const currentSelection = current ? canonicalSelection(numericRules(current.rules), directory) : undefined;
        const rules = canonicalSelection(input.menuIds, directory).join(',');
        // Sorting and removing structural ancestors preserve the actual grant
        // set. Only a permission/status change requires reference confirmation.
        if (current && (current.status !== input.status || currentSelection!.join(',') !== rules)) {
          await requireAdminRoleImpactConfirmation(tx, authorityActor,
            await inspectAdminRoleMutationImpact(tx, current, { rules, status: input.status }));
        }
        assertActor(actor);
        const fields = { roleName: input.roleName, rules, status: input.status };
        const rows = current ? await tx.update(systemRole).set(fields).where(and(eq(systemRole.id, current.id),
          eq(systemRole.type, current.type), eq(systemRole.relationId, 0), eq(systemRole.level, live.level + 1), eq(systemRole.status, current.status))).returning()
          : await tx.insert(systemRole).values({ ...fields, type: 0, relationId: 0, level: live.level + 1 }).returning();
        if (rows.length !== 1) throw conflict('角色保存范围已变化');
        const saved = rows[0];
        if (!Number.isSafeInteger(saved.id) || saved.id <= 0 || saved.id > 2147483647 || current && saved.id !== current.id
          || saved.roleName !== fields.roleName || saved.rules !== rules || saved.status !== input.status
          || saved.type !== (current?.type ?? 0) || saved.relationId !== 0 || saved.level !== live.level + 1) throw conflict('角色保存结果不一致');
        const [readBack] = await tx.select().from(systemRole).where(eq(systemRole.id, saved.id)).limit(1);
        if (!readBack || JSON.stringify(formRow(readBack)) !== JSON.stringify(formRow(saved))) throw conflict('角色保存结果不一致');
        assertActor(actor);
        return { id: saved.id, created: !current };
      });
    } catch (error) { return lockError(error); }
  }
}
