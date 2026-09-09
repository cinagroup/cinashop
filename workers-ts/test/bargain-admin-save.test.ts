import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { adminActivitySave, adminActivityStatus } from '../src/controllers/api/v1/AdminCrudController';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { storeBargain, storeSeckill, storeCombination, storeIntegral } from '../src/models/schema';

describe('bargain admin edits preserve existing business data', () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  beforeEach(async () => {
    f = await createBargainSelectionFixture([storeSeckill, storeCombination, storeIntegral]);
    await f.db.update(storeBargain).set({ storeName: '原名称', sales: 3, addTime: 123, quotaShow: 20 }).where(eq(storeBargain.id, 40));
  }, 30_000);
  afterEach(async () => { await f?.close(); });
  const request = async (body: unknown, path = 'save') => {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', f.container); await next(); });
    app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    app.post('/save', adminActivitySave); app.post('/status', adminActivityStatus);
    return (await app.request('/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, f.env)).json();
  };
  const snapshot = async () => ({ ...await f.snapshot(), sequences: undefined });

  it('edits only supplied fields without resetting stock, quota, sales, people, product, price or creation time', async () => {
    const before = await snapshot();
    expect(await request({ type: 'bargain', id: 40, storeName: '新名称' })).toMatchObject({ status: 200, data: { id: 40 } });
    expect(await snapshot()).toEqual({ ...before, bargains: before.bargains.map(row => ({ ...row, storeName: '新名称' })) });
  });
  it('allows a no-op edit without rewriting any business field', async () => {
    const before = await snapshot();
    expect(await request({ type: 'bargain', id: 40 })).toMatchObject({ status: 200 });
    expect(await snapshot()).toEqual(before);
  });
  it('updates stock and quota only with their unchanged original values, preserving sales and quotaShow unless quota changes', async () => {
    const before = await snapshot();
    expect(await request({ type: 'bargain', id: 40, stock: 12, expected: { stock: 8, quota: 8 } })).toMatchObject({ status: 200 });
    expect(await snapshot()).toEqual({ ...before, bargains: before.bargains.map(row => ({ ...row, stock: 12 })) });
  });
  it.each([
    { stock: 9 }, { quota: 7 }, { stock: 9, expected: { stock: 9, quota: 8 } },
    { stock: 7, expected: { stock: 8, quota: 8 } }, { quota: 9, expected: { stock: 8, quota: 8 } },
    { sales: 0 }, { addTime: 0 }, { isDel: 0 }, { quotaShow: 10 },
    { price: '-1.00' }, { price: '1.001' }, { minPrice: '11.00' }, { people: 0 },
    { stock: -1 }, { stock: 1.5 }, { num: 0 }, { status: 2 }, { storeName: '' },
    { productId: 0 }, { price: null }, { expected: [] },
  ])('rejects invalid or stale edit %j without partial writes', async patch => {
    const before = await snapshot();
    expect(await request({ type: 'bargain', id: 40, ...patch })).toMatchObject({ status: 400 });
    expect(await snapshot()).toEqual(before);
  });
  it.each([0, -1, 1.5, '40', 2147483648, 999])('rejects malformed/missing record %s', async id => {
    const before = await snapshot();
    expect(await request({ type: 'bargain', id, storeName: '不可保存' })).toMatchObject({ status: 400 });
    expect(await snapshot()).toEqual(before);
  });
  it.each(['save', 'status'])('does not modify a retired activity through %s', async path => {
    await f.db.update(storeBargain).set({ isDel: 1 });
    const before = await snapshot();
    expect(await request({ type: 'bargain', id: 40, status: 0 }, path)).toMatchObject({ status: 400 });
    expect(await snapshot()).toEqual(before);
  });
  it.each([null, -1, 2, '1', true])('rejects malformed status %s without changing state', async status => {
    const before = await snapshot();
    expect(await request({ type: 'bargain', id: 40, status }, 'status')).toMatchObject({ status: 400 });
    expect(await snapshot()).toEqual(before);
  });
  it('changes only status and can re-enable a non-retired activity', async () => {
    const before = await snapshot();
    expect(await request({ type: 'bargain', id: 40, status: 0 }, 'status')).toMatchObject({ status: 200 });
    expect(await snapshot()).toEqual({ ...before, bargains: before.bargains.map(row => ({ ...row, status: 0 })) });
    expect(await request({ type: 'bargain', id: 40, status: 1 }, 'status')).toMatchObject({ status: 200 });
    expect(await snapshot()).toEqual(before);
  });
  it('creates a basic activity with validated submitted rules and zero sales', async () => {
    const response = await request({ type: 'bargain', productId: 70, storeName: '新活动', price: '10', minPrice: '2.5',
      stock: 12, quota: 9, people: 3, num: 2, status: 0, startTime: f.startTime.toISOString(), stopTime: f.stopTime.toISOString() });
    expect(response).toMatchObject({ status: 200 });
    const rows = await f.db.select().from(storeBargain).where(eq(storeBargain.storeName, '新活动'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ productId: 70, price: '10.00', minPrice: '2.50', stock: 12, quota: 9,
      quotaShow: 9, people: 3, num: 2, sales: 0, status: 0, isDel: 0 });
    expect(rows[0].addTime).toBeGreaterThan(0);
  });
  it('updates explicitly submitted rules and quota without resetting their unrelated fields', async () => {
    const before = await snapshot();
    expect(await request({ type: 'bargain', id: 40, people: 3, num: 2, minPrice: '3.00', quota: 6,
      expected: { stock: 8, quota: 8 } })).toMatchObject({ status: 200 });
    expect(await snapshot()).toEqual({ ...before, bargains: before.bargains.map(row => ({ ...row,
      people: 3, num: 2, minPrice: '3.00', quota: 6, quotaShow: 6 })) });
  });
  it.each([{ productId: 999 }, { price: '0.00' }, { people: 801 }, { quota: 101 }, { minPrice: '10.00' }])('rejects invalid basic creation %j', async patch => {
    const before = await snapshot();
    expect(await request({ type: 'bargain', productId: 70, storeName: '新建', price: '10.00', minPrice: '2.00',
      startTime: f.startTime.toISOString(), stopTime: f.stopTime.toISOString(), ...patch })).toMatchObject({ status: 400 });
    expect(await snapshot()).toEqual(before);
  });
  it.each(['save', 'status'])('rolls back an injected database failure after %s writes', async path => {
    await f.db.execute(sql.raw(`CREATE FUNCTION qa_edit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'isolated edit failure'; END $$;
      CREATE TRIGGER qa_edit_failure AFTER UPDATE ON store_bargain FOR EACH ROW EXECUTE FUNCTION qa_edit_failure()`));
    const before = await snapshot();
    expect(await request({ type: 'bargain', id: 40, status: 0 }, path)).toMatchObject({ status: 400 });
    expect(await snapshot()).toEqual(before);
  });
  it.each(['save', 'status'])('bounds the shared %s body before any write', async path => {
    const before = await snapshot();
    expect(await request({ type: 'bargain', id: 40, status: 0, padding: 'x'.repeat(65_536) }, path)).toMatchObject({ status: 400, msg: '请求数据不能超过64 KiB' });
    expect(await snapshot()).toEqual(before);
  });
  it.each(['seckill', 'combination', 'integral'] as const)('keeps valid shared-dispatch %s create/status working', async type => {
    expect(await request({ type, productId: 70, storeName: '其他活动', price: '10.00', stock: 9, quota: 9, status: 0 })).toMatchObject({ status: 200 });
    const table = { seckill: storeSeckill, combination: storeCombination, integral: storeIntegral }[type];
    const [row] = await f.db.select().from(table);
    expect(row).toMatchObject({ stock: 9, quota: 9, sales: 0, status: 0 });
    expect(await request({ type, id: row.id, status: 1 }, 'status')).toMatchObject({ status: 200 });
    expect((await f.db.select().from(table))[0]).toMatchObject({ stock: 9, quota: 9, sales: 0, status: 1 });
  });
});
