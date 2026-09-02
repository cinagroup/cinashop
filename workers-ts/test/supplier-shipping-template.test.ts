import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatLegacyShippingRuleGroups,
  normalizeSupplierShippingTemplateInput,
} from "@/services/supplier/SupplierShippingTemplateService";

function validTemplate() {
  return {
    name: "  华南运费模板  ",
    type: 2,
    appoint: 1,
    no_delivery: 1,
    sort: 88,
    region_info: [
      {
        city_ids: [[0]],
        first: "1",
        first_price: "8",
        continue: "0.5",
        continue_price: "2.25",
      },
      {
        city_ids: [[44], [11, 1101]],
        first: "1.25",
        first_price: "6.50",
        continue: "0.5",
        continue_price: "1.50",
      },
    ],
    appoint_info: [{ city_ids: [[44, 4401]], number: "2", price: "99.9" }],
    no_delivery_info: [{ city_ids: [[65, 6501]] }],
  };
}

describe("supplier shipping-template normalization", () => {
  it("normalizes the complete legacy form without accepting scope fields", () => {
    const result = normalizeSupplierShippingTemplateInput({
      ...validTemplate(),
      owner_type: 0,
      relation_id: 999,
    });
    expect(result).toMatchObject({
      name: "华南运费模板",
      billingType: 2,
      appoint: 1,
      noDelivery: 1,
      sort: 88,
    });
    expect(result.regions[0]).toMatchObject({
      paths: [[0]],
      first: "1.00",
      firstPrice: "8.00",
      continue: "0.50",
      continuePrice: "2.25",
    });
    expect(result.freeRules[0]).toMatchObject({ number: "2.00", price: "99.90" });
  });

  it("removes disabled optional rules so stale rows cannot remain authoritative", () => {
    const result = normalizeSupplierShippingTemplateInput({
      ...validTemplate(),
      appoint: 0,
      no_delivery: 0,
    });
    expect(result.appoint).toBe(0);
    expect(result.noDelivery).toBe(0);
    expect(result.freeRules).toEqual([]);
    expect(result.noDeliveryRules).toEqual([]);
  });

  it("rejects ambiguous, unbounded and invalid money/path inputs", () => {
    const duplicate = validTemplate();
    duplicate.region_info[1].city_ids = [[0]];
    expect(() => normalizeSupplierShippingTemplateInput(duplicate)).toThrow("配送区域不能重复");

    const noDefault = validTemplate();
    noDefault.region_info = [noDefault.region_info[1]];
    expect(() => normalizeSupplierShippingTemplateInput(noDefault)).toThrow("默认全国规则");

    const invalidFree = validTemplate();
    invalidFree.appoint_info[0].city_ids = [[0]];
    expect(() => normalizeSupplierShippingTemplateInput(invalidFree)).toThrow("全国路径格式错误");

    const excessivePrecision = validTemplate();
    excessivePrecision.region_info[0].first_price = "1.001";
    expect(() => normalizeSupplierShippingTemplateInput(excessivePrecision)).toThrow("最多两位小数");
  });

  it("formats migrated rows back into the legacy grouped city_ids contract", () => {
    expect(formatLegacyShippingRuleGroups([
      {
        id: 2,
        provinceId: 44,
        cityId: 4403,
        value: "[44,4403]",
        uniqid: "group-a",
        first: "1.00",
        firstPrice: "6.00",
        continue: "1.00",
        continuePrice: "2.00",
        billingGroup: 1,
      },
      {
        id: 1,
        provinceId: 44,
        cityId: 4401,
        value: "[44,4401]",
        uniqid: "group-a",
        first: "1.00",
        firstPrice: "6.00",
        continue: "1.00",
        continuePrice: "2.00",
        billingGroup: 1,
      },
    ], "region")).toEqual([{
      id: 2,
      province_id: 44,
      uniqid: "group-a",
      city_id: [4401, 4403],
      city_ids: [[44, 4401], [44, 4403]],
      first: "1.00",
      first_price: "6.00",
      continue: "1.00",
      continue_price: "2.00",
      group: 1,
    }]);
  });
});

describe("supplier shipping-template migration wiring", () => {
  it("mounts all five exact PHP routes after authentication", () => {
    const routes = readFileSync("src/routes/supplierapi.ts", "utf8");
    for (const route of [
      'get(\n  "/setting/shipping_templates/list"',
      'get(\n  "/setting/shipping_templates/:id/edit"',
      'post(\n  "/setting/shipping_templates/save/:id"',
      'delete(\n  "/setting/shipping_templates/del/:id"',
      'get(\n  "/setting/shipping_templates/city_list"',
    ]) {
      expect(routes).toContain(route);
    }
    expect(routes.indexOf('use("/*", supplierAuthMiddleware)')).toBeLessThan(
      routes.indexOf('"/setting/shipping_templates/list"'),
    );
  });

  it("migrates the Supplier page and product template selector without legacy delete side effects", () => {
    const page = readFileSync("../view/supplier-ts/src/pages/ShippingTemplates.vue", "utf8");
    const product = readFileSync("../view/supplier-ts/src/pages/ProductForm.vue", "utf8");
    const api = readFileSync("../view/supplier-ts/src/api/supplier.ts", "utf8");
    expect(page).toContain("form.region_info.splice(index, 1)");
    expect(page).not.toContain("deleteShippingTemplate(rule.id");
    expect(page).toContain("被商品使用的模板会被服务器拒绝删除");
    expect(product).toContain('form.freight === 3');
    expect(product).toContain("getShippingTemplates({ page: 1, limit: 100 })");
    expect(api).toContain('url: "/setting/shipping_templates/city_list"');
  });

  it("keeps every mutation tenant-scoped, transactional and locked", () => {
    const service = readFileSync(
      "src/services/supplier/SupplierShippingTemplateService.ts",
      "utf8",
    );
    expect(service).toContain("eq(shippingTemplates.ownerType, SUPPLIER_OWNER_TYPE)");
    expect(service).toContain("eq(shippingTemplates.relationId, supplierId)");
    expect(service).toContain("eq(shippingTemplates.isDel, 0)");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain('.for("update")');
    expect(service).toContain("运费模板仍被商品使用，不能删除");
    expect(service).toContain("await replaceRules(tx, savedId, input, cities, now)");
  });
});
