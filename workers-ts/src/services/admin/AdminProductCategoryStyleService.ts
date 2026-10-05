import { and, eq, sql } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import { systemDise, systemLog } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { lockDiseCatalogForMutation, themeDeadlines, themeHash } from '@/services/content/ThemeReadService';
import { decodeProductCategoryStyle, productCategoryStyleCatalog, ProductCategoryStyleReadService,
  PRODUCT_CATEGORY_TEMPLATE_NAME, projectProductCategoryStyle } from '@/services/content/ProductCategoryStyleReadService';
import { categoryStyleInput, categoryStyleOperationId, ProductCategoryStyleRejected, ProductCategoryStyleStaleVersion } from './AdminProductCategoryStyleInput';
import type { ProductCategoryStyleReceipt } from '../../../../view/common/productCategoryStyle';
export const PRODUCT_CATEGORY_STYLE_LOCK_NAMESPACE = 731_721;
const JOURNAL_TYPE = 'product_category_style', receiptPath = (id: string) => `/config/product-category-style/receipt/${id}`;
function parseReceipt(value: string, operationId: string): ProductCategoryStyleReceipt | null {
  const match = /^update;id=([1-9]\d{0,9});payload=([a-f0-9]{64})$/.exec(value);
  return match && Number(match[1]) <= 2147483647 ? { operation: 'update', id: Number(match[1]), operationId, payloadHash: match[2] } : null;
}
function actorId(actor: { id: number }) { if (!actor || !Number.isSafeInteger(actor.id) || actor.id <= 0 || actor.id > 2147483647) throw new ValidateException('管理员身份无效'); return actor.id; }
export class AdminProductCategoryStyleService {
  constructor(private readonly container: Container) {}
  read() { return new ProductCategoryStyleReadService(this.container).read(); }
  receipt(value: unknown, actor: { id: number }) {
    const operationId = categoryStyleOperationId(value), id = actorId(actor);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await themeDeadlines(tx);
      const rows = await tx.select({ action: systemLog.action }).from(systemLog)
        .where(and(eq(systemLog.type, JOURNAL_TYPE), eq(systemLog.path, receiptPath(operationId)), eq(systemLog.adminId, id))).limit(2);
      if (!rows.length) throw new NotFoundException('分类样式回执不存在');
      const receipt = rows.length === 1 ? parseReceipt(rows[0].action, operationId) : null;
      if (!receipt) throw new ValidateException('分类样式回执异常，结果未知'); return receipt;
    });
  }
  save(input: unknown, actor: { id: number }) {
    const id = actorId(actor), { operationId, canonical } = categoryStyleInput(input);
    return themeHash(canonical).then(payloadHash => withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`); await themeDeadlines(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRODUCT_CATEGORY_STYLE_LOCK_NAMESPACE},0)`);
      const journals = await tx.select({ action: systemLog.action, actor: systemLog.adminId }).from(systemLog)
        .where(and(eq(systemLog.type, JOURNAL_TYPE), eq(systemLog.path, receiptPath(operationId)))).limit(2);
      if (journals.length) {
        const receipt = journals.length === 1 ? parseReceipt(journals[0].action, operationId) : null;
        if (!receipt || journals[0].actor !== id || receipt.payloadHash !== payloadHash) throw new ValidateException('操作标识已用于其他分类样式请求'); return receipt;
      }
      await lockDiseCatalogForMutation(tx);
      const catalog = await productCategoryStyleCatalog(tx);
      if (catalog.revision !== canonical.revision) throw new ProductCategoryStyleStaleVersion(operationId, payloadHash);
      if (!projectProductCategoryStyle(catalog).editable) throw new ProductCategoryStyleRejected(operationId, payloadHash);
      const now = Math.floor(Date.now() / 1000), version = crypto.randomUUID(), row = catalog.rows[0]; let resultId: number;
      if (row) {
        resultId = row.id; const saved = decodeProductCategoryStyle(row.value)!;
        await tx.update(systemDise).set({ value: JSON.stringify({ ...saved, level: canonical.level, index: canonical.index }), version,
          updateTime: sql<number>`GREATEST(${systemDise.updateTime}+1,${now})` }).where(eq(systemDise.id, row.id));
      } else {
        const [created] = await tx.insert(systemDise).values({ templateName: PRODUCT_CATEGORY_TEMPLATE_NAME, type: 3, name: '商品分类', title: '商品分类可视化',
          value: JSON.stringify({ level: canonical.level, index: canonical.index }), status: 0, isShow: 0, isDel: 0, isDiy: 1, version, addTime: now, updateTime: now }).returning({ id: systemDise.id }); resultId = created.id;
      }
      await tx.insert(systemLog).values({ adminId: id, type: JOURNAL_TYPE, path: receiptPath(operationId), page: JOURNAL_TYPE, method: 'POST',
        action: `update;id=${resultId};payload=${payloadHash}`, addTime: now });
      return { operation: 'update' as const, id: resultId, operationId, payloadHash };
    }));
  }
}
