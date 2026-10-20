/** Owned full PG16 and actual App/JWT scenario. Catalogue/cart edits below are
 * explicit fixture admission, never historical receipt rewrites or providers. */
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '@/lib/di';
import type { Env } from '@/env';
import { storeCart, storeProduct, storeProductAttrValue, user } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './refundRuntimeFixture';
import { refundEvidenceR2, refundEvidenceSequences, refundEvidenceSnapshot } from './refundApplicationEvidence';

export const presaleShortUnique = 'short7';
export async function presaleShortSkuFixture(options: { unique?: string; presale?: boolean } = {}) {
  const f = await refundRuntimeFixture();
  try {
    const unique = options.unique ?? presaleShortUnique;
    if (!unique || unique.length > 8 || /[\s\x00-\x1f\x7f]/.test(unique))
      throw Error('Owned presale fixture requires a canonical base SKU');
    const stamp = Math.floor(Date.now() / 1000), presale = options.presale !== false;
    await f.db.update(storeProduct).set({ price: '17.00', isVip: 0, isVipProduct: 0,
      isPresaleProduct: presale ? 1 : 0, presaleStartTime: stamp - 3600,
      presaleEndTime: stamp + 3600, presaleDay: 7, isLimit: 0 })
      .where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ unique, price: '18.88' })
      .where(eq(storeProductAttrValue.id, 1));
    await f.db.update(storeCart).set({ productAttrUnique: unique, type: presale ? 6 : 0 })
      .where(eq(storeCart.id, 1));
    // The quote fixture inserts explicit cart ids 1/2. New public cart authors
    // must start after those owned rows rather than collide with sequence 1.
    await f.db.execute(sql`SELECT setval(pg_get_serial_sequence('store_cart','id'),
      (SELECT max(id) FROM store_cart),true)`);
    const password = 'owned-presale-short-account', key = 'owned-presale-short-app-key';
    await f.db.update(user).set({ pwd: password }).where(eq(user.uid, 11));
    const r2 = refundEvidenceR2();
    const env: Env = { ...f.env, APP_KEY: key, NODE_ENV: 'test' as Env['NODE_ENV'], ASSETS_BUCKET: r2.bucket };
    const token = (await createToken(11, 'api', md5(password), key)).token;
    return { ...f, ...r2, env, token, unique, container: createContainerFromDb(f.db),
      snapshot: () => refundEvidenceSnapshot(f.db), sequences: () => refundEvidenceSequences(f.db) };
  } catch (error) { await f.close(); throw error; }
}
