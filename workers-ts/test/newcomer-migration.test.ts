import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import { storeNewcomer } from "../src/models/schema";
import { configFlag, parseConfigIds } from "../src/services/activity/StoreNewcomerService";

describe("newcomer catalog migration", () => {
  it("preserves every source column and the identity migration key", () => {
    expect(getTableName(storeNewcomer)).toBe("store_newcomer");
    expect(Object.keys(getTableColumns(storeNewcomer))).toEqual([
      "id", "type", "productId", "productType", "relationId", "price",
      "otPrice", "sales", "isDel", "updateTime", "addTime",
    ]);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "store_newcomer")?.key)
      .toEqual(["id"]);
  });

  it("keeps historical duplicates importable and indexes active product lookups", () => {
    const migration = readFileSync("migrations/0059_store_newcomer.sql", "utf8");
    expect(migration).not.toContain("CREATE UNIQUE INDEX");
    expect(migration).toContain('"store_newcomer_product_id"');
    expect(migration).toContain('"store_newcomer_active_id"');
    expect(migration).toContain('"store_newcomer_product_active"');
  });

  it("parses legacy scalar flags and coupon-id JSON safely", () => {
    expect(configFlag('"1"')).toBe(true);
    expect(configFlag("false")).toBe(false);
    expect(configFlag(undefined, true)).toBe(true);
    expect(parseConfigIds("[3,2,3]")).toEqual([3, 2]);
    expect(parseConfigIds("4,5,invalid")).toEqual([4, 5]);
  });

  it("restores catalog routes and maps activity SKU prices to base SKU stock", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const cart = readFileSync("src/services/order/StoreCartService.ts", "utf8");
    const order = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    const pcCheckout = readFileSync("../view/pc-ts/src/pages/order/Checkout.vue", "utf8");
    const uniCheckout = readFileSync("../view/uniapp-ts/src/pages/order/confirm.vue", "utf8");
    for (const route of [
      "/newcomer/product_list",
      "/newcomer/product_detail/:id",
      "/newcomer/info",
      "/newcomer/gift",
    ]) expect(routes).toContain(route);
    expect(cart).toContain("resolved.baseSku.unique");
    expect(cart).toContain("新人专享商品限购一件");
    expect(order).toContain("newcomerActivitySkuId");
    expect(order).toContain("isNewcomer: 1");
    expect(order).toContain('.for("update")');
    expect(order).toContain("type === 7");
    expect(order).toContain("loadFirstOrderDiscountConfig");
    expect(order).toContain("firstOrderPriceCents");
    expect(order).toContain("isFirstOrder: 1");
    expect(order).toContain("hasPaidNonNewcomerOrder");
    expect(order).toContain("preliminaryFirstOrderEligible");
    expect(routes).toContain("/order/first_order_quote");
    expect(cart).toContain("quoteFirstOrderDiscount");
    expect(pcCheckout).toContain("apiFirstOrderQuote");
    expect(uniCheckout).toContain("couponExclusive");
  });

  it("initializes newcomer eligibility for password and WeChat registrations", () => {
    const service = readFileSync("src/services/activity/StoreNewcomerService.ts", "utf8");
    const login = readFileSync("src/services/user/LoginService.ts", "utf8");
    const wechat = readFileSync("src/services/wechat/WechatAuthService.ts", "utf8");
    expect(service).toContain("registrationState");
    expect(service).toContain("applyRegistrationGifts");
    expect(service).toContain("isFirstOrder: -1, isNewcomer: -1");
    expect(login).toContain("...registration.flags");
    expect(login).toContain("applyRegistrationGifts(tx");
    expect(wechat).toContain("...registration.flags");
    expect(wechat).toContain("applyRegistrationGifts(tx");
    expect(wechat).toContain("pg_advisory_xact_lock");
  });

  it("restores the PHP Admin register configuration and catalog routes", () => {
    const routes = readFileSync("src/routes/adminapi.ts", "utf8");
    const service = readFileSync("src/services/activity/AdminNewcomerService.ts", "utf8");
    const page = readFileSync("../view/admin-ts/src/pages/config/NewcomerSettings.vue", "utf8");
    expect(routes).toContain('/config/user/register"');
    expect(routes).toContain('/config/user/register/products"');
    expect(routes).toContain('/config/user/register/coupons"');
    expect(service).toContain("REGISTER_CONFIG_KEYS");
    expect(service).toContain("newcomer_agreement");
    expect(page).toContain("新人运营");
    expect(page).toContain("config.manage");
  });
});
