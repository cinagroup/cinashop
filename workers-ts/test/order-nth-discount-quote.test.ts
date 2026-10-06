import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createContainerFromDb, type Container } from '../src/lib/di';
import { storeOrder, storeOrderCartInfo, storeProduct, storeProductAttrValue,
  storeProductRelation, storePromotions, storePromotionsAuxiliary } from '../src/models/schema';
import { quoteOrderPromotions } from '../src/services/activity/OrderPromotionQuoteService';
import { financePostgres } from './helpers/financePostgres';

const now = 1_800_000_000;
const roses = (quantity = 1) => ({ key: 'roses', productId: 1, skuUnique: 'rose0001',
  quantity, rawUnitPriceCents: 1999, memberUnitPriceCents: 1900 });
const vase = (quantity = 1) => ({ key: 'vase', productId: 2, skuUnique: 'vase0001',
  quantity, rawUnitPriceCents: 1000, memberUnitPriceCents: 1000 });

describe('nth-piece promotion quote semantics', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let container: Container;
  beforeAll(async () => {
    fixture = await financePostgres([storeProduct, storeProductAttrValue, storeProductRelation,
      storePromotions, storePromotionsAuxiliary, storeOrder, storeOrderCartInfo]);
    container = createContainerFromDb(fixture.db);
  }, 30_000);
  afterAll(async () => fixture?.close());
  beforeEach(async () => {
    await fixture.reset();
    await fixture.db.insert(storeProduct).values([
      { id: 1, pid: 0, storeName: '玫瑰', isShow: 1, isDel: 0, isVerify: 1 },
      { id: 2, pid: 0, storeName: '花瓶', isShow: 1, isDel: 0, isVerify: 1 },
    ]);
    await fixture.db.insert(storeProductAttrValue).values([
      { productId: 1, unique: 'rose0001', type: 0, price: '19.99' },
      { productId: 2, unique: 'vase0001', type: 0, price: '10.00' },
    ]);
  });
  const create = async (overrides: Partial<typeof storePromotions.$inferInsert> = {}) => {
    const [row] = await fixture.db.insert(storePromotions).values({ pid: 0, type: 1, storeId: 0,
      promotionsType: 2, promotionsCate: 1, thresholdType: 2, threshold: '2.00',
      discountType: 2, nPieceNDiscount: 3, discount: '50.00',
      name: '第2件半价', productPartakeType: 1, startTime: now - 10,
      stopTime: now + 10, status: 1, isDel: 0, updateTime: now, ...overrides }).returning();
    return row;
  };
  const quote = (lines: Array<ReturnType<typeof roses> | ReturnType<typeof vase>>) =>
    quoteOrderPromotions(container, { uid: 7, now, lines });

  it('counts participating pieces across products but discounts the cheapest unit only once', async () => {
    const root = await create({ productPartakeType: 2, overlay: '5', labelId: '31' });
    await fixture.db.insert(storePromotionsAuxiliary).values([
      { promotionsId: root.id, type: 1, productPartakeType: 2,
        productId: 1, unique: 'rose0001', isAll: 1 },
      { promotionsId: root.id, type: 1, productPartakeType: 2,
        productId: 2, unique: 'vase0001', isAll: 1 },
    ]);
    const two = await quote([roses(), vase()]);
    expect(two).toMatchObject({ totalPriceCents: 2400, totalSavingsCents: 500,
      couponEligibleGrossCents: 2400 });
    expect(two.lines.map(row => row.promotionSavingsCents)).toEqual([327, 173]);
    expect(two.lines.map(row => row.promotionAllocations[0].promotionId)).toEqual([root.id, root.id]);
    expect(two.lines[0].promotionAllocations[0].labelIds).toEqual([31]);
    const four = await quote([roses(2), vase(2)]);
    expect(four).toMatchObject({ totalPriceCents: 5300, totalSavingsCents: 500 });
    expect(four.lines.map(row => row.promotionSavingsCents)).toEqual([327, 173]);
    expect(await quote([roses(9), vase(9)])).toMatchObject({
      totalPriceCents: 25600, totalSavingsCents: 500 });
    await fixture.db.insert(storePromotions).values({ pid: root.id, type: 1, storeId: 0,
      promotionsType: 2, thresholdType: 2, threshold: '9.00', discountType: 2,
      discount: '0.00', isDel: 0 });
    expect((await quote([roses(2), vase(2)])).materialsFingerprint)
      .toBe(four.materialsFingerprint);
    await fixture.db.delete(storePromotionsAuxiliary).where(and(
      eq(storePromotionsAuxiliary.promotionsId, root.id),
      eq(storePromotionsAuxiliary.productId, 2)));
    const excluded = await quote([roses(), vase()]);
    expect(excluded).toMatchObject({ totalPriceCents: 2900, totalSavingsCents: 0 });
    expect(excluded.materialsFingerprint).not.toBe(two.materialsFingerprint);
  });

  it('treats zero percent as one cheapest free item and 100 percent as no discount', async () => {
    await fixture.db.update(storeProductAttrValue).set({ price: '0.01' })
      .where(eq(storeProductAttrValue.productId, 2));
    const root = await create({ nPieceNDiscount: 2, discount: '0.00' });
    const cheap = { ...vase(), rawUnitPriceCents: 1, memberUnitPriceCents: 1 };
    expect(await quote([roses(), cheap])).toMatchObject({ totalPriceCents: 1900,
      totalSavingsCents: 1 });
    await fixture.db.update(storePromotions).set({ nPieceNDiscount: 3, discount: '100.00' })
      .where(eq(storePromotions.id, root.id));
    expect(await quote([roses(), cheap])).toMatchObject({ totalPriceCents: 1901,
      totalSavingsCents: 0 });
  });

  it('stacks only mutual type-1 overlays and applies the cheapest-item rule to the current price', async () => {
    const nth = await create({ overlay: '1,5' });
    const [time] = await fixture.db.insert(storePromotions).values({ pid: 0, type: 1,
      storeId: 0, promotionsType: 1, name: '限时九折', productPartakeType: 1,
      discount: '90.00', discountType: 2, overlay: '2,5', startTime: now - 10,
      stopTime: now + 10, status: 1, isDel: 0, updateTime: now }).returning();
    const stacked = await quote([roses(2)]);
    expect(stacked.lines[0]).toMatchObject({ totalPriceCents: 2700,
      membershipSavingsCents: 0, promotionSavingsCents: 1298,
      promotionIds: [time.id, nth.id], couponEligibleGrossCents: 2700 });
    await fixture.db.update(storePromotions).set({ overlay: '' })
      .where(eq(storePromotions.id, time.id));
    const alone = await quote([roses(2)]);
    expect(alone.lines[0]).toMatchObject({ totalPriceCents: 2850,
      membershipSavingsCents: 198, promotionSavingsCents: 950,
      promotionIds: [nth.id], couponEligibleGrossCents: 2850 });
  });
});
