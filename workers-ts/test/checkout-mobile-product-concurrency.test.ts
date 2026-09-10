import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { adminMobileProductSetShow, adminMobileProductUpdateAttrs, adminMobileProductBatchProcess } from '../src/controllers/api/v1/AdminCrudController';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { waitForFinanceBlock } from './helpers/financePeers';
import { storeProduct, storeProductAttrValue, storeCart, systemLog, storeProductStockRecord, storeProductRelation,
  storeProductCategory, storeProductLabel, storeCouponIssue, storeProductCoupon, userLabel, systemForm, storeBrand } from '../src/models/schema';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('full-ORM mobile product management versus checkout', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let owned: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  const input = { cartIds: [1], addressId: 11, couponId: 0, type: 0 };
  const attrs = { attr_value: [{ unique: 'qared001', price: '10.00', cost: '1.00', ot_price: '12.00', stock: 8 }] };
  const app = (db: DbClient) => {
    const a = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    a.use('*', async (c, next) => {
      c.set('container', createContainerFromDb(db)); c.set('uid', 11); c.set('adminId', 1);
      // Actual handlers/transactions, synthetic authentication/KV/Sequence only.
      c.set('adminInfo', { id: 1, account: 'isolated', realName: 'isolated', level: 0, roles: '', divisionId: 0 });
      await next();
    });
    a.onError((e, c) => c.json({ status: 400, msg: e.message, data: null }));
    a.post('/api/order/create/:key', orderCreate);
    a.post('/mobile/show', adminMobileProductSetShow);
    a.post('/mobile/attrs/:id', adminMobileProductUpdateAttrs);
    a.post('/mobile/batch', adminMobileProductBatchProcess);
    return a;
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
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'isolated', get: () => ({ fetch: async () => new Response('mobile_concurrency_order') }) } });
  }, 120_000);
  afterEach(async () => { await f?.close(); }, 120_000);
  const request = async (a: ReturnType<typeof app>, path: string, body: object) => {
    const r = await a.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': '11' }, body: JSON.stringify(body) }, f.env);
    return r.json() as Promise<{ status: number; msg: string; data: { orderKey: string; quoteToken: string; changed: number } }>;
  };
  const confirm = async (body = input) => { const r = await request(f.app, '/api/order/confirm', body); expect(r.status, r.msg).toBe(200); return r.data; };
  const buy = (db: DbClient, receipt: Awaited<ReturnType<typeof confirm>>, body = input) => request(app(db), `/api/order/create/${receipt.orderKey}`, { ...body, quoteToken: receipt.quoteToken });
  const peers = async (run: (peers: [SequenceRunnerPeer, SequenceRunnerPeer, SequenceRunnerPeer]) => Promise<void>) => {
    const connect = owned.withPeer; if (!connect) throw new Error('Dedicated PG16 peers required');
    await connect(a => connect(b => connect(async c => {
      const [observer] = await f.db.select({ pid: sql<number>`pg_backend_pid()` }).from(sql`(values (1)) as probe(n)`);
      expect(new Set([observer.pid, a.pid, b.pid, c.pid]).size).toBe(4); await run([a, b, c]);
    })));
  };
  const state = async () => ({ ...await f.snapshot(), audit: await f.db.select().from(systemLog), stocks: await f.db.select().from(storeProductStockRecord), relations: await f.db.select().from(storeProductRelation), coupons: await f.db.select().from(storeProductCoupon) });
  const secondProduct = async () => {
    await f.db.insert(storeProduct).values({ id: 71, storeName: 'second', price: '10.00', stock: 8, isShow: 1, isVerify: 1, freight: 3, tempId: 10 });
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 71, unique: 'qasecond', suk: '默认', type: 0, price: '10.00', stock: 8 });
  };
  const finishedOrBlocked = async (pid: number, blocker: number, finished: () => boolean) => {
    const deadline = performance.now() + 1_500;
    while (!finished() && performance.now() < deadline) {
      const [row] = await f.db.select({ blockers: sql<number[]>`pg_blocking_pids(${pid}::int)` }).from(sql`(values (1)) as probe(n)`);
      if (row.blockers.includes(blocker)) return true;
      await delay(10);
    }
    return false;
  };

  it.each(['show', 'attrs'] as const)('%s refuses inverse cart/SKU waits without killing checkout', async operation => {
    const receipt = await confirm();
    await peers(async ([holder, buyer, editor]) => {
      await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
      const buying = buy(buyer.db, receipt); await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      let finished = false;
      const editing = request(app(editor.db), operation === 'show' ? '/mobile/show' : '/mobile/attrs/70', operation === 'show' ? { ids: [70], is_show: 0 } : attrs)
        .finally(() => { finished = true; });
      const reverseWait = await finishedOrBlocked(editor.pid, operation === 'show' ? buyer.pid : holder.pid, () => finished);
      const refusedBeforeRelease = finished;
      await holder.exec('COMMIT');
      const [e, b] = await Promise.all([editing, buying]);
      expect(reverseWait, JSON.stringify({ e, b })).toBe(false); expect(refusedBeforeRelease).toBe(true);
      expect(e.status).toBe(400); expect(e.msg).toContain('正在变化'); expect(b.status, b.msg).toBe(200);
    });
    const after = await state(); expect(after.orders).toHaveLength(1); expect(after.audit).toEqual([]); expect(after.stocks).toEqual([]);
    expect(after.products[0]).toMatchObject({ stock: 6, isShow: 1 }); expect(after.skus[0]).toMatchObject({ stock: 6, sales: 2 });
  }, 20_000);

  it('multi-product batch refuses a later occupied product and releases earlier product locks', async () => {
    await secondProduct();
    await f.db.update(storeCart).set({ productId: 71, productAttrUnique: 'qasecond', cartNum: 1 }).where(eq(storeCart.id, 1));
    await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 70, productAttrUnique: 'qared001', cartNum: 2, isNew: 1, status: 1 });
    const body = { ...input, cartIds: [1, 2] };
    // Validate actual DAO order instead of assuming SQL sorts cart IDs.
    expect((await f.container.storeCartDao.getByIds(body.cartIds)).map(c => c.productId)).toEqual([71, 70]);
    const receipt = await confirm(body);
    await peers(async ([holder, buyer, editor]) => {
      await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
      const buying = buy(buyer.db, receipt, body); await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      let finished = false;
      const editing = request(app(editor.db), '/mobile/batch', { ids: [70, 71], type: 6, data: { recommend: ['is_hot'] } }).finally(() => { finished = true; });
      const reverseWait = await finishedOrBlocked(editor.pid, buyer.pid, () => finished), refusedBeforeRelease = finished;
      await holder.exec('COMMIT');
      const [e, b] = await Promise.all([editing, buying]);
      expect(reverseWait, JSON.stringify({ e, b })).toBe(false); expect(refusedBeforeRelease).toBe(true);
      expect(e.status).toBe(400); expect(e.msg).toContain('正在变化'); expect(b.status, b.msg).toBe(200);
    });
    const after = await state(); expect(after.orders).toHaveLength(1); expect(after.products.every(p => p.isHot === 0)).toBe(true); expect(after.audit).toEqual([]);
    expect(after.products.find(p => p.id === 70)?.stock).toBe(6); expect(after.products.find(p => p.id === 71)?.stock).toBe(7);
  }, 20_000);

  it('show/hide changes only open live carts and category relations, with verified audit', async () => {
    await secondProduct();
    await f.db.insert(storeCart).values([
      { id: 2, uid: 11, productId: 70, productAttrUnique: 'qared001', isPay: 1, status: 1 },
      { id: 3, uid: 11, productId: 70, productAttrUnique: 'qared001', isDel: 1, status: 1 },
      { id: 4, uid: 11, productId: 71, productAttrUnique: 'qasecond', status: 1 },
    ]);
    await f.db.insert(storeProductRelation).values([
      { productId: 70, type: 1, relationId: 9, status: 1 }, { productId: 70, type: 2, relationId: 9, status: 1 },
    ]);
    const hidden = await request(app(f.db), '/mobile/show', { ids: [70], is_show: 0 }); expect(hidden.status, hidden.msg).toBe(200);
    const middle = await state(); expect(middle.carts.find(c => c.id === 1)?.status).toBe(0);
    expect(middle.carts.filter(c => c.id !== 1).every(c => c.status === 1)).toBe(true);
    expect(middle.relations.find(r => r.type === 1)?.status).toBe(0); expect(middle.relations.find(r => r.type === 2)?.status).toBe(1);
    expect(middle.products.find(p => p.id === 71)?.isShow).toBe(1);
    await f.db.update(storeProduct).set({ autoOffTime: 123 }).where(eq(storeProduct.id, 70));
    const shown = await request(app(f.db), '/mobile/show', { ids: [70], is_show: 1 }); expect(shown.status, shown.msg).toBe(200);
    const after = await state(); expect(after.products.find(p => p.id === 70)).toMatchObject({ isShow: 1, autoOffTime: 0 });
    expect(after.carts.every(c => c.status === 1)).toBe(true); expect(after.audit).toHaveLength(2);
  });

  it('busy later cart rolls back earlier cart/product writes and releases locks', async () => {
    await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 70, productAttrUnique: 'qared001', status: 1 });
    const before = await state();
    await peers(async ([holder, editor, probe]) => {
      await holder.exec('BEGIN; SELECT id FROM store_cart WHERE id=2 FOR UPDATE');
      const r = await request(app(editor.db), '/mobile/show', { ids: [70], is_show: 0 });
      expect(r.status).toBe(400); expect(r.msg).toContain('正在变化'); expect(await state()).toEqual(before);
      await probe.exec('BEGIN; SELECT id FROM store_cart WHERE id=1 FOR UPDATE NOWAIT; SELECT id FROM store_product WHERE id=70 FOR UPDATE NOWAIT; COMMIT');
      await holder.exec('COMMIT');
    });
  }, 20_000);

  it('explicit SKU refresh preserves consumed sales, records only fresh stock difference and excludes retired rows', async () => {
    const receipt = await confirm(); expect((await buy(f.db, receipt)).status).toBe(200);
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 70, unique: 'qaold001', suk: '旧规格', type: 0, stock: 99, isRetired: 1 });
    const r = await request(app(f.db), '/mobile/attrs/70', { attr_value: [{ ...attrs.attr_value[0], stock: 7 }] });
    expect(r.status, r.msg).toBe(200);
    const after = await state(); expect(after.skus.find(s => s.id === 1)).toMatchObject({ stock: 7, sumStock: 7, sales: 2, unique: 'qared001' });
    expect(after.skus.find(s => s.id === 2)).toMatchObject({ stock: 99, isRetired: 1 }); expect(after.products[0].stock).toBe(7);
    expect(after.stocks).toHaveLength(1); expect(after.stocks[0]).toMatchObject({ number: 1, pm: 1, unique: 'qared001' });
  });

  it('bounds raw request bytes before SQL while retaining a formatted 500-SKU transaction', async () => {
    const added = Array.from({ length: 499 }, (_, i) => ({
      id: i + 2, productId: 70, unique: '界'.repeat(7) + String.fromCharCode(0x4e00 + i),
      suk: `isolated-${i}`, type: 0, stock: 1, sales: 3, price: '10.00', cost: '1.00', otPrice: '12.00',
    }));
    await f.db.insert(storeProductAttrValue).values(added);
    const body = { attr_value: [attrs.attr_value[0], ...added.map(row => ({
      unique: row.unique, price: row.price, cost: row.cost, ot_price: row.otPrice, stock: row.stock,
    }))].map(row => ({ ...row, stock: 2, price: '20.00', cost: '3.00', ot_price: '25.00' })) };
    const raw = JSON.stringify(body, null, 4);
    const maxBytes = 128 * 1024;
    const bytes = new TextEncoder().encode(raw).byteLength;
    expect(bytes).toBeGreaterThan(64 * 1024); expect(bytes).toBeLessThan(maxBytes);
    const before = await state();
    const a = app(f.db);
    const postRaw = async (payload: string) => {
      const r = await a.request('/mobile/attrs/70', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: payload,
      }, f.env);
      expect(r.headers.get('cache-control')).toBe('private, no-store, max-age=0');
      return r.json();
    };
    expect(await postRaw(raw + ' '.repeat(maxBytes + 1 - bytes)))
      .toEqual({ status: 400, msg: '请求数据不能超过128 KiB', data: null });
    expect(await state()).toEqual(before);
    expect(await postRaw(raw + ' '.repeat(maxBytes - bytes)))
      .toEqual({ status: 200, msg: '修改成功', data: { changed: 500 } });
    const after = await state();
    expect(after.skus).toHaveLength(500); expect(after.stocks).toHaveLength(500);
    for (const previous of before.skus) {
      expect(after.skus.find(row => row.id === previous.id)).toEqual({
        ...previous, stock: 2, sumStock: 2, price: '20.00', cost: '3.00', otPrice: '25.00',
      });
      expect(after.stocks.find(row => row.unique === previous.unique)).toMatchObject({
        productId: 70, costPrice: '3.00', number: Math.abs(2 - previous.stock), pm: previous.stock > 2 ? 0 : 1,
      });
    }
    expect(after.products).toEqual(before.products.map(row => ({ ...row, stock: 1000, price: '20.00', cost: '3.00', otPrice: '25.00' })));
    expect({ ...after, skus: [], products: [], stocks: [] }).toEqual({ ...before, skus: [], products: [], stocks: [] });
  }, 20_000);

  const batches = [
    { type: 1, data: { cate_id: [9] }, expected: { cateId: '9' }, relation: 1 },
    { type: 2, data: { store_label_id: [9] }, expected: { storeLabelId: '9' }, relation: 3 },
    { type: 3, data: { delivery_type: [1, 3] }, expected: { deliveryType: '1,3' } },
    { type: 4, data: { give_integral: '2.00', coupon_ids: [9] }, expected: { giveIntegral: '2.00' } },
    { type: 5, data: { label_id: [9] }, expected: { labelId: '9' }, relation: 4 },
    { type: 6, data: { recommend: ['is_hot', 'is_new'] }, expected: { isHot: 1, isNew: 1, isGood: 0 } },
    { type: 7, data: { system_form_id: 9 }, expected: { systemFormId: 9 } },
    { type: 8, data: { freight: 2, postage: '3.00', temp_id: 0 }, expected: { freight: 2, postage: '3.00', tempId: 0 } },
    { type: 9, data: { brand_id: [9] }, expected: { brandId: 9, brandCom: '9' }, relation: 2 },
  ];
  it.each(batches)('preserves actual batch type $type for two products', async scenario => {
    await secondProduct();
    await f.db.insert(storeProductCategory).values({ id: 9, cateName: 'isolated', isShow: 1, type: 0, relationId: 0 });
    await f.db.insert(storeProductLabel).values({ id: 9, labelName: 'isolated', status: 1, isShow: 1 });
    await f.db.insert(userLabel).values({ id: 9, name: 'isolated', status: 1 });
    await f.db.insert(systemForm).values({ id: 9, name: 'isolated', status: 1, isDel: 0 });
    await f.db.insert(storeBrand).values({ id: 9, brandName: 'isolated', pid: 0, isShow: 1, isDel: 0 });
    await f.db.insert(storeCouponIssue).values({ id: 9, title: 'isolated', couponTitle: 'isolated', status: 1, isDel: 0 });
    const r = await request(app(f.db), '/mobile/batch', { ids: [71, 70, 70], type: scenario.type, data: scenario.data });
    expect(r.status, r.msg).toBe(200); expect(r.data.changed).toBe(2);
    const after = await state(); for (const p of after.products) expect(p).toMatchObject(scenario.expected);
    expect(after.audit).toHaveLength(2);
    if (scenario.relation) { expect(after.relations).toHaveLength(2); for (const r of after.relations) expect(r).toMatchObject({ type: scenario.relation, relationId: 9, status: 1 }); }
    if (scenario.type === 4) { expect(after.coupons).toHaveLength(2); expect(after.coupons.every(c => c.issueCouponId === 9)).toBe(true); }
  });

  it.each(['show', 'attrs', 'batch'] as const)('%s final SQL failure rolls back the entire operation', async operation => {
    const table = operation === 'attrs' ? 'store_product_stock_record' : 'system_log';
    await f.exec(`CREATE FUNCTION test_mobile_final_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated mobile final failure'; END $$; CREATE TRIGGER test_mobile_final_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION test_mobile_final_failure()`);
    const before = await state();
    const path = operation === 'show' ? '/mobile/show' : operation === 'attrs' ? '/mobile/attrs/70' : '/mobile/batch';
    const body = operation === 'show' ? { ids: [70], is_show: 0 } : operation === 'attrs' ? { attr_value: [{ ...attrs.attr_value[0], stock: 9 }] } : { ids: [70], type: 6, data: { recommend: ['is_hot'] } };
    const r = await request(app(f.db), path, body);
    expect(r.status).toBe(400); expect(r.msg).toContain(table); expect(r.msg).not.toContain('正在变化'); expect(await state()).toEqual(before);
  });

  it('does not translate a non-lock SQL error from product selection into an inventory retry', async () => {
    const before = await state();
    await f.exec('ALTER TABLE store_product RENAME COLUMN is_verify TO isolated_verify');
    const r = await request(app(f.db), '/mobile/show', { ids: [70], is_show: 0 });
    expect(r.status).toBe(400); expect(r.msg).toContain('is_verify'); expect(r.msg).not.toContain('正在变化');
    await f.exec('ALTER TABLE store_product RENAME COLUMN isolated_verify TO is_verify');
    expect(await state()).toEqual(before);
  });
});
