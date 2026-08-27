import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeDiscountPackageInput } from "@/services/activity/AdminDiscountPackageService";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";

function validInput(): Record<string, unknown> {
  return {
    title: "咖啡随行组合",
    image: "https://cdn.example.test/package.png",
    type: 1,
    is_limit: 1,
    limit_num: 50,
    link_ids: [{ id: 8 }, { id: 3 }],
    is_time: 1,
    time: ["2026-08-15", "2026-08-31"],
    sort: 100,
    free_shipping: 1,
    status: 1,
    is_support_refund: 0,
    products: [
      {
        product_id: 10,
        type: 1,
        skus: [
          { base_unique: "BASE0001", price: "7.25" },
          { base_unique: "BASE0002", price: 8 },
        ],
      },
      {
        product_id: 20,
        type: 0,
        attr: [{ unique: "BASE0003", price: "0" }],
      },
    ],
  };
}

describe("admin discount-package migration", () => {
  it("normalizes the PHP snake-case contract and canonical SKU input", () => {
    const normalized = normalizeDiscountPackageInput(validInput());
    expect(normalized.type).toBe(1);
    expect(normalized.limitNum).toBe(50);
    expect(normalized.linkIds).toEqual([3, 8]);
    expect(normalized.startTime).toBe(1_786_723_200);
    expect(normalized.stopTime).toBe(1_788_191_999);
    expect(normalized.products).toEqual([
      {
        productId: 10,
        required: 1,
        skus: [
          { unique: "BASE0001", price: "7.25" },
          { unique: "BASE0002", price: "8.00" },
        ],
      },
      {
        productId: 20,
        required: 0,
        skus: [{ unique: "BASE0003", price: "0.00" }],
      },
    ]);
  });

  it("keeps fixed packages all-required while allowing zero-priced promotional components", () => {
    const input = validInput();
    input.type = 0;
    const products = input.products as Array<Record<string, unknown>>;
    products[0].type = 1;
    const normalized = normalizeDiscountPackageInput(input);
    expect(normalized.products.map((product) => product.required)).toEqual([0, 0]);
    expect(normalized.products[1].skus[0].price).toBe("0.00");
  });

  it("rejects duplicate products/SKUs, missing mix-package mains and invalid dates", () => {
    const duplicateProducts = validInput();
    (duplicateProducts.products as Array<Record<string, unknown>>)[1].product_id = 10;
    expect(() => normalizeDiscountPackageInput(duplicateProducts)).toThrow("套餐商品不能重复");

    const duplicateSkus = validInput();
    ((duplicateSkus.products as Array<Record<string, unknown>>)[0].skus as Array<Record<string, unknown>>)[1]
      .base_unique = "BASE0001";
    expect(() => normalizeDiscountPackageInput(duplicateSkus)).toThrow("同一商品规格不能重复");

    const noMain = validInput();
    for (const product of noMain.products as Array<Record<string, unknown>>) product.type = 0;
    expect(() => normalizeDiscountPackageInput(noMain)).toThrow("至少需要一个主商品");

    expect(() => normalizeDiscountPackageInput({ ...validInput(), time: ["2026-02-30", "2026-03-01"] }))
      .toThrow("套餐日期不存在");
  });

  it("maps PHP-compatible reads/writes and the legacy GET mutation to activity ACL", () => {
    expect(requiredAdminPermission("GET", "/adminapi/discounts/list")).toBe("activity.view");
    expect(requiredAdminPermission("GET", "/adminapi/discounts/info/:id")).toBe("activity.view");
    expect(requiredAdminPermission("POST", "/adminapi/discounts/save")).toBe("activity.manage");
    expect(requiredAdminPermission("GET", "/adminapi/discounts/set_status/:id/:status"))
      .toBe("activity.manage");
    expect(requiredAdminPermission("DELETE", "/adminapi/discounts/del/:id")).toBe("activity.manage");
  });

  it("uses bounded bodies, an advisory lock, transactions and type-5 SKU snapshots", () => {
    const controller = readFileSync("src/controllers/api/v1/AdminDiscountPackageController.ts", "utf8");
    const service = readFileSync("src/services/activity/AdminDiscountPackageService.ts", "utf8");
    const routes = readFileSync("src/routes/adminapi.ts", "utf8");
    expect(controller).toContain("MAX_BODY_BYTES");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain("withTx(this.container");
    expect(service).toContain("PACKAGE_SKU_TYPE = 5");
    expect(service).toContain("storeProductAttrResult");
    expect(routes).toContain('"/discounts/list"');
    expect(routes).toContain('"/discounts/set_status/:id/:status"');
  });
});
