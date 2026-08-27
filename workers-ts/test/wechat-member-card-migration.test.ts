import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { userCard, userEnter, wechatCard } from "@/models/schema";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";
import { MIGRATION_MANIFEST_VERSION, MIGRATION_TABLES } from "../scripts/data-migration/manifest";

describe("official-account member-card migration boundary", () => {
  it("defines all three remaining source tables with source-shaped columns", () => {
    expect([userEnter, wechatCard, userCard].map(getTableName)).toEqual([
      "user_enter", "wechat_card", "user_card",
    ]);
    expect(Object.keys(getTableColumns(userEnter))).toEqual([
      "id", "uid", "province", "city", "district", "address", "merchantName",
      "linkUser", "linkTel", "charter", "addTime", "applyTime", "successTime",
      "failMessage", "failTime", "status", "isLock", "isDel",
    ]);
    expect(Object.keys(getTableColumns(wechatCard))).toEqual([
      "id", "cardId", "cardType", "codeType", "brandName", "title", "color",
      "notice", "description", "centerTitle", "centerSubTitle", "centerUrl",
      "servicePhone", "logoUrl", "backgroundPicUrl", "prerogative", "especial",
      "status", "isDel", "addTime",
    ]);
    expect(Object.keys(getTableColumns(userCard))).toEqual([
      "id", "uid", "spreadUid", "wechatCardId", "cardId", "code", "storeId",
      "staffId", "openid", "isSubmit", "submitTime", "isDel", "delTime", "addTime",
    ]);
  });

  it("preserves only the source user_enter uid uniqueness", () => {
    expect(getTableConfig(userEnter).indexes.filter((index) => index.config.unique)).toHaveLength(1);
    expect(getTableConfig(wechatCard).indexes.filter((index) => index.config.unique)).toHaveLength(0);
    expect(getTableConfig(userCard).indexes.filter((index) => index.config.unique)).toHaveLength(0);
  });

  it("adds deterministic manifest cursors and records the historical boundaries", () => {
    const manifest = new Map(MIGRATION_TABLES.map((entry) => [entry.table, entry]));
    expect(manifest.get("user_enter")?.key).toEqual(["id"]);
    expect(manifest.get("user_enter")?.note).toContain("system_user_apply");
    expect(manifest.get("wechat_card")?.key).toEqual(["id"]);
    expect(manifest.get("wechat_card")?.note).toContain("read-only history");
    expect(manifest.get("user_card")?.key).toEqual(["id"]);
    expect(manifest.get("user_card")?.note).toContain("masked admin diagnostics");
    expect(MIGRATION_MANIFEST_VERSION).toBe("2026-08-11.57");
  });

  it("keeps external 0077 and embedded 0084 SQL exactly equivalent", () => {
    const migration = readFileSync("migrations/0077_wechat_member_card.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(
      /private migration_0084\(\): string \{\s*return `([\s\S]*?)`;\s*\}/,
    )?.[1]?.trim();
    expect(embedded).toBe(migration);
    expect((migration.match(/CREATE TABLE IF NOT EXISTS/g) ?? [])).toHaveLength(3);
    expect((migration.match(/CREATE UNIQUE INDEX IF NOT EXISTS/g) ?? [])).toHaveLength(1);
    expect(migration).not.toMatch(/FOREIGN KEY\s*\(|REFERENCES\s+"/i);
    expect(migration).not.toMatch(/\bINSERT\s+INTO\b/i);
  });

  it("exposes only masked Admin diagnostics and returns 501 for remote writes", () => {
    const routes = readFileSync("src/routes/adminapi.ts", "utf8");
    const publicRoutes = readFileSync("src/routes/v1/index.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/AdminWechatMemberCardController.ts", "utf8");
    const service = readFileSync("src/services/wechat/WechatMemberCardCatalogService.ts", "utf8");
    expect(routes).toContain('adminapiRoutes.get("/wechat/card", adminAuth, AdminWechatMemberCard.cards)');
    expect(routes).toContain('adminapiRoutes.get("/wechat/card/users", adminAuth, AdminWechatMemberCard.claims)');
    expect(routes).toContain('adminapiRoutes.post("/wechat/card", adminAuth, AdminWechatMemberCard.remoteWriteUnavailable)');
    expect(controller).toContain("not_migrated_requires_idempotent_outbox");
    expect(controller).toContain("501");
    expect(service).toContain('pii_display: "masked"');
    expect(service).toContain("remote_card_id_masked");
    expect(service).toContain("code_masked");
    expect(service).toContain("openid_masked");
    expect(service).not.toMatch(/\bfetch\s*\(/);
    expect(publicRoutes).not.toMatch(/\/?wechat\/card/);
  });

  it("uses a dedicated permission domain for reads and the closed write placeholder", () => {
    expect(requiredAdminPermission("GET", "/adminapi/wechat/card")).toBe("wechat_member_card.view");
    expect(requiredAdminPermission("GET", "/adminapi/wechat/card/users")).toBe("wechat_member_card.view");
    expect(requiredAdminPermission("POST", "/adminapi/wechat/card")).toBe("wechat_member_card.manage");
  });

  it("wires a responsive previewable Admin catalog without mutation controls", () => {
    const router = readFileSync("../view/admin-ts/src/router/index.ts", "utf8");
    const layout = readFileSync("../view/admin-ts/src/layouts/AdminLayout.vue", "utf8");
    const api = readFileSync("../view/admin-ts/src/api/wechatMemberCard.ts", "utf8");
    const page = readFileSync("../view/admin-ts/src/pages/content/WechatMemberCard.vue", "utf8");
    expect(router).toContain('path: "content/wechat-card"');
    expect(layout).toContain('index="/content/wechat-card"');
    expect(api).toContain('get("/wechat/card/summary")');
    expect(page).toContain("远端制卡、激活和回调写入保持关闭");
    expect(page).toContain("mobile-list");
    expect(page).toContain("system_user_apply");
    expect(page).not.toMatch(/(?:新增|编辑|删除|创建|激活)[^<]{0,20}<\/el-button>/);
  });
});
