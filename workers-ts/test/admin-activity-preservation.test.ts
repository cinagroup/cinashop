import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    ['seckill', 501], ['combination', 502], ['integral', 503],
  ] as const)('editing %s preserves sales, creation time, and omitted fields', async (type, id) => {
    const before = await row(type, id);
    expect(await request('/activity/save', 'POST', { type, id, storeName: '新名称' })).toMatchObject({ status: 200 });
    expect(await row(type, id)).toEqual({ ...before, storeName: '新名称' });
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
    ['seckill', 501], ['combination', 502], ['integral', 503],
  ] as const)('retiring %s marks only isDel, hides it from admin list and preserves the row', async (type, id) => {
    const before = await row(type, id);
    expect(await request(`/activity/del/${type}/${id}`, 'DELETE')).toMatchObject({ status: 200 });
    expect(await row(type, id)).toEqual({ ...before, isDel: 1 });
    expect(await request(`/activity/${type}`)).toMatchObject({ status: 200, data: [] });
    expect(await request(`/activity/del/${type}/${id}`, 'DELETE')).toMatchObject({ status: 200 });
    expect(await row(type, id)).toEqual({ ...before, isDel: 1 });
  });

  it.each([
    ['seckill', 501], ['combination', 502], ['integral', 503],
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
