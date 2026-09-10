import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray, sql } from 'drizzle-orm';
import { PostgresJsPreparedQuery } from 'drizzle-orm/postgres-js';
import type { PreparedQueryConfig } from 'drizzle-orm/pg-core';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import { productStockUpload } from '../src/controllers/out/OutApiController';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
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
    { name: 'nonphysical product', product: { productType: 1 }, sku: {} },
    { name: 'another nonphysical product', product: { productType: 3 }, sku: {} },
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
});
