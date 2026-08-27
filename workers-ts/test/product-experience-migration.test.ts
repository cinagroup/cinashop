import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import {
  storeProductEnsure,
  storeProductLog,
  storeVisit,
} from "../src/models/schema";
import { requiredAdminPermission } from "../src/services/admin/AdminPermissionService";
import {
  normalizeProductExperienceIds,
  productVisitTimeKey,
} from "../src/services/product/ProductExperienceService";

describe("product assurance and visit analytics migration", () => {
  it("preserves all source columns and primary keys for the three active tables", () => {
    expect(getTableName(storeProductEnsure)).toBe("store_product_ensure");
    expect(Object.keys(getTableColumns(storeProductEnsure))).toEqual([
      "id", "type", "relationId", "name", "image", "desc", "sort", "status", "addTime",
    ]);
    expect(getTableName(storeProductLog)).toBe("store_product_log");
    expect(Object.keys(getTableColumns(storeProductLog))).toEqual([
      "id", "type", "productId", "uid", "visitNum", "cartNum", "orderNum", "payNum",
      "payPrice", "costPrice", "payUid", "refundNum", "refundPrice", "collectNum",
      "addTime", "deleteTime",
    ]);
    expect(getTableName(storeVisit)).toBe("store_visit");
    expect(Object.keys(getTableColumns(storeVisit))).toEqual([
      "id", "productId", "productType", "cateId", "type", "uid", "count", "content", "addTime",
    ]);
    for (const table of ["store_product_ensure", "store_product_log", "store_visit"]) {
      expect(MIGRATION_TABLES.find((entry) => entry.table === table)?.key).toEqual(["id"]);
    }
  });

  it("does not invent uniqueness for historical visit aggregates", () => {
    const migration = readFileSync(
      "migrations/0054_product_assurance_and_visit_analytics.sql",
      "utf8",
    );
    expect(migration).not.toContain("CREATE UNIQUE INDEX");
    expect(migration).toContain('ON "store_visit" ("uid", "product_id", "product_type", "id")');
    expect(migration).toContain('"delete_time" TIMESTAMP');
  });

  it("normalizes legacy CSV and JSON id lists without accepting unsafe values", () => {
    expect(normalizeProductExperienceIds("3,2,3")).toEqual([3, 2]);
    expect(normalizeProductExperienceIds("[4,5,4]")).toEqual([4, 5]);
    expect(normalizeProductExperienceIds([6, "7"])).toEqual([6, 7]);
    expect(() => normalizeProductExperienceIds("1,-2")).toThrow("ID列表格式错误");
    expect(() => normalizeProductExperienceIds([Number.MAX_SAFE_INTEGER + 1])).toThrow("ID列表格式错误");
  });

  it("groups visit dates with the PHP current-year display contract in Shanghai time", () => {
    const current = Date.parse("2026-08-10T12:00:00+08:00") / 1000;
    const sameYear = Date.parse("2026-01-02T01:00:00+08:00") / 1000;
    const priorYear = Date.parse("2025-12-31T23:59:00+08:00") / 1000;
    expect(productVisitTimeKey(sameYear, current)).toBe("01月02日");
    expect(productVisitTimeKey(priorYear, current)).toBe("2025年12月31日");
  });

  it("restores product assurance, supplier choice and user visit routes under existing ACLs", () => {
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    const publicRoutes = readFileSync("src/routes/v1/index.ts", "utf8");
    const supplierRoutes = readFileSync("src/routes/supplierapi.ts", "utf8");
    for (const routes of [adminRoutes, publicRoutes]) {
      expect(routes).toContain('/product/ensure"');
      expect(routes).toContain('/product/ensure/set_show/:id/:is_show"');
    }
    expect(publicRoutes).toContain('/user/visit_list"');
    expect(publicRoutes).toContain('/user/visit"');
    expect(supplierRoutes).toContain('/product/all_ensure"');
    expect(requiredAdminPermission("GET", "/adminapi/product/ensure")).toBe("product.view");
    expect(requiredAdminPermission("PUT", "/api/admin/product/ensure/1")).toBe("product.manage");
  });

  it("records visits with a scope lock and keeps product assurance outside stale detail cache", () => {
    const experience = readFileSync("src/services/product/ProductExperienceService.ts", "utf8");
    const product = readFileSync("src/services/product/StoreProductService.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/ProductController.ts", "utf8");
    expect(experience).toContain("pg_advisory_xact_lock");
    expect(experience).toContain('.for("update")');
    expect(experience).toContain("existing[0].addTime + VISIT_THROTTLE_SECONDS < now");
    expect(experience).toContain("eq(storeProductLog.type, \"visit\")");
    expect(product).toContain("delete cacheable.ensure");
    expect(controller).toContain("c.executionCtx.waitUntil");
    expect(controller).toContain(".recordVisit(uid, id, id)");
  });
});
