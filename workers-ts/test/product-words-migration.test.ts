import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRODUCT_WORDS_INDEX_SQL } from "../src/migrations/productWordsIndexes";
import {
  normalizeProductWordColor,
  normalizeProductWordIcon,
  normalizeProductWordName,
} from "../src/services/product/ProductWordsService";
import { requiredAdminPermission } from "../src/services/admin/AdminPermissionService";

describe("platform search-word migration", () => {
  it("normalizes the legacy fields without accepting executable assets or unbounded values", () => {
    expect(normalizeProductWordName("  新品上市  ")).toBe("新品上市");
    expect(normalizeProductWordName("123456789012345")).toBe("123456789012345");
    expect(() => normalizeProductWordName("1234567890123456")).toThrow("15");
    expect(normalizeProductWordColor("rgba(64, 158, 255, 0.35)", "背景颜色"))
      .toBe("rgba(64, 158, 255, 0.35)");
    expect(() => normalizeProductWordColor("rgb(256, 0, 0)", "文字颜色")).toThrow("255");
    expect(normalizeProductWordIcon("/uploads/words/new.svg")).toBe("/uploads/words/new.svg");
    expect(normalizeProductWordIcon("https://cdn.example.test/new.svg"))
      .toBe("https://cdn.example.test/new.svg");
    expect(() => normalizeProductWordIcon("javascript:alert(1)")).toThrow("HTTPS");
    expect(() => normalizeProductWordIcon("http://cdn.example.test/new.svg")).toThrow("HTTPS");
  });

  it("registers all six authenticated legacy contracts with product permissions", () => {
    const adminapi = readFileSync("src/routes/adminapi.ts", "utf8");
    const v1 = readFileSync("src/routes/v1/index.ts", "utf8");
    for (const route of [
      'get("/product/words"',
      'get("/product/words/get_all"',
      'get("/product/words/:id"',
      'post("/product/words/:id"',
      'put(\n  "/product/words/set_show/:id/:is_show"',
      'delete("/product/words/:id"',
    ]) expect(adminapi).toContain(route);
    expect(v1).toContain('get("/admin/product/words"');
    expect(requiredAdminPermission("GET", "/adminapi/product/words")).toBe("product.view");
    expect(requiredAdminPermission("POST", "/adminapi/product/words/0")).toBe("product.manage");
    expect(requiredAdminPermission("PUT", "/api/admin/product/words/set_show/1/1"))
      .toBe("product.manage");
    expect(requiredAdminPermission("DELETE", "/api/admin/product/words/1"))
      .toBe("product.manage");
  });

  it("uses owner-scoped soft-delete services, bounded writes, and same-transaction audit evidence", () => {
    const service = readFileSync("src/services/product/ProductWordsService.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/AdminProductWordsController.ts", "utf8");
    const publicController = readFileSync("src/controllers/api/v1/PublicController.ts", "utf8");
    expect(service).toContain("eq(storeProductWords.type, PLATFORM_TYPE)");
    expect(service).toContain("eq(storeProductWords.relationId, PLATFORM_RELATION_ID)");
    expect(service).toContain("eq(storeProductWords.isDel, 0)");
    expect(service).toContain("icon: safeStoredIcon(row.icon)");
    expect(service).toContain("pg_advisory_xact_lock(${WORDS_LOCK_NAMESPACE}");
    expect(service).toContain("isDel: 1, isShow: 0, isHot: 0");
    expect(service).toContain("await writeAudit(tx, actor");
    expect(service).not.toContain(".delete(storeProductWords)");
    expect(controller).toContain("readBoundedJsonObject(c.req.raw, MAX_BODY_BYTES)");
    expect(controller).toContain('c.header("Cache-Control", "private, no-store")');
    expect(publicController).toContain("ProductWordsService(c.get(\"container\")).publicKeywords()");
    expect(publicController).not.toContain("storeProductWords.isHot");
  });

  it("keeps the physical and embedded scoped indexes identical", () => {
    const external = readFileSync("migrations/0125_product_words_indexes.sql", "utf8");
    const migrationService = readFileSync("src/services/MigrationService.ts", "utf8");
    expect(external.trim()).toBe(PRODUCT_WORDS_INDEX_SQL.trim());
    expect(external).toContain('"spw_owner_active_sort"');
    expect(external).toContain('WHERE "type" = 0 AND "relation_id" = 0');
    expect(migrationService).toContain("this.migration_0131()");
    expect(migrationService).toContain("return PRODUCT_WORDS_INDEX_SQL");
  });

  it("connects responsive Admin CRUD and public-visibility controls", () => {
    const page = readFileSync("../view/admin-ts/src/pages/product/ProductMetadata.vue", "utf8");
    const api = readFileSync("../view/admin-ts/src/api/productMetadata.ts", "utf8");
    expect(page).toContain('label="搜索热词"');
    expect(page).toContain("这里只管理平台热词");
    expect(page).toContain("show-alpha");
    expect(page).toContain("setWordStatus(row, Number($event))");
    expect(page).toContain("@media (max-width: 720px)");
    expect(api).toContain('request.get("/product/words"');
    expect(api).toContain("request.post(`/product/words/${id}`");
    expect(api).toContain("request.put(`/product/words/set_show/${id}/${isShow}`");
    expect(api).toContain("request.delete(`/product/words/${id}`)");
  });
});
