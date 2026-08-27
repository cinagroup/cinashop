import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";
import {
  REGISTER_CONFIG_KEYS,
  normalizeRegisterConfig,
} from "@/services/activity/AdminNewcomerService";
import {
  parseFirstOrderPayPercent,
  parseLegacyWholeMoney,
} from "@/services/activity/StoreNewcomerService";

function validInput(): Record<string, unknown> {
  return {
    store_user_mobile: 0,
    routine_auth_type: [1, 2],
    store_user_agreement: 1,
    newcomer_status: 1,
    newcomer_limit_status: 1,
    newcomer_limit_time: 7,
    register_integral_status: 1,
    register_give_integral: 100,
    register_money_status: 1,
    register_give_money: "9.99",
    register_coupon_status: 1,
    register_give_coupon: [{ id: 8 }, { id: 3 }],
    first_order_status: 1,
    first_order_discount: "89.50",
    first_order_discount_limit: "15.25",
    register_price_status: 1,
    newcomer_agreement: "规则",
    product: [{
      product_id: 10,
      attr: [
        { unique: "BASE0001", price: "19.90" },
        { unique: "BASE0002", price: "20" },
      ],
    }],
  };
}

describe("admin newcomer configuration", () => {
  it("normalizes only the PHP register-config whitelist", () => {
    const normalized = normalizeRegisterConfig({ ...validInput(), arbitrary_secret: "ignored" });
    expect(Object.keys(normalized.values)).toEqual([...REGISTER_CONFIG_KEYS]);
    expect(normalized.values.register_give_coupon).toEqual([3, 8]);
    expect(normalized.values.register_give_money).toBe("9.99");
    expect(normalized.values.first_order_discount).toBe("89.50");
    expect(normalized.products[0]).toEqual({
      productId: 10,
      skus: [
        { unique: "BASE0001", price: "19.90" },
        { unique: "BASE0002", price: "20.00" },
      ],
    });
  });

  it("rejects duplicate products, coupon IDs and SKU identifiers", () => {
    expect(() => normalizeRegisterConfig({
      ...validInput(),
      register_give_coupon: [3, 3],
    })).toThrow("优惠券不能重复");
    expect(() => normalizeRegisterConfig({
      ...validInput(),
      product: [
        (validInput().product as unknown[])[0],
        (validInput().product as unknown[])[0],
      ],
    })).toThrow("新人专享商品不能重复");
    expect(() => normalizeRegisterConfig({
      ...validInput(),
      product: [{ product_id: 10, attr: [
        { unique: "BASE0001", price: 10 },
        { unique: "BASE0001", price: 12 },
      ] }],
    })).toThrow("同一商品规格不能重复");
  });

  it("preserves legacy discount and whole-unit registration-money semantics", () => {
    expect(parseFirstOrderPayPercent("89.50")).toBe(89);
    expect(parseLegacyWholeMoney("9.99")).toBe(9);
    expect(parseLegacyWholeMoney("0.99")).toBe(0);
  });

  it("maps reads and writes to existing config permissions", () => {
    expect(requiredAdminPermission("GET", "/adminapi/config/user/register")).toBe("config.view");
    expect(requiredAdminPermission("GET", "/adminapi/config/user/register/products")).toBe("config.view");
    expect(requiredAdminPermission("POST", "/adminapi/config/user/register")).toBe("config.manage");
  });

  it("uses bounded bodies, advisory locking and an atomic catalog replacement", () => {
    const controller = readFileSync("src/controllers/api/v1/AdminNewcomerController.ts", "utf8");
    const service = readFileSync("src/services/activity/AdminNewcomerService.ts", "utf8");
    expect(controller).toContain("MAX_BODY_BYTES");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain("replaceCatalog(tx");
    expect(service).toContain("Promise.all(REGISTER_CONFIG_KEYS.map");
    expect(service).toContain('eq(storeProductAttrValue.type, 7)');
  });
});
