import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import { userGroup, userLabelRelation } from "../src/models/schema";
import { requiredAdminPermission } from "../src/services/admin/AdminPermissionService";
import { normalizeSegmentationIds } from "../src/services/user/UserSegmentationService";

describe("user segmentation migration", () => {
  it("preserves the source group and label-relation table contracts", () => {
    expect(getTableName(userGroup)).toBe("user_group");
    expect(Object.keys(getTableColumns(userGroup))).toEqual(["id", "groupName"]);
    expect(getTableName(userLabelRelation)).toBe("user_label_relation");
    expect(Object.keys(getTableColumns(userLabelRelation))).toEqual([
      "id",
      "uid",
      "type",
      "relationId",
      "labelId",
    ]);
  });

  it("registers deterministic keys without inventing historical uniqueness", () => {
    const group = MIGRATION_TABLES.find((entry) => entry.table === "user_group");
    const relation = MIGRATION_TABLES.find(
      (entry) => entry.table === "user_label_relation",
    );
    expect(group?.key).toEqual(["id"]);
    expect(group?.note).toContain("deletion is blocked");
    expect(relation?.key).toEqual(["id"]);
    expect(relation?.note).toContain("no composite uniqueness constraint");

    const migration = readFileSync("migrations/0048_user_segmentation.sql", "utf8");
    expect(migration).not.toContain("CREATE UNIQUE INDEX");
    expect(migration).toContain('ON "user_label_relation" ("type", "relation_id", "uid", "id")');
  });

  it("validates, de-duplicates, and sorts user and label IDs", () => {
    expect(normalizeSegmentationIds("3,1,3,2", "ids", 10)).toEqual([1, 2, 3]);
    expect(normalizeSegmentationIds([4, "2"], "ids", 10)).toEqual([2, 4]);
    expect(normalizeSegmentationIds(undefined, "ids", 10)).toEqual([]);
    expect(() => normalizeSegmentationIds("0,1", "ids", 10)).toThrow();
    expect(() => normalizeSegmentationIds([1, 2], "ids", 1)).toThrow();
  });

  it("restores both admin route surfaces with transactional guards and ACL", () => {
    const service = readFileSync("src/services/user/UserSegmentationService.ts", "utf8");
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    const v1Routes = readFileSync("src/routes/v1/index.ts", "utf8");

    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain('.for("update")');
    expect(service).toContain('.for("key share")');
    expect(service).toContain("Historical duplicate relation rows stay in storage");
    expect(service.indexOf(".delete(userLabelRelation)")).toBeLessThan(
      service.indexOf(".delete(userLabel).where(eq(userLabel.id, id))"),
    );

    for (const routes of [adminRoutes, v1Routes]) {
      expect(routes).toContain("/user_group/list");
      expect(routes).toContain("/user_group/save");
      expect(routes).toContain("/user_group/del/:id");
      expect(routes).toContain("/label/:id");
      expect(routes).toContain("/save_set_group");
      expect(routes).toContain("/save_set_label");
    }
    expect(requiredAdminPermission("GET", "/adminapi/user_group/list")).toBe("user.view");
    expect(requiredAdminPermission("POST", "/api/admin/user_group/save")).toBe("user.manage");
    expect(requiredAdminPermission("GET", "/adminapi/label/:id")).toBe("label.view");
    expect(requiredAdminPermission("PUT", "/api/admin/save_set_label")).toBe("label.manage");
  });
});
