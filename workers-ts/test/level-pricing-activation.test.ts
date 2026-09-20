import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { StoreProductService } from '../src/services/product/StoreProductService';
import { StoreCartService } from '../src/services/order/StoreCartService';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { OrderQuoteReconfirmRequired } from '../src/services/order/CheckoutConfirmation';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { levelActivate } from '../src/controllers/api/v1/UserLevelController';
import { storeProduct, storeProductAttr, storeProductAttrValue, storeProductEnsure,
  storeProductRelation, systemUserLevel, systemConfig, user, userRelation, storeCart,
  storeOrderCartInfo, storeOrderStatus, printDocument } from '../src/models/schema';

describe('level activation authorizes display, cart and order admission', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let products: StoreProductService;
  let beforeSequence: (() => Promise<void>) | undefined;
  let sequence = 0;
  const input = { cartIds: [1], addressId: 11, type: 0 };
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([storeProductAttr, storeProductEnsure, storeProductRelation,
      systemUserLevel, userRelation, storeOrderCartInfo, storeOrderStatus, printDocument]);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.setConfig({ member_func_status: '1' });
    await f.db.insert(systemUserLevel).values({ id: 1, name: 'Active level fixture', discount: '80.00', isShow: 1 });
    await f.db.update(user).set({ level: 1, levelStatus: 1, isEverLevel: 0, isMoneyLevel: 0, overdueTime: 0 });
    await f.db.update(storeProduct).set({ price: '100.00', vipPrice: '90.00', freight: 1, tempId: 0 });
    await f.db.update(storeProductAttrValue).set({ price: '100.00', vipPrice: '90.00' });
    products = new StoreProductService(f.container, f.env);
    f.app.post('/api/order/create/:key', orderCreate);
    beforeSequence = undefined;
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'activation-fixture', get: () => ({
      fetch: async () => { await beforeSequence?.(); return new Response(`activation_order_${++sequence}`); },
    }) } });
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); }, 30_000);
  const setStatus = (value: number, db = f.db) => db.update(user).set({ levelStatus: value }).where(eq(user.uid, 11));
  const cart = async () => new StoreCartService(f.container, f.env).projectLegacyV2Rows(11, await f.db.select().from(storeCart));
  const state = async () => ({ ...await f.snapshot(), levels: await f.db.select().from(systemUserLevel),
    details: await f.db.select().from(storeOrderCartInfo), statuses: await f.db.select().from(storeOrderStatus) });
  const request = async (path: string, body: object) => {
    const response = await f.app.request(path, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-fixture-user': '11',
    }, body: JSON.stringify(body) }, f.env);
    return response.json() as Promise<{ status: number; msg: string; data: {
      orderKey: string; quoteToken: string; errorCode?: string; pay_price: string; priceGroup: { pay_price: string };
    } }>;
  };
  const confirm = async () => {
    const receipt = await request('/api/order/confirm', input);
    expect(receipt.status, receipt.msg).toBe(200); return receipt.data;
  };
  const create = (receipt: { orderKey: string; quoteToken: string }) => request(`/api/order/create/${receipt.orderKey}`, {
    ...input, quoteToken: receipt.quoteToken,
  });
  const createWithDb = (db: DbClient, receipt: { orderKey: string; quoteToken: string }) =>
    new StoreOrderCreateService(createContainerFromDb(db), f.env).createOrder({ ...input,
      uid: 11, key: receipt.orderKey, quoteToken: receipt.quoteToken, userIp: '127.0.0.1' });
  const display = async (selected: string, priceType: string, levelName = '', uid = 11) => {
    expect.soft(await products.getProductDetail(70, uid)).toMatchObject({ vipPrice: selected, price_type: priceType, level_name: levelName });
    expect.soft((await products.getGoodsList({}, uid)).list).toMatchObject([{ vip_price: selected, price_type: priceType, level_name: levelName }]);
    expect.soft(await products.getRecommendProducts(uid)).toMatchObject([{ vip_price: selected, price_type: priceType, level_name: levelName }]);
    expect.soft(await products.getLegacyProductAttr(70, uid, false)).toMatchObject({
      storeInfo: { vip_price: selected, price_type: priceType, level_name: levelName },
    });
  };

  it.each([0, -1, 2])('does not grant a level price for inactive/invalid activation value %s', async status => {
    await setStatus(status);
    await display('0', '');
    expect.soft(await cart()).toMatchObject([{ truePrice: 100, price_type: '' }]);
    const receipt = await confirm();
    expect.soft(receipt.priceGroup.pay_price).toBe('200.00');
    expect((await create(receipt)).status).toBe(200);
    expect((await state()).orders).toMatchObject([{ payPrice: '200.00', paid: 0 }]);
  });

  it('recomputes a deactivation and reactivation on the same service without cache invalidation', async () => {
    await display('80.00', 'level', 'Active level fixture');
    expect(await cart()).toMatchObject([{ truePrice: 80 }]);
    await setStatus(0);
    const before = await state();
    await display('0', '');
    expect.soft(await cart()).toMatchObject([{ truePrice: 100 }]);
    expect.soft((await confirm()).priceGroup.pay_price).toBe('200.00');
    expect(await state()).toEqual(before);
    await setStatus(1);
    await display('80.00', 'level', 'Active level fixture');
    expect(await cart()).toMatchObject([{ truePrice: 80 }]);
    const receipt = await confirm(); expect(receipt.priceGroup.pay_price).toBe('160.00');
    expect((await create(receipt)).status).toBe(200);
  });

  it('keeps paid membership independent from inactive level membership', async () => {
    await f.setConfig({ member_card_status: '1', svip_price_status: '1' });
    await f.db.update(user).set({ levelStatus: 0, isEverLevel: 1 });
    await display('90.00', 'member');
    expect.soft(await cart()).toMatchObject([{ truePrice: 90, price_type: 'member' }]);
    const receipt = await confirm(); expect.soft(receipt.priceGroup.pay_price).toBe('180.00');
    expect((await create(receipt)).status).toBe(200);
    expect((await state()).orders).toMatchObject([{ payPrice: '180.00', paid: 0 }]);
  });

  it('does not mistake an advertised SVIP offer for payable eligibility when both memberships are inactive', async () => {
    await f.setConfig({ member_card_status: '1', svip_price_status: '1' });
    await setStatus(0);
    await display('90.00', 'member');
    expect.soft(await cart()).toMatchObject([{ truePrice: 100, price_type: '' }]);
    const receipt = await confirm(); expect.soft(receipt.priceGroup.pay_price).toBe('200.00');
    expect((await create(receipt)).status).toBe(200);
    expect((await state()).orders).toMatchObject([{ payPrice: '200.00', paid: 0 }]);
  });

  it('does not resolve or lock an inactive dangling level definition', async () => {
    await f.db.update(user).set({ levelStatus: 0, level: 999 });
    const lookup = vi.spyOn(f.container.systemUserLevelDao, 'getById');
    await display('0', '');
    expect(await cart()).toMatchObject([{ truePrice: 100 }]);
    const receipt = await confirm();
    expect.soft(lookup).not.toHaveBeenCalled();
    expect((await create(receipt)).status).toBe(200);
    expect((await state()).orders).toMatchObject([{ payPrice: '200.00', paid: 0 }]);
  });

  it('does not give anonymous visitors the last active visitor level', async () => {
    await display('80.00', 'level', 'Active level fixture');
    await display('0', '', '', 0);
  });

  it('applies the real activation controller commit to the next quote and rejects repeat activation', async () => {
    await setStatus(0);
    await f.db.insert(systemConfig).values({ menuName: 'level_activate_status', value: '1' });
    f.app.post('/api/user/level/activate', levelActivate);
    const before = await state();
    await display('0', '');
    expect((await request('/api/user/level/activate', [])).status).toBe(200);
    expect(await state()).toEqual({ ...before, users: before.users.map(row => ({ ...row, levelStatus: 1 })) });
    await display('80.00', 'level', 'Active level fixture');
    expect(await cart()).toMatchObject([{ truePrice: 80 }]);
    const receipt = await confirm(); expect(receipt.priceGroup.pay_price).toBe('160.00');
    expect((await create(receipt)).status).toBe(200);
    const created = await state();
    expect((await request('/api/user/level/activate', [])).status).toBe(400);
    expect(await state()).toEqual(created);
  });

  it.each([[1, 0], [0, 1]])('requires reconfirmation for activation %s → %s between confirm and create', async (from, to) => {
    await setStatus(from); const receipt = await confirm();
    await setStatus(to); const before = await state();
    expect(await create(receipt)).toMatchObject({ status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED' } });
    expect(await state()).toEqual(before);
    const refreshed = await request(`/api/order/computed/${receipt.orderKey}`, input);
    expect(refreshed.status, refreshed.msg).toBe(200);
    expect(refreshed.data.pay_price).toBe(to === 1 ? '160.00' : '200.00');
    expect((await create({ ...receipt, quoteToken: refreshed.data.quoteToken })).status).toBe(200);
    expect((await state()).orders).toMatchObject([{ payPrice: refreshed.data.pay_price, paid: 0 }]);
  });

  it.each([[1, 0], [0, 1]])('rolls back a late activation change %s → %s after creation has priced its items', async (from, to) => {
    await setStatus(from); const receipt = await confirm();
    let edited: Awaited<ReturnType<typeof state>> | undefined;
    beforeSequence = async () => { await setStatus(to); edited = await state(); };
    expect(await create(receipt)).toMatchObject({ status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED' } });
    expect(edited).toBeDefined(); expect(await state()).toEqual(edited);
  });

  it('binds activation even when a cheaper paid-member offer keeps the total unchanged', async () => {
    await f.setConfig({ member_card_status: '1', svip_price_status: '1' });
    await f.db.update(user).set({ isEverLevel: 1 });
    await f.db.update(storeProductAttrValue).set({ vipPrice: '70.00' });
    const receipt = await confirm(); expect(receipt.priceGroup.pay_price).toBe('140.00');
    await setStatus(0); const before = await state();
    expect(await create(receipt)).toMatchObject({ status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED' } });
    expect(await state()).toEqual(before);
  });

  it('does not turn an irrelevant inactive level edit into a receipt change', async () => {
    await setStatus(0); const receipt = await confirm();
    await f.db.update(systemUserLevel).set({ discount: '50.00' });
    await f.db.update(user).set({ level: 999 });
    expect((await create(receipt)).status).toBe(200);
    expect((await state()).orders).toMatchObject([{ payPrice: '200.00', paid: 0 }]);
  });

  it('ignores activation edits when the level feature is disabled', async () => {
    await f.setConfig({ member_func_status: '0' });
    await display('0', ''); const receipt = await confirm();
    beforeSequence = async () => { await setStatus(0); };
    expect((await create(receipt)).status).toBe(200);
    expect((await state()).orders).toMatchObject([{ payPrice: '200.00', paid: 0 }]);
  });

  it('replays a persisted order after deactivation without changing its price or stock twice', async () => {
    const receipt = await confirm(); const result = await create(receipt); expect(result.status).toBe(200);
    await setStatus(0); f.cache.clear(); const before = await state();
    expect(await create(receipt)).toEqual(result);
    expect(await state()).toEqual(before);
  });

  it('also enforces activation in the core when a test caller omits the receipt adapter', async () => {
    await setStatus(0);
    await StoreOrderCreateService.createWithRuntime(f.container, { CONFIG_KV: f.env.CONFIG_KV,
      nextOrderId: async () => 'activation_core_order' }, { ...input, uid: 11, key: 'activation_core', userIp: '127.0.0.1' });
    expect((await state()).orders).toMatchObject([{ payPrice: '200.00', paid: 0 }]);
  });

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each([[1, 0], [0, 1]])(
    'rejects committed activation %s → %s after an observed independent PostgreSQL SKU wait', async (from, to) => {
      await setStatus(from); const receipt = await confirm(); const before = await state();
      await withFinancePeers(f.db, async ([holder, buyer, editor]) => {
        await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
        const buying = outcome(createWithDb(buyer.db, receipt));
        await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
        await setStatus(to, editor.db);
        const edited = { ...before, users: await editor.db.select().from(user) };
        await holder.exec('COMMIT');
        const result = await buying;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
        expect(await state()).toEqual(edited);
      });
    }, 15_000);

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('keeps activation protected until the checkout transaction commits', async () => {
    const receipt = await confirm();
    await withFinancePeers(f.db, async ([holder, buyer, editor]) => {
      await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731642,74)');
      // Outer transaction is a test-only observation gate, not a production API.
      const buying = outcome(withTx(createContainerFromDb(buyer.db), async tx => {
        const result = await createWithDb(tx, receipt);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(731642,74)`); return result;
      }));
      await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      const editing = outcome(setStatus(0, editor.db));
      await waitForFinanceBlock(f.db, editor.pid, buyer.pid);
      await holder.exec('COMMIT');
      expect((await buying).ok).toBe(true); expect((await editing).ok).toBe(true);
    });
    expect((await state()).orders).toMatchObject([{ payPrice: '160.00', paid: 0 }]);
  }, 15_000);
});
