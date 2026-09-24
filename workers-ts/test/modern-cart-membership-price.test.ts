import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { cartList } from '../src/controllers/api/v1/OrderController';
import { StoreCartService } from '../src/services/order/StoreCartService';
import { memberRight, storeCart, storeProduct, storeProductAttrValue, systemUserLevel, user } from '../src/models/schema';

interface CartQuoteRow {
  id: number; truePrice?: string; trueSumPrice?: string; priceType?: string; levelName?: string; sumPrice?: string;
  productInfo: { price: string } | null;
}

describe('modern cart current-user prices, actual HTTP handler and PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([systemUserLevel]);
    f.app.get('/api/cart/list', cartList);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.setConfig({ member_func_status: '1', member_card_status: '1', svip_price_status: '1' });
    await f.db.insert(systemUserLevel).values({ id: 1, name: '银卡', discount: '88.50', isShow: 1 });
    await f.db.update(user).set({ level: 1, levelStatus: 1, isEverLevel: 0, isMoneyLevel: 0 });
    await f.db.insert(user).values({ uid: 22, account: 'second-local-user', nickname: '无会员本地样本' });
    await f.db.update(storeProduct).set({ price: '100.00', vipPrice: '1.00', freight: 1, tempId: 0 });
    await f.db.update(storeProductAttrValue).set({ price: '19.99', vipPrice: '10.00' });
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 70, unique: 'qablue01', suk: '蓝色,小号', stock: 8, price: '29.99', vipPrice: '28.00' });
    await f.db.update(storeCart).set({ isNew: 0 });
    await f.db.insert(storeCart).values([
      { id: 2, uid: 11, productId: 70, productAttrUnique: 'qablue01', cartNum: 3, isNew: 0, status: 1 },
      { id: 3, uid: 11, productId: 70, productAttrUnique: 'qared001', cartNum: 1, isNew: 1, status: 1 },
      { id: 4, uid: 22, productId: 70, productAttrUnique: 'qared001', cartNum: 1, isNew: 0, status: 1 },
    ]);
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); }, 30_000);
  async function rows(scope = 'scope=cart', uid = 11) {
    const response = await f.app.request(`/api/cart/list?${scope}`, { headers: { 'x-fixture-user': String(uid) } }, f.env);
    const body = await response.json() as { status: number; data: CartQuoteRow[] };
    expect(body.status).toBe(200); return body.data;
  }
  async function expectPrices(prices: string[], types: string[]) {
    const list = (await rows()).sort((a, b) => a.id - b.id);
    expect(list.map(row => row.id)).toEqual([1, 2]);
    expect(list.map(row => row.truePrice)).toEqual(prices);
    expect(list.map(row => row.priceType)).toEqual(types);
    expect(list.map(row => row.levelName)).toEqual(types.map(type => type === 'level' ? '银卡' : ''));
    expect(list.map(row => row.productInfo?.price)).toEqual(['19.99', '29.99']);
    expect(list.map(row => row.sumPrice)).toEqual(['39.98', '89.97']);
    expect(list.map(row => row.trueSumPrice)).toEqual(prices.map((price, i) => ((Number(price.replace('.', '')) * (i + 2)) / 100).toFixed(2)));
  }
  it('quotes each SKU once per unit, preserves raw amounts, and never writes business rows', async () => {
    const before = await f.snapshot();
    await expectPrices(['17.59', '26.39'], ['level', 'level']);
    expect(await f.snapshot()).toEqual(before);
  });
  it('chooses different paid/level winners within the same cart', async () => {
    await f.db.update(user).set({ isEverLevel: 1 }).where(eq(user.uid, 11));
    await expectPrices(['10.00', '26.39'], ['member', 'level']);
  });
  it('refreshes the same user after activation and level policy change, without cache dependence', async () => {
    await f.db.update(user).set({ levelStatus: 0 }).where(eq(user.uid, 11));
    await expectPrices(['19.99', '29.99'], ['', '']);
    await f.db.update(user).set({ levelStatus: 1 }).where(eq(user.uid, 11));
    await f.db.update(systemUserLevel).set({ discount: '50', name: '银卡' });
    await expectPrices(['9.99', '14.99'], ['level', 'level']);
  });
  it.each(['isShow', 'isDel'] as const)('does not grant a hidden or deleted level (%s)', async key => {
    await f.db.update(systemUserLevel).set({ [key]: key === 'isShow' ? 0 : 1 });
    await expectPrices(['19.99', '29.99'], ['', '']);
  });
  it.each(['member_card_status', 'svip_price_status'])('paid switch %s cannot disable the valid level price', async key => {
    await f.db.update(user).set({ isEverLevel: 1 }).where(eq(user.uid, 11));
    await f.setConfig({ [key]: '0' }); await expectPrices(['17.59', '26.39'], ['level', 'level']);
  });
  it('level switch does not remove independent paid eligibility', async () => {
    await f.db.update(user).set({ isEverLevel: 1 }).where(eq(user.uid, 11));
    await f.setConfig({ member_func_status: '0' }); await expectPrices(['10.00', '28.00'], ['member', 'member']);
  });
  it('expired paid eligibility and product opt-out never receive the advertised paid amount', async () => {
    await f.db.update(user).set({ isMoneyLevel: 1, overdueTime: Math.floor(Date.now() / 1000) - 1 }).where(eq(user.uid, 11));
    await expectPrices(['17.59', '26.39'], ['level', 'level']);
    await f.db.update(user).set({ isEverLevel: 1 }).where(eq(user.uid, 11));
    await f.db.update(storeProduct).set({ isVip: 0 }); await expectPrices(['17.59', '26.39'], ['level', 'level']);
  });
  it('direct-buy and unscoped reads keep exact owner rows and receive the same quote', async () => {
    expect(await rows('scope=buy&ids=3')).toMatchObject([{ id: 3, truePrice: '17.59', trueSumPrice: '17.59' }]);
    expect((await rows('')).map(row => row.id).sort()).toEqual([1, 2, 3]);
    expect(await rows('scope=cart', 22)).toMatchObject([{ id: 4, truePrice: '19.99', trueSumPrice: '19.99', priceType: '' }]);
  });
  it('matches actual server confirmation for selected membership unit prices', async () => {
    const cart = await rows('scope=buy&ids=3');
    const response = await f.app.request('/api/order/confirm', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': '11' },
      body: JSON.stringify({ cartIds: [3], addressId: 11, type: 0 }) }, f.env);
    const body = await response.json() as { status: number; data: { priceGroup: { pay_price: string } } };
    expect(body.status).toBe(200); expect(cart[0].trueSumPrice).toBe(body.data.priceGroup.pay_price);
  });
  it('invalid SKU rows cannot have a fabricated payable quote', async () => {
    await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.id, 1));
    const list = await rows(); expect(list.find(row => row.id === 1)).toMatchObject({ isValid: false, productInfo: null });
    expect(list.find(row => row.id === 1)).not.toHaveProperty('truePrice');
  });
  it('reads the level once for several rows and does not require a Worker Env or KV', async () => {
    const spy = vi.spyOn(f.container.systemUserLevelDao, 'getById');
    const list = await new StoreCartService(f.container).list(11, { mode: 'cart' });
    expect(spy).toHaveBeenCalledTimes(1); expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ truePrice: '17.59' })]));
  });

  it.each([
    { name: 'level with per-unit truncation', paid: false, config: {}, level: '88.50', productVip: 1, right: 1, expected: '17.59', type: 'level' },
    { name: 'cheaper paid SKU price', paid: true, config: {}, level: '88.50', productVip: 1, right: 1, expected: '10.00', type: 'member' },
    { name: 'cheaper level price', paid: true, config: {}, level: '50.00', productVip: 1, right: 1, expected: '9.99', type: 'level' },
    { name: 'paid membership switch off', paid: true, config: { member_card_status: '0' }, level: '88.50', productVip: 1, right: 1, expected: '17.59', type: 'level' },
    { name: 'paid pricing switch off', paid: true, config: { svip_price_status: '0' }, level: '88.50', productVip: 1, right: 1, expected: '17.59', type: 'level' },
    { name: 'level pricing switch off', paid: true, config: { member_func_status: '0' }, level: '88.50', productVip: 1, right: 1, expected: '10.00', type: 'member' },
    { name: 'product paid-price opt-out', paid: true, config: {}, level: '88.50', productVip: 0, right: 1, expected: '17.59', type: 'level' },
    { name: 'paid right disabled', paid: true, config: {}, level: '88.50', productVip: 1, right: 0, expected: '17.59', type: 'level' },
  ])('presale direct-buy display matches real confirmation: $name', async scenario => {
    await f.db.update(storeProduct).set({ isPresaleProduct: 1, presaleStartTime: 0,
      presaleEndTime: 2147483647, presaleDay: 7, isVip: scenario.productVip });
    await f.db.update(storeCart).set({ type: 6 }).where(eq(storeCart.id, 3));
    await f.db.update(user).set({ isEverLevel: scenario.paid ? 1 : 0 }).where(eq(user.uid, 11));
    await f.db.update(systemUserLevel).set({ discount: scenario.level });
    await f.db.update(memberRight).set({ status: scenario.right }).where(eq(memberRight.rightType, 'vip_price'));
    for (const [key, value] of Object.entries(scenario.config)) await f.setConfig({ [key]: value });
    const before = await f.snapshot();
    const [display] = await rows('scope=buy&ids=3');
    expect(display).toMatchObject({ id: 3, truePrice: scenario.expected, trueSumPrice: scenario.expected,
      priceType: scenario.type, levelName: scenario.type === 'level' ? '银卡' : '',
      productInfo: { price: '19.99' }, sumPrice: '19.99' });
    const response = await f.app.request('/api/order/confirm', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-fixture-user': '11' },
      body: JSON.stringify({ cartIds: [3], addressId: 11, type: 6, useIntegral: false }) }, f.env);
    const body = await response.json() as { status: number; msg: string; data: { priceGroup: { pay_price: string } } };
    expect(body.status, body.msg).toBe(200); expect(body.data.priceGroup.pay_price).toBe(display.trueSumPrice);
    expect(await f.snapshot()).toEqual(before);
  });
});
