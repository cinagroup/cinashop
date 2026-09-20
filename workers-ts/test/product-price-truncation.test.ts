import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { StoreProductService } from '../src/services/product/StoreProductService';
import { StoreCartService } from '../src/services/order/StoreCartService';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { centsToDecimal, decimalToCents } from '../src/services/order/OrderBrokerageService';
import { systemUserLevel, storeProduct, storeProductAttrValue, storeProductRelation,
  storeProductEnsure, userRelation, user, storeCart, storeOrderCartInfo,
  storeOrderStatus, printDocument } from '../src/models/schema';
import bcmathCases from './fixtures/member-price-bcmath.json';

// Actual service/DAO and confirm/create controllers on an owned real-PG fixture.
// Identity, KV receipts and sequence allocation are explicit local substitutes;
// this does not claim production auth, paid-provider or browser acceptance.
describe('PHP-truncated level price from catalogue through persisted order', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([systemUserLevel, storeProductRelation,
      storeProductEnsure, userRelation, storeOrderCartInfo, storeOrderStatus, printDocument]);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.setConfig({ member_func_status: '1', member_card_status: '1', svip_price_status: '1' });
    await f.db.insert(systemUserLevel).values({ id: 1, name: 'Precision fixture', isShow: 1, discount: '88.00' });
    await f.db.update(user).set({ level: 1, levelStatus: 1, isEverLevel: 1 }).where(eq(user.uid, 11));
    f.app.post('/api/order/create/:key', orderCreate);
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'precision-fixture', get: () => ({
      fetch: async () => new Response('precision_fixture_order'),
    }) } });
  }, 30_000);
  afterEach(async () => { await f?.close(); }, 30_000);
  const request = async (path: string, body: object) => {
    const response = await f.app.request(path, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-fixture-user': '11',
    }, body: JSON.stringify(body) }, f.env);
    return response.json() as Promise<{ status: number; msg: string;
      data: { orderKey: string; quoteToken: string; priceGroup: { pay_price: string } } }>;
  };

  // Two-decimal base prices and nonzero payable quotes, including decimal
  // percentages and a winner that changes when the display rounding is fixed.
  // Zero discount and the PHP one-cent payment floor are separate policy gates.
  it.each([0, 1, 2, 8, 9, 10].map(index => bcmathCases[index]))
    ('persists the same amount for $price / $discount / SVIP $vipPrice', async row => {
      await f.db.update(systemUserLevel).set({ discount: row.discount });
      await f.db.update(storeProduct).set({ price: row.price, isVip: row.isVip,
        vipPrice: row.vipPrice, freight: 1, tempId: 0 });
      await f.db.update(storeProductAttrValue).set({ price: row.price, vipPrice: row.vipPrice });
      const products = new StoreProductService(f.container, f.env);
      const detail = await products.getProductDetail(70, 11);
      const catalogue = await products.getGoodsList({}, 11);
      const recommendations = await products.getRecommendProducts(11);
      const carts = await f.db.select().from(storeCart);
      const legacyCart = await new StoreCartService(f.container, f.env).projectLegacyV2Rows(11, carts);
      const input = { cartIds: [1], addressId: 11, type: 0 };
      const confirmation = await request('/api/order/confirm', input);
      expect(confirmation.status, confirmation.msg).toBe(200);
      const total = centsToDecimal(decimalToCents(row.payPrice) * 2);
      expect(confirmation.data.priceGroup.pay_price).toBe(total);
      expect(legacyCart).toMatchObject([{ truePrice: Number(row.payPrice), price_type: row.priceType }]);
      // Soft assertions let the red run still exercise and verify real checkout.
      expect.soft(detail).toMatchObject({ vipPrice: row.selectedPrice,
        level_price: row.levelPrice, price_type: row.priceType });
      expect.soft(catalogue.list).toMatchObject([{ vip_price: row.selectedPrice, price_type: row.priceType }]);
      expect.soft(recommendations).toMatchObject([{ vip_price: row.selectedPrice, price_type: row.priceType }]);
      const created = await request(`/api/order/create/${confirmation.data.orderKey}`, {
        ...input, quoteToken: confirmation.data.quoteToken,
      });
      expect(created.status, created.msg).toBe(200);
      const state = await f.snapshot();
      expect(state.orders).toMatchObject([{ paid: 0, payPrice: total, totalNum: 2 }]);
      expect(state.products).toMatchObject([{ price: row.price, stock: 6 }]);
      expect(state.skus).toMatchObject([{ price: row.price, vipPrice: row.vipPrice, stock: 6 }]);
      expect(state.users).toMatchObject([{ level: 1, isEverLevel: 1 }]);
    });
});
