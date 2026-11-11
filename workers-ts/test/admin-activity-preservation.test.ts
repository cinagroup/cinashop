import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import {
  adminActivityDel,
  adminActivitySave,
  adminActivityStatus,
  adminCombinationList,
  adminIntegralList,
  adminSeckillList,
} from '../src/controllers/api/v1/AdminCrudController';
import { storeCombination, storeIntegral, storeSeckill } from '../src/models/schema';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';

const activityTables = { seckill: storeSeckill, combination: storeCombination, integral: storeIntegral };
type ActivityType = keyof typeof activityTables;

describe('admin activity edits and retirement preserve existing records', () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;

  beforeEach(async () => {
    f = await createBargainSelectionFixture(Object.values(activityTables));
    await f.db.insert(storeSeckill).values({ id: 501, productId: 70, storeName: '原秒杀', timeId: '7,8',
      price: '12.00', stock: 6, quota: 9, quotaShow: 6, sales: 3, addTime: 123, status: 1 });
    await f.db.insert(storeCombination).values({ id: 502, productId: 70, storeName: '原拼团', people: 5,
      price: '13.00', stock: 6, quota: 9, quotaShow: 6, sales: 3, addTime: 124, status: 1 });
    await f.db.insert(storeIntegral).values({ id: 503, productId: 70, storeName: '原积分', integral: 120,
      price: '14.00', stock: 6, quota: 9, quotaShow: 6, sales: 3, addTime: 125, status: 1 });
  }, 30_000);
  afterEach(async () => { await f?.close(); });

  function app() {
    const http = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    http.use('*', async (c, next) => { c.set('container', f.container); await next(); });
    http.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    http.post('/activity/save', adminActivitySave);
    http.post('/activity/status', adminActivityStatus);
    http.delete('/activity/del/:type/:id', adminActivityDel);
    http.get('/activity/seckill', adminSeckillList);
    http.get('/activity/combination', adminCombinationList);
    http.get('/activity/integral', adminIntegralList);
    return http;
  }
  async function request(path: string, method = 'GET', body?: unknown) {
    return (await app().request(path, { method, ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }) }, f.env)).json() as Promise<{ status: number; msg?: string; data: unknown }>;
  }
  async function row(type: ActivityType, id: number) {
    const table = activityTables[type];
    const [found] = await f.db.select().from(table).where(eq(table.id, id));
    return found;
  }

  it.each([
    ['seckill', 501], ['integral', 503],
  ] as const)('editing %s preserves sales, creation time, and omitted fields', async (type, id) => {
    const before = await row(type, id);
    expect(await request('/activity/save', 'POST', { type, id, storeName: '新名称' })).toMatchObject({ status: 200 });
    expect(await row(type, id)).toEqual({ ...before, storeName: '新名称' });
  });

  it('rejects abbreviated combination creation, editing, status and deletion before any transaction or DML', async () => {
    const before = await row('combination', 502);
    const transaction = vi.spyOn(f.container.db, 'transaction');
    const insert = vi.spyOn(f.container.db, 'insert');
    const update = vi.spyOn(f.container.db, 'update');
    const remove = vi.spyOn(f.container.db, 'delete');
    try {
      for (const [path, method, body] of [
        ['/activity/save', 'POST', { type: 'combination', productId: 70, storeName: '简化创建' }],
        ['/activity/save', 'POST', { type: 'combination', id: 502, quota: 100 }],
        ['/activity/status', 'POST', { type: 'combination', id: 502, status: 0 }],
        ['/activity/del/combination/502', 'DELETE', undefined],
      ] as const) expect(await request(path, method, body)).toMatchObject({ status: 400, msg: '请使用完整拼团管理接口' });
      expect(transaction).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
      expect(await row('combination', 502)).toEqual(before);
      expect(await request('/activity/combination')).toMatchObject({ status: 200, data: [expect.objectContaining({ id: 502 })] });
    } finally { transaction.mockRestore(); insert.mockRestore(); update.mockRestore(); remove.mockRestore(); }
  });

  it('a seckill form submission without timeId preserves its existing slots and business history', async () => {
    const before = await row('seckill', 501);
    const response = await request('/activity/save', 'POST', {
      type: 'seckill', id: 501, productId: 70, storeName: '新秒杀', image: '', price: '12.00',
      otPrice: '0.00', stock: 6, quota: 9, num: 2, sort: 90, status: 1,
    });
    expect(response).toMatchObject({ status: 200 });
    expect(await row('seckill', 501)).toMatchObject({ id: 501, storeName: '新秒杀', timeId: '7,8',
      sales: before.sales, addTime: before.addTime, quotaShow: before.quotaShow });
  });

  it.each([
    ['seckill', 501], ['integral', 503],
  ] as const)('retiring %s marks only isDel, hides it from admin list and preserves the row', async (type, id) => {
    const before = await row(type, id);
    expect(await request(`/activity/del/${type}/${id}`, 'DELETE')).toMatchObject({ status: 200 });
    expect(await row(type, id)).toEqual({ ...before, isDel: 1 });
    expect(await request(`/activity/${type}`)).toMatchObject({ status: 200, data: [] });
    expect(await request(`/activity/del/${type}/${id}`, 'DELETE')).toMatchObject({ status: 200 });
    expect(await row(type, id)).toEqual({ ...before, isDel: 1 });
  });

  it.each([
    ['seckill', 501], ['integral', 503],
  ] as const)('cannot edit or re-enable retired %s activity', async (type, id) => {
    await request(`/activity/del/${type}/${id}`, 'DELETE');
    const before = await row(type, id);
    expect(await request('/activity/save', 'POST', { type, id, storeName: '不可恢复' })).toMatchObject({ status: 400 });
    expect(await request('/activity/status', 'POST', { type, id, status: 1 })).toMatchObject({ status: 400 });
    expect(await row(type, id)).toEqual(before);
  });

  it.each([
    ['seckill', 501], ['combination', 502], ['integral', 503],
  ] as const)('rejects missing and malformed %s IDs before changing existing data', async (type, id) => {
    const before = await row(type, id);
    expect(await request('/activity/save', 'POST', { type, id: 999, storeName: '无目标' }))
      .toMatchObject({ status: 400 });
    expect(await request('/activity/save', 'POST', { type, id: '501', storeName: '错误类型' }))
      .toMatchObject({ status: 400 });
    expect(await request(`/activity/del/${type}/999`, 'DELETE')).toMatchObject({ status: 400 });
    expect(await request(`/activity/del/${type}/00${id}`, 'DELETE')).toMatchObject({ status: 400 });
    expect(await row(type, id)).toEqual(before);
  });

  it.each(['2', 1.5, -1, 2_147_483_648, null, 0])('rejects invalid or underflowing quota %s without rewriting the activity', async quota => {
    const before = await row('seckill', 501);
    expect(await request('/activity/save', 'POST', { type: 'seckill', id: 501, quota }))
      .toMatchObject({ status: 400 });
    expect(await row('seckill', 501)).toEqual(before);
  });

  it('rejects quotaShow overflow instead of corrupting the activity', async () => {
    await f.db.update(storeSeckill).set({ quota: 0, quotaShow: 2_147_483_647 }).where(eq(storeSeckill.id, 501));
    const before = await row('seckill', 501);
    expect(await request('/activity/save', 'POST', { type: 'seckill', id: 501, quota: 1 }))
      .toMatchObject({ status: 400 });
    expect(await row('seckill', 501)).toEqual(before);
  });

  it.each(['__proto__', 'toString', 'unknown'])('rejects unsupported activity type %s without modifying data', async type => {
    const before = await row('seckill', 501);
    expect(await request('/activity/save', 'POST', { type, id: 501, storeName: '坏类型' }))
      .toMatchObject({ status: 400, msg: '未知活动类型' });
    expect(await request('/activity/status', 'POST', { type, id: 501, status: 0 }))
      .toMatchObject({ status: 400, msg: '未知活动类型' });
    expect(await request(`/activity/del/${type}/501`, 'DELETE'))
      .toMatchObject({ status: 400, msg: '未知活动类型' });
    expect(await row('seckill', 501)).toEqual(before);
  });

  it.each(['501', 0, -1, 1.5, 2_147_483_648])('rejects malformed status ID %s without changing the activity', async id => {
    const before = await row('seckill', 501);
    expect(await request('/activity/status', 'POST', { type: 'seckill', id, status: 0 }))
      .toMatchObject({ status: 400, msg: '参数错误' });
    expect(await row('seckill', 501)).toEqual(before);
  });
});

// This independent native suite exercises the Out author and the existing
// recommendation consumer against the same committed product and real PG16.
import { sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeBargain, storeProduct, storeProductAttrValue, storeProductCategory, storeProductRelation, outProductWriteReplay } from '@/models/schema';
import { productCreate, productInfo, productUpdate } from '@/controllers/out/OutApiController';
import { RecommendationNavigationService } from '@/services/product/RecommendationNavigationService';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { completePurchaseOriginEvidenceOrm } from '@/migrations/runPurchaseOriginEvidence';
import { completePurchaseCancellationEvidenceOrm } from '@/migrations/runPurchaseCancellationEvidence';
import { runtimeBusinessPrivilegePlan } from '@/migrations/runtimeBusinessPrivilegePlan';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Out activity order and actual recommendation navigation on owned PG16', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let owned: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let network: ReturnType<typeof vi.spyOn>;
  const body = { product_type: 0, supplier_id: 0, cate_id: [9], store_name: 'Out activity product',
    slider_image: ['/isolated.png'], delivery_type: [1], freight: 3, temp_id: 10, spec_type: 1, is_show: 1,
    items: [{ value: '颜色', detail: ['红色'] }, { value: '尺码', detail: ['大号'] }],
    attrs: [{ suk: '红色,大号', detail: { 颜色: '红色', 尺码: '大号' }, unique: 'qared001', price: '10.00', stock: 999, bar_code: 'OUT-A' }] };
  const app = (db: DbClient) => {
    const a = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    a.use('*', async (c, next) => { c.set('container', createContainerFromDb(db));
      c.set('outInfo', { id: 7, appid: 'isolated-out-activity', title: 'isolated', rules: [] }); await next(); });
    a.onError((e, c) => c.json({ status: 400, msg: e.message, data: null }));
    a.post('/outapi/product', productCreate); a.put('/outapi/product/:id', productUpdate); a.get('/outapi/product/:id', productInfo);
    return a;
  };
  beforeEach(async () => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Out activity acceptance forbids external I/O'));
    f = await createPcCheckoutQuoteFixture([], async () => {
      owned = await sequenceRunnerDatabase();
      try { const api = await import('drizzle-kit/api'), schema = await import('@/models/schema');
        await owned.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(schema))).join('\n'));
        await completePurchaseOriginEvidenceOrm(owned.db); await completePurchaseCancellationEvidenceOrm(owned.db); return owned;
      } catch (error) { await owned.close(); throw error; }
    });
    await f.db.insert(storeProductCategory).values({ id: 9, cateName: 'isolated', isShow: 1 });
    await f.db.update(storeProduct).set({ cateId: '9', specType: 1 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ barCode: 'OUT-A' }).where(eq(storeProductAttrValue.id, 1));
    await f.db.insert(storeProductRelation).values({ productId: 70, relationId: 9, type: 1, status: 1 });
  }, 120_000);
  afterEach(async () => { try { expect(network).not.toHaveBeenCalled(); } finally { network?.mockRestore(); await f?.close(); } }, 120_000);
  const request = async (db: DbClient, data?: object, key = crypto.randomUUID(), path = '/outapi/product/70', method = 'PUT') => {
    const response = await app(db).request(path, { method, headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
      ...(data ? { body: JSON.stringify(data) } : {}) }, f.env);
    return response.json() as Promise<{ status: number; msg: string; data: any }>;
  };
  const state = async () => ({ ...await f.snapshot(), replays: await f.db.select().from(outProductWriteReplay), relations: await f.db.select().from(storeProductRelation) });

  it('persists create and update, replays exactly, projects the detail and drives real navigation', async () => {
    const now = new Date('2026-09-21T02:00:00Z');
    await f.db.insert(storeBargain).values({ id: 1000, productId: 70, title: '测试砍价', startTime: now, stopTime: new Date('2026-09-21T03:00:00Z') });
    const key = crypto.randomUUID(), data = { ...body, activity: ['砍价', '默认', '秒杀', '拼团'] };
    const result = await request(f.db, data, key); expect(result.status, result.msg).toBe(200);
    const [row] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)); expect(row.activity).toBe('2,0,1,3');
    const target = await new RecommendationNavigationService(createContainerFromDb(f.db)).decorate([{ id: 70, activity: row.activity, is_presale_product: 0 }], now);
    expect(target[0].recommendation_target).toMatchObject({ kind: 'bargain', id: 1000 });
    const detail = await request(f.db, undefined, crypto.randomUUID(), '/outapi/product/70', 'GET');
    expect(detail.status, detail.msg).toBe(200); expect(detail.data.productInfo.activity).toEqual(['砍价', '默认', '秒杀', '拼团']);
    const saved = await state(); expect((await request(f.db, data, key)).data.idempotent).toBe(true); expect(await state()).toEqual(saved);
    expect((await request(f.db, body)).status).toBe(200);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0].activity).toBe('2,0,1,3');
    expect((await request(f.db, { ...body, activity: [] })).status).toBe(200);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0].activity).toBe('');
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product','id'),70,true); SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),1,true)");
    const created = await request(f.db, { ...body, activity: ['拼团', '默认'] }, crypto.randomUUID(), '/outapi/product', 'POST');
    expect(created.status, created.msg).toBe(200);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, created.data.id)))[0].activity).toBe('3,0');
  }, 30_000);

  it('rejects ambiguous orders and rolls back receipt and product on deferred mutation', async () => {
    const before = await state();
    const invalid = await request(f.db, { ...body, activity: ['秒杀', '秒杀'] });
    expect(invalid.status).not.toBe(200); expect(await state()).toEqual(before);
    for (const mutation of ["activity='1'", 'activity=activity']) {
      await f.exec(`CREATE FUNCTION test_out_activity_damage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE store_product SET ${mutation} WHERE id=70; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER test_out_activity_damage AFTER INSERT ON out_product_write_replay DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_out_activity_damage()`);
      const failed = await request(f.db, { ...body, activity: ['砍价', '默认'] });
      expect(failed.status).not.toBe(200); expect(await state()).toEqual(before);
      await f.exec('DROP TRIGGER test_out_activity_damage ON out_product_write_replay; DROP FUNCTION test_out_activity_damage()');
    }
  }, 30_000);

  it('saves and reads with existing restricted App privileges', async () => {
    if (!owned.withRuntimeRole) throw Error('Native restricted LOGIN required');
    await owned.withRuntimeRole(async runtime => {
      const plan = runtimeBusinessPrivilegePlan('app'), quote = (name: string) => {
        if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw Error('Invalid owned grant identifier'); return `"${name}"`;
      };
      const tables = await f.db.execute<{ name: string }>(sql`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname`);
      for (const { name } of tables) { const rights = plan.tables[name]; if (!rights) continue;
        await f.exec(`GRANT ${rights.join(',')} ON public.${quote(name)} TO ${quote(runtime.role)}`);
        const columns = plan.updateColumns[name]; if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(quote).join(',')}) ON public.${quote(name)} TO ${quote(runtime.role)}`);
      }
      const sequences = await f.db.execute<{ table_name: string; sequence_name: string | null }>(sql`SELECT c.relname AS table_name,
        pg_get_serial_sequence('public.'||quote_ident(c.relname),a.attname) AS sequence_name FROM pg_class c
        JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'`);
      for (const row of sequences) if (row.sequence_name && plan.tables[row.table_name]?.includes('INSERT')) {
        const parts = row.sequence_name.split('.'); if (parts.length !== 2 || parts[0] !== 'public') throw Error('Unexpected owned sequence');
        await f.exec(`GRANT USAGE ON SEQUENCE public.${quote(parts[1])} TO ${quote(runtime.role)}`);
      }
      const result = await request(runtime.db, { ...body, activity: ['砍价', '默认'] }); expect(result.status, result.msg).toBe(200);
      const detail = await request(runtime.db, undefined, crypto.randomUUID(), '/outapi/product/70', 'GET');
      expect(detail.status, detail.msg).toBe(200); expect(detail.data.productInfo.activity).toEqual(['砍价', '默认']);
    });
  }, 30_000);
});
