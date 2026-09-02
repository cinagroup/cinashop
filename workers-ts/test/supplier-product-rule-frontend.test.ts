import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { requiredSupplierPermissions } from "@/services/supplier/SupplierPermissionService";
import {
  normalizeProductRuleInput,
  parseProductRuleValue,
} from "@/services/product/ProductMetadataService";

describe("supplier reusable product-rule frontend migration", () => {
  it("keeps historical reads tolerant and new template writes strictly bounded", () => {
    expect(parseProductRuleValue("not-json")).toEqual([]);
    expect(normalizeProductRuleInput([
      { value: "颜色", detail: ["黑色", "白色"] },
      { value: "尺码", detail: ["S", "M"] },
    ])).toHaveLength(2);
    expect(() => normalizeProductRuleInput([])).toThrow("1至3项");
    expect(() => normalizeProductRuleInput([
      { value: "颜色", detail: Array.from({ length: 51 }, (_, index) => String(index)) },
    ])).toThrow("不能超过50个规格值");
  });

  it("mounts all five legacy Supplier contracts behind exact product permissions", () => {
    const routes = readFileSync("src/routes/supplierapi.ts", "utf8");
    for (const route of [
      'get("/product/product/get_rule"',
      'get("/product/product/rule"',
      'post("/product/product/rule/:id"',
      'get("/product/product/rule/:id"',
      '"/product/product/rule/delete/:id"',
    ]) expect(routes).toContain(route);
    expect(requiredSupplierPermissions("GET", "/supplierapi/product/product/get_rule"))
      .toEqual(["supplier.product.view"]);
    expect(requiredSupplierPermissions("GET", "/supplierapi/product/product/rule/12"))
      .toEqual(["supplier.product.view"]);
    expect(requiredSupplierPermissions("POST", "/supplierapi/product/product/rule/0"))
      .toEqual(["supplier.product.manage"]);
    expect(requiredSupplierPermissions("DELETE", "/supplierapi/product/product/rule/delete/12"))
      .toEqual(["supplier.product.manage"]);
  });

  it("scopes list, detail, update and delete to the authenticated Supplier", () => {
    const service = readFileSync("src/services/product/ProductMetadataService.ts", "utf8");
    expect(service).toContain("function ownedRuleScope(owner: MetadataOwner)");
    expect(service).toContain("eq(storeProductRule.type, owner.type)");
    expect(service).toContain("eq(storeProductRule.relationId, owner.relationId)");
    expect(service).toContain("and(eq(storeProductRule.id, id), ownedRuleScope(owner))");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain("duplicateConditions = [ownedRuleScope(owner)");
  });

  it("connects list, detail, save, delete and reusable dropdown clients", () => {
    const api = readFileSync("../view/supplier-ts/src/api/supplier.ts", "utf8");
    expect(api).toContain('url: "/product/product/get_rule"');
    expect(api).toContain('url: "/product/product/rule"');
    expect(api).toContain("url: `/product/product/rule/${id}`");
    expect(api).toContain("url: `/product/product/rule/delete/${id}`");
    expect(api).toContain("previewProductRules");
  });

  it("adds a manage-gated library and explicit destructive ProductForm application", () => {
    const router = readFileSync("../view/supplier-ts/src/router.ts", "utf8");
    const shell = readFileSync("../view/supplier-ts/src/components/AppShell.vue", "utf8");
    const page = readFileSync("../view/supplier-ts/src/pages/ProductSpecifications.vue", "utf8");
    const form = readFileSync("../view/supplier-ts/src/pages/ProductForm.vue", "utf8");
    expect(router).toContain('path: "product-specifications"');
    expect(shell).toContain('{ path: "/product-specifications", label: "规格模板"');
    expect(page).toContain('auth.can("supplier.product.manage")');
    expect(page).toContain('v-if="canManageProducts"');
    expect(page).toContain("await getProductRule(id)");
    expect(form).toContain("getProductRuleTemplates()");
    expect(form).toContain("套用规格模板");
    expect(form).toContain("form.attrs = []");
    expect(form).toContain("regenerateSkus(false)");
  });
});
