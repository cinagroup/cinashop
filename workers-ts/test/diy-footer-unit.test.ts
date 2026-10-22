import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { storeCart } from '@/models/schema';
import { cartCount } from '@/controllers/api/v1/OrderController';
import { StoreCartService } from '@/services/order/StoreCartService';
import { canonicalizeDiyEditorialMedia, DIY_FOOTER_MEDIA_SLOT_LIMIT } from '@/services/content/DiyEditorialMediaPolicy';
import { financeMemoryPostgres } from './helpers/financePostgres';

describe('footer exact authored media slots and independent atomic budget', () => {
  it.each(['pageFoot', 'PAGEFOOT', 'PageFoot'])('canonicalizes only both real icon indices in %s and preserves neighboring strings', name => {
    const ticket = '/api/assets/7?expires=1&signature=old', foreign = 'https://foreign.test/api/assets/7?expires=1&signature=old';
    const value = [{ name, link: ticket, menuList: [{ name: ticket, link: ticket, preview: ticket, imgList: [ticket, ticket, ticket] },
      { imgList: { 0: ticket, 1: ticket } }, { imgList: [foreign, '/static/logo.png'] }] },
    { name: 'unknown', menuList: [{ imgList: [ticket, ticket] }] }];
    const expected = structuredClone(value); expected[0].menuList[0].imgList = ['/api/assets/7', '/api/assets/7', ticket];
    canonicalizeDiyEditorialMedia(value); expect(value).toEqual(expected);
  });
  it('keeps all42500 mixed slots and rejects footer20001 before mutating any earlier legacy ticket', () => {
    const ticket = '/api/assets/7?expires=1&signature=old';
    const value = [{ name: 'swipers', swiperConfig: { list: Array.from({ length: 2500 }, () => ({ img: ticket })) } },
      { name: 'menus', menuConfig: { list: Array.from({ length: 20000 }, () => ({ img: ticket })) } },
      { name: 'pageFoot', menuList: Array.from({ length: DIY_FOOTER_MEDIA_SLOT_LIMIT / 2 }, () => ({ imgList: [ticket, ticket] })) }];
    canonicalizeDiyEditorialMedia(value);
    expect(value[2].menuList!.at(-1)!.imgList).toEqual(['/api/assets/7', '/api/assets/7']);
    const invalid = structuredClone(value); invalid[0].swiperConfig!.list[0].img = ticket;
    invalid[2].menuList!.push({ imgList: [ticket] }); const before = structuredClone(invalid);
    expect(() => canonicalizeDiyEditorialMedia(invalid)).toThrow('DIY公开素材超过完整读取容量'); expect(invalid).toEqual(before);
  });
});

describe('explicit footer quantity branch through real controller/service/aggregate SQL', () => {
  let f: Awaited<ReturnType<typeof financeMemoryPostgres>>, container: ReturnType<typeof createContainerFromDb>;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  beforeAll(async () => {
    f = await financeMemoryPostgres([storeCart]); container = createContainerFromDb(f.db);
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('uid', 11); c.set('container', container); await next(); }); app.get('/cart/count', cartCount);
  });
  afterAll(async () => { await f?.close(); });
  beforeEach(async () => {
    await f.reset();
    await f.db.insert(storeCart).values([{ uid: 11, cartNum: 3 },
      { uid: 11, cartNum: 4, type: 2, activityId: 7, productId: 999, staffId: 4, storeId: 5, touristUid: 'actor-owned' },
      { uid: 11, cartNum: 9, status: 0 }, { uid: 11, cartNum: 8, isNew: 1 }, { uid: 11, cartNum: 7, isPay: 1 },
      { uid: 11, cartNum: 6, isDel: 1 }, { uid: 22, cartNum: 5 }]);
  });
  it.each([['', 4], ['?scope=cart', 3], ['?scope=cart&store_id=9', 3], ['?numType=0', 7], ['?scope=cart&numType=0', 7],
    ['?scope=cart&numType=0&store_id=9', 7], ['?numType=1', 2], ['?scope=cart&numType=1', 2]] as const)('preserves old count or explicit PHP aggregate for %s', async (query, count) => {
    const before = await f.db.select().from(storeCart), response = await app.request('/cart/count' + query);
    expect(await response.json()).toMatchObject({ status: 200, data: { count } }); expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await f.db.select().from(storeCart)).toEqual(before);
  });
  it.each(['scope=', 'scope=other', 'scope=cart&scope=cart', 'numType=', 'numType=false', 'numType=true', 'numType=00', 'numType=01',
    'numType=+0', 'numType=%200', 'numType=0%20', 'numType=0.0', 'numType=2', 'numType=-1', 'numType=[]', 'numType=0&numType=0',
    'numType=0&numType=1'])('rejects malformed or duplicated selectors before any count query: %s', async query => {
    const old = vi.spyOn(container.storeCartDao, 'count'), explicit = vi.spyOn(container.storeCartDao, 'footerCount');
    try {
      const response = await app.request('/cart/count?' + query); expect(await response.json()).toMatchObject({ status: 400 });
      expect(response.headers.get('Cache-Control')).toBe('private, no-store'); expect(old).not.toHaveBeenCalled(); expect(explicit).not.toHaveBeenCalled();
    } finally { old.mockRestore(); explicit.mockRestore(); }
  });
  it.each(['-1', 'NaN', '1.5', '9007199254740992', ' 7'])('rejects an invalid aggregate result %s rather than clamping or rounding', async value => {
    const fault = vi.spyOn(container.storeCartDao, 'footerCount').mockResolvedValue(value);
    try { await expect(new StoreCartService(container).footerCount(11, 0)).rejects.toThrow('购物车数量无效'); } finally { fault.mockRestore(); }
  });
  it('returns a numeric zero for an actor with no matching rows', async () => {
    expect(await new StoreCartService(container).footerCount(99, 0)).toBe(0); expect(await new StoreCartService(container).footerCount(99, 1)).toBe(0);
  });
});
