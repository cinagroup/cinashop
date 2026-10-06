import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import { storeCart, storeProduct, systemConfig, systemStore } from '../src/models/schema';
import { storeStatusV2 } from '../src/controllers/api/v1/PublicController';
import { orderCheckShipping } from '../src/controllers/api/v1/OrderController';
import { V2PublicCompatibilityService } from '../src/services/content/V2PublicCompatibilityService';
import { LegacyOrderCompatibilityService } from '../src/services/order/LegacyOrderCompatibilityService';
import { financePostgres } from './helpers/financePostgres';

/** Real SQL in the owned four-table fixture; public/session/KV boundaries are
 * isolated substitutes. Creation and nearby-store directory are separate contracts. */
describe('public status and ordinary shipping selection share SQL pickup authority', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  let publicService: V2PublicCompatibilityService;
  let checkout: LegacyOrderCompatibilityService;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  const cachedRead = vi.fn(async () => { throw new Error('pickup must not consult cached settings'); });
  const env = { CONFIG_KV: { get: cachedRead } } as unknown as Env;

  beforeAll(async () => {
    f = await financePostgres([systemConfig, systemStore, storeCart, storeProduct]);
    const container = createContainerFromDb(f.db);
    publicService = new V2PublicCompatibilityService(container, env);
    checkout = new LegacyOrderCompatibilityService(container, env);
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      c.set('container', container);
      c.set('uid', c.req.header('x-fixture-user') === '11' ? 11 : 0);
      await next();
    });
    app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    app.get('/api/v2/diy/get_store_status', storeStatusV2);
    app.post('/api/order/check_shipping', orderCheckShipping);
  }, 30_000);
  beforeEach(async () => {
    cachedRead.mockClear();
    await f.reset();
    await f.db.insert(systemConfig).values([
      { id: 1, menuName: 'store_func_status', value: '1' },
      { id: 2, menuName: 'store_self_mention', value: '1' },
    ]);
    await f.db.insert(systemStore).values({ id: 1, name: '隔离提货点', isStore: 1, isShow: 1, isDel: 0 });
    await f.db.insert(storeProduct).values({ id: 1, storeName: '隔离普通商品', deliveryType: '1,2' });
    await f.db.insert(storeCart).values({ id: 1, uid: 11, productId: 1, cartNum: 1, type: 0, status: 1 });
  });
  afterEach(() => { expect(cachedRead).not.toHaveBeenCalled(); });
  afterAll(async () => { await f?.close(); });

  const select = () => checkout.checkShipping(11, [1]);
  const set = (key: string, value: string) => f.db.update(systemConfig).set({ value }).where(eq(systemConfig.menuName, key));
  const drop = (key: string) => f.db.delete(systemConfig).where(eq(systemConfig.menuName, key));
  const snapshot = async () => ({
    configs: await f.db.select().from(systemConfig).orderBy(systemConfig.id),
    stores: await f.db.select().from(systemStore).orderBy(systemStore.id),
    products: await f.db.select().from(storeProduct).orderBy(storeProduct.id),
    carts: await f.db.select().from(storeCart).orderBy(storeCart.id),
  });

  it('uses current SQL while cached settings are unavailable and makes no business writes', async () => {
    const before = await snapshot();
    expect(await publicService.storeStatus()).toEqual({ store_status: 1 });
    expect(await select()).toEqual({ type: 0, methods: [1, 2] });
    expect(await snapshot()).toEqual(before);
  });

  it.each(['store_func_status', 'store_self_mention'])('removes pickup when SQL disables %s', async key => {
    await set(key, '0');
    expect(await publicService.storeStatus()).toEqual({ store_status: 0 });
    expect(await select()).toEqual({ type: 1, methods: [1] });
  });

  it('defaults a missing store-function switch on while requiring explicit self-mention', async () => {
    await drop('store_func_status');
    expect(await publicService.storeStatus()).toEqual({ store_status: 1 });
    expect((await select()).methods).toEqual([1, 2]);
    await drop('store_self_mention');
    expect(await publicService.storeStatus()).toEqual({ store_status: 0 });
    expect((await select()).methods).toEqual([1]);
  });

  it.each(['store_func_status', 'store_self_mention'])('treats a present empty %s as disabled', async key => {
    await set(key, '');
    expect(await publicService.storeStatus()).toEqual({ store_status: 0 });
    expect((await select()).methods).toEqual([1]);
  });

  it('normalizes legacy JSON scalar flags rather than advertising encoded zero', async () => {
    await set('store_self_mention', '"0"');
    expect(await publicService.storeStatus()).toEqual({ store_status: 0 });
    expect((await select()).methods).toEqual([1]);
    await set('store_self_mention', '"1"');
    await set('store_func_status', '"1"');
    expect(await publicService.storeStatus()).toEqual({ store_status: 1 });
    expect((await select()).methods).toEqual([1, 2]);
  });

  it('preserves global scope, hidden winners and exact sort/id priority', async () => {
    await f.db.insert(systemConfig).values([
      { id: 3, menuName: 'store_self_mention', value: '0', isStore: 1, sort: 999 },
      { id: 4, menuName: 'store_self_mention', value: '0', sort: -1 },
      { id: 5, menuName: 'store_self_mention', value: '0', sort: 5 },
      { id: 6, menuName: 'store_self_mention', value: '1', sort: 5, status: 0 },
    ]);
    expect(await publicService.storeStatus()).toEqual({ store_status: 1 });
    expect((await select()).methods).toEqual([1, 2]);
    await set('store_func_status', '0');
    await f.db.insert(systemConfig).values({ id: 7, menuName: 'store_func_status', value: '1', isStore: 1, sort: 999 });
    expect(await publicService.storeStatus()).toEqual({ store_status: 0 });
    expect((await select()).methods).toEqual([1]);
  });

  it.each(['2', 'true', '{}', 'invalid'])('rejects corrupt flag %s instead of granting pickup', async value => {
    await set('store_self_mention', value);
    await expect(publicService.storeStatus()).rejects.toThrow('自提开关配置无效');
    await expect(select()).rejects.toThrow('自提开关配置无效');
  });

  it('still validates self-mention when the separate store-function flag is disabled', async () => {
    await set('store_func_status', '0');
    await set('store_self_mention', 'invalid');
    await expect(publicService.storeStatus()).rejects.toThrow('自提开关配置无效');
    await expect(select()).rejects.toThrow('自提开关配置无效');
  });

  it.each([{ isStore: 0 }, { isShow: 0 }, { isDel: 1 }])('requires an eligible pickup store %j without changing the global status response', async patch => {
    await f.db.update(systemStore).set(patch);
    expect(await publicService.storeStatus()).toEqual({ store_status: 1 });
    expect(await select()).toEqual({ type: 1, methods: [1] });
  });

  it('does not invent express delivery for a pickup-only product after pickup closes', async () => {
    await f.db.update(storeProduct).set({ deliveryType: '2' });
    await set('store_self_mention', '0');
    expect(await select()).toEqual({ type: 0, methods: [] });
  });

  it('preserves express and local-delivery methods when pickup is disabled', async () => {
    await f.db.update(storeProduct).set({ deliveryType: '1,2,3' });
    await set('store_self_mention', '0');
    expect(await select()).toEqual({ type: 1, methods: [1, 3] });
  });

  it('serves actual public status and authenticated selection with stable response fields', async () => {
    const before = await snapshot();
    const status = await app.request('/api/v2/diy/get_store_status', {}, env);
    expect(await status.json()).toMatchObject({ status: 200, data: { store_status: 1 } });
    const response = await app.request('/api/order/check_shipping', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': '11' },
      body: JSON.stringify({ cartIds: [1] }),
    }, env);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ status: 200, data: { type: 0, methods: [1, 2] } });
    expect(await snapshot()).toEqual(before);
  });

  it('rejects unauthenticated and foreign-cart HTTP selection without writes', async () => {
    const before = await snapshot();
    const request = (authenticated: boolean) => app.request('/api/order/check_shipping', {
      method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { 'x-fixture-user': '11' } : {}) },
      body: JSON.stringify({ cartIds: [1] }),
    }, env);
    expect(await (await request(false)).json()).toMatchObject({ status: 400 });
    await f.db.update(storeCart).set({ uid: 22 });
    expect(await (await request(true)).json()).toMatchObject({ status: 400 });
    await f.db.update(storeCart).set({ uid: 11 });
    expect(await snapshot()).toEqual(before);
  });
});
