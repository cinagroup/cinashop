import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { adminProductCreate, adminProductUpdate } from '../src/controllers/api/v1/AdminCrudController';
import { categoryUpdate, categoryDelete, categorySetShow } from '../src/controllers/out/OutApiController';
import { saveProduct as supplierSaveProduct } from '../src/controllers/supplier/SupplierController';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { normalizeProductSkuEditorPayload, replaceProductSkuEditor } from '../src/services/product/ProductSkuEditorService';
import { ValidateException } from '../src/utils/errors';
import { waitForFinanceBlock } from './helpers/financePeers';
import { storeProduct, storeProductCategory, storeProductRelation, storeCouponIssue, storeCouponUser,
  storeOrderCartInfo, storeOrderStatus, systemLog, storeProductAttrValue, shippingTemplatesFree,
  storeProductAttr, storeProductAttrResult, storeProductStockRecord, storeProductDescription } from '../src/models/schema';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('real full-ORM catalog management versus checkout', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let owned: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let beforeSequence: (() => Promise<void>) | undefined;
  const input = { cartIds: [1], addressId: 11, couponId: 41, type: 0 };
  const skuBody = { cate_id: [9], spec_type: 1,
    items: [{ value: '颜色', detail: ['红色'] }, { value: '尺码', detail: ['大号'] }],
    attrs: [{ suk: '红色,大号', detail: { 颜色: '红色', 尺码: '大号' }, unique: 'qared001', price: 10, vip_price: 9, stock: 8 }] };
  const app = (db: DbClient) => {
    const result = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    result.use('*', async (c, next) => {
      c.set('container', createContainerFromDb(db)); c.set('uid', 11); c.set('adminId', 1);
      // Synthetic identities only; real handlers/services/SQL, not formal auth evidence.
      c.set('adminInfo', { id: 1, account: 'isolated-admin', realName: 'isolated', level: 0, roles: '', divisionId: 0 });
      c.set('outInfo', { id: 7, appid: 'isolated-out', title: 'isolated', rules: [] }); await next();
    });
    result.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    result.post('/api/order/create/:key', orderCreate);
    result.post('/admin/product/edit/:id', adminProductUpdate);
    result.post('/admin/product/add', adminProductCreate);
    result.use('/supplier/product/:id', async (c, next) => { c.set('supplierId', 51); c.set('supplierAdminId', 1); await next(); });
    result.post('/supplier/product/:id', supplierSaveProduct);
    result.put('/outapi/category/:id', categoryUpdate);
    result.delete('/outapi/category/:id', categoryDelete);
    result.put('/outapi/category/show/:id/:is_show', categorySetShow);
    return result;
  };
  beforeEach(async () => {
    beforeSequence = undefined;
    f = await createPcCheckoutQuoteFixture([], async () => {
      owned = await sequenceRunnerDatabase();
      try {
        const api = await import('drizzle-kit/api'), models = await import('../src/models/schema');
        await owned.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join('\n'));
        return owned;
      } catch (error) { await owned.close(); throw error; }
    });
    // The reused checkout fixture seeds explicit product/SKU IDs. New-product
    // controls also use their serial defaults, so advance only these owned seeds.
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product','id'),(SELECT max(id) FROM store_product),true); SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),(SELECT max(id) FROM store_product_attr_value),true)");
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.db.update(storeProduct).set({ cateId: '9', specType: 1 }).where(eq(storeProduct.id, 70));
    await f.db.insert(storeProductCategory).values([
      { id: 7, cateName: 'root', isShow: 1 }, { id: 8, cateName: 'branch', pid: 7, path: '7', level: 1, isShow: 1 },
      { id: 9, cateName: 'leaf', pid: 8, path: '7,8', level: 2, isShow: 1 }, { id: 10, cateName: 'other', isShow: 1 },
    ]);
    await f.db.insert(storeProductRelation).values({ productId: 70, relationId: 9, relationPid: 8, type: 1, status: 1 });
    await f.db.insert(storeCouponIssue).values({ id: 1, type: 1, couponType: 1, category_id: '7', legacyCategoryId: 7 });
    await f.db.insert(storeCouponUser).values({ id: 41, uid: 11, issueCouponId: 1, couponPrice: '1.00', useMinPrice: '0.00' });
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'isolated', get: () => ({ fetch: async () => {
      await beforeSequence?.(); return new Response('catalog_management_order');
    } }) } });
  }, 120_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); }, 120_000);
  const request = async (application: ReturnType<typeof app>, path: string, body?: object, method = 'POST') => {
    const response = await application.request(path, { method, headers: { 'content-type': 'application/json', 'x-fixture-user': '11' },
      ...(body ? { body: JSON.stringify(body) } : {}) }, f.env);
    return response.json() as Promise<{ status: number; msg: string; data: { id: number; orderKey: string; quoteToken: string; errorCode?: string; idempotent?: boolean } }>;
  };
  const confirm = async () => { const r = await request(f.app, '/api/order/confirm', input); expect(r.status, r.msg).toBe(200); return r.data; };
  const buy = (db: DbClient, receipt: Awaited<ReturnType<typeof confirm>>) => request(app(db), `/api/order/create/${receipt.orderKey}`, { ...input, quoteToken: receipt.quoteToken });
  const peers = async (run: (a: { db: DbClient; pid: number; exec: (s: string) => Promise<unknown> }, b: { db: DbClient; pid: number; exec: (s: string) => Promise<unknown> }, c: { db: DbClient; pid: number; exec: (s: string) => Promise<unknown> }) => Promise<void>) => {
    const connect = owned.withPeer; if (!connect) throw new Error('Requires independent real PostgreSQL peers');
    await connect(a => connect(b => connect(async c => {
      const [observer] = await f.db.select({ pid: sql<number>`pg_backend_pid()` }).from(sql`(values (1)) as probe(n)`);
      expect(new Set([observer.pid, a.pid, b.pid, c.pid]).size).toBe(4); await run(a, b, c);
    })));
  };
  const state = async () => ({ ...await f.snapshot(), categories: await f.db.select().from(storeProductCategory).orderBy(storeProductCategory.id),
    relations: await f.db.select().from(storeProductRelation).orderBy(storeProductRelation.id),
    coupons: await f.db.select().from(storeCouponUser), details: await f.db.select().from(storeOrderCartInfo),
    statuses: await f.db.select().from(storeOrderStatus), audit: await f.db.select().from(systemLog),
    attrs: await f.db.select().from(storeProductAttr), attrResults: await f.db.select().from(storeProductAttrResult),
    stockRecords: await f.db.select().from(storeProductStockRecord), descriptions: await f.db.select().from(storeProductDescription) });

  it('refuses the SKU editor reverse wait without a database deadlock and preserves the buyer', async () => {
    const receipt = await confirm();
    await peers(async (holder, editor, buyer) => {
      await holder.exec('BEGIN; SELECT id FROM store_product_category WHERE id=9 FOR UPDATE');
      const editing = request(app(editor.db), '/admin/product/edit/70', skuBody);
      await waitForFinanceBlock(f.db, editor.pid, holder.pid);
      const buying = buy(buyer.db, receipt);
      await waitForFinanceBlock(f.db, buyer.pid, editor.pid);
      await holder.exec('COMMIT');
      const e = await editing, b = await buying;
      expect(e.status, e.msg).toBe(400); expect(e.msg).toContain('商品库存正在变化');
      expect(b.status, b.msg).toBe(200);
    });
    const after = await state(); expect(after.orders).toHaveLength(1); expect(after.audit).toEqual([]);
    expect(after.products[0].stock).toBe(6); expect(after.skus[0].stock).toBe(6);
    expect(after.attrs).toEqual([]); expect(after.attrResults).toEqual([]); expect(after.stockRecords).toEqual([]);
    // Explicitly refresh the stock input, not an automatic retry of stale stock=8.
    const refreshed = { ...skuBody, attrs: [{ ...skuBody.attrs[0], stock: 6 }] };
    const retry = await request(app(f.db), '/admin/product/edit/70', refreshed); expect(retry.status, retry.msg).toBe(200);
    expect((await state()).skus[0]).toMatchObject({ stock: 6, sales: 2 });
  }, 20_000);

  it.each(['category', 'equivalent', 'display', 'sku-price'] as const)('checks an actual late product edit (%s)', async operation => {
    const receipt = await confirm(); let edited: Awaited<ReturnType<typeof state>> | undefined;
    beforeSequence = async () => {
      const body = operation === 'category' ? { cate_id: [10] } : operation === 'equivalent' ? { cate_id: [8, 9, 8] }
        : operation === 'display' ? { store_info: 'new display' } : { ...skuBody, attrs: [{ ...skuBody.attrs[0], price: 11 }] };
      const r = await request(app(f.db), '/admin/product/edit/70', body); expect(r.status, r.msg).toBe(200); edited = await state();
    };
    const r = await buy(f.db, receipt); expect(edited).toBeDefined();
    expect(r.status, r.msg).toBe(operation === 'equivalent' || operation === 'display' ? 200 : 400);
    if (r.status === 400) expect(await state()).toEqual(edited);
  });

  it.each(['move', 'display', 'show', 'referenced-delete'] as const)('checks an actual late Out category operation (%s)', async operation => {
    const receipt = await confirm(); let edited: Awaited<ReturnType<typeof state>> | undefined;
    beforeSequence = async () => {
      const r = operation === 'show' ? await request(app(f.db), '/outapi/category/show/8/0', undefined, 'PUT')
        : operation === 'referenced-delete' ? await request(app(f.db), '/outapi/category/9', undefined, 'DELETE')
        : await request(app(f.db), '/outapi/category/8', { cate_name: operation === 'display' ? 'renamed' : 'branch', pid: operation === 'move' ? 10 : 7, is_show: 1 }, 'PUT');
      expect(r.status, r.msg).toBe(operation === 'referenced-delete' ? 400 : 200); edited = await state();
    };
    const r = await buy(f.db, receipt); expect(edited).toBeDefined();
    expect(r.status, r.msg).toBe(operation === 'move' ? 400 : 200);
    if (operation === 'move') { expect(r.data.errorCode).toBe('ORDER_QUOTE_RECONFIRM_REQUIRED'); expect(await state()).toEqual(edited); }
  });

  it('refuses checkout while a real Out tree move holds categories and waits for relation repair', async () => {
    const receipt = await confirm(), before = await state();
    await peers(async (holder, editor, buyer) => {
      await holder.exec('BEGIN; LOCK TABLE store_product_relation IN SHARE MODE');
      const editing = request(app(editor.db), '/outapi/category/8', { cate_name: 'branch', pid: 10, is_show: 1 }, 'PUT');
      await waitForFinanceBlock(f.db, editor.pid, holder.pid);
      const result = await buy(buyer.db, receipt); expect(result.status).toBe(400);
      expect(result.data.errorCode).toBe('ORDER_QUOTE_RECONFIRM_REQUIRED'); expect(await state()).toEqual(before);
      await holder.exec('COMMIT'); expect((await editing).status).toBe(200);
    });
    const after = await state(); expect(after.categories.find(c => c.id === 9)).toMatchObject({ path: '10,8', level: 2 });
    expect(after.orders).toEqual([]);
    const retry = await request(app(f.db), '/outapi/category/8', { cate_name: 'branch', pid: 10, is_show: 1 }, 'PUT');
    expect(retry.data.idempotent).toBe(true); expect(await state()).toEqual(after);
  }, 20_000);

  it.each(['product', 'tree'] as const)('rolls back the entire actual %s editor on a final SQL failure', async target => {
    const table = target === 'product' ? 'system_log' : 'store_product_relation';
    const event = target === 'product' ? 'INSERT' : 'UPDATE';
    await f.exec(`CREATE FUNCTION test_reject_catalog() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated final editor failure'; END $$; CREATE TRIGGER test_reject_catalog BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION test_reject_catalog()`);
    const before = await state();
    const r = target === 'product' ? await request(app(f.db), '/admin/product/edit/70', skuBody)
      : await request(app(f.db), '/outapi/category/8', { cate_name: 'branch', pid: 10, is_show: 1 }, 'PUT');
    expect(r.status).toBe(400); expect(r.msg).toContain(table); expect(await state()).toEqual(before);
  });

  it.each([['product', 'commit'], ['product', 'rollback'], ['tree', 'commit'], ['tree', 'rollback']] as const)(
    'holds actual later %s save until checkout %s', async (target, ending) => {
      const receipt = await confirm(), before = await state();
      await peers(async (holder, buyer, shippingEditor) => {
        await holder.exec('BEGIN; LOCK TABLE store_order_cart_info IN SHARE MODE');
        const buying = buy(buyer.db, receipt); await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
        await shippingEditor.exec('BEGIN; LOCK TABLE shipping_templates_free IN ACCESS EXCLUSIVE MODE');
        await holder.exec('COMMIT'); await waitForFinanceBlock(f.db, buyer.pid, shippingEditor.pid);
        const editing = target === 'product' ? request(app(holder.db), '/admin/product/edit/70', { cate_id: [10] })
          : request(app(holder.db), '/outapi/category/8', { cate_name: 'branch', pid: 10, is_show: 1 }, 'PUT');
        await waitForFinanceBlock(f.db, holder.pid, buyer.pid);
        if (ending === 'rollback') await shippingEditor.db.insert(shippingTemplatesFree).values({ id: 99, tempId: 10, cityId: 101 });
        await shippingEditor.exec('COMMIT'); const b = await buying, e = await editing;
        expect(b.status, b.msg).toBe(ending === 'commit' ? 200 : 400); expect(e.status, e.msg).toBe(200);
      });
      const after = await state(); expect(after.orders).toHaveLength(ending === 'commit' ? 1 : 0);
      if (ending === 'rollback') expect({ ...after, categories: before.categories, products: before.products, relations: before.relations, audit: before.audit }).toEqual(before);
    }, 20_000);

  it('Out deletion waits for buyer inventory and then still refuses the live product reference', async () => {
    const receipt = await confirm();
    await peers(async (holder, buyer, editor) => {
      await holder.exec('BEGIN; LOCK TABLE store_order_cart_info IN SHARE MODE');
      const buying = buy(buyer.db, receipt); await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      const deleting = request(app(editor.db), '/outapi/category/9', undefined, 'DELETE');
      await waitForFinanceBlock(f.db, editor.pid, buyer.pid);
      await holder.exec('COMMIT'); expect((await buying).status).toBe(200);
      const d = await deleting; expect(d.status).toBe(400); expect(d.msg).toContain('引用');
    });
    expect((await state()).categories.some(c => c.id === 9)).toBe(true);
  }, 20_000);

  it.each(['55P03', '40P01', '57014', '08006'])('only translates SKU lock unavailability, never other SQL errors (%s)', async code => {
    const failure = new Error('isolated wrapped driver failure', { cause: { code } });
    const run = withTx(f.container, async tx => {
      vi.spyOn(tx, 'select').mockImplementationOnce(() => { throw failure; });
      await replaceProductSkuEditor(tx, { id: 70, productType: 0, image: '', type: 0, relationId: 0 }, normalizeProductSkuEditorPayload(skuBody), 1);
    });
    if (code === '55P03') await expect(run).rejects.toBeInstanceOf(ValidateException);
    else await expect(run).rejects.toBe(failure);
  });

  it('the actual supplier save rolls back on busy SKU and succeeds after explicit refresh', async () => {
    await f.db.update(storeProduct).set({ type: 2, relationId: 51 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductCategory).set({ type: 2, relationId: 51 }).where(eq(storeProductCategory.id, 9));
    const body = { ...skuBody, product_type: 0, store_name: 'supplier edited', slider_image: ['/api/qa/image.svg'],
      freight: 1, attrs: [{ ...skuBody.attrs[0], settle_price: '1.00' }], description: 'new supplier description' };
    const before = await state();
    await peers(async (holder, editor) => {
      await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
      const r = await request(app(editor.db), '/supplier/product/70', body);
      expect(r.status).toBe(400); expect(r.msg).toContain('商品库存正在变化'); expect(await state()).toEqual(before);
      await holder.db.update(storeProductAttrValue).set({ stock: 6 }).where(eq(storeProductAttrValue.id, 1));
      await holder.db.update(storeProduct).set({ stock: 6 }).where(eq(storeProduct.id, 70)); await holder.exec('COMMIT');
      const r2 = await request(app(editor.db), '/supplier/product/70', { ...body, attrs: [{ ...body.attrs[0], stock: 6 }] });
      expect(r2.status, r2.msg).toBe(200);
    });
    const after = await state(); expect(after.skus[0]).toMatchObject({ unique: 'qared001', stock: 6 });
    expect(after.products[0]).toMatchObject({ stock: 6, isShow: 0, isVerify: 0 }); expect(after.carts[0].status).toBe(0);
  }, 20_000);

  it('a later occupied SKU rolls back earlier acquired SKU locks and all editor writes', async () => {
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 70, type: 0, unique: 'qablue01', suk: '蓝色,大号', price: '10.00', stock: 2 });
    const body = { ...skuBody, items: [{ value: '颜色', detail: ['红色', '蓝色'] }, skuBody.items[1]],
      attrs: [...skuBody.attrs, { ...skuBody.attrs[0], suk: '蓝色,大号', detail: { 颜色: '蓝色', 尺码: '大号' }, unique: 'qablue01', stock: 2 }] };
    const before = await state();
    await peers(async (holder, editor, probe) => {
      await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=2 FOR UPDATE');
      const r = await request(app(editor.db), '/admin/product/edit/70', body);
      expect(r.status).toBe(400); expect(r.msg).toContain('商品库存正在变化'); expect(await state()).toEqual(before);
      await probe.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE NOWAIT; SELECT id FROM store_product WHERE id=70 FOR UPDATE NOWAIT; COMMIT');
      await holder.exec('COMMIT');
    });
  }, 20_000);

  it.each(['admin', 'supplier'] as const)('preserves actual new-product SKU creation for %s', async actor => {
    if (actor === 'supplier') await f.db.update(storeProductCategory).set({ type: 2, relationId: 51 }).where(eq(storeProductCategory.id, 9));
    const body = { ...skuBody, store_name: 'new isolated product', slider_image: ['/api/qa/image.svg'], product_type: 0, freight: 1,
      attrs: [{ ...skuBody.attrs[0], unique: '', settle_price: '1.00', stock: 3 }] };
    const r = await request(app(f.db), actor === 'admin' ? '/admin/product/add' : '/supplier/product/0', body);
    expect(r.status, r.msg).toBe(200); expect(r.data.id).not.toBe(70);
    const rows = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, r.data.id));
    expect(rows).toHaveLength(1); expect(rows[0].stock).toBe(3); expect(rows[0].unique).not.toBe('qared001');
  });
});
