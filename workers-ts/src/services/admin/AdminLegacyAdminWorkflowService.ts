import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { systemAdmin, systemMenus, systemRole } from '@/models/schema';
import { adminAuthorityOperation } from '@/models/schema/adminAuthorityOperation';
import { acquireAdminAuthorityMenuLock, assertAdminLegacyAdminOperationReady } from '@/migrations/adminAuthorityOperation';
import { ApiErrorCode, AuthException, HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { AdminPermissionService, canRetainOpaqueLegacyMenu, hasAdminPermission } from './AdminPermissionService';
import { loadAdminLegacyRoleDeletionProofs, loadAdminLegacyRoleReferenceHistory } from './AdminLegacyRoleDeletionProof';
import { acquireAdminAuthorityWriteBarrier, adminAuthorityWriteError, assertAdminAuthoritySession,
  assertRemainingActivePlatformSuperAdmin, normalizeAdminAuthorityRules, parseAdminAuthorityRoleIds,
  type AdminAuthorityActor } from './AdminAuthorityWriteService';

export type LegacyAdminOperationKind = 'legacy-admin-save' | 'legacy-admin-status' | 'legacy-admin-delete';
export type LegacyAdminActor = AdminAuthorityActor;
export type AdminLegacyAdminActor = LegacyAdminActor;
export const LEGACY_ADMIN_PREVIEW_TTL_SECONDS = 300;
export const MAX_LEGACY_ADMIN_ROLE_OPTIONS = 1_000;
export const MAX_LEGACY_ADMIN_MENU_ROWS = 10_000;
export interface LegacyAdminCommitMetadata { operation_id: string; revision: string; expires_at: number; confirmed: true }
export interface LegacyAdminResult { id: number; created?: boolean; deleted?: boolean }
export interface LegacyAdminReceipt {
  operation_id: string; actor_id: number; operation: LegacyAdminOperationKind;
  state: 'committed' | 'not_applied' | 'unknown'; request_hash: string | null; result: LegacyAdminResult | null;
}
export interface LegacyAdminValues {
  account: string; real_name: string; phone: string; roles: number[]; level: number; status: 0 | 1; is_del: 0 | 1;
}
export interface LegacyAdminPreview {
  operation_id: string; actor_id: number; operation: LegacyAdminOperationKind; request_hash: string;
  revision: string; expires_at: number; requires_confirmation: true;
  summary: { target_id: number; target_name: string; action: 'create' | 'update' | 'status' | 'delete';
    before: LegacyAdminValues | null; after: LegacyAdminValues & { password_changed: boolean } };
}
export interface LegacyAdminFormRule {
  type: 'input' | 'select' | 'radio'; field: string; title: string; value: string | number | number[];
  props?: Record<string, string | number | boolean>;
  options?: Array<{ value: number; label: string; disabled?: boolean }>;
  validate?: Array<{ required: boolean; message: string; type?: string }>;
}
export interface LegacyAdminFormDto { title: string; rules: LegacyAdminFormRule[]; action: string; method: 'POST' | 'PUT' }
interface Prepared { operation: LegacyAdminOperationKind; id: number; account?: string; realName?: string; phone?: string;
  roleIds?: number[]; roles?: string; password?: string; status?: 0 | 1 }
type AdminRow = typeof systemAdmin.$inferSelect;
type RoleRow = typeof systemRole.$inferSelect;
type MenuRow = typeof systemMenus.$inferSelect;
type ReceiptRow = typeof adminAuthorityOperation.$inferSelect;
interface Live { row: AdminRow; roleIds: number[]; roles: RoleRow[]; keys: Set<string>; numeric: Set<number> }
interface Catalogue { rows: MenuRow[]; byId: Map<number, MenuRow>; footprints: Map<number, string[]>; validPaths: Set<number> }
interface Plan { input: Prepared; live: Live; target?: AdminRow; fields: Partial<typeof systemAdmin.$inferInsert>;
  proof: unknown; summary: LegacyAdminPreview['summary'] }
const conflict = (message: string) => new HttpApiException(message, 409, 409);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const INTEGER = /^[1-9]\d*$/;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const forbiddenText = /[\u0000-\u001f\u007f-\u009f]/u;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('管理员提交数据格式错误');
  return value as Record<string, unknown>;
}
function only(row: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(row).some(key => !fields.includes(key))) throw new ValidateException('管理员提交包含未知字段');
}
export function legacyAdminOperationKind(value: unknown): LegacyAdminOperationKind {
  if (value !== 'legacy-admin-save' && value !== 'legacy-admin-status' && value !== 'legacy-admin-delete') {
    throw new ValidateException('旧管理员操作类型错误');
  }
  return value;
}
function operationId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ValidateException('操作ID必须为小写UUIDv4');
  return value;
}
export function parseLegacyAdminPathId(value: string, create = false): number {
  if (create && value === '0') return 0;
  if (!INTEGER.test(value) || value.length > 10 || !integer(Number(value))) throw new ValidateException('管理员ID必须为有效整数');
  return Number(value);
}
export function parseLegacyAdminStatus(value: string): 0 | 1 {
  if (value !== '0' && value !== '1') throw new ValidateException('管理员状态只能为0或1');
  return Number(value) as 0 | 1;
}
/** The original business body remains its seven fields. Missing confirmation
 * is a controlled conflict, never an unaudited shortcut to modern saves. */
export function parseLegacyAdminCommitMetadata(headers: Headers): LegacyAdminCommitMetadata {
  const id = headers.get('X-Admin-Operation-Id'), revision = headers.get('X-Admin-Revision');
  const expires = headers.get('X-Admin-Expires-At'), confirmed = headers.get('X-Admin-Confirmed');
  if (id === null || revision === null || expires === null || confirmed === null) throw conflict('请先预览并明确确认管理员变更');
  if (!UUID.test(id) || !/^[a-f0-9]{64}$/.test(revision) || !INTEGER.test(expires) || expires.length > 10
    || !Number.isSafeInteger(Number(expires)) || confirmed !== 'true') throw new ValidateException('管理员确认metadata错误');
  return { operation_id: id, revision, expires_at: Number(expires), confirmed: true };
}
function text(value: unknown, name: string, max: number, required = true): string {
  if (typeof value !== 'string' || forbiddenText.test(value) || [...value].length > max || required && !value.trim()) {
    throw new ValidateException(`${name}格式错误或超出存储长度`);
  }
  return value;
}
export function parseLegacyAdminSave(pathId: string, body: unknown): Prepared {
  const id = parseLegacyAdminPathId(pathId, true), row = object(body);
  only(row, ['account', 'conf_pwd', 'pwd', 'real_name', 'phone', 'roles', 'status']);
  const account = text(row.account, '管理员账号', 32);
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(account)) throw new ValidateException('管理员账号须为4到32位字母、数字、下划线或横线');
  const realName = text(row.real_name, '管理员姓名', 16), phone = text(row.phone, '管理员电话', 32);
  // The actual ThinkPHP mobile rule is /^1[3-9]\d{9}$/; varchar(32)
  // capacity alone is not this legacy phone contract.
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new ValidateException('电话格式不正确');
  const password = row.pwd === undefined ? '' : text(row.pwd, '管理员密码', 72, false);
  const confirmation = row.conf_pwd === undefined ? '' : text(row.conf_pwd, '确认密码', 72, false);
  if (!id && !password) throw new ValidateException('新管理员密码至少12位');
  if (password && ([...password].length < 12 || new TextEncoder().encode(password).length > 72)) {
    throw new ValidateException('管理员密码至少12位且UTF-8编码不能超过72字节');
  }
  if (password !== confirmation) throw new ValidateException('两次输入的密码不相同');
  if (!Array.isArray(row.roles) || !row.roles.length || row.roles.length > 128
    || [...row.roles].some(role => !integer(role))) throw new ValidateException('请选择有效的数字身份ID数组');
  const roleIds = [...new Set(row.roles as number[])].sort((a, b) => a - b), roles = roleIds.join(',');
  if (roles.length > 128) throw new ValidateException('身份ID合计不能超过128字符');
  const status = row.status === undefined ? 0 : row.status;
  if (status !== 0 && status !== 1) throw new ValidateException('管理员状态只能为0或1');
  return Object.freeze({ operation: 'legacy-admin-save', id, account, realName, phone, roleIds, roles, password, status });
}
function prepared(operation: LegacyAdminOperationKind, value: unknown): Prepared {
  const row = object(value);
  if (operation === 'legacy-admin-save') {
    only(row, ['id', 'account', 'conf_pwd', 'pwd', 'real_name', 'phone', 'roles', 'status']);
    if (row.id !== 0 && !integer(row.id)) throw new ValidateException('管理员ID错误');
    const { id, ...body } = row;
    return parseLegacyAdminSave(String(id), body);
  }
  only(row, operation === 'legacy-admin-status' ? ['id', 'status'] : ['id']);
  if (!integer(row.id)) throw new ValidateException('管理员ID错误');
  if (operation === 'legacy-admin-status' && row.status !== 0 && row.status !== 1) throw new ValidateException('管理员状态只能为0或1');
  return Object.freeze({ operation, id: row.id, ...(operation === 'legacy-admin-status' ? { status: row.status as 0 | 1 } : {}) });
}
function envelope(value: unknown, commit = false) {
  const row = object(value);
  only(row, commit ? ['operation_id', 'operation', 'payload', 'revision', 'expires_at', 'confirmed'] : ['operation_id', 'operation', 'payload']);
  const operation = legacyAdminOperationKind(row.operation);
  return { operationId: operationId(row.operation_id), operation, input: prepared(operation, row.payload) };
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  throw new ValidateException('管理员操作包含不能签名的数据');
}
function equalHash(value: string, expected: string): boolean {
  return /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(new TextEncoder().encode(value), new TextEncoder().encode(expected));
}
function capabilityError(error: unknown): never {
  let next = error;
  for (let depth = 0; depth < 6 && next && typeof next === 'object'; depth++) {
    const code = 'code' in next ? String(next.code) : '';
    if (['42P01', '42501', '42883'].includes(code)) throw new ServiceUnavailableException('旧管理员耐久操作或权限目录尚未就绪');
    if (code === '23505') throw conflict('操作ID已被使用，请恢复原操作');
    next = 'cause' in next ? next.cause : undefined;
  }
  return adminAuthorityWriteError(error);
}
async function identity(tx: DbClient, actor: LegacyAdminActor): Promise<AdminRow> {
  assertAdminAuthoritySession(actor);
  const [row] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
  if (!row || row.adminType !== 1 || row.relationId !== 0 || row.status !== 1 || row.isDel !== 0) {
    throw new AuthException('管理员已禁用或身份已变化', ApiErrorCode.ERR_BANNED);
  }
  if (!timingSafeEqual(new TextEncoder().encode(md5(row.pwd)), new TextEncoder().encode(actor.authVersion))) {
    throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
  }
  return row;
}
async function liveActor(tx: DbClient, actor: LegacyAdminActor, write: boolean): Promise<Live> {
  const row = await identity(tx, actor);
  if (!Number.isInteger(row.level) || row.level < 0 || row.level > 9) throw new AuthException('管理员层级不支持下一层级表单', ApiErrorCode.ERR_AUTH);
  const roleIds = parseAdminAuthorityRoleIds(row.roles);
  const history = await loadAdminLegacyRoleReferenceHistory(tx, roleIds, row.level);
  const roles = history.roles.filter(role => role.status === 1);
  for (const role of roles) normalizeAdminAuthorityRules(role.rules);
  const permissions = new AdminPermissionService(createContainerFromDb(tx));
  const assignment = await permissions.resolveRoleAssignment(row.roles, write);
  const keys = row.level === 0 ? await permissions.resolveAdminPermissionKeys(row) : assignment.keys;
  if (row.level !== 0 && !hasAdminPermission(keys,
    write ? 'system.legacy_admin_manage' : 'system.legacy_admin_form_view')) throw new AuthException('旧管理员表单权限已变化', ApiErrorCode.ERR_AUTH);
  return { row, roleIds, roles, keys, numeric: new Set(assignment.legacyRuleIds) };
}
function pureStructure(row: MenuRow): boolean {
  return row.authType === 0 && !row.apiUrl.trim() && !row.menuPath.trim() && !row.uniqueAuth.trim();
}
function grantMetadata(row: MenuRow): boolean {
  if (row.authType === 1) return !!row.menuPath.trim();
  if (row.authType !== 2 || !row.apiUrl.trim()) return false;
  const methods = row.methods.split(/[\s,|]+/).filter(Boolean).map(method => method.toUpperCase());
  return !!methods.length && methods.every(method => ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method));
}
async function catalogue(tx: DbClient): Promise<Catalogue> {
  // Full rows, including deleted/disabled metadata, bind the confirmation.
  const rows = await tx.select().from(systemMenus).where(eq(systemMenus.type, 1)).orderBy(asc(systemMenus.id)).limit(MAX_LEGACY_ADMIN_MENU_ROWS + 1);
  if (rows.length > MAX_LEGACY_ADMIN_MENU_ROWS) throw new ServiceUnavailableException('权限目录超过10000，请先整理目录');
  const active = rows.filter(row => row.access === 1 && row.isDel === 0), byId = new Map(active.map(row => [row.id, row]));
  const keys = await new AdminPermissionService(createContainerFromDb(tx)).resolveManyRulePermissionKeys(active.map(row => String(row.id)));
  const footprints = new Map(active.map((row, index) => [row.id, keys[index]])), validPaths = new Set<number>();
  for (const row of active) {
    let id = row.id, depth = 0, valid = true;
    const seen = new Set<number>();
    while (id !== 0) {
      const parent = byId.get(id);
      if (!parent || seen.has(id) || parent.pid < 0 || ++depth > 64) { valid = false; break; }
      seen.add(id); id = parent.pid;
    }
    if (valid) validPaths.add(row.id);
  }
  return { rows, byId, footprints, validPaths };
}
/** Check every persisted token before resolution can drop unknown grants. */
function delegable(role: RoleRow, live: Live, directory: Catalogue, effective = true): void {
  const normalized = normalizeAdminAuthorityRules(role.rules), tokens = normalized ? normalized.split(',') : [];
  const selectedGrants: number[] = [], structural: number[] = [];
  for (const token of tokens) {
    if (!INTEGER.test(token)) {
      if (effective && live.row.level !== 0 && !hasAdminPermission(live.keys, token)) throw new AuthException('身份权限超出可委派范围', ApiErrorCode.ERR_AUTH);
      continue;
    }
    const id = Number(token), row = directory.byId.get(id);
    if (!row || !directory.validPaths.has(id)) throw conflict('身份菜单缺失、已停用或层级无效');
    if (pureStructure(row)) { structural.push(id); continue; }
    const footprint = directory.footprints.get(id)!;
    if (!grantMetadata(row) || !footprint.length && !canRetainOpaqueLegacyMenu(row)) throw conflict('身份菜单不能完整表达或已受保护');
    if (effective && live.row.level !== 0 && (footprint.length ? footprint.some(key => !hasAdminPermission(live.keys, key)) : !live.numeric.has(id))) {
      throw new AuthException('身份菜单超出可委派范围', ApiErrorCode.ERR_AUTH);
    }
    selectedGrants.push(id);
  }
  const ancestors = new Set<number>();
  for (const id of selectedGrants) {
    let next = directory.byId.get(id)!.pid;
    while (next && !ancestors.has(next)) { ancestors.add(next); next = directory.byId.get(next)!.pid; }
  }
  if (structural.some(id => !ancestors.has(id))) throw conflict('身份结构菜单不是已授权限的上级');
}
async function target(tx: DbClient, id: number, live: Live): Promise<AdminRow> {
  if (id === live.row.id) throw conflict('不能通过下一级管理员合同修改本人');
  const [row] = await tx.select().from(systemAdmin).where(and(eq(systemAdmin.id, id), eq(systemAdmin.adminType, 1),
    eq(systemAdmin.relationId, 0), eq(systemAdmin.isDel, 0), eq(systemAdmin.level, live.row.level + 1), inArray(systemAdmin.status, [0, 1]))).limit(1);
  if (!row) throw new NotFoundException('下一级管理员不存在');
  return row;
}
async function rolesAtNextLevel(tx: DbClient, live: Live): Promise<RoleRow[]> {
  const rows = await tx.select().from(systemRole).where(and(inArray(systemRole.type, [0, 1]), eq(systemRole.relationId, 0),
    eq(systemRole.level, live.row.level + 1), eq(systemRole.status, 1))).orderBy(asc(systemRole.id)).limit(MAX_LEGACY_ADMIN_ROLE_OPTIONS + 1);
  if (rows.length > MAX_LEGACY_ADMIN_ROLE_OPTIONS) throw new ServiceUnavailableException('下一级身份超过1000，请先整理目录');
  return rows;
}
function requireRoles(ids: number[], rows: RoleRow[], live: Live, directory: Catalogue): void {
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) throw conflict('身份不存在、未启用或不属于下一级平台');
    delegable(row, live, directory);
  }
}
interface AssignedLegacyRole { id: number; roleName: string; status: number; deleted?: true }
async function currentRoles(tx: DbClient, current: AdminRow, live: Live, directory: Catalogue): Promise<AssignedLegacyRole[]> {
  const ids = parseAdminAuthorityRoleIds(current.roles);
  const history = await loadAdminLegacyRoleReferenceHistory(tx, ids, live.row.level + 1, true);
  for (const role of history.roles) delegable(role, live, directory, role.status === 1);
  // These are explicit disabled display choices, never synthetic database rows
  // or assignable roles. Only the immutable deletion snapshot supplies a label.
  return [...history.roles, ...[...history.deleted.values()].map(role => ({
    id: role.id, roleName: role.role_name, status: -1, deleted: true as const,
  }))].sort((a,b) => a.id-b.id);
}
function values(row: AdminRow): LegacyAdminValues {
  if (![0, 1].includes(row.status) || ![0, 1].includes(row.isDel) || !Number.isInteger(row.level) || row.level < 0 || row.level > 10) {
    throw new ServiceUnavailableException('管理员存储数据不完整');
  }
  return { account: row.account, real_name: row.realName, phone: row.phone, roles: parseAdminAuthorityRoleIds(row.roles),
    level: row.level, status: row.status as 0 | 1, is_del: row.isDel as 0 | 1 };
}
async function plan(tx: DbClient, input: Prepared, live: Live): Promise<Plan> {
  const current = input.id ? await target(tx, input.id, live) : undefined, directory = await catalogue(tx), roles = await rolesAtNextLevel(tx, live);
  for (const role of live.roles) delegable(role, live, directory, false);
  // A current role outside the actor's live delegation is not made harmless by
  // replacing it with an empty/mapped subset during an account-only edit.
  // Disabled/deleted role rows carry no effective authority. Preserve their
  // complete identities and validate all tokens, rather than preventing safe
  // account repair/retirement or silently dropping missing/foreign identities.
  if (current) await currentRoles(tx, current, live, directory);
  if (input.roleIds) requireRoles(input.roleIds, roles, live, directory);
  const relevantRoleIds = new Set([...live.roleIds, ...parseAdminAuthorityRoleIds(current?.roles ?? ''), ...(input.roleIds ?? [])]);
  const relevantRoles = relevantRoleIds.size ? await tx.select().from(systemRole).where(inArray(systemRole.id, [...relevantRoleIds])).orderBy(asc(systemRole.id)) : [];
  const physicallyPresent = new Set(relevantRoles.map(role => role.id));
  const deletedRoleEvidence = [...(await loadAdminLegacyRoleDeletionProofs(tx,
    [...relevantRoleIds].filter(id => !physicallyPresent.has(id)))).values()].sort((a,b) => a.id-b.id);
  let uniqueness: AdminRow[] = [];
  if (input.operation === 'legacy-admin-save') {
    uniqueness = await tx.select().from(systemAdmin).where(and(eq(systemAdmin.adminType, 1), eq(systemAdmin.relationId, 0), eq(systemAdmin.isDel, 0),
      ne(systemAdmin.id, input.id), or(eq(systemAdmin.account, input.account!), eq(systemAdmin.phone, input.phone!)))).orderBy(asc(systemAdmin.id)).limit(MAX_LEGACY_ADMIN_MENU_ROWS + 1);
    if (uniqueness.length > MAX_LEGACY_ADMIN_MENU_ROWS) throw new ServiceUnavailableException('管理员重复目录超过10000，请先整理目录');
    if (uniqueness.some(row => row.account === input.account)) throw conflict('管理员账号已存在');
    if (uniqueness.some(row => row.phone === input.phone)) throw conflict('管理员电话已存在');
  }
  if (current?.id === live.row.id) throw conflict('不能修改本人账号的权限、状态或等级');
  if (current?.level === 0 && current.status === 1 && (input.status === 0 || input.operation === 'legacy-admin-delete')) {
    await assertRemainingActivePlatformSuperAdmin(tx, current.id);
  }
  const fields = input.operation === 'legacy-admin-save' ? { account: input.account!, realName: input.realName!, phone: input.phone!,
    roles: input.roles!, status: input.status! } : input.operation === 'legacy-admin-status' ? { status: input.status! } : { status: 0, isDel: 1 };
  const before = current ? values(current) : null;
  const after: LegacyAdminPreview['summary']['after'] = { account: input.account ?? current?.account ?? '', real_name: input.realName ?? current?.realName ?? '',
    phone: input.phone ?? current?.phone ?? '', roles: input.roleIds ?? parseAdminAuthorityRoleIds(current?.roles ?? ''), level: live.row.level + 1,
    status: input.operation === 'legacy-admin-delete' ? 0 : input.status ?? current!.status as 0 | 1,
    is_del: input.operation === 'legacy-admin-delete' ? 1 : 0, password_changed: !!input.password };
  return { input, live, target: current, fields, summary: { target_id: input.id, target_name: after.real_name || after.account,
    action: input.operation === 'legacy-admin-delete' ? 'delete' : input.operation === 'legacy-admin-status' ? 'status' : current ? 'update' : 'create', before, after },
    proof: { actor: live.row, actorRoles: live.roles, target: current, relevantRoles, deletedRoleEvidence, nextLevelRoles: roles, menus: directory.rows,
      input, fields, uniqueness, permissions: new AdminPermissionService(createContainerFromDb(tx)).permissionTree() } };
}
function receiptDto(row: ReceiptRow): LegacyAdminReceipt {
  return { operation_id: row.operationId, actor_id: row.actorId, operation: legacyAdminOperationKind(row.operation),
    state: row.state as 'committed' | 'not_applied', request_hash: row.state === 'committed' ? row.requestHash : null, result: row.result };
}
function validateReceipt(row: ReceiptRow, actorId: number, operation: LegacyAdminOperationKind): void {
  if (row.actorId !== actorId || row.adminType !== 1 || row.relationId !== 0) throw new AuthException('无权读取该管理员操作', ApiErrorCode.ERR_AUTH);
  if (row.operation !== operation) throw conflict('操作ID与原操作类型不一致');
  const result = row.result;
  if (!UUID.test(row.operationId) || !Number.isSafeInteger(row.createdAt) || row.createdAt <= 0
    || row.state !== 'committed' && row.state !== 'not_applied'
    || row.state === 'not_applied' && (row.requestHash !== '' || row.revision !== '' || result !== null)
    || row.state === 'committed' && (!/^[a-f0-9]{64}$/.test(row.requestHash) || !/^[a-f0-9]{64}$/.test(row.revision)
      || !result || !integer(result.id) || operation === 'legacy-admin-delete' && (result.deleted !== true || result.created !== undefined)
      || operation !== 'legacy-admin-delete' && (typeof result.created !== 'boolean' || result.deleted !== undefined)
      || operation === 'legacy-admin-status' && result.created !== false
      || Object.keys(result).some(key => !['id', operation === 'legacy-admin-delete' ? 'deleted' : 'created'].includes(key)))) {
    throw new ServiceUnavailableException('管理员操作回执数据不完整');
  }
}
async function readReceipt(tx: DbClient, id: string, actor: number, operation: LegacyAdminOperationKind): Promise<ReceiptRow | undefined> {
  const [row] = await tx.select().from(adminAuthorityOperation).where(eq(adminAuthorityOperation.operationId, id)).limit(1);
  if (row) validateReceipt(row, actor, operation);
  return row;
}
async function appendReceipt(tx: DbClient, input: typeof adminAuthorityOperation.$inferInsert): Promise<ReceiptRow> {
  const rows = await tx.insert(adminAuthorityOperation).values(input).returning();
  if (rows.length !== 1 || canonical(rows[0]) !== canonical(input)) throw conflict('管理员操作回执保存结果不一致');
  validateReceipt(rows[0], input.actorId, legacyAdminOperationKind(input.operation));
  const [stored] = await tx.select().from(adminAuthorityOperation).where(eq(adminAuthorityOperation.operationId, input.operationId)).limit(1);
  if (!stored || canonical(stored) !== canonical(rows[0])) throw conflict('管理员操作回执回读不一致');
  return stored;
}
async function apply(tx: DbClient, current: Plan, passwordHash?: string): Promise<LegacyAdminResult> {
  const { input, target: previous, live } = current;
  const expected = previous ? { ...previous, ...current.fields, ...(passwordHash ? { pwd: passwordHash } : {}) }
    : { account: input.account!, realName: input.realName!, phone: input.phone!, pwd: passwordHash!, roles: input.roles!, level: live.row.level + 1,
      status: input.status!, adminType: 1, relationId: 0, isDel: 0, headPic: '', lastIp: '', lastTime: 0, addTime: Math.floor(Date.now() / 1000),
      loginCount: 0, isWay: 0, divisionId: 0 };
  const rows = previous ? await tx.update(systemAdmin).set({ ...current.fields, ...(passwordHash ? { pwd: passwordHash } : {}) })
    .where(and(eq(systemAdmin.id, previous.id), eq(systemAdmin.adminType, 1), eq(systemAdmin.relationId, 0), eq(systemAdmin.isDel, 0),
      eq(systemAdmin.level, live.row.level + 1), eq(systemAdmin.status, previous.status))).returning()
    : await tx.insert(systemAdmin).values(expected).returning();
  if (rows.length !== 1 || !integer(rows[0].id) || previous && rows[0].id !== previous.id
    || Object.entries(expected).some(([key, value]) => (rows[0] as unknown as Record<string, unknown>)[key] !== value)) throw conflict('管理员保存结果不一致');
  const [stored] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, rows[0].id)).limit(1);
  if (!stored || canonical(stored) !== canonical(rows[0])) throw conflict('管理员保存回读不一致');
  return input.operation === 'legacy-admin-delete' ? { id: rows[0].id, deleted: true } : { id: rows[0].id, created: !previous };
}
function form(row: AdminRow | undefined, options: Array<{ value: number; label: string; disabled?: boolean }>): LegacyAdminFormDto {
  const required = (message: string) => [{ required: true, message }];
  return { title: row ? '管理员修改' : '管理员添加', action: row ? `setting/admin/${row.id}` : 'setting/admin', method: row ? 'PUT' : 'POST', rules: [
    { type: 'input', field: 'account', title: '管理员账号', value: row?.account ?? '', props: { maxlength: 32, minlength: 4 }, validate: required('请填写管理员账号') },
    { type: 'input', field: 'pwd', title: '管理员密码', value: '', props: { type: 'password', placeholder: row ? '不修改密码请留空；至少12位且不超过72字节' : '至少12位且不超过72字节' }, ...(row ? {} : { validate: required('请填写管理员密码') }) },
    { type: 'input', field: 'conf_pwd', title: '确认密码', value: '', props: { type: 'password' }, ...(row ? {} : { validate: required('请输入确认密码') }) },
    { type: 'input', field: 'real_name', title: '管理员姓名', value: row?.realName ?? '', props: { maxlength: 16 }, validate: required('请输入管理员姓名') },
    { type: 'input', field: 'phone', title: '管理员电话', value: row?.phone ?? '', props: { maxlength: 11 }, validate: required('请填写管理员电话') },
    { type: 'select', field: 'roles', title: '管理员身份', value: row ? parseAdminAuthorityRoleIds(row.roles) : [], props: { multiple: true }, options, validate: [{ required: true, type: 'array', message: '请选择管理员身份' }] },
    { type: 'radio', field: 'status', title: '状态', value: row?.status ?? 1, options: [{ value: 1, label: '开启' }, { value: 0, label: '关闭' }] },
  ] };
}

/** Dedicated next-level legacy staff policy. Its operation domain and
 * recovery callbacks cannot invoke modern full-level authority mutation. */
export class AdminLegacyAdminWorkflowService {
  constructor(private readonly container: Container, private readonly appKey: string) {}
  private digest(domain: string, value: unknown): string {
    if (typeof this.appKey !== 'string' || !this.appKey) throw new ServiceUnavailableException('管理员操作签名密钥尚未就绪');
    return createHmac('sha256', this.appKey).update(`cinashop.legacy-admin.${domain}.v1\0${canonical(value)}`).digest('hex');
  }
  private async read(query: URLSearchParams, actor: LegacyAdminActor, id?: number): Promise<LegacyAdminFormDto> {
    if (query.size) throw new ValidateException('管理员表单不接受查询参数');
    assertAdminAuthoritySession(actor);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`); await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
      await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
      const live = await liveActor(tx, actor, false), directory = await catalogue(tx), roles = await rolesAtNextLevel(tx, live);
      for (const role of live.roles) delegable(role, live, directory, false);
      const current = id ? await target(tx, id, live) : undefined;
      const assigned = current ? await currentRoles(tx, current, live, directory) : [];
      const options: Array<{ value: number; label: string; disabled?: boolean }> = [];
      for (const role of roles) {
        try { delegable(role, live, directory); options.push({ value: role.id, label: role.roleName }); }
        catch (error) {
          if (!(error instanceof AuthException || error instanceof ValidateException || error instanceof HttpApiException && error.httpStatus === 409)) throw error;
        }
      }
      for (const role of assigned) if (role.status !== 1) options.push({ value: role.id,
        label: `${role.roleName}（当前${role.deleted ? '已删除' : '停用'}身份，保存时请移除）`, disabled: true });
      options.sort((a, b) => a.value - b.value);
      if (options.length > MAX_LEGACY_ADMIN_ROLE_OPTIONS) throw new ServiceUnavailableException('身份回显超过1000，请先整理目录');
      assertAdminAuthoritySession(actor); return form(current, options);
    });
  }
  createForm(query: URLSearchParams, actor: LegacyAdminActor): Promise<LegacyAdminFormDto> { return this.read(query, actor); }
  editForm(pathId: string, query: URLSearchParams, actor: LegacyAdminActor): Promise<LegacyAdminFormDto> { return this.read(query, actor, parseLegacyAdminPathId(pathId)); }
  private async transaction<T>(actor: LegacyAdminActor, callback: (tx: DbClient, live: Live) => Promise<T>): Promise<T> {
    assertAdminAuthoritySession(actor);
    try {
      return await withTx(this.container, async tx => {
        await acquireAdminAuthorityWriteBarrier(tx); await acquireAdminAuthorityMenuLock(tx);
        const live = await liveActor(tx, actor, true); await assertAdminLegacyAdminOperationReady(tx);
        const result = await callback(tx, live); assertAdminAuthoritySession(actor); return result;
      });
    } catch (error) { return capabilityError(error); }
  }
  private async recovery<T>(actor: LegacyAdminActor, callback: (tx: DbClient) => Promise<T>): Promise<T> {
    assertAdminAuthoritySession(actor);
    try {
      return await withTx(this.container, async tx => {
        await acquireAdminAuthorityWriteBarrier(tx); await identity(tx, actor); await assertAdminLegacyAdminOperationReady(tx);
        const result = await callback(tx); assertAdminAuthoritySession(actor); return result;
      });
    } catch (error) { return capabilityError(error); }
  }
  async preview(value: unknown, actorInput: LegacyAdminActor): Promise<LegacyAdminPreview> {
    const input = envelope(value), actor = Object.freeze({ ...actorInput });
    const requestHash = this.digest('request', { actorId: actor.id, ...input });
    return this.transaction(actor, async (tx, live) => {
      if (await readReceipt(tx, input.operationId, actor.id, input.operation)) throw conflict('操作ID已有耐久结果，请恢复原操作');
      const current = await plan(tx, input.input, live), expiresAt = Math.min(Math.floor(Date.now() / 1000) + LEGACY_ADMIN_PREVIEW_TTL_SECONDS, actor.expiresAt);
      return { operation_id: input.operationId, actor_id: actor.id, operation: input.operation, request_hash: requestHash,
        revision: this.digest('revision', { input, actor, requestHash, expiresAt, proof: current.proof }), expires_at: expiresAt,
        requires_confirmation: true, summary: current.summary };
    });
  }
  async commit(value: unknown, actorInput: LegacyAdminActor): Promise<LegacyAdminReceipt> {
    const input = envelope(value, true), row = object(value), actor = Object.freeze({ ...actorInput });
    assertAdminAuthoritySession(actor);
    if (row.confirmed !== true) throw new ValidateException('请明确确认管理员变更');
    if (typeof row.revision !== 'string' || !/^[a-f0-9]{64}$/.test(row.revision) || typeof row.expires_at !== 'number' || !Number.isSafeInteger(row.expires_at)) {
      throw new ValidateException('管理员确认版本参数错误');
    }
    const revision = row.revision, expiresAt = row.expires_at, requestHash = this.digest('request', { actorId: actor.id, ...input });
    const passwordHash = input.input.password ? await bcrypt.hash(input.input.password, 12) : undefined;
    return this.transaction(actor, async (tx, live) => {
      const prior = await readReceipt(tx, input.operationId, actor.id, input.operation);
      if (prior) {
        if (prior.state === 'not_applied') throw conflict('操作已永久封存为未执行');
        if (!equalHash(prior.requestHash, requestHash)) throw conflict('操作ID与原提交内容不一致');
        return receiptDto(prior);
      }
      const now = Math.floor(Date.now() / 1000);
      if (expiresAt <= now || expiresAt > now + LEGACY_ADMIN_PREVIEW_TTL_SECONDS || expiresAt > actor.expiresAt) throw conflict('管理员确认已过期，请重新预览');
      const current = await plan(tx, input.input, live);
      if (!equalHash(revision, this.digest('revision', { input, actor, requestHash, expiresAt, proof: current.proof }))) throw conflict('管理员权限或完整变更范围已变化，请重新预览');
      assertAdminAuthoritySession(actor);
      const result = await apply(tx, current, passwordHash);
      return receiptDto(await appendReceipt(tx, { operationId: input.operationId, actorId: actor.id, adminType: 1, relationId: 0,
        operation: input.operation, state: 'committed', requestHash, revision, result, createdAt: Math.floor(Date.now() / 1000) }));
    });
  }
  save(pathId: string, body: unknown, metadata: LegacyAdminCommitMetadata, actor: LegacyAdminActor): Promise<LegacyAdminReceipt> {
    const input = parseLegacyAdminSave(pathId, body);
    return this.commit({ ...metadata, operation: 'legacy-admin-save', payload: { id: input.id, ...object(body) } }, actor);
  }
  setStatus(pathId: string, statusPath: string, metadata: LegacyAdminCommitMetadata, actor: LegacyAdminActor): Promise<LegacyAdminReceipt> {
    return this.commit({ ...metadata, operation: 'legacy-admin-status', payload: { id: parseLegacyAdminPathId(pathId), status: parseLegacyAdminStatus(statusPath) } }, actor);
  }
  delete(pathId: string, metadata: LegacyAdminCommitMetadata, actor: LegacyAdminActor): Promise<LegacyAdminReceipt> {
    return this.commit({ ...metadata, operation: 'legacy-admin-delete', payload: { id: parseLegacyAdminPathId(pathId) } }, actor);
  }
  async receipt(idInput: unknown, operationInput: unknown, actorInput: LegacyAdminActor): Promise<LegacyAdminReceipt> {
    const id = operationId(idInput), operation = legacyAdminOperationKind(operationInput), actor = Object.freeze({ ...actorInput });
    return this.recovery(actor, async tx => {
      const row = await readReceipt(tx, id, actor.id, operation);
      return row ? receiptDto(row) : { operation_id: id, actor_id: actor.id, operation, state: 'unknown', request_hash: null, result: null };
    });
  }
  async resolve(value: unknown, actorInput: LegacyAdminActor): Promise<LegacyAdminReceipt> {
    const row = object(value); only(row, ['operation_id', 'operation']);
    const id = operationId(row.operation_id), operation = legacyAdminOperationKind(row.operation), actor = Object.freeze({ ...actorInput });
    return this.recovery(actor, async tx => {
      const prior = await readReceipt(tx, id, actor.id, operation);
      if (prior) return receiptDto(prior);
      return receiptDto(await appendReceipt(tx, { operationId: id, actorId: actor.id, adminType: 1, relationId: 0, operation,
        state: 'not_applied', requestHash: '', revision: '', result: null, createdAt: Math.floor(Date.now() / 1000) }));
    });
  }
}
