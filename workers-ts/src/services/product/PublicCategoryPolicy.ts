import { sql } from 'drizzle-orm';
import { ValidateException } from '@/utils/errors';
import { storeProductCategory } from '@/models/schema';
import { and, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
/** Platform taxonomy has at most three levels. Parent visibility is authority;
 * stale CSV paths never make an orphan/foreign/hidden branch public. */
export function publicCategoryIdentitySql(alias = 'category') {
  if (!/^[a-z_][a-z_0-9]*$/.test(alias)) throw new Error('Invalid category SQL alias');
  const c = sql.raw(alias);
  return sql`${c}.id>0 AND ${c}.type=0 AND ${c}.relation_id=0 AND ${c}.is_show=1 AND (
    (${c}.level=0 AND ${c}.pid=0) OR
    (${c}.level=1 AND EXISTS(SELECT 1 FROM store_product_category AS category_parent WHERE category_parent.id=${c}.pid
      AND category_parent.id>0 AND category_parent.type=0 AND category_parent.relation_id=0 AND category_parent.is_show=1 AND category_parent.level=0 AND category_parent.pid=0)) OR
    (${c}.level=2 AND EXISTS(SELECT 1 FROM store_product_category AS category_parent JOIN store_product_category AS category_root ON category_root.id=category_parent.pid
      WHERE category_parent.id=${c}.pid AND category_parent.id>0 AND category_parent.type=0 AND category_parent.relation_id=0 AND category_parent.is_show=1 AND category_parent.level=1
      AND category_root.id>0 AND category_root.type=0 AND category_root.relation_id=0 AND category_root.is_show=1 AND category_root.level=0 AND category_root.pid=0)))`;
}
export function publicCategoryRelationSelection(id: number, mode: 'cid' | 'sid' | 'tid') {
  const scope = mode === 'tid' ? sql`category.id=${id}` : mode === 'sid'
    ? sql`(category.id=${id} OR category.pid=${id})`
    : sql`(category.id=${id} OR category.pid=${id} OR EXISTS(SELECT 1 FROM store_product_category AS ancestor WHERE ancestor.id=category.pid AND ancestor.pid=${id}))`;
  return sql`SELECT relation.product_id FROM store_product_relation AS relation JOIN store_product_category AS category ON category.id=relation.relation_id
    WHERE relation.type=1 AND ${publicCategoryIdentitySql()} AND ${scope}
      AND EXISTS(SELECT 1 FROM store_product_category AS requested WHERE requested.id=${id} AND ${publicCategoryIdentitySql('requested')})`;
}
export function categoryPublicId(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647) throw new ValidateException('分类ID须为规范正整数'); return Number(value);
}
export function publicCategoryQuery(query: URLSearchParams) {
  const result: { cid?: number; sid?: number; tid?: number; selectId?: number } = {};
  for (const key of ['cid', 'sid', 'tid', 'selectId'] as const) {
    const values = query.getAll(key); if (!values.length) continue;
    if (values.length !== 1 || !/^(?:0|[1-9]\d{0,9})$/.test(values[0]) || Number(values[0]) > 2147483647) throw new ValidateException('分类筛选须为规范非负整数');
    result[key] = Number(values[0]);
  }
  const big = query.getAll('is_big'); if (big.length && (big.length !== 1 || !/^[01]$/.test(big[0]))) throw new ValidateException('商品图片模式无效');
  return result;
}
export async function validatePublicCategoryFilters(db: DbClient, query: { cid?: number; sid?: number; tid?: number; selectId?: number }) {
  const ids = [...new Set(Object.values(query).filter((value): value is number => value !== undefined && value !== 0))];
  if (!ids.length) return;
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 2147483647)) throw new ValidateException('分类筛选无效');
  const rows = await db.select({ id: storeProductCategory.id, pid: storeProductCategory.pid, level: storeProductCategory.level }).from(storeProductCategory)
    .where(and(inArray(storeProductCategory.id, ids), publicCategoryIdentitySql('store_product_category')));
  if (rows.length !== ids.length) throw new ValidateException('分类不存在或不可公开');
  const byId = new Map(rows.map(row => [row.id, row])), sid = query.sid ? byId.get(query.sid)! : null, tid = query.tid ? byId.get(query.tid)! : null;
  if ((sid && sid.level !== 1) || (tid && tid.level !== 2) || (sid && query.cid && sid.pid !== query.cid) || (tid && sid && tid.pid !== sid.id)) throw new ValidateException('分类筛选父子关系冲突');
  if (tid && query.cid && !sid) {
    const [parent] = await db.select({ pid: storeProductCategory.pid }).from(storeProductCategory).where(inArray(storeProductCategory.id, [tid.pid])).limit(1);
    if (parent?.pid !== query.cid) throw new ValidateException('分类筛选父子关系冲突');
  }
}
