import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import {
  storeServiceFeedback,
  storeServiceSpeechcraft,
} from "../src/models/schema";
import { requiredAdminPermission } from "../src/services/admin/AdminPermissionService";
import { escapeCustomerServiceFeedback } from "../src/services/message/CustomerServiceCatalogService";

describe("customer-service feedback and speechcraft migration", () => {
  it("preserves the complete source schemas and primary migration keys", () => {
    expect(getTableName(storeServiceFeedback)).toBe("store_service_feedback");
    expect(Object.keys(getTableColumns(storeServiceFeedback))).toEqual([
      "id", "uid", "relaName", "phone", "content", "make", "status", "addTime",
    ]);
    expect(getTableName(storeServiceSpeechcraft)).toBe("store_service_speechcraft");
    expect(Object.keys(getTableColumns(storeServiceSpeechcraft))).toEqual([
      "id", "kefuId", "cateId", "title", "message", "sort", "addTime",
    ]);
    for (const table of ["store_service_feedback", "store_service_speechcraft"]) {
      expect(MIGRATION_TABLES.find((entry) => entry.table === table)?.key).toEqual(["id"]);
    }
  });

  it("does not invent uniqueness that would discard historical quick replies", () => {
    const migration = readFileSync(
      "migrations/0055_customer_service_feedback_and_speechcraft.sql",
      "utf8",
    );
    expect(migration).not.toContain("CREATE UNIQUE INDEX");
    expect(migration).toContain('"kefu_id" INTEGER DEFAULT 0 NOT NULL');
    expect(migration).toContain('"content" VARCHAR(500) DEFAULT \'\' NOT NULL');
  });

  it("matches PHP htmlspecialchars storage behavior for untrusted feedback", () => {
    expect(escapeCustomerServiceFeedback(`<script a="b">x&'y</script>`)).toBe(
      "&lt;script a=&quot;b&quot;&gt;x&amp;&#039;y&lt;/script&gt;",
    );
    expect(escapeCustomerServiceFeedback("plain text")).toBe("plain text");
  });

  it("restores user, admin and compatibility routes behind the correct ACL", () => {
    const publicRoutes = readFileSync("src/routes/v1/index.ts", "utf8");
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    expect(publicRoutes).toContain('/user/service/feedback"');
    for (const routes of [publicRoutes, adminRoutes]) {
      expect(routes).toContain('/feedback"');
      expect(routes).toContain('/wechat/speechcraft"');
    }
    expect(requiredAdminPermission("GET", "/adminapi/feedback")).toBe("service.view");
    expect(requiredAdminPermission("PUT", "/api/admin/wechat/speechcraft/1")).toBe("service.manage");
  });

  it("serializes new reply writes and enforces owner-scoped category and duplicate checks", () => {
    const service = readFileSync(
      "src/services/message/CustomerServiceCatalogService.ts",
      "utf8",
    );
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain("eq(legacyCategory.ownerId, kefuId)");
    expect(service).toContain("eq(storeServiceSpeechcraft.kefuId, kefuId)");
    expect(service).toContain("话术不能重复添加");
  });
});
