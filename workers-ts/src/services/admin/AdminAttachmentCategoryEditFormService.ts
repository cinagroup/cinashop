import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import { systemAttachmentCategory } from '@/models/schema';
import { HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import {
  MAX_ADMIN_CATEGORY_FORM_ROOT_OPTIONS,
  assertAdminCategoryFormActor,
  authorizeAdminCategoryFormRead,
  type AdminAttachmentCategoryCreateFormActor,
} from './AdminAttachmentCategoryCreateFormService';

export interface AdminAttachmentCategoryEditForm {
  title: '编辑分类'; method: 'PUT'; action: `file/category/${number}`;
  rules: [
    { type: 'hidden'; field: 'file_type'; value: 1 | 2 },
    { type: 'select'; field: 'pid'; title: '上级分类'; value: number; props: { filterable: true }; options: Array<{ value: number; label: string }> },
    { type: 'input'; field: 'name'; title: '分类名称'; value: string; props: { maxlength: 20 } },
  ];
}

export function parseAdminCategoryEditFormQuery(idValue: string, query: URLSearchParams) {
  if (typeof idValue !== 'string' || !/^[1-9]\d*$/.test(idValue) || idValue.length > 10 || Number(idValue) > 2147483647) {
    throw new ValidateException('分类ID必须为有效整数');
  }
  for (const key of query.keys()) {
    if (key !== 'file_type' || query.getAll(key).length !== 1) throw new ValidateException('分类表单查询参数错误');
  }
  const rawType = query.get('file_type');
  if (rawType !== null && rawType !== '1' && rawType !== '2') throw new ValidateException('文件类型只能为 1 或 2');
  return { id: Number(idValue), fileType: rawType === null ? undefined : Number(rawType) as 1 | 2 };
}

/** A root-only selector must represent the saved parent exactly. Historical
 * deep or orphaned relationships fail explicitly rather than being reset to 0. */
export class AdminAttachmentCategoryEditFormService {
  constructor(private readonly container: Container) {}

  async editForm(idValue: string, query: URLSearchParams, actor: AdminAttachmentCategoryCreateFormActor): Promise<AdminAttachmentCategoryEditForm> {
    const { id, fileType: requestedType } = parseAdminCategoryEditFormQuery(idValue, query);
    assertAdminCategoryFormActor(actor);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
      await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
      await authorizeAdminCategoryFormRead(tx, actor);
      const [target] = await tx.select({ id: systemAttachmentCategory.id, pid: systemAttachmentCategory.pid,
        name: systemAttachmentCategory.name, fileType: systemAttachmentCategory.fileType })
        .from(systemAttachmentCategory).where(and(eq(systemAttachmentCategory.id, id),
          eq(systemAttachmentCategory.type, 1), eq(systemAttachmentCategory.relationId, 0))).limit(1);
      if (!target) throw new NotFoundException('附件分类不存在');
      if (target.fileType !== 1 && target.fileType !== 2) throw new HttpApiException('附件分类文件类型无效，请先整理分类目录', 409, 409);
      if (requestedType !== undefined && requestedType !== target.fileType) throw new ValidateException('文件类型与附件分类不一致');
      const roots = await tx.select({ id: systemAttachmentCategory.id, name: systemAttachmentCategory.name })
        .from(systemAttachmentCategory).where(and(eq(systemAttachmentCategory.type, 1),
          eq(systemAttachmentCategory.relationId, 0), eq(systemAttachmentCategory.fileType, target.fileType),
          eq(systemAttachmentCategory.pid, 0), ne(systemAttachmentCategory.id, id)))
        .orderBy(asc(systemAttachmentCategory.id)).limit(MAX_ADMIN_CATEGORY_FORM_ROOT_OPTIONS + 1);
      if (roots.length > MAX_ADMIN_CATEGORY_FORM_ROOT_OPTIONS) throw new ServiceUnavailableException('上级分类选项超过10000，请先整理分类目录');
      if (target.pid !== 0 && !roots.some(row => row.id === target.pid)) {
        throw new HttpApiException('当前上级分类不属于可选择的根分类，请先整理分类层级', 409, 409);
      }
      assertAdminCategoryFormActor(actor);
      return {
        title: '编辑分类', method: 'PUT', action: `file/category/${id}`,
        rules: [
          { type: 'hidden', field: 'file_type', value: target.fileType },
          { type: 'select', field: 'pid', title: '上级分类', value: target.pid, props: { filterable: true },
            options: [{ value: 0, label: '所有分类' }, ...roots.map(row => ({ value: row.id, label: row.name }))] },
          { type: 'input', field: 'name', title: '分类名称', value: target.name, props: { maxlength: 20 } },
        ],
      };
    });
  }
}
