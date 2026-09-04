import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Status = "candidate" | "partial" | "missing" | "retired";
interface ProductRouteAudit {
  summary: Record<"legacyRoutes" | Status, number>;
  routes: Array<{
    legacyPath: string;
    status: Status;
    newScreens: string[];
    newApiContracts: string[];
    covered: string;
    remaining: string;
  }>;
}

const audit = JSON.parse(
  readFileSync("audit/admin-legacy-product-route-parity.json", "utf8"),
) as ProductRouteAudit;

describe("legacy Admin product screen parity", () => {
  it("accounts for all twelve active legacy product routes without title-only coverage", () => {
    expect(audit.routes.map((row) => row.legacyPath)).toEqual([
      "/admin/product/product_list",
      "/admin/product/product_classify",
      "/admin/product/add_product/:id?",
      "/admin/product/product_reply/:id?",
      "/admin/product/product_attr",
      "/admin/product/product_brand",
      "/admin/product/unitList",
      "/admin/product/label",
      "/admin/product/specs",
      "/admin/product/ensure",
      "/admin/product/ensure/create/:id?",
      "/admin/product/hotWords",
    ]);
    expect(audit.summary).toEqual({
      legacyRoutes: 12,
      candidate: 6,
      partial: 6,
      missing: 0,
      retired: 0,
    });
    for (const status of ["candidate", "partial", "missing", "retired"] as const) {
      expect(audit.routes.filter((row) => row.status === status)).toHaveLength(audit.summary[status]);
    }
    for (const row of audit.routes) {
      expect(row.covered.length).toBeGreaterThan(20);
      expect(row.remaining.length).toBeGreaterThan(20);
      if (row.status === "missing") {
        expect(row.newScreens).toEqual([]);
        expect(row.newApiContracts).toEqual([]);
      } else {
        expect(row.newScreens.length).toBeGreaterThan(0);
        expect(row.newApiContracts.length).toBeGreaterThan(0);
      }
    }
  });

  it("connects Admin SKU specification-template CRUD to the scoped service", () => {
    const page = readFileSync("../view/admin-ts/src/pages/product/ProductMetadata.vue", "utf8");
    const api = readFileSync("../view/admin-ts/src/api/productMetadata.ts", "utf8");
    const routes = readFileSync("src/routes/adminapi.ts", "utf8");
    const service = readFileSync("src/services/product/ProductMetadataService.ts", "utf8");

    expect(page).toContain('label="SKU 规格模板"');
    expect(page).toContain("规格模板用于颜色、尺码等 SKU 维度");
    expect(page).toContain("最多支持 3 个规格维度");
    expect(api).toContain('request.get("/product/rule"');
    expect(api).toContain("request.get(`/product/rule/${id}`)");
    expect(api).toContain("request.post(`/product/rule/${id}`");
    expect(api).toContain("request.delete(`/product/rule/delete/${id}`)");
    expect(routes).toContain('get("/product/rule"');
    expect(routes).toContain('post("/product/rule/:id"');
    expect(service).toContain("ownedRuleScope(owner)");
    expect(service).toContain("pg_advisory_xact_lock(${RULE_LOCK_NAMESPACE}");
    expect(service).toContain("商品规格维度需为1至3项");
  });

  it("keeps product parameter templates distinct and transactionally replaces their rows", () => {
    const page = readFileSync("../view/admin-ts/src/pages/product/ProductMetadata.vue", "utf8");
    const api = readFileSync("../view/admin-ts/src/api/productMetadata.ts", "utf8");
    const routes = readFileSync("src/routes/adminapi.ts", "utf8");
    const service = readFileSync("src/services/product/ProductMetadataService.ts", "utf8");

    expect(page).toContain('label="商品参数模板"');
    expect(page).toContain("不参与 SKU 价格与库存组合");
    expect(page).toContain("最多支持 100 个参数");
    expect(api).toContain('request.get("/specs"');
    expect(api).toContain("request.get(`/specs/${id}`)");
    expect(api).toContain("request.post(`/specs/${id}`");
    expect(api).toContain("request.delete(`/specs/${id}`)");
    expect(routes).toContain('get("/specs"');
    expect(routes).toContain('post("/specs/:id"');
    expect(service).toContain("PARAMETER_TEMPLATE_GROUP = 3");
    expect(service).toContain("pg_advisory_xact_lock(${SPECS_LOCK_NAMESPACE}");
    expect(service).toContain("await tx.delete(storeProductSpecs)");
    expect(service).toContain("await tx.insert(storeProductSpecs)");
  });

  it("counts search words only after owner-scoped API and responsive UI parity exist", () => {
    const hotWords = audit.routes.find((row) => row.legacyPath === "/admin/product/hotWords");
    const page = readFileSync("../view/admin-ts/src/pages/product/ProductMetadata.vue", "utf8");
    const schema = readFileSync("src/models/schema/words.ts", "utf8");
    const routes = readFileSync("src/routes/adminapi.ts", "utf8");
    const service = readFileSync("src/services/product/ProductWordsService.ts", "utf8");
    expect(hotWords?.status).toBe("candidate");
    expect(schema).toContain('"store_product_words"');
    expect(page).toContain('label="搜索热词"');
    expect(routes).toContain('get("/product/words"');
    expect(service).toContain("platformScope()");
    expect(service).toContain("isDel: 1, isShow: 0, isHot: 0");
  });

  it("does not keep implemented product batch operations in the remaining-gap narrative", () => {
    const productList = audit.routes.find((row) => row.legacyPath === "/admin/product/product_list");
    expect(productList?.covered).toContain("delivery");
    expect(productList?.covered).toContain("gift/coupon");
    expect(productList?.covered).toContain("freight-template");
    expect(productList?.covered).toContain("brand replacement");
    expect(productList?.remaining).not.toContain("Legacy batch types");
    expect(productList?.remaining).toContain("non-platform SKU lifecycle");
  });
});
