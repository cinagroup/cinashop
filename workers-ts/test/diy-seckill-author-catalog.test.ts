import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { seckillIndex, seckillList } from '@/controllers/api/v1/UserActivityController';
import { ActivityService } from '@/services/activity/ActivityService';
import { storeActivity, storeSeckill, storeSeckillTime, storeProduct, storeCart, storeOrder, storeOrderCartInfo, systemAttachment, systemConfig, systemDise, user } from '@/models/schema';
import { financeMemoryPostgres } from './helpers/financePostgres';

// Fixed PHP8ed2a5b StoreSeckillDao140–142 filters nonexistent/deleted base
// products before pagination; StoreSeckillServices430–457 binds the parent
// activity frame. Existing TS Shanghai/NULL/parent/slot admission contracts are
// deliberately stronger than the old PHP comparisons and remain unchanged.
const NOW = new Date('2026-10-25T01:00:00.000Z'); // 09:00 Shanghai.
const day = (date = '2026-10-25') => Date.parse(`${date}T00:00:00+08:00`) / 1000;
const at = (clock: string, date = '2026-10-25') => new Date(`${date}T${clock}+08:00`);
const appKey = 'local-seckill-author-catalog-signing-key';
const tables = [storeProduct, storeActivity, storeSeckill, storeSeckillTime, systemAttachment, systemConfig, systemDise, storeCart, storeOrder, storeOrderCartInfo, user];
const parent = (patch: Partial<typeof storeActivity.$inferInsert> = {}) => ({ id: 301, type: 1, status: 1, isDel: 0,
  name: '真实父活动', image: '/images/seckill-parent.png', startDay: day(), endDay: day(), timeId: '101,102', ...patch });
const activity = (patch: Partial<typeof storeSeckill.$inferInsert> = {}) => ({ id: 901, productId: 201, activityId: 301, timeId: '101,102',
  type: 1, relationId: 0, storeName: '真实秒杀目录', image: '/static/seckill-product.png', price: '6.25', otPrice: '99.90',
  quota: 7, quotaShow: 10, stock: 999, sort: 2, status: 1, isShow: 1, isDel: 0,
  startTime: null, stopTime: null, cost: '1.01', customForm: 'private-form', systemFormId: 77, ...patch });
type CatalogRow = { id: number; product_id: number; activity_id: number; title: string; image: string; activity_image: string;
  price: number; ot_price: number; stock: number; percent: number; [key: string]: unknown };

describe('seckill author real read-only catalogue and public controller', () => {
  let f: Awaited<ReturnType<typeof financeMemoryPostgres>>, container: ReturnType<typeof createContainerFromDb>;
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  // Identity injection is the fixture boundary. Controller, service, both media
  // policies, actual DAO and SQL execute; no purchase/cart/order route exists.
  app.use('*', async (c, next) => { c.set('container', container); c.set('uid', c.req.header('x-fixture-user') === '11' ? 11 : 0); await next(); });
  app.onError((error, c) => c.json({ status: 400000, msg: error.message, data: null }, 400));
  app.get('/api/seckill/index', seckillIndex); app.get('/api/seckill/list/:time', seckillList);
  beforeAll(async () => { f = await financeMemoryPostgres(tables); container = createContainerFromDb(f.db); }, 30_000);
  afterAll(async () => { vi.useRealTimers(); await f?.close(); });
  beforeEach(async () => {
    vi.setSystemTime(NOW); await f.reset();
    await f.db.insert(storeProduct).values({ id: 201, storeName: '独立基础商品', price: '700.00', otPrice: '888.00', isShow: 1, isVerify: 1, isDel: 0 });
    await f.db.insert(storeActivity).values(parent());
    await f.db.insert(storeSeckillTime).values([{ id: 101, title: '上午', startTime: '0800', endTime: '10:00', status: 1 },
      { id: 102, title: '晚上', startTime: '18:00', endTime: '2000', status: 1 }]);
    await f.db.insert(storeSeckill).values(activity());
    await f.db.insert(systemAttachment).values([
      { attId: 61, type: 1, relationId: 0, moduleType: 1 },
      { attId: 62, type: 4, relationId: 7, moduleType: 1 },
      { attId: 63, type: 3, relationId: 11, moduleType: 3 },
      { attId: 64, type: 1, relationId: 2, moduleType: 1 },
      { attId: 65, type: 1, relationId: 0, moduleType: 2 },
      { attId: 66, type: 1, relationId: 0, moduleType: 1, fileType: 2 },
      { attId: 67, type: 1, relationId: 0, moduleType: 1, attDir: '/api/assets/999' },
    ].map(row => ({ imageType: 8, fileType: 1, attType: 'image/png', name: `attachments/admin/1/seckill-author-${row.attId}.png`,
      attDir: `/api/assets/${row.attId}`, ...row })));
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No catalogue provider, storage or network I/O'));
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  async function snapshot() {
    const rows = await Promise.all(tables.map(async table => [getTableConfig(table).name,
      Array.from(await f.db.execute(sql.raw(`SELECT * FROM "${getTableConfig(table).name}" ORDER BY 1`)), row => ({ ...row }))] as const));
    return { tables: Object.fromEntries(rows), sequences: Array.from(await f.db.execute(sql`SELECT sequencename,last_value FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`), row => ({ ...row })) };
  }
  async function unchanged<T>(work: () => Promise<T>): Promise<T> {
    const before = await snapshot();
    try { return await work(); }
    finally { expect(await snapshot()).toEqual(before); }
  }
  const service = (key: string | undefined = appKey) => new ActivityService(container, { APP_KEY: key } as Env);
  const daoRows = (slot = '101', page = 1, limit = 10, now = NOW) => unchanged(() => container.storeSeckillDao.getByTimeId(slot, page, limit, now));
  async function read(slot = '101', query = 'page=1&limit=10', uid = '') {
    return unchanged(async () => {
      const response = await app.request(`/api/seckill/list/${slot}?${query}`, { headers: uid ? { 'x-fixture-user': uid } : {} }, { APP_KEY: appKey } as Env);
      expect(response.status).toBe(200); const body = await response.json() as { status: number; data: CatalogRow[] };
      expect(body.status).toBe(200); expect(Array.isArray(body.data)).toBe(true); return body.data;
    });
  }
  async function index(now = NOW) { return unchanged(() => service().seckillTimes(now)); }
  function signed(value: string, id = 61) {
    const url = new URL(value, 'https://local.invalid'), expires = Number(url.searchParams.get('expires'));
    expect(url.pathname).toBe(`/api/assets/${id}`); expect(expires).toBeGreaterThan(Math.floor(NOW.getTime() / 1000));
    expect(expires).toBeLessThanOrEqual(Math.floor(NOW.getTime() / 1000) + 900);
    expect(url.searchParams.get('signature')).toBe(createHmac('sha256', appKey).update(`GET\n/api/assets/${id}\n${expires}`).digest('base64url'));
  }
  const frame = (image: string | null) => f.db.update(storeActivity).set({ image }).where(eq(storeActivity.id, 301));

  it('maps child, base and parent identities while retaining activity prices, quota stock and exact public DTO', async () => {
    expect(await read()).toEqual([{ id: 901, product_id: 201, activity_id: 301, title: '真实秒杀目录', image: '/static/seckill-product.png',
      price: 6.25, ot_price: 99.9, quota: 7, quota_show: 10, freight: 2, stock: 7, store_label_id: '', store_label: [], brand_name: '',
      percent: 30, discount_num: 0.6, activity_image: '/images/seckill-parent.png' }]);
    const [raw] = await daoRows(); expect(raw).toMatchObject({ id: 901, productId: 201, activityId: 301, otPrice: '99.90', systemFormId: 77 });
    expect(raw).not.toHaveProperty('storeProduct'); expect(raw).not.toHaveProperty('storeSeckill'); expect(raw).not.toHaveProperty('activityImage');
  });
  it('omits a missing base product through actual SQL and the controller without removing its stored activity', async () => {
    await f.db.delete(storeProduct); expect(await daoRows()).toEqual([]); expect(await read()).toEqual([]);
    expect((await f.db.select().from(storeSeckill))[0].id).toBe(901);
  });
  it('omits a deleted base product before pagination, independently of the child availability', async () => {
    await f.db.update(storeProduct).set({ isDel: 1 }); expect(await daoRows()).toEqual([]); expect(await read()).toEqual([]);
  });
  it.each([{ isShow: 0 }, { isVerify: 0 }, { stock: 0 }, { isVipProduct: 1 }])('does not invent a base-product %j visibility or purchase gate for this read-only list', async patch => {
    await f.db.update(storeProduct).set(patch); expect((await read()).map(row => row.id)).toEqual([901]);
  });
  it('filters missing/deleted bases and invalid schedules before complete stable sort/id pages', async () => {
    await f.db.delete(storeSeckill); await f.db.insert(storeProduct).values({ id: 202, storeName: '已删旁观基础商品', isDel: 1 });
    await f.db.insert(storeSeckill).values([
      ...Array.from({ length: 25 }, (_, i) => activity({ id: i + 1, sort: 1 })),
      ...Array.from({ length: 10 }, (_, i) => activity({ id: 1001 + i, productId: i < 5 ? 202 : 999, sort: 999 })),
      ...Array.from({ length: 5 }, (_, i) => activity({ id: 2001 + i, activityId: 999, sort: 999 })),
    ]);
    const pages = []; for (let page = 1; page <= 4; page++) pages.push(await daoRows('101', page, 10));
    expect(pages.map(rows => rows.length)).toEqual([10, 10, 5, 0]); expect(pages.flat().map(row => row.id)).toEqual(Array.from({ length: 25 }, (_, i) => 25 - i));
    expect((await read('101', 'page=2&limit=10')).map(row => row.id)).toEqual(Array.from({ length: 10 }, (_, i) => 15 - i));
  });
  it('preserves multiple activities using one base and does not replace the activity old price with the base price', async () => {
    await f.db.insert(storeSeckill).values(activity({ id: 902, price: '0.00', otPrice: '3.00', sort: 3 }));
    expect((await read()).map(row => [row.id, row.product_id, row.price, row.ot_price])).toEqual([[902, 201, 0, 3], [901, 201, 6.25, 99.9]]);
  });
  it('projects each parent frame by its real association rather than row order or product identity', async () => {
    await f.db.insert(storeActivity).values(parent({ id: 302, image: '/images/other-parent.png' }));
    await f.db.insert(storeActivity).values(parent({ id: 303, image: '/api/assets/999' })); // Unrelated parent must not affect this page.
    await f.db.insert(storeSeckill).values(activity({ id: 902, activityId: 302, sort: 9 }));
    expect((await read()).map(row => [row.id, row.activity_id, row.activity_image])).toEqual([[902, 302, '/images/other-parent.png'], [901, 301, '/images/seckill-parent.png']]);
  });
  it('keeps standalone activityId0 frames empty even if a row with parent id0 exists', async () => {
    await f.db.insert(storeActivity).values(parent({ id: 0, image: '/api/assets/61' }));
    await f.db.update(storeSeckill).set({ activityId: 0 }); expect((await read())[0].activity_image).toBe('');
  });
  it('signs only a business-policy-approved parent frame and never stores its response ticket', async () => {
    await frame('/api/assets/61'); const rows = await read(); signed(rows[0].activity_image);
    expect(rows[0].image).toBe('/static/seckill-product.png'); expect((await f.db.select().from(storeActivity))[0].image).toBe('/api/assets/61');
  });
  it('refreshes an expired copied parent ticket without changing the original database value', async () => {
    const stale = '/api/assets/61?expires=1&signature=old'; await frame(stale); signed((await read())[0].activity_image);
    expect((await f.db.select().from(storeActivity))[0].image).toBe(stale);
  });
  it.each([62, 63, 64, 65, 66, 67, 999])('does not sign cross-owner/module, non-image or mismatched business frame %s', async id => {
    await frame(`/api/assets/${id}`); expect((await read())[0].activity_image).toBe('');
  });
  it.each(['/images/frame.png', 'https://static.example.invalid/frame.png'])('preserves safe public business frame %s without network or storage access', async value => {
    await frame(value); expect((await read())[0].activity_image).toBe(value);
  });
  it.each(['javascript:alert(1)', '//evil.example/frame.png', 'http://static.example/frame.png', 'https://user:pass@example/frame.png', '/images\\bad.png', 'data:image/png;base64,AAAA', ''])('does not render an unsafe or empty parent frame %s', async value => {
    await frame(value); expect((await read())[0].activity_image).toBe('');
  });
  it('does not treat parent heading text or absent image as a frame authority', async () => {
    await f.db.update(storeActivity).set({ name: '/api/assets/61', image: null }); expect((await read())[0].activity_image).toBe('');
  });
  it('retains signing-key failure for a valid private frame but requires no key for empty or public frames', async () => {
    await frame('/api/assets/61'); await expect(unchanged(() => new ActivityService(container).seckillList('101'))).rejects.toThrow();
    await frame('/images/public.png'); expect((await unchanged(() => new ActivityService(container).seckillList('101')))[0].activity_image).toBe('/images/public.png');
    await f.db.delete(storeSeckill); expect(await unchanged(() => new ActivityService(container).seckillList('101'))).toEqual([]);
  });
  it('preserves quota progress zero and exhausted cases independently of the parent decoration', async () => {
    for (const [quota, quotaShow, expected] of [[0, 10, 100], [10, 10, 0], [1, 3, 66.7], [1, 0, 100]]) {
      await f.db.update(storeSeckill).set({ quota, quotaShow }); expect((await read())[0]).toMatchObject({ stock: quota, percent: expected });
    }
  });
  it('retains server-selected slot order/idASC and exclusive session ends with Shanghai stop times', async () => {
    await f.db.insert(storeSeckillTime).values({ id: 100, title: '同起点较小ID', startTime: '08:00', endTime: '1000', status: 1 });
    const schedule = await index(); expect(schedule.seckillTime.map(row => row.id)).toEqual([100, 101, 102]); expect(schedule.seckillTimeIndex).toBe(0);
    expect(schedule.seckillTime[1].stop).toBe(Math.floor(at('10:00:00').getTime() / 1000));
    const ended = await index(at('10:00:00')); expect(ended.seckillTime.map(row => row.status)).toEqual([0, 0, 2]); expect(ended.seckillTimeIndex).toBe(2);
  });
  it('browses enabled current-day slots before and after their session without granting purchase admission', async () => {
    for (const clock of ['07:59:59.999', '08:00:00', '10:00:00', '20:00:00']) expect((await daoRows('101', 1, 10, at(clock))).map(row => row.id)).toEqual([901]);
    expect((await daoRows('102', 1, 10, NOW)).map(row => row.id)).toEqual([901]);
  });
  it('preserves legacy NULL child dates and standalone schedules under the added base filter', async () => {
    expect((await daoRows()).map(row => row.id)).toEqual([901]); await f.db.update(storeSeckill).set({ activityId: 0 });
    expect((await read())[0]).toMatchObject({ id: 901, activity_id: 0, activity_image: '' });
  });
  it('keeps precise child start and inclusive stored stop instants, then closes at the next millisecond', async () => {
    await f.db.update(storeSeckill).set({ startTime: NOW, stopTime: NOW });
    expect(await daoRows('101', 1, 10, new Date(NOW.getTime() - 1))).toEqual([]);
    expect((await daoRows()).map(row => row.id)).toEqual([901]); expect(await daoRows('101', 1, 10, new Date(NOW.getTime() + 1))).toEqual([]);
  });
  it('retains the inclusive legacy final day and closes at the following Shanghai midnight', async () => {
    await f.db.update(storeSeckill).set({ stopTime: at('00:00:00') });
    expect((await daoRows('102', 1, 10, at('19:59:59.999'))).map(row => row.id)).toEqual([901]);
    expect(await daoRows('102', 1, 10, at('00:00:00', '2026-10-26'))).toEqual([]);
  });
  it.each([{ status: 0 }, { isDel: 1 }, { type: 2 }, { timeId: '102' }])('keeps the original stronger parent rejection for %j', async patch => {
    await f.db.update(storeActivity).set(patch); expect(await daoRows()).toEqual([]); expect(await read()).toEqual([]);
  });
  it.each([{ status: 0 }, { isShow: 0 }, { isDel: 1 }, { activityId: 999 }, { timeId: '0101' }])('keeps original child schedule rejection for %j', async patch => {
    await f.db.update(storeSeckill).set(patch); expect(await daoRows()).toEqual([]); expect(await read()).toEqual([]);
  });
  it('retains the missing/malformed/disabled linked-slot boundary rather than weakening the schedule query', async () => {
    await f.db.delete(storeSeckillTime).where(eq(storeSeckillTime.id, 102)); expect(await daoRows()).toEqual([]);
    await f.db.insert(storeSeckillTime).values({ id: 102, startTime: 'bad', endTime: '2000', status: 1 }); expect(await daoRows()).toEqual([]);
    await f.db.update(storeSeckillTime).set({ startTime: '18:00', status: 0 }).where(eq(storeSeckillTime.id, 102));
    expect((await daoRows()).map(row => row.id)).toEqual([901]); expect(await daoRows('102')).toEqual([]);
  });
  it('rejects malformed requested slot IDs and invalid clocks through the unchanged strict SQL contract', async () => {
    for (const slot of ['', '0', '0101', '101,102', '101 OR 1=1', '2147483648', '101\n']) await expect(daoRows(slot)).rejects.toThrow('参数无效');
    await expect(daoRows('101', 1, 10, new Date(NaN))).rejects.toThrow('参数无效');
  });
  it('keeps current bounded public pagination and ignores actor-looking read parameters without writes', async () => {
    const guest = await read(); expect(await read('101', 'page=1&limit=10&uid=99&vip=1&time_id=102&quantity=999', '11')).toEqual(guest);
    expect(await read('101', 'page=0&limit=0')).toEqual(guest); expect(await read('101', 'page=999999&limit=999')).toEqual([]);
  });
  it('preserves whole-row getById even when the activity has no available base product or schedule', async () => {
    await f.db.update(storeSeckill).set({ productId: 999, status: 0, isDel: 1, timeId: 'bad' });
    const [raw] = await f.db.select().from(storeSeckill).where(eq(storeSeckill.id, 901));
    expect(await unchanged(() => container.storeSeckillDao.getById(901))).toEqual(raw); expect(raw.systemFormId).toBe(77); expect(await read()).toEqual([]);
  });
  it('repeats actual DAO service and both public controller reads without changing any table or sequence', async () => {
    await frame('/api/assets/61'); const before = await snapshot();
    for (let i = 0; i < 3; i++) { await daoRows(); await unchanged(() => service().seckillList('101')); await read();
      const response = await app.request('/api/seckill/index', {}, { APP_KEY: appKey } as Env); expect(response.status).toBe(200); }
    expect(await snapshot()).toEqual(before); expect(f.isMemory).toBe(true);
  });
});
