import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { StoreProductService } from '../src/services/product/StoreProductService';
import { StoreCartService } from '../src/services/order/StoreCartService';
import { storeProduct, storeProductAttr, storeProductAttrValue, storeProductRelation,
  storeProductEnsure, userRelation, systemUserLevel, user, storeCart } from '../src/models/schema';

describe('selected SKU membership unit price uses checkout eligibility', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([storeProductAttr, storeProductRelation,
      storeProductEnsure, userRelation, systemUserLevel]);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.setConfig({ member_func_status: '1', member_card_status: '1', svip_price_status: '1' });
    await f.db.insert(systemUserLevel).values({ id: 1, name: '银卡', discount: '88.50', isShow: 1 });
    await f.db.update(user).set({ level: 1, levelStatus: 1, isEverLevel: 0, isMoneyLevel: 0 }).where(eq(user.uid, 11));
    await f.db.update(storeProduct).set({ price: '100.00', vipPrice: '1.00', specType: 1, isVip: 1, freight: 1, tempId: 0 });
    await f.db.update(storeProductAttrValue).set({ price: '19.99', vipPrice: '10.00' });
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 70, unique: 'qablue01', suk: '蓝色,小号', price: '29.99', vipPrice: '28.00', stock: 2 });
  }, 30_000);
  afterEach(async () => { await f?.close(); }, 30_000);
  async function projections(uid = 11) {
    const service = new StoreProductService(f.container, f.env);
    const detail = await service.getProductDetail(70, uid);
    const legacy = await service.getLegacyProductAttr(70, uid, false);
    return [detail.attr_value as Array<Record<string, unknown>>, Object.values(legacy.productValue)];
  }
  async function prices(expected: string[], types: string[], uid = 11) {
    for (const rows of await projections(uid)) {
      expect(rows.map(row => row.member_price)).toEqual(expected);
      expect(rows.map(row => row.price_type)).toEqual(types);
      expect(rows.map(row => row.level_name)).toEqual(types.map(type => type === 'level' ? '银卡' : ''));
      expect(rows.map(row => row.price)).toEqual(['19.99', '29.99']);
    }
  }
  it('uses per-SKU level prices, not product summary or advertised SVIP for an unpaid user', async () => {
    await prices(['17.59', '26.39'], ['level', 'level']);
    for (const rows of await projections()) expect(rows.map(row => row.vip_price)).toEqual(['10.00', '28.00']);
  });
  it('selects different winning price types for the two SKUs of a paid user', async () => {
    await f.db.update(user).set({ isEverLevel: 1 });
    await prices(['10.00', '26.39'], ['member', 'level']);
  });
  it('does not grant expired paid benefits', async () => {
    await f.db.update(user).set({ isMoneyLevel: 1, overdueTime: Math.floor(Date.now() / 1000) - 1 });
    await prices(['17.59', '26.39'], ['level', 'level']);
  });
  it('grants a current timed paid membership without requiring a lifetime flag', async () => {
    await f.db.update(user).set({ isMoneyLevel: 1, overdueTime: Math.floor(Date.now() / 1000) + 3600 });
    await prices(['10.00', '26.39'], ['member', 'level']);
  });
  it('product-level paid pricing opt-out leaves the ordinary level discount intact', async () => {
    await f.db.update(user).set({ isEverLevel: 1 });
    await f.db.update(storeProduct).set({ isVip: 0 });
    await prices(['17.59', '26.39'], ['level', 'level']);
  });
  it('does not apply the ordinary-SKU membership quote to activity SKU rows', async () => {
    await f.db.insert(storeProductAttrValue).values({ id: 3, productId: 70, unique: 'qaact001', suk: '活动规格', type: 1, price: '8.00', vipPrice: '1.00', stock: 2 });
    const detail = await new StoreProductService(f.container, f.env).getProductDetail(70, 11, 1);
    const rows = detail.attr_value as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ price: '8.00', unique: 'qaact001' });
    expect(rows[0]).not.toHaveProperty('member_price');
  });
  it('retains the checkout one-cent floor and no-discount classification for a one-cent SKU', async () => {
    await f.db.update(storeProductAttrValue).set({ price: '0.01', vipPrice: '0.00' });
    for (const rows of await projections()) {
      expect(rows.map(row => [row.price, row.member_price, row.price_type])).toEqual([
        ['0.01', '0.01', ''], ['0.01', '0.01', ''],
      ]);
    }
  });
  it('keeps paid eligibility independent when the level feature is off', async () => {
    await f.setConfig({ member_func_status: '0' });
    await f.db.update(user).set({ isEverLevel: 1 });
    await prices(['10.00', '28.00'], ['member', 'member']);
  });
  it('disabled or hidden levels do not price an unpaid user', async () => {
    await f.db.update(user).set({ levelStatus: 0 });
    await prices(['19.99', '29.99'], ['', '']);
    await f.db.update(user).set({ levelStatus: 1 });
    await f.db.update(systemUserLevel).set({ isShow: 0 });
    await prices(['19.99', '29.99'], ['', '']);
  });
  it('never grants anonymous visitors the advertised paid-member price', async () => {
    await prices(['19.99', '29.99'], ['', ''], 0);
  });
  it('disabled paid pricing preserves the valid level price', async () => {
    await f.db.update(user).set({ isEverLevel: 1 });
    await f.setConfig({ svip_price_status: '0' });
    await prices(['17.59', '26.39'], ['level', 'level']);
  });
  it('zero or higher paid prices never become a free or more expensive offer', async () => {
    await f.db.update(user).set({ isEverLevel: 1 });
    await f.db.update(storeProductAttrValue).set({ vipPrice: '0.00' }).where(eq(storeProductAttrValue.id, 1));
    await f.db.update(storeProductAttrValue).set({ vipPrice: '99.00' }).where(eq(storeProductAttrValue.id, 2));
    await prices(['17.59', '26.39'], ['level', 'level']);
  });
  it.each([false, true])('matches actual cart and confirmation unit price for both SKUs (paid=%s)', async (paid) => {
    if (paid) await f.db.update(user).set({ isEverLevel: 1 });
    const [rows] = await projections();
    for (const row of rows) {
      await f.db.update(storeCart).set({ productAttrUnique: String(row.unique), cartNum: 1 }).where(eq(storeCart.id, 1));
      const carts = await f.db.select().from(storeCart);
      const legacy = await new StoreCartService(f.container, f.env).projectLegacyV2Rows(11, carts);
      const response = await f.app.request('/api/order/confirm', { method: 'POST', headers: {
        'content-type': 'application/json', 'x-fixture-user': '11',
      }, body: JSON.stringify({ cartIds: [1], addressId: 11, type: 0 }) }, f.env);
      const result = await response.json() as { status: number; data: { priceGroup: { pay_price: string } } };
      expect(result.status).toBe(200);
      expect.soft(row.member_price).toBe(result.data.priceGroup.pay_price);
      expect.soft(row.member_price).toBe(Number(legacy[0].truePrice).toFixed(2));
    }
  });
});
