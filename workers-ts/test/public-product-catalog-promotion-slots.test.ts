import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Env } from "@/env";
import { createContainerFromDb } from "@/lib/di";
import {
  memberRight,
  storeProduct,
  storeProductRelation,
  storePromotions,
  storePromotionsAuxiliary,
  systemConfig,
  systemStore,systemSupplier,systemAttachment,storeBrand,storeCart,
} from "@/models/schema";
import { V2PromotionCompatibilityService } from "@/services/activity/V2PromotionCompatibilityService";
import { StoreProductService } from "@/services/product/StoreProductService";
import { financePostgres } from "./helpers/financePostgres";

describe("ordinary product catalogue promotion slots", () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let products: StoreProductService;
  const now = Math.floor(Date.now() / 1_000);

  beforeAll(async () => {
    fixture = await financePostgres([
      memberRight, systemConfig, storeProduct, storeProductRelation,
      storePromotions, storePromotionsAuxiliary,systemStore,systemSupplier,systemAttachment,storeBrand,storeCart,
    ]);
    products = new StoreProductService(createContainerFromDb(fixture.db), {} as Env);
    await fixture.db.insert(storeProduct).values([
      { id: 101, pid: 0, storeName: "multiple promotion types", price: "19.90", isShow: 1, isVerify: 1 },
      { id: 102, pid: 0, storeName: "no matching frame", price: "9.90", isShow: 1, isVerify: 1 },
    ]);
    await fixture.db.insert(storeProductRelation).values([
      { productId: 101, type: 2, relationId: 7 },
      { productId: 101, type: 3, relationId: 9 },
    ]);
    await fixture.db.insert(storePromotions).values([
      { id: 1, promotionsType: 1, productPartakeType: 1, name: "discount", discount: "90.00",
        startTime: now - 3_600, stopTime: now + 3_600, updateTime: 1 },
      { id: 5, promotionsType: 5, productPartakeType: 4, name: "frame", image: "/frame.png",
        startTime: now - 3_600, stopTime: now + 3_600, updateTime: 5 },
      { id: 6, promotionsType: 6, productPartakeType: 5, name: "background", image: "/background.png",
        startTime: now - 3_600, stopTime: now + 3_600, updateTime: 6 },
      { id: 7, promotionsType: 5, productPartakeType: 1, name: "disabled frame", image: "/disabled.png",
        status: 0, startTime: now - 3_600, stopTime: now + 3_600, updateTime: 7 },
    ]);
    await fixture.db.insert(storePromotionsAuxiliary).values([
      { promotionsId: 5, type: 1, productPartakeType: 4, brandId: 7 },
      { promotionsId: 6, type: 1, productPartakeType: 5, storeLabelId: 9 },
    ]);
  }, 30_000);

  afterAll(async () => { await fixture?.close(); });

  it("keeps discount, matching frame and matching background together in both list paths", async () => {
    const catalogue = await products.getGoodsList({}, 0);
    expect(catalogue.count).toBe(2);
    const recommendations = await products.getRecommendProducts(0);
    for (const list of [catalogue.list, recommendations]) {
      const matching = list.find((row) => row.id === 101);
      const other = list.find((row) => row.id === 102);
      expect(matching).toMatchObject({
        promotions: { id: 1, promotions_type: 1 },
        activity_frame: { id: 5, name: "frame", image: "/frame.png" },
        activity_background: { id: 6, name: "background", image: "/background.png" },
      });
      expect(other).toMatchObject({ promotions: { id: 1, promotions_type: 1 } });
      expect(other?.activity_frame).toEqual([]);
      expect(other?.activity_background).toEqual([]);
    }
  });

  it("selects page-scoped winners despite more than 200 active platform promotions", async () => {
    await fixture.db.insert(storePromotions).values(Array.from({ length: 205 }, (_, index) => ({
      id: 1_000 + index,
      promotionsType: 5,
      productPartakeType: 2,
      name: `unrelated frame ${index}`,
      startTime: now - 3_600,
      stopTime: now + 3_600,
      updateTime: 1_000 + index,
    })));
    await fixture.db.insert(storePromotions).values([
      { id: 2_001, promotionsType: 5, productPartakeType: 3, name: "not excluded",
        image: "/not-excluded.png", startTime: now - 3_600, stopTime: now + 3_600,
        updateTime: 20_001 },
      { id: 2_002, promotionsType: 5, productPartakeType: 3, name: "excluded product 101",
        image: "/excluded.png", startTime: now - 3_600, stopTime: now + 3_600,
        updateTime: 20_002 },
      { id: 3_001, promotionsType: 4, productPartakeType: 1, name: "newer promotion type",
        startTime: now - 3_600, stopTime: now + 3_600, updateTime: 30_001 },
      { id: 3_002, promotionsType: 5, productPartakeType: 1, name: "child activity",
        pid: 77, startTime: now - 3_600, stopTime: now + 3_600, updateTime: 30_002 },
      { id: 3_003, promotionsType: 5, productPartakeType: 1, name: "supplier activity",
        storeId: 77, startTime: now - 3_600, stopTime: now + 3_600, updateTime: 30_003 },
      { id: 3_004, promotionsType: 5, productPartakeType: 1, name: "expired activity",
        startTime: now - 7_200, stopTime: now - 3_600, updateTime: 30_004 },
    ]);
    await fixture.db.insert(storePromotionsAuxiliary).values([
      { promotionsId: 2_001, type: 1, productPartakeType: 3, productId: 101, isAll: 0 },
      { promotionsId: 2_002, type: 1, productPartakeType: 3, productId: 101, isAll: 1 },
    ]);

    const catalogue = await products.getGoodsList({}, 0);
    const recommendations = await products.getRecommendProducts(0);
    for (const list of [catalogue.list, recommendations]) {
      const first = list.find((row) => row.id === 101);
      const second = list.find((row) => row.id === 102);
      expect(first).toMatchObject({
        promotions: { id: 1, promotions_type: 1 },
        activity_frame: { id: 2_001, image: "/not-excluded.png" },
        activity_background: { id: 6, image: "/background.png" },
      });
      expect(second).toMatchObject({ activity_frame: { id: 2_002, image: "/excluded.png" } });
    }
    const promotions = new V2PromotionCompatibilityService(
      createContainerFromDb(fixture.db), {} as Env,
    );
    const [child] = await promotions.decorateCatalogProducts([{ id: 103, pid: 101 }]);
    expect(child).toMatchObject({
      activity_frame: { id: 2_001 },
      activity_background: { id: 6 },
    });
    // This endpoint selects only type 1, then calls getRecommendProducts. Its
    // recommendation decoration must not reintroduce the global 200-row cap.
    const discountProducts = await promotions.productList(1, { page: 1, limit: 10 });
    expect(discountProducts.list.map((row) => row.product_id)).toEqual([102, 101]);
  });

  it("returns the three legacy empty slots when all promotions are disabled", async () => {
    await fixture.db.update(storePromotions).set({ status: 0 }).where(eq(storePromotions.status, 1));
    const catalogue = await products.getGoodsList({}, 0);
    const recommendations = await products.getRecommendProducts(0);
    for (const row of [...catalogue.list, ...recommendations]) {
      expect(row.promotions).toEqual([]);
      expect(row.activity_frame).toEqual([]);
      expect(row.activity_background).toEqual([]);
    }
  });
});
