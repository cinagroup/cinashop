import { and, asc, eq, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { systemAdmin, systemAttachmentCategory } from '@/models/schema';
import { ApiErrorCode, AuthException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { AdminPermissionService } from './AdminPermissionService';

export const MAX_ADMIN_CATEGORY_FORM_ROOT_OPTIONS = 10_000;
export interface AdminAttachmentCategoryCreateFormActor { id: number; authVersion: string; expiresAt: number }
export interface AdminAttachmentCategoryCreateForm {
  title: '添加分类'; method: 'POST'; action: 'file/category';
  rules: [
    { type: 'hidden'; field: 'file_type'; value: 1 | 2 },
    { type: 'select'; field: 'pid'; title: '上级分类'; value: number; props: { filterable: true }; options: Array<{ value: number; label: string }> },
    { type: 'input'; field: 'name'; title: '分类名称'; value: ''; props: { maxlength: 20 } },
  ];
}

function parentId(value: string | null): number {
  if (value === null || value === '' || value === '0') return 0;
  if (!/^[1-9]\d*$/.test(value) || value.length > 10 || Number(value) > 2147483647) throw new ValidateException('上级分类ID必须为有效整数');
  return Number(value);
}

export function parseAdminCategoryCreateFormQuery(query: URLSearchParams, pathParentId?: string) {
  for (const key of query.keys()) {
    if (!['id', 'file_type'].includes(key) || query.getAll(key).length !== 1) throw new ValidateException('分类表单查询参数错误');
  }
  const selected = parentId(query.get('id'));
  const pathSelected = pathParentId === undefined ? undefined : parentId(pathParentId);
  if (pathSelected !== undefined && query.has('id') && selected !== pathSelected) throw new ValidateException('上级分类参数冲突');
  const rawType = query.get('file_type') ?? '1';
  if (rawType !== '1' && rawType !== '2') throw new ValidateException('文件类型只能为 1 或 2');
  const fileType: 1 | 2 = rawType === '1' ? 1 : 2;
  return { pid: pathSelected ?? selected, fileType };
}

function assertActor(actor: AdminAttachmentCategoryCreateFormActor) {
  if (!Number.isSafeInteger(actor.id) || actor.id <= 0 || actor.id > 2147483647
    || typeof actor.authVersion !== 'string' || !/^[a-f0-9]{32}$/.test(actor.authVersion)
    || !Number.isSafeInteger(actor.expiresAt) || actor.expiresAt <= 0) throw new AuthException('请重新登录', ApiErrorCode.ERR_LOGIN);
  if (actor.expiresAt <= Math.floor(Date.now() / 1000)) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
}

async function authorizeRead(tx: DbClient, actor: AdminAttachmentCategoryCreateFormActor) {
  const [live] = await tx.select({ pwd: systemAdmin.pwd, adminType: systemAdmin.adminType, status: systemAdmin.status,
    isDel: systemAdmin.isDel, level: systemAdmin.level, roles: systemAdmin.roles })
    .from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
  if (!live || live.adminType !== 1 || live.status !== 1 || live.isDel !== 0
    || !Number.isInteger(live.level) || live.level < 0 || live.level > 9) throw new AuthException('管理员已禁用或身份已变化', ApiErrorCode.ERR_BANNED);
  const encoder = new TextEncoder();
  if (!timingSafeEqual(encoder.encode(md5(live.pwd)), encoder.encode(actor.authVersion))) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
  if (live.level !== 0) {
    const { keys } = await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(live.roles);
    if (!keys.has('attachment.view')) throw new AuthException('素材查看权限已变化', ApiErrorCode.ERR_AUTH);
  }
  assertActor(actor);
}

/** The PHP create-form DTO is independent of modern category writes: the form
 * limits the old input to 20 characters without changing POST's 50-char limit. */
export class AdminAttachmentCategoryCreateFormService {
  constructor(private readonly container: Container) {}

  async createForm(query: URLSearchParams, actor: AdminAttachmentCategoryCreateFormActor, pathParentId?: string): Promise<AdminAttachmentCategoryCreateForm> {
    const { pid, fileType } = parseAdminCategoryCreateFormQuery(query, pathParentId);
    assertActor(actor);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
      await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
      await authorizeRead(tx, actor);
      const roots = await tx.select({ id: systemAttachmentCategory.id, name: systemAttachmentCategory.name })
        .from(systemAttachmentCategory).where(and(eq(systemAttachmentCategory.type, 1),
          eq(systemAttachmentCategory.relationId, 0), eq(systemAttachmentCategory.fileType, fileType), eq(systemAttachmentCategory.pid, 0)))
        .orderBy(asc(systemAttachmentCategory.id)).limit(MAX_ADMIN_CATEGORY_FORM_ROOT_OPTIONS + 1);
      if (roots.length > MAX_ADMIN_CATEGORY_FORM_ROOT_OPTIONS) throw new ServiceUnavailableException('上级分类选项超过10000，请先整理分类目录');
      if (pid !== 0 && !roots.some(row => row.id === pid)) throw new NotFoundException('上级附件分类不存在');
      assertActor(actor);
      return {
        title: '添加分类', method: 'POST', action: 'file/category',
        rules: [
          { type: 'hidden', field: 'file_type', value: fileType },
          { type: 'select', field: 'pid', title: '上级分类', value: pid, props: { filterable: true },
            options: [{ value: 0, label: '所有分类' }, ...roots.map(row => ({ value: row.id, label: row.name }))] },
          { type: 'input', field: 'name', title: '分类名称', value: '', props: { maxlength: 20 } },
        ],
      };
    });
  }
}
