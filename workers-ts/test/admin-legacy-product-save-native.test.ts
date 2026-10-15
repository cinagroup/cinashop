import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeCart, storeProduct, storeProductAttrValue, storeProductDescription, systemLog, storeOrderOutbox } from '@/models/schema';
import { AdminLegacyProductSaveService } from '@/services/admin/AdminLegacyProductSaveService';
import { legacySaveActor, legacySaveBody, legacySaveFixture, legacySaveSku } from './helpers/adminLegacyProductSave';
import { pauseModerationExecute } from './helpers/adminProductModeration';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const service = (db: DbClient) => new AdminLegacyProductSaveService(createContainerFromDb(db));
type Cart = typeof storeCart.$inferSelect;

/** PG16-only: genuine SQL results and separate registered fixture connections.
 * The pause observes an already-executed barrier; it never replaces a result. */
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('PG16 complete product save real DML admission and absent-cart barriers', () => {
  let f: Awaited<ReturnType<typeof legacySaveFixture>>;
  beforeAll(async () => { f = await legacySaveFixture(); }, 30000);
  beforeEach(async () => {
    await f.seed();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native product save forbids provider I/O'));
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  afterAll(async () => { await f?.close(); });

  async function seededProduct() {
    const saved = await f.service.save(0, legacySaveBody({ is_show: 1 }), legacySaveActor());
    const [sku] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, saved.id));
    const [cart] = await f.db.insert(storeCart).values({ id: 41, productId: saved.id, productAttrUnique: sku.unique,
      uid: 7, cartNum: 2, status: 1, type: 3, activityId: 456, isPay: 1, isDel: 1 }).returning();
    return { id: saved.id, sku, cart };
  }

  it('refuses independently held cart and category DML through real NOWAIT barriers without any business, audit or intent change', async () => {
    const product = await seededProduct(), before = await f.snapshot();
    await withFinancePeers(f.db, async ([writer, blocker]) => {
      expect(writer.pid).not.toBe(blocker.pid);
      for (const hold of [
        { table: 'store_cart', statement: 'UPDATE store_cart SET cart_num=cart_num WHERE id=41' },
        { table: 'store_product_category', statement: 'UPDATE store_product_category SET sort=sort WHERE id=1' },
      ]) {
        const ready = signal(), release = signal();
        const held = outcome(blocker.db.transaction(async tx => {
          await tx.execute(sql.raw(hold.statement));
          ready.resolve(); await release.promise;
        }));
        try {
          await Promise.race([ready.promise, held.then(result => {
            if (!result.ok) throw result.error;
            throw Error('Independent DML holder exited before admission');
          })]);
          expect(await f.exec(`SELECT mode,granted FROM pg_locks WHERE pid=${blocker.pid} AND relation='public.${hold.table}'::regclass`))
            .toEqual(expect.arrayContaining([expect.objectContaining({ mode: 'RowExclusiveLock', granted: true })]));
          const saved = await outcome(service(writer.db).save(product.id,
            legacySaveBody({ store_name: '不得部分保存', is_show: 0, attrs: [legacySaveSku({ stock: 9 })] }), legacySaveActor()));
          expect(saved.ok).toBe(false);
          if (saved.ok) throw Error('Complete save bypassed the independent SQL writer');
          expect(saved.error).toMatchObject({ code: 409, httpStatus: 409 });
          expect(await f.snapshot()).toEqual(before);
        } finally { release.resolve(); await held; }
        const completed = await held;
        if (!completed.ok) throw completed.error;
      }
    });
    expect(await f.snapshot()).toEqual(before);
  }, 60000);

  it('blocks an absent target-cart insert behind the executed save barrier, then commits the full save and the later row without lost data', async () => {
    const product = await seededProduct(), before = await f.snapshot();
    await withFinancePeers(f.db, async ([writer, peer]) => {
      expect(writer.pid).not.toBe(peer.pid);
      const ready = signal(), release = signal();
      const hooked = pauseModerationExecute(writer.db,
        /LOCK TABLE ONLY[\s\S]*store_cart[\s\S]*SHARE ROW EXCLUSIVE MODE NOWAIT/i,
        async () => { ready.resolve(); await release.promise; });
      const pending = outcome(service(hooked).save(product.id,
        legacySaveBody({ store_name: '真实屏障内保存', is_show: 0, description: '<p>并发保存后的完整描述</p>',
          attrs: [legacySaveSku({ unique: product.sku.unique, stock: 9 })] }), legacySaveActor()));
      let inserted: ReturnType<typeof outcome<Cart[]>> | undefined;
      try {
        await Promise.race([ready.promise, pending.then(result => {
          if (!result.ok) throw result.error;
          throw Error('Complete save did not pause after its physical cart barrier');
        })]);
        expect(await f.exec(`SELECT mode,granted FROM pg_locks WHERE pid=${writer.pid} AND relation='public.store_cart'::regclass`))
          .toEqual(expect.arrayContaining([expect.objectContaining({ mode: 'ShareRowExclusiveLock', granted: true })]));
        expect(await f.db.select().from(storeCart).where(eq(storeCart.id, 990))).toEqual([]);
        inserted = outcome(peer.db.transaction(tx => tx.insert(storeCart).values({ id: 990, productId: product.id,
          productAttrUnique: product.sku.unique, uid: 88, cartNum: 3, status: 1 }).returning()));
        await waitForFinanceBlock(f.db, peer.pid, writer.pid);
        expect(await f.db.select().from(storeCart).where(eq(storeCart.id, 990))).toEqual([]);
      } finally {
        release.resolve();
        // Drain both outcomes even when a lock assertion fails, before peers close.
        await pending;
        if (inserted) await inserted;
      }
      const saved = await pending;
      expect(saved.ok).toBe(true); if (!saved.ok) throw saved.error;
      expect(saved.value).toMatchObject({ id: product.id, committed: true });
      if (!inserted) throw Error('Independent absent-row insert was not attempted');
      const added = await inserted;
      expect(added.ok).toBe(true); if (!added.ok) throw added.error;
      expect(added.value).toHaveLength(1);
      expect(await f.db.select().from(storeCart).where(eq(storeCart.id, 990))).toEqual(added.value);
      // Rows inserted after the save commit are later work, not part of its cart invalidation.
      expect(added.value[0]).toMatchObject({ id: 990, uid: 88, cartNum: 3, status: 1, productId: product.id });
      expect(await f.db.select().from(storeCart).where(eq(storeCart.id, product.cart.id))).toEqual([{ ...product.cart, status: 0 }]);
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, product.id)))[0])
        .toMatchObject({ storeName: '真实屏障内保存', isShow: 0, stock: 9 });
      expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, product.sku.id)))[0])
        .toMatchObject({ unique: product.sku.unique, stock: 9, sumStock: 9 });
      expect(await f.db.select().from(storeProductDescription).where(eq(storeProductDescription.productId, product.id)))
        .toEqual([{ productId: product.id, type: 0, description: '<p>并发保存后的完整描述</p>' }]);
      const audits = await f.db.select().from(systemLog), events = await f.db.select().from(storeOrderOutbox);
      expect(audits).toHaveLength(2); expect(events).toHaveLength(2);
      expect(events.find(row => row.id === saved.value.outboxId))
        .toMatchObject({ eventType: 'product.save.effects', aggregateId: product.id, status: 'PENDING' });
    });
    const after = await f.snapshot();
    const touched = new Set(['store_product', 'store_product_attr', 'store_product_attr_result', 'store_product_attr_value',
      'store_product_description', 'store_product_relation', 'store_product_stock_record', 'store_cart', 'system_log', 'store_order_outbox']);
    for (const table of Object.keys(before)) if (!touched.has(table)) expect(after[table]).toEqual(before[table]);
  }, 60000);
});
