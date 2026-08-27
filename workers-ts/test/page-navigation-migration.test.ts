import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { pageCategory, pageLink } from "@/models/schema";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";
import {
  buildPageCategoryTree,
  normalizePageLinkInput,
} from "@/services/content/PageNavigationService";
import { MIGRATION_MANIFEST_VERSION, MIGRATION_TABLES } from "../scripts/data-migration/manifest";

describe("page navigation migration", () => {
  it("preserves both source-shaped tables and stable migration keys", () => {
    expect(getTableName(pageCategory)).toBe("page_category");
    expect(getTableName(pageLink)).toBe("page_link");
    expect(Object.keys(getTableColumns(pageCategory))).toEqual([
      "id", "pid", "type", "name", "sort", "status", "addTime",
    ]);
    expect(Object.keys(getTableColumns(pageLink))).toEqual([
      "id", "cateId", "type", "name", "url", "param", "example", "status", "sort", "addTime",
    ]);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "page_category")?.key).toEqual(["id"]);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "page_link")?.key).toEqual(["id"]);
    expect(MIGRATION_MANIFEST_VERSION).toBe("2026-08-11.57");
  });

  it("keeps external 0069 and embedded 0076 SQL exactly equivalent", () => {
    const migration = readFileSync("migrations/0069_page_navigation.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(
      /private migration_0076\(\): string \{\s*return `([\s\S]*?)`;\s*\}/,
    )?.[1]?.trim();
    expect(embedded).toBe(migration);
    expect(migration).not.toMatch(/FOREIGN KEY\s*\(|REFERENCES\s+"|CREATE UNIQUE INDEX/i);
    expect(migration.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(2);
    expect(migration).toContain('("pid", "sort" DESC, "id" ASC)');
    expect(migration).toContain('("cate_id", "sort" DESC, "id" ASC)');
  });

  it("builds the PHP-shaped pid=0 tree and omits disconnected cycles", () => {
    const tree = buildPageCategoryTree([
      { id: 1, pid: 0, type: "link", name: "商城页面" },
      { id: 2, pid: 1, type: "link", name: "商城链接" },
      { id: 3, pid: 99, type: "custom", name: "孤立分类" },
      { id: 4, pid: 5, type: "custom", name: "循环甲" },
      { id: 5, pid: 4, type: "custom", name: "循环乙" },
    ]);
    expect(tree).toEqual([
      {
        id: 1,
        pid: 0,
        type: "link",
        name: "商城页面",
        title: "商城页面",
        expand: true,
        children: [
          {
            id: 2,
            pid: 1,
            type: "link",
            name: "商城链接",
            title: "商城链接",
            expand: true,
            children: [],
          },
        ],
      },
    ]);
  });

  it("registers source-compatible routes under the existing DIY permission domain", () => {
    const routes = readFileSync("src/routes/adminapi.ts", "utf8");
    expect(routes).toContain('adminapiRoutes.get("/diy/get_page_category"');
    expect(routes).toContain('adminapiRoutes.get("/diy/get_page_link/:cate_id"');
    expect(routes).toContain('adminapiRoutes.post("/diy/save_link/:cate_id"');
    expect(routes).toContain('adminapiRoutes.delete("/diy/del_link/:id"');
    expect(requiredAdminPermission("GET", "/adminapi/diy/get_page_category")).toBe("dise.view");
    expect(requiredAdminPermission("POST", "/adminapi/diy/save_link/:cate_id")).toBe("dise.manage");
    expect(requiredAdminPermission("DELETE", "/adminapi/diy/del_link/:id")).toBe("dise.manage");
  });

  it("normalizes custom links and rejects executable or malformed values", () => {
    expect(normalizePageLinkInput({ name: " 官网 ", url: " https://example.com/shop " }))
      .toEqual({ name: "官网", url: "https://example.com/shop" });
    expect(() => normalizePageLinkInput({ name: "脚本", url: "javascript:alert(1)" }))
      .toThrow("页面链接协议不安全");
    expect(() => normalizePageLinkInput({ name: "控制字符", url: "/pages/\u0000shop" }))
      .toThrow("页面链接包含非法控制字符");
    expect(() => normalizePageLinkInput({ name: "", url: "/pages/index" }))
      .toThrow("请输入页面名称");
  });

  it("keeps request bodies bounded and page-category reads status-agnostic", () => {
    const controller = readFileSync("src/controllers/api/v1/PageNavigationController.ts", "utf8");
    const service = readFileSync("src/services/content/PageNavigationService.ts", "utf8");
    expect(controller).toContain("const MAX_BODY_BYTES = 8 * 1024");
    expect(controller).toContain("total > MAX_BODY_BYTES");
    expect(controller).toContain('application/x-www-form-urlencoded');
    expect(service).not.toContain("eq(pageCategory.status");
    expect(service).toContain('inArray(systemDise.type, [1, 2])');
    expect(service).toContain("eq(storeProductCategory.relationId, 0)");
    expect(service).toContain("eq(storeProductCategory.isShow, 1)");
  });
});
