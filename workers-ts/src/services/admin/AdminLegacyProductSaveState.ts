import { asc, eq, getTableColumns, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { DbClient } from '@/lib/di';
import { storeProduct, storeProductAttr, storeProductAttrResult, storeProductAttrValue, storeProductDescription,
  storeProductVirtual, storeProductStockRecord, storeCart, storeProductRelation, storeProductCoupon,
  storeDiscountsProducts, storeSeckill, storeCombination, storeBargain, storeIntegral } from '@/models/schema';
import { HttpApiException, ServiceUnavailableException } from '@/utils/errors';

export const MAX_PRODUCT_SAVE_ROWS = 10_000;
export const productSaveConflict = (message = '商品完整数据正在变化，请刷新后重试') => new HttpApiException(message, 409, 409);
export function productSaveCanonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
export const productSaveSame = (a: unknown, b: unknown) => productSaveCanonical(a) === productSaveCanonical(b);
export function assertProductSaveSame(actual: unknown, expected: unknown, group: string): void {
  if (!productSaveSame(actual, expected)) throw productSaveConflict(`商品${group}完整回读不一致`);
}
async function bounded<T>(query: PromiseLike<T[]>): Promise<T[]> {
  const rows = await query;
  if (rows.length > MAX_PRODUCT_SAVE_ROWS) throw new ServiceUnavailableException('商品完整保存集合超过10000项容量');
  return rows;
}
export async function readProductSaveState(tx: DbClient, id: number) {
  const [skus, attrs, results, descriptions, cards, ledgers, carts, relations, coupons, discounts, seckill, combination, bargain, integral] = await Promise.all([
    bounded(tx.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, id)).orderBy(asc(storeProductAttrValue.id)).limit(MAX_PRODUCT_SAVE_ROWS + 1)),
    bounded(tx.select().from(storeProductAttr).where(eq(storeProductAttr.productId, id)).orderBy(asc(storeProductAttr.id)).limit(MAX_PRODUCT_SAVE_ROWS + 1)),
    bounded(tx.select().from(storeProductAttrResult).where(eq(storeProductAttrResult.productId, id)).orderBy(asc(storeProductAttrResult.id)).limit(MAX_PRODUCT_SAVE_ROWS + 1)),
    bounded(tx.select().from(storeProductDescription).where(eq(storeProductDescription.productId, id)).orderBy(asc(storeProductDescription.type)).limit(MAX_PRODUCT_SAVE_ROWS + 1)),
    bounded(tx.select().from(storeProductVirtual).where(eq(storeProductVirtual.productId, id)).orderBy(asc(storeProductVirtual.id)).limit(MAX_PRODUCT_SAVE_ROWS + 1)),
    bounded(tx.select().from(storeProductStockRecord).where(eq(storeProductStockRecord.productId, id)).orderBy(asc(storeProductStockRecord.id)).limit(MAX_PRODUCT_SAVE_ROWS + 1)),
    bounded(tx.select().from(storeCart).where(eq(storeCart.productId, id)).orderBy(asc(storeCart.id)).limit(MAX_PRODUCT_SAVE_ROWS + 1)),
    bounded(tx.select().from(storeProductRelation).where(eq(storeProductRelation.productId, id)).orderBy(asc(storeProductRelation.id)).limit(MAX_PRODUCT_SAVE_ROWS + 1)),
    bounded(tx.select().from(storeProductCoupon).where(eq(storeProductCoupon.productId, id)).orderBy(asc(storeProductCoupon.id)).limit(MAX_PRODUCT_SAVE_ROWS + 1)),
    bounded(tx.select().from(storeDiscountsProducts).where(eq(storeDiscountsProducts.productId, id)).orderBy(asc(storeDiscountsProducts.id)).limit(MAX_PRODUCT_SAVE_ROWS + 1)),
    bounded(tx.select().from(storeSeckill).where(eq(storeSeckill.productId, id)).orderBy(asc(storeSeckill.id)).limit(MAX_PRODUCT_SAVE_ROWS + 1)),
    bounded(tx.select().from(storeCombination).where(eq(storeCombination.productId, id)).orderBy(asc(storeCombination.id)).limit(MAX_PRODUCT_SAVE_ROWS + 1)),
    bounded(tx.select().from(storeBargain).where(eq(storeBargain.productId, id)).orderBy(asc(storeBargain.id)).limit(MAX_PRODUCT_SAVE_ROWS + 1)),
    bounded(tx.select().from(storeIntegral).where(eq(storeIntegral.productId, id)).orderBy(asc(storeIntegral.id)).limit(MAX_PRODUCT_SAVE_ROWS + 1)),
  ]);
  return { skus, attrs, results, descriptions, cards, ledgers, carts, relations, coupons, discounts, seckill, combination, bargain, integral };
}
export type ProductSaveState = Awaited<ReturnType<typeof readProductSaveState>>;
export function emptyProductSaveState(): ProductSaveState {
  return { skus: [], attrs: [], results: [], descriptions: [], cards: [], ledgers: [], carts: [],
    relations: [], coupons: [], discounts: [], seckill: [], combination: [], bargain: [], integral: [] };
}

/** Derive every declared default from the repository schema, never from a
 * possibly trigger-modified INSERT receipt. Generated IDs are checked apart.
 * A new non-scalar default requires an explicit reviewed expected value. */
export function productSaveDefaults(table: PgTable): Record<string, unknown> {
  return Object.fromEntries(Object.entries(getTableColumns(table)).filter(([key]) => key !== 'id').map(([key, column]) => {
    const value: unknown = column.default;
    if (value !== undefined && (value === null || ['string', 'number', 'boolean'].includes(typeof value))) return [key, value];
    if (value === undefined && !column.notNull) return [key, null];
    throw Error(`Product save expected default requires review: ${key}`);
  }));
}
export function assertProductSaveGeneratedRows(actual: Array<{ id: number }>, expected: Record<string, unknown>[], watermark: number, group: string): void {
  if (actual.some(row => !Number.isSafeInteger(row.id) || row.id <= watermark || row.id > 2_147_483_647)
    || new Set(actual.map(row => row.id)).size !== actual.length) throw productSaveConflict(`商品${group}生成身份不一致`);
  const withoutId = actual.map(({ id: _id, ...row }) => productSaveCanonical(row)).sort();
  assertProductSaveSame(withoutId, expected.map(productSaveCanonical).sort(), group);
}
export async function productSaveWatermarks(tx: DbClient): Promise<Record<string, number>> {
  const tables = { skus: storeProductAttrValue, attrs: storeProductAttr, results: storeProductAttrResult,
    cards: storeProductVirtual, ledgers: storeProductStockRecord, relations: storeProductRelation, coupons: storeProductCoupon };
  const result: Record<string, number> = {};
  for (const [key, table] of Object.entries(tables)) {
    const [row] = await tx.select({ maximum: sql<number>`COALESCE(max(${table.id}),0)::int` }).from(table);
    result[key] = Number(row.maximum);
  }
  return result;
}
export async function lockProductSaveTables(tx: DbClient): Promise<void> {
  // Real barriers close direct-SQL and absent-row phantoms. Acquire only after
  // the bargain admission fence and all TRY advisory locks, never wait here.
  await tx.execute(sql`LOCK TABLE ONLY ${storeProduct}, ONLY ${storeProductAttrValue}, ONLY ${storeCart}, ONLY ${storeProductRelation},
    ONLY ${storeProductAttr}, ONLY ${storeProductAttrResult}, ONLY ${storeProductDescription}, ONLY ${storeProductVirtual},
    ONLY ${storeProductStockRecord}, ONLY ${storeProductCoupon}, ONLY ${storeDiscountsProducts}, ONLY ${storeSeckill},
    ONLY ${storeCombination}, ONLY ${storeBargain}, ONLY ${storeIntegral} IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
}
export async function lockProductSaveRows(tx: DbClient, id: number): Promise<void> {
  await tx.select({ id: storeProduct.id }).from(storeProduct).where(eq(storeProduct.id, id)).for('update', { noWait: true });
  for (const table of [storeProductAttrValue, storeProductAttr, storeProductAttrResult, storeProductDescription,
    storeProductVirtual, storeProductStockRecord, storeCart, storeProductRelation, storeProductCoupon, storeDiscountsProducts,
    storeSeckill, storeCombination, storeBargain, storeIntegral])
    await tx.execute(sql`SELECT 1 FROM ${table} WHERE ${table.productId}=${id} FOR UPDATE NOWAIT`);
}
