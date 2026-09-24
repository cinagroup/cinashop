import { eq, sql } from "drizzle-orm";
import { withTx, type Container, type DbClient } from "@/lib/di";
import { storeProduct } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

// A source product can back several bargain activities. Admission readers and
// product retirement writers share this boundary without holding a product row
// lock across a participant wait. Checkout owns activity/cart rows before it
// updates the product row, so FOR SHARE here could create a lock cycle.
// This covers the two Worker is_del retirement paths; it does not serialize
// visibility/review edits or replace checkout's final product-row guard.
const BARGAIN_SOURCE_PRODUCT_LIFECYCLE_NAMESPACE = 731_634;

function assertProductId(productId: number): void {
  if (!Number.isSafeInteger(productId) || productId <= 0 || productId > 2_147_483_647) {
    throw new ValidateException("商品ID错误");
  }
}

export async function boundBargainSourceProductRetirement(tx: DbClient): Promise<void> {
  await tx.execute(sql.raw(`SELECT
    pg_catalog.set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms',true),
    pg_catalog.set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    pg_catalog.set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
}

export async function lockBargainSourceProductAdmission(tx: DbClient, productId: number): Promise<void> {
  assertProductId(productId);
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${BARGAIN_SOURCE_PRODUCT_LIFECYCLE_NAMESPACE}, ${productId})`);
}

export async function lockBargainSourceProductRetirement(tx: DbClient, productId: number): Promise<void> {
  assertProductId(productId);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${BARGAIN_SOURCE_PRODUCT_LIFECYCLE_NAMESPACE}, ${productId})`);
}

/** Preserve the legacy platform soft-delete response while serializing with
 * bargain starts and help on every activity backed by this product.
 */
export async function retirePlatformSourceProduct(container: Container, productId: number): Promise<void> {
  assertProductId(productId);
  await withTx(container, async tx => {
    await boundBargainSourceProductRetirement(tx);
    await lockBargainSourceProductRetirement(tx, productId);
    await tx.update(storeProduct).set({ isDel: 1 }).where(eq(storeProduct.id, productId));
  });
}
