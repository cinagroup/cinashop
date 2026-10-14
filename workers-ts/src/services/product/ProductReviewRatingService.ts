import { eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct, storeProductReply } from '@/models/schema';
import { ServiceUnavailableException } from '@/utils/errors';
import { lockProductWrite } from './ProductAssociationService';

export type ReviewProductRow = typeof storeProduct.$inferSelect;

function sameProduct(actual: ReviewProductRow | undefined, expected: ReviewProductRow): boolean {
  return !!actual && Object.keys(actual).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => actual[key as keyof ReviewProductRow] === value);
}

/** Order/cart locks precede this operation for real order reviews. Acquire all
 * products in ascending order before inserting any review, even for an order
 * whose cart order runs backwards. Missing current products do not invalidate
 * the immutable order/cart evidence used by historical customer reviews. */
export async function lockReviewProducts(tx: DbClient, ids: readonly number[]): Promise<Map<number, ReviewProductRow>> {
  const products = new Map<number, ReviewProductRow>();
  const sorted = [...new Set(ids.filter(id => Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647))].sort((a, b) => a - b);
  for (const id of sorted) {
    await lockProductWrite(tx, id);
    const [product] = await tx.select().from(storeProduct).where(eq(storeProduct.id, id)).limit(1).for('update');
    if (product) products.set(id, product);
  }
  return products;
}

export async function verifyReviewProductSnapshot(tx: DbClient, expected: ReviewProductRow): Promise<void> {
  const [fresh] = await tx.select().from(storeProduct).where(eq(storeProduct.id, expected.id)).limit(1);
  if (!sameProduct(fresh, expected)) throw new Error('评价商品完整评分回执核验失败');
}

/** PHP product.reply -> computedProductStar: all nondeleted product_score
 * values, including UID0/hidden/other-owner reviews, truncated to one decimal.
 * Creation producers execute the effect before commit. PHP deletion does not
 * emit that event, so deletion deliberately does not invoke this function. */
export async function refreshProductReviewStar(tx: DbClient, before: ReviewProductRow): Promise<ReviewProductRow> {
  await verifyReviewProductSnapshot(tx, before);
  const rows = await tx.execute(sql`SELECT COUNT(*)::text AS count,
    TRUNC(SUM(${storeProductReply.productScore})::numeric / NULLIF(COUNT(*), 0), 1)::text AS star
    FROM ${storeProductReply}
    WHERE ${storeProductReply.productId} = ${before.id} AND ${storeProductReply.isDel} = 0`) as unknown as Array<{ count: string; star: string | null }>;
  if (rows.length !== 1 || !/^\d+$/.test(rows[0].count)) throw new Error('评价商品评分聚合回执不完整');
  if (BigInt(rows[0].count) === 0n) return before;
  const star = rows[0].star;
  if (star === null || !/^[0-5]\.\d$/.test(star) || Number(star) > 5) {
    throw new ServiceUnavailableException('历史商品评价分数异常，请核对数据');
  }
  const expected = { ...before, star };
  const changed = await tx.update(storeProduct).set({ star }).where(eq(storeProduct.id, before.id)).returning();
  if (changed.length !== 1 || !sameProduct(changed[0], expected)) throw new Error('评价商品完整评分更新回执不一致');
  await verifyReviewProductSnapshot(tx, expected);
  return expected;
}
