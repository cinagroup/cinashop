import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { normalizeGoodsDetail } from "../../view/pc-ts/src/api/productDetail";
import { pcDetailFixture as fixture } from "./helpers/pcProductDetailFixture";
import { StoreProductService } from "../src/services/product/StoreProductService";
import { ProductExperienceService } from "../src/services/product/ProductExperienceService";

vi.mock("../src/utils/cache", () => ({ cacheGet: vi.fn(async () => null), cacheSet: vi.fn(async () => {}) }));

describe("FE-002B PC product detail adapter", () => {
  it("consumes actual uncached and cached service outputs with isolated DAOs", async () => {
    const { cacheGet } = await import("../src/utils/cache");
    const assurance = vi.spyOn(ProductExperienceService.prototype, "productEnsures").mockResolvedValue([]);
    const daoProduct = { ...fixture, sliderImage: JSON.stringify(["/test-one.svg"]), deliveryType: "1,2" };
    const container = {
      storeProductDao: { getById: vi.fn(async () => daoProduct) },
      storeProductAttrValueDao: { getByProductId: vi.fn(async () => [
        { id: 901, unique: "realred1", suk: "红色,大号", price: "19.90", otPrice: "29.90", vipPrice: "17.90", stock: 8, sales: 2, image: "" },
      ]), getPriceRange: vi.fn(async () => ({ min: 0.1, max: 20 })) },
    } as unknown as ConstructorParameters<typeof StoreProductService>[0];
    try {
      const service = new StoreProductService(container, {} as ConstructorParameters<typeof StoreProductService>[1]);
      const wire = await service.getProductDetail(70, 0);
      expect(wire).not.toHaveProperty("store_name");
      expect(wire).not.toHaveProperty("cart_button");
      expect(normalizeGoodsDetail(wire).skus).toEqual([{ unique: "realred1", suk: "红色,大号", price: "19.90",
        ot_price: "29.90", vip_price: "17.90", stock: 8, image: "" }]);
      expect(normalizeGoodsDetail(wire)).toMatchObject({ store_name: fixture.storeName,
        store_info: fixture.storeInfo, price: "99.90", ot_price: "199.00", vip_price: "79.90",
        slider_image: ["/test-one.svg"], delivery_type: ["1", "2"], cart_button: 1 });
      vi.mocked(cacheGet).mockResolvedValueOnce(wire);
      expect(normalizeGoodsDetail(await service.getProductDetail(70, 0))).toEqual(normalizeGoodsDetail(wire));
      daoProduct.specType = 1;
      expect(normalizeGoodsDetail(await service.getProductDetail(70, 0))).toMatchObject({
        price: "0.1", min_price: 0.1, max_price: 20, spec_type: 1 });
    } finally { assurance.mockRestore(); vi.mocked(cacheGet).mockReset(); }
  });

  it("maps the observed camelCase/computed detail shape without recalculating money", () => {
    const source = Object.freeze({ ...fixture, sliderImage: ["/test-one.svg", "/test-two.svg"] });
    const result = normalizeGoodsDetail(source);
    expect(result).toMatchObject({ id: 70, store_name: fixture.storeName, store_info: fixture.storeInfo,
      slider_image: source.sliderImage, price: "99.90", ot_price: "199.00", vip_price: "79.90",
      stock: 100, fsales: 250, cart_button: 1, is_vip: 1, delivery_type: ["1", "2"],
      spec_type: 0, userCollect: false });
    expect(result.slider_image).not.toBe(source.sliderImage);
    expect(source).not.toHaveProperty("store_name");
  });

  it("round-trips the legacy view shape and preserves explicit empty/zero/false values", () => {
    const legacy = normalizeGoodsDetail(fixture);
    expect(normalizeGoodsDetail(legacy)).toEqual(legacy);
    expect(normalizeGoodsDetail({ ...fixture, store_name: "", slider_image: [], is_vip: 0,
      ot_price: "0.00", cart_button: 0 })).toMatchObject({ store_name: "", slider_image: [],
      is_vip: 0, ot_price: "0.00", cart_button: 0 });
  });

  it.each(["productType", "isPresaleProduct", "systemFormId"])("cannot enable restricted %s products", (key) => {
    for (const cart of [{}, { cart_button: 1 }, { cart_button: 0 }]) {
      expect(normalizeGoodsDetail({ ...fixture, [key]: 1, ...cart }).cart_button).toBe(0);
    }
  });

  it("does not interpret missing, malformed, off-sale or unavailable state as permission", () => {
    for (const delta of [{ stock: 0 }, { isShow: 0 }, { isDel: 1 }, { systemFormId: undefined },
      { cart_button: "1" }, { cart_button: false }, { cart_button: 2 }, { cart_button: null }]) {
      expect(normalizeGoodsDetail({ ...fixture, ...delta }).cart_button).toBe(0);
    }
  });

  it("keeps SKU range and member price strings exact, never synthesizing product images", () => {
    expect(normalizeGoodsDetail({ ...fixture, price: "0.10", vipPrice: "0.09", min_price: 0.1,
      max_price: 199, specType: 1, spec_type: 1, userCollect: true })).toMatchObject({
      price: "0.10", vip_price: "0.09", min_price: 0.1, max_price: 199, spec_type: 1,
      userCollect: true, slider_image: [], image: "" });
  });

  it("rejects malformed critical data and filters malformed optional image arrays", () => {
    for (const value of [null, [], "", { ...fixture, price: "NaN" }, { ...fixture, price: "-1" },
      { ...fixture, stock: -1 }, { ...fixture, stock: "100" }, { ...fixture, id: 0 }]) {
      expect(() => normalizeGoodsDetail(value)).toThrow();
    }
    expect(normalizeGoodsDetail({ ...fixture, sliderImage: [null, 2, "/valid.svg"] }).slider_image)
      .toEqual(["/valid.svg"]);
  });

  it("routes the real API through the adapter and retains disabled-button guards", () => {
    const api = readFileSync("../view/pc-ts/src/api/product.ts", "utf8");
    const page = readFileSync("../view/pc-ts/src/pages/goods/GoodsDetail.vue", "utf8");
    expect(api).toContain("normalizeGoodsDetail(await getData<unknown>(request.get(`/product/detail/${id}`)))");
    expect(page.match(/:disabled="!canPurchase \|\| purchaseSubmitting"/g)).toHaveLength(2);
    expect(page).toContain("detail.value?.cart_button === 1");
    expect(page).toContain("Math.max(selectedStock, 1)");
  });
});
