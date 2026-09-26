import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import { storeBrand, storeProduct, storeProductLabel, storeProductRelation, storePromotions,
  storePromotionsAuxiliary, user, systemConfig, memberRight } from '../src/models/schema';
import { productHot } from '../src/controllers/api/v1/ProductController';
import { V2PromotionCompatibilityService } from '../src/services/activity/V2PromotionCompatibilityService';
import { financePostgres } from './helpers/financePostgres';

const NOW = new Date('2026-09-26T02:00:00.000Z');
const SECONDS = NOW.getTime() / 1000;
const tables = [storeBrand, storeProduct, storeProductLabel, storeProductRelation, storePromotions,
  storePromotionsAuxiliary, user, systemConfig, memberRight];
const frame = (id: number, extra: Partial<typeof storePromotions.$inferInsert> = {}) => ({
  id, promotionsType: 5, name: `Frame ${id}`, image: `/images/frame-${id}.png`,
  productPartakeType: 1, startTime: SECONDS, stopTime: SECONDS + 3600, updateTime: SECONDS, ...extra,
});
type Product = { id: number; activity_frame: [] | { id: number; name: string; image: string }; [key: string]: unknown };

describe('hot product frame display against disposable SQL', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, service: V2PromotionCompatibilityService;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  beforeAll(async () => {
    f = await financePostgres(tables);
    const container = createContainerFromDb(f.db);
    service = new V2PromotionCompatibilityService(container, {} as Env);
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', container); c.set('uid', 0); await next(); });
    app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    app.get('/api/product/hot', productHot);
  }, 60_000);
  afterAll(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await f?.close(); }, 60_000);
  beforeEach(async () => {
    vi.setSystemTime(NOW); await f.reset();
    await f.db.insert(storeProduct).values(Array.from({ length: 4 }, (_, index) => ({
      id: 170 + index, storeName: `Hot ${index}`, price: '12.30', stock: 5, isHot: 1, isShow: 1, isVerify: 1,
    })));
  });
  const request = async (query = '') => {
    const response = await app.request(`/api/product/hot${query}`);
    const result = await response.json() as { status: number; msg: string; data: Product[] };
    expect(result.status, result.msg).toBe(200);
    return result.data;
  };

  it('adds the legacy empty array while retaining every existing response field', async () => {
    const rows = await request();
    expect(rows.map(row => row.id)).toEqual([173, 172, 171, 170]);
    expect(rows.every(row => Array.isArray(row.activity_frame) && row.activity_frame.length === 0)).toBe(true);
    expect(rows[0]).toMatchObject({ price: '12.30', stock: 5,
      recommendation_target: { version: 1, product_id: 173, kind: 'product', id: 173, ends_at: null } });
    expect(rows[0]).not.toHaveProperty('promotions');
    expect(rows[0]).not.toHaveProperty('activity_background');
  });

  it.each([
    { mode: 1, expected: [170, 171, 172, 173] },
    { mode: 2, expected: [170, 172] },
    { mode: 3, expected: [171, 172, 173] },
    { mode: 4, expected: [170] },
    { mode: 5, expected: [171] },
  ])('uses the legacy product scope $mode without changing the hot page', async ({ mode, expected }) => {
    await f.db.insert(storePromotions).values(frame(500, { productPartakeType: mode }));
    await f.db.insert(storePromotionsAuxiliary).values([
      { promotionsId: 500, productId: 170, brandId: 40, storeLabelId: 50, isAll: 1 },
      { promotionsId: 500, productId: 172, isAll: 0 },
      // Gifts are not participating products or scope brands/labels.
      { promotionsId: 500, type: 3, productId: 173, brandId: 41, storeLabelId: 51 },
    ]);
    await f.db.insert(storeProductRelation).values([
      { productId: 170, type: 2, relationId: 40 },
      { productId: 171, type: 3, relationId: 50 },
      { productId: 172, type: 1, relationId: 40 },
      { productId: 173, type: 2, relationId: 41 },
      { productId: 173, type: 3, relationId: 51 },
      { productId: 999, type: 2, relationId: 40 },
    ]);
    const rows = await request();
    expect(rows.map(row => row.id)).toEqual([173, 172, 171, 170]);
    for (const row of rows) expect(row.activity_frame).toEqual(expected.includes(row.id)
      ? { id: 500, name: 'Frame 500', image: '/images/frame-500.png' } : []);
  });

  it('rejects unsupported or empty selected scopes instead of treating them as all products', async () => {
    for (const productPartakeType of [0, 2, 4, 5, 6]) {
      await f.db.insert(storePromotions).values(frame(500 + productPartakeType, { productPartakeType }));
    }
    expect((await request()).every(row => Array.isArray(row.activity_frame))).toBe(true);
  });

  it('filters non-platform, child, disabled, deleted, future and expired rows before picking a frame', async () => {
    await f.db.insert(storePromotions).values([
      frame(500), frame(501, { type: 2 }), frame(502, { storeId: 1 }), frame(503, { pid: 500 }),
      frame(504, { status: 0 }), frame(505, { isDel: 1 }), frame(506, { startTime: SECONDS + 1 }),
      frame(507, { stopTime: SECONDS - 1 }), frame(508, { promotionsType: 1, discount: '10.00' }),
      frame(509, { promotionsType: 6 }),
    ]);
    for (const row of await request()) expect(row.activity_frame).toEqual({ id: 500, name: 'Frame 500', image: '/images/frame-500.png' });
  });

  it('includes the legacy start and stop seconds, and removes the frame at the next second', async () => {
    await f.db.insert(storePromotions).values(frame(500, { startTime: SECONDS, stopTime: SECONDS }));
    vi.setSystemTime(new Date(NOW.getTime() - 1));
    expect((await request())[0].activity_frame).toEqual([]);
    vi.setSystemTime(NOW);
    expect((await request())[0].activity_frame).toMatchObject({ id: 500 });
    vi.setSystemTime(new Date(NOW.getTime() + 999));
    expect((await request())[0].activity_frame).toMatchObject({ id: 500 });
    vi.setSystemTime(new Date(NOW.getTime() + 1000));
    expect((await request())[0].activity_frame).toEqual([]);
  });

  it('chooses the newest matching frame with a stable ID tie and rechecks edits on the next request', async () => {
    await f.db.insert(storePromotions).values([
      frame(500, { updateTime: SECONDS + 1 }), frame(501, { updateTime: SECONDS + 1 }),
      frame(502), frame(503, { updateTime: SECONDS + 2, productPartakeType: 2 }),
    ]);
    expect((await request())[0].activity_frame).toMatchObject({ id: 501 });
    await f.db.update(storePromotions).set({ status: 0 }).where(eq(storePromotions.id, 501));
    expect((await request())[0].activity_frame).toMatchObject({ id: 500 });
    await f.db.update(storePromotions).set({ image: '/images/replacement.png' }).where(eq(storePromotions.id, 500));
    expect((await request())[0].activity_frame).toMatchObject({ id: 500, image: '/images/replacement.png' });
  });

  it('preserves price, navigation, pagination and business data with unrelated monetary promotions present', async () => {
    const beforeFrames = await request('?page=2&limit=2');
    await f.db.insert(storePromotions).values([
      frame(500), ...Array.from({ length: 201 }, (_, index) => frame(1000 + index, { promotionsType: 1, discount: '10.00' })),
    ]);
    const snapshot = async () => Promise.all(tables.map(table => f.db.select().from(table)));
    const before = await snapshot(), afterFrames = await request('?page=2&limit=2');
    expect(afterFrames).toEqual(beforeFrames.map(row => ({ ...row,
      activity_frame: { id: 500, name: 'Frame 500', image: '/images/frame-500.png' } })));
    expect(await request('?page=3&limit=2')).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it('batches 100 existing products in three reads without reading a whole product catalogue', async () => {
    await f.db.insert(storePromotions).values(frame(500));
    const select = vi.spyOn(f.db, 'select');
    try {
      const input = Array.from({ length: 100 }, (_, index) => ({ id: 170 + index, price: '12.30' }));
      const rows = await service.decorateProductFrames(input);
      expect(rows).toHaveLength(100); expect(select).toHaveBeenCalledTimes(3);
      expect(input.every(row => !Object.hasOwn(row, 'activity_frame'))).toBe(true);
      expect(rows.every(row => row.price === '12.30' && (row.activity_frame as { id: number }).id === 500)).toBe(true);
    } finally { select.mockRestore(); }
  });

  it('rejects invalid/duplicate/oversized input before SQL and refuses a truncated frame selection', async () => {
    const select = vi.spyOn(f.db, 'select');
    try {
      for (const rows of [[{ id: 0 }], [{ id: '170' }], [{ id: 170 }, { id: 170 }], Array.from({ length: 101 }, (_, index) => ({ id: index + 1 }))]) {
        await expect(service.decorateProductFrames(rows)).rejects.toThrow();
      }
      expect(await service.decorateProductFrames([])).toEqual([]);
      expect(select).not.toHaveBeenCalled();
    } finally { select.mockRestore(); }
    await f.db.insert(storePromotions).values(Array.from({ length: 201 }, (_, index) => frame(500 + index)));
    const response = await app.request('/api/product/hot');
    expect(await response.json()).toMatchObject({ status: 400, msg: '有效优惠活动过多，请联系管理员整理', data: null });
  });
});
