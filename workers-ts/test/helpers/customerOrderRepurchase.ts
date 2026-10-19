import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '@/lib/di';
import type { Env } from '@/env';
import { storeCart, storeOrder, storeOrderCartInfo, storeProduct, user } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './refundRuntimeFixture';
import { refundEvidenceR2, refundEvidenceSequences, refundEvidenceSnapshot } from './refundApplicationEvidence';

/** Actual registered checkout; optional paid/allocation plus received state are
 * explicitly synthetic admission. Reorder and reads use owned maintenance SQL,
 * never production grants or a claim of payment/provider acceptance. */
export async function customerOrderRepurchaseFixture(state: 'received' | 'unpaid' = 'received') {
  const f = await refundRuntimeFixture();
  try {
    await f.db.update(storeProduct).set({ isVerify: 1 }).where(eq(storeProduct.id, 71));
    const source = state === 'received'
      ? await f.withRuntime(writer => writer.createPaid({ key: 'repurchase-source', orderId: 'repurchase_source' }))
      : await f.withRuntime(async writer => {
        const created = await writer.checkout({ key: 'repurchase-source', orderId: 'repurchase_source' });
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
