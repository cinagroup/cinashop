import { and, eq } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProductSkuRetirementLog } from '@/models/schema';
import { assertProductRecycleSkuGuardReady } from '@/migrations/productRecycleSkuGuard';

export interface PermanentProductDeletionExpected {
  productId: number; skuId?: number; skuUnique: string; supplierId?: number; productType: number;
}
export interface PermanentProductDeletionFact { skuId: number; supplierId: number; productType: number }
type FactRow = Pick<typeof storeProductSkuRetirementLog.$inferSelect,
  'productId' | 'skuId' | 'uniqueSnapshot' | 'action' | 'dependencySnapshot'>;
export function parseSupplierPermanentDeletionFact(row: FactRow, expected: PermanentProductDeletionExpected): PermanentProductDeletionFact | null {
  const positive = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= 2147483647;
  if (!positive(expected.productId) || expected.supplierId !== undefined && !positive(expected.supplierId) || !Number.isSafeInteger(expected.productType)
    || expected.productType < 0 || expected.productType > 32767 || expected.skuId !== undefined && !positive(expected.skuId)
    || typeof expected.skuUnique !== 'string' || !expected.skuUnique || expected.skuUnique.length > 8
    || row.action !== 'permanent_delete' || row.productId !== expected.productId || !positive(row.skuId)
    || expected.skuId !== undefined && row.skuId !== expected.skuId || row.uniqueSnapshot !== expected.skuUnique
    || typeof row.dependencySnapshot !== 'string' || new TextEncoder().encode(row.dependencySnapshot).length > 1024) return null;
  let value: unknown; try { value = JSON.parse(row.dependencySnapshot); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  if (Object.keys(snapshot).length !== 5 || snapshot.version !== 1 || snapshot.kind !== 'supplier_product_permanent_delete'
    || snapshot.owner_type !== 2 || !positive(snapshot.supplier_id) || expected.supplierId !== undefined && snapshot.supplier_id !== expected.supplierId
    || snapshot.product_type !== expected.productType) return null;
  return { skuId: row.skuId, supplierId: snapshot.supplier_id, productType: expected.productType };
}
/** Caller owns the root/SKU compensation fence and has proved their absence.
 * This proves only why that absence may be deliberate; it never restores stock
 * or grants permission to treat an arbitrary missing row as deleted. */
export async function readSupplierPermanentDeletionFact(tx: DbClient, expected: PermanentProductDeletionExpected): Promise<PermanentProductDeletionFact | null> {
  await assertProductRecycleSkuGuardReady(tx);
  const rows = await tx.select().from(storeProductSkuRetirementLog).where(and(eq(storeProductSkuRetirementLog.productId, expected.productId),
    eq(storeProductSkuRetirementLog.action, 'permanent_delete'), expected.skuId === undefined
      ? eq(storeProductSkuRetirementLog.uniqueSnapshot, expected.skuUnique) : eq(storeProductSkuRetirementLog.skuId, expected.skuId))).limit(2);
  return rows.length === 1 ? parseSupplierPermanentDeletionFact(rows[0], expected) : null;
}
