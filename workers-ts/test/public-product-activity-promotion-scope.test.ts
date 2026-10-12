import { systemStore, systemSupplier } from '../src/models/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import {
  storeCouponIssue, storeCouponProduct, storeDiscounts, storeDiscountsProducts,
  storeProduct, storeProductRelation, storePromotions, storePromotionsAuxiliary,
  systemDise,
} from '../src/models/schema';
import { PublicCatalogService } from '../src/services/product/PublicCatalogService';
import { financePostgres } from './helpers/financePostgres';

type ActivityResult = {
  promotions: Array<{ id: number; promotions_type: number }>;
  activity_background: { id: number; name: string; image: string } | [];
};

describe('public product activity promotion scopes', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let catalog: PublicCatalogService;
  const now = Math.floor(Date.now() / 1_000);
  const promotion = (
    id: number,
    promotionsType: number,
    productPartakeType: number,
    overrides: Partial<typeof storePromotions.$inferInsert> = {},
  ) => ({
    id, promotionsType, productPartakeType, name: `promotion ${id}`, image: `/images/image-${id}.png`,
    startTime: now - 3_600, stopTime: now + 3_600, updateTime: id,
    ...overrides,
  });
  const auxiliary = (
    promotionsId: number,
    overrides: Partial<typeof storePromotionsAuxiliary.$inferInsert> = {},
  ) => ({ promotionsId, type: 1, ...overrides });

  beforeAll(async () => {
    fixture = await financePostgres([systemStore, systemSupplier,
      storeProduct, storeProductRelation, storePromotions, storePromotionsAuxiliary,
      storeCouponIssue, storeCouponProduct, storeDiscounts, storeDiscountsProducts,
      systemDise,
    ]);
    catalog = new PublicCatalogService(createContainerFromDb(fixture.db), {} as Env);
    await fixture.db.insert(systemStore).values({ id: 7, isStore: 1, isShow: 1, isDel: 0 });
    await fixture.db.insert(storeProduct).values([
      { id: 101, pid: 0, storeName: 'main', isShow: 1, isVerify: 1 },
      { id: 102, pid: 101, type: 1, relationId: 7, storeName: 'variant', isShow: 1, isVerify: 1 },
      { id: 201, pid: 0, storeName: 'other', isShow: 1, isVerify: 1 },
      { id: 301, pid: 0, storeName: 'presale', isPresaleProduct: 1, isShow: 1, isVerify: 1 },
    ]);
    await fixture.db.insert(storeProductRelation).values([
      { productId: 101, type: 2, relationId: 7 },
      { productId: 101, type: 3, relationId: 9 },
      { productId: 201, type: 2, relationId: 8 },
      { productId: 201, type: 3, relationId: 10 },
    ]);
    await fixture.db.insert(storePromotions).values([
      promotion(1, 1, 1),
      promotion(2, 2, 2),
      promotion(3, 3, 3),
      promotion(4, 4, 4),
      promotion(5, 6, 5),
      promotion(6, 6, 5, { updateTime: 200 }),
      promotion(7, 1, 1, { stopTime: now - 1, updateTime: 200 }),
      promotion(8, 2, 2, { updateTime: 200 }),
      promotion(9, 3, 3, { updateTime: 200 }),
      promotion(10, 4, 4, { updateTime: 200 }),
      promotion(11, 6, 5, { updateTime: 201 }),
      promotion(12, 5, 1),
      promotion(13, 7, 1),
      promotion(14, 1, 1, { status: 0, updateTime: 201 }),
      promotion(15, 1, 1, { storeId: 1, updateTime: 202 }),
      promotion(16, 1, 1, { type: 2, updateTime: 203 }),
      promotion(17, 1, 1, { pid: 17, updateTime: 204 }),
      promotion(18, 1, 1, { startTime: now + 3_600, updateTime: 205 }),
      promotion(19, 1, 1, { isDel: 1, updateTime: 206 }),
      promotion(20, 2, 2, { updateTime: 202 }),
      promotion(21, 2, 2, { updateTime: 100 }),
      promotion(22, 3, 3, { updateTime: 100 }),
    ]);
    await fixture.db.insert(storePromotionsAuxiliary).values([
      auxiliary(2, { productPartakeType: 2, productId: 101 }),
      auxiliary(3, { productPartakeType: 3, productId: 201, isAll: 1 }),
      auxiliary(4, { productPartakeType: 4, brandId: 7, productId: 0 }),
      auxiliary(5, { productPartakeType: 5, storeLabelId: 9, productId: 0 }),
      auxiliary(6, { productPartakeType: 5, storeLabelId: 10, productId: 0 }),
      auxiliary(8, { productPartakeType: 2, productId: 201 }),
      auxiliary(9, { productPartakeType: 3, productId: 101, isAll: 1 }),
      auxiliary(10, { productPartakeType: 4, brandId: 8, productId: 0 }),
      auxiliary(11, { productPartakeType: 5, storeLabelId: 10, productId: 0 }),
      auxiliary(20, { productPartakeType: 2, productId: 101, type: 2 }),
      auxiliary(21, { productPartakeType: 2, productId: 101 }),
      auxiliary(22, { productPartakeType: 3, productId: 101, isAll: 0 }),
    ]);
  }, 30_000);

  afterAll(async () => { await fixture?.close(); });

  it('matches all five product scopes, one newest applicable row per default type, and background type 6', async () => {
    const result = await catalog.productActivity(101) as ActivityResult;
    expect(result.promotions.map((row) => [row.promotions_type, row.id])).toEqual([
      [1, 1], [2, 21], [3, 22], [4, 4],
    ]);
    expect(result.activity_background).toEqual({ id: 5, name: 'promotion 5', image: '/images/image-5.png' });
  });

  it('uses the parent product for a variant and preserves the presale/absent empty contract', async () => {
    const variant = await catalog.productActivity(102) as ActivityResult;
    expect(variant.promotions.map((row) => row.id)).toEqual([1, 21, 22, 4]);
    expect(variant.activity_background).toEqual({ id: 5, name: 'promotion 5', image: '/images/image-5.png' });
    expect(await catalog.productActivity(301)).toMatchObject({ promotions: [], activity_background: [] });
    expect(await catalog.productActivity(999)).toMatchObject({ promotions: [], activity_background: [] });
  });

  it('returns a frame only for an explicit type 5 request and honors the DIY activity switch', async () => {
    const frame = await catalog.productActivity(101, 5) as ActivityResult;
    expect(frame.promotions.map((row) => [row.promotions_type, row.id])).toEqual([[5, 12]]);
    expect(frame.activity_background).toEqual([]);

    await fixture.db.insert(systemDise).values({ templateName: 'product_detail', type: 3,
      value: JSON.stringify({ showService: [1, 2, 3] }) });
    const hidden = await catalog.productActivity(101) as ActivityResult;
    expect(hidden.promotions).toEqual([]);
    expect(hidden.activity_background).toEqual({ id: 5, name: 'promotion 5', image: '/images/image-5.png' });
    expect((await catalog.productActivity(101, 5) as ActivityResult).promotions.map((row) => row.id)).toEqual([12]);
  });
});
