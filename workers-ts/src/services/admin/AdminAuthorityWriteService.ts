import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { createHash, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { systemAdmin, systemRole } from '@/models/schema';
import { ApiErrorCode, AuthException, HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { AdminPermissionService, assertDelegablePermissions, hasAdminPermission, normalizeRoleRules } from './AdminPermissionService';

export interface AdminAuthorityActor { id: number; authVersion: string; expiresAt: number }
export interface AdminAuthorityLiveActor {
  id: number; level: number; roles: string; roleIds: number[]; divisionId: number;
  keys: Set<string>; legacyRuleIds: number[];
}
export type AdminAuthorityRoleRow = typeof systemRole.$inferSelect;
export const MAX_ADMIN_AUTHORITY_RULE_CHARACTERS = 16_384;
export const MAX_ADMIN_AUTHORITY_RULE_TOKENS = 2_048;
export const MAX_ADMIN_AUTHORITY_ROLE_REFERENCES = 1_000;
const conflict = (message: string) => new HttpApiException(message, 409, 409);
const integerId = (value: unknown): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;

export function assertAdminAuthoritySession(actor: AdminAuthorityActor): void {
  if (!integerId(actor.id) || typeof actor.authVersion !== 'string' || !/^[a-f0-9]{32}$/.test(actor.authVersion)
    || !Number.isSafeInteger(actor.expiresAt) || actor.expiresAt <= 0) throw new AuthException('请重新登录', ApiErrorCode.ERR_LOGIN);
  if (actor.expiresAt <= Math.floor(Date.now() / 1000)) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
}

/** This validates the entire persisted/requested CSV before permission services
 * can apply their legacy token limit. PostgreSQL varchar bounds characters. */
export function parseAdminAuthorityRoleIds(value: string): number[] {
  if (typeof value !== 'string' || [...value].length > 128) throw new ValidateException('角色 ID 数据最多 128 个字符');
  const tokens = value.split(',').map(item => item.trim()).filter(Boolean);
  if (tokens.some(token => !/^[1-9]\d*$/.test(token) || token.length > 10 || !integerId(Number(token)))) {
    throw new ValidateException('角色 ID 格式错误');
  }
  return [...new Set(tokens.map(Number))];
}

function boundedRuleSource(value: unknown): string {
  if (typeof value !== 'string' && !(Array.isArray(value) && value.every(token => typeof token === 'string'))) {
    throw new ValidateException('角色权限参数错误');
  }
  const source = typeof value === 'string' ? value : value.join(',');
  if (source.length > MAX_ADMIN_AUTHORITY_RULE_CHARACTERS || /[\u0000-\u001f\u007f-\u009f]/u.test(source)) {
    throw new ValidateException('角色权限数据过大或包含控制字符');
  }
  const tokens = [...new Set(source.split(',').map(token => token.trim()).filter(Boolean))];
  if (tokens.length > MAX_ADMIN_AUTHORITY_RULE_TOKENS) throw new ValidateException('角色权限最多 2048 条');
  if (tokens.some(token => /^\d+$/.test(token) && (!/^[1-9]\d*$/.test(token) || token.length > 10 || !integerId(Number(token))))) {
    throw new ValidateException('角色菜单 ID 格式错误');
  }
  return source;
}
export function normalizeAdminAuthorityRules(value: unknown): string {
  const normalized = normalizeRoleRules(boundedRuleSource(value));
  // Manage expansion can add tokens; validate the completed value as well.
  boundedRuleSource(normalized);
  return normalized;
}
/** Compare only complete, recognized representations. Unknown strings and
 * invalid/oversized legacy data must never look equivalent after resolution
 * drops an unrecognized grant or silently truncates a token list. */
function sameAdminAuthorityRuleSemantics(current: string, requested: string): boolean {
  try {
    return normalizeAdminAuthorityRules(current) === normalizeAdminAuthorityRules(requested);
  } catch (error) {
    if (error instanceof ValidateException) return false;
    throw error;
  }
}

/** A common table barrier also blocks rows which do not exist yet. Row locks
 * on the current references alone cannot serialize a new roles assignment.
 * UPDATE privilege permits this mode in PG16; dedicated Admin LOGINs already
 * require UPDATE on both tables. Do not replace it with an advisory-only lock. */
export async function acquireAdminAuthorityWriteBarrier(tx: DbClient): Promise<void> {
  await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
  await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
  await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
  await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
  await tx.execute(sql`LOCK TABLE ONLY public.system_admin, ONLY public.system_role IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
}

export function adminAuthorityWriteError(error: unknown): never {
  let cause: unknown = error;
  for (let depth = 0; depth < 4 && cause && typeof cause === 'object'; depth++) {
    const code = 'code' in cause ? String(cause.code) : '';
    if (['55P03', '40P01', '40001'].includes(code)) throw conflict('管理员权限正在变更，请刷新后重试');
    if (code === '57014') throw new ServiceUnavailableException('管理员权限操作超时，请稍后重试');
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}

async function validateRoleRulesBeforeResolution(tx: DbClient, roleIds: number[]): Promise<void> {
  if (!roleIds.length) return;
  const rows = await tx.select({ rules: systemRole.rules }).from(systemRole).where(and(inArray(systemRole.id, roleIds),
    inArray(systemRole.type, [0, 1]), eq(systemRole.relationId, 0), eq(systemRole.status, 1)));
  for (const row of rows) boundedRuleSource(row.rules);
}

/** Called only after acquireAdminAuthorityWriteBarrier by write consumers. */
export async function loadAdminAuthorityLiveActor(tx: DbClient, actor: AdminAuthorityActor,
  requiredCapability: string): Promise<AdminAuthorityLiveActor> {
  assertAdminAuthoritySession(actor);
  const [live] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
  if (!live || live.adminType !== 1 || live.relationId !== 0 || live.status !== 1 || live.isDel !== 0
    || !Number.isInteger(live.level) || live.level < 0 || live.level > 9) {
    throw new AuthException('管理员已禁用或身份已变化', ApiErrorCode.ERR_BANNED);
  }
  const encoder = new TextEncoder();
  if (!timingSafeEqual(encoder.encode(md5(live.pwd)), encoder.encode(actor.authVersion))) {
    throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
  }
  const roleIds = parseAdminAuthorityRoleIds(live.roles);
  await validateRoleRulesBeforeResolution(tx, roleIds);
  const permissions = new AdminPermissionService(createContainerFromDb(tx));
  const assignment = await permissions.resolveRoleAssignment(live.roles, true);
  const keys = live.level === 0 ? await permissions.resolveAdminPermissionKeys(live) : assignment.keys;
  if (live.level !== 0 && (assignment.missingRoleIds.length || !hasAdminPermission(keys, requiredCapability))) {
    throw new AuthException('管理员权限已变化', ApiErrorCode.ERR_AUTH);
  }
  assertAdminAuthoritySession(actor);
  return { id: live.id, level: live.level, roles: live.roles, roleIds, divisionId: live.divisionId,
    keys, legacyRuleIds: assignment.legacyRuleIds };
}

export async function withAdminAuthorityWriteTx<T>(container: Container, actor: AdminAuthorityActor,
  requiredCapability: string, callback: (tx: DbClient, live: AdminAuthorityLiveActor) => Promise<T>): Promise<T> {
  assertAdminAuthoritySession(actor);
  try {
    return await withTx(container, async tx => {
      await acquireAdminAuthorityWriteBarrier(tx);
      const live = await loadAdminAuthorityLiveActor(tx, actor, requiredCapability);
      const result = await callback(tx, live);
      assertAdminAuthoritySession(actor);
      return result;
    });
  } catch (error) { return adminAuthorityWriteError(error); }
}

export async function assertAdminAuthorityRoleAssignment(tx: DbClient, live: AdminAuthorityLiveActor,
  roles: string, requireEveryRole = true): Promise<void> {
  const ids = parseAdminAuthorityRoleIds(roles);
  await validateRoleRulesBeforeResolution(tx, ids);
  const assignment = await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(roles, true);
  if (requireEveryRole && assignment.missingRoleIds.length) {
    throw new ValidateException(`角色不存在或已停用: ${assignment.missingRoleIds.join(',')}`);
  }
  if (live.level !== 0) {
    if (assignment.legacyRuleIds.length) throw new ValidateException('包含旧版数字菜单规则的角色只能由超级管理员委派');
    assertDelegablePermissions(live.keys, assignment.keys);
  }
}

export async function assertAdminAuthorityRoleRules(tx: DbClient, live: AdminAuthorityLiveActor, rules: string): Promise<void> {
  boundedRuleSource(rules);
  if (live.level === 0) return;
  if (rules.split(',').some(rule => /^\d+$/.test(rule.trim()))) {
    throw new ValidateException('旧版数字菜单规则只能由超级管理员迁移');
  }
  const requested = await new AdminPermissionService(createContainerFromDb(tx)).resolveRulePermissionKeys(rules);
  assertDelegablePermissions(live.keys, requested);
}

export async function assertRemainingActivePlatformSuperAdmin(tx: DbClient, excludingIds: number | readonly number[]): Promise<void> {
  const ids = typeof excludingIds === 'number' ? [excludingIds] : [...excludingIds];
  if (!ids.length || ids.some(id => !integerId(id))) throw new ValidateException('管理员 ID 参数错误');
  const [remaining] = await tx.select({ id: systemAdmin.id }).from(systemAdmin).where(and(
    eq(systemAdmin.adminType, 1), eq(systemAdmin.relationId, 0), eq(systemAdmin.isDel, 0),
    eq(systemAdmin.status, 1), eq(systemAdmin.level, 0), notInArray(systemAdmin.id, ids))).limit(1);
  if (!remaining) throw conflict('必须保留至少一个启用的平台超级管理员');
}

export interface AdminRoleMutationImpact {
  current: AdminAuthorityRoleRow;
  next: { rules: string; status: number };
  authorityChanged: boolean;
  references: Array<Pick<typeof systemAdmin.$inferSelect, 'id' | 'roles' | 'level' | 'status' | 'isDel' | 'adminType' | 'relationId'>>;
  revision: string;
}
/** Root consumers attach impact confirmation here while the same barrier is
 * held. The revision covers all references, including disabled/deleted users,
 * so future reactivation cannot silently acquire a newly changed role. */
export type AdminRoleMutationPolicy = (tx: DbClient, live: AdminAuthorityLiveActor, impact: AdminRoleMutationImpact) => Promise<void>;
export async function inspectAdminRoleMutationImpact(tx: DbClient, current: AdminAuthorityRoleRow,
  next: { rules: string; status: number }): Promise<AdminRoleMutationImpact> {
  const references = await tx.select({ id: systemAdmin.id, roles: systemAdmin.roles, level: systemAdmin.level,
    status: systemAdmin.status, isDel: systemAdmin.isDel, adminType: systemAdmin.adminType, relationId: systemAdmin.relationId })
    .from(systemAdmin).where(sql`${systemAdmin.roles} ~ ${`(^|,)\\s*${current.id}\\s*(,|$)`}`)
    .orderBy(asc(systemAdmin.id)).limit(MAX_ADMIN_AUTHORITY_ROLE_REFERENCES + 1);
  if (references.length > MAX_ADMIN_AUTHORITY_ROLE_REFERENCES) throw new ServiceUnavailableException('角色引用超过1000，请先整理管理员目录');
  for (const reference of references) parseAdminAuthorityRoleIds(reference.roles);
  const revision = createHash('sha256').update(JSON.stringify({ current, references })).digest('hex');
  return { current, next, authorityChanged: !sameAdminAuthorityRuleSemantics(current.rules, next.rules)
    || current.status !== next.status, references, revision };
}
export const requireAdminRoleImpactConfirmation: AdminRoleMutationPolicy = async (_tx, _live, impact) => {
  if (impact.authorityChanged && impact.references.length) throw conflict('角色已被管理员引用，修改权限或状态需要先确认影响范围');
};

function record(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidateException('请求数据格式错误');
  return body as Record<string, unknown>;
}
function optionalId(row: Record<string, unknown>): number {
  if (row.id === undefined || row.id === 0) return 0;
  if (!integerId(row.id)) throw new ValidateException('ID错误');
  return row.id;
}
function optionalText(value: unknown, name: string, maximum: number, trim = false): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new ValidateException(`${name}参数错误`);
  const result = trim ? value.trim() : value;
  if ([...result].length > maximum) throw new ValidateException(`${name}最多 ${maximum} 个字符`);
  return result;
}
function optionalLevel(value: unknown, kind: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 9) throw new ValidateException(`${kind}等级必须为 0 到 9 的整数`);
  return value;
}
function optionalStatus(value: unknown, kind: string): 0 | 1 | undefined {
  if (value === undefined) return undefined;
  if (value !== 0 && value !== 1) throw new ValidateException(`${kind}状态参数错误`);
  return value;
}
function sameValues(actual: object | undefined, expected: object): boolean {
  if (!actual) return false;
  const values = actual as Record<string, unknown>;
  return Object.entries(expected).every(([key, value]) => values[key] === value);
}
async function verifyAdminReadBack(tx: DbClient, saved: typeof systemAdmin.$inferSelect | undefined,
  expected: object): Promise<void> {
  if (!saved || !sameValues(saved, expected)) throw conflict('管理员保存结果不一致');
  const [readBack] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, saved.id)).limit(1);
  if (!sameValues(readBack, saved)) throw conflict('管理员保存回读不一致');
}
async function verifyRoleReadBack(tx: DbClient, saved: AdminAuthorityRoleRow | undefined,
  expected: object, deleting = false): Promise<void> {
  const action = deleting ? '删除' : '保存';
  if (!saved || !sameValues(saved, expected)) throw conflict(`角色${action}结果不一致`);
  const [readBack] = await tx.select().from(systemRole).where(eq(systemRole.id, saved.id)).limit(1);
  if (!sameValues(readBack, saved)) throw conflict(`角色${action}回读不一致`);
}

export class AdminAuthorityWriteService {
  constructor(private readonly container: Container,
    private readonly roleMutationPolicy: AdminRoleMutationPolicy = requireAdminRoleImpactConfirmation) {}

  async saveAdmin(body: unknown, actor: AdminAuthorityActor): Promise<{ id: number; created: boolean }> {
    const row = record(body), id = optionalId(row);
    const account = optionalText(row.account, '账号', 32, true);
    const realName = optionalText(row.real_name, '管理员姓名', 16);
    const phone = optionalText(row.phone, '手机号', 32);
    const password = optionalText(row.pwd, '管理员密码', 256);
    const level = optionalLevel(row.level, '管理员'), status = optionalStatus(row.status, '管理员');
    const roles = row.roles === undefined ? undefined : parseAdminAuthorityRoleIds(row.roles as string).join(',');
    if (id && password && password.length < 12) throw new ValidateException('管理员密码至少 12 位');
    if (!id && !account) throw new ValidateException('账号不能为空');
    if (!id && (!password || password.length < 12)) throw new ValidateException('新管理员密码至少 12 位');
    // Hashing is deliberately outside the bounded transaction; the live
    // password version is revalidated after hashing and acquiring the barrier.
    const pwd = password ? await bcrypt.hash(password, 12) : undefined;
    return withAdminAuthorityWriteTx(this.container, actor, 'system.manage', async (tx, live) => {
      const [target] = id ? await tx.select().from(systemAdmin).where(and(eq(systemAdmin.id, id),
        eq(systemAdmin.adminType, 1), eq(systemAdmin.relationId, 0), eq(systemAdmin.isDel, 0), inArray(systemAdmin.status, [0, 1]))).limit(1) : [];
      if (id && !target) throw new ValidateException('管理员不存在');
      if (live.level !== 0 && (target?.level === 0 || level === 0)) {
        throw new ValidateException(id ? '只有超级管理员可以管理超级管理员账号' : '只有超级管理员可以创建超级管理员账号');
      }
      if (target?.id === live.id) {
        const sameRoles = roles === undefined || [...parseAdminAuthorityRoleIds(roles)].sort((a,b) => a-b).join(',')
          === [...live.roleIds].sort((a,b) => a-b).join(',');
        if (level !== undefined && level !== target.level || status !== undefined && status !== target.status || !sameRoles) {
          throw conflict('不能修改本人账号的权限、状态或等级');
        }
      } else if (target && live.level !== 0) await assertAdminAuthorityRoleAssignment(tx, live, target.roles, false);
      if (roles !== undefined && target?.id !== live.id) await assertAdminAuthorityRoleAssignment(tx, live, roles);
      if (!target) await assertAdminAuthorityRoleAssignment(tx, live, roles ?? '');
      if (target && target.level === 0 && target.status === 1 && (level !== undefined && level !== 0 || status === 0)) {
        await assertRemainingActivePlatformSuperAdmin(tx, target.id);
      }
      if (target) {
        const fields = { ...(realName !== undefined ? { realName } : {}), ...(phone !== undefined ? { phone } : {}),
          ...(roles !== undefined ? { roles } : {}), ...(level !== undefined ? { level } : {}),
          ...(status !== undefined ? { status } : {}), ...(pwd ? { pwd } : {}) };
        if (!Object.keys(fields).length) return { id, created: false };
        const [saved] = await tx.update(systemAdmin).set(fields).where(and(eq(systemAdmin.id, id),
          eq(systemAdmin.adminType, 1), eq(systemAdmin.relationId, 0), eq(systemAdmin.isDel, 0))).returning();
        await verifyAdminReadBack(tx, saved, { ...target, ...fields });
        return { id, created: false };
      }
      const fields = { account: account!, pwd: pwd!, realName: realName ?? '',
        phone: phone ?? '', roles: roles ?? '', level: level ?? 1, status: status ?? 1, adminType: 1, relationId: 0,
        headPic: '', lastIp: '', lastTime: Math.floor(Date.now()/1000), addTime: 0, loginCount: 0, isWay: 0, divisionId: 0, isDel: 0 };
      const [saved] = await tx.insert(systemAdmin).values(fields).returning();
      if (!saved || !integerId(saved.id)) throw conflict('管理员保存结果不一致');
      await verifyAdminReadBack(tx, saved, { ...fields, id: saved.id });
      return { id: saved.id, created: true };
    });
  }

  async saveRole(body: unknown, actor: AdminAuthorityActor): Promise<{ id: number; created: boolean }> {
    const row = record(body), id = optionalId(row);
    const roleName = optionalText(row.role_name, '角色名称', 32, true);
    if (roleName !== undefined && !roleName) throw new ValidateException('角色名称不能为空');
    const rules = row.rules === undefined ? undefined : normalizeAdminAuthorityRules(row.rules);
    const level = optionalLevel(row.level, '角色'), status = optionalStatus(row.status, '角色');
    return withAdminAuthorityWriteTx(this.container, actor, 'system.manage', async (tx, live) => {
      if (live.roleIds.includes(id)) throw conflict('不能修改本人正在使用的角色');
      const [target] = id ? await tx.select().from(systemRole).where(and(eq(systemRole.id, id),
        inArray(systemRole.type, [0, 1]), eq(systemRole.relationId, 0), inArray(systemRole.status, [0, 1]))).limit(1) : [];
      if (id && !target) throw new ValidateException('角色不存在');
      if (target) await assertAdminAuthorityRoleRules(tx, live, target.rules);
      if (rules !== undefined || !target) await assertAdminAuthorityRoleRules(tx, live, rules ?? '');
      if (target) {
        // The modern form echoes expanded permissionKeys. A known manage
        // rule and its explicit manage+view representation grant the same
        // authority. Absent rules preserve legacy numeric/opaque data exactly;
        // unknown or incomplete representations are never treated as equal.
        if (rules !== undefined && !sameAdminAuthorityRuleSemantics(target.rules, rules)
          || status !== undefined && status !== target.status) {
          const impact = await inspectAdminRoleMutationImpact(tx, target, { rules: rules ?? target.rules, status: status ?? target.status });
          await this.roleMutationPolicy(tx, live, impact);
        }
        const fields = { ...(roleName !== undefined ? { roleName } : {}), ...(rules !== undefined ? { rules } : {}),
          ...(level !== undefined ? { level } : {}), ...(status !== undefined ? { status } : {}) };
        if (!Object.keys(fields).length) return { id, created: false };
        const [saved] = await tx.update(systemRole).set(fields).where(and(eq(systemRole.id, id),
          inArray(systemRole.type, [0, 1]), eq(systemRole.relationId, 0), eq(systemRole.status, target.status))).returning();
        await verifyRoleReadBack(tx, saved, { ...target, ...fields });
        return { id, created: false };
      }
      const fields = { roleName: roleName ?? '新角色', rules: rules ?? '', level: level ?? 0, status: status ?? 1, type: 0, relationId: 0 };
      const [saved] = await tx.insert(systemRole).values(fields).returning();
      if (!saved || !integerId(saved.id)) throw conflict('角色保存结果不一致');
      await verifyRoleReadBack(tx, saved, { ...fields, id: saved.id });
      return { id: saved.id, created: true };
    });
  }

  async deleteRole(id: number, actor: AdminAuthorityActor): Promise<void> {
    if (!integerId(id)) throw new ValidateException('ID错误');
    await withAdminAuthorityWriteTx(this.container, actor, 'system.manage', async (tx, live) => {
      if (live.roleIds.includes(id)) throw conflict('不能删除本人正在使用的角色');
      const [target] = await tx.select().from(systemRole).where(and(eq(systemRole.id, id), inArray(systemRole.type, [0, 1]),
        eq(systemRole.relationId, 0), inArray(systemRole.status, [0, 1]))).limit(1);
      if (!target) throw new ValidateException('角色不存在');
      await assertAdminAuthorityRoleRules(tx, live, target.rules);
      const impact = await inspectAdminRoleMutationImpact(tx, target, { rules: target.rules, status: -1 });
      await this.roleMutationPolicy(tx, live, impact);
      const [saved] = await tx.update(systemRole).set({ status: -1 }).where(and(eq(systemRole.id, id),
        inArray(systemRole.type, [0, 1]), eq(systemRole.relationId, 0), eq(systemRole.status, target.status))).returning();
      await verifyRoleReadBack(tx, saved, { ...target, status: -1 }, true);
    });
  }
}
