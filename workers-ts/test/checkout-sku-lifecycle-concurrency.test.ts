import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { adminProductUpdate, adminProductSkuRetire, adminProductSkuRestore } from '../src/controllers/api/v1/AdminCrudController';
import { retireProductSkus, restoreProductSkus } from '../src/controllers/supplier/SupplierController';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { waitForFinanceBlock } from './helpers/financePeers';
import { storeProduct, storeProductAttrValue, storeCart, storeProductSkuRetirementLog, systemLog,
  storeProductAttr, storeProductAttrResult } from '../src/models/schema';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('full-ORM SKU lifecycle and multi-product concurrency', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let owned: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  const input = { cartIds: [1, 2], addressId: 11, couponId: 0, type: 0 };
  const editBody = { spec_type: 0, items: [{ value: '规格', detail: ['默认'] }],
    attrs: [{ suk: '默认', unique: 'qasecond', price: 10, stock: 8 }] };
  const lifecycleBody = { product_id: 70, sku_ids: [1], reason: 'isolated lifecycle test' };
  const app = (db: DbClient) => {
    const result = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    result.use('*', async (c, next) => {
      c.set('container', createContainerFromDb(db)); c.set('uid', 11); c.set('adminId', 1);
      // Actual handlers and SQL; synthetic authentication/Sequence/KV only.
      c.set('adminInfo', { id: 1, account: 'isolated', realName: 'isolated', level: 0, roles: '', divisionId: 0 });
      c.set('supplierId', 51); c.set('supplierAdminId', 1);
      c.set('supplierAdminInfo', { id: 1, account: 'isolated', realName: 'isolated', level: 0, roles: '', isPrimary: true });
      await next();
    });
    result.onError((e, c) => c.json({ status: 400, msg: e.message, data: null }));
    result.post('/api/order/create/:key', orderCreate);
    result.post('/admin/product/edit/:id', adminProductUpdate);
    result.post('/admin/product/sku/retire', adminProductSkuRetire);
    result.post('/admin/product/sku/restore', adminProductSkuRestore);
    result.post('/supplier/product/sku/retire', retireProductSkus);
    result.post('/supplier/product/sku/restore', restoreProductSkus);
    return result;
  };
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([], async () => {
      owned = await sequenceRunnerDatabase();
      try {
        const api = await import('drizzle-kit/api'), schema = await import('../src/models/schema');
        await owned.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(schema))).join('\n'));
        return owned;
      } catch (e) { await owned.close(); throw e; }
    });
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.db.insert(storeProduct).values({ id: 71, storeName: 'second product', price: '10.00', stock: 8,
      isShow: 1, isVerify: 1, freight: 3, tempId: 10 });
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 71, type: 0, unique: 'qasecond', suk: '默认', price: '10.00', stock: 8 });
    await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 71, productAttrUnique: 'qasecond', cartNum: 1, isNew: 1, status: 1 });
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'isolated', get: () => ({ fetch: async () => new Response('lifecycle_multi_order') }) } });
  }, 120_000);
  afterEach(async () => { await f?.close(); }, 120_000);
  const request = async (application: ReturnType<typeof app>, path: string, body: object) => {
    const r = await application.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': '11' }, body: JSON.stringify(body) }, f.env);
    return r.json() as Promise<{ status: number; msg: string; data: { orderKey: string; quoteToken: string; changed: number } }>;
  };
  const confirm = async () => { const r = await request(f.app, '/api/order/confirm', input); expect(r.status, r.msg).toBe(200); return r.data; };
  const buy = (db: DbClient, receipt: Awaited<ReturnType<typeof confirm>>) => request(app(db), `/api/order/create/${receipt.orderKey}`, { ...input, quoteToken: receipt.quoteToken });
  const peers = async (run: (peers: [SequenceRunnerPeer, SequenceRunnerPeer, SequenceRunnerPeer, SequenceRunnerPeer]) => Promise<void>) => {
    const connect = owned.withPeer; if (!connect) throw new Error('Dedicated PG16 peers required');
    await connect(a => connect(b => connect(c => connect(async d => {
      const [observer] = await f.db.select({ pid: sql<number>`pg_backend_pid()` }).from(sql`(values (1)) as probe(n)`);
      expect(new Set([observer.pid, a.pid, b.pid, c.pid, d.pid]).size).toBe(5); await run([a, b, c, d]);
    }))));
  };
  const state = async () => ({ ...await f.snapshot(), retirements: await f.db.select().from(storeProductSkuRetirementLog), audit: await f.db.select().from(systemLog),
    dimensions: await f.db.select().from(storeProductAttr), results: await f.db.select().from(storeProductAttrResult) });
  const lifecycleFixture = async (surface: 'admin' | 'supplier') => {
    await f.db.update(storeProduct).set({ specType: 1, stock: 10, ...(surface === 'supplier' ? { type: 2, relationId: 51 } : {}) }).where(eq(storeProduct.id, 70));
    await f.db.insert(storeProductAttrValue).values({ id: 3, productId: 70, type: 0, unique: 'qablue01', suk: '蓝色,大号', price: '10.00', stock: 2 });
    await f.db.insert(storeProductAttr).values([
      { productId: 70, type: 0, attrName: '颜色', attrValues: '红色,蓝色' },
      { productId: 70, type: 0, attrName: '尺码', attrValues: '大号' },
    ]);
  };

  it('retirement waiting for product A must not hold the identity lock needed by editor B', async () => {
    const receipt = await confirm();
    await peers(async ([holder, buyer, retiring, editor]) => {
      await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=2 FOR UPDATE');
      const buying = buy(buyer.db, receipt); await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      let retirementFinished = false;
      const retirement = request(app(retiring.db), '/admin/product/sku/retire', lifecycleBody)
        .finally(() => { retirementFinished = true; });
      // On old code this is an exact product-row wait; fixed code refuses that
      // wait and rolls back before the independent editor starts.
      const retirementDeadline = performance.now() + 1_500;
      let retirementBlocked = false;
      while (!retirementFinished && performance.now() < retirementDeadline) {
        const [row] = await f.db.select({ blockers: sql<number[]>`pg_blocking_pids(${retiring.pid}::int)` }).from(sql`(values (1)) as probe(n)`);
        if (row.blockers.includes(buyer.pid)) { retirementBlocked = true; break; }
        await delay(10);
      }
      let finished = false;
      const editing = request(app(editor.db), '/admin/product/edit/71', editBody).finally(() => { finished = true; });
      let reverseWait = false;
      const deadline = performance.now() + 1_500;
      while (!finished && performance.now() < deadline) {
        const [row] = await f.db.select({ blockers: sql<number[]>`pg_blocking_pids(${editor.pid}::int)` }).from(sql`(values (1)) as probe(n)`);
        if (row.blockers.includes(retiring.pid)) { reverseWait = true; break; }
        await delay(10);
      }
      // In the regression, releasing this gate completes the three-way cycle.
      // Fixed code refuses retirement A and editor B before gate release.
      const bothRefusedBeforeRelease = retirementFinished && finished;
      await holder.exec('COMMIT');
      const [e, b, r] = await Promise.all([editing, buying, retirement]);
      expect(bothRefusedBeforeRelease).toBe(true);
      expect(retirementFinished).toBe(true); expect(retirementBlocked).toBe(false);
      expect(reverseWait, JSON.stringify({ e, b, r })).toBe(false);
      expect(e.status, e.msg).toBe(400); expect(e.msg).toContain('商品库存正在变化');
      expect(b.status, b.msg).toBe(200); expect(r.status).toBe(400); expect(r.msg).toContain('商品库存正在变化');
    });
    const after = await state(); expect(after.orders).toHaveLength(1); expect(after.retirements).toEqual([]); expect(after.audit).toEqual([]);
    expect(after.products.find(p => p.id === 70)?.stock).toBe(6); expect(after.products.find(p => p.id === 71)?.stock).toBe(7);
  }, 20_000);

  for (const surface of ['admin', 'supplier'] as const) {
    for (const action of ['retire', 'restore'] as const) {
      it(`${surface} ${action} rolls back flags, projections and lifecycle log on final audit failure`, async () => {
        await lifecycleFixture(surface);
        await f.db.update(storeCart).set({ isDel: 1 }).where(eq(storeCart.id, 1));
        if (action === 'restore') await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.id, 1));
        await f.exec("CREATE FUNCTION test_reject_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated final lifecycle failure'; END $$; CREATE TRIGGER test_reject_lifecycle BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION test_reject_lifecycle()");
        const before = await state();
        const r = await request(app(f.db), `/${surface}/product/sku/${action}`, lifecycleBody);
        expect(r.status).toBe(400); expect(r.msg).toContain('system_log'); expect(r.msg).not.toContain('商品库存正在变化');
        expect(await state()).toEqual(before);
      });
      it.each(['product', 'sku'] as const)(`${surface} ${action} refuses busy %s and releases all acquired locks`, async resource => {
        await lifecycleFixture(surface);
        if (action === 'restore') await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.id, 1));
        const before = await state();
        await peers(async ([holder, changing, probe]) => {
          await holder.exec(resource === 'product'
            ? 'BEGIN; SELECT id FROM store_product WHERE id=70 FOR UPDATE'
            : 'BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
          const r = await request(app(changing.db), `/${surface}/product/sku/${action}`, lifecycleBody);
          expect(r.status).toBe(400); expect(r.msg).toContain('商品库存正在变化'); expect(await state()).toEqual(before);
          // Probe before releasing the original holder: the failed transaction
          // must have released its global identity lock and (for SKU) product.
          await probe.exec('BEGIN');
          const [lock] = await probe.exec('SELECT pg_try_advisory_xact_lock(731602,0) AS acquired');
          expect(lock.acquired).toBe(true);
          if (resource === 'sku') await probe.exec('SELECT id FROM store_product WHERE id=70 FOR UPDATE NOWAIT');
          await probe.exec('COMMIT'); await holder.exec('COMMIT');
        });
      }, 20_000);
    }

    it(`${surface} preserves explicit retirement/restore, references, identity and audit`, async () => {
      await lifecycleFixture(surface);
      const before = await state();
      const blocked = await request(app(f.db), `/${surface}/product/sku/retire`, lifecycleBody);
      expect(blocked.status).toBe(400); expect(blocked.msg).toContain('引用'); expect(await state()).toEqual(before);
      await f.db.update(storeCart).set({ isDel: 1 }).where(eq(storeCart.id, 1));
      const retired = await request(app(f.db), `/${surface}/product/sku/retire`, lifecycleBody);
      expect(retired.status, retired.msg).toBe(200); expect(retired.data.changed).toBe(1);
      const middle = await state(); expect(middle.skus.find(s => s.id === 1)).toMatchObject({ isRetired: 1, unique: 'qared001', stock: 8 });
      expect(middle.products.find(p => p.id === 70)?.stock).toBe(2);
      const restored = await request(app(f.db), `/${surface}/product/sku/restore`, lifecycleBody);
      expect(restored.status, restored.msg).toBe(200); expect(restored.data.changed).toBe(1);
      const after = await state(); expect(after.skus.find(s => s.id === 1)).toMatchObject({ isRetired: 0, unique: 'qared001', stock: 8 });
      expect(after.products.find(p => p.id === 70)?.stock).toBe(10);
      expect(after.retirements.map(r => r.action).sort()).toEqual(['restore', 'retire']); expect(after.audit).toHaveLength(2);
    });
  }

  it.each(['retire', 'restore'] as const)('%s releases earlier selected SKU locks when a later SKU is busy', async action => {
    await lifecycleFixture('admin');
    if (action === 'restore') await f.exec('UPDATE store_product_attr_value SET is_retired=1 WHERE product_id=70');
    const before = await state();
    await peers(async ([holder, changing, probe]) => {
      await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=3 FOR UPDATE');
      const r = await request(app(changing.db), `/admin/product/sku/${action}`, { ...lifecycleBody, sku_ids: [3, 1] });
      expect(r.status).toBe(400); expect(r.msg).toContain('商品库存正在变化'); expect(await state()).toEqual(before);
      await probe.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE NOWAIT; SELECT id FROM store_product WHERE id=70 FOR UPDATE NOWAIT; COMMIT');
      await holder.exec('COMMIT');
    });
  }, 20_000);
});
