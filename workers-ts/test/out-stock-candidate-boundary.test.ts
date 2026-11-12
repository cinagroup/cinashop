import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray, sql } from 'drizzle-orm';
import { PostgresJsPreparedQuery } from 'drizzle-orm/postgres-js';
import type { PreparedQueryConfig } from 'drizzle-orm/pg-core';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import { productStockUpload } from '../src/controllers/out/OutApiController';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { completePurchaseOriginEvidenceOrm } from '../src/migrations/runPurchaseOriginEvidence';
import { completePurchaseCancellationEvidenceOrm } from '../src/migrations/runPurchaseCancellationEvidence';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { storeProduct, storeProductAttrValue, storeProductStockRecord, outProductWriteReplay } from '../src/models/schema';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('full-ORM bounded Out stock barcode discovery', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([], async () => {
      const owned = await sequenceRunnerDatabase();
      try {
        const api = await import('drizzle-kit/api'), schema = await import('../src/models/schema');
        await owned.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(schema))).join('\n'));
        await completePurchaseOriginEvidenceOrm(owned.db);
        await completePurchaseCancellationEvidenceOrm(owned.db);
        return owned;
      } catch (error) { await owned.close(); throw error; }
    });
    await f.db.update(storeProductAttrValue).set({ barCode: 'OUT-A' }).where(eq(storeProductAttrValue.id, 1));
  }, 120_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); }, 120_000);
  const request = async (items: Array<{ bar_code: string; qty: number }>, key = '8c237c34-9995-4e47-8e02-c6d3e67524db') => {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      c.set('container', createContainerFromDb(f.db));
      c.set('outInfo', { id: 7, appid: 'isolated', title: 'isolated', rules: [] }); await next();
    });
    app.onError((e, c) => c.json({ status: 400, msg: e.message, data: null }));
    app.put('/outapi/product/stock/upload', productStockUpload);
    const response = await app.request('/outapi/product/stock/upload', { method: 'PUT',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ items }) }, f.env);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    return response.json() as Promise<{ status: number; msg: string; data: { updated: number; idempotent: boolean } }>;
  };
  const state = async () => ({ ...await f.snapshot(), stocks: await f.db.select().from(storeProductStockRecord), replays: await f.db.select().from(outProductWriteReplay) });
  const observeDiscovery = () => {
    const observations: Array<{ sql: string; params: unknown[]; rows: number }> = [];
    const execute = PostgresJsPreparedQuery.prototype.execute;
    vi.spyOn(PostgresJsPreparedQuery.prototype, 'execute').mockImplementation(async function (
      this: PostgresJsPreparedQuery<PreparedQueryConfig>, ...args
    ) {
      const prepared = this.getQuery(), query = prepared.sql;
      const result = await execute.apply(this, args);
      if (/^\s*select/i.test(query) && /join\s+"store_product"/i.test(query) && query.includes('"store_product_attr_value"')) {
        if (!Array.isArray(result)) throw new Error('Expected real PostgreSQL row-array result');
        observations.push({ sql: query, params: prepared.params, rows: result.length });
      }
      return result;
    });
    return observations;
  };
  const seed = async (barCodes: string[]) => {
    await f.db.insert(storeProductAttrValue).values(barCodes.map((barCode, i) => ({
      id: i + 2, productId: 70, unique: `qa${String(i + 2).padStart(6, '0')}`, suk: `isolated-${i}`,
      type: 0, stock: 1, sumStock: 1, price: '10.00', barCode,
    })));
    await f.db.update(storeProduct).set({ stock: 8 + barCodes.length }).where(eq(storeProduct.id, 70));
  };

  it.each([{ codes: 1, duplicates: 400 }, { codes: 100, duplicates: 10 }])(
    'returns at most two real rows per barcode for $codes codes with $duplicates duplicates', async ({ codes, duplicates }) => {
      const barCodes = Array.from({ length: codes }, (_, i) => `DUP-${i}`);
      await seed(barCodes.flatMap(code => Array.from({ length: duplicates }, () => code)));
      const before = await state(), observations = observeDiscovery();
      const result = await request(barCodes.map(bar_code => ({ bar_code, qty: 2 })));
      expect(result.status).toBe(400); expect(result.msg).toContain('存在重复'); expect(await state()).toEqual(before);
      expect(observations).toHaveLength(1); expect(observations[0].rows).toBe(codes * 2);
    }, 20_000,
  );

  it('does not rescan the unindexed SKU barcode set once for each of 100 requested codes', async () => {
    const barCodes = Array.from({ length: 100 }, (_, i) => `DUP-${i}`);
    await seed(barCodes.flatMap(code => Array.from({ length: 10 }, () => code)));
    await f.exec('ANALYZE store_product_attr_value; ANALYZE store_product');
    const observations = observeDiscovery(); expect((await request(barCodes.map(bar_code => ({ bar_code, qty: 2 })))).status).toBe(400);
    expect(observations).toHaveLength(1);
    const query = observations[0];
    // Rebind the captured, application-generated SELECT parameters for EXPLAIN;
    // values remain SQL parameters, not interpolated SQL text.
    const parts = query.sql.split(/(\$\d+)/g).map(part => /^\$\d+$/.test(part)
      ? sql`${query.params[Number(part.slice(1)) - 1]}` : sql.raw(part));
    type Plan = { 'Node Type': string; 'Relation Name'?: string; 'Actual Loops'?: number; 'Actual Rows'?: number; Plans?: Plan[] };
    const plans = await f.db.execute<{ 'QUERY PLAN': Array<{ Plan: Plan }> }>(sql`EXPLAIN (ANALYZE, FORMAT JSON) ${sql.join(parts, sql``)}`);
    const nodes: Plan[] = [];
    const visit = (node: Plan) => { nodes.push(node); for (const child of node.Plans ?? []) visit(child); };
    visit(plans[0]['QUERY PLAN'][0].Plan);
    const scans = nodes.filter(node => node['Relation Name'] === 'store_product_attr_value');
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.every(node => node['Actual Loops'] === 1), JSON.stringify(scans.map(node => ({ type: node['Node Type'], loops: node['Actual Loops'], rows: node['Actual Rows'] })))).toBe(true);
    expect(plans[0]['QUERY PLAN'][0].Plan['Actual Rows']).toBe(200);
  }, 20_000);

  it('updates all 100 unique codes on a hidden unverified physical product and replays without discovery or writes', async () => {
    const codes = Array.from({ length: 100 }, (_, i) => `UNIQUE-${i}`);
    await seed(codes);
    await f.db.update(storeProduct).set({ isShow: 0, isVerify: 0 }).where(eq(storeProduct.id, 70));
    const before = await state(), observations = observeDiscovery();
    const items = codes.map(bar_code => ({ bar_code, qty: 3 }));
    expect(await request(items)).toMatchObject({ status: 200, data: { updated: 100, idempotent: false } });
    expect(observations).toHaveLength(1); expect(observations[0].rows).toBe(100);
    const after = await state();
    expect(after.skus.find(row => row.id === 1)).toEqual(before.skus.find(row => row.id === 1));
    for (const row of after.skus.filter(row => row.id !== 1)) {
      expect(row).toEqual({ ...before.skus.find(previous => previous.id === row.id), stock: 3, sumStock: 3 });
    }
    expect(after.products).toEqual(before.products.map(row => ({ ...row, stock: 308, isSold: 0 })));
    expect(after.stocks).toHaveLength(100); expect(after.stocks.every(row => row.number === 2 && row.pm === 1)).toBe(true);
    expect(after.replays).toHaveLength(1);
    expect(await request(items)).toMatchObject({ status: 200, data: { updated: 100, idempotent: true } });
    expect(observations).toHaveLength(1); expect(await state()).toEqual(after);
  }, 20_000);

  it('rejects an entire 100-item batch when its last barcode is missing', async () => {
    const codes = Array.from({ length: 99 }, (_, i) => `UNIQUE-${i}`);
    await seed(codes);
    const before = await state(), observations = observeDiscovery();
    const result = await request([...codes, 'MISSING-LAST'].map(bar_code => ({ bar_code, qty: 3 })));
    expect(result.status).toBe(400); expect(result.msg).toContain('MISSING-LAST 不存在于平台商品');
    expect(observations).toHaveLength(1); expect(observations[0].rows).toBe(99);
    expect(await state()).toEqual(before);
  }, 20_000);

  it.each([
    { name: 'card product with mismatched SKU type', product: { productType: 1 }, sku: {} },
    { name: 'one-time card stock', product: { productType: 1 }, sku: { productType: 1, diskInfo: '' } },
    { name: 'second-card product with mismatched SKU type', product: { productType: 4 }, sku: {} },
    { name: 'manual product with mismatched SKU type', product: { productType: 3 }, sku: { productType: 0 } },
    { name: 'nonplatform owner', product: { type: 1, relationId: 51 }, sku: {} },
    { name: 'nonzero platform relation', product: { relationId: 51 }, sku: {} },
    { name: 'deleted product', product: { isDel: 1 }, sku: {} },
    { name: 'retired SKU', product: {}, sku: { isRetired: 1 } },
    { name: 'nonordinary SKU', product: {}, sku: { type: 1 } },
  ])('filters $name matches before limiting, preserving a higher-ID eligible SKU', async ({ product, sku }) => {
    await seed(['ELIGIBLE', 'ELIGIBLE', 'ELIGIBLE', 'ELIGIBLE']);
    const [base] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70));
    await f.db.insert(storeProduct).values({ ...base, id: 71, spu: 'isolated71', stock: 3, ...product });
    await f.db.update(storeProductAttrValue).set({ productId: 71, ...sku }).where(inArray(storeProductAttrValue.id, [2, 3, 4]));
    await f.db.update(storeProduct).set({ stock: 9 }).where(eq(storeProduct.id, 70));
    const before = await state(), observations = observeDiscovery();
    expect(await request([{ bar_code: 'ELIGIBLE', qty: 4 }])).toMatchObject({ status: 200, data: { updated: 1 } });
    expect(observations).toHaveLength(1); expect(observations[0].rows).toBe(1);
    const after = await state();
    expect(after.skus.filter(row => row.id !== 5)).toEqual(before.skus.filter(row => row.id !== 5));
    expect(after.skus.find(row => row.id === 5)).toEqual({ ...before.skus.find(row => row.id === 5), stock: 4, sumStock: 4 });
    expect(after.products.find(row => row.id === 71)).toEqual(before.products.find(row => row.id === 71));
    expect(after.products.find(row => row.id === 70)).toEqual({ ...before.products.find(row => row.id === 70), stock: 12 });
    expect(after.stocks).toHaveLength(1); expect(after.replays).toHaveLength(1);
  }, 20_000);

  it('updates manual virtual stock but rejects a barcode shared by physical and virtual products', async () => {
    await seed(['MANUAL', 'CROSS', 'CROSS']);
    const [base] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70));
    await f.db.insert(storeProduct).values({ ...base, id: 71, spu:'manual71',productType:3,stock:2,deliveryType:'',freight:2,tempId:0,postage:'0.00' });
    await f.db.update(storeProductAttrValue).set({productId:71,productType:3}).where(inArray(storeProductAttrValue.id,[2,4]));
    await f.db.update(storeProduct).set({stock:9}).where(eq(storeProduct.id,70));
    const success = await request([{bar_code:'MANUAL',qty:6}]);
    expect(success).toMatchObject({status:200,data:{updated:1,idempotent:false}});
    const after = await state();
    expect(after.skus.find(row=>row.id===2)).toMatchObject({productId:71,productType:3,stock:6});
    expect(after.products.find(row=>row.id===71)).toMatchObject({productType:3,stock:7,isSold:0});
    expect(await request([{bar_code:'MANUAL',qty:6}])).toMatchObject({status:200,data:{updated:1,idempotent:true}});
    expect(await state()).toEqual(after);
    const duplicate=await request([{bar_code:'CROSS',qty:8}],'6479a289-0a69-4b63-8f8e-713b4baf1905');
    expect(duplicate.status).toBe(400);expect(duplicate.msg).toContain('存在重复');expect(await state()).toEqual(after);
  },20_000);

  it('rolls back manual stock and its receipt when a deferred trigger changes the saved SKU', async () => {
    await f.db.update(storeProduct).set({productType:3,deliveryType:'',freight:2,tempId:0,postage:'0.00'}).where(eq(storeProduct.id,70));
    await f.db.update(storeProductAttrValue).set({productType:3}).where(eq(storeProductAttrValue.id,1));
    await f.exec(`CREATE FUNCTION test_manual_stock_drift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE store_product_attr_value SET stock=999 WHERE id=1; RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER test_manual_stock_drift AFTER INSERT ON out_product_write_replay DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION test_manual_stock_drift()`);
    const before=await state(),result=await request([{bar_code:'OUT-A',qty:6}]);
    expect(result.status).toBe(400);expect(result.msg).toContain('库存');expect(await state()).toEqual(before);
  },20_000);

  it('keeps Unicode, quotes and case-distinct barcodes as exact bound parameters', async () => {
    const codes = ["中文'条码", 'Case', 'case', "x'); DROP TABLE foo;--"];
    await seed(codes);
    const observations = observeDiscovery();
    expect(await request(codes.map((bar_code, i) => ({ bar_code, qty: i + 2 })))).toMatchObject({ status: 200, data: { updated: 4 } });
    expect(observations).toHaveLength(1); expect(observations[0].rows).toBe(4);
    for (const code of codes) {
      expect(observations[0].params).toContain(code); expect(observations[0].sql).not.toContain(code);
    }
    const rows = await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id);
    expect(rows.slice(1).map(row => ({ barCode: row.barCode, stock: row.stock }))).toEqual(codes.map((barCode, i) => ({ barCode, stock: i + 2 })));
  }, 20_000);
  it('updates second-card inventory and rejects a physical collision', async () => {
    await seed(['SECOND', 'CROSS', 'CROSS']);
    const [base] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70));
    await f.db.insert(storeProduct).values({ ...base, id: 71, spu: 'second71', productType: 4, stock: 2, deliveryType: '2', freight: 1, tempId: 0, postage: '0.00' });
    await f.db.update(storeProductAttrValue).set({ productId: 71, productType: 4 }).where(inArray(storeProductAttrValue.id, [2, 4]));
    await f.db.update(storeProduct).set({ stock: 9 }).where(eq(storeProduct.id, 70));
    expect(await request([{ bar_code: 'SECOND', qty: 6 }])).toMatchObject({ status: 200, data: { updated: 1, idempotent: false } });
    const after = await state();
    expect(after.skus.find(row => row.id === 2)).toMatchObject({ productId: 71, productType: 4, stock: 6 });
    expect(after.products.find(row => row.id === 71)).toMatchObject({ productType: 4, stock: 7, isSold: 0 });
    expect(await request([{ bar_code: 'SECOND', qty: 6 }])).toMatchObject({ status: 200, data: { updated: 1, idempotent: true } });
    expect(await state()).toEqual(after);
    const duplicate = await request([{ bar_code: 'CROSS', qty: 8 }], crypto.randomUUID());
    expect(duplicate.status).toBe(400); expect(duplicate.msg).toContain('存在重复'); expect(await state()).toEqual(after);
  }, 20_000);

  it('rolls back stock synchronization if a deferred trigger changes card validity', async () => {
    await f.db.update(storeProduct).set({ productType: 4, deliveryType: '2', freight: 1, tempId: 0, postage: '0.00' }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ productType: 4, writeTimes: 3, writeValid: 2, writeDays: 30 }).where(eq(storeProductAttrValue.id, 1));
    await f.exec(`CREATE FUNCTION test_card_rule_drift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE store_product_attr_value SET write_days=2 WHERE id=1; RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER test_card_rule_drift AFTER INSERT ON out_product_write_replay DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION test_card_rule_drift()`);
    const before = await state(), result = await request([{ bar_code: 'OUT-A', qty: 6 }]);
    expect(result.status).toBe(400); expect(await state()).toEqual(before);
  }, 20_000);

  it('rolls back second-card inventory and receipt on deferred SKU tampering', async () => {
    await f.db.update(storeProduct).set({ productType: 4, deliveryType: '2', freight: 1, tempId: 0, postage: '0.00' }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ productType: 4 }).where(eq(storeProductAttrValue.id, 1));
    await f.exec(`CREATE FUNCTION test_card_stock_drift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE store_product_attr_value SET stock=999 WHERE id=1; RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER test_card_stock_drift AFTER INSERT ON out_product_write_replay DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION test_card_stock_drift()`);
    const before = await state(), result = await request([{ bar_code: 'OUT-A', qty: 6 }]);
    expect(result.status).toBe(400); expect(result.msg).toContain('库存'); expect(await state()).toEqual(before);
  }, 20_000);
  it('updates fixed-content stock but refuses a barcode shared with a physical product', async () => {
    await seed(['FIXED', 'CROSS', 'CROSS']);
    const [base] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70));
    await f.db.insert(storeProduct).values({ ...base, id: 71, spu: 'fixed71', productType: 1, stock: 2, deliveryType: '', freight: 2, tempId: 0, postage: '0.00' });
    await f.db.update(storeProductAttrValue).set({ productId: 71, productType: 1, diskInfo: 'isolated-fixed' }).where(inArray(storeProductAttrValue.id, [2, 4]));
    await f.db.update(storeProduct).set({ stock: 9 }).where(eq(storeProduct.id, 70));
    expect(await request([{ bar_code: 'FIXED', qty: 6 }])).toMatchObject({ status: 200, data: { updated: 1 } });
    const after = await state(); expect(after.products.find(row => row.id === 71)).toMatchObject({ stock: 7, productType: 1 });
    const failed = await request([{ bar_code: 'CROSS', qty: 8 }], crypto.randomUUID()); expect(failed.status).toBe(400); expect(failed.msg).toContain('存在重复'); expect(await state()).toEqual(after);
  }, 20_000);
});

import { productCreate, productInfo, productUpdate } from '@/controllers/out/OutApiController';
import { outAuthMiddleware } from '@/middleware/out-auth';
import { createToken, md5 } from '@/utils/jwt';
import { StoreCartService } from '@/services/order/StoreCartService';
import { StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';
import { deliverPaidVirtualOrders } from '@/services/order/VirtualProductDeliveryService';
import { runtimeBusinessPrivilegePlan } from '@/migrations/runtimeBusinessPrivilegePlan';
import type { DbClient } from '@/lib/di';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
import { errorHandler } from '@/middleware/error';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Out card product author and real inventory delivery', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let owned: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let network: ReturnType<typeof vi.spyOn>, env: Env, token: string;
  const first = { key: 'isolated-card-one', value: 'isolated-value-one' };
  const second = { key: '隔离:卡二😀', value: '隔离内容:二😀' };
  const third = { key: 'isolated-card-three', value: 'isolated-value-three' };
  const body = { product_type: 1, cate_id: [9], store_name: '隔离Out卡密', slider_image: ['/card.png'], spec_type: 0, is_show: 1,
    brand_id: [31], ensure_id: [91], store_label_id: [101], label_id: [201], specs_id: 301, specs: [{ name: '版本', value: '隔离' }],
    coupon_ids: [], custom_form: [], system_form_id: 0,
    attrs: [{ price: '10.00', stock: 999, bar_code: 'OUT-CARD', disk_info: '', virtual_list: [first, second, first] }] };
  const app = (db = f.db) => { const a = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    a.use('*', async (c, next) => { c.set('container', createContainerFromDb(db)); await next(); });
    a.onError(errorHandler);
    a.post('/outapi/product', outAuthMiddleware('POST', '/product'), productCreate);
    a.put('/outapi/product/stock/upload', outAuthMiddleware('PUT', '/product/stock/upload'), productStockUpload);
    a.put('/outapi/product/:id', outAuthMiddleware('PUT', '/product/{id}'), productUpdate);
    a.get('/outapi/product/:id', outAuthMiddleware('GET', '/product/{id}'), productInfo); return a; };
  const call = async (path: string, method: string, data?: object, key = crypto.randomUUID(), db = f.db) => {
    const response = await app(db).request(path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      ...(data ? { body: JSON.stringify(data) } : {}) }, env);
    return response.json() as Promise<{ status: number; msg: string; data: any }>;
  };
  beforeEach(async () => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Isolated card author forbids external providers'));
    f = await createPcCheckoutQuoteFixture([], async () => { owned = await sequenceRunnerDatabase();
      try { const api = await import('drizzle-kit/api'), schema = await import('@/models/schema');
        await owned.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(schema))).join('\n'));
        await completePurchaseOriginEvidenceOrm(owned.db); await completePurchaseCancellationEvidenceOrm(owned.db); return owned;
      } catch (error) { await owned.close(); throw error; } });
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.exec(`INSERT INTO store_product_category(id,cate_name,is_show) VALUES (9,'隔离分类',1);
      INSERT INTO store_brand(id,brand_name,is_show) VALUES (31,'隔离品牌',1);
      INSERT INTO store_product_ensure(id,name,status) VALUES (91,'隔离保障',1);
      INSERT INTO category(id,"group",name,is_show) VALUES (300,2,'标签组',1),(301,3,'参数模板',1);
      INSERT INTO store_product_label(id,label_name,label_cate,status,is_show) VALUES (101,'隔离商品标签',300,1,1);
      INSERT INTO user_label(id,name,status) VALUES (201,'隔离用户标签',1);
      INSERT INTO out_interface(id,type,method,url) VALUES (1,1,'POST','/product'),(2,1,'PUT','/product/{id}'),
        (3,1,'GET','/product/{id}'),(4,1,'PUT','/product/stock/upload');
      INSERT INTO out_account(id,appid,appsecret,rules) VALUES (1,'card-local','fixture-card-secret','[1,2,3,4]');
      SELECT setval(pg_get_serial_sequence('store_product','id'),70,true);
      SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),1,true);
      SELECT setval(pg_get_serial_sequence('store_cart','id'),1,true)`);
    env = { ...f.env, APP_KEY: 'isolated-local-key-not-a-real-credential', TOKEN_BUCKET: { getByName: () => ({ consumeRateLimit: async () =>
      ({ allowed: true, auditEvent: false, limit: 120, remaining: 119, resetAt: Date.now() + 60000 }) }) } } as unknown as Env;
    token = (await createToken(1, 'out', md5('fixture-card-secret'), env.APP_KEY)).token;
  }, 120_000);
  afterEach(async () => { try { expect(network).not.toHaveBeenCalled(); } finally { network?.mockRestore(); await f?.close(); } }, 60_000);
  const state = async () => ({ ...await f.snapshot(), cards: await f.db.execute(sql`SELECT * FROM store_product_virtual ORDER BY id`),
    records: await f.db.execute(sql`SELECT * FROM store_product_stock_record ORDER BY id`), receipts: await f.db.execute(sql`SELECT * FROM out_product_write_replay ORDER BY id`) });
  const checkout = async (id: number, unique: string) => {
    const cart = await new StoreCartService(f.container, f.env).add({ uid: 11, productId: id, unique, cartNum: 1, isNew: 1, type: 0 });
    const selection = { cartIds: [cart.id], type: 0, shippingType: 1, useIntegral: false };
    const response = await f.app.request('/api/order/confirm', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': '11' }, body: JSON.stringify(selection) }, f.env);
    const confirmed = await response.json() as { status: number; msg: string; data: { orderKey: string; quoteToken: string } }; expect(confirmed.status, confirmed.msg).toBe(200);
    return StoreOrderCreateService.createWithRuntime(f.container, { CONFIG_KV: f.env.CONFIG_KV, requireConfirmation: true, requirePurchaseOrigin: true,
      nextOrderId: async () => `out_card_${id}` }, { ...selection, uid: 11, key: confirmed.data.orderKey, quoteToken: confirmed.data.quoteToken, userIp: '127.0.0.1' });
  };
  const markFixturePaidThenDeliver = async (businessId: string) => {
    // Explicit test seed: no payment handler/provider is claimed by this test.
    await f.db.execute(sql`UPDATE store_order SET paid=1 WHERE order_id=${businessId}`);
    const [row] = await f.db.execute<any>(sql`SELECT id,uid,order_id,paid,status,is_del,is_system_del,product_type FROM store_order WHERE order_id=${businessId}`);
    return f.db.transaction(tx => deliverPaidVirtualOrders(tx as unknown as DbClient, [{ id: row.id, uid: row.uid, orderId: row.order_id, paid: row.paid,
      status: row.status, isDel: row.is_del, isSystemDel: row.is_system_del, productType: row.product_type }], Math.floor(Date.now() / 1000)));
  };
  it('creates, replays, buys and delivers one-time cards, then imports without duplicating assigned credentials', async () => {
    const key = crypto.randomUUID(), created = await call('/outapi/product', 'POST', body, key); expect(created.status, created.msg).toBe(200); const id = Number(created.data.id);
    expect((await call('/outapi/product', 'POST', body, key)).data).toMatchObject({ id, idempotent: true });
    const [sku] = await f.db.execute<any>(sql`SELECT id,"unique",product_type,stock,sum_stock FROM store_product_attr_value WHERE product_id=${id} AND type=0`);
    expect(sku).toMatchObject({ product_type: 1, stock: 2, sum_stock: 2 });
    const links = await f.db.execute<any>(sql`SELECT type,relation_id FROM store_product_relation WHERE product_id=${id} ORDER BY type`);
    expect(links).toEqual([{ type: 1, relation_id: 9 }, { type: 2, relation_id: 31 }, { type: 3, relation_id: 101 }, { type: 4, relation_id: 201 }, { type: 5, relation_id: 91 }, { type: 6, relation_id: 301 }]);
    const detail = await call(`/outapi/product/${id}`, 'GET'); expect(detail.status, detail.msg).toBe(200);
    expect(detail.data.productInfo.attr).toMatchObject({ virtual_list: [], virtual_available: 2, virtual_total: 2 });
    for (const value of [first.key, first.value, second.key, second.value]) expect(JSON.stringify(detail)).not.toContain(value);
    const order = await checkout(id, sku.unique), before = await state();
    const blocked = await call(`/outapi/product/${id}`, 'PUT', { ...body, attrs: [{ ...body.attrs[0], unique: sku.unique }] });
    expect(blocked.status).not.toBe(200); expect(await state()).toEqual(before);
    expect(await markFixturePaidThenDeliver(order.orderId)).toEqual({ deliveredOrders: 1, deliveredCards: 1 });
    const imported = await call(`/outapi/product/${id}`, 'PUT', { ...body, attrs: [{ ...body.attrs[0], unique: sku.unique, virtual_list: [first, second, third] }] });
    expect(imported.status, imported.msg).toBe(200); expect(imported.data.stock_preserved).toBe(true);
    const [final] = await f.db.execute<any>(sql`SELECT stock,sum_stock,sales FROM store_product_attr_value WHERE id=${sku.id}`);
    expect(final).toMatchObject({ stock: 2, sum_stock: 3, sales: 1 });
    const [counts] = await f.db.execute<any>(sql`SELECT count(*)::int AS total,count(*) FILTER(WHERE uid=0)::int AS available FROM store_product_virtual WHERE product_id=${id}`);
    expect(counts).toEqual({ total: 3, available: 2 });
    const after = await state(); const numeric = await call('/outapi/product/stock/upload', 'PUT', { items: [{ bar_code: 'OUT-CARD', qty: 99 }] });
    expect(numeric.status).not.toBe(200); expect(await state()).toEqual(after);
  }, 40_000);
  it('uses ordinary stock for fixed content and delivers the frozen checkout content after an edit', async () => {
    const input = { ...body, attrs: [{ ...body.attrs[0], stock: 5, disk_info: 'isolated-fixed-one', virtual_list: [] }] };
    const created = await call('/outapi/product', 'POST', input); expect(created.status, created.msg).toBe(200); const id = Number(created.data.id);
    const [sku] = await f.db.execute<any>(sql`SELECT "unique" FROM store_product_attr_value WHERE product_id=${id} AND type=0`);
    const synced = await call('/outapi/product/stock/upload', 'PUT', { items: [{ bar_code: 'OUT-CARD', qty: 7 }] }); expect(synced.status, synced.msg).toBe(200);
    const order = await checkout(id, sku.unique);
    const edited = await call(`/outapi/product/${id}`, 'PUT', { ...input, attrs: [{ ...input.attrs[0], unique: sku.unique, disk_info: 'isolated-fixed-two' }] }); expect(edited.status, edited.msg).toBe(200);
    expect(await markFixturePaidThenDeliver(order.orderId)).toEqual({ deliveredOrders: 1, deliveredCards: 0 });
    const [saved] = await f.db.execute<any>(sql`SELECT virtual_info FROM store_order WHERE order_id=${order.orderId}`);
    expect(JSON.parse(saved.virtual_info)).toMatchObject([{ disk_info: 'isolated-fixed-one', product_id: id, sku_unique: sku.unique }]);
  }, 40_000);
  it('rolls back imported cards, stock, snapshot and receipt on deferred credential tampering', async () => {
    await f.exec(`CREATE FUNCTION test_out_card_payload_drift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE store_product_virtual SET card_pwd='tampered-fixture' WHERE product_id=NEW.product_id; RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER test_out_card_payload_drift AFTER INSERT ON out_product_write_replay DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_out_card_payload_drift()`);
    const before = await state(), failed = await call('/outapi/product', 'POST', body); expect(failed.status).not.toBe(200); expect(failed.msg).toContain('变化'); expect(await state()).toEqual(before);
  }, 30_000);
  it('rejects unsafe mode changes, changed import replays and conflicting historical stock', async () => {
    const key = crypto.randomUUID(), created = await call('/outapi/product', 'POST', body, key); expect(created.status, created.msg).toBe(200); const id = Number(created.data.id);
    const [sku] = await f.db.execute<any>(sql`SELECT id,"unique" FROM store_product_attr_value WHERE product_id=${id} AND type=0`);
    const before = await state();
    const mode = await call(`/outapi/product/${id}`, 'PUT', { ...body, attrs: [{ ...body.attrs[0], unique: sku.unique, disk_info: 'fixed-now', virtual_list: [] }] });
    expect(mode.status).not.toBe(200); expect(mode.msg).toContain('切换');
    const conflict = await call('/outapi/product', 'POST', { ...body, attrs: [{ ...body.attrs[0], virtual_list: [third] }] }, key);
    expect(conflict.status).not.toBe(200); expect(conflict.msg).toContain('Idempotency-Key'); expect(await state()).toEqual(before);
    await f.db.execute(sql`UPDATE store_product_attr_value SET stock=1 WHERE id=${sku.id}`);
    await f.db.execute(sql`UPDATE store_product SET stock=1 WHERE id=${id}`);
    const drifted = await state(), failed = await call(`/outapi/product/${id}`, 'PUT', { ...body, attrs: [{ ...body.attrs[0], unique: sku.unique }] });
    expect(failed.status).not.toBe(200); expect(failed.msg).toContain('变化'); expect(await state()).toEqual(drifted);
  }, 30_000);
  it('refuses an independent importer inventory lock and safely reuses the uncommitted request key', async () => {
    const created = await call('/outapi/product', 'POST', body); expect(created.status, created.msg).toBe(200); const id = Number(created.data.id);
    const [sku] = await f.db.execute<any>(sql`SELECT "unique" FROM store_product_attr_value WHERE product_id=${id} AND type=0`);
    const key = crypto.randomUUID(), input = { ...body, attrs: [{ ...body.attrs[0], unique: sku.unique, virtual_list: [third] }] }, before = await state();
    if (!owned.withPeer) throw Error('Dedicated PG16 peers required');
    await owned.withPeer(async peer => { await peer.exec('BEGIN'); await peer.db.execute(sql`SELECT pg_advisory_xact_lock(731603,${id}::integer)`);
      try { const failed = await call(`/outapi/product/${id}`, 'PUT', input, key); expect(failed.status).not.toBe(200); expect(failed.msg).toContain('正在变化'); }
      finally { await peer.exec('ROLLBACK'); } });
    expect(await state()).toEqual(before);
    const retried = await call(`/outapi/product/${id}`, 'PUT', input, key); expect(retried.status, retried.msg).toBe(200);
    const after = await state(); expect((await call(`/outapi/product/${id}`, 'PUT', input, key)).data.idempotent).toBe(true); expect(await state()).toEqual(after);
  }, 30_000);
  it('creates and imports card inventory using the existing restricted application login', async () => {
    if (!owned.withRuntimeRole) throw Error('Native restricted LOGIN required');
    await owned.withRuntimeRole(async runtime => {
      const plan = runtimeBusinessPrivilegePlan('app'), quote = (name: string) => { if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw Error('Invalid identifier'); return `"${name}"`; };
      const tables = await f.db.execute<{ name: string }>(sql`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname`);
      for (const { name } of tables) { const rights = plan.tables[name]; if (!rights) continue; await f.exec(`GRANT ${rights.join(',')} ON public.${quote(name)} TO ${quote(runtime.role)}`);
        const columns = plan.updateColumns[name]; if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(quote).join(',')}) ON public.${quote(name)} TO ${quote(runtime.role)}`); }
      const seqs = await f.db.execute<{ table_name: string; sequence_name: string | null }>(sql`SELECT c.relname AS table_name,pg_get_serial_sequence('public.'||quote_ident(c.relname),a.attname) AS sequence_name FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'`);
      for (const row of seqs) if (row.sequence_name && plan.tables[row.table_name]?.includes('INSERT')) { const parts = row.sequence_name.split('.'); if (parts.length !== 2 || parts[0] !== 'public') throw Error('Unexpected sequence'); await f.exec(`GRANT USAGE ON SEQUENCE public.${quote(parts[1])} TO ${quote(runtime.role)}`); }
      const saved = await call('/outapi/product', 'POST', body, crypto.randomUUID(), runtime.db); expect(saved.status, saved.msg).toBe(200);
      const [row] = await f.db.execute<any>(sql`SELECT product_type,stock FROM store_product WHERE id=${Number(saved.data.id)}`); expect(row).toEqual({ product_type: 1, stock: 2 });
      const [rights] = await runtime.db.execute(sql`SELECT current_user=session_user AS direct_login,has_table_privilege(current_user,'public.system_config','UPDATE') AS config_write`);
      expect(rights).toEqual({ direct_login: true, config_write: false });
    });
  }, 30_000);
  it('supports safe empty-inventory mode changes and rolls back fixed-stock card interference', async () => {
    const emptyFixed = { ...body, attrs: [{ ...body.attrs[0], stock: 0, disk_info: 'empty-fixed', virtual_list: [] }] };
    const made = await call('/outapi/product', 'POST', emptyFixed); expect(made.status, made.msg).toBe(200); const id = Number(made.data.id);
    const [sku] = await f.db.execute<any>(sql`SELECT "unique" FROM store_product_attr_value WHERE product_id=${id} AND type=0`);
    const changed = await call(`/outapi/product/${id}`, 'PUT', { ...body, attrs: [{ ...body.attrs[0], unique: sku.unique, virtual_list: [first] }] }); expect(changed.status, changed.msg).toBe(200);
    const emptyCards = { ...body, attrs: [{ ...body.attrs[0], bar_code: 'OUT-SWITCH', virtual_list: [] }] };
    const another = await call('/outapi/product', 'POST', emptyCards); expect(another.status, another.msg).toBe(200); const secondId = Number(another.data.id);
    const [secondSku] = await f.db.execute<any>(sql`SELECT "unique" FROM store_product_attr_value WHERE product_id=${secondId} AND type=0`);
    const fixed = await call(`/outapi/product/${secondId}`, 'PUT', { ...emptyCards, attrs: [{ ...emptyCards.attrs[0], unique: secondSku.unique, disk_info: 'switch-fixed' }] }); expect(fixed.status, fixed.msg).toBe(200);
    await f.exec(`CREATE FUNCTION test_out_fixed_card_drift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO store_product_virtual(product_id,attr_unique,card_no,card_pwd,card_unique) VALUES (${secondId},'${secondSku.unique}','isolated','fixture',md5('${secondSku.unique},isolated,fixture')); RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER test_out_fixed_card_drift AFTER INSERT ON out_product_write_replay DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_out_fixed_card_drift()`);
    const before = await state(), failed = await call('/outapi/product/stock/upload', 'PUT', { items: [{ bar_code: 'OUT-SWITCH', qty: 5 }] });
    expect(failed.status).not.toBe(200); expect(failed.msg).toContain('卡密'); expect(await state()).toEqual(before);
  }, 40_000);
  it('refuses a card author during a real checkout SKU wait without reversing its lock order', async () => {
    const created = await call('/outapi/product', 'POST', body); expect(created.status, created.msg).toBe(200); const id = Number(created.data.id);
    const [sku] = await f.db.execute<any>(sql`SELECT id,"unique" FROM store_product_attr_value WHERE product_id=${id} AND type=0`);
    const cart = await new StoreCartService(f.container, f.env).add({ uid: 11, productId: id, unique: sku.unique, cartNum: 1, isNew: 1, type: 0 });
    const selection = { cartIds: [cart.id], type: 0, shippingType: 1, useIntegral: false };
    const response = await f.app.request('/api/order/confirm', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': '11' }, body: JSON.stringify(selection) }, f.env);
    const confirmed = await response.json() as { status: number; msg: string; data: { orderKey: string; quoteToken: string } }; expect(confirmed.status, confirmed.msg).toBe(200);
    if (!owned.withPeer) throw Error('Dedicated PG16 peers required');
    await owned.withPeer(holder => owned.withPeer!(async buyer => {
      await holder.exec('BEGIN'); await holder.db.execute(sql`SELECT id FROM store_product_attr_value WHERE id=${sku.id} FOR UPDATE`);
      const pending = outcome(StoreOrderCreateService.createWithRuntime(createContainerFromDb(buyer.db), { CONFIG_KV: f.env.CONFIG_KV,
        requireConfirmation: true, requirePurchaseOrigin: true, nextOrderId: async () => `out_card_race_${id}` },
        { ...selection, uid: 11, key: confirmed.data.orderKey, quoteToken: confirmed.data.quoteToken, userIp: '127.0.0.1' }));
      let holding = true;
      try { await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
        const refused = await call(`/outapi/product/${id}`, 'PUT', { ...body, attrs: [{ ...body.attrs[0], unique: sku.unique, virtual_list: [third] }] });
        expect(refused.status).not.toBe(200); expect(refused.msg).toContain('变化');
        await holder.exec('COMMIT'); holding = false; const result = await pending; expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
      } finally { if (holding) await holder.exec('ROLLBACK'); await pending; }
    }));
    const [stock] = await f.db.execute<any>(sql`SELECT stock FROM store_product_attr_value WHERE id=${sku.id}`); expect(stock.stock).toBe(1);
    const [counts] = await f.db.execute<any>(sql`SELECT count(*)::int AS n FROM store_product_virtual WHERE product_id=${id}`); expect(counts.n).toBe(2);
  }, 40_000);
  it('hides credential-bearing SQL failures through the production error boundary', async () => {
    await f.exec(`CREATE FUNCTION test_out_card_insert_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rejected payload: %',NEW.card_pwd; END $$;
      CREATE TRIGGER test_out_card_insert_failure BEFORE INSERT ON store_product_virtual FOR EACH ROW EXECUTE FUNCTION test_out_card_insert_failure()`);
    const before = await state(), result = await call('/outapi/product', 'POST', body);
    expect(result).toMatchObject({ status: 500, msg: '系统繁忙,请稍后再试', data: null });
    for (const value of [first.key, first.value, second.key, second.value]) expect(JSON.stringify(result)).not.toContain(value);
    expect(await state()).toEqual(before);
  }, 30_000);
  it('keeps mixed multi-SKU fixed content and card inventory separate during create and edit', async () => {
    const input = { ...body, spec_type: 1, items: [{ value: '类型', detail: ['固定', '卡库'] }], attrs: [
      { suk: '固定', detail: { 类型: '固定' }, price: '8.00', stock: 3, disk_info: 'mixed-fixed', virtual_list: [], bar_code: 'MIXED-FIXED' },
      { suk: '卡库', detail: { 类型: '卡库' }, price: '10.00', stock: 99, disk_info: '', virtual_list: [first, second], bar_code: 'MIXED-CARDS' },
    ] };
    const created = await call('/outapi/product', 'POST', input); expect(created.status, created.msg).toBe(200); const id = Number(created.data.id);
    const rows = await f.db.execute<any>(sql`SELECT suk,"unique",stock,sum_stock,disk_info FROM store_product_attr_value WHERE product_id=${id} AND type=0 ORDER BY id`);
    expect(rows).toMatchObject([{ suk: '固定', stock: 3, sum_stock: 3, disk_info: 'mixed-fixed' }, { suk: '卡库', stock: 2, sum_stock: 2, disk_info: '' }]);
    const edited = { ...input, attrs: input.attrs.map((row, index) => ({ ...row, unique: rows[index].unique, stock: 999,
      virtual_list: index === 1 ? [first, third] : [] })) };
    const saved = await call(`/outapi/product/${id}`, 'PUT', edited); expect(saved.status, saved.msg).toBe(200);
    const [product] = await f.db.execute<any>(sql`SELECT stock FROM store_product WHERE id=${id}`); expect(product.stock).toBe(6);
    const after = await f.db.execute<any>(sql`SELECT suk,stock,sum_stock FROM store_product_attr_value WHERE product_id=${id} AND type=0 ORDER BY id`);
    expect(after).toEqual([{ suk: '固定', stock: 3, sum_stock: 3 }, { suk: '卡库', stock: 3, sum_stock: 3 }]);
    const [snapshot] = await f.db.execute<any>(sql`SELECT result FROM store_product_attr_result WHERE product_id=${id} AND type=0`);
    expect(JSON.parse(snapshot.result).value.map((row: any) => ({ suk: row.suk, stock: row.stock }))).toEqual([{ suk: '固定', stock: 3 }, { suk: '卡库', stock: 3 }]);
  }, 40_000);
});

import { readDetailVideo } from '@/services/product/ProductDetailDesignData';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Out product other settings and actual video policy', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>, owned: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let network: ReturnType<typeof vi.spyOn>, env: Env, token: string;
  const body = { product_type: 0, cate_id: [9], store_name: '隔离其他设置', slider_image: ['/settings.png'],
    delivery_type: [1], freight: 1, spec_type: 0, is_show: 1, attrs: [{ price: '10.00', stock: 5, bar_code: 'OUT-SETTINGS' }] };
  const call = async (path: string, method: string, data?: object, key = crypto.randomUUID(), db = f.db) => {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', createContainerFromDb(db)); await next(); }); app.onError(errorHandler);
    app.post('/outapi/product', outAuthMiddleware('POST', '/product'), productCreate);
    app.put('/outapi/product/:id', outAuthMiddleware('PUT', '/product/{id}'), productUpdate);
    app.get('/outapi/product/:id', outAuthMiddleware('GET', '/product/{id}'), productInfo);
    const response = await app.request(path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      ...(data ? { body: JSON.stringify(data) } : {}) }, env);
    return response.json() as Promise<{ status: number; msg: string; data: any }>;
  };
  beforeEach(async () => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Isolated settings forbid provider HTTP'));
    f = await createPcCheckoutQuoteFixture([], async () => { owned = await sequenceRunnerDatabase();
      try { const api = await import('drizzle-kit/api'), schema = await import('@/models/schema');
        await owned.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(schema))).join('\n'));
        await completePurchaseOriginEvidenceOrm(owned.db); await completePurchaseCancellationEvidenceOrm(owned.db); return owned;
      } catch (error) { await owned.close(); throw error; } });
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.exec(`INSERT INTO store_product_category(id,cate_name,is_show) VALUES (9,'隔离分类',1);
      INSERT INTO out_interface(id,type,method,url) VALUES (1,1,'POST','/product'),(2,1,'PUT','/product/{id}'),(3,1,'GET','/product/{id}');
      INSERT INTO out_account(id,appid,appsecret,rules) VALUES (1,'settings-local','fixture-settings-secret','[1,2,3]');
      INSERT INTO system_attachment(att_id,type,relation_id,module_type,file_type,image_type,name,att_dir,att_type) VALUES
      (901,1,0,1,2,8,'attachments/admin/1/settings.mp4','/api/assets/901','video/mp4'),
      (902,4,44,1,2,8,'attachments/supplier/44/foreign.mp4','/api/assets/902','video/mp4'),
      (903,1,0,1,1,8,'attachments/admin/1/image.png','/api/assets/903','image/png');
      SELECT setval(pg_get_serial_sequence('store_product','id'),70,true);
      SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),1,true)`);
    env = { ...f.env, APP_KEY: 'isolated-settings-key-not-real', TOKEN_BUCKET: { getByName: () => ({ consumeRateLimit: async () =>
      ({ allowed: true, auditEvent: false, limit: 120, remaining: 119, resetAt: Date.now() + 60000 }) }) } } as unknown as Env;
    token = (await createToken(1, 'out', md5('fixture-settings-secret'), env.APP_KEY)).token;
  }, 120_000);
  afterEach(async () => { try { expect(network).not.toHaveBeenCalled(); } finally { network?.mockRestore(); await f?.close(); } }, 60_000);
  const state = async () => ({ ...await f.snapshot(), receipts: await f.db.execute(sql`SELECT * FROM out_product_write_replay ORDER BY id`),
    attachments: await f.db.execute(sql`SELECT * FROM system_attachment ORDER BY att_id`) });
  const row = async (id: number) => (await f.db.select().from(storeProduct).where(eq(storeProduct.id, id)))[0];
  it('creates, replays, preserves and clears settings while the actual public policy honors the video switch', async () => {
    const key = crypto.randomUUID(), input = { ...body, mer_use: 1, command_word: ' 隔离复制😀 ', video_open: 0, video_link: '/api/assets/901?expires=1&signature=fixture' };
    const created = await call('/outapi/product', 'POST', input, key); expect(created.status, created.msg).toBe(200); const id = Number(created.data.id);
    expect((await call('/outapi/product', 'POST', input, key)).data).toMatchObject({ id, idempotent: true });
    const saved = await row(id); expect(saved).toMatchObject({ merUse: 1, commandWord: '隔离复制😀', videoOpen: 0, videoLink: '/api/assets/901', stock: 5 });
    const beforeConflict = await state(), conflict = await call('/outapi/product', 'POST', { ...input, mer_use: 0 }, key);
    expect(conflict.status).not.toBe(200); expect(conflict.msg).toContain('Idempotency-Key'); expect(await state()).toEqual(beforeConflict);
    expect(await readDetailVideo(f.db, saved)).toBe('');
    const detail = await call(`/outapi/product/${id}`, 'GET'); expect(detail.status, detail.msg).toBe(200);
    expect(detail.data.productInfo).toMatchObject({ mer_use: 1, command_word: '隔离复制😀', video_open: false });
    const enabled = { ...body, mer_use: 1, command_word: '隔离复制😀', video_open: true, video_link: '/api/assets/901' };
    const edited = await call(`/outapi/product/${id}`, 'PUT', enabled); expect(edited.status, edited.msg).toBe(200);
    expect(await readDetailVideo(f.db, await row(id))).toBe('/api/assets/901');
    const preserved = await call(`/outapi/product/${id}`, 'PUT', { ...body, video_link: '/api/assets/901' }); expect(preserved.status, preserved.msg).toBe(200);
    expect(await row(id)).toMatchObject({ merUse: 1, commandWord: '隔离复制😀', videoOpen: 1, stock: 5 });
    const cleared = await call(`/outapi/product/${id}`, 'PUT', { ...body, mer_use: 0, command_word: '', video_open: 0 }); expect(cleared.status, cleared.msg).toBe(200);
    expect(await row(id)).toMatchObject({ merUse: 0, commandWord: '', videoOpen: 0, videoLink: '', stock: 5 });
  }, 40_000);
  it.each([0, 1, 3, 4])('persists settings with fulfillment type %i without changing its SKU or delivery behavior', async type => {
    const input = { ...body, product_type: type, mer_use: true, command_word: '隔离共同设置', video_open: 0,
      attrs: [{ ...body.attrs[0], ...(type === 1 ? { disk_info: 'isolated-fixed-content' } : {}), ...(type === 4 ? { write_times: 2, write_valid: 1 } : {}) }] };
    const result = await call('/outapi/product', 'POST', input); expect(result.status, result.msg).toBe(200); const id = Number(result.data.id);
    expect(await row(id)).toMatchObject({ productType: type, merUse: 1, commandWord: '隔离共同设置', videoOpen: 0, stock: 5,
      deliveryType: type === 4 ? '2' : type === 0 ? '1' : '' });
    const skus = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, id));
    expect(skus).toHaveLength(1); expect(skus[0]).toMatchObject({ productType: type, stock: 5 });
  }, 30_000);
  it('rejects foreign, wrong-media and missing private references even for a disabled video without partial writes', async () => {
    const before = await state();
    for (const reference of ['/api/assets/902', '/api/assets/903', '/api/assets/999']) {
      const result = await call('/outapi/product', 'POST', { ...body, video_open: 0, video_link: reference });
      expect(result.status).not.toBe(200); expect(result.msg).toContain('视频'); expect(await state()).toEqual(before);
    }
  }, 40_000);
  it('rejects new invalid public video references but permits unchanged historical bytes only without explicit video intent', async () => {
    const made = await call('/outapi/product', 'POST', body); expect(made.status, made.msg).toBe(200); const id = Number(made.data.id);
    const before = await state(); const failed = await call(`/outapi/product/${id}`, 'PUT', { ...body, video_link: 'https://media.example.test/not-video.jpg' });
    expect(failed.status).not.toBe(200); expect(await state()).toEqual(before);
    await f.db.execute(sql`UPDATE store_product SET video_link='https://media.example.test/not-video.jpg' WHERE id=${id}`);
    const legacy = await call(`/outapi/product/${id}`, 'PUT', { ...body, video_link: 'https://media.example.test/not-video.jpg', command_word: 'repairing-other-fields' });
    expect(legacy.status, legacy.msg).toBe(200); expect(await readDetailVideo(f.db, await row(id))).toBe('');
    const saved = await state(), rejected = await call(`/outapi/product/${id}`, 'PUT', { ...body, video_open: 1, video_link: 'https://media.example.test/not-video.jpg' });
    expect(rejected.status).not.toBe(200); expect(await state()).toEqual(saved);
  }, 40_000);
  it.each(['settings', 'asset', 'receipt'])('rolls back the complete author on receipt-triggered %s tampering', async target => {
    const mutation = target === 'settings' ? "UPDATE store_product SET mer_use=0,command_word='tampered',video_open=1 WHERE id=NEW.product_id;"
      : target === 'asset' ? "UPDATE system_attachment SET file_type=1 WHERE att_id=901;" : "NEW.request_hash:=repeat('0',64);";
    const timing = target === 'receipt' ? 'BEFORE INSERT' : 'AFTER INSERT';
    const makeTrigger = target === 'receipt' ? 'CREATE TRIGGER' : 'CREATE CONSTRAINT TRIGGER';
    await f.exec(`CREATE FUNCTION test_settings_drift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${mutation} RETURN NEW; END $$;
      ${makeTrigger} test_settings_drift ${timing} ON out_product_write_replay ${target === 'receipt' ? '' : 'DEFERRABLE INITIALLY DEFERRED'} FOR EACH ROW EXECUTE FUNCTION test_settings_drift()`);
    const before = await state(), failed = await call('/outapi/product', 'POST', { ...body, mer_use: 1, command_word: 'isolated-original', video_open: 0, video_link: '/api/assets/901' });
    expect(failed.status).not.toBe(200); expect(await state()).toEqual(before);
  }, 30_000);
  it('refuses a real concurrent video metadata deletion and safely retries the same uncommitted request key', async () => {
    if (!owned.withPeer) throw Error('Dedicated PG16 peers required');
    const input = { ...body, mer_use: 1, video_open: 1, video_link: '/api/assets/901' }, key = crypto.randomUUID(), before = await state();
    await owned.withPeer(async peer => { await peer.exec('BEGIN'); await peer.db.execute(sql`DELETE FROM system_attachment WHERE att_id=901`);
      try { const failed = await call('/outapi/product', 'POST', input, key); expect(failed.status).not.toBe(200); expect(failed.msg).toContain('变化'); }
      finally { await peer.exec('ROLLBACK'); } });
    expect(await state()).toEqual(before); const retried = await call('/outapi/product', 'POST', input, key); expect(retried.status, retried.msg).toBe(200);
    expect((await call('/outapi/product', 'POST', input, key)).data.idempotent).toBe(true);
  }, 30_000);
  it('writes platform video settings through the unchanged restricted application LOGIN grants', async () => {
    if (!owned.withRuntimeRole) throw Error('Native restricted LOGIN required');
    await owned.withRuntimeRole(async runtime => {
      const plan = runtimeBusinessPrivilegePlan('app'), quote = (name: string) => { if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw Error('Invalid identifier'); return `"${name}"`; };
      const tables = await f.db.execute<{ name: string }>(sql`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname`);
      for (const { name } of tables) { const rights = plan.tables[name]; if (!rights) continue; await f.exec(`GRANT ${rights.join(',')} ON public.${quote(name)} TO ${quote(runtime.role)}`);
        const columns = plan.updateColumns[name]; if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(quote).join(',')}) ON public.${quote(name)} TO ${quote(runtime.role)}`); }
      const sequences = await f.db.execute<{ table_name: string; sequence_name: string | null }>(sql`SELECT c.relname AS table_name,pg_get_serial_sequence('public.'||quote_ident(c.relname),a.attname) AS sequence_name FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'`);
      for (const seq of sequences) if (seq.sequence_name && plan.tables[seq.table_name]?.includes('INSERT')) { const parts = seq.sequence_name.split('.'); if (parts.length !== 2 || parts[0] !== 'public') throw Error('Unexpected sequence'); await f.exec(`GRANT USAGE ON SEQUENCE public.${quote(parts[1])} TO ${quote(runtime.role)}`); }
      const result = await call('/outapi/product', 'POST', { ...body, mer_use: 1, command_word: 'restricted-fixture', video_open: 1, video_link: '/api/assets/901' }, crypto.randomUUID(), runtime.db);
      expect(result.status, result.msg).toBe(200); expect(await row(Number(result.data.id))).toMatchObject({ merUse: 1, videoOpen: 1, videoLink: '/api/assets/901' });
      const [rights] = await runtime.db.execute(sql`SELECT current_user=session_user AS direct_login,has_table_privilege(current_user,'public.system_config','UPDATE') AS config_write`);
      expect(rights).toEqual({ direct_login: true, config_write: false });
    });
  }, 30_000);
});

import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { runRoutinePaymentRuntimeInstallation } from '@/migrations/routinePaymentRuntime';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { applyStoreOrderBalancePayment } from '@/services/order/StoreOrderPayService';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { SupplierFulfillmentService, normalizeSupplierDeliveryInput } from '@/services/supplier/SupplierFulfillmentService';
import { orderConfirm as type2Confirm, orderDetail as type2Detail } from '@/controllers/api/v1/OrderController';
import { storeOrder, storeOrderOutbox, storeCouponIssue, storeCouponUser, storeOrderProductCouponReward, storeProductCategory, user } from '@/models/schema';
import type { OrderMessage } from '@/env';
import { assertCustomerFulfillmentReady } from '@/services/customer-work/customerFulfillmentAuthority';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Out type-two actual wallet payment and manual fulfillment', () => {
  it('creates through Out JWT, pays a real isolated balance once, grants generic coupons once and exposes only delivered buyer content', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Type-two acceptance forbids external providers'));
    const f = await refundRuntimeFixture();
    try {
      await f.db.insert(storeProductCategory).values({ id: 800001, cateName: '隔离类型二分类', isShow: 1 });
      await f.db.insert(storeCouponIssue).values({ id: 800001, couponTitle: '隔离支付赠券', couponType: 0, type: 1, couponPrice: '1.00',
        receiveType: 3, isPermanent: 1, day: 7, status: 1 });
      await f.db.update(user).set({ nowMoney: '100.00' }).where(eq(user.uid, 11));
      await f.exec(`INSERT INTO out_interface(id,type,method,url) VALUES (800001,1,'POST','/product'),(800002,1,'PUT','/product/{id}'),(800003,1,'GET','/product/{id}');
        INSERT INTO out_account(id,appid,appsecret,rules) VALUES (800001,'type-two-local','fixture-type-two-secret','[800001,800002,800003]');
        SELECT setval(pg_get_serial_sequence('store_product','id'),800010,true);
        SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),800010,true);
        SELECT setval(pg_get_serial_sequence('store_cart','id'),800010,true)`);
      const env = { ...f.env, APP_KEY: 'isolated-type-two-key-not-real', TOKEN_BUCKET: { getByName: () => ({ consumeRateLimit: async () =>
        ({ allowed: true, auditEvent: false, limit: 120, remaining: 119, resetAt: Date.now() + 60000 }) }) } } as unknown as Env;
      const token = (await createToken(800001, 'out', md5('fixture-type-two-secret'), env.APP_KEY)).token;
      if (!f.withRuntimeRole) throw Error('Owned native runtime LOGINs required');
      await f.withRuntimeRole(appRole => f.withRuntimeRole!(async adminRole => {
        const [identity] = await f.db.execute(sql`SELECT current_database() AS name`);
        const names = { app: appRole.role, admin: adminRole.role, maintenance: 'finance_test', database: String(identity.name), pricingOwner: f.pricingOwner };
        await runRuntimeBusinessCommissioning(f.db, names);
        expect((await runRoutinePaymentRuntimeInstallation(f.db, names)).after.ready).toBe(true);
        expect(await auditRuntimeBusinessPrivileges(appRole.db, 'app', names)).toMatchObject({ ready: true, failures: [] });
        const container = createContainerFromDb(appRole.db), errors: Error[] = [];
        const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
        app.use('*', async (c, next) => { c.set('container', container); c.set('uid', 11); await next(); });
        app.onError((error,c) => { errors.push(error); return errorHandler(error,c); });
        app.post('/outapi/product', outAuthMiddleware('POST', '/product'), productCreate);
        app.get('/outapi/product/:id', outAuthMiddleware('GET', '/product/{id}'), productInfo);
        app.post('/api/order/confirm', type2Confirm); app.get('/api/order/detail/:uni', type2Detail);
        const post = async (path: string, body: object, key = crypto.randomUUID()) => {
          const response = await app.request(path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) }, env);
          return response.json() as Promise<{ status: number; msg: string; data: any }>;
        };
        const input = { product_type: 2, cate_id: [800001], store_name: '历史类型二兑换商品', slider_image: ['/type-two.png'],
          spec_type: 0, is_show: 1, coupon_ids: [800001], is_sub: [], attrs: [{ price: '10.00', stock: 5, bar_code: 'TYPE-TWO' }] };
        const key = crypto.randomUUID(), created = await post('/outapi/product', input, key);
        expect(created.status, JSON.stringify({ created, errors: errors.map(e => ({message:e.message,cause:e.cause})) })).toBe(200);
        const id = Number(created.data.id); expect((await post('/outapi/product', input, key)).data.idempotent).toBe(true);
        const [sku] = await appRole.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, id));
        expect(sku.productType).toBe(2); const cart = await new StoreCartService(container, env).add({ uid: 11, productId: id, unique: sku.unique, cartNum: 1, isNew: 1 });
        const selection = { cartIds: [cart.id], shippingType: 1, useIntegral: false };
        const confirmed = await post('/api/order/confirm', selection); expect(confirmed.status, JSON.stringify({confirmed,errors:errors.map(e=>e.message)})).toBe(200);
        const order = await StoreOrderCreateService.createWithRuntime(container, { CONFIG_KV: env.CONFIG_KV, requireConfirmation: true,
          requirePurchaseOrigin: true, nextOrderId: async () => 'type_two_isolated_order' }, { ...selection, uid: 11,
          key: confirmed.data.orderKey, quoteToken: confirmed.data.quoteToken, userIp: '127.0.0.1' });
        const detail = async () => {
          const response = await app.request(`/api/order/detail/${order.orderId}`, {}, env);
          const result = await response.json() as {status:number;msg:string;data:any}; expect(result.status,result.msg).toBe(200); return result;
        };
        expect((await detail()).data.fictitiousContent).toBe('');
        const paid = await applyStoreOrderBalancePayment(container, { uid: 11, orderId: order.orderId, routineNotice: env });
        expect(paid.outcome).toBe('paid'); expect(paid.outbox).not.toBeNull();
        expect((await applyStoreOrderBalancePayment(container, { uid: 11, orderId: order.orderId })).outcome).toBe('already-paid');
        const queue = { send: vi.fn(async()=>{}), sendBatch: vi.fn(async()=>({successful:1})) };
        const consumer = new OrderOutboxService(container, { ORDER_QUEUE: queue as unknown as Queue<OrderMessage>, APP_KEY: env.APP_KEY });
        const message = { action:'processOrderPaidOutbox' as const, outboxId: paid.outbox!.id, eventKey: paid.outbox!.eventKey };
        expect(await consumer.processMessage(message)).toBe('completed'); expect(await consumer.processMessage(message)).toBe('already-completed');
        const [pending] = await appRole.db.select().from(storeOrder).where(eq(storeOrder.orderId, order.orderId));
        expect(pending).toMatchObject({ productType: 2, paid: 1, status: 0, payPrice: '10.00', payPostage: '0.00' });
        await assertCustomerFulfillmentReady(appRole.db, {root:pending,order:pending}, 'manual', undefined, false);
        for (const mode of ['split','electronic','city'] as const)
          await expect(assertCustomerFulfillmentReady(appRole.db,{root:pending,order:pending},mode,undefined,false)).rejects.toThrow('须整单虚拟交付');
        expect((await appRole.db.select().from(user).where(eq(user.uid, 11)))[0].nowMoney).toBe('90.00');
        expect(await appRole.db.select().from(storeOrderProductCouponReward)).toHaveLength(1);
        expect((await appRole.db.select().from(storeCouponUser)).filter(row=>row.issueCouponId===800001)).toHaveLength(1);
        expect((await detail()).data.fictitiousContent).toBe('');
        const fulfillment = new SupplierFulfillmentService(container, env), content = '隔离兑换说明：请凭本订单核对已赠优惠券';
        await expect(fulfillment.deliver(0,pending.id,normalizeSupplierDeliveryInput({delivery_type:'express',delivery_name:'Local',delivery_code:'local',delivery_id:'NO-REAL-SHIPMENT'}),{expectedStoreId:0})).rejects.toThrow('只能使用虚拟交付');
        const delivered = await fulfillment.deliver(0,pending.id,normalizeSupplierDeliveryInput({delivery_type:'fictitious',fictitious_content:content}),{expectedStoreId:0});
        expect(delivered.idempotent).toBe(false);
        await expect(fulfillment.deliver(0,pending.id,normalizeSupplierDeliveryInput({delivery_type:'fictitious',fictitious_content:content}),{expectedStoreId:0})).rejects.toThrow();
        const visible = await detail(); expect(visible.status,visible.msg).toBe(200); expect(visible.data.fictitiousContent).toBe(content);
        await expect(new StoreOrderCreateService(container,env).detail(22,order.orderId)).rejects.toThrow('订单不存在');
        expect((await appRole.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id,paid.outbox!.id)))[0].status).toBe('COMPLETED');
        expect(queue.send).not.toHaveBeenCalled(); expect(queue.sendBatch).not.toHaveBeenCalled();
      }));
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); await f.close(); }
  }, 180_000);
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Out historical type-two author and inventory', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>, token: string, env: Env, network: ReturnType<typeof vi.spyOn>;
  const body = { product_type: 2, cate_id: [9], brand_id: [30,31], ensure_id: [91], store_label_id: [101], label_id: [201],
    specs_id: 301, specs: [{name:'权益说明',value:'通用赠券'}], coupon_ids:[9001], custom_form:[], system_form_id:0,
    store_name:'历史类型二多规格',slider_image:['/type-two.png'],spec_type:1,is_show:1,
    items:[{value:'档位',detail:['甲','乙']}],attrs:[
      {suk:'甲',detail:{档位:'甲'},price:'10.00',stock:3,bar_code:'LEGACY-A'},
      {suk:'乙',detail:{档位:'乙'},price:'20.00',stock:7,bar_code:'LEGACY-B'}] };
  const call = async (path:string, method:string, data:object, key=crypto.randomUUID()) => {
    const app = new Hono<{Bindings:Env;Variables:AppVariables}>(); app.use('*',async(c,next)=>{c.set('container',f.container);await next();});app.onError(errorHandler);
    app.post('/outapi/product',outAuthMiddleware('POST','/product'),productCreate);
    app.put('/outapi/product/stock/upload',outAuthMiddleware('PUT','/product/stock/upload'),productStockUpload);
    app.put('/outapi/product/:id',outAuthMiddleware('PUT','/product/{id}'),productUpdate);
    const response=await app.request(path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(data)},env);
    return response.json() as Promise<{status:number;msg:string;data:any}>;
  };
  beforeEach(async()=>{
    network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Isolated type-two author forbids providers'));
    f=await createPcCheckoutQuoteFixture([],async()=>{const owned=await sequenceRunnerDatabase();try{
      const api=await import('drizzle-kit/api'),schema=await import('@/models/schema');
      await owned.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson(schema))).join('\n'));
      await completePurchaseOriginEvidenceOrm(owned.db);await completePurchaseCancellationEvidenceOrm(owned.db);return owned;
    }catch(error){await owned.close();throw error;}});
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key=>[key,'0'])));
    await f.exec(`INSERT INTO store_product_category(id,cate_name,is_show) VALUES(9,'隔离分类',1);
      INSERT INTO store_brand(id,brand_name,pid,is_show) VALUES(30,'父品牌',0,1),(31,'子品牌',30,1);
      INSERT INTO store_product_ensure(id,name,status) VALUES(91,'隔离保障',1);
      INSERT INTO category(id,"group",name,is_show) VALUES(300,2,'标签组',1),(301,3,'参数模板',1);
      INSERT INTO store_product_label(id,label_name,label_cate,status,is_show) VALUES(101,'商品标签',300,1,1);
      INSERT INTO user_label(id,name,status) VALUES(201,'用户标签',1);
      INSERT INTO store_coupon_issue(id,coupon_title,coupon_type,type,coupon_price,receive_type,is_permanent,day,status) VALUES(9001,'通用赠券',0,1,'1.00',3,1,7,1);
      INSERT INTO out_interface(id,type,method,url) VALUES(1,1,'POST','/product'),(2,1,'PUT','/product/{id}'),(3,1,'PUT','/product/stock/upload');
      INSERT INTO out_account(id,appid,appsecret,rules) VALUES(1,'type-two-author','fixture-type-two-author','[1,2,3]');
      SELECT setval(pg_get_serial_sequence('store_product','id'),70,true);
      SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),1,true)`);
    env={...f.env,APP_KEY:'isolated-type-two-author-key',TOKEN_BUCKET:{getByName:()=>({consumeRateLimit:async()=>({allowed:true,auditEvent:false,limit:120,remaining:119,resetAt:Date.now()+60000})})}} as unknown as Env;
    token=(await createToken(1,'out',md5('fixture-type-two-author'),env.APP_KEY)).token;
  },120_000);
  afterEach(async()=>{try{expect(network).not.toHaveBeenCalled();}finally{network?.mockRestore();await f?.close();}},60_000);
  const state=async()=>({...await f.snapshot(),relations:await f.db.execute(sql`SELECT * FROM store_product_relation ORDER BY id`),
    coupons:await f.db.execute(sql`SELECT * FROM store_product_coupon ORDER BY id`),replays:await f.db.execute(sql`SELECT * FROM out_product_write_replay ORDER BY id`),
    records:await f.db.execute(sql`SELECT * FROM store_product_stock_record ORDER BY id`),attrs:await f.db.execute(sql`SELECT * FROM store_product_attr ORDER BY id`),
    snapshots:await f.db.execute(sql`SELECT * FROM store_product_attr_result ORDER BY id`),descriptions:await f.db.execute(sql`SELECT * FROM store_product_description ORDER BY product_id,type`)});
  it('creates and edits complete multi-SKU type-two products, preserves inventory, clears coupons and synchronizes exact barcodes',async()=>{
    const key=crypto.randomUUID(),made=await call('/outapi/product','POST',body,key);expect(made.status,made.msg).toBe(200);const id=Number(made.data.id);
    expect((await call('/outapi/product','POST',body,key)).data).toMatchObject({id,idempotent:true});
    const links=await f.db.execute(sql`SELECT type,relation_id FROM store_product_relation WHERE product_id=${id} ORDER BY type`);
    expect(links).toEqual([{type:1,relation_id:9},{type:2,relation_id:30},{type:2,relation_id:31},{type:3,relation_id:101},{type:4,relation_id:201},{type:5,relation_id:91},{type:6,relation_id:301}]);
    const before=await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId,id)).orderBy(storeProductAttrValue.id);
    expect(before.map(s=>({suk:s.suk,stock:s.stock,productType:s.productType}))).toEqual([{suk:'甲',stock:3,productType:2},{suk:'乙',stock:7,productType:2}]);
    const edit={...body,coupon_ids:[],attrs:body.attrs.map((s,i)=>({...s,unique:before[i].unique,stock:999}))};
    const saved=await call(`/outapi/product/${id}`,'PUT',edit);expect(saved.status,saved.msg).toBe(200);expect(saved.data.stock_preserved).toBe(true);
    expect(await f.db.execute(sql`SELECT id FROM store_product_coupon WHERE product_id=${id}`)).toEqual([]);
    const stockKey=crypto.randomUUID(),stockBody={items:[{bar_code:'LEGACY-A',qty:8}]};
    const synced=await call('/outapi/product/stock/upload','PUT',stockBody,stockKey);expect(synced.status,synced.msg).toBe(200);
    const after=await state();expect((await call('/outapi/product/stock/upload','PUT',stockBody,stockKey)).data.idempotent).toBe(true);expect(await state()).toEqual(after);
    expect(after.products.find(p=>p.id===id)).toMatchObject({productType:2,stock:15,freight:2,tempId:0,postage:'0.00',deliveryType:''});
    expect(after.skus.filter(s=>s.productId===id).sort((a,b)=>a.id-b.id).map(s=>({suk:s.suk,stock:s.stock}))).toEqual([{suk:'甲',stock:8},{suk:'乙',stock:7}]);
    await f.db.update(storeProductAttrValue).set({barCode:'LEGACY-A'}).where(eq(storeProductAttrValue.id,1));
    const ambiguous=await state(),failed=await call('/outapi/product/stock/upload','PUT',{items:[{bar_code:'LEGACY-A',qty:6}]});
    expect(failed.status).not.toBe(200);expect(failed.msg).toContain('存在重复');expect(await state()).toEqual(ambiguous);
  },40_000);
  it.each(['product','sku','receipt'])('rolls back the entire type-two author on %s tampering',async target=>{
    const mutation=target==='product'?'UPDATE store_product SET product_type=3 WHERE id=NEW.product_id;':target==='sku'?'UPDATE store_product_attr_value SET product_type=0 WHERE product_id=NEW.product_id;':"NEW.request_hash:=repeat('0',64);";
    await f.exec(`CREATE FUNCTION test_type_two_drift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${mutation} RETURN NEW; END $$;
      ${target==='receipt'?'CREATE TRIGGER':'CREATE CONSTRAINT TRIGGER'} test_type_two_drift ${target==='receipt'?'BEFORE':'AFTER'} INSERT ON out_product_write_replay ${target==='receipt'?'':'DEFERRABLE INITIALLY DEFERRED'} FOR EACH ROW EXECUTE FUNCTION test_type_two_drift()`);
    const before=await state(),failed=await call('/outapi/product','POST',body);expect(failed.status).not.toBe(200);expect(await state()).toEqual(before);
  },30_000);
  it('refuses changed fulfillment types, foreign SKU identities and non-platform historical owners without side effects',async()=>{
    const made=await call('/outapi/product','POST',body);expect(made.status,made.msg).toBe(200);const id=Number(made.data.id),before=await state();
    const changed=await call(`/outapi/product/${id}`,'PUT',{...body,product_type:3});expect(changed.status).not.toBe(200);expect(await state()).toEqual(before);
    const wrong=await call(`/outapi/product/${id}`,'PUT',{...body,attrs:body.attrs.map(s=>({...s,unique:'qared001'}))});expect(wrong.status).not.toBe(200);expect(await state()).toEqual(before);
    await f.db.update(storeProduct).set({type:2,relationId:77}).where(eq(storeProduct.id,id));const foreign=await state();
    const denied=await call(`/outapi/product/${id}`,'PUT',body);expect(denied.status).not.toBe(200);expect(await state()).toEqual(foreign);
  },30_000);
});
