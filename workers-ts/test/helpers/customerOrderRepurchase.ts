import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '@/lib/di';
import type { Env } from '@/env';
import { storeCart, storeOrder, storeOrderCartInfo, storeProduct, storeProductAttrValue, user } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './refundRuntimeFixture';
import { refundEvidenceR2, refundEvidenceSequences, refundEvidenceSnapshot } from './refundApplicationEvidence';
import { StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';

/** Actual registered checkout; optional paid/allocation plus received state are
 * explicitly synthetic admission. Reorder and reads use owned maintenance SQL,
 * never production grants or a claim of payment/provider acceptance. */
export interface CustomerOrderRepurchaseOptions {
  /** Set the selected catalogue/cart identity before actual immutable capture. */
  skuUnique?: string;
  sourceIdentity?: { key: string; orderId: string };
  /** Capture both protected receipts through the actual checkout author. */
  requirePurchaseOrigin?: true;
}
export async function customerOrderRepurchaseFixture(state: 'received' | 'unpaid' = 'received',
  options: CustomerOrderRepurchaseOptions = {}) {
  const f = await refundRuntimeFixture();
  try {
    await f.db.update(storeProduct).set({ isVerify: 1 }).where(eq(storeProduct.id, 71));
    if (options.skuUnique !== undefined) {
      if (!options.skuUnique || options.skuUnique.length > 8 || /[\s\x00-\x1f\x7f]/.test(options.skuUnique))
        throw Error('Owned repurchase source requires a canonical SKU key');
      await f.db.update(storeProductAttrValue).set({ unique: options.skuUnique }).where(eq(storeProductAttrValue.id, 1));
      await f.db.update(storeCart).set({ productAttrUnique: options.skuUnique }).where(eq(storeCart.id, 1));
    }
    const sourceIdentity = options.sourceIdentity ?? { key: 'repurchase-source', orderId: 'repurchase_source' };
    const source = await f.withRuntime(async writer => {
      if (options.requirePurchaseOrigin) await StoreOrderCreateService.createWithRuntime(writer.container,
        { CONFIG_KV: f.env.CONFIG_KV, requirePurchaseOrigin: true, nextOrderId: async () => sourceIdentity.orderId },
        { uid: 11, key: sourceIdentity.key, cartIds: [1, 2], addressId: 11, userIp: '127.0.0.1', useIntegral: true });
      // The mature writer replays the same source key. Received admission keeps
      // its existing explicitly synthetic payment/allocation after capture.
      if (state === 'received') return writer.createPaid(sourceIdentity);
      const created = await writer.checkout(sourceIdentity);
      const [row] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId)); return row;
    });
    if (state === 'received') await f.db.update(storeOrder).set({ status: 2 }).where(eq(storeOrder.id, source.id));
    const [current] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, source.id));
    const carts = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, source.id)).orderBy(storeOrderCartInfo.id);
    if (carts.length !== 2 || carts[0].cartNum !== 2 || carts[1].cartNum !== 1 || carts.some(row => row.type !== 2)) {
      throw Error('Actual repurchase source must retain its Supplier-origin ordinary 2+1 lines');
    }
    const password = 'owned-repurchase-account', key = 'owned-repurchase-app-key';
    await f.db.update(user).set({ pwd: password }).where(eq(user.uid, 11));
    await f.db.update(user).set({ pwd: password }).where(eq(user.uid, 22));
    await f.db.execute(sql`SELECT setval(pg_get_serial_sequence('store_cart','id'),(SELECT max(id) FROM store_cart),true)`);
    const r2 = refundEvidenceR2();
    const env: Env = { ...f.env, APP_KEY: key, NODE_ENV: 'test' as Env['NODE_ENV'], ASSETS_BUCKET: r2.bucket };
    const tokens = { buyer: (await createToken(11, 'api', md5(password), key)).token,
      foreignBuyer: (await createToken(22, 'api', md5(password), key)).token };
    const container = createContainerFromDb(f.db);
    const withBuyer = <T>(work: (peer: { db: typeof f.db; container: typeof container; sqlBoundary: 'maintenance' }) => Promise<T>) =>
      work({ db: f.db, container, sqlBoundary: 'maintenance' });
    return { ...f, ...r2, env, tokens, container, withBuyer, source: current, carts, selected: carts[0], unselected: carts[1],
      ids: { sourceOrder: current.id, publicOrderId: current.orderId, buyer: 11 },
      snapshot: () => refundEvidenceSnapshot(f.db), sequences: () => refundEvidenceSequences(f.db),
      prepared: (ids: number[]) => f.db.select().from(storeCart).where(sql`${storeCart.id} = ANY(${`{${ids.join(',')}}`}::integer[])`).orderBy(storeCart.id),
    };
  } catch (error) { await f.close(); throw error; }
}
