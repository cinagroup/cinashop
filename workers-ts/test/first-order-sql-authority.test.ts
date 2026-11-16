import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { StoreCartService } from '../src/services/order/StoreCartService';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { issueCheckoutConfirmation, readCheckoutConfirmation } from '../src/services/order/CheckoutConfirmation';
import { firstOrderDiscountConfig, loadFirstOrderDiscountConfig, loadFirstOrderDiscountConfigFromDb,
  quoteFirstOrderDiscount, quoteFirstOrderDiscountFromDb } from '../src/services/activity/StoreNewcomerService';
import * as pricingSources from '../src/services/order/CheckoutPricingSources';
import { systemConfig, memberRight, user, storeCart, storeOrder, storeProduct, storeProductAttrValue,
  storeCouponIssue, storeCouponUser, storeCouponProduct, storePromotions, storePromotionsAuxiliary,
  storeOrderCartInfo, storeOrderStatus, printDocument } from '../src/models/schema';

const keys = ['newcomer_status', 'first_order_status', 'first_order_discount',
  'first_order_discount_limit', 'newcomer_limit_status', 'newcomer_limit_time'] as const;
const baseline = { newcomer_status: '1', first_order_status: '1', first_order_discount: '85.99',
  first_order_discount_limit: '100.00', newcomer_limit_status: '1', newcomer_limit_time: '30' };

// Native execution is required: a missing TEST_FINANCE_POSTGRES_URL is a skip,
// never evidence of PostgreSQL acceptance. The local native runner supplies it.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('first-order SQL authority across config, cart and checkout quote', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let now: number;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await createPcCheckoutQuoteFixture([storeCouponIssue, storeCouponUser, storeCouponProduct,
      storeOrderCartInfo, storeOrderStatus, printDocument]);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.setConfig(baseline);
    now = Math.floor(Date.now() / 1000);
    await f.db.update(user).set({ isFirstOrder: 0, addTime: now - 3 * 86400 }).where(eq(user.uid, 11));
    await f.db.update(storeCart).set({ cartNum: 1 }).where(eq(storeCart.id, 1));
    await f.db.update(storeProduct).set({ price: '19.99', freight: 1, tempId: 0 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ price: '19.99' }).where(eq(storeProductAttrValue.id, 1));
  }, 60_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 60_000);

  const setSql = (key: string, value: string) => f.db.update(systemConfig).set({ value })
    .where(eq(systemConfig.menuName, key));
  const state = async () => ({ ...await f.snapshot(), configs: await f.db.select().from(systemConfig),
    rights: await f.db.select().from(memberRight), issues: await f.db.select().from(storeCouponIssue),
    coupons: await f.db.select().from(storeCouponUser), scopes: await f.db.select().from(storeCouponProduct),
    promotions: await f.db.select().from(storePromotions), auxiliary: await f.db.select().from(storePromotionsAuxiliary),
    cache: [...f.cache.entries()], cacheWrites: [...f.writes] });
  const quote = (couponId = 0) => new StoreOrderCreateService(f.container, f.env)
    .quoteOrder({ uid: 11, cartIds: [1], addressId: 11, couponId });
  const checkReaders = async (eligible: boolean, discount: string, cents: number) => {
    const before = await state();
    expect(await quoteFirstOrderDiscount(f.container, f.env, 11, 1999)).toMatchObject({
      eligible, couponExclusive: eligible, subtotal: '19.99', firstOrderPrice: discount,
    });
    // An env-free cart service must use SQL rather than requiring a dummy KV facade.
    expect(await new StoreCartService(f.container).quoteFirstOrder(11, [1])).toMatchObject({
      eligible, couponExclusive: eligible, subtotal: '19.99', firstOrderPrice: discount,
    });
    await new StoreCartService(f.container, f.env).projectLegacyV2Rows(11, await f.db.select().from(storeCart));
    expect(await quote()).toMatchObject({ rawTotalCents: 1999, firstOrderPriceCents: cents,
      couponPriceCents: 0, payCents: 1999 - cents });
    expect(await state()).toEqual(before);
  };

  const authorityCases = [
    { key: 'newcomer_status', first: '0', second: '1', firstEligible: false, firstDiscount: '0.00', firstCents: 0 },
    { key: 'first_order_status', first: '0', second: '1', firstEligible: false, firstDiscount: '0.00', firstCents: 0 },
    { key: 'first_order_discount', first: '100', second: '85.99', firstEligible: true, firstDiscount: '0.00', firstCents: 0 },
    { key: 'first_order_discount_limit', first: '0', second: '100.00', firstEligible: true, firstDiscount: '0.00', firstCents: 0 },
    { key: 'newcomer_limit_status', first: '1', second: '0', firstEligible: false, firstDiscount: '0.00', firstCents: 0 },
    { key: 'newcomer_limit_time', first: '1', second: '30', firstEligible: false, firstDiscount: '0.00', firstCents: 0 },
  ] as const;
  it.each(authorityCases)('uses SQL $key in both directions against the opposite stale KV', async test => {
    if (test.key === 'newcomer_limit_status') await setSql('newcomer_limit_time', '1');
    await setSql(test.key, test.first); f.config[test.key] = test.second;
    await checkReaders(test.firstEligible, test.firstDiscount, test.firstCents);
    await setSql(test.key, test.second); f.config[test.key] = test.first;
    await checkReaders(true, '2.99', 299);
  });

  it('ignores a complete KV outage for direct configuration, full cart and quote without cache refill', async () => {
    const get = vi.spyOn(f.env.CONFIG_KV, 'get').mockRejectedValue(Error('Synthetic KV outage'));
    const put = vi.spyOn(f.env.CONFIG_KV, 'put').mockRejectedValue(Error('Synthetic KV outage'));
    expect(await loadFirstOrderDiscountConfig(f.container, f.env)).toEqual({ enabled: true,
      limitEnabled: true, limitDays: 30, payPercent: 85, limitCents: 10000 });
    await checkReaders(true, '2.99', 299);
    expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
  });

  it('does not confuse forbidden first-order cache I/O with legitimate immutable receipt KV', async () => {
    const originalGet = f.env.CONFIG_KV.get.bind(f.env.CONFIG_KV);
    const originalPut = f.env.CONFIG_KV.put.bind(f.env.CONFIG_KV);
    const isConfigKey = (key: string | string[]) => (Array.isArray(key) ? key : [key]).some(name => name.startsWith('cfg_'));
    const get = vi.spyOn(f.env.CONFIG_KV, 'get').mockImplementation(async (...args) => {
      if (isConfigKey(args[0])) throw Error('Configuration cache unavailable');
      return originalGet(...args);
    });
    const put = vi.spyOn(f.env.CONFIG_KV, 'put').mockImplementation(async (...args) => {
      if (isConfigKey(args[0])) throw Error('Configuration cache unavailable');
      return originalPut(...args);
    });
    await checkReaders(true, '2.99', 299);
    expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
    const priced = await quote(), scope = { uid: 11, key: 'first-order-sql-native-receipt' };
    const token = await issueCheckoutConfirmation(f.env.CONFIG_KV, scope, priced.confirmationFingerprint);
    expect((await readCheckoutConfirmation(f.env.CONFIG_KV, scope, token)).fingerprint).toBe(priced.confirmationFingerprint);
    expect(put).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1);
    expect(f.cache.size).toBe(1);
    expect([...get.mock.calls, ...put.mock.calls].every(([key]) => !isConfigKey(key))).toBe(true);
  });

  it('reads exactly six bounded SQL keys in one statement without unrelated membership policy', async () => {
    await setSql('member_func_status', 'not-a-membership-flag');
    await f.db.delete(memberRight);
    const select = vi.spyOn(f.db, 'select');
    expect(await pricingSources.readFirstOrderPricingSources(f.db)).toEqual(baseline);
    expect(select).toHaveBeenCalledTimes(1); select.mockRestore();
    expect(await loadFirstOrderDiscountConfigFromDb(f.container)).toMatchObject({ enabled: true, payPercent: 85 });
  });

  it('uses global sort/id winners and scalar values independently of configuration field visibility', async () => {
    await f.db.insert(systemConfig).values([
      { id: 1000, menuName: 'first_order_discount', value: '"85.99"', sort: 10, status: 0 },
      { id: 1001, menuName: 'first_order_discount', value: '100', sort: 9, status: 1 },
      { id: 1002, menuName: 'first_order_discount', value: '100', sort: 99, isStore: 1 },
    ]);
    await checkReaders(true, '2.99', 299);
    await f.db.insert(systemConfig).values({ id: 1003, menuName: 'first_order_discount', value: '"90.00"', sort: 10, status: 0 });
    await checkReaders(true, '1.99', 199);
  });

  it.each(['missing', 'empty'] as const)('preserves all six legacy defaults for %s SQL values', async mode => {
    if (mode === 'missing') await f.db.delete(systemConfig).where(inArray(systemConfig.menuName, [...keys]));
    else await f.db.update(systemConfig).set({ value: '' }).where(inArray(systemConfig.menuName, [...keys]));
    Object.assign(f.config, baseline);
    expect(await loadFirstOrderDiscountConfig(f.container, f.env)).toEqual({ enabled: false,
      limitEnabled: true, limitDays: 0, payPercent: 100, limitCents: 0 });
    await checkReaders(false, '0.00', 0);
  });

  it.each([
    { name: 'quoted scalars', values: { newcomer_status: '"true"', first_order_status: ' YES ', newcomer_limit_status: '"off"',
      newcomer_limit_time: '"-3"', first_order_discount: '"85.99"', first_order_discount_limit: '"3.01"' },
      expected: { enabled: true, limitEnabled: false, limitDays: 0, payPercent: 85, limitCents: 301 }, discount: '2.99', cents: 299 },
    { name: 'permissive flags and invalid amount fallbacks', values: { newcomer_status: '1.5', first_order_status: 'anything',
      newcomer_limit_status: 'null', newcomer_limit_time: '2.5', first_order_discount: '101', first_order_discount_limit: '-1' },
      expected: { enabled: true, limitEnabled: false, limitDays: 0, payPercent: 100, limitCents: 0 }, discount: '0.00', cents: 0 },
    { name: 'overprecision fallbacks', values: { ...baseline, first_order_discount: '85.999', first_order_discount_limit: '1.000' },
      expected: { enabled: true, limitEnabled: true, limitDays: 30, payPercent: 100, limitCents: 0 }, discount: '0.00', cents: 0 },
    { name: 'nested quoting decoded once by the existing SQL policy', values: {
      newcomer_status: JSON.stringify('"false"'), first_order_status: JSON.stringify('"0"'),
      newcomer_limit_status: JSON.stringify('"off"'), newcomer_limit_time: JSON.stringify('"30"'),
      first_order_discount: JSON.stringify('"85.99"'), first_order_discount_limit: JSON.stringify('"3.01"') },
      expected: { enabled: true, limitEnabled: true, limitDays: 0, payPercent: 100, limitCents: 0 }, discount: '0.00', cents: 0 },
  ])('shares the existing permissive normalization for $name across all readers', async test => {
    await f.setConfig(test.values);
    expect(firstOrderDiscountConfig(test.values)).toEqual(test.expected);
    expect(await loadFirstOrderDiscountConfigFromDb(f.container)).toEqual(test.expected);
    await checkReaders(true, test.discount, test.cents);
  });

  it('propagates SQL failures instead of using a previous or cached first-order policy', async () => {
    await checkReaders(true, '2.99', 299);
    vi.spyOn(pricingSources, 'readFirstOrderPricingSources').mockRejectedValue(Error('First-order SQL unavailable'));
    await expect(loadFirstOrderDiscountConfig(f.container, f.env)).rejects.toThrow('First-order SQL unavailable');
    await expect(new StoreCartService(f.container).quoteFirstOrder(11, [1])).rejects.toThrow('First-order SQL unavailable');
    vi.spyOn(pricingSources, 'readCheckoutPricingSources').mockRejectedValue(Error('Checkout SQL unavailable'));
    await expect(quote()).rejects.toThrow('Checkout SQL unavailable');
  });

  it('ignores paid type7 history but honors paid ordinary history even after soft deletion', async () => {
    await f.db.insert(storeOrder).values({ id: 1000, uid: 11, orderId: 'first_order_history', unique: 'first_order_history', paid: 1, type: 7 });
    await checkReaders(true, '2.99', 299);
    await f.db.update(storeOrder).set({ type: 0, isDel: 1 }).where(eq(storeOrder.id, 1000));
    await checkReaders(false, '0.00', 0);
  });

  it('preserves expiry equality, user flags and deleted-user eligibility without writes', async () => {
    await setSql('newcomer_limit_time', '1');
    await f.db.update(user).set({ addTime: now - 86400 }).where(eq(user.uid, 11));
    const before = await state();
    expect(await quoteFirstOrderDiscountFromDb(f.container, 11, 1999, now)).toMatchObject({ eligible: true, firstOrderPrice: '2.99' });
    expect(await quoteFirstOrderDiscountFromDb(f.container, 11, 1999, now + 1)).toMatchObject({ eligible: false, firstOrderPrice: '0.00' });
    expect(await state()).toEqual(before);
    for (const isFirstOrder of [-1, 1]) {
      await f.db.update(user).set({ isFirstOrder }).where(eq(user.uid, 11));
      expect((await quoteFirstOrderDiscountFromDb(f.container, 11, 1999, now)).eligible).toBe(false);
    }
    await f.db.update(user).set({ isFirstOrder: 0, isDel: 1 }).where(eq(user.uid, 11));
    expect((await quoteFirstOrderDiscountFromDb(f.container, 11, 1999, now)).eligible).toBe(false);
  });

  it('keeps zero-saving first-order eligibility exclusive of an actual coupon and active promotion', async () => {
    await setSql('first_order_discount', '100');
    await f.db.insert(storePromotions).values({ id: 1000, name: 'Native ordinary ninety-percent promotion', promotionsType: 1,
      type: 1, pid: 0, storeId: 0, status: 1, isDel: 0, startTime: now - 3600, stopTime: now + 3600,
      discount: '90', productPartakeType: 1, isLimit: 0, overlay: '5' });
    await f.db.insert(storeCouponIssue).values({ id: 1000, couponType: 0, type: 1, couponTitle: 'Native three-unit coupon', status: 1 });
    await f.db.insert(storeCouponUser).values({ id: 1000, uid: 11, issueCouponId: 1000, couponTitle: 'Native three-unit coupon',
      type: 1, couponPrice: '3.00', useMinPrice: '0.00', status: 0,
      startTime: new Date((now - 3600) * 1000), endTime: new Date((now + 3600) * 1000) });
    const before = await state();
    expect(await quoteFirstOrderDiscountFromDb(f.container, 11, 1999)).toMatchObject({ eligible: true, couponExclusive: true, firstOrderPrice: '0.00' });
    expect(await quote(1000)).toMatchObject({ firstOrderPriceCents: 0, couponPriceCents: 0, promotionSavingsCents: 0, payCents: 1999 });
    expect(await state()).toEqual(before);
    await setSql('first_order_status', '0');
    const withoutFirstOrder = await state();
    expect(await quote(1000)).toMatchObject({ firstOrderPriceCents: 0, couponPriceCents: 300, promotionSavingsCents: 199, payCents: 1500 });
    expect(await state()).toEqual(withoutFirstOrder);
  });

  it('preserves an eligible free item as a zero-money read without consuming first-order status', async () => {
    await f.db.update(storeProduct).set({ price: '0.00' }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ price: '0.00' }).where(eq(storeProductAttrValue.id, 1));
    const before = await state();
    expect(await new StoreCartService(f.container).quoteFirstOrder(11, [1])).toMatchObject({ eligible: true, couponExclusive: true, firstOrderPrice: '0.00' });
    expect(await quote()).toMatchObject({ rawTotalCents: 0, firstOrderPriceCents: 0, payCents: 0 });
    expect(await state()).toEqual(before);
  });
});
