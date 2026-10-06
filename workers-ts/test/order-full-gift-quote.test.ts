import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { AdminFullGiftService } from '../src/services/admin/AdminFullGiftService';
import { quoteOrderPromotionGifts } from '../src/services/activity/OrderPromotionGiftService';
import { readOrderPromotionGiftIntent } from '../src/services/activity/OrderPromotionGiftSnapshot';
import { verifyUnpaidCancellationLines } from '../src/services/order/UnpaidOrderCancellationEvidence';
import { StoreCartService } from '../src/services/order/StoreCartService';
import { storeCouponIssue, storeProduct, storeProductAttrValue, userLabel,
  storeProductCategory, systemLog, storePromotionsAuxiliary } from '../src/models/schema';

const shanghai = (hours: number) => {
  const date = new Date(Date.now() + (hours + 8) * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
};
const payload = () => ({ name: '满送真实报价', section_time: [shanghai(-1), shanghai(24)],
  promotions_cate: 2, threshold_type: 1, promotions: [{ threshold: 10, give_integral: 3,
    give_coupon_id: [{ give_coupon_id: 41, give_coupon_num: 10 }],
    give_product_id: [{ give_product_id: 71, unique: 'gift1111', give_product_num: 10 }] }],
  is_label: 1, label_id: [31], product_partake_type: 2,
  product_id: [{ product_id: 70, unique: ['qared001'] }], brand_id: [], store_label_id: [],
  status: 1, sort: 0, request_id: crypto.randomUUID() });

describe('full-gift quote uses checkout-priced, coupon-adjusted purchased lines', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let rootId: number;
  const input = (gross: number, coupon: number, quantity = 2) => ({ uid: 11, shippingType: 1,
    lines: [{ key: 1, productId: 70, skuUnique: 'qared001', quantity,
      postPromotionGrossCents: gross, couponDiscountCents: coupon }] });
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([storeCouponIssue, userLabel, storeProductCategory, systemLog]);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.db.update(storeProduct).set({ deliveryType: '1', freight: 1 });
    await f.db.insert(storeProduct).values({ id: 71, storeName: '订单实物赠品', image: '/gift.png',
      stock: 20, isShow: 1, isVerify: 1, deliveryType: '1' });
    await f.db.insert(storeProductAttrValue).values({ id: 71, productId: 71,
      type: 0, unique: 'gift1111', suk: '礼盒', stock: 20 });
    await f.db.insert(userLabel).values({ id: 31, name: '满送用户', type: 0, relationId: 0 });
    await f.db.insert(storeCouponIssue).values({ id: 41, couponTitle: '满送券', type: 1,
      couponPrice: '2.00', useMinPrice: '5.00', receiveType: 3, status: 1,
      remainCount: 20, totalCount: 20, day: 7 });
    rootId = (await new AdminFullGiftService(f.container).mutate('create', 0, payload(), { id: 9 })).id;
  });
  afterEach(async () => f?.close());

  it('loops points and the physical gift, grants the coupon issue once, and freezes IDs', async () => {
    const quote = await quoteOrderPromotionGifts(f.container, input(2500, 200));
    expect(quote.totalGiftQuantity).toBe(2);
    expect(quote.totalIntegral).toBe(6);
    expect(quote.couponIssueIds).toEqual([41]);
    expect(quote.intent?.promotions).toMatchObject([{ id: rootId, repetitions: 2,
      give_integral: 6, coupons: [{ issue_id: 41 }],
      products: [{ product_id: 71, sku_id: 71, quantity: 2, cart_id: expect.stringMatching(/^\d+$/) }] }]);
    expect(readOrderPromotionGiftIntent(JSON.stringify(quote.intent))).toEqual(quote.intent);
    const paddedPurchasedSku = await quoteOrderPromotionGifts(f.container, {
      ...input(2500, 200), lines: [{ ...input(2500, 200).lines[0], skuUnique: 'qared001   ' }],
    });
    expect(paddedPurchasedSku.totalGiftQuantity).toBe(2);
    const [pool] = await f.db.select().from(storePromotionsAuxiliary)
      .where(eq(storePromotionsAuxiliary.productId, 71));
    expect(pool.surplusNum).toBe(10); // A quote does not reserve inventory.
  });

  it('uses post-coupon money for the threshold, but not a coupon per loop', async () => {
    expect((await quoteOrderPromotionGifts(f.container, input(2000, 1100))).intent).toBeNull();
    const once = await quoteOrderPromotionGifts(f.container, input(2000, 1000));
    expect(once.intent?.promotions[0]).toMatchObject({ repetitions: 1, give_integral: 3 });
    expect(once.totalGiftQuantity).toBe(1);
    expect((await quoteOrderPromotionGifts(f.container, { ...input(2000, 0),
      firstOrderEligible: true })).intent).toBeNull();
    expect((await quoteOrderPromotionGifts(f.container, { ...input(2000, 0), uid: 0 })).intent).toBeNull();
  });

  it('ignores volatile stock in the confirmation fingerprint but rejects stale rule material', async () => {
    const before = await quoteOrderPromotionGifts(f.container, input(2000, 0));
    await f.db.update(storeProduct).set({ stock: 3 }).where(eq(storeProduct.id, 71));
    await f.db.update(storeProductAttrValue).set({ stock: 3 })
      .where(eq(storeProductAttrValue.id, 71));
    expect((await quoteOrderPromotionGifts(f.container, input(2000, 0))).materialsFingerprint)
      .toBe(before.materialsFingerprint);
    await f.db.update(storeProductAttrValue).set({ stock: 0 })
      .where(eq(storeProductAttrValue.id, 71));
    await expect(quoteOrderPromotionGifts(f.container, input(2000, 0))).rejects.toThrow(/库存/);
    await f.db.update(storeProductAttrValue).set({ stock: 3 })
      .where(eq(storeProductAttrValue.id, 71));
    await f.db.update(storePromotionsAuxiliary).set({ isAll: 0 })
      .where(eq(storePromotionsAuxiliary.productId, 71));
    const changed = await quoteOrderPromotionGifts(f.container, input(2000, 0));
    expect(changed.materialsFingerprint).not.toBe(before.materialsFingerprint);
    expect(changed.totalGiftQuantity).toBe(0);
  });

  it('keeps numeric gift cart identities out of purchased quota cancellation evidence', async () => {
    const quote = await quoteOrderPromotionGifts(f.container, input(2500, 0));
    const gift = quote.intent!.promotions[0].products[0];
    const order = { id: 51, uid: 11, type: 0, cartId: `1,${gift.cart_id}`, totalNum: 4,
      refundStatus: 0, refundType: 0, useIntegral: '0.00',
      promotionsGive: JSON.stringify(quote.intent) };
    const source = { oid: 51, uid: 11, oldCartId: '', refundNum: 0, splitStatus: 0,
      isWriteoff: 0 };
    const purchased = { ...source, id: 1, cartId: '1', productId: 70, skuUnique: 'qared001',
      cartNum: 2, splitSurplusNum: 2, surplusNum: 2, isGift: 0,
      cartInfo: JSON.stringify({ financial_version: 'checkout-line-finance-v1',
        id: '1', cart_num: 2, product: { id: 70 }, sku: { id: 1, unique: 'qared001' },
        use_integral: '0' }) };
    const presented = { ...source, id: 2, cartId: gift.cart_id, productId: 71,
      skuUnique: 'gift1111', cartNum: 2, splitSurplusNum: 2, surplusNum: 2, isGift: 1,
      cartInfo: JSON.stringify({ financial_version: 'checkout-line-finance-v1',
        id: gift.cart_id, cart_num: 2, product: { id: 71 },
        sku: { id: 71, unique: 'gift1111' }, use_integral: '0', sum_true_price: '0.00',
        gain_integral: '0', ...Object.fromEntries(['sum_price', 'vip_truePrice',
          'member_postage_price', 'member_coupon_price', 'raw_postage_price',
          'postage_price', 'coupon_price', 'integral_price', 'first_order_price',
          'promotions_true_price', 'one_brokerage', 'two_brokerage',
          'division_staff_brokerage', 'division_agent_brokerage', 'division_brokerage']
          .map(field => [field, '0.00'])),
        promotion_gift: { version: 'order-promotion-gifts-v1', root_id: rootId,
          tier_id: quote.intent!.promotions[0].tier_id, aux_id: gift.aux_id } }) };
    expect(verifyUnpaidCancellationLines(order, [purchased, presented])).toMatchObject({
      products: [{ productId: 70, quantity: 2 }], cartIds: [1] });
    expect(() => verifyUnpaidCancellationLines(order,
      [purchased, { ...presented, isGift: 0 }])).toThrow();
    expect(() => verifyUnpaidCancellationLines(order,
      [purchased, { ...presented, cartNum: 1, splitSurplusNum: 1, surplusNum: 1 }])).toThrow();
  });

  it('projects a provisional gift benefit on the ordinary cart without claiming resources', async () => {
    const [cart] = await new StoreCartService(f.container, f.env).list(11,
      { mode: 'buy', ids: [1] }) as Array<Record<string, unknown>>;
    expect(cart.giftPromotion).toMatchObject([{ id: rootId, repetitions: 2,
      giveIntegral: 6, giveCoupon: [{ id: 41 }],
      giveCartInfo: [{ productId: 71, quantity: 2 }] }]);
    expect((await f.db.select().from(storePromotionsAuxiliary)
      .where(eq(storePromotionsAuxiliary.productId, 71)))[0].surplusNum).toBe(10);
  });
});
