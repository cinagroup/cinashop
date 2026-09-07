import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeGoodsDetail } from "../../view/pc-ts/src/api/productDetail";
import { normalizeGoodsSkus, parseCheckoutSelection, productCartInput } from "../../view/pc-ts/src/api/productPurchase";
import { pcDetailFixture } from "./helpers/pcProductDetailFixture";

const skus = [
  { unique: "real-red", suk: "红色,大号", stock: 8, price: "19.90", ot_price: "29.90", vip_price: "17.90" },
  { unique: "real-blue", suk: "蓝色,小号", stock: 2, price: "0.10", ot_price: "1.00", vip_price: "0.09" },
  { unique: "sold-out", suk: "白色,大号", stock: 0, price: "29.90" },
];
describe("FE-002E PC purchase selection contracts", () => {
  it("preserves actual SKU identities, combinations and decimal strings", () => {
    const detail = normalizeGoodsDetail({ ...pcDetailFixture, attr_value: skus });
    expect(detail.skus).toMatchObject(skus);
    expect(normalizeGoodsDetail(detail)).toEqual(detail);
    expect(productCartInput(detail, "real-blue", 2, true)).toEqual({ productId: 70, unique: "real-blue", cartNum: 2, new: 1 });
    expect(productCartInput(detail, "real-red", 1, false).new).toBe(0);
  });
  it("rejects guessed/missing/sold out SKU, restricted goods and quantities outside the selected SKU", () => {
    const detail = normalizeGoodsDetail({ ...pcDetailFixture, attr_value: skus });
    for (const [unique, qty] of [["sku00070", 1], ["", 1], ["sold-out", 1], ["real-blue", 3],
      ["real-red", 0], ["real-red", 1.5], ["real-red", Number.NaN]] as const) {
      expect(() => productCartInput(detail, unique, qty, true)).toThrow();
    }
    expect(() => productCartInput({ ...detail, cart_button: 0 }, "real-red", 1, false)).toThrow();
    expect(() => productCartInput({ ...detail, stock: 1 }, "real-red", 2, false)).toThrow();
    expect(() => productCartInput(normalizeGoodsDetail(pcDetailFixture), "sku00070", 1, true)).toThrow();
  });
  it("fails closed on malformed or ambiguous SKU inventory", () => {
    for (const value of [null, {}, [null], [skus[0], skus[0]], [{ ...skus[0], stock: -1 }],
      [{ ...skus[0], price: "NaN" }], [{ ...skus[0], unique: " " }], [{ ...skus[0], stock: "8" }]]) {
      expect(() => normalizeGoodsSkus(value)).toThrow();
    }
    expect(normalizeGoodsSkus(undefined)).toEqual([]);
  });
  it("distinguishes ordinary checkout from exact direct IDs without fallback", () => {
    expect(parseCheckoutSelection({})).toEqual({ mode: "cart" });
    expect(parseCheckoutSelection({ mode: "buy", cartIds: "8,3" })).toEqual({ mode: "buy", ids: [8, 3] });
    expect(parseCheckoutSelection({ mode: "buy", cartId: "4" })).toEqual({ mode: "buy", ids: [4] });
    for (const query of [{ mode: "buy" }, { mode: "buy", cartIds: "" }, { cartIds: "1" },
      { mode: "cart", cartIds: "1" }, { mode: "buy", cartIds: "1,bad" }, { mode: "buy", cartIds: "1,1" },
      { mode: "buy", cartIds: "1", cartId: "2" }, { mode: "buy", cartIds: ["1"] }, { mode: "buy", cartIds: "0" },
      { mode: "buy", cartIds: "9007199254740992" }, { mode: "buy", cartIds: Array.from({ length: 101 }, (_, i) => i + 1).join(",") }]) {
      expect(() => parseCheckoutSelection(query)).toThrow();
    }
  });
  it("wires guarded purchase and distinct read paths into real pages", () => {
    const detail = readFileSync("../view/pc-ts/src/pages/goods/GoodsDetail.vue", "utf8");
    const checkout = readFileSync("../view/pc-ts/src/pages/order/Checkout.vue", "utf8");
    const cart = readFileSync("../view/pc-ts/src/api/cart.ts", "utf8");
    expect(detail).toContain("productCartInput(detail.value, selectedUnique.value, qty.value, direct)");
    expect(detail).not.toContain('String(detail.value.id).padStart');
    expect(detail).not.toContain("立即购买接入中");
    expect(detail).toContain("purchaseSubmitting.value = true");
    expect(detail).toContain("sku: input.unique, qty: String(input.cartNum)");
    expect(detail).toContain("hash: route.hash }).fullPath");
    expect(checkout).toContain("await apiDirectCartList(requested.ids)");
    expect(checkout).toContain("parseCheckoutSelection(route.query)");
    expect(checkout).not.toContain("ids.size > 0");
    expect(checkout).toContain("apiOrderCreate(orderKey.value");
    expect(cart).toContain('scope: "cart"');
    expect(cart).toContain('scope: "buy"');
  });
});
