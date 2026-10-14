import { desc, eq, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { systemAdmin, systemLog, userGroup } from '@/models/schema';
import { ApiErrorCode, AuthException, NotFoundException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { UserSegmentationService } from '@/services/user/UserSegmentationService';
import { AdminPermissionService, hasAdminPermission } from './AdminPermissionService';
import { assertAdminAuthoritySession, parseAdminAuthorityRoleIds, withAdminAuthorityWriteTx,
  type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { loadAdminLegacyRoleReferenceHistory } from './AdminLegacyRoleDeletionProof';

export function userGroupId(value: unknown, allowZero = false): number {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || !/^(?:0|[1-9]\d*)$/.test(String(value))) throw new ValidateException('用户分组ID格式错误');
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < (allowZero ? 0 : 1) || id > 2147483647) {
    throw new ValidateException('用户分组ID超出范围');
  }
  return id;
}

function queryValues(query: URLSearchParams, allowed: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of query) {
    if (!allowed.includes(key) || Object.hasOwn(result, key)) throw new ValidateException('用户分组查询参数错误或重复');
    result[key] = value;
  }
  return result;
}

function input(value: unknown, legacy: boolean) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('用户分组正文必须是对象');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !['id', 'group_name'].includes(key))) throw new ValidateException('用户分组正文包含未知字段');
  const id = body.id === undefined ? 0 : userGroupId(body.id, true);
  const name = typeof body.group_name === 'string' ? body.group_name.trim() : '';
  const max = legacy ? 20 : 64;
  if (!name || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(name)) throw new ValidateException('请输入有效分组名称');
  if ([...name].length > max) throw new ValidateException(`分组名称不能超过${max}个字符`);
  return { id, group_name: name };
}

/** Exact legacy group URLs and the existing Admin editor share one authority and lifecycle. */
export class AdminUserGroupService {
  constructor(private readonly container: Container) {}

  private async read<T>(actor: AdminAuthorityActor, work: (tx: DbClient) => Promise<T>): Promise<T> {
    assertAdminAuthoritySession(actor);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
      const [live] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
      if (!live || live.adminType !== 1 || live.relationId !== 0 || live.status !== 1 || live.isDel !== 0
        || !Number.isInteger(live.level) || live.level < 0 || live.level > 9) {
        throw new AuthException('管理员身份已变化', ApiErrorCode.ERR_BANNED);
      }
      const encoder = new TextEncoder();
      if (!timingSafeEqual(encoder.encode(md5(live.pwd)), encoder.encode(actor.authVersion))) {
        throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
      }
      const roles = parseAdminAuthorityRoleIds(live.roles);
      await loadAdminLegacyRoleReferenceHistory(tx, roles, live.level);
      const { keys } = await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(live.roles);
      if (live.level !== 0 && !hasAdminPermission(keys, 'user.view')) throw new AuthException('用户查看权限已变化', ApiErrorCode.ERR_AUTH);
      assertAdminAuthoritySession(actor);
      const result = await work(tx);
      assertAdminAuthoritySession(actor);
      return result;
    });
  }

  async list(query: URLSearchParams, actor: AdminAuthorityActor, legacy = true) {
    const filter = queryValues(query, legacy ? ['page', 'limit'] : ['page', 'limit', 'group_name', 'name']);
    const page = filter.page === undefined ? 1 : userGroupId(filter.page);
    const limit = filter.limit === undefined ? 20 : userGroupId(filter.limit);
    if (limit > 100 || (page - 1) * limit > 2147483647) throw new ValidateException('用户分组分页超出范围');
    return this.read(actor, async tx => {
      if (!legacy) return new UserSegmentationService(createContainerFromDb(tx)).groupList(filter);
      const [count] = await tx.select({ count: sql<number>`count(*)::integer` }).from(userGroup);
      const list = await tx.select({ id: userGroup.id, group_name: userGroup.groupName }).from(userGroup)
        .orderBy(desc(userGroup.id)).limit(limit).offset((page - 1) * limit);
      return { list, count: count?.count ?? 0 };
    });
  }

  async form(idValue: unknown, query: URLSearchParams, actor: AdminAuthorityActor) {
    const id = userGroupId(idValue, true), filter = queryValues(query, ['id']);
    if (filter.id !== undefined && userGroupId(filter.id, true) !== id) throw new ValidateException('用户分组查询ID必须与路径一致');
    return this.read(actor, async tx => {
      const [row] = id ? await tx.select().from(userGroup).where(eq(userGroup.id, id)).limit(1) : [];
      if (id && !row) throw new NotFoundException('用户分组不存在');
      return { title: id ? '修改分组' : '添加分组', action: 'user/user_group/save', method: 'POST',
        rules: [...(id ? [{ type: 'hidden', field: 'id', value: id }] : []),
          { type: 'input', field: 'group_name', title: '分组名称', value: row?.groupName ?? '',
            props: { maxlength: 20 }, validate: [{ required: true }] }] };
    });
  }

  private async audit(tx: DbClient, actor: AdminAuthorityActor, operation: string, id: number) {
    const action = JSON.stringify({ operation, id });
    const [row] = await tx.insert(systemLog).values({ adminId: actor.id, type: 'user_group_catalog',
      path: `user/user_group/${operation}`, page: '用户分组管理', method: operation === 'delete' ? 'DELETE' : 'POST',
      action, addTime: Math.floor(Date.now() / 1000) }).returning();
    if (!row || row.adminId !== actor.id || row.action !== action || row.type !== 'user_group_catalog') {
      throw new Error('用户分组审计回执不完整');
    }
  }

  async save(value: unknown, actor: AdminAuthorityActor, legacy = true) {
    const body = input(value, legacy);
    return withAdminAuthorityWriteTx(this.container, actor, 'user.manage', async tx => {
      const result = await new UserSegmentationService(createContainerFromDb(tx)).saveGroup(body);
      await this.audit(tx, actor, body.id ? 'update' : 'create', result.id);
      return result;
    });
  }

  async remove(idValue: unknown, query: URLSearchParams, actor: AdminAuthorityActor, legacy = true) {
    const id = userGroupId(idValue), filter = queryValues(query, ['id']);
    if (filter.id !== undefined && userGroupId(filter.id) !== id) throw new ValidateException('用户分组查询ID必须与路径一致');
    return withAdminAuthorityWriteTx(this.container, actor, 'user.manage', async tx => {
      // All group CRUD shares the existing segmentation namespace; row locks also protect assignments.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(731621, 0)`);
      const [existing] = await tx.select().from(userGroup).where(eq(userGroup.id, id)).limit(1).for('update');
      if (!existing && legacy) return '删除成功!';
      if (!existing) throw new NotFoundException('用户分组不存在');
      await new UserSegmentationService(createContainerFromDb(tx)).deleteGroup(id);
      await this.audit(tx, actor, 'delete', id);
      return legacy ? '删除成功!' : null;
    });
  }
}
