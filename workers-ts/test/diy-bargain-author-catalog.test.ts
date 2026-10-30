import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { bargainList } from '@/controllers/api/v1/UserActivityController';
import { ActivityService } from '@/services/activity/ActivityService';
import { storeBargain, storeBargainUser, storeBargainUserHelp, storeCart, storeOrder, storeOrderCartInfo, storeProduct, systemAttachment, user } from '@/models/schema';
import { financeMemoryPostgres } from './helpers/financePostgres';

// Fixed PHP8ed2a5b StoreBargainDao150–162: nondeleted activity/base product,
// inclusive nonNULL dates, sort DESC/id DESC, then pagination. The model's
// product153–155 binds base ot_price; service287–305 keeps the activity price
// and counts type1 initiator help rows. No purchase/participation route executes.
const NOW = new Date('2026-10-25T12:00:00.000Z');
const past = new Date(NOW.getTime() - 60_000), future = new Date(NOW.getTime() + 60_000);
const tables = [storeProduct, storeBargain, storeBargainUser, storeBargainUserHelp, storeCart, storeOrder, storeOrderCartInfo, systemAttachment, user];
const activity = (patch: Partial<typeof storeBargain.$inferInsert> = {}) => ({ id: 101, productId: 201, type: 0, relationId: 0, productType: 0,
  storeName: '备用商品名', title: '真实砍价目录', info: '目录说明', image: '/static/bargain-product.png', price: '20.00', minPrice: '5.00', stock: 9, sales: 3,
  people: 999, quota: 300, sort: 2, startTime: past, stopTime: future, status: 1, isDel: 0, systemFormId: 77, cost: '1.01', customForm: 'private-form', ...patch });
type CatalogRow = { id: number; product_id: number; price: number; min_price: number; ot_price: number; title: string; people: number; sales: number; stock: number; [key: string]: unknown };

describe('bargain author real read-only catalogue and actual public controller', () => {
  let f: Awaited<ReturnType<typeof financeMemoryPostgres>>, container: ReturnType<typeof createContainerFromDb>;
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  // Only auth principal injection is a fixture boundary. The production public
  // controller, service, DAO, SQL selection and DTO projection all execute.
  app.use('*', async (c, next) => { c.set('container', container); c.set('uid', c.req.header('x-fixture-user') === '11' ? 11 : 0); await next(); });
  app.onError((error, c) => c.json({ status: 500, msg: error.message, data: null }, 500));
  app.get('/api/bargain/list', bargainList);
  beforeAll(async () => { f = await financeMemoryPostgres(tables); container = createContainerFromDb(f.db); }, 30_000);
  afterAll(async () => { vi.useRealTimers(); await f?.close(); });
  beforeEach(async () => {
    vi.setSystemTime(NOW); await f.reset();
    await f.db.insert(storeProduct).values({ id: 201, storeName: '基础商品', price: '70.00', otPrice: '99.90', isShow: 1, isVerify: 1, isDel: 0 });
    await f.db.insert(storeBargain).values(activity());
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No catalogue provider/network I/O'));
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  async function snapshot() {
    const rows = await Promise.all(tables.map(async table => [getTableConfig(table).name,
      Array.from(await f.db.execute(sql.raw(`SELECT * FROM "${getTableConfig(table).name}" ORDER BY 1`)), row => ({ ...row }))] as const));
    return { tables: Object.fromEntries(rows), sequences: Array.from(await f.db.execute(sql`SELECT sequencename,last_value FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`), row => ({ ...row })) };
  }
  async function unchanged<T>(work: () => Promise<T>): Promise<T> { const before = await snapshot(), value = await work(); expect(await snapshot()).toEqual(before); return value; }
  const service = () => new ActivityService(container);
  async function read(query = 'page=1&limit=10', uid = '') {
    return unchanged(async () => {
      const response = await app.request(`/api/bargain/list?${query}`, { headers: uid ? { 'x-fixture-user': uid } : {} }, {} as Env);
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
      const body = await response.json() as { status: number; msg: string; data: CatalogRow[] }; expect(body.status).toBe(200); expect(Array.isArray(body.data)).toBe(true); return body.data;
    });
  }
  const daoRows = () => unchanged(() => container.storeBargainDao.list(1, 10));

  it('maps activity/base identities and independent start/minimum/base old prices through the real public controller without leaking private columns', async () => {
    const rows = await read(); expect(rows).toEqual([{ id: 101, type: 0, relation_id: 0, product_id: 201, product_type: 0, price: 20, min_price: 5,
      ot_price: 99.9, image: '/static/bargain-product.png', title: '真实砍价目录', info: '目录说明', sales: 3, stock: 9, people: 0, brand_name: '' }]);
    expect(rows[0]).not.toHaveProperty('cost'); expect(rows[0]).not.toHaveProperty('customForm'); expect(rows[0]).not.toHaveProperty('systemFormId');
  });
  it('keeps all original flat DAO activity columns and adds only the bound base otPrice without nested joined rows', async () => {
    const [raw] = await f.db.select().from(storeBargain).where(eq(storeBargain.id, 101));
    const rows = await daoRows(); expect(rows).toEqual([{ ...raw, otPrice: '99.90' }]); expect(rows[0]).not.toHaveProperty('store_product'); expect(rows[0]).not.toHaveProperty('store_bargain');
  });
  it('preserves base zero old price rather than falling back to the activity start or base selling price', async () => {
    await f.db.update(storeProduct).set({ otPrice: '0.00', price: '70.00' }); expect((await read())[0]).toMatchObject({ price: 20, min_price: 5, ot_price: 0 });
  });
  it('keeps a zero activity price distinct from a nonzero base old price and never substitutes minimum-price marketing', async () => {
    await f.db.update(storeBargain).set({ price: '0.00', minPrice: '0.00' }); expect((await read())[0]).toMatchObject({ price: 0, min_price: 0, ot_price: 99.9 });
  });
  it.each([
    ['start endpoint', NOW, future, true], ['stop endpoint', past, NOW, true], ['both endpoints', NOW, NOW, true],
    ['one millisecond before start', new Date(NOW.getTime() + 1), future, false],
    ['one millisecond after stop', past, new Date(NOW.getTime() - 1), false],
    ['NULL start', null, future, false], ['NULL stop', past, null, false], ['both NULL', null, null, false], ['inverted interval', future, past, false],
  ] as const)('matches strict PHP time comparisons at %s', async (_label, startTime, stopTime, visible) => {
    await f.db.update(storeBargain).set({ startTime, stopTime }); expect((await daoRows()).map(row => row.id)).toEqual(visible ? [101] : []); expect((await read()).map(row => row.id)).toEqual(visible ? [101] : []);
  });
  it.each([{ status: 0 }, { status: 2 }, { isDel: 1 }, { isDel: 2 }] as const)('excludes disabled/deleted activity %j before DTO adoption', async patch => {
    await f.db.update(storeBargain).set(patch); expect(await daoRows()).toEqual([]); expect(await read()).toEqual([]);
  });
  it.each([1, 2])('excludes base product isDel%s independently from the activity flag', async isDel => {
    await f.db.update(storeProduct).set({ isDel }); expect(await daoRows()).toEqual([]); expect(await read()).toEqual([]);
  });
  it('excludes a missing base product using the original product membership requirement', async () => {
    await f.db.update(storeBargain).set({ productId: 999 }); expect(await daoRows()).toEqual([]); expect(await read()).toEqual([]);
  });
  it.each([{ isShow: 0 }, { isVerify: 0 }, { isShow: 0, isVerify: -1, stock: 0, isVipProduct: 1 }] as const)('does not invent an additional base visibility/verification/stock/vip condition for %j', async patch => {
    // PHP's source condition is exactly base is_del=0. Selection/purchase may
    // enforce stricter visibility elsewhere; that policy is not changed here.
    await f.db.update(storeProduct).set(patch); expect((await read()).map(row => row.id)).toEqual([101]);
  });
  it('filters every unavailable high-sort row before deterministic descending sort/id pagination', async () => {
    await f.db.insert(storeBargain).values([
      activity({ id: 102, sort: 3 }), activity({ id: 103, sort: 3 }), activity({ id: 104, sort: 9 }), activity({ id: 105, sort: 9 }),
      activity({ id: 111, sort: 999, status: 0 }), activity({ id: 112, sort: 999, isDel: 1 }), activity({ id: 113, sort: 999, productId: 999 }),
      activity({ id: 114, sort: 999, startTime: null }), activity({ id: 115, sort: 999, stopTime: past }),
    ]);
    expect((await read('page=1&limit=2')).map(row => row.id)).toEqual([105, 104]); expect((await read('page=2&limit=2')).map(row => row.id)).toEqual([103, 102]); expect((await read('page=3&limit=2')).map(row => row.id)).toEqual([101]); expect(await read('page=4&limit=2')).toEqual([]);
  });
  it('keeps distinct activity IDs sharing one base product without accidental join duplication or deduplication', async () => {
    await f.db.insert(storeBargain).values(activity({ id: 102, price: '30.00', minPrice: '7.00', sort: 2 }));
    expect((await read()).map(row => [row.id, row.product_id, row.price, row.ot_price])).toEqual([[102, 201, 30, 99.9], [101, 201, 20, 99.9]]);
  });
  it('counts every real type1 initiator help for this activity, not friend helps, quota or the stored help requirement', async () => {
    await f.db.insert(storeBargainUser).values([{ id: 301, uid: 11, bargainId: 101, status: 1 }, { id: 302, uid: 11, bargainId: 101, status: 2, isDel: 1 }]);
    await f.db.insert(storeBargainUserHelp).values([
      { id: 1, uid: 11, bargainId: 101, bargainUserId: 301, type: 1 }, { id: 2, uid: 11, bargainId: 101, bargainUserId: 302, type: 1 },
      { id: 3, uid: 22, bargainId: 101, bargainUserId: 301, type: 0 }, { id: 4, uid: 22, bargainId: 999, bargainUserId: 900, type: 1 },
    ]);
    expect((await read())[0]).toMatchObject({ people: 2, sales: 3 }); expect((await unchanged(() => service().bargainList(1, 1)))[0]).toMatchObject({ people: 2 });
  });
  it('returns zero initiators for activities with no type1 rows and aggregates each requested page independently', async () => {
    await f.db.insert(storeBargain).values(activity({ id: 102, sort: 3 }));
    await f.db.insert(storeBargainUserHelp).values([{ bargainId: 101, uid: 11, type: 1 }, { bargainId: 101, uid: 12, type: 1 }, { bargainId: 102, uid: 22, type: 0 }]);
    expect((await read('page=1&limit=1'))[0]).toMatchObject({ id: 102, people: 0 }); expect((await read('page=2&limit=1'))[0]).toMatchObject({ id: 101, people: 2 });
  });
  it('keeps public reads independent of actor uid/spid and ignores purchase-looking request flags without writes', async () => {
    const guest = await read(); const actor = await read('page=1&limit=10&uid=22&spid=999&vip=1&bargain_user_id=301', '11'); expect(actor).toEqual(guest);
  });
  it('retains the current bounded controller pagination normalization without widening the API contract', async () => {
    await f.db.insert(storeBargain).values(Array.from({ length: 54 }, (_, i) => activity({ id: 102 + i, sort: 2 })));
    expect((await read('page=0&limit=0')).map(row => row.id)).toEqual([155, 154, 153, 152, 151, 150, 149, 148, 147, 146]);
    expect((await read('page=1&limit=999')).length).toBe(50); expect((await read('page=2&limit=50')).map(row => row.id)).toEqual([105, 104, 103, 102, 101]);
    expect(await read('page=999999&limit=50')).toEqual([]);
  });
  it('does not change getById flat whole-row access used by cart system forms even for an unavailable catalogue row', async () => {
    await f.db.update(storeBargain).set({ productId: 999, status: 0, isDel: 1, startTime: null, stopTime: null });
    const [raw] = await f.db.select().from(storeBargain).where(eq(storeBargain.id, 101));
    const row = await unchanged(() => container.storeBargainDao.getById(101)); expect(row).toEqual(raw); expect(row?.systemFormId).toBe(77); expect(row).not.toHaveProperty('otPrice'); expect(await read()).toEqual([]);
  });
  it('supports repeated DAO service and controller reads without changing any seeded table or sequence', async () => {
    await f.db.insert(storeBargainUser).values({ id: 301, uid: 11, bargainId: 101, price: '0.00' });
    await f.db.insert(storeBargainUserHelp).values({ uid: 11, bargainId: 101, bargainUserId: 301, type: 1 });
    const before = await snapshot(); for (let i = 0; i < 3; i++) { await daoRows(); await unchanged(() => service().bargainList(1, 10)); await read(); } expect(await snapshot()).toEqual(before);
  });
});
