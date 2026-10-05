import { and, eq, sql } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { storeProductCategory } from '@/models/schema';
import { themeDeadlines, themeHash } from '@/services/content/ThemeReadService';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { integralDetailText } from '@/services/activity/IntegralProductDetailData';
import { ValidateException } from '@/utils/errors';
import { publicCategoryIdentitySql } from './PublicCategoryPolicy';
export interface PublicCategoryNode { id: number; pid: number; cate_name: string; pic: string; big_pic: string; children: PublicCategoryNode[] }
export const PUBLIC_CATEGORY_LIMIT = 3000;
export class StoreCategoryService {
  constructor(private readonly container: Container, private readonly env: Env) {}
  private async snapshot() {
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await themeDeadlines(tx);
      const rows = await tx.select({ id: storeProductCategory.id, pid: storeProductCategory.pid, level: storeProductCategory.level,
        cateName: storeProductCategory.cateName, pic: storeProductCategory.pic, bigPic: storeProductCategory.bigPic,
        sort: storeProductCategory.sort, isShow: storeProductCategory.isShow, path: storeProductCategory.path, xmin: sql<string>`xmin::text` })
        .from(storeProductCategory).where(and(eq(storeProductCategory.type, 0), eq(storeProductCategory.relationId, 0)))
        .orderBy(sql`${storeProductCategory.sort} DESC`, sql`${storeProductCategory.id} DESC`).limit(PUBLIC_CATEGORY_LIMIT + 1);
      if (rows.length > PUBLIC_CATEGORY_LIMIT) throw new ValidateException('平台分类超过完整读取容量');
      const visible = await tx.select({ id: storeProductCategory.id }).from(storeProductCategory).where(publicCategoryIdentitySql('store_product_category')).limit(PUBLIC_CATEGORY_LIMIT + 1);
      const ids = new Set(visible.map(row => row.id)), safe = rows.filter(row => ids.has(row.id) && integralDetailText(row.cateName, 100));
      const accepted = new Map<number, typeof safe[number]>();
      for (let level = 0; level < 3; level++) for (const row of safe) if (row.level === level && (level === 0 || accepted.has(row.pid))) accepted.set(row.id, row);
      const published = rows.filter(row => accepted.has(row.id));
      const references = await publicProductPictures(tx, published.flatMap(row => [{ image: row.pic, type: 0, relationId: 0 }, { image: row.bigPic, type: 0, relationId: 0 }]));
      return { rows: published, references, revision: await themeHash(rows) };
    });
  }
  async getCategory(): Promise<PublicCategoryNode[]> {
    const snapshot = await this.snapshot(), pictures = await renderProductPictures(this.env?.APP_KEY, snapshot.references);
    const map = new Map<number, PublicCategoryNode>(), roots: PublicCategoryNode[] = [];
    snapshot.rows.forEach((row, index) => map.set(row.id, { id: row.id, pid: row.pid, cate_name: row.cateName, pic: pictures[index * 2], big_pic: pictures[index * 2 + 1], children: [] }));
    for (const row of snapshot.rows) { const node = map.get(row.id)!; if (row.pid) map.get(row.pid)!.children.push(node); else roots.push(node); }
    return roots;
  }
  async getLevelCategory(id: number) {
    const roots = await this.getCategory(), queue = [...roots];
    while (queue.length) { const found = queue.shift()!; if (found.id === id) return found.pid === 0 ? roots : findChildren(roots, found.pid); queue.push(...found.children); }
    return [];
  }
  /** Compatibility invalidation only; public reads no longer consume or fill
   * the old unscoped Redis tree cache. */
  async invalidate() { const { cacheDelete } = await import('@/utils/cache'); await cacheDelete('category_all_tree', this.env); }
  async getVersion() { return (await this.snapshot()).revision; }
}
function findChildren(rows: PublicCategoryNode[], id: number): PublicCategoryNode[] {
  for (const row of rows) { if (row.id === id) return row.children; const children = findChildren(row.children, id); if (children.length) return children; } return [];
}
