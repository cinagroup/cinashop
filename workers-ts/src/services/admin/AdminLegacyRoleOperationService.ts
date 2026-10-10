import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { systemAdmin, systemMenus, systemRole } from '@/models/schema';
import { adminAuthorityOperation } from '@/models/schema/adminAuthorityOperation';
import { acquireAdminAuthorityMenuLock, assertAdminLegacyRoleOperationReady } from '@/migrations/adminAuthorityOperation';
import { ApiErrorCode, AuthException, HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { AdminPermissionService, canRetainOpaqueLegacyMenu, hasAdminPermission } from './AdminPermissionService';
import { acquireAdminAuthorityWriteBarrier, adminAuthorityWriteError, assertAdminAuthoritySession,
  normalizeAdminAuthorityRules, parseAdminAuthorityRoleIds, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { loadAdminLegacyRoleDeletionProofs, type AdminLegacyRoleDeletedSnapshot } from './AdminLegacyRoleDeletionProof';

export type LegacyRoleOperationKind = 'legacy-role-status' | 'legacy-role-delete';
export type LegacyRoleActor = AdminAuthorityActor;
export const LEGACY_ROLE_PREVIEW_TTL_SECONDS = 300;
export const MAX_LEGACY_ROLE_REFERENCES = 1_000;
export const MAX_LEGACY_ROLE_OPERATION_MENU_ROWS = 10_000;
export const MAX_LEGACY_ROLE_RELEVANT_ROLES = 10_000;
export const MAX_LEGACY_ROLE_COLLECTION_BYTES = 4 * 1024 * 1024;
export interface LegacyRoleCommitMetadata { operation_id: string; revision: string; expires_at: number; confirmed: true }
export interface LegacyRoleResult { id: number; created?: false; deleted?: true }
export interface LegacyRoleReceipt { operation_id: string; actor_id: number; operation: LegacyRoleOperationKind;
  state: 'committed' | 'not_applied' | 'unknown'; request_hash: string | null; result: LegacyRoleResult | null }
export interface LegacyRoleReference { id: number; account: string; real_name: string; roles: number[];
  level: number; status: 0 | 1; is_del: 0 | 1; effective_permission_change: boolean }
export interface LegacyRolePreview { operation_id: string; actor_id: number; operation: LegacyRoleOperationKind;
  request_hash: string; revision: string; expires_at: number; requires_confirmation: true;
  summary: { target_id: number; target_name: string; action: 'status' | 'delete';
    before: AdminLegacyRoleDeletedSnapshot; after: AdminLegacyRoleDeletedSnapshot | null;
    impact: { reference_count: number; active_reference_count: number; references: LegacyRoleReference[] } } }
type AdminRow = typeof systemAdmin.$inferSelect;
type RoleRow = typeof systemRole.$inferSelect;
type MenuRow = typeof systemMenus.$inferSelect;
type ReceiptRow = typeof adminAuthorityOperation.$inferSelect;
interface Prepared { operation: LegacyRoleOperationKind; id: number; status?: 0 | 1 }
interface Live { row: AdminRow; roleIds: number[]; roles: RoleRow[]; deletedRoles: Map<number, AdminLegacyRoleDeletedSnapshot>;
  keys: Set<string>; numeric: Set<number> }
interface Catalogue { rows: MenuRow[]; byId: Map<number, MenuRow>; footprints: Map<number, string[]>;
  validPaths: Set<number>; permissionKeys: string[] }
interface Plan { input: Prepared; live: Live; target: RoleRow; references: AdminRow[]; roles: RoleRow[];
  deletedRoles: Map<number, AdminLegacyRoleDeletedSnapshot>; directory: Catalogue; proof: unknown; summary: LegacyRolePreview['summary'] }
type StoredResult = LegacyRoleResult & { deleted_role?: AdminLegacyRoleDeletedSnapshot };
const conflict = (message: string) => new HttpApiException(message, 409, 409);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const INTEGER = /^[1-9]\d*$/;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('角色操作数据格式错误');
  return value as Record<string, unknown>;
};
function only(row: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(row).some(key => !fields.includes(key))) throw new ValidateException('角色操作包含未知字段');
}
export function legacyRoleOperationKind(value: unknown): LegacyRoleOperationKind {
  if (value !== 'legacy-role-status' && value !== 'legacy-role-delete') throw new ValidateException('旧角色操作类型错误');
  return value;
}
function operationId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ValidateException('操作ID必须为小写UUIDv4');
  return value;
}
export function parseLegacyRoleOperationPathId(value: string): number {
  if (!INTEGER.test(value) || value.length > 10 || !integer(Number(value))) throw new ValidateException('角色ID必须为有效整数');
  return Number(value);
}
export function parseLegacyRoleOperationStatus(value: string): 0 | 1 {
  if (value !== '0' && value !== '1') throw new ValidateException('角色状态只能为0或1');
  return Number(value) as 0 | 1;
}
export function parseLegacyRoleCommitMetadata(headers: Headers): LegacyRoleCommitMetadata {
  const id = headers.get('X-Admin-Operation-Id'), revision = headers.get('X-Admin-Revision');
  const expires = headers.get('X-Admin-Expires-At'), confirmed = headers.get('X-Admin-Confirmed');
  if (id === null || revision === null || expires === null || confirmed === null) throw conflict('请先预览并明确确认角色影响范围');
  if (!UUID.test(id) || !/^[a-f0-9]{64}$/.test(revision) || !INTEGER.test(expires) || expires.length > 10
    || !Number.isSafeInteger(Number(expires)) || confirmed !== 'true') throw new ValidateException('角色确认metadata错误');
  return { operation_id: id, revision, expires_at: Number(expires), confirmed: true };
}
function prepared(operation: LegacyRoleOperationKind, value: unknown): Prepared {
  const row = object(value); only(row, operation === 'legacy-role-status' ? ['id', 'status'] : ['id']);
  if (!integer(row.id)) throw new ValidateException('角色ID错误');
  if (operation === 'legacy-role-status' && row.status !== 0 && row.status !== 1) throw new ValidateException('角色状态只能为0或1');
  return Object.freeze({ operation, id: row.id, ...(operation === 'legacy-role-status' ? { status: row.status as 0 | 1 } : {}) });
}
function envelope(value: unknown, commit = false) {
  const row = object(value); only(row, commit ? ['operation_id', 'operation', 'payload', 'revision', 'expires_at', 'confirmed']
    : ['operation_id', 'operation', 'payload']);
  const operation = legacyRoleOperationKind(row.operation);
  return { operationId: operationId(row.operation_id), operation, input: prepared(operation, row.payload) };
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  throw new ValidateException('角色操作包含不能签名的数据');
}
function equalHash(value: string, expected: string): boolean {
  return /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(new TextEncoder().encode(value), new TextEncoder().encode(expected));
}
function roleIds(value: string): number[] {
  const ids = parseAdminAuthorityRoleIds(value);
  if (value.trim() && value.split(',').some(token => !token.trim())) throw conflict('管理员角色CSV不完整');
  return ids;
}
function completeRules(value: string): string[] {
  if (typeof value !== 'string' || value.trim() && value.split(',').some(token => !token.trim())) throw conflict('角色权限CSV不完整');
  const normalized = normalizeAdminAuthorityRules(value);
  return normalized ? normalized.split(',') : [];
}
function roleSnapshot(row: RoleRow): AdminLegacyRoleDeletedSnapshot {
  return { id: row.id, type: row.type as 0 | 1, relation_id: row.relationId, role_name: row.roleName, rules: row.rules, level: row.level, status: row.status as 0 | 1 };
}
function assertSnapshot(value: unknown, id: number): asserts value is AdminLegacyRoleDeletedSnapshot {
  const row = object(value); only(row, ['id', 'type', 'relation_id', 'role_name', 'rules', 'level', 'status']);
  if (Object.keys(row).length !== 7 || row.id !== id || row.type !== 0 && row.type !== 1 || row.relation_id !== 0
    || typeof row.role_name !== 'string' || [...row.role_name].length > 32 || /[\u0000-\u001f\u007f-\u009f]/u.test(row.role_name)
    || !Number.isInteger(row.level) || Number(row.level) < 1 || Number(row.level) > 10 || row.status !== 0 && row.status !== 1
    || typeof row.rules !== 'string') throw new ServiceUnavailableException('角色删除历史证明不完整');
  completeRules(row.rules);
}
async function identity(tx: DbClient, actor: LegacyRoleActor): Promise<AdminRow> {
  assertAdminAuthoritySession(actor);
  const [row] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
  if (!row || row.adminType !== 1 || row.relationId !== 0 || row.status !== 1 || row.isDel !== 0) throw new AuthException('管理员已禁用或身份已变化', ApiErrorCode.ERR_BANNED);
  if (!timingSafeEqual(new TextEncoder().encode(md5(row.pwd)), new TextEncoder().encode(actor.authVersion))) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
  return row;
}
async function collectionBudget(tx: DbClient,
  table: typeof systemRole | typeof systemMenus | typeof systemAdmin | typeof adminAuthorityOperation,
  condition: SQL, maxRows: number, label: string): Promise<void> {
  // Count the complete protected set before transferring full rows or building
  // HMAC strings. Large valid catalogs fail closed, never a truncated subset.
  const [size] = await tx.execute(sql`SELECT count(*)::text AS rows,
    coalesce(sum(octet_length(to_jsonb(${table})::text)),0)::text AS bytes FROM ${table} WHERE ${condition}`);
  const rows = typeof size?.rows === 'string' && /^\d+$/.test(size.rows) ? Number(size.rows) : NaN;
  const bytes = typeof size?.bytes === 'string' && /^\d+$/.test(size.bytes) ? Number(size.bytes) : NaN;
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(bytes) || rows > maxRows || bytes > MAX_LEGACY_ROLE_COLLECTION_BYTES) {
    throw new ServiceUnavailableException(`${label}完整快照超过确认容量，请先整理目录`);
  }
}
async function deletionProofs(tx: DbClient, ids: number[]): Promise<Map<number, AdminLegacyRoleDeletedSnapshot>> {
  const proofs = new Map<number, AdminLegacyRoleDeletedSnapshot>();
  // A single account's CSV helper is bounded to 128 IDs. A complete 1000-account
  // impact may span more; retain every proof with bounded sequential queries.
  if (ids.length > MAX_LEGACY_ROLE_RELEVANT_ROLES) throw new ServiceUnavailableException('相关身份超过10000，请先整理目录');
  if (ids.length) await collectionBudget(tx, adminAuthorityOperation, and(eq(adminAuthorityOperation.operation, 'legacy-role-delete'),
    eq(adminAuthorityOperation.state, 'committed'), eq(adminAuthorityOperation.adminType, 1), eq(adminAuthorityOperation.relationId, 0),
    sql`${adminAuthorityOperation.result}->>'id' IN (${sql.join(ids.map(id => sql`${String(id)}`), sql`,`)})`)!, MAX_LEGACY_ROLE_RELEVANT_ROLES, '角色删除证明');
  for (let start = 0; start < ids.length; start += 128) for (const [id, proof] of await loadAdminLegacyRoleDeletionProofs(tx, ids.slice(start, start + 128))) proofs.set(id, proof);
  return proofs;
}
async function liveActor(tx: DbClient, actor: LegacyRoleActor, operation: LegacyRoleOperationKind): Promise<Live> {
  const row = await identity(tx, actor);
  if (!Number.isInteger(row.level) || row.level < 0 || row.level > 9) throw new AuthException('管理员层级不支持下一层级角色', ApiErrorCode.ERR_AUTH);
  const ids = roleIds(row.roles);
  if (ids.length) await collectionBudget(tx, systemRole, inArray(systemRole.id, ids), MAX_LEGACY_ROLE_RELEVANT_ROLES, '当前管理员身份');
  const roles = ids.length ? await tx.select().from(systemRole).where(inArray(systemRole.id, ids)).orderBy(asc(systemRole.id)) : [];
  const found = new Set(roles.map(role => role.id)), missing = ids.filter(id => !found.has(id));
  const deletedRoles = await deletionProofs(tx, missing);
  for (const role of roles) {
    if (![0, 1].includes(role.type) || role.relationId !== 0 || ![-1, 0, 1].includes(role.status) || role.level !== row.level) throw new AuthException('管理员角色域或层级已变化', ApiErrorCode.ERR_AUTH);
    completeRules(role.rules);
  }
  for (const id of missing) {
    const proof = deletedRoles.get(id); if (!proof || proof.level !== row.level) throw new AuthException('管理员角色缺失或层级不一致', ApiErrorCode.ERR_AUTH);
    assertSnapshot(proof, id);
  }
  const permissions = new AdminPermissionService(createContainerFromDb(tx));
  const active = roles.filter(role => role.status === 1), resolved = await permissions.resolveManyRulePermissionKeys(active.map(role => role.rules));
  const keys = row.level === 0 ? await permissions.resolveAdminPermissionKeys(row) : new Set(resolved.flat());
  if (row.level !== 0 && !hasAdminPermission(keys, operation === 'legacy-role-status' ? 'system.legacy_role_status' : 'system.legacy_role_delete')) throw new AuthException('角色独立操作权限已变化', ApiErrorCode.ERR_AUTH);
  return { row, roleIds: ids, roles, deletedRoles, keys,
    numeric: new Set(active.flatMap(role => completeRules(role.rules).filter(token => INTEGER.test(token)).map(Number))) };
}
function pureStructure(row: MenuRow): boolean { return row.authType === 0 && !row.apiUrl.trim() && !row.menuPath.trim() && !row.uniqueAuth.trim(); }
function grantMetadata(row: MenuRow): boolean {
  if (row.authType === 1) return !!row.menuPath.trim();
  if (row.authType !== 2 || !row.apiUrl.trim()) return false;
  const methods = row.methods.split(/[\s,|]+/).filter(Boolean).map(method => method.toUpperCase());
  return !!methods.length && methods.every(method => ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method));
}
async function catalogue(tx: DbClient): Promise<Catalogue> {
  await collectionBudget(tx, systemMenus, eq(systemMenus.type, 1), MAX_LEGACY_ROLE_OPERATION_MENU_ROWS, '权限菜单');
  const rows = await tx.select().from(systemMenus).where(eq(systemMenus.type, 1)).orderBy(asc(systemMenus.id)).limit(MAX_LEGACY_ROLE_OPERATION_MENU_ROWS + 1);
  if (rows.length > MAX_LEGACY_ROLE_OPERATION_MENU_ROWS) throw new ServiceUnavailableException('权限目录超过10000，请先整理目录');
  const active = rows.filter(row => row.access === 1 && row.isDel === 0), byId = new Map(active.map(row => [row.id, row]));
  const permissions = new AdminPermissionService(createContainerFromDb(tx));
  const keys = await permissions.resolveManyRulePermissionKeys(active.map(row => String(row.id)));
  const footprints = new Map(active.map((row, index) => [row.id, keys[index]])), validPaths = new Set<number>();
  for (const row of active) {
    let id = row.id, depth = 0, valid = true; const seen = new Set<number>();
    while (id !== 0) { const parent = byId.get(id); if (!parent || seen.has(id) || parent.pid < 0 || ++depth > 64) { valid = false; break; } seen.add(id); id = parent.pid; }
    if (valid) validPaths.add(row.id);
  }
  return { rows, byId, footprints, validPaths, permissionKeys: permissions.permissionTree().flatMap(group => group.children.map(child => child.key)) };
}
function validateRules(rules: string, live: Live, directory: Catalogue, effective = true): void {
  const grants: number[] = [], structural: number[] = [];
  for (const token of completeRules(rules)) {
    if (!INTEGER.test(token)) { if (effective && live.row.level !== 0 && !hasAdminPermission(live.keys, token)) throw new AuthException('角色权限超出可委派范围', ApiErrorCode.ERR_AUTH); continue; }
    const id = Number(token), menu = directory.byId.get(id);
    if (!menu || !directory.validPaths.has(id)) throw conflict('角色菜单缺失、停用或层级不完整');
    if (pureStructure(menu)) { structural.push(id); continue; }
    const footprint = directory.footprints.get(id)!;
    if (!grantMetadata(menu) || !footprint.length && !canRetainOpaqueLegacyMenu(menu)) throw conflict('角色菜单不能完整表达或受保护');
    if (effective && live.row.level !== 0 && (footprint.length ? footprint.some(key => !hasAdminPermission(live.keys, key)) : !live.numeric.has(id))) throw new AuthException('角色菜单超出可委派范围', ApiErrorCode.ERR_AUTH);
    grants.push(id);
  }
  const ancestors = new Set<number>();
  for (const id of grants) { let next = directory.byId.get(id)!.pid; while (next && !ancestors.has(next)) { ancestors.add(next); next = directory.byId.get(next)!.pid; } }
  if (structural.some(id => !ancestors.has(id))) throw conflict('结构菜单不是已授权限的上级');
}
async function references(tx: DbClient, id: number): Promise<AdminRow[]> {
  const condition = sql`${systemAdmin.roles} ~ ${`(^|,)\\s*${id}\\s*(,|$)`}`;
  await collectionBudget(tx, systemAdmin, condition, MAX_LEGACY_ROLE_REFERENCES, '角色引用账号');
  const rows = await tx.select().from(systemAdmin).where(condition)
    .orderBy(asc(systemAdmin.id)).limit(MAX_LEGACY_ROLE_REFERENCES + 1);
  if (rows.length > MAX_LEGACY_ROLE_REFERENCES) throw new ServiceUnavailableException('角色引用超过1000，请先整理管理员目录');
  return rows;
}
function effective(roleRows: RoleRow[], directory: Catalogue): string {
  const active = roleRows.filter(role => role.status === 1), keys = new Set<string>(), opaque = new Set<number>();
  for (const role of active) for (const token of completeRules(role.rules)) {
    if (!INTEGER.test(token)) keys.add(token);
    else { const id = Number(token), footprint = directory.footprints.get(id)!; for (const key of footprint) keys.add(key);
      if (!footprint.length && canRetainOpaqueLegacyMenu(directory.byId.get(id)!)) opaque.add(id); }
  }
  return canonical({ keys: directory.permissionKeys.filter(key => hasAdminPermission(keys, key)).sort(), opaque: [...opaque].sort((a, b) => a - b) });
}
async function plan(tx: DbClient, input: Prepared, live: Live): Promise<Plan> {
  if (live.roleIds.includes(input.id)) throw conflict('不能修改本人正在使用的角色');
  const targetCondition = and(eq(systemRole.id, input.id), inArray(systemRole.type, [0, 1]),
    eq(systemRole.relationId, 0), eq(systemRole.level, live.row.level + 1), inArray(systemRole.status, [0, 1]))!;
  await collectionBudget(tx, systemRole, targetCondition, 1, '目标角色');
  const [current] = await tx.select().from(systemRole).where(targetCondition).limit(1);
  if (!current) throw new NotFoundException('下一级角色不存在');
  assertSnapshot(roleSnapshot(current), current.id);
  const directory = await catalogue(tx), refs = await references(tx, input.id);
  for (const role of live.roles) validateRules(role.rules, live, directory, false);
  for (const proof of live.deletedRoles.values()) validateRules(proof.rules, live, directory, false);
  validateRules(current.rules, live, directory);
  const allIds = new Set([current.id, ...live.roleIds]);
  for (const row of refs) {
    if (row.adminType !== 1 || row.relationId !== 0 || row.level !== live.row.level + 1 || ![0, 1].includes(row.status) || ![0, 1].includes(row.isDel)) throw conflict('角色引用包含平台域或层级之外的管理员');
    const ids = roleIds(row.roles); if (!ids.includes(current.id)) throw conflict('角色引用CSV不完整'); for (const id of ids) allIds.add(id);
  }
  if (allIds.size > MAX_LEGACY_ROLE_RELEVANT_ROLES) throw new ServiceUnavailableException('相关身份超过10000，请先整理目录');
  await collectionBudget(tx, systemRole, inArray(systemRole.id, [...allIds]), MAX_LEGACY_ROLE_RELEVANT_ROLES, '相关角色');
  const roles = await tx.select().from(systemRole).where(inArray(systemRole.id, [...allIds])).orderBy(asc(systemRole.id));
  const byId = new Map(roles.map(role => [role.id, role])), missing = [...allIds].filter(id => !byId.has(id));
  const deletedRoles = await deletionProofs(tx, missing);
  const impact: LegacyRoleReference[] = [];
  for (const row of refs) {
    const ids = roleIds(row.roles), assigned: RoleRow[] = [];
    for (const id of ids) {
      const role = byId.get(id);
      if (role) {
        if (![0, 1].includes(role.type) || role.relationId !== 0 || role.level !== row.level || ![-1, 0, 1].includes(role.status)) throw conflict('既有角色域或层级不完整');
        validateRules(role.rules, live, directory, role.status === 1); assigned.push(role);
      } else {
        const proof = deletedRoles.get(id); if (!proof || proof.level !== row.level) throw conflict('既有角色缺失或删除证明层级不一致');
        assertSnapshot(proof, id); validateRules(proof.rules, live, directory, false);
      }
    }
    const next = assigned.flatMap(role => role.id !== current.id ? [role] : input.operation === 'legacy-role-delete' ? [] : [{ ...role, status: input.status! }]);
    impact.push({ id: row.id, account: row.account, real_name: row.realName, roles: ids, level: row.level,
      status: row.status as 0 | 1, is_del: row.isDel as 0 | 1, effective_permission_change: row.status === 1 && row.isDel === 0 && effective(assigned, directory) !== effective(next, directory) });
  }
  const before = roleSnapshot(current), after = input.operation === 'legacy-role-delete' ? null : { ...before, status: input.status! };
  return { input, live, target: current, references: refs, roles, deletedRoles, directory,
    summary: { target_id: current.id, target_name: current.roleName, action: input.operation === 'legacy-role-delete' ? 'delete' : 'status', before, after,
      impact: { reference_count: refs.length, active_reference_count: refs.filter(row => row.status === 1 && row.isDel === 0).length, references: impact } },
    proof: { input, actor: live.row, actorRoles: live.roles, actorDeletedRoles: [...live.deletedRoles], target: current,
      references: refs, relevantRoles: roles, deletedRoles: [...deletedRoles].sort(([a], [b]) => a - b), menus: directory.rows,
      permissions: new AdminPermissionService(createContainerFromDb(tx)).permissionTree() } };
}
function validateReceipt(row: ReceiptRow, actorId: number, operation: LegacyRoleOperationKind): void {
  if (row.actorId !== actorId || row.adminType !== 1 || row.relationId !== 0) throw new AuthException('无权读取该角色操作', ApiErrorCode.ERR_AUTH);
  if (row.operation !== operation) throw conflict('操作ID与原操作类型不一致');
  const result = row.result as StoredResult | null;
  if (!UUID.test(row.operationId) || !Number.isSafeInteger(row.createdAt) || row.createdAt <= 0 || row.state !== 'committed' && row.state !== 'not_applied'
    || row.state === 'not_applied' && (row.requestHash !== '' || row.revision !== '' || result !== null)
    || row.state === 'committed' && (!/^[a-f0-9]{64}$/.test(row.requestHash) || !/^[a-f0-9]{64}$/.test(row.revision) || !result || !integer(result.id)
      || operation === 'legacy-role-delete' && (result.deleted !== true || result.created !== undefined || !result.deleted_role
        || Object.keys(result).length !== 3 || Object.keys(result).some(key => !['id', 'deleted', 'deleted_role'].includes(key)))
      || operation === 'legacy-role-status' && (result.created !== false || result.deleted !== undefined || result.deleted_role !== undefined
        || Object.keys(result).length !== 2 || Object.keys(result).some(key => !['id', 'created'].includes(key))))) throw new ServiceUnavailableException('角色操作回执数据不完整');
  if (row.state === 'committed' && operation === 'legacy-role-delete') assertSnapshot(result!.deleted_role, result!.id);
}
function receiptDto(row: ReceiptRow): LegacyRoleReceipt {
  const operation = legacyRoleOperationKind(row.operation), result = row.result as StoredResult | null;
  return { operation_id: row.operationId, actor_id: row.actorId, operation, state: row.state as 'committed' | 'not_applied',
    request_hash: row.state === 'committed' ? row.requestHash : null,
    result: result ? operation === 'legacy-role-delete' ? { id: result.id, deleted: true } : { id: result.id, created: false } : null };
}
async function readReceipt(tx: DbClient, id: string, actor: number, operation: LegacyRoleOperationKind): Promise<ReceiptRow | undefined> {
  const [row] = await tx.select().from(adminAuthorityOperation).where(eq(adminAuthorityOperation.operationId, id)).limit(1);
  if (row) validateReceipt(row, actor, operation); return row;
}
async function appendReceipt(tx: DbClient, input: typeof adminAuthorityOperation.$inferInsert): Promise<ReceiptRow> {
  const rows = await tx.insert(adminAuthorityOperation).values(input).returning();
  if (rows.length !== 1 || canonical(rows[0]) !== canonical(input)) throw conflict('角色操作回执保存结果不一致');
  validateReceipt(rows[0], input.actorId, legacyRoleOperationKind(input.operation));
  const [stored] = await tx.select().from(adminAuthorityOperation).where(eq(adminAuthorityOperation.operationId, input.operationId)).limit(1);
  if (!stored || canonical(stored) !== canonical(rows[0])) throw conflict('角色操作回执回读不一致'); return stored;
}
async function apply(tx: DbClient, current: Plan): Promise<StoredResult> {
  const { input, target } = current, where = and(eq(systemRole.id, target.id), eq(systemRole.type, target.type), eq(systemRole.relationId, 0),
    eq(systemRole.level, current.live.row.level + 1), eq(systemRole.status, target.status));
  const rows = input.operation === 'legacy-role-delete' ? await tx.delete(systemRole).where(where).returning()
    : await tx.update(systemRole).set({ status: input.status! }).where(where).returning();
  const expected = input.operation === 'legacy-role-delete' ? target : { ...target, status: input.status! };
  if (rows.length !== 1 || canonical(rows[0]) !== canonical(expected)) throw conflict('角色变更结果不一致');
  await collectionBudget(tx, systemRole, eq(systemRole.id, target.id), 1, '目标角色回读');
  const [stored] = await tx.select().from(systemRole).where(eq(systemRole.id, target.id)).limit(1);
  if (input.operation === 'legacy-role-delete' ? stored !== undefined : !stored || canonical(stored) !== canonical(expected)) throw conflict('角色变更回读不一致');
  // Even owner-installed triggers must not silently cascade CSV/identity or
  // other relevant authority changes alongside this one independent action.
  const afterRefs = await references(tx, target.id);
  if (canonical(afterRefs) !== canonical(current.references)) throw conflict('角色引用发生非预期级联变更');
  const [actor] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, current.live.row.id)).limit(1);
  if (!actor || canonical(actor) !== canonical(current.live.row)) throw conflict('操作管理员发生非预期变更');
  await collectionBudget(tx, systemRole, inArray(systemRole.id, current.roles.map(role => role.id)), MAX_LEGACY_ROLE_RELEVANT_ROLES, '相关角色回读');
  const roles = await tx.select().from(systemRole).where(inArray(systemRole.id, current.roles.map(role => role.id))).orderBy(asc(systemRole.id));
  const expectedRoles = current.roles.flatMap(role => role.id !== target.id ? [role] : input.operation === 'legacy-role-delete' ? [] : [expected]);
  if (canonical(roles) !== canonical(expectedRoles) || canonical((await catalogue(tx)).rows) !== canonical(current.directory.rows)) throw conflict('相关角色或菜单发生非预期变更');
  return input.operation === 'legacy-role-delete' ? { id: target.id, deleted: true, deleted_role: roleSnapshot(target) } : { id: target.id, created: false };
}
function capabilityError(error: unknown): never {
  let next = error;
  for (let depth = 0; depth < 6 && next && typeof next === 'object'; depth++) {
    const code = 'code' in next ? String(next.code) : '';
    if (['42P01', '42501', '42883'].includes(code)) throw new ServiceUnavailableException('旧角色耐久操作或权限目录尚未就绪');
    if (code === '23505') throw conflict('操作ID已被使用，请恢复原操作'); next = 'cause' in next ? next.cause : undefined;
  }
  return adminAuthorityWriteError(error);
}

/** Dedicated legacy independent actions. Physical deletion and unchanged CSV
 * are proved on the same transaction as permanent owner-scoped evidence. */
export class AdminLegacyRoleOperationService {
  constructor(private readonly container: Container, private readonly appKey: string) {}
  private digest(domain: string, value: unknown): string {
    if (typeof this.appKey !== 'string' || !this.appKey) throw new ServiceUnavailableException('角色操作签名密钥尚未就绪');
    return createHmac('sha256', this.appKey).update(`cinashop.legacy-role.${domain}.v1\0${canonical(value)}`).digest('hex');
  }
  private async transaction<T>(actor: LegacyRoleActor, operation: LegacyRoleOperationKind, callback: (tx: DbClient, live: Live) => Promise<T>): Promise<T> {
    assertAdminAuthoritySession(actor);
    try { return await withTx(this.container, async tx => {
      await acquireAdminAuthorityWriteBarrier(tx); await acquireAdminAuthorityMenuLock(tx); await assertAdminLegacyRoleOperationReady(tx);
      const live = await liveActor(tx, actor, operation), result = await callback(tx, live); assertAdminAuthoritySession(actor); return result;
    }); } catch (error) { return capabilityError(error); }
  }
  private async recovery<T>(actor: LegacyRoleActor, callback: (tx: DbClient) => Promise<T>): Promise<T> {
    assertAdminAuthoritySession(actor);
    try { return await withTx(this.container, async tx => {
      await acquireAdminAuthorityWriteBarrier(tx); await identity(tx, actor); await assertAdminLegacyRoleOperationReady(tx);
      const result = await callback(tx); assertAdminAuthoritySession(actor); return result;
    }); } catch (error) { return capabilityError(error); }
  }
  async preview(value: unknown, actorInput: LegacyRoleActor): Promise<LegacyRolePreview> {
    const input = envelope(value), actor = Object.freeze({ ...actorInput }), requestHash = this.digest('request', { actorId: actor.id, ...input });
    return this.transaction(actor, input.operation, async (tx, live) => {
      if (await readReceipt(tx, input.operationId, actor.id, input.operation)) throw conflict('操作ID已有耐久结果，请恢复原操作');
      const current = await plan(tx, input.input, live), expiresAt = Math.min(Math.floor(Date.now() / 1000) + LEGACY_ROLE_PREVIEW_TTL_SECONDS, actor.expiresAt);
      return { operation_id: input.operationId, actor_id: actor.id, operation: input.operation, request_hash: requestHash,
        revision: this.digest('revision', { input, actor, requestHash, expiresAt, proof: current.proof }), expires_at: expiresAt, requires_confirmation: true, summary: current.summary };
    });
  }
  async commit(value: unknown, actorInput: LegacyRoleActor): Promise<LegacyRoleReceipt> {
    const input = envelope(value, true), row = object(value), actor = Object.freeze({ ...actorInput }); assertAdminAuthoritySession(actor);
    if (row.confirmed !== true || typeof row.revision !== 'string' || !/^[a-f0-9]{64}$/.test(row.revision)
      || typeof row.expires_at !== 'number' || !Number.isSafeInteger(row.expires_at)) throw new ValidateException('请明确确认角色影响及正确确认版本');
    const revision = row.revision, expiresAt = row.expires_at, requestHash = this.digest('request', { actorId: actor.id, ...input });
    return this.transaction(actor, input.operation, async (tx, live) => {
      const prior = await readReceipt(tx, input.operationId, actor.id, input.operation);
      if (prior) { if (prior.state === 'not_applied') throw conflict('操作已永久封存为未执行');
        if (!equalHash(prior.requestHash, requestHash)) throw conflict('操作ID与原提交内容不一致'); return receiptDto(prior); }
      const now = Math.floor(Date.now() / 1000);
      if (expiresAt <= now || expiresAt > now + LEGACY_ROLE_PREVIEW_TTL_SECONDS || expiresAt > actor.expiresAt) throw conflict('角色确认已过期，请重新预览');
      const current = await plan(tx, input.input, live);
      if (!equalHash(revision, this.digest('revision', { input, actor, requestHash, expiresAt, proof: current.proof }))) throw conflict('角色授权或完整影响范围已变化，请重新预览');
      assertAdminAuthoritySession(actor); const result = await apply(tx, current);
      return receiptDto(await appendReceipt(tx, { operationId: input.operationId, actorId: actor.id, adminType: 1, relationId: 0,
        operation: input.operation, state: 'committed', requestHash, revision, result, createdAt: Math.floor(Date.now() / 1000) }));
    });
  }
  setStatus(pathId: string, statusPath: string, metadata: LegacyRoleCommitMetadata, actor: LegacyRoleActor): Promise<LegacyRoleReceipt> {
    return this.commit({ ...metadata, operation: 'legacy-role-status', payload: { id: parseLegacyRoleOperationPathId(pathId), status: parseLegacyRoleOperationStatus(statusPath) } }, actor);
  }
  delete(pathId: string, metadata: LegacyRoleCommitMetadata, actor: LegacyRoleActor): Promise<LegacyRoleReceipt> {
    return this.commit({ ...metadata, operation: 'legacy-role-delete', payload: { id: parseLegacyRoleOperationPathId(pathId) } }, actor);
  }
  async receipt(idInput: unknown, operationInput: unknown, actorInput: LegacyRoleActor): Promise<LegacyRoleReceipt> {
    const id = operationId(idInput), operation = legacyRoleOperationKind(operationInput), actor = Object.freeze({ ...actorInput });
    return this.recovery(actor, async tx => { const row = await readReceipt(tx, id, actor.id, operation);
      return row ? receiptDto(row) : { operation_id: id, actor_id: actor.id, operation, state: 'unknown', request_hash: null, result: null }; });
  }
  async resolve(value: unknown, actorInput: LegacyRoleActor): Promise<LegacyRoleReceipt> {
    const row = object(value); only(row, ['operation_id', 'operation']);
    const id = operationId(row.operation_id), operation = legacyRoleOperationKind(row.operation), actor = Object.freeze({ ...actorInput });
    return this.recovery(actor, async tx => { const prior = await readReceipt(tx, id, actor.id, operation); if (prior) return receiptDto(prior);
      return receiptDto(await appendReceipt(tx, { operationId: id, actorId: actor.id, adminType: 1, relationId: 0, operation,
        state: 'not_applied', requestHash: '', revision: '', result: null, createdAt: Math.floor(Date.now() / 1000) })); });
  }
}
