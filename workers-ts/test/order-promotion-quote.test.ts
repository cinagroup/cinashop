import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createContainerFromDb, type Container } from '../src/lib/di';
import {
  storeOrder, storeOrderCartInfo, storeProduct, storeProductAttrValue,
  storeProductRelation, storePromotions, storePromotionsAuxiliary,
} from '../src/models/schema';
import {
  discountUnitPriceCents, quoteOrderPromotions,
  type OrderPromotionQuoteInput,
} from '../src/services/activity/OrderPromotionQuoteService';
import { financePostgres } from './helpers/financePostgres';

const now = 1_800_000_000;
const line = (overrides: Partial<OrderPromotionQuoteInput['lines'][number]> = {}) => ({
  key: 'cart-1', productId: 1, skuUnique: 'sku1', quantity: 1,
  rawUnitPriceCents: 1999, memberUnitPriceCents: 1900, ...overrides,
});
const input = (overrides: Partial<OrderPromotionQuoteInput> = {}): OrderPromotionQuoteInput => ({
  uid: 7, now, lines: [line()], ...overrides,
});

describe('authoritative order promotion quote', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let container: Container;
  beforeAll(async () => {
    fixture = await financePostgres([
      storeProduct, storeProductAttrValue, storeProductRelation,
      storePromotions, storePromotionsAuxiliary, storeOrder, storeOrderCartInfo,
    ]);
    container = createContainerFromDb(fixture.db);
  }, 30_000);
  afterAll(async () => fixture?.close());
  beforeEach(async () => {
    await fixture.reset();
    await fixture.db.insert(storeProduct).values([
      { id: 1, pid: 0, storeName: '花束', isShow: 1, isDel: 0, isVerify: 1 },
      { id: 2, pid: 0, storeName: '花瓶', isShow: 1, isDel: 0, isVerify: 1 },
      { id: 3, pid: 1, storeName: '供应商花束', isShow: 1, isDel: 0, isVerify: 1 },
    ]);
    await fixture.db.insert(storeProductAttrValue).values([
      { productId: 1, unique: 'sku1', type: 0, price: '19.99' },
      { productId: 1, unique: 'sku2', type: 0, price: '19.99' },
      { productId: 2, unique: 'sku3', type: 0, price: '10.00' },
      { productId: 3, unique: 'sku4', type: 0, price: '19.99' },
    ]);
    await fixture.db.insert(storeProductRelation).values([
      { productId: 1, type: 2, relationId: 11 },
      { productId: 1, type: 3, relationId: 21 },
    ]);
  });
  const promotion = async (overrides: Partial<typeof storePromotions.$inferInsert> = {}) => {
    const [row] = await fixture.db.insert(storePromotions).values({
      pid: 0, type: 1, storeId: 0, promotionsType: 1, name: '限时九折',
      discount: '90.00', productPartakeType: 1, startTime: now - 10,
      stopTime: now + 10, status: 1, isDel: 0, updateTime: now,
      ...overrides,
    }).returning();
    return row;
  };

  it('floors each unit saving before subtracting, chooses below-member pricing, and preserves first-order exclusion', async () => {
    expect(discountUnitPriceCents(1999, 90)).toBe(1800);
    expect(discountUnitPriceCents(1, 99)).toBe(1);
    await promotion({ overlay: '5', labelId: '31,32' });
    const quote = await quoteOrderPromotions(container, input());
    expect(quote.lines[0]).toMatchObject({ totalPriceCents: 1800, promotionSavingsCents: 199,
      membershipSavingsCents: 0, discountQuantity: 1, couponEligibleGrossCents: 1800,
      priceType: 'promotions', promotionAllocations: [{ savingsCents: 199, labelIds: [31, 32] }] });
    expect(quote.materialsFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const first = await quoteOrderPromotions(container, input({ firstOrderEligible: true }));
    expect(first.lines[0]).toMatchObject({ totalPriceCents: 1900, promotionIds: [],
      couponEligibleGrossCents: 1900, priceType: '' });
    expect(first.materialsFingerprint).not.toBe(quote.materialsFingerprint);
  });

  it('keeps stock and sales outside the price fingerprint, while binding eligibility, scope, price and used quota', async () => {
    const root = await promotion({ productPartakeType: 4, isLimit: 1, limitNum: 3 });
    await fixture.db.insert(storePromotionsAuxiliary).values({ promotionsId: root.id, type: 1,
      productPartakeType: 4, brandId: 11 });
    const original = await quoteOrderPromotions(container, input());
    await fixture.db.update(storeProduct).set({ stock: 200, sales: 91, ficti: 400 })
      .where(eq(storeProduct.id, 1));
    await fixture.db.update(storeProductAttrValue).set({ stock: 200, sales: 91 })
      .where(eq(storeProductAttrValue.productId, 1));
    expect((await quoteOrderPromotions(container, input())).materialsFingerprint)
      .toBe(original.materialsFingerprint);

    await fixture.db.update(storePromotions).set({ status: 0 }).where(eq(storePromotions.id, root.id));
    expect((await quoteOrderPromotions(container, input())).materialsFingerprint)
      .not.toBe(original.materialsFingerprint);
    await fixture.db.update(storePromotions).set({ status: 1 }).where(eq(storePromotions.id, root.id));
    await fixture.db.update(storeProduct).set({ isVerify: 0 }).where(eq(storeProduct.id, 1));
    expect((await quoteOrderPromotions(container, input())).materialsFingerprint)
      .not.toBe(original.materialsFingerprint);
    await fixture.db.update(storeProduct).set({ isVerify: 1 }).where(eq(storeProduct.id, 1));

    await fixture.db.delete(storeProductRelation).where(and(
      eq(storeProductRelation.productId, 1), eq(storeProductRelation.type, 2)));
    expect((await quoteOrderPromotions(container, input())).materialsFingerprint)
      .not.toBe(original.materialsFingerprint);
    await fixture.db.insert(storeProductRelation).values({ productId: 1, type: 2, relationId: 11 });

    const [order] = await fixture.db.insert(storeOrder).values({ uid: 7, paid: 1,
      orderId: 'fingerprint-history' }).returning();
    await fixture.db.insert(storeOrderCartInfo).values({ uid: 7, oid: order.id,
      productId: 1, skuUnique: 'sku1', promotionsId: String(root.id), cartNum: 1,
      cartInfo: JSON.stringify({ promotion_discount_quantity: 1 }) });
    expect((await quoteOrderPromotions(container, input())).materialsFingerprint)
      .not.toBe(original.materialsFingerprint);

    await fixture.db.update(storeProductAttrValue).set({ price: '20.00' }).where(and(
      eq(storeProductAttrValue.productId, 1), eq(storeProductAttrValue.unique, 'sku1')));
    await expect(quoteOrderPromotions(container, input())).rejects.toThrow('商品规格或价格已变化');
    expect((await quoteOrderPromotions(container, input({ lines: [line({ rawUnitPriceCents: 2000 })] })))
      .materialsFingerprint).not.toBe(original.materialsFingerprint);
  });

  it('ignores unrelated activity material but invalidates when a newer rule starts matching this SKU', async () => {
    await promotion({ id: 20, updateTime: now, productPartakeType: 4 });
    await fixture.db.insert(storePromotionsAuxiliary).values({ promotionsId: 20, type: 1,
      productPartakeType: 4, brandId: 11 });
    const original = await quoteOrderPromotions(container, input());
    await promotion({ id: 21, updateTime: now + 1, productPartakeType: 2, discount: '50.00' });
    const [unrelated] = await fixture.db.insert(storePromotionsAuxiliary).values({ promotionsId: 21, type: 1,
      productPartakeType: 2, productId: 2, isAll: 1 }).returning();
    expect((await quoteOrderPromotions(container, input())).materialsFingerprint)
      .toBe(original.materialsFingerprint);
    await fixture.db.update(storePromotionsAuxiliary).set({ productId: 1 })
      .where(eq(storePromotionsAuxiliary.id, unrelated.id));
    const matching = await quoteOrderPromotions(container, input());
    expect(matching.lines[0].promotionIds).toEqual([21]);
    expect(matching.materialsFingerprint).not.toBe(original.materialsFingerprint);
  });

  it('uses inclusive boundaries, newest same-type rule and independent scope matches', async () => {
    await promotion({ id: 10, updateTime: now - 1, discount: '50.00', stopTime: now - 1 });
    await promotion({ id: 11, updateTime: now, discount: '90.00', startTime: now, stopTime: now,
      productPartakeType: 2 });
    await fixture.db.insert(storePromotionsAuxiliary).values({ promotionsId: 11, type: 1,
      productPartakeType: 2, productId: 1, isAll: 0, unique: 'sku1' });
    expect((await quoteOrderPromotions(container, input())).lines[0].promotionIds).toEqual([11]);
    expect((await quoteOrderPromotions(container, input({ lines: [line({ skuUnique: 'sku2' })] })))
      .lines[0].promotionIds).toEqual([]);
    await promotion({ id: 12, updateTime: now + 1, discount: '80.00', productPartakeType: 4 });
    await fixture.db.insert(storePromotionsAuxiliary).values({ promotionsId: 12, type: 1,
      productPartakeType: 4, brandId: 11 });
    expect((await quoteOrderPromotions(container, input())).lines[0].promotionIds).toEqual([12]);
    expect((await quoteOrderPromotions(container, input({ lines: [line({ key: 'child', productId: 3,
      skuUnique: 'sku4' })] }))).lines[0].promotionIds).toEqual([12]);
  });

  it('honors product-label and controlled SKU exclusion without crossing product/SKU identities', async () => {
    const root = await promotion({ productPartakeType: 5 });
    await fixture.db.insert(storePromotionsAuxiliary).values({ promotionsId: root.id, type: 1,
      productPartakeType: 5, storeLabelId: 21 });
    expect((await quoteOrderPromotions(container, input())).lines[0].promotionIds).toEqual([root.id]);
    expect((await quoteOrderPromotions(container, input({ lines: [line({ productId: 2, skuUnique: 'sku3',
      rawUnitPriceCents: 1000, memberUnitPriceCents: 1000 })] }))).lines[0].promotionIds).toEqual([]);
    const exclude = await promotion({ updateTime: now + 1, productPartakeType: 3 });
    await fixture.db.insert(storePromotionsAuxiliary).values({ promotionsId: exclude.id, type: 1,
      productPartakeType: 3, productId: 1, isAll: 0, unique: 'sku1' });
    expect((await quoteOrderPromotions(container, input())).lines[0].promotionIds).toEqual([root.id]);
    expect((await quoteOrderPromotions(container, input({ lines: [line({ skuUnique: 'sku2' })] })))
      .lines[0].promotionIds).toEqual([exclude.id]);
    await expect(quoteOrderPromotions(container, input({ lines: [line({ skuUnique: 'sku3' })] })))
      .rejects.toThrow('商品规格或价格已变化');
  });

  it('counts historical discounted pieces, excludes unpaid cancellation but keeps paid refunds, and quotes partial caps', async () => {
    const root = await promotion({ isLimit: 1, limitNum: 3 });
    const [order] = await fixture.db.insert(storeOrder).values({ uid: 7, paid: 1,
      refundStatus: 2, refundType: 6, orderId: 'paid-refunded' }).returning();
    await fixture.db.insert(storeOrderCartInfo).values({ uid: 7, oid: order.id,
      productId: 1, skuUnique: 'sku1', promotionsId: String(root.id), cartNum: 2,
      cartInfo: JSON.stringify({ promotion_discount_quantity: 1 }) });
    const [cancelled] = await fixture.db.insert(storeOrder).values({ uid: 7, paid: 0,
      status: -2, isDel: 1, orderId: 'unpaid-cancelled' }).returning();
    await fixture.db.insert(storeOrderCartInfo).values({ uid: 7, oid: cancelled.id,
      productId: 1, skuUnique: 'sku1', promotionsId: String(root.id), cartNum: 2 });
    const quote = await quoteOrderPromotions(container, input({ lines: [line({ quantity: 3 })] }));
    expect(quote.lines[0]).toMatchObject({ discountQuantity: 2, totalPriceCents: 5500,
      promotionSavingsCents: 398, membershipSavingsCents: 99,
      couponEligibleGrossCents: 1900, unitPriceCents: null });
    expect(quote.lines[0].segments.map((segment) => segment.quantity)).toEqual([2, 1]);
    expect((await quoteOrderPromotions(container, input({ uid: 0 }))).lines[0].promotionIds).toEqual([]);
    const [splitRoot] = await fixture.db.insert(storeOrder).values({ uid: 7, paid: 1,
      pid: -1, orderId: 'paid-split-root' }).returning();
    await fixture.db.insert(storeOrderCartInfo).values({ uid: 7, oid: splitRoot.id,
      productId: 1, skuUnique: 'sku1', promotionsId: String(root.id), cartNum: 1,
      cartInfo: JSON.stringify({ promotion_discount_quantity: 1 }) });
    const [splitChild] = await fixture.db.insert(storeOrder).values({ uid: 7, paid: 1,
      pid: splitRoot.id, orderId: 'paid-split-child' }).returning();
    await fixture.db.insert(storeOrderCartInfo).values({ uid: 7, oid: splitChild.id,
      productId: 1, skuUnique: 'sku1', promotionsId: String(root.id), cartNum: 1,
      cartInfo: JSON.stringify({ promotion_discount_quantity: 1 }) });
    expect((await quoteOrderPromotions(container, input({ lines: [line({ quantity: 3 })] })))
      .lines[0]).toMatchObject({ discountQuantity: 1, totalPriceCents: 5600 });
  });

  it('counts a paid store-derived type-1 promotion against the parent product cap across SKUs', async () => {
    const root = await promotion({ isLimit: 1, limitNum: 2 });
    const [derived, otherType] = await fixture.db.insert(storePromotions).values([
      { pid: root.id, type: 1, storeId: 9, promotionsType: 1, name: '门店派生限时折扣',
        discount: '90.00', isDel: 0 },
      { pid: root.id, type: 1, storeId: 0, promotionsType: 3, name: '异类型子促销',
        discount: '1.00', isDel: 0 },
    ]).returning();
    const [paid] = await fixture.db.insert(storeOrder).values({ uid: 7, paid: 1,
      orderId: 'paid-derived-type-1' }).returning();
    await fixture.db.insert(storeOrderCartInfo).values({ uid: 7, oid: paid.id,
      productId: 1, skuUnique: 'sku2', promotionsId: String(derived.id), cartNum: 1,
      cartInfo: JSON.stringify({ promotion_discount_quantity: 1 }) });
    const [wrongTypePaid] = await fixture.db.insert(storeOrder).values({ uid: 7, paid: 1,
      orderId: 'paid-wrong-child-type' }).returning();
    await fixture.db.insert(storeOrderCartInfo).values({ uid: 7, oid: wrongTypePaid.id,
      productId: 1, skuUnique: 'sku2', promotionsId: String(otherType.id), cartNum: 1,
      cartInfo: JSON.stringify({ promotion_discount_quantity: 1 }) });

    const quote = await quoteOrderPromotions(container, input({ lines: [line({ quantity: 2 })] }));
    expect(quote.lines[0]).toMatchObject({ discountQuantity: 1, totalPriceCents: 3700,
      promotionSavingsCents: 199, membershipSavingsCents: 99 });
    await fixture.db.update(storePromotions).set({ isDel: 1 })
      .where(eq(storePromotions.id, derived.id));
    expect((await quoteOrderPromotions(container, input({ lines: [line({ quantity: 2 })] }))).lines[0])
      .toMatchObject({ discountQuantity: 1, totalPriceCents: 3700 });
  });

  it('applies mutual overlay type 2/3 and blocks coupon when any chosen rule lacks overlay 5', async () => {
    const limited = await promotion({ discount: '90.00', overlay: '2,3,5' });
    const count = await promotion({ promotionsType: 2, name: '两件折扣', overlay: '1,3,5',
      thresholdType: 2, threshold: '2.00', discount: '50.00' });
    const tier = await promotion({ promotionsType: 3, name: '满额减', overlay: '1,2',
      promotionsCate: 1, thresholdType: 1, threshold: '20.00', discountType: 1,
      discount: '2.00' });
    const quote = await quoteOrderPromotions(container, input({ lines: [line({ quantity: 2 })] }));
    expect(quote.lines[0].promotionIds).toEqual([limited.id, count.id, tier.id]);
    expect(quote.lines[0].totalPriceCents).toBeLessThan(3600);
    expect(quote.lines[0].couponEligibleGrossCents).toBe(0);
    expect(quote.lines[0].promotionAllocations).toHaveLength(3);
  });

  it('keeps legacy fractional type-2/3 percentages and cent-valued full-cut rules effective', async () => {
    const count = await promotion({ promotionsType: 2, name: '两件折扣',
      thresholdType: 2, threshold: '2.00', discount: '95.50' });
    const twoPieces = await quoteOrderPromotions(container, input({ lines: [line({ quantity: 2 })] }));
    // PHP bcdiv(95.50, 100, 2) becomes 0.95; one 19.00 unit saves 0.95.
    expect(twoPieces.lines[0]).toMatchObject({ promotionIds: [count.id],
      totalPriceCents: 3705, promotionSavingsCents: 95, discountQuantity: 0 });
    await fixture.db.update(storePromotions).set({ status: 0 }).where(eq(storePromotions.id, count.id));

    const tier = await promotion({ promotionsType: 3, name: '满额减一元二角五分',
      promotionsCate: 1, thresholdType: 1, threshold: '20.00',
      discountType: 1, discount: '1.25' });
    expect((await quoteOrderPromotions(container, input({ lines: [line({ quantity: 2 })] }))).lines[0])
      .toMatchObject({ promotionIds: [tier.id], totalPriceCents: 3675,
        promotionSavingsCents: 125, discountQuantity: 0 });
    await fixture.db.update(storePromotions).set({ discountType: 2, discount: '95.50' })
      .where(eq(storePromotions.id, tier.id));
    expect((await quoteOrderPromotions(container, input({ lines: [line({ quantity: 2 })] }))).lines[0])
      .toMatchObject({ promotionIds: [tier.id], totalPriceCents: 3610,
        promotionSavingsCents: 190, discountQuantity: 0 });
    await fixture.db.update(storePromotions).set({ status: 0 }).where(eq(storePromotions.id, tier.id));

    await promotion({ discount: '95.50' });
    await expect(quoteOrderPromotions(container, input()))
      .rejects.toThrow('限时折扣百分比配置无效');
  });

  it('truncates tier percentage savings on each one-cent unit, not the two-cent basket', async () => {
    await fixture.db.update(storeProductAttrValue).set({ price: '0.01' }).where(and(
      eq(storeProductAttrValue.productId, 1), eq(storeProductAttrValue.unique, 'sku1')));
    await promotion({ promotionsType: 3, name: '两件半价', promotionsCate: 1,
      thresholdType: 2, threshold: '2.00', discountType: 2, discount: '50.00' });
    const quote = await quoteOrderPromotions(container, input({ lines: [line({ quantity: 2,
      rawUnitPriceCents: 1, memberUnitPriceCents: 1 })] }));
    expect(quote.lines[0]).toMatchObject({ totalPriceCents: 2,
      promotionSavingsCents: 0, promotionIds: [], discountQuantity: 0 });
  });

  it('uses the highest reached full-cut tier and repeats amount rules by yuan or piece thresholds', async () => {
    const root = await promotion({ promotionsType: 3, name: '满减阶梯', promotionsCate: 1,
      thresholdType: 1, threshold: '20.00', discountType: 1, discount: '1.25',
      overlay: '5', labelId: '31' });
    await fixture.db.insert(storePromotions).values({ pid: root.id, type: 1, storeId: 0,
      promotionsType: 3, promotionsCate: 1, thresholdType: 1, threshold: '40.00',
      discountType: 1, discount: '4.00' });
    const two = (await quoteOrderPromotions(container, input({ lines: [line({ quantity: 2 })] }))).lines[0];
    expect(two).toMatchObject({ totalPriceCents: 3675, promotionSavingsCents: 125,
      couponEligibleGrossCents: 3675, discountQuantity: 0,
      promotionAllocations: [{ promotionId: root.id, labelIds: [31], savingsCents: 125 }] });
    const three = (await quoteOrderPromotions(container, input({ lines: [line({ quantity: 3 })] }))).lines[0];
    expect(three).toMatchObject({ totalPriceCents: 5300, promotionSavingsCents: 400 });
    const originalFingerprint = (await quoteOrderPromotions(container, input({ lines: [line({ quantity: 3 })] })))
      .materialsFingerprint;
    await fixture.db.insert(storePromotions).values([
      { pid: root.id, type: 1, storeId: 9, promotionsType: 3, promotionsCate: 1,
        thresholdType: 1, threshold: '50.00', discountType: 1, discount: '10.00' },
      { pid: root.id, type: 1, storeId: 0, promotionsType: 2, promotionsCate: 1,
        thresholdType: 1, threshold: '45.00', discountType: 1, discount: '15.00' },
    ]);
    const unpolluted = await quoteOrderPromotions(container, input({ lines: [line({ quantity: 3 })] }));
    expect(unpolluted.lines[0]).toMatchObject({ totalPriceCents: 5300, promotionSavingsCents: 400 });
    expect(unpolluted.materialsFingerprint).toBe(originalFingerprint);

    await fixture.db.update(storePromotions).set({ promotionsCate: 2 }).where(eq(storePromotions.id, root.id));
    const repeatYuan = (await quoteOrderPromotions(container, input({ lines: [line({ quantity: 3 })] }))).lines[0];
    expect(repeatYuan).toMatchObject({ totalPriceCents: 5450, promotionSavingsCents: 250 });
    await fixture.db.update(storePromotions).set({ thresholdType: 2, threshold: '2.00', discount: '0.35' })
      .where(eq(storePromotions.id, root.id));
    const repeatPieces = (await quoteOrderPromotions(container, input({ lines: [line({ quantity: 5 })] }))).lines[0];
    expect(repeatPieces).toMatchObject({ totalPriceCents: 9430, promotionSavingsCents: 70 });
  });

  it('aggregates a type-3 threshold only across participating products and allocates every saving cent', async () => {
    const root = await promotion({ promotionsType: 3, name: '跨商品满减', promotionsCate: 1,
      productPartakeType: 2, thresholdType: 1, threshold: '20.00',
      discountType: 1, discount: '1.25', overlay: '5' });
    await fixture.db.insert(storePromotionsAuxiliary).values([
      { promotionsId: root.id, type: 1, productPartakeType: 2,
        productId: 1, unique: 'sku1', isAll: 0 },
      { promotionsId: root.id, type: 1, productPartakeType: 2,
        productId: 2, unique: 'sku3', isAll: 1 },
    ]);
    const one = await quoteOrderPromotions(container, input());
    expect(one.lines[0]).toMatchObject({ totalPriceCents: 1900, promotionIds: [] });
    const quote = await quoteOrderPromotions(container, input({ lines: [line(),
      line({ key: 'vase', productId: 2, skuUnique: 'sku3', rawUnitPriceCents: 1000,
        memberUnitPriceCents: 1000 })] }));
    expect(quote).toMatchObject({ totalPriceCents: 2775, totalSavingsCents: 125,
      couponEligibleGrossCents: 2775 });
    expect(quote.lines.map((row) => row.promotionSavingsCents)).toEqual([81, 44]);
    expect(quote.lines.flatMap((row) => row.promotionAllocations.map((part) => part.savingsCents)))
      .toEqual([81, 44]);
    await fixture.db.delete(storePromotionsAuxiliary).where(and(
      eq(storePromotionsAuxiliary.promotionsId, root.id),
      eq(storePromotionsAuxiliary.productId, 2)));
    const outsideScope = await quoteOrderPromotions(container, input({ lines: [line(),
      line({ key: 'vase', productId: 2, skuUnique: 'sku3', rawUnitPriceCents: 1000,
        memberUnitPriceCents: 1000 })] }));
    expect(outsideScope).toMatchObject({ totalPriceCents: 2900, totalSavingsCents: 0 });
    expect(outsideScope.materialsFingerprint).not.toBe(quote.materialsFingerprint);
  });

  it('fails when promotion tables or SKU material cannot be read instead of silently returning member price', async () => {
    await promotion();
    await fixture.exec('DROP TABLE store_promotions_auxiliary');
    await expect(quoteOrderPromotions(container, input())).rejects.toThrow();
  });
});
