import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { StoreProductService } from '../src/services/product/StoreProductService';
import { StoreCartService } from '../src/services/order/StoreCartService';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { readMembershipPricingSources } from '../src/services/order/CheckoutPricingSources';
import * as pricingSources from '../src/services/order/CheckoutPricingSources';
import { storeProduct, storeProductAttr, storeProductAttrValue, storeProductEnsure,
  storeProductRelation, systemUserLevel, systemConfig, memberRight, user, userRelation,
  storeCart, storeOrderCartInfo, storeOrderStatus, printDocument } from '../src/models/schema';

describe('membership feature policy across catalogue, legacy cart and checkout', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let products: StoreProductService;
  const keys = ['member_func_status', 'member_card_status', 'svip_price_status'] as const;
  const input = { cartIds: [1], addressId: 11, type: 0 };
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([storeProductAttr, storeProductEnsure, storeProductRelation,
      systemUserLevel, userRelation, storeOrderCartInfo, storeOrderStatus, printDocument]);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.setConfig(Object.fromEntries(keys.map(key => [key, '1'])));
    await f.db.insert(systemUserLevel).values({ id: 1, name: 'Policy fixture', discount: '80.00', isShow: 1 });
    await f.db.update(user).set({ level: 1, levelStatus: 1, isEverLevel: 1 }).where(eq(user.uid, 11));
    await f.db.update(storeProduct).set({ price: '100.00', vipPrice: '70.00', freight: 1, tempId: 0 });
    await f.db.update(storeProductAttrValue).set({ price: '100.00', vipPrice: '70.00' });
    products = new StoreProductService(f.container, f.env);
    f.app.post('/api/order/create/:key', orderCreate);
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'policy-fixture', get: () => ({
      fetch: async () => new Response('policy_fixture_order'),
    }) } });
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); }, 30_000);
  const setSql = (name: string, value: string) => f.db.update(systemConfig).set({ value }).where(eq(systemConfig.menuName, name));
  const cart = async () => new StoreCartService(f.container, f.env).projectLegacyV2Rows(11, await f.db.select().from(storeCart));
  const request = async (path: string, body: object) => {
    const response = await f.app.request(path, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-fixture-user': '11',
    }, body: JSON.stringify(body) }, f.env);
    return response.json() as Promise<{ status: number; msg: string; data: {
      orderKey: string; quoteToken: string; priceGroup: { pay_price: string };
    } }>;
  };
  const display = async (price: string, priceType: string, paidEnabled: boolean, uid = 11) => {
    const selected = priceType ? price : '0';
    expect.soft(await products.getProductDetail(70, uid)).toMatchObject({ vipPrice: selected,
      price_type: priceType, attr_value: [{ vip_price: paidEnabled ? '70.00' : '0' }] });
    expect.soft((await products.getGoodsList({}, uid)).list).toMatchObject([{ vip_price: selected, price_type: priceType }]);
    expect.soft(await products.getRecommendProducts(uid)).toMatchObject([{ vip_price: selected, price_type: priceType }]);
    expect.soft(await products.getLegacyProductAttr(70, uid, false)).toMatchObject({
      storeInfo: { vip_price: selected, price_type: priceType },
      productValue: { '红色,大号': { vip_price: paidEnabled ? '70.00' : '0' } },
    });
  };

  it.each(keys)('follows SQL %s off and on despite the opposite KV value', async key => {
    if (key === 'member_func_status') await f.setConfig({ member_card_status: '0' });
    await products.getProductDetail(70, 11); await cart();
    await setSql(key, '0'); f.config[key] = '1';
    const off = key === 'member_func_status' ? '100.00' : '80.00';
    const offType = key === 'member_func_status' ? '' : 'level';
    await display(off, offType, false);
    expect.soft(await cart()).toMatchObject([{ truePrice: Number(off), price_type: offType }]);
    const disabledQuote = await request('/api/order/confirm', input);
    expect(disabledQuote.status, disabledQuote.msg).toBe(200);
    expect(disabledQuote.data.priceGroup.pay_price).toBe((Number(off) * 2).toFixed(2));
    await setSql(key, '1'); f.config[key] = '0';
    const on = key === 'member_func_status' ? '80.00' : '70.00';
    const onType = key === 'member_func_status' ? 'level' : 'member';
    await display(on, onType, key !== 'member_func_status');
    expect.soft(await cart()).toMatchObject([{ truePrice: Number(on), price_type: onType }]);
    const receipt = await request('/api/order/confirm', input);
    expect(receipt.status, receipt.msg).toBe(200);
    expect(receipt.data.priceGroup.pay_price).toBe((Number(on) * 2).toFixed(2));
    expect((await request(`/api/order/create/${receipt.data.orderKey}`, {
      ...input, quoteToken: receipt.data.quoteToken,
    })).status).toBe(200);
    expect((await f.snapshot()).orders).toMatchObject([{ paid: 0, payPrice: (Number(on) * 2).toFixed(2) }]);
  });

  it.each(['hidden', 'zero', 'missing', 'losing-duplicate'] as const)('respects SQL paid-price right %s', async mode => {
    if (mode === 'missing') await f.db.delete(memberRight).where(eq(memberRight.id, 1));
    else await f.db.update(memberRight).set(mode === 'zero' ? { number: 0 } : { status: 0 }).where(eq(memberRight.id, 1));
    if (mode === 'losing-duplicate') await f.db.insert(memberRight).values({ id: 99, rightType: 'vip_price', status: 1, number: 1 });
    await display('80.00', 'level', false);
    expect(await cart()).toMatchObject([{ truePrice: 80, price_type: 'level' }]);
  });

  it('does not advertise disabled paid-price fields to anonymous visitors', async () => {
    await setSql('svip_price_status', '0');
    await display('100.00', '', false, 0);
  });

  it('uses global scope, sort/id priority, scalar normalization and not config field visibility', async () => {
    await f.db.insert(systemConfig).values([
      { id: 100, menuName: 'member_card_status', value: '"0"', sort: 10, status: 0 },
      { id: 101, menuName: 'member_card_status', value: '1', sort: 9 },
      { id: 102, menuName: 'member_card_status', value: '1', sort: 99, isStore: 1 },
    ]);
    await display('80.00', 'level', false);
    expect.soft(await cart()).toMatchObject([{ truePrice: 80 }]);
    await f.db.insert(systemConfig).values({ id: 103, menuName: 'member_card_status', value: '"1"', sort: 10 });
    await display('70.00', 'member', true);
    expect.soft(await cart()).toMatchObject([{ truePrice: 70 }]);
  });

  describe.each(keys)('validating %s', key => {
    it.each(['1.5', 'not-a-flag', 'true', '9007199254740992'])('rejects malformed SQL value %s rather than enabling a cached discount', async value => {
      await setSql(key, value);
      const before = await f.snapshot();
      await expect.soft(products.getProductDetail(70, 11)).rejects.toThrow(/配置/);
      await expect.soft(cart()).rejects.toThrow(/配置/);
      expect((await request('/api/order/confirm', input)).status).toBe(400);
      expect(await f.snapshot()).toEqual(before);
    });
  });

  it('reads only three membership keys and the paid-price right in one SQL statement', async () => {
    const select = vi.spyOn(f.db, 'select');
    const source = await readMembershipPricingSources(f.db);
    expect(select).toHaveBeenCalledTimes(1);
    expect(source).toEqual({ values: Object.fromEntries(keys.map(key => [key, '1'])),
      rightRows: [{ rightType: 'vip_price', status: 1, number: 1 }] });
  });

  it('does not require KV or mutate business/policy rows for display and cart reads', async () => {
    const get = vi.spyOn(f.env.CONFIG_KV, 'get').mockImplementation(async () => { throw new Error('synthetic KV outage'); });
    const put = vi.spyOn(f.env.CONFIG_KV, 'put');
    const snapshot = async () => ({ ...await f.snapshot(), configs: await f.db.select().from(systemConfig),
      rights: await f.db.select().from(memberRight), levels: await f.db.select().from(systemUserLevel) });
    const before = await snapshot();
    await display('70.00', 'member', true);
    expect(await cart()).toMatchObject([{ truePrice: 70 }]);
    expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it('propagates policy read failure instead of serving earlier cached discounts', async () => {
    await display('70.00', 'member', true); await cart();
    vi.spyOn(pricingSources, 'readMembershipPricingSources').mockRejectedValue(new Error('synthetic policy SQL failure'));
    await expect(products.getProductDetail(70, 11)).rejects.toThrow('synthetic policy SQL failure');
    await expect(products.getGoodsList({}, 11)).rejects.toThrow('synthetic policy SQL failure');
    await expect(products.getRecommendProducts(11)).rejects.toThrow('synthetic policy SQL failure');
    await expect(products.getLegacyProductAttr(70, 11, false)).rejects.toThrow('synthetic policy SQL failure');
    await expect(cart()).rejects.toThrow('synthetic policy SQL failure');
  });

  it.each(['missing', 'empty'] as const)('matches checkout default-enabled semantics for %s switches', async mode => {
    if (mode === 'missing') for (const key of keys) await f.db.delete(systemConfig).where(eq(systemConfig.menuName, key));
    else for (const key of keys) await setSql(key, '');
    for (const key of keys) f.config[key] = '0';
    await display('70.00', 'member', true);
    expect.soft(await cart()).toMatchObject([{ truePrice: 70 }]);
    expect((await request('/api/order/confirm', input)).data.priceGroup.pay_price).toBe('140.00');
  });
});
