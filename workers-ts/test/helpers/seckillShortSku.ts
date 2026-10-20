/** Small owned PG column fixtures for the first seckill short-base-key reds.
 * Admin mounts the actual controller/auth middleware with real AdminJWT;
 * public selection uses the existing explicitly synthetic-principal Hono app.
 * Neither fixture claims full createApp, registered-schema or LOGIN authority. */
import { eq, sql } from 'drizzle-orm';
import { storeProduct, storeProductAttrValue } from '@/models/schema';
import { seckillActivityFixture, seckillActivityInput } from './seckillActivityFixture';
import { createPcSeckillFixture } from './pcSeckillFixture';
import { refundEvidenceSequences, refundEvidenceSnapshot } from './refundApplicationEvidence';

export const seckillShortUnique = 'short7';

export async function seckillShortAdminFixture() {
  const f = await seckillActivityFixture();
  try {
    await f.db.update(storeProduct).set({ price: '17.00' }).where(eq(storeProduct.id, 101));
    await f.db.update(storeProductAttrValue).set({ unique: seckillShortUnique, price: '18.88' })
      .where(eq(storeProductAttrValue.id, 11));
    return { ...f,
      rawIdentity: async () => (await f.db.execute(sql`SELECT "unique" AS raw_unique,
        pg_typeof("unique")::text AS storage_type,octet_length("unique") AS bytes
        FROM public.store_product_attr_value WHERE id=11`))[0],
      publicSnapshot: () => refundEvidenceSnapshot(f.db),
      publicSequences: () => refundEvidenceSequences(f.db),
    };
  } catch (error) { await f.close(); throw error; }
}

export function seckillShortAdminInput() {
  return seckillActivityInput({ products: [{ child_id: null, product_id: 101, status: 1,
    skus: [{ id: null, base_unique: seckillShortUnique, price: '6.25', quota_total: 5, enabled: true }] }] });
}

/** Explicit independent bootstrap: the activity is seeded by the old fixture,
 * not presented as an activity successfully produced by the Admin save path. */
export async function seckillShortPublicFixture() {
  const f = await createPcSeckillFixture();
  try {
    await f.db.update(storeProduct).set({ price: '17.00' }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ unique: seckillShortUnique, price: '18.88' })
      .where(eq(storeProductAttrValue.id, 1));
    return { ...f,
      rawIdentity: async () => (await f.db.execute(sql`SELECT "unique" AS raw_unique,
        pg_typeof("unique")::text AS storage_type,octet_length("unique") AS bytes
        FROM public.store_product_attr_value WHERE id=1`))[0],
      publicSnapshot: () => refundEvidenceSnapshot(f.db),
      publicSequences: () => refundEvidenceSequences(f.db),
    };
  } catch (error) { await f.close(); throw error; }
}
