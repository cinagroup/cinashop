import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import {
  legacyCategory,
  storeProductRule,
  storeProductSpecs,
  storeProductUnit,
  storeProductVirtual,
  systemGroup,
  systemGroupData,
} from "../src/models/schema";
import {
  normalizeProductRuleInput,
  parseProductRuleValue,
} from "../src/services/product/ProductMetadataService";
import { requiredAdminPermission } from "../src/services/admin/AdminPermissionService";

describe("product metadata and system group migration", () => {
  it("preserves all seven source table contracts without merging their semantics", () => {
    expect(getTableName(legacyCategory)).toBe("category");
    expect(Object.keys(getTableColumns(legacyCategory))).toEqual([
      "id", "pid", "type", "relationId", "ownerId", "name", "sort", "group",
      "other", "isShow", "addTime", "integralMin", "integralMax",
    ]);
    expect(Object.keys(getTableColumns(storeProductUnit))).toEqual([
      "id", "type", "relationId", "name", "sort", "status", "isDel", "addTime",
    ]);
    expect(Object.keys(getTableColumns(storeProductRule))).toEqual([
      "id", "type", "relationId", "ruleName", "ruleValue",
    ]);
    expect(Object.keys(getTableColumns(storeProductSpecs))).toEqual([
      "id", "type", "relationId", "tempId", "name", "value", "sort", "status", "addTime",
    ]);
    expect(Object.keys(getTableColumns(storeProductVirtual))).toEqual([
      "id", "productId", "storeId", "attrUnique", "cardNo", "cardPwd", "cardUnique",
      "orderId", "orderType", "uid",
    ]);
    expect(Object.keys(getTableColumns(systemGroup))).toEqual([
      "id", "cateId", "name", "info", "configName", "fields",
    ]);
    expect(Object.keys(getTableColumns(systemGroupData))).toEqual([
      "id", "gid", "value", "addTime", "sort", "status",
    ]);
  });

  it("registers deterministic keys and explicit preservation boundaries", () => {
    for (const table of [
      "category",
      "store_product_unit",
      "store_product_rule",
      "store_product_specs",
      "store_product_virtual",
      "system_group",
      "system_group_data",
    ]) {
      expect(MIGRATION_TABLES.find((entry) => entry.table === table)?.key).toEqual(["id"]);
    }
    expect(MIGRATION_TABLES.find((entry) => entry.table === "category")?.note).toContain(
      "do not merge",
    );
    expect(MIGRATION_TABLES.find((entry) => entry.table === "store_product_virtual")?.note)
      .toContain("payment-outbox transaction");
  });

  it("normalizes new SKU templates while retaining safe reads of historical JSON", () => {
    expect(parseProductRuleValue("not-json")).toEqual([]);
    expect(parseProductRuleValue('[{"value":"颜色","detail":["红","蓝"]}]')).toEqual([
      { value: "颜色", detail: ["红", "蓝"] },
    ]);
    expect(normalizeProductRuleInput([
      { value: "颜色", detail: ["红", "蓝"] },
      { value: "尺寸", detail: ["M", "L"] },
    ])).toHaveLength(2);
    expect(() => normalizeProductRuleInput([
      { value: "颜色", detail: ["红"] },
      { value: "颜色", detail: ["蓝"] },
    ])).toThrow("规格名称不能重复");
    expect(() => normalizeProductRuleInput([
      { value: "颜色", detail: ["红", "红"] },
    ])).toThrow("规格值不能重复");
  });

  it("restores admin/supplier aliases with ownership isolation and no card-secret endpoint", () => {
    const service = readFileSync("src/services/product/ProductMetadataService.ts", "utf8");
    const supplierRoutes = readFileSync("src/routes/supplierapi.ts", "utf8");
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    const permissions = readFileSync("src/services/admin/AdminPermissionService.ts", "utf8");

    expect(service).toContain("readableUnitScope(owner)");
    expect(service).toContain("readableTemplateScope(owner)");
    expect(service).toContain("ownedRuleScope(owner)");
    expect(service).toContain("inArray(storeProductSpecs.tempId");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).not.toContain("storeProductVirtual.cardNo");
    expect(service).not.toContain("storeProductVirtual.cardPwd");

    expect(supplierRoutes).toContain('"/product/get_all_unit"');
    expect(supplierRoutes).toContain('"/product/all_specs"');
    expect(supplierRoutes).toContain('"/product/product/get_rule"');
    expect(supplierRoutes).toContain('"/product/product/rule/delete/:id"');
    expect(adminRoutes).toContain('"/get_all_unit"');
    expect(adminRoutes).toContain('"/specs/:id"');
    expect(adminRoutes).toContain('"/product/rule/:id"');
    expect(permissions).toContain('"get_all_unit"');
    expect(permissions).toContain('"all_specs"');
    expect(requiredAdminPermission("GET", "/adminapi/get_all_unit")).toBe("product.view");
    expect(requiredAdminPermission("POST", "/adminapi/specs/:id")).toBe("product.manage");
    expect(requiredAdminPermission("DELETE", "/api/admin/unit/:id")).toBe("product.manage");
  });
});
