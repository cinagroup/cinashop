import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { productCreate, productInfo, productUpdate, productSetShow, productStockUpload } from '../src/controllers/out/OutApiController';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { completePurchaseOriginEvidenceOrm } from '../src/migrations/runPurchaseOriginEvidence';
import { completePurchaseCancellationEvidenceOrm } from '../src/migrations/runPurchaseCancellationEvidence';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { waitForFinanceBlock } from './helpers/financePeers';
import { runtimeBusinessPrivilegePlan } from '../src/migrations/runtimeBusinessPrivilegePlan';
import { storeProduct, storeProductAttrValue, storeProductCategory, storeCart, storeProductRelation,
  outProductWriteReplay, storeProductStockRecord, storeProductAttr, storeProductAttrResult, storeProductDescription, storeBrand, storeProductEnsure, storeCouponIssue, storeProductCoupon } from '../src/models/schema';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('full-ORM Out product management versus checkout', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let owned: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let network: ReturnType<typeof vi.spyOn>;
  const key = '8c237c34-9995-4e47-8e02-c6d3e67524db';
  const input = { cartIds: [1], addressId: 11, couponId: 0, type: 0 };
  const productBody = { product_type: 0, supplier_id: 0, cate_id: [9], store_name: 'isolated Out product',
    slider_image: ['/isolated.png'], delivery_type: [1], freight: 3, temp_id: 10, spec_type: 1, is_show: 1,
    items: [{ value: '颜色', detail: ['红色'] }, { value: '尺码', detail: ['大号'] }],
    attrs: [{ suk: '红色,大号', detail: { 颜色: '红色', 尺码: '大号' }, unique: 'qared001', price: '10.00', vip_price: '9.00', stock: 999, bar_code: 'OUT-A' }] };
  const app = (db: DbClient) => {
    const a = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    a.use('*', async (c, next) => {
      c.set('container', createContainerFromDb(db)); c.set('uid', 11);
      // Synthetic identity/KV/Sequence; actual handlers, services and PostgreSQL.
      c.set('outInfo', { id: 7, appid: 'isolated-out', title: 'isolated', rules: [] }); await next();
    });
    a.onError((e, c) => c.json({ status: 400, msg: e.message, data: null }));
    a.post('/api/order/create/:key', orderCreate);
    a.post('/outapi/product', productCreate);
    a.get('/outapi/product/:id', productInfo);
    a.put('/outapi/product/stock/upload', productStockUpload);
    a.put('/outapi/product/set_show/:id/:is_show', productSetShow);
    a.put('/outapi/product/:id', productUpdate);
    return a;
  };
  beforeEach(async () => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External provider HTTP is not accepted by native Out product tests'));
    f = await createPcCheckoutQuoteFixture([], async () => {
      owned = await sequenceRunnerDatabase();
      try {
        const api = await import('drizzle-kit/api'), schema = await import('../src/models/schema');
        await owned.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(schema))).join('\n'));
        await completePurchaseOriginEvidenceOrm(owned.db);
        await completePurchaseCancellationEvidenceOrm(owned.db);
        return owned;
      } catch (e) { await owned.close(); throw e; }
    });
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.db.insert(storeProductCategory).values({ id: 9, cateName: 'isolated', isShow: 1 });
    await f.db.update(storeProduct).set({ cateId: '9', specType: 1 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ barCode: 'OUT-A' }).where(eq(storeProductAttrValue.id, 1));
    await f.db.insert(storeProductRelation).values({ productId: 70, relationId: 9, type: 1, status: 1 });
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'isolated', get: () => ({ fetch: async () => new Response('out_product_concurrency_order') }) } });
  }, 120_000);
  afterEach(async () => { try { expect(network).not.toHaveBeenCalled(); } finally { network?.mockRestore(); await f?.close(); } }, 120_000);
  const request = async (a: ReturnType<typeof app>, path: string, body?: object, method = 'PUT', requestKey = key) => {
    const r = await a.request(path, { method, headers: { 'content-type': 'application/json', 'x-fixture-user': '11', 'Idempotency-Key': requestKey },
      ...(body ? { body: JSON.stringify(body) } : {}) }, f.env);
    return r.json() as Promise<{ status: number; msg: string; data: { orderKey: string; quoteToken: string; id: number; updated: number; idempotent: boolean; stock_preserved: boolean } }>;
  };
  const confirm = async (body = input) => { const r = await request(f.app, '/api/order/confirm', body, 'POST'); expect(r.status, r.msg).toBe(200); return r.data; };
  const buy = (db: DbClient, receipt: Awaited<ReturnType<typeof confirm>>, body = input) => request(app(db), `/api/order/create/${receipt.orderKey}`, { ...body, quoteToken: receipt.quoteToken }, 'POST');
  const peers = async (run: (peers: [SequenceRunnerPeer, SequenceRunnerPeer, SequenceRunnerPeer]) => Promise<void>) => {
    const connect = owned.withPeer; if (!connect) throw new Error('Dedicated PG16 peers required');
    await connect(a => connect(b => connect(async c => {
      const [observer] = await f.db.select({ pid: sql<number>`pg_backend_pid()` }).from(sql`(values (1)) as probe(n)`);
      expect(new Set([observer.pid, a.pid, b.pid, c.pid]).size).toBe(4); await run([a, b, c]);
    })));
  };
  const state = async () => ({ ...await f.snapshot(), replays: await f.db.select().from(outProductWriteReplay),
    stocks: await f.db.select().from(storeProductStockRecord), relations: await f.db.select().from(storeProductRelation),
    attrs: await f.db.select().from(storeProductAttr), results: await f.db.select().from(storeProductAttrResult), descriptions: await f.db.select().from(storeProductDescription), brands: await f.db.select().from(storeBrand).orderBy(storeBrand.id), ensures: await f.db.select().from(storeProductEnsure).orderBy(storeProductEnsure.id) });
  const finishedOrBlocked = async (pid: number, blocker: number, finished: () => boolean) => {
    const deadline = performance.now() + 1_500;
    while (!finished() && performance.now() < deadline) {
      const [row] = await f.db.select({ blockers: sql<number[]>`pg_blocking_pids(${pid}::int)` }).from(sql`(values (1)) as probe(n)`);
      if (row.blockers.includes(blocker)) return true;
      await delay(10);
    }
    return false;
  };

  it('show refuses the cart-to-product inverse wait and preserves checkout', async () => {
    const receipt = await confirm();
    await peers(async ([holder, buyer, editor]) => {
      await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
      const buying = buy(buyer.db, receipt); await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      let finished = false;
      const editing = request(app(editor.db), '/outapi/product/set_show/70/0').finally(() => { finished = true; });
      const reverseWait = await finishedOrBlocked(editor.pid, buyer.pid, () => finished), refusedBeforeRelease = finished;
      await holder.exec('COMMIT');
      const [e, b] = await Promise.all([editing, buying]);
      expect(reverseWait, JSON.stringify({ e, b })).toBe(false); expect(refusedBeforeRelease).toBe(true);
      expect(e.status).toBe(400); expect(e.msg).toContain('正在变化'); expect(b.status, b.msg).toBe(200);
    });
    const after = await state(); expect(after.orders).toHaveLength(1); expect(after.replays).toEqual([]);
    expect(after.products[0]).toMatchObject({ stock: 6, isShow: 1 }); expect(after.stocks).toEqual([]);
  }, 20_000);

  it('save refuses a busy product after SKU locks instead of entering the buyer cart cycle', async () => {
    const receipt = await confirm();
    await peers(async ([holder, buyer, editor]) => {
      await holder.exec('BEGIN; SELECT id FROM store_product WHERE id=70 FOR UPDATE');
      let finished = false;
      const editing = request(app(editor.db), '/outapi/product/70', productBody).finally(() => { finished = true; });
      const reverseWait = await finishedOrBlocked(editor.pid, holder.pid, () => finished), refusedBeforeRelease = finished;
      const buying = buy(buyer.db, receipt);
      // Red version holds SKU while waiting for the product; fixed version has rolled back.
      await waitForFinanceBlock(f.db, buyer.pid, reverseWait ? editor.pid : holder.pid);
      await holder.exec('COMMIT');
      const [e, b] = await Promise.all([editing, buying]);
      expect(reverseWait, JSON.stringify({ e, b })).toBe(false); expect(refusedBeforeRelease).toBe(true);
      expect(e.status).toBe(400); expect(e.msg).toContain('正在变化'); expect(b.status, b.msg).toBe(200);
    });
    const after = await state(); expect(after.orders).toHaveLength(1); expect(after.replays).toEqual([]);
    expect(after.products[0].storeName).not.toBe(productBody.store_name); expect(after.skus[0].stock).toBe(6);
    expect(after.attrs).toEqual([]); expect(after.results).toEqual([]); expect(after.descriptions).toEqual([]);
  }, 20_000);

  it('stock upload refuses a cross-product cycle even when editing different SKUs from the buyer', async () => {
    await f.db.insert(storeProduct).values({ id: 71, storeName: 'second', price: '10.00', stock: 8, isShow: 1, isVerify: 1, freight: 3, tempId: 10 });
    await f.db.insert(storeProductAttrValue).values([
      { id: 2, productId: 71, unique: 'qasecond', suk: '默认', type: 0, price: '10.00', stock: 8 },
      { id: 3, productId: 70, unique: 'qaextra1', suk: 'extra', type: 0, price: '10.00', stock: 1, barCode: 'OUT-X' },
      { id: 4, productId: 71, unique: 'qaextra2', suk: 'extra', type: 0, price: '10.00', stock: 1, barCode: 'OUT-Y' },
    ]);
    await f.db.update(storeProduct).set({ stock: 9 });
    await f.db.update(storeCart).set({ productId: 71, productAttrUnique: 'qasecond', cartNum: 1 }).where(eq(storeCart.id, 1));
    await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 70, productAttrUnique: 'qared001', cartNum: 2, isNew: 1, status: 1 });
    const body = { ...input, cartIds: [1, 2] }, receipt = await confirm(body);
    expect((await createContainerFromDb(f.db).storeCartDao.getByIds([1, 2])).map(row => row.productId)).toEqual([71, 70]);
    await peers(async ([holder, buyer, editor]) => {
      await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
      const buying = buy(buyer.db, receipt, body); await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      let finished = false;
      const editing = request(app(editor.db), '/outapi/product/stock/upload', { items: [{ bar_code: 'OUT-X', qty: 2 }, { bar_code: 'OUT-Y', qty: 2 }] }).finally(() => { finished = true; });
      const reverseWait = await finishedOrBlocked(editor.pid, buyer.pid, () => finished), refusedBeforeRelease = finished;
      await holder.exec('COMMIT');
      const [e, b] = await Promise.all([editing, buying]);
      expect(reverseWait, JSON.stringify({ e, b })).toBe(false); expect(refusedBeforeRelease).toBe(true);
      expect(e.status).toBe(400); expect(e.msg).toContain('正在变化'); expect(b.status, b.msg).toBe(200);
    });
    const after = await state(); expect(after.orders).toHaveLength(1); expect(after.replays).toEqual([]); expect(after.stocks).toEqual([]);
    expect(after.skus.filter(row => row.id >= 3).every(row => row.stock === 1)).toBe(true);
  }, 20_000);
  it.each(['save', 'show'] as const)('%s rolls back every earlier write on a busy later cart, then reuses the uncommitted key', async operation => {
    await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 70, productAttrUnique: 'qared001', status: 1 });
    const before = await state();
    const path = operation === 'show' ? '/outapi/product/set_show/70/0' : '/outapi/product/70';
    const body = operation === 'show' ? undefined : { ...productBody, is_show: 0 };
    await peers(async ([holder, editor, probe]) => {
      await holder.exec('BEGIN; SELECT id FROM store_cart WHERE id=2 FOR UPDATE');
      const r = await request(app(editor.db), path, body);
      expect(r.status).toBe(400); expect(r.msg).toContain('正在变化'); expect(await state()).toEqual(before);
      await probe.exec('BEGIN; SELECT id FROM store_cart WHERE id=1 FOR UPDATE NOWAIT; SELECT id FROM store_product WHERE id=70 FOR UPDATE NOWAIT; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE NOWAIT; COMMIT');
      await holder.exec('COMMIT');
    });
    const first = await request(app(f.db), path, body); expect(first.status, first.msg).toBe(200);
    const after = await state(); expect(after.replays).toHaveLength(1); expect(after.carts.every(row => row.status === 0)).toBe(true);
    const repeated = await request(app(f.db), path, body); expect(repeated.status).toBe(200); expect(repeated.data.idempotent).toBe(true);
    expect(await state()).toEqual(after);
  }, 20_000);

  it.each(['save', 'stock'] as const)('%s releases earlier SKU and advisory locks on a busy later SKU', async operation => {
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 70, unique: 'qasmall1', suk: '红色,小号', type: 0, stock: 2, price: '10.00', barCode: 'OUT-B' });
    const body = operation === 'stock' ? { items: [{ bar_code: 'OUT-A', qty: 9 }, { bar_code: 'OUT-B', qty: 4 }] } : {
      ...productBody, items: [productBody.items[0], { value: '尺码', detail: ['大号', '小号'] }],
      attrs: [...productBody.attrs, { ...productBody.attrs[0], suk: '红色,小号', detail: { 颜色: '红色', 尺码: '小号' }, unique: 'qasmall1', bar_code: 'OUT-B' }],
    };
    const before = await state();
    await peers(async ([holder, editor, probe]) => {
      await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=2 FOR UPDATE');
      const r = await request(app(editor.db), operation === 'stock' ? '/outapi/product/stock/upload' : '/outapi/product/70', body);
      expect(r.status).toBe(400); expect(r.msg).toContain('正在变化'); expect(await state()).toEqual(before);
      await probe.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE NOWAIT');
      const [locks] = await probe.db.select({ identity: sql<boolean>`pg_try_advisory_xact_lock(731602,0)`, replay: sql<boolean>`pg_try_advisory_xact_lock(744220001,7)` }).from(sql`(values (1)) as probe(n)`);
      expect(locks).toEqual({ identity: true, replay: true }); await probe.exec('COMMIT'); await holder.exec('COMMIT');
    });
  }, 20_000);

  it.each(['create', 'save', 'show', 'stock'] as const)('%s final replay-ledger failure rolls back its entire business transaction', async operation => {
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product','id'),70,true); SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),1,true)");
    await f.exec("CREATE FUNCTION test_out_ledger_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated Out ledger failure'; END $$; CREATE TRIGGER test_out_ledger_failure BEFORE INSERT ON out_product_write_replay FOR EACH ROW EXECUTE FUNCTION test_out_ledger_failure()");
    const before = await state();
    const path = operation === 'create' ? '/outapi/product' : operation === 'save' ? '/outapi/product/70' : operation === 'show' ? '/outapi/product/set_show/70/0' : '/outapi/product/stock/upload';
    const body = operation === 'stock' ? { items: [{ bar_code: 'OUT-A', qty: 9 }] } : operation === 'show' ? undefined : productBody;
    const r = await request(app(f.db), path, body, operation === 'create' ? 'POST' : 'PUT');
    expect(r.status).toBe(400); expect(r.msg).toContain('out_product_write_replay'); expect(r.msg).not.toContain('正在变化');
    expect(await state()).toEqual(before);
  });

  it.each(['save', 'stock'] as const)('%s after checkout preserves consumed sales and replays without another write', async operation => {
    const receipt = await confirm(); expect((await buy(f.db, receipt)).status).toBe(200);
    const before = await state(), previousSku = before.skus[0];
    const path = operation === 'save' ? '/outapi/product/70' : '/outapi/product/stock/upload';
    const body = operation === 'save' ? productBody : { items: [{ bar_code: 'OUT-A', qty: 9 }] };
    const r = await request(app(f.db), path, body); expect(r.status, r.msg).toBe(200);
    const after = await state(); expect(after.replays).toHaveLength(1);
    expect(after.skus[0]).toMatchObject({ id: previousSku.id, unique: previousSku.unique, sales: 2,
      stock: operation === 'save' ? 6 : 9, sumStock: operation === 'save' ? previousSku.sumStock : previousSku.sumStock + 3 });
    expect(after.products[0]).toMatchObject({ stock: operation === 'save' ? 6 : 9, sales: 2 });
    if (operation === 'save') { expect(after.stocks).toEqual([]); expect(r.data.stock_preserved).toBe(true); }
    else { expect(after.stocks).toHaveLength(1); expect(after.stocks[0]).toMatchObject({ unique: 'qared001', number: 3, pm: 1 }); }
    const replay = await request(app(f.db), path, body); expect(replay.status).toBe(200); expect(replay.data.idempotent).toBe(true);
    expect(await state()).toEqual(after);
  });

  it('preserves the existing Out all-cart/all-relation show policy without touching another product', async () => {
    await f.db.insert(storeProduct).values({ id: 71, storeName: 'other', stock: 1, isShow: 1 });
    await f.db.insert(storeCart).values([
      { id: 2, uid: 11, productId: 70, isPay: 1, status: 1 }, { id: 3, uid: 11, productId: 70, isDel: 1, status: 1 },
      { id: 4, uid: 11, productId: 71, status: 1 },
    ]);
    await f.db.insert(storeProductRelation).values([{ productId: 70, relationId: 9, type: 2, status: 1 }, { productId: 71, relationId: 9, type: 1, status: 1 }]);
    expect((await request(app(f.db), '/outapi/product/set_show/70/0')).status).toBe(200);
    const hidden = await state(); expect(hidden.carts.filter(row => row.productId === 70).every(row => row.status === 0)).toBe(true);
    expect(hidden.relations.filter(row => row.productId === 70).every(row => row.status === 0)).toBe(true);
    expect(hidden.carts.find(row => row.id === 4)?.status).toBe(1); expect(hidden.products.find(row => row.id === 71)?.isShow).toBe(1);
    await f.db.update(storeProduct).set({ autoOffTime: 123 }).where(eq(storeProduct.id, 70));
    expect((await request(app(f.db), '/outapi/product/set_show/70/1', undefined, 'PUT', '8c237c34-9995-4e47-8e02-c6d3e67524dc')).status).toBe(200);
    expect((await state()).products.find(row => row.id === 70)).toMatchObject({ isShow: 1, autoOffTime: 0 });
  });

  it('concurrent create with the same key commits only one product and one ledger row', async () => {
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product','id'),70,true); SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),1,true)");
    await peers(async ([holder, first, second]) => {
      await holder.exec('BEGIN; LOCK TABLE store_product_category IN ACCESS EXCLUSIVE MODE');
      const creating = request(app(first.db), '/outapi/product', productBody, 'POST'); await waitForFinanceBlock(f.db, first.pid, holder.pid);
      const repeating = request(app(second.db), '/outapi/product', productBody, 'POST'); await waitForFinanceBlock(f.db, second.pid, first.pid);
      await holder.exec('COMMIT'); const [a, b] = await Promise.all([creating, repeating]);
      expect(a.status, a.msg).toBe(200); expect(b.status, b.msg).toBe(200); expect(a.data.id).toBe(b.data.id); expect(b.data.idempotent).toBe(true);
    });
    const after = await state(); expect(after.products).toHaveLength(2); expect(after.skus).toHaveLength(2); expect(after.replays).toHaveLength(1);
    expect(after.products.find(row => row.id !== 70)).toMatchObject({ stock: 999, type: 0, relationId: 0 });
    expect(after.skus.find(row => row.id !== 1)?.unique).not.toBe('qared001');
  }, 20_000);

  it('preserves non-lock selection errors rather than translating them into a refresh retry', async () => {
    const before = await state(); await f.exec('ALTER TABLE store_product RENAME COLUMN price TO isolated_price');
    const r = await request(app(f.db), '/outapi/product/set_show/70/0');
    expect(r.status).toBe(400); expect(r.msg).toContain('price'); expect(r.msg).not.toContain('正在变化');
    await f.exec('ALTER TABLE store_product RENAME COLUMN isolated_price TO price'); expect(await state()).toEqual(before);
  });

  it('stock upload excludes retired SKU inventory from the active product total', async () => {
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 70, unique: 'qaold001', suk: 'retired', type: 0, stock: 99, isRetired: 1, barCode: 'OUT-OLD' });
    const r = await request(app(f.db), '/outapi/product/stock/upload', { items: [{ bar_code: 'OUT-A', qty: 9 }] });
    expect(r.status, r.msg).toBe(200); const after = await state();
    expect(after.skus.find(row => row.id === 2)).toMatchObject({ stock: 99, isRetired: 1 });
    expect(after.products[0].stock).toBe(9); expect(after.stocks).toHaveLength(1);
  });

  async function seedBrands() {
    await f.db.insert(storeBrand).values([
      { id: 30, brandName: '平台父品牌', pid: 0, storeId: 0, isShow: 1 },
      { id: 31, brandName: '平台子品牌', pid: 30, storeId: 0, isShow: 1 },
      { id: 32, brandName: '另一子品牌', pid: 30, storeId: 0, isShow: 1 },
      { id: 33, brandName: '门店品牌', pid: 0, storeId: 9, isShow: 1 },
      { id: 34, brandName: '隐藏品牌', pid: 0, storeId: 0, isShow: 0 },
      { id: 35, brandName: '删除品牌', pid: 0, storeId: 0, isShow: 1, isDel: 1 },
      { id: 40, brandName: '原品牌', pid: 0, storeId: 0, isShow: 1 },
    ]);
    await f.db.update(storeProduct).set({ brandId: 40, brandCom: '40' }).where(eq(storeProduct.id, 70));
    await f.db.insert(storeProductRelation).values([
      { id: 900, productId: 70, type: 2, relationId: 40, relationPid: 0, status: 1 },
      { id: 901, productId: 70, type: 3, relationId: 90, relationPid: 0, status: 1 },
      { id: 902, productId: 70, type: 5, relationId: 91, relationPid: 0, status: 0 },
    ]);
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_relation','id'),902,true)");
  }
  const unownedBrandRelations = () => f.db.execute(sql`SELECT id,xmin::text AS version,to_jsonb(r) AS data
    FROM store_product_relation r WHERE product_id=70 AND type NOT IN(1,2) ORDER BY id`);

  it('commits a full platform brand path and exact type2 rows with its replay while preserving historical relations and consumed stock', async () => {
    const receipt = await confirm(), purchased = await buy(f.db, receipt);
    expect(purchased.status, purchased.msg).toBe(200);
    await seedBrands(); const protectedRows = await unownedBrandRelations(), before = await state();
    expect(before.products[0]).toMatchObject({ stock: 6, sales: 2 });
    const body = { ...productBody, brand_id: ['30', '31'] }, first = await request(app(f.db), '/outapi/product/70', body);
    expect(first.status, first.msg).toBe(200); expect(first.data.stock_preserved).toBe(true);
    const after = await state(); expect(after.products.find(row => row.id === 70)).toMatchObject({ brandId: 31, brandCom: '30,31', stock: before.products[0].stock, sales: before.products[0].sales });
    expect(after.skus.map(row => [row.id, row.unique, row.stock, row.sumStock, row.sales])).toEqual(before.skus.map(row => [row.id, row.unique, row.stock, row.sumStock, row.sales]));
    expect(after.orders).toEqual(before.orders); expect(after.bills).toEqual(before.bills);
    expect(after.relations.filter(row => row.productId === 70 && row.type === 2)).toMatchObject([
      { relationId: 30, relationPid: 0, status: 1 }, { relationId: 31, relationPid: 0, status: 1 },
    ]);
    expect(await unownedBrandRelations()).toEqual(protectedRows); expect(after.replays).toHaveLength(1);
    await f.db.update(storeBrand).set({ isShow: 0 }).where(eq(storeBrand.id, 31));
    const changedCatalog = await state(), replay = await request(app(f.db), '/outapi/product/70', body);
    expect(replay.status, replay.msg).toBe(200); expect(replay.data.idempotent).toBe(true); expect(await state()).toEqual(changedCatalog);
  });

  it('creates one branded product and one receipt for two concurrent same-key authors', async () => {
    await seedBrands(); await f.exec("SELECT setval(pg_get_serial_sequence('store_product','id'),70,true); SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),1,true)");
    const body = { ...productBody, brand_id: [30, 31] };
    await peers(async ([_holder, first, second]) => {
      const results = await Promise.all([request(app(first.db), '/outapi/product', body, 'POST'), request(app(second.db), '/outapi/product', body, 'POST')]);
      for (const result of results) expect(result.status, result.msg).toBe(200);
      expect(results.filter(row => row.data.idempotent)).toHaveLength(1);
      expect(results[0].data.id).toBe(results[1].data.id);
      const id = results[0].data.id;
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, id)))[0]).toMatchObject({ type: 0, relationId: 0, brandId: 31, brandCom: '30,31' });
      expect((await f.db.select().from(storeProductRelation)).filter(row => row.productId === id && row.type === 2).map(row => row.relationId)).toEqual([30, 31]);
      expect(await f.db.select().from(outProductWriteReplay)).toHaveLength(1);
    });
  }, 20_000);

  it('clears branding only with an explicit new intent and refuses borrowing the original selected-path replay key', async () => {
    await seedBrands(); const protectedRows = await unownedBrandRelations();
    expect((await request(app(f.db), '/outapi/product/70', { ...productBody, brand_id: [30, 31] })).status).toBe(200);
    const before = await state(), conflict = await request(app(f.db), '/outapi/product/70', { ...productBody, brand_id: [] });
    expect(conflict.status).not.toBe(200); expect(await state()).toEqual(before);
    const cleared = await request(app(f.db), '/outapi/product/70', { ...productBody, brand_id: [] }, 'PUT', crypto.randomUUID());
    expect(cleared.status, cleared.msg).toBe(200);
    expect((await state()).products.find(row => row.id === 70)).toMatchObject({ brandId: 0, brandCom: '' });
    expect((await state()).relations.filter(row => row.productId === 70 && row.type === 2)).toEqual([]);
    expect(await unownedBrandRelations()).toEqual(protectedRows);
  });

  it('omitted branding preserves even unresolved old metadata without consulting the brand catalog', async () => {
    await seedBrands(); await f.db.update(storeProduct).set({ brandId: 999, brandCom: 'unresolved-legacy-brand' }).where(eq(storeProduct.id, 70));
    const priorRelations = await f.db.execute(sql`SELECT id,xmin::text AS version,to_jsonb(r) AS data FROM store_product_relation r WHERE product_id=70 AND type=2 ORDER BY id`);
    await f.exec('ALTER TABLE store_brand RENAME TO hidden_out_brand_catalog');
    const result = await request(app(f.db), '/outapi/product/70', productBody);
    expect(result.status, result.msg).toBe(200);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0]).toMatchObject({ brandId: 999, brandCom: 'unresolved-legacy-brand' });
    expect(await f.db.execute(sql`SELECT id,xmin::text AS version,to_jsonb(r) AS data FROM store_product_relation r WHERE product_id=70 AND type=2 ORDER BY id`)).toEqual(priorRelations);
  });

  it.each([{ brand_id: [31] }, { brand_id: [31, 30] }, { brand_id: [30, 32, 31] },
    { brand_id: [33] }, { brand_id: [34] }, { brand_id: [35] }, { brand_id: [999] }])('rejects a missing, crossed, hidden, deleted or non-root platform brand path $brand_id before receipt or business mutation', async ({ brand_id }) => {
    await seedBrands(); const before = await state(), result = await request(app(f.db), '/outapi/product/70', { ...productBody, brand_id });
    expect(result.status).not.toBe(200); expect(result.msg).toContain('品牌路径'); expect(await state()).toEqual(before);
  });

  it('refuses branding a Supplier-owned product through the platform Out writer without changing any row or receipt', async () => {
    await seedBrands(); await f.db.update(storeProduct).set({ type: 2, relationId: 44 }).where(eq(storeProduct.id, 70));
    const before = await state(), result = await request(app(f.db), '/outapi/product/70', { ...productBody, brand_id: [30, 31] });
    expect(result.status).not.toBe(200); expect(result.msg).toContain('不属于平台'); expect(await state()).toEqual(before);
  });

  it('uses the existing App privilege plan on a genuine restricted LOGIN for branding while brand catalog mutation remains denied', async () => {
    await seedBrands(); if (!owned.withRuntimeRole) throw Error('Native restricted LOGIN required');
    await owned.withRuntimeRole(async runtime => {
      const plan = runtimeBusinessPrivilegePlan('app'), quote = (name: string) => {
        if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw Error('Invalid owned grant identifier'); return `"${name}"`;
      };
      const tables = await f.db.execute<{ name: string }>(sql`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname`);
      for (const { name } of tables) {
        const rights = plan.tables[name]; if (!rights) continue;
        await f.exec(`GRANT ${rights.join(',')} ON public.${quote(name)} TO ${quote(runtime.role)}`);
        const columns = plan.updateColumns[name];
        if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(quote).join(',')}) ON public.${quote(name)} TO ${quote(runtime.role)}`);
      }
      const sequences = await f.db.execute<{ table_name: string; sequence_name: string | null }>(sql`SELECT c.relname AS table_name,
        pg_get_serial_sequence('public.'||quote_ident(c.relname),a.attname) AS sequence_name
        FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'`);
      for (const row of sequences) if (row.sequence_name && plan.tables[row.table_name]?.includes('INSERT')) {
        const parts = row.sequence_name.split('.'); if (parts.length !== 2 || parts[0] !== 'public') throw Error('Unexpected owned sequence');
        await f.exec(`GRANT USAGE ON SEQUENCE public.${quote(parts[1])} TO ${quote(runtime.role)}`);
      }
      const [identity] = await runtime.db.execute(sql`SELECT current_user AS role,session_user AS session,
        (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated,
        has_column_privilege(current_user,'public.store_brand','id','UPDATE') AS can_lock,
        has_column_privilege(current_user,'public.store_brand','is_show','UPDATE') AS can_mutate`);
      expect(identity).toEqual({ role: runtime.role, session: runtime.role, elevated: false, can_lock: true, can_mutate: false });
      const ordinary = await request(app(runtime.db), '/outapi/product/70', productBody, 'PUT', crypto.randomUUID());
      expect(ordinary.status, ordinary.msg).toBe(200);
      const branded = await request(app(runtime.db), '/outapi/product/70', { ...productBody, brand_id: [30, 31] });
      expect(branded.status, branded.msg).toBe(200);
      const read = await request(app(runtime.db), '/outapi/product/70', undefined, 'GET');
      expect(read.status, read.msg).toBe(200); expect(read.data).toMatchObject({ brand_id: [30, 31], brand_selection: { consistent: true, available: true } });
      await expect(runtime.exec('UPDATE store_brand SET is_show=0 WHERE id=31')).rejects.toMatchObject({ code: '42501' });
    });
  }, 30_000);

  it('refuses a busy later brand row without keeping earlier brand/SKU/replay locks and permits the uncommitted key after release', async () => {
    await seedBrands(); const before = await state(), body = { ...productBody, brand_id: [30, 31] };
    await peers(async ([holder, editor, probe]) => {
      await holder.exec('BEGIN; SELECT id FROM store_brand WHERE id=31 FOR UPDATE');
      try {
        const result = await request(app(editor.db), '/outapi/product/70', body);
        expect(result.status).not.toBe(200); expect(result.msg).toContain('正在变化'); expect(await state()).toEqual(before);
        await probe.exec('BEGIN; SELECT id FROM store_brand WHERE id=30 FOR UPDATE NOWAIT; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE NOWAIT');
        const [locks] = await probe.db.execute(sql`SELECT pg_try_advisory_xact_lock(731602,0) AS sku,pg_try_advisory_xact_lock(744220001,7) AS replay`);
        expect(locks).toEqual({ sku: true, replay: true }); await probe.exec('COMMIT');
      } finally { await holder.exec('ROLLBACK'); }
    });
    expect((await request(app(f.db), '/outapi/product/70', body)).status).toBe(200);
  }, 20_000);

  it('pins the selected brand rows throughout a real blocked product write', async () => {
    await seedBrands();
    await f.exec("CREATE FUNCTION test_out_brand_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=70 THEN PERFORM pg_advisory_xact_lock(744220090,1); END IF; RETURN NEW; END $$; CREATE TRIGGER test_out_brand_gate BEFORE UPDATE ON store_product FOR EACH ROW EXECUTE FUNCTION test_out_brand_gate()");
    await peers(async ([holder, editor, probe]) => {
      await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(744220090,1)');
      const pending = request(app(editor.db), '/outapi/product/70', { ...productBody, brand_id: [30, 31] });
      try {
        await waitForFinanceBlock(f.db, editor.pid, holder.pid);
        await probe.exec('BEGIN');
        await expect(probe.exec('SELECT id FROM store_brand WHERE id=31 FOR UPDATE NOWAIT')).rejects.toMatchObject({ code: '55P03' });
        await probe.exec('ROLLBACK');
      } finally { await holder.exec('COMMIT'); }
      const result = await pending; expect(result.status, result.msg).toBe(200);
    });
  }, 20_000);

  it('a final replay failure rolls back the already-authored brand scalars and exact relationship replacement', async () => {
    await seedBrands(); const before = await state(), protectedRows = await unownedBrandRelations();
    await f.exec("CREATE FUNCTION test_out_brand_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated branded receipt failure'; END $$; CREATE TRIGGER test_out_brand_receipt_failure BEFORE INSERT ON out_product_write_replay FOR EACH ROW EXECUTE FUNCTION test_out_brand_receipt_failure()");
    const result = await request(app(f.db), '/outapi/product/70', { ...productBody, brand_id: [30, 31] });
    expect(result.status).not.toBe(200); expect(await state()).toEqual(before); expect(await unownedBrandRelations()).toEqual(protectedRows);
  });

  it('rejects a brand trigger rewriting an unrelated row to the same values and rolls everything back', async () => {
    await seedBrands(); const before = await state(), protectedRows = await unownedBrandRelations();
    await f.exec("CREATE FUNCTION test_out_brand_interference() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE store_product_relation SET status=status WHERE id=901; RETURN NEW; END $$; CREATE TRIGGER test_out_brand_interference AFTER INSERT ON store_product_relation FOR EACH ROW WHEN(NEW.type=2) EXECUTE FUNCTION test_out_brand_interference()");
    const result = await request(app(f.db), '/outapi/product/70', { ...productBody, brand_id: [30, 31] });
    expect(result.status).not.toBe(200); expect(result.msg).toContain('历史关联已变化');
    expect(await state()).toEqual(before); expect(await unownedBrandRelations()).toEqual(protectedRows);
  });

  it('reads the stored brand path and availability without repairing malformed or newly unavailable history', async () => {
    await seedBrands(); expect((await request(app(f.db), '/outapi/product/70', { ...productBody, brand_id: [30, 31] })).status).toBe(200);
    let before = await state(), read = await request(app(f.db), '/outapi/product/70', undefined, 'GET');
    expect(read.status, read.msg).toBe(200); expect(read.data).toMatchObject({ brand_id: [30, 31], brand_selection: { consistent: true, available: true } });
    expect(await state()).toEqual(before);
    await f.db.update(storeBrand).set({ isShow: 0 }).where(eq(storeBrand.id, 31)); before = await state();
    read = await request(app(f.db), '/outapi/product/70', undefined, 'GET');
    expect(read.data).toMatchObject({ brand_id: [30, 31], brand_selection: { consistent: true, available: false } }); expect(await state()).toEqual(before);
    await f.db.update(storeProduct).set({ brandCom: '030,31' }).where(eq(storeProduct.id, 70)); before = await state();
    read = await request(app(f.db), '/outapi/product/70', undefined, 'GET');
    expect(read.data).toMatchObject({ brand_com: '030,31', brand_id: [], brand_selection: { brand_id: 31, brand_com: '030,31', consistent: false, available: false } });
    expect(await state()).toEqual(before);
  });

  it('reads brand scalars and relationship rows from one real repeatable-read snapshot across a concurrent replacement', async () => {
    await seedBrands(); expect((await request(app(f.db), '/outapi/product/70', { ...productBody, brand_id: [30, 31] })).status).toBe(200);
    await peers(async ([holder, reader, _other]) => {
      await holder.exec('BEGIN; LOCK TABLE store_product_relation IN ACCESS EXCLUSIVE MODE');
      const pending = request(app(reader.db), '/outapi/product/70', undefined, 'GET');
      try {
        await waitForFinanceBlock(f.db, reader.pid, holder.pid);
        await holder.exec("UPDATE store_product SET brand_id=32,brand_com='30,32' WHERE id=70; DELETE FROM store_product_relation WHERE product_id=70 AND type=2; INSERT INTO store_product_relation(product_id,type,relation_id,relation_pid,status) VALUES(70,2,30,0,1),(70,2,32,0,1)");
      } finally { await holder.exec('COMMIT'); }
      const old = await pending; expect(old.status, old.msg).toBe(200);
      expect(old.data).toMatchObject({ brand_id: [30, 31], brand_selection: { consistent: true, available: true } });
      const current = await request(app(reader.db), '/outapi/product/70', undefined, 'GET');
      expect(current.data).toMatchObject({ brand_id: [30, 32], brand_selection: { consistent: true, available: true } });
    });
  }, 20_000);

  async function seedEnsures() {
    await seedBrands();
    await f.db.insert(storeProductEnsure).values([
      { id: 91, type: 0, relationId: 0, name: '既有停用保障', status: 0 },
      { id: 92, type: 0, relationId: 0, name: '平台保障', status: 1 },
      { id: 93, type: 2, relationId: 44, name: '供应商保障', status: 1 },
      { id: 94, type: 0, relationId: 44, name: '错误平台归属', status: 1 },
      { id: 95, type: 0, relationId: 0, name: '未绑定的停用保障', status: 0 },
      { id: 96, type: 2, relationId: 0, name: '错误供应商归属', status: 1 },
      { id: 97, type: 0, relationId: 0, name: '第二平台保障', status: 1 },
    ]);
    await f.db.update(storeProduct).set({ ensureId: '91' }).where(eq(storeProduct.id, 70));
  }
  const otherEnsureRelations = (combined = false) => f.db.execute(sql`SELECT id,xmin::text AS version,to_jsonb(r) AS data
    FROM store_product_relation r WHERE product_id=70 AND type NOT IN(${sql.join((combined ? [1, 2, 5] : [1, 5]).map(n => sql`${n}`), sql`,`)}) ORDER BY id`);

  it('writes brand and ensure selections atomically after real checkout while preserving SKU sales and every unowned relation', async () => {
    const receipt = await confirm(), purchased = await buy(f.db, receipt);
    expect(purchased.status, purchased.msg).toBe(200);
    await seedEnsures(); const before = await state(), protectedRows = await otherEnsureRelations(true);
    const body = { ...productBody, brand_id: [30, 31], ensure_id: ['91', '92'] };
    const result = await request(app(f.db), '/outapi/product/70', body);
    expect(result.status, result.msg).toBe(200); expect(result.data.stock_preserved).toBe(true);
    const after = await state();
    expect(after.products[0]).toMatchObject({ brandId: 31, brandCom: '30,31', ensureId: '91,92', stock: 6, sales: 2 });
    expect(after.skus.map(row => [row.id, row.unique, row.stock, row.sumStock, row.sales])).toEqual(before.skus.map(row => [row.id, row.unique, row.stock, row.sumStock, row.sales]));
    expect(after.orders).toEqual(before.orders); expect(after.bills).toEqual(before.bills);
    expect(after.relations.filter(row => row.type === 2).map(row => row.relationId)).toEqual([30, 31]);
    expect(after.relations.filter(row => row.type === 5)).toMatchObject([{ relationId: 91, relationPid: 0, status: 1 }, { relationId: 92, relationPid: 0, status: 1 }]);
    expect(await otherEnsureRelations(true)).toEqual(protectedRows); expect(after.replays).toHaveLength(1);
    await f.db.update(storeBrand).set({ isShow: 0 }).where(eq(storeBrand.id, 31));
    await f.db.update(storeProductEnsure).set({ status: 0 }).where(eq(storeProductEnsure.id, 92));
    const changed = await state(), replay = await request(app(f.db), '/outapi/product/70', body);
    expect(replay.status, replay.msg).toBe(200); expect(replay.data.idempotent).toBe(true); expect(await state()).toEqual(changed);
  }, 20_000);

  it('clears only explicitly owned ensures with a fresh key and preserves omitted brand rows and scalars', async () => {
    await seedEnsures(); const protectedRows = await otherEnsureRelations();
    expect((await request(app(f.db), '/outapi/product/70', { ...productBody, ensure_id: [92] })).status).toBe(200);
    const before = await state(), conflict = await request(app(f.db), '/outapi/product/70', { ...productBody, ensure_id: [] });
    expect(conflict.status).not.toBe(200); expect(await state()).toEqual(before);
    const result = await request(app(f.db), '/outapi/product/70', { ...productBody, ensure_id: [] }, 'PUT', crypto.randomUUID());
    expect(result.status, result.msg).toBe(200);
    expect((await state()).products[0]).toMatchObject({ ensureId: '', brandId: 40, brandCom: '40' });
    expect((await state()).relations.filter(row => row.type === 5)).toEqual([]);
    expect(await otherEnsureRelations()).toEqual(protectedRows);
  });

  it('omitted ensures preserve unresolved legacy scalars and physical rows without consulting the ensure catalog', async () => {
    await seedEnsures(); await f.db.update(storeProduct).set({ ensureId: 'unresolved-legacy-ensure' }).where(eq(storeProduct.id, 70));
    const relations = await f.db.execute(sql`SELECT id,xmin::text AS version,to_jsonb(r) AS data FROM store_product_relation r WHERE type=5 ORDER BY id`);
    await f.exec('ALTER TABLE store_product_ensure RENAME TO hidden_out_ensure_catalog');
    const result = await request(app(f.db), '/outapi/product/70', { ...productBody, brand_id: [30, 31] });
    expect(result.status, result.msg).toBe(200);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0]).toMatchObject({ ensureId: 'unresolved-legacy-ensure', brandId: 31 });
    expect(await f.db.execute(sql`SELECT id,xmin::text AS version,to_jsonb(r) AS data FROM store_product_relation r WHERE type=5 ORDER BY id`)).toEqual(relations);
  });

  it.each([{ ensure_id: [93] }, { ensure_id: [94] }, { ensure_id: [95] }, { ensure_id: [96] }, { ensure_id: [999] }])(
    'rejects unavailable or foreign ensure selection $ensure_id without business changes or a receipt', async ({ ensure_id }) => {
      await seedEnsures(); const before = await state();
      const result = await request(app(f.db), '/outapi/product/70', { ...productBody, ensure_id });
      expect(result.status).not.toBe(200); expect(result.msg).toContain('保障服务'); expect(await state()).toEqual(before);
    });

  it('does not treat a malformed stored ensure selection as authority to retain a disabled service', async () => {
    await seedEnsures(); await f.db.update(storeProduct).set({ ensureId: '95' }).where(eq(storeProduct.id, 70));
    const before = await state(), result = await request(app(f.db), '/outapi/product/70', { ...productBody, ensure_id: [95] });
    expect(result.status).not.toBe(200); expect(await state()).toEqual(before);
    const repair = await request(app(f.db), '/outapi/product/70', { ...productBody, ensure_id: [92] });
    expect(repair.status, repair.msg).toBe(200);
    expect((await state()).products[0].ensureId).toBe('92');
  });

  it('refuses an ensure edit on a Supplier-owned product', async () => {
    await seedEnsures(); await f.db.update(storeProduct).set({ type: 2, relationId: 44 }).where(eq(storeProduct.id, 70));
    const before = await state(), result = await request(app(f.db), '/outapi/product/70', { ...productBody, ensure_id: [92] });
    expect(result.status).not.toBe(200); expect(result.msg).toContain('不属于平台'); expect(await state()).toEqual(before);
  });

  it('creates one combined brand and ensure product for two concurrent same-key requests', async () => {
    await seedEnsures(); await f.exec("SELECT setval(pg_get_serial_sequence('store_product','id'),70,true); SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),1,true)");
    const body = { ...productBody, brand_id: [30, 31], ensure_id: [92] };
    await peers(async ([_holder, first, second]) => {
      const results = await Promise.all([request(app(first.db), '/outapi/product', body, 'POST'), request(app(second.db), '/outapi/product', body, 'POST')]);
      for (const result of results) expect(result.status, result.msg).toBe(200);
      expect(results.filter(row => row.data.idempotent)).toHaveLength(1); expect(results[0].data.id).toBe(results[1].data.id);
      const id = results[0].data.id;
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, id)))[0]).toMatchObject({ brandId: 31, brandCom: '30,31', ensureId: '92' });
      expect((await f.db.select().from(storeProductRelation)).filter(row => row.productId === id && row.type === 5)).toMatchObject([{ relationId: 92, status: 1 }]);
      expect(await f.db.select().from(outProductWriteReplay)).toHaveLength(1);
    });
  }, 20_000);

  it('rolls back earlier ensure SKU and replay locks on a busy later catalog row and permits the uncommitted key after release', async () => {
    await seedEnsures(); const before = await state(), body = { ...productBody, ensure_id: [92, 97] };
    await peers(async ([holder, editor, probe]) => {
      await holder.exec('BEGIN; SELECT id FROM store_product_ensure WHERE id=97 FOR UPDATE');
      try {
        const result = await request(app(editor.db), '/outapi/product/70', body);
        expect(result.status).not.toBe(200); expect(result.msg).toContain('正在变化'); expect(await state()).toEqual(before);
        await probe.exec('BEGIN; SELECT id FROM store_product_ensure WHERE id=92 FOR UPDATE NOWAIT; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE NOWAIT; ROLLBACK');
      } finally { await holder.exec('COMMIT'); }
      const retry = await request(app(editor.db), '/outapi/product/70', body);
      expect(retry.status, retry.msg).toBe(200); expect(retry.data.idempotent).toBe(false);
    });
  }, 20_000);

  it('pins admitted ensure rows throughout the actual ordinary product write', async () => {
    await seedEnsures();
    await f.exec("CREATE FUNCTION test_out_ensure_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=70 THEN PERFORM pg_advisory_xact_lock(744220091,1); END IF; RETURN NEW; END $$; CREATE TRIGGER test_out_ensure_gate BEFORE UPDATE ON store_product FOR EACH ROW EXECUTE FUNCTION test_out_ensure_gate()");
    await peers(async ([holder, editor, probe]) => {
      await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(744220091,1)');
      const pending = request(app(editor.db), '/outapi/product/70', { ...productBody, ensure_id: [92] });
      try {
        await waitForFinanceBlock(f.db, editor.pid, holder.pid); await probe.exec('BEGIN');
        await expect(probe.exec('SELECT id FROM store_product_ensure WHERE id=92 FOR UPDATE NOWAIT')).rejects.toMatchObject({ code: '55P03' });
        await probe.exec('ROLLBACK');
      } finally { await holder.exec('COMMIT'); }
      const result = await pending; expect(result.status, result.msg).toBe(200);
    });
  }, 20_000);

  it.each([{ target: 'relation' }, { target: 'catalog' }, { target: 'receipt-failure' }])(
    'rolls back the complete combined author when the final receipt interferes with $target', async ({ target }) => {
      await seedEnsures(); const before = await state(), protectedRows = await otherEnsureRelations(true);
      const operation = target === 'relation' ? 'UPDATE store_product_relation SET status=status WHERE id=901;'
        : target === 'catalog' ? 'UPDATE store_product_ensure SET status=0 WHERE id=92;'
        : "RAISE EXCEPTION 'isolated combined receipt failure';";
      await f.exec(`CREATE FUNCTION test_out_ensure_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${operation} RETURN NEW; END $$; CREATE TRIGGER test_out_ensure_receipt AFTER INSERT ON out_product_write_replay FOR EACH ROW EXECUTE FUNCTION test_out_ensure_receipt()`);
      const result = await request(app(f.db), '/outapi/product/70', { ...productBody, brand_id: [30, 31], ensure_id: [92] });
      expect(result.status).not.toBe(200); expect(await state()).toEqual(before); expect(await otherEnsureRelations(true)).toEqual(protectedRows);
    });

  it.each([{ combined: false }, { combined: true }])('rejects an ensure trigger rewriting omitted or already-authored brand columns (combined=$combined)', async ({ combined }) => {
    await seedEnsures(); const before = await state();
    await f.exec("CREATE FUNCTION test_out_ensure_brand_interference() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE store_product SET brand_id=999 WHERE id=70; RETURN NEW; END $$; CREATE TRIGGER test_out_ensure_brand_interference AFTER INSERT ON store_product_relation FOR EACH ROW WHEN(NEW.type=5) EXECUTE FUNCTION test_out_ensure_brand_interference()");
    const result = await request(app(f.db), '/outapi/product/70', { ...productBody, ensure_id: [92], ...(combined ? { brand_id: [30, 31] } : {}) });
    expect(result.status).not.toBe(200); expect(await state()).toEqual(before);
  });

  it('reads stored ensure consistency separately from availability and retains legitimate Out show states without a write', async () => {
    await seedEnsures(); expect((await request(app(f.db), '/outapi/product/70', { ...productBody, ensure_id: [92] })).status).toBe(200);
    expect((await request(app(f.db), '/outapi/product/set_show/70/0', undefined, 'PUT', crypto.randomUUID())).status).toBe(200);
    const before = await state(), first = await request(app(f.db), '/outapi/product/70', undefined, 'GET');
    expect(first.status, first.msg).toBe(200); expect(first.data).toMatchObject({ ensure_id: [92], ensure_selection: { ensure_id: '92', consistent: true, available: true, retained_ids: [], truncated: false } });
    expect(await state()).toEqual(before);
    await f.db.update(storeProductEnsure).set({ status: 0 }).where(eq(storeProductEnsure.id, 92));
    const hidden = await state(), next = await request(app(f.db), '/outapi/product/70', undefined, 'GET');
    expect(next.data).toMatchObject({ ensure_id: [92], ensure_selection: { consistent: true, available: false, retained_ids: [92] } }); expect(await state()).toEqual(hidden);
    await f.db.update(storeProduct).set({ ensureId: 'invalid-legacy-ensure' }).where(eq(storeProduct.id, 70));
    const malformed = await state(), bad = await request(app(f.db), '/outapi/product/70', undefined, 'GET');
    expect(bad.data).toMatchObject({ ensure_id: [], ensure_selection: { ensure_id: 'invalid-legacy-ensure', consistent: false, available: false, retained_ids: [] } }); expect(await state()).toEqual(malformed);
  });

  it('uses only the existing App privileges for actual restricted-LOGIN combined brand and ensure writes', async () => {
    await seedEnsures(); if (!owned.withRuntimeRole) throw Error('Native restricted LOGIN required');
    await owned.withRuntimeRole(async runtime => {
      const plan = runtimeBusinessPrivilegePlan('app'), quote = (name: string) => {
        if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw Error('Invalid owned grant identifier'); return `"${name}"`;
      };
      const tables = await f.db.execute<{ name: string }>(sql`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname`);
      for (const { name } of tables) {
        const rights = plan.tables[name]; if (!rights) continue;
        await f.exec(`GRANT ${rights.join(',')} ON public.${quote(name)} TO ${quote(runtime.role)}`);
        const columns = plan.updateColumns[name];
        if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(quote).join(',')}) ON public.${quote(name)} TO ${quote(runtime.role)}`);
      }
      const sequences = await f.db.execute<{ table_name: string; sequence_name: string | null }>(sql`SELECT c.relname AS table_name,
        pg_get_serial_sequence('public.'||quote_ident(c.relname),a.attname) AS sequence_name
        FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'`);
      for (const row of sequences) if (row.sequence_name && plan.tables[row.table_name]?.includes('INSERT')) {
        const parts = row.sequence_name.split('.'); if (parts.length !== 2 || parts[0] !== 'public') throw Error('Unexpected owned sequence');
        await f.exec(`GRANT USAGE ON SEQUENCE public.${quote(parts[1])} TO ${quote(runtime.role)}`);
      }
      const [identity] = await runtime.db.execute(sql`SELECT current_user AS role,session_user AS session,
        (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated,
        has_column_privilege(current_user,'public.store_product_ensure','id','UPDATE') AS can_lock,
        has_column_privilege(current_user,'public.store_product_ensure','status','UPDATE') AS can_mutate`);
      expect(identity).toEqual({ role: runtime.role, session: runtime.role, elevated: false, can_lock: true, can_mutate: false });
      const result = await request(app(runtime.db), '/outapi/product/70', { ...productBody, brand_id: [30, 31], ensure_id: [91, 92] });
      expect(result.status, result.msg).toBe(200);
      const read = await request(app(runtime.db), '/outapi/product/70', undefined, 'GET');
      expect(read.status, read.msg).toBe(200); expect(read.data).toMatchObject({ ensure_id: [91, 92], ensure_selection: { consistent: true, retained_ids: [91] } });
      await expect(runtime.exec('UPDATE store_product_ensure SET status=0 WHERE id=92')).rejects.toMatchObject({ code: '42501' });
    });
  }, 30_000);

  it('reads ensure scalars and type5 rows from the same snapshot across a real concurrent replacement', async () => {
    await seedEnsures();
    await peers(async ([holder, reader]) => {
      await holder.exec('BEGIN; LOCK TABLE store_product_relation IN ACCESS EXCLUSIVE MODE');
      const pending = request(app(reader.db), '/outapi/product/70', undefined, 'GET');
      try {
        await waitForFinanceBlock(f.db, reader.pid, holder.pid);
        await holder.exec("UPDATE store_product SET ensure_id='92' WHERE id=70; DELETE FROM store_product_relation WHERE product_id=70 AND type=5; INSERT INTO store_product_relation(product_id,relation_id,relation_pid,type,status) VALUES(70,92,0,5,1)");
      } finally { await holder.exec('COMMIT'); }
      const old = await pending; expect(old.status, old.msg).toBe(200);
      expect(old.data).toMatchObject({ ensure_id: [91], ensure_selection: { consistent: true, available: false, retained_ids: [91] } });
      const current = await request(app(reader.db), '/outapi/product/70', undefined, 'GET');
      expect(current.data).toMatchObject({ ensure_id: [92], ensure_selection: { consistent: true, available: true, retained_ids: [] } });
    });
  }, 20_000);

  it('rejects a successful receipt trigger rewriting a protected relationship after the brand author and rolls back the receipt too', async () => {
    await seedBrands(); const before = await state(), protectedRows = await unownedBrandRelations();
    await f.exec("CREATE FUNCTION test_out_brand_receipt_interference() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE store_product_relation SET status=status WHERE id=901; RETURN NEW; END $$; CREATE TRIGGER test_out_brand_receipt_interference AFTER INSERT ON out_product_write_replay FOR EACH ROW EXECUTE FUNCTION test_out_brand_receipt_interference()");
    const result = await request(app(f.db), '/outapi/product/70', { ...productBody, brand_id: [30, 31] });
    expect(result.status).not.toBe(200); expect(result.msg).toContain('历史关联已变化');
    expect(await state()).toEqual(before); expect(await unownedBrandRelations()).toEqual(protectedRows);
  });

  const couponState = async () => ({ business: await state(),
    coupons: await f.db.select().from(storeProductCoupon).orderBy(storeProductCoupon.id),
    issues: await f.db.select().from(storeCouponIssue).orderBy(storeCouponIssue.id) });
  const seedCouponIssues = async () => {
    await f.db.insert(storeCouponIssue).values([
      { id: 800, title: '第一发行券', couponTitle: '赠券一', status: 1 },
      { id: 801, title: '停用发行券', status: 0 },
      { id: 802, title: '删除发行券', isDel: 1 },
    ]);
    await f.db.insert(storeProductCoupon).values({ productId: 70, issueCouponId: 801, title: '原关联' });
  };

  it('Out coupon replacement preserves stock, reads issuance titles, replays before admission, and clears explicitly', async () => {
    await seedCouponIssues();
    const before = await couponState();
    const selected = { ...productBody, coupon_ids: [801, 800, 800] };
    const saved = await request(app(f.db), '/outapi/product/70', selected);
    expect(saved.status, saved.msg).toBe(200); expect(saved.data.stock_preserved).toBe(true);
    const after = await couponState();
    expect(after.coupons.map(row => [row.issueCouponId, row.title])).toEqual([[800, '赠券一'], [801, '停用发行券']]);
    expect(after.business.skus.map(row => [row.id, row.unique, row.stock, row.sumStock, row.sales]))
      .toEqual(before.business.skus.map(row => [row.id, row.unique, row.stock, row.sumStock, row.sales]));
    const read = await request(app(f.db), '/outapi/product/70', undefined, 'GET');
    expect(read.status, read.msg).toBe(200);
    expect(read.data).toMatchObject({ productInfo: { coupons: [{ id: 800, title: '第一发行券' }, { id: 801, title: '停用发行券' }] } });
    await f.db.update(storeCouponIssue).set({ isDel: 1 }).where(eq(storeCouponIssue.id, 800));
    const changed = await couponState();
    const replay = await request(app(f.db), '/outapi/product/70', selected);
    expect(replay.status, replay.msg).toBe(200); expect(replay.data.idempotent).toBe(true); expect(await couponState()).toEqual(changed);
    const fresh = await request(app(f.db), '/outapi/product/70', selected, 'PUT', crypto.randomUUID());
    expect(fresh.status).not.toBe(200); expect(await couponState()).toEqual(changed);
    const clear = await request(app(f.db), '/outapi/product/70', { ...productBody, coupon_ids: [] }, 'PUT', crypto.randomUUID());
    expect(clear.status, clear.msg).toBe(200); expect((await couponState()).coupons).toEqual([]);
  });

  it('creates an Out product and coupon links in the same idempotent receipt', async () => {
    await seedCouponIssues();
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product','id'),70,true); SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),1,true)");
    const body = { ...productBody, coupon_ids: [800], attrs: productBody.attrs.map(row => ({ ...row, unique: 'cpnew001', bar_code: 'COUPON-NEW' })) };
    const saved = await request(app(f.db), '/outapi/product', body, 'POST');
    expect(saved.status, saved.msg).toBe(200);
    expect((await f.db.select().from(storeProductCoupon).where(eq(storeProductCoupon.productId, saved.data.id)))
      .map(row => [row.issueCouponId, row.title])).toEqual([[800, '赠券一']]);
    const before = await couponState();
    const replay = await request(app(f.db), '/outapi/product', body, 'POST');
    expect(replay.status, replay.msg).toBe(200); expect(replay.data).toMatchObject({ id: saved.data.id, idempotent: true });
    expect(await couponState()).toEqual(before);
  });

  it('omitted coupons retain exact legacy rows, differ from explicit-clear receipt, and do not consult issuance catalog', async () => {
    await seedCouponIssues();
    await f.exec('ALTER TABLE store_coupon_issue RENAME TO hidden_out_coupon_issue');
    const before = await f.db.select().from(storeProductCoupon);
    try {
      const saved = await request(app(f.db), '/outapi/product/70', productBody);
      expect(saved.status, saved.msg).toBe(200); expect(await f.db.select().from(storeProductCoupon)).toEqual(before);
      const conflict = await request(app(f.db), '/outapi/product/70', { ...productBody, coupon_ids: [] });
      expect(conflict.status).not.toBe(200); expect(await f.db.select().from(storeProductCoupon)).toEqual(before);
    } finally { await f.exec('ALTER TABLE hidden_out_coupon_issue RENAME TO store_coupon_issue'); }
  });

  it('rejects missing or deleted issues atomically and refuses busy coupon and issue locks without waiting', async () => {
    await seedCouponIssues(); const before = await couponState();
    for (const id of [802, 999]) {
      const result = await request(app(f.db), '/outapi/product/70', { ...productBody, coupon_ids: [id] }, 'PUT', crypto.randomUUID());
      expect(result.status).not.toBe(200); expect(await couponState()).toEqual(before);
    }
    await peers(async ([holder, writer]) => {
      await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731626, 70)');
      const busy = await request(app(writer.db), '/outapi/product/70', { ...productBody, coupon_ids: [800] }, 'PUT', crypto.randomUUID());
      expect(busy.status).not.toBe(200); expect(busy.msg).toContain('正在变化'); await holder.exec('COMMIT');
      await holder.exec('BEGIN; SELECT id FROM store_coupon_issue WHERE id=800 FOR UPDATE');
      const issueBusy = await request(app(writer.db), '/outapi/product/70', { ...productBody, coupon_ids: [800] }, 'PUT', crypto.randomUUID());
      expect(issueBusy.status).not.toBe(200); expect(issueBusy.msg).toContain('正在变化'); await holder.exec('COMMIT');
    });
    expect(await couponState()).toEqual(before);
  }, 20_000);

  it('saves coupon links under the existing restricted App privilege plan', async () => {
    await seedCouponIssues(); if (!owned.withRuntimeRole) throw Error('Native restricted LOGIN required');
    await owned.withRuntimeRole(async runtime => {
      const plan = runtimeBusinessPrivilegePlan('app'), quote = (name: string) => {
        if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw Error('Invalid owned grant identifier'); return `"${name}"`;
      };
      const tables = await f.db.execute<{ name: string }>(sql`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname`);
      for (const { name } of tables) {
        const rights = plan.tables[name]; if (!rights) continue;
        await f.exec(`GRANT ${rights.join(',')} ON public.${quote(name)} TO ${quote(runtime.role)}`);
        const columns = plan.updateColumns[name];
        if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(quote).join(',')}) ON public.${quote(name)} TO ${quote(runtime.role)}`);
      }
      const sequences = await f.db.execute<{ table_name: string; sequence_name: string | null }>(sql`SELECT c.relname AS table_name,
        pg_get_serial_sequence('public.'||quote_ident(c.relname),a.attname) AS sequence_name
        FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'`);
      for (const row of sequences) if (row.sequence_name && plan.tables[row.table_name]?.includes('INSERT')) {
        const parts = row.sequence_name.split('.'); if (parts.length !== 2 || parts[0] !== 'public') throw Error('Unexpected owned sequence');
        await f.exec(`GRANT USAGE ON SEQUENCE public.${quote(parts[1])} TO ${quote(runtime.role)}`);
      }
      const saved = await request(app(runtime.db), '/outapi/product/70', { ...productBody, coupon_ids: [800] });
      expect(saved.status, saved.msg).toBe(200);
      expect((await f.db.select().from(storeProductCoupon).where(eq(storeProductCoupon.productId, 70))).map(row => row.issueCouponId)).toEqual([800]);
    });
  }, 30_000);

  it('rolls back selected and omitted coupon changes caused by deferred receipt triggers', async () => {
    await seedCouponIssues(); const before = await couponState();
    await f.exec("CREATE FUNCTION test_out_coupon_receipt_damage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE store_product_coupon SET title='damaged' WHERE product_id=70; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER test_out_coupon_receipt_damage AFTER INSERT ON out_product_write_replay DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_out_coupon_receipt_damage()");
    for (const value of [productBody, { ...productBody, coupon_ids: [800] }]) {
      const result = await request(app(f.db), '/outapi/product/70', value, 'PUT', crypto.randomUUID());
      expect(result.status).not.toBe(200); expect(result.msg).toContain('优惠券'); expect(await couponState()).toEqual(before);
    }
  });

});
