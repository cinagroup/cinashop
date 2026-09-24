import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { cartAdd, cartList, orderCreate } from '../src/controllers/api/v1/OrderController';
import { AdminConfigBatchService } from '../src/services/system/AdminConfigBatchService';
import { AdminNewcomerService } from '../src/services/activity/AdminNewcomerService';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { OrderQuoteReconfirmRequired } from '../src/services/order/CheckoutConfirmation';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import {
  legacyCache, printDocument, storeCouponIssue, storeCouponProduct, storeCouponUser, storeDiscounts,
  storeDiscountsProducts, storeNewcomer, storeOrderCartInfo, storeOrderStatus,
  storeSeckill, storeSeckillTime, storeActivity, storeCombination, storePink,
  storeIntegral, storeProductAttrValue, systemConfig, user,
} from '../src/models/schema';

type Reply = { status: number; msg: string; data: Record<string, unknown> | null };
const addBody = { productId: 70, unique: 'new04001', cartNum: 1, type: 7, activityId: 40, new: 1 };

// The test requires real independent sessions and an owned disposable PG16
// database. PGlite cannot prove advisory waits or create-order SQL protocols.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('newcomer HTTP purchase chain on PostgreSQL 16', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  const body = (cartId: number) => ({ cartIds: [cartId], addressId: 11, type: 7,
    shippingType: 1, storeId: 0, couponId: 0, useIntegral: false });
  const request = async (path: string, method = 'GET', payload?: object, uid = 11): Promise<Reply> => {
    const response = await f.app.request(path, { method, headers: {
      'content-type': 'application/json', 'x-fixture-user': String(uid),
    }, ...(payload ? { body: JSON.stringify(payload) } : {}) }, f.env);
    return response.json() as Promise<Reply>;
  };
  const add = async () => {
    const response = await request('/api/cart/add', 'POST', addBody);
    expect(response.status, response.msg).toBe(200);
    const id = Number(response.data?.id);
    expect(id).toBeGreaterThan(1);
    return id;
  };
  const quote = async (cartId: number) => {
    const response = await request('/api/order/confirm', 'POST', body(cartId));
    expect(response.status, response.msg).toBe(200);
    return { key: String(response.data?.orderKey), token: String(response.data?.quoteToken),
      data: response.data! };
  };

  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([
      legacyCache, printDocument, storeCouponIssue, storeCouponProduct, storeCouponUser,
      storeDiscounts, storeDiscountsProducts, storeNewcomer, storeOrderCartInfo,
      storeOrderStatus, storeSeckill, storeSeckillTime, storeActivity,
      storeCombination, storePink, storeIntegral,
    ]);
    f.config.newcomer_status = '1';
    f.config.register_price_status = '1';
    f.config.newcomer_limit_status = '0';
    f.config.newcomer_limit_time = '0';
    await f.db.insert(systemConfig).values([
      { menuName: 'newcomer_status', value: '1' },
      { menuName: 'register_price_status', value: '1' },
      { menuName: 'newcomer_limit_status', value: '0' },
      { menuName: 'newcomer_limit_time', value: '0' },
    ]);
    await f.db.insert(storeNewcomer).values({ id: 40, productId: 70, price: '8.00' });
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 40, type: 7,
      unique: addBody.unique, suk: '红色,大号', stock: 0, quota: 0, price: '8.00', cost: '3.00' });
    await f.db.update(user).set({ addTime: Math.floor(Date.now() / 1000), isNewcomer: 0 }).where(eq(user.uid, 11));
    await f.exec("SELECT setval(pg_get_serial_sequence('store_cart','id'),(SELECT max(id) FROM store_cart),true)");
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),(SELECT max(id) FROM store_product_attr_value),true)");
    f.app.post('/api/cart/add', cartAdd);
    f.app.get('/api/cart/list', cartList);
    f.app.post('/api/order/create/:key', orderCreate);
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'isolated', get: () => ({ fetch: async () => new Response('newcomer_pg_order') }) } });
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });

  it('adds the exact type=7 SKU, quotes from the server, creates once and consumes eligibility atomically', async () => {
    const cartId = await add();
    const rows = await request(`/api/cart/list?scope=buy&ids=${cartId}`);
    expect(rows.status, rows.msg).toBe(200);
    expect(rows.data).toEqual(expect.arrayContaining([expect.objectContaining({
      id: cartId, productId: 70, type: 7, activityId: 40, isNew: 1,
      isValid: true, sumPrice: '8.00',
    })]));
    const first = await quote(cartId);
    expect(first.data.priceGroup).toMatchObject({ sumPrice: '10.00', totalPrice: '8.00' });
    expect(first.data.cartInfo).toEqual(expect.arrayContaining([expect.objectContaining({
      id: cartId, truePrice: '8.00', activityId: 40,
    })]));
    const computed = await request(`/api/order/computed/${first.key}`, 'POST', body(cartId));
    expect(computed.status, computed.msg).toBe(200);
    expect(computed.data?.quoteToken).toMatch(/^[a-f0-9]{32}$/);
    const latestToken = String(computed.data?.quoteToken);
    const create = await request(`/api/order/create/${first.key}`, 'POST', { ...body(cartId), quoteToken: latestToken });
    expect(create.status, create.msg).toBe(200);
    const state = await f.snapshot();
    expect(state.orders).toHaveLength(1);
    expect(state.orders[0]).toMatchObject({ uid: 11, type: 7, activityId: 40, paid: 0 });
    expect(state.users.find(row => row.uid === 11)).toMatchObject({ isNewcomer: 1 });
    expect(state.skus.find(row => row.id === 1)).toMatchObject({ stock: 7 });
    expect(state.skus.find(row => row.id === 2)).toMatchObject({ stock: 0, quota: 0 });
    const replay = await request(`/api/order/create/${first.key}`, 'POST', { ...body(cartId), quoteToken: latestToken });
    expect(replay.status, replay.msg).toBe(200);
    expect(await f.snapshot()).toEqual(state);
  }, 30_000);

  it('keeps legacy activity stock=0 purchasable but invalidates removed SKU, disabled gate and expired account', async () => {
    const cartId = await add();
    const read = async () => ((await request('/api/cart/list')).data as unknown as Array<{
      id: number; isValid: boolean; productInfo: unknown; sumPrice?: string;
    }>).find(row => row.id === cartId);
    expect(await read()).toMatchObject({ isValid: true, sumPrice: '8.00' });
    await f.db.update(storeProductAttrValue).set({ stock: 0 }).where(eq(storeProductAttrValue.id, 2));
    expect(await read()).toMatchObject({ isValid: true, sumPrice: '8.00' });
    expect((await quote(cartId)).data.priceGroup).toMatchObject({ sumPrice: '10.00', totalPrice: '8.00' });
    await f.db.update(storeProductAttrValue).set({ stock: 0 }).where(eq(storeProductAttrValue.id, 1));
    expect(await read()).toMatchObject({ isValid: false, productInfo: null });
    await f.db.update(storeProductAttrValue).set({ stock: 8 }).where(eq(storeProductAttrValue.id, 1));
    await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.id, 2));
    expect(await read()).toMatchObject({ isValid: false, productInfo: null });
    await f.db.update(storeProductAttrValue).set({ isRetired: 0 }).where(eq(storeProductAttrValue.id, 2));
    await f.db.update(storeNewcomer).set({ isDel: 1 }).where(eq(storeNewcomer.id, 40));
    expect(await read()).toMatchObject({ isValid: false, productInfo: null });
    await f.db.update(storeNewcomer).set({ isDel: 0 }).where(eq(storeNewcomer.id, 40));
    await f.db.update(systemConfig).set({ value: '0' }).where(eq(systemConfig.menuName, 'newcomer_status'));
    expect(await read()).toMatchObject({ isValid: false, productInfo: null });
    await f.db.update(systemConfig).set({ value: '1' }).where(eq(systemConfig.menuName, 'newcomer_status'));
    await f.db.update(systemConfig).set({ value: '1' }).where(eq(systemConfig.menuName, 'newcomer_limit_status'));
    await f.db.update(systemConfig).set({ value: '1' }).where(eq(systemConfig.menuName, 'newcomer_limit_time'));
    await f.db.update(user).set({ addTime: Math.floor(Date.now() / 1000) - 3 * 86_400 }).where(eq(user.uid, 11));
    expect(await read()).toMatchObject({ isValid: false, productInfo: null });
    // Detail/add may still see stale KV. The cart projection and final create
    // use SQL and cannot advertise a purchasable row here.
  }, 30_000);

  it('rejects duplicate active campaign suk before add and after cart creation instead of selecting another price', async () => {
    const duplicate = { id: 3, productId: 40, type: 7, unique: 'new04002',
      suk: '红色,大号', stock: 0, quota: 0, price: '9.00' };
    await f.db.insert(storeProductAttrValue).values(duplicate);
    const rejected = await request('/api/cart/add', 'POST', addBody);
    expect(rejected.status).toBe(400);
    expect(rejected.msg).toMatch(/规格配置重复/);
    expect((await f.snapshot()).carts).toHaveLength(1);
    await f.db.delete(storeProductAttrValue).where(eq(storeProductAttrValue.id, 3));
    const cartId = await add();
    const first = await quote(cartId);
    await f.db.insert(storeProductAttrValue).values(duplicate);
    const rows = (await request('/api/cart/list')).data as unknown as Array<{ id: number; isValid: boolean; productInfo: unknown }>;
    expect(rows.find(row => row.id === cartId)).toMatchObject({ isValid: false, productInfo: null });
    expect((await request(`/api/cart/list?scope=buy&ids=${cartId}`)).status).toBe(400);
    expect((await request('/api/order/confirm', 'POST', body(cartId))).status).toBe(400);
    expect((await request(`/api/order/create/${first.key}`, 'POST', { ...body(cartId), quoteToken: first.token })).status).toBe(400);
    const state = await f.snapshot();
    expect(state.orders).toHaveLength(0);
    expect(state.users.find(row => row.uid === 11)).toMatchObject({ isNewcomer: 0 });
  }, 30_000);

  it('defaults an omitted unique only when the activity has exactly one active SKU', async () => {
    const withoutUnique = { productId: 70, cartNum: 1, type: 7, activityId: 40, new: 1 };
    const single = await request('/api/cart/add', 'POST', withoutUnique);
    expect(single.status, single.msg).toBe(200);
    expect(single.data?.id).toBeTruthy();
    await f.db.insert(storeProductAttrValue).values({ id: 3, productId: 40, type: 7,
      unique: 'new04002', suk: '蓝色,大号', stock: 0, quota: 0, price: '9.00' });
    const multiple = await request('/api/cart/add', 'POST', withoutUnique);
    expect(multiple.status).toBe(400);
    expect(multiple.msg).toMatch(/请选择唯一/);
    expect((await f.snapshot()).carts).toHaveLength(2);
  }, 30_000);

  it('rejects duplicate activity unique even when the competing SKU has another suk', async () => {
    await f.db.insert(storeProductAttrValue).values({ id: 3, productId: 40, type: 7,
      unique: addBody.unique, suk: '蓝色,大号', stock: 0, quota: 0, price: '9.00' });
    const rejected = await request('/api/cart/add', 'POST', addBody);
    expect(rejected.status).toBe(400);
    expect(rejected.msg).toMatch(/规格标识无效或重复/);
    expect((await f.snapshot()).carts).toHaveLength(1);
  }, 30_000);

  it('rejects duplicate base unique at add and invalidates an existing type-7 cart through list and quote', async () => {
    const cartId = await add();
    const first = await quote(cartId);
    await f.db.insert(storeProductAttrValue).values({ id: 3, productId: 70, type: 0,
      unique: 'qared001', suk: '蓝色,大号', stock: 8, price: '11.00' });
    const rejected = await request('/api/cart/add', 'POST', addBody);
    expect(rejected.status).toBe(400);
    expect(rejected.msg).toMatch(/基础规格标识重复/);
    const rows = (await request('/api/cart/list')).data as unknown as Array<{ id: number; isValid: boolean; productInfo: unknown }>;
    expect(rows.find(row => row.id === cartId)).toMatchObject({ isValid: false, productInfo: null });
    expect((await request(`/api/cart/list?scope=buy&ids=${cartId}`)).status).toBe(400);
    expect((await request('/api/order/confirm', 'POST', body(cartId))).status).toBe(400);
    expect((await request(`/api/order/create/${first.key}`, 'POST', { ...body(cartId), quoteToken: first.token })).status).toBe(400);
    expect((await f.snapshot()).orders).toHaveLength(0);
  }, 30_000);

  it('rechecks ambiguous campaign suk after a concurrent legacy insert commits before create', async () => {
    const cartId = await add();
    const first = await quote(cartId);
    await withFinancePeers(f.db, async ([writer, buyer]) => {
      await writer.exec('BEGIN');
      await writer.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('admin-newcomer-register-config'))`);
      await writer.db.insert(storeProductAttrValue).values({ id: 3, productId: 40, type: 7,
        unique: 'new04002', suk: '红色,大号', stock: 0, quota: 0, price: '9.00' });
      const create = outcome(new StoreOrderCreateService(createContainerFromDb(buyer.db), f.env)
        .createOrder({ ...body(cartId), uid: 11, key: first.key, quoteToken: first.token, userIp: '127.0.0.1' }));
      try { await waitForFinanceBlock(f.db, buyer.pid, writer.pid); }
      finally { await writer.exec('COMMIT'); }
      const result = await create;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
    });
    const state = await f.snapshot();
    expect(state.orders).toHaveLength(0);
    expect(state.users.find(row => row.uid === 11)).toMatchObject({ isNewcomer: 0 });
  }, 30_000);

  it.each([true, false])('generic Admin config %s while create waits: commit reconfirms, rollback permits one order', async commit => {
    const cartId = await add();
    const first = await quote(cartId);
    await withFinancePeers(f.db, async ([writer, buyer]) => {
      const original = writer.db.transaction.bind(writer.db);
      let entered!: () => void, release!: () => void;
      const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
      const releasePromise = new Promise<void>(resolve => { release = resolve; });
      vi.spyOn(writer.db, 'transaction').mockImplementation((callback, options) => original(async tx => {
        const result = await callback(tx);
        entered(); await releasePromise;
        if (!commit) throw new Error('forced Admin rollback');
        return result;
      }, options));
      const admin = outcome(new AdminConfigBatchService(createContainerFromDb(writer.db), f.env)
        .save({ newcomer_status: '0' }));
      await enteredPromise;
      const create = outcome(new StoreOrderCreateService(createContainerFromDb(buyer.db), f.env)
        .createOrder({ ...body(cartId), uid: 11, key: first.key, quoteToken: first.token, userIp: '127.0.0.1' }));
      try { await waitForFinanceBlock(f.db, buyer.pid, writer.pid); }
      finally { release(); }
      const [adminResult, orderResult] = await Promise.all([admin, create]);
      expect(adminResult.ok).toBe(commit);
      expect(orderResult.ok).toBe(!commit);
      if (commit && !orderResult.ok) expect(orderResult.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
    });
    const state = await f.snapshot();
    expect(state.orders).toHaveLength(commit ? 0 : 1);
    expect(state.users.find(row => row.uid === 11)).toMatchObject({ isNewcomer: commit ? 0 : 1 });
    const [config] = await f.db.select({ value: systemConfig.value }).from(systemConfig)
      .where(eq(systemConfig.menuName, 'newcomer_status'));
    expect(config?.value).toBe(commit ? '0' : '1');
  }, 30_000);

  it.each([true, false])('dedicated Admin SKU save %s while create waits: commit reconfirms, rollback preserves original quote', async commit => {
    const cartId = await add();
    const first = await quote(cartId);
    await withFinancePeers(f.db, async ([writer, buyer]) => {
      const original = writer.db.transaction.bind(writer.db);
      let entered!: () => void, release!: () => void;
      const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
      const releasePromise = new Promise<void>(resolve => { release = resolve; });
      vi.spyOn(writer.db, 'transaction').mockImplementation((callback, options) => original(async tx => {
        const result = await callback(tx);
        entered(); await releasePromise;
        if (!commit) throw new Error('forced newcomer Admin rollback');
        return result;
      }, options));
      const admin = outcome(new AdminNewcomerService(createContainerFromDb(writer.db), f.env)
        .saveRegisterConfig({ newcomer_status: 1, register_price_status: 1, newcomer_limit_status: 0,
          newcomer_limit_time: 0, product: [{ product_id: 70, skus: [{ unique: 'qared001', price: '9.00' }] }] }));
      await enteredPromise;
      const create = outcome(new StoreOrderCreateService(createContainerFromDb(buyer.db), f.env)
        .createOrder({ ...body(cartId), uid: 11, key: first.key, quoteToken: first.token, userIp: '127.0.0.1' }));
      try { await waitForFinanceBlock(f.db, buyer.pid, writer.pid); }
      finally { release(); }
      const [adminResult, result] = await Promise.all([admin, create]);
      expect(adminResult.ok).toBe(commit);
      expect(result.ok).toBe(!commit);
      if (commit && !result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
    });
    const state = await f.snapshot();
    expect(state.orders).toHaveLength(commit ? 0 : 1);
    expect(state.users.find(row => row.uid === 11)).toMatchObject({ isNewcomer: commit ? 0 : 1 });
    expect(state.skus.find(row => row.type === 7 && row.productId === 40)?.price).toBe(commit ? '9.00' : '8.00');
  }, 30_000);
});
