import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { systemAttachment, systemAttachmentCategory } from '@/models/schema';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { publicHotwordAuthorImages, renderHotwordAuthorImages } from '@/services/product/HotwordAuthorAssetPolicy';
import { NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { assertAdminAuthoritySession, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { authorizeAdminLegacyProductRead, assertAdminLegacyProductReadDeadline } from './AdminLegacyProductReadAuthority';

const IMAGE_CAPACITY = 5000;

function parameters(query: URLSearchParams, allowed: readonly string[]) {
  for (const [key] of query) {
    if (!allowed.includes(key) || query.getAll(key).length !== 1) throw new ValidateException('公众号配置支持查询字段无效或重复');
  }
}
function integer(raw: string | null, fallback: number, min: number, max: number) {
  if (raw === null) return fallback;
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) throw new ValidateException('公众号配置图库分页或分类无效');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ValidateException('公众号配置图库分页或分类超出范围');
  return value;
}
export interface WechatBaseAttachmentOption { att_id: number; pid: number; real_name: string; reference: string; preview: string }
/** Dedicated wechat_base.manage image selection reads. No attachment management,
 * provider/R2 access, KV cache population or configuration mutations. */
export class AdminWechatBaseSupportService {
  constructor(private readonly container: Container, private readonly env: Pick<Env, 'APP_KEY'>) {}

  private read<T>(actor: AdminAuthorityActor, work: (tx: DbClient) => Promise<T>): Promise<T> {
    assertAdminAuthoritySession(actor);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
      await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
      await authorizeAdminLegacyProductRead(tx, actor, 'wechat_base.manage');
      const result = await work(tx);
      await assertAdminLegacyProductReadDeadline(tx, actor);
      return result;
    });
  }

  async categories(query: URLSearchParams, actor: AdminAuthorityActor) {
    parameters(query, []);
    return this.read(actor, async tx => {
      const rows = await tx.select({ id: systemAttachmentCategory.id, pid: systemAttachmentCategory.pid, name: systemAttachmentCategory.name })
        .from(systemAttachmentCategory).where(and(eq(systemAttachmentCategory.type, 1), eq(systemAttachmentCategory.relationId, 0), eq(systemAttachmentCategory.fileType, 1)))
        .orderBy(asc(systemAttachmentCategory.id)).limit(IMAGE_CAPACITY + 1);
      if (rows.length > IMAGE_CAPACITY) throw new ServiceUnavailableException('公众号配置图库分类超过5000项，不能截断');
      return { list: rows };
    });
  }

  async options(query: URLSearchParams, actor: AdminAuthorityActor) {
    parameters(query, ['page', 'limit', 'pid', 'name']);
    const page = integer(query.get('page'), 1, 1, 5000), limit = integer(query.get('limit'), 20, 1, 100), pid = integer(query.get('pid'), 0, 0, 2_147_483_647);
    const name = query.get('name') ?? '';
    if ([...name].length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) throw new ValidateException('公众号配置图库名称查询无效');
    const snapshot = await this.read(actor, async tx => {
      if (pid > 0) {
        const [category] = await tx.select({ id: systemAttachmentCategory.id }).from(systemAttachmentCategory)
          .where(and(eq(systemAttachmentCategory.id, pid), eq(systemAttachmentCategory.type, 1), eq(systemAttachmentCategory.relationId, 0), eq(systemAttachmentCategory.fileType, 1))).limit(1);
        if (!category) throw new NotFoundException('平台图片分类不存在');
      }
      const rows = await tx.select().from(systemAttachment).where(and(eq(systemAttachment.type, 1), eq(systemAttachment.relationId, 0),
        eq(systemAttachment.moduleType, 1), eq(systemAttachment.fileType, 1), eq(systemAttachment.pid, pid)))
        .orderBy(desc(systemAttachment.attId)).limit(IMAGE_CAPACITY + 1);
      if (rows.length > IMAGE_CAPACITY) throw new ServiceUnavailableException('当前图片分类超过5000项，请先整理，不能截断目录');
      const references = await publicHotwordAuthorImages(tx, rows.map(row => row.attDir));
      const eligible = rows.flatMap((row, index) => references[index]
        && parseCanonicalAttachmentId(references[index]!) !== null && references[index]! === `/api/assets/${row.attId}`
        && row.realName.includes(name)
        ? [{ att_id: row.attId, pid: row.pid, real_name: row.realName, reference: references[index]! }] : []);
      return { list: eligible.slice((page - 1) * limit, page * limit), count: eligible.length };
    });
    const previews = await renderHotwordAuthorImages(this.env.APP_KEY, snapshot.list.map(row => row.reference));
    assertAdminAuthoritySession(actor);
    return { list: snapshot.list.map((row, index): WechatBaseAttachmentOption => ({ ...row, preview: previews[index]! })), count: snapshot.count, page, limit };
  }

}
