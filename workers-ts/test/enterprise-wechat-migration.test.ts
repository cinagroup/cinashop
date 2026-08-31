import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  workChannelCode,
  workChannelCycle,
  workChannelLimit,
  workClient,
  workClientFollow,
  workClientFollowTags,
  workDepartment,
  workGroupChat,
  workGroupChatAuth,
  workGroupChatMember,
  workGroupChatStatistic,
  workGroupMsgRelation,
  workGroupMsgSendResult,
  workGroupMsgTask,
  workGroupTemplate,
  workLabel,
  workMedia,
  workMember,
  workMemberOther,
  workMemberRelation,
  workMoment,
  workMomentSendResult,
  workWelcome,
  workWelcomeRelation,
} from "@/models/schema";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";
import { MIGRATION_MANIFEST_VERSION, MIGRATION_TABLES } from "../scripts/data-migration/manifest";

const tables: PgTable[] = [
  workChannelCode, workChannelCycle, workChannelLimit, workClient, workClientFollow,
  workClientFollowTags, workDepartment, workGroupChat, workGroupChatAuth,
  workGroupChatMember, workGroupChatStatistic, workGroupMsgRelation,
  workGroupMsgSendResult, workGroupMsgTask, workGroupTemplate, workLabel, workMedia,
  workMember, workMemberOther, workMemberRelation, workMoment, workMomentSendResult,
  workWelcome, workWelcomeRelation,
];

describe("Enterprise WeChat migration boundary", () => {
  it("defines all 24 PHP work tables with source-compatible names", () => {
    expect(tables.map(getTableName)).toEqual([
      "work_channel_code", "work_channel_cycle", "work_channel_limit", "work_client",
      "work_client_follow", "work_client_follow_tags", "work_department", "work_group_chat",
      "work_group_chat_auth", "work_group_chat_member", "work_group_chat_statistic",
      "work_group_msg_relation", "work_group_msg_send_result", "work_group_msg_task",
      "work_group_template", "work_label", "work_media", "work_member", "work_member_other",
      "work_member_relation", "work_moment", "work_moment_send_result", "work_welcome",
      "work_welcome_relation",
    ]);
    expect(Object.keys(getTableColumns(workChannelCycle))).toEqual([
      "channelId", "userids", "startTime", "endTime", "wokrTime",
    ]);
    expect(Object.keys(getTableColumns(workClientFollow))).toContain("createtime");
    expect(Object.keys(getTableColumns(workDepartment))).toContain("srot");
    expect(Object.keys(getTableColumns(workMemberRelation))).toContain("srot");
    expect(Object.keys(getTableColumns(workMember))).toEqual([
      "id", "corpId", "userid", "uid", "name", "position", "mobile", "gender", "email",
      "bizMail", "directLeader", "avatar", "thumbAvatar", "telephone", "alias", "enable",
      "isLeader", "hideMobile", "address", "openUserid", "mainDepartment", "status",
      "qrCode", "externalPosition", "createTime", "updateTime",
    ]);
  });

  it("preserves keyless source multisets while guarding canonical active callback identities", () => {
    const noStableKey = [
      workChannelCycle, workChannelLimit, workClientFollowTags, workGroupMsgRelation,
      workMemberRelation, workWelcomeRelation,
    ];
    for (const table of noStableKey) {
      const config = getTableConfig(table);
      expect(config.primaryKeys).toHaveLength(0);
      expect(config.uniqueConstraints).toHaveLength(0);
      expect(config.indexes.filter((index) => index.config.unique)).toHaveLength(0);
    }
    expect(getTableConfig(workMember).indexes.filter((index) => index.config.unique)).toHaveLength(1);
    expect(getTableConfig(workMemberOther).indexes.filter((index) => index.config.unique)).toHaveLength(1);
    expect(getTableConfig(workClient).indexes.filter((index) => index.config.unique)
      .map((index) => index.config.name)).toEqual(["work_client_active_identity_uq"]);
    expect(getTableConfig(workClientFollow).indexes.filter((index) => index.config.unique)
      .map((index) => index.config.name)).toEqual(["work_client_follow_active_identity_uq"]);
  });

  it("uses safe cursors and duplicate-preserving strategies for the six keyless relations", () => {
    const manifest = new Map(MIGRATION_TABLES.map((entry) => [entry.table, entry]));
    for (const table of tables) expect(manifest.has(getTableName(table))).toBe(true);
    for (const table of [
      "work_channel_cycle", "work_channel_limit", "work_client_follow_tags",
      "work_group_msg_relation", "work_member_relation", "work_welcome_relation",
    ]) {
      expect(manifest.get(table)?.key).toEqual([]);
      expect(manifest.get(table)?.copyStrategy).toBe("append_multiset");
      expect(manifest.get(table)?.note).toMatch(/multiset/i);
    }
    expect(manifest.get("work_member")?.key).toEqual(["id"]);
    expect(manifest.get("work_member_other")?.key).toEqual(["member_id"]);
    expect(MIGRATION_MANIFEST_VERSION).toBe("2026-08-11.57");
  });

  it("keeps external 0076 and embedded 0083 SQL exactly equivalent", () => {
    const migration = readFileSync("migrations/0076_enterprise_wechat.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(
      /private migration_0083\(\): string \{\s*return `([\s\S]*?)`;\s*\}/,
    )?.[1]?.trim();
    expect(embedded).toBe(migration);
    expect((migration.match(/CREATE TABLE IF NOT EXISTS "work_/g) ?? [])).toHaveLength(24);
    expect((migration.match(/CREATE UNIQUE INDEX IF NOT EXISTS/g) ?? [])).toHaveLength(2);
    expect(migration).not.toMatch(/FOREIGN KEY\s*\(|REFERENCES\s+"/i);
    expect(migration).not.toMatch(/\bINSERT\s+INTO\b/i);
  });

  it("exposes fail-closed Work reads while limiting writes to callback ingress and context bootstrap", () => {
    const routes = readFileSync("src/routes/adminapi.ts", "utf8");
    const publicRoutes = readFileSync("src/routes/v1/index.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/AdminEnterpriseWechatController.ts", "utf8");
    const service = readFileSync("src/services/work/EnterpriseWechatCatalogService.ts", "utf8");
    for (const path of [
      "/work/summary", "/work/tree", "/work/member", "/work/client", "/work/group_chat",
      "/work/channel_code", "/work/group_template", "/work/moment", "/work/welcome",
    ]) expect(routes).toContain(path);
    expect(routes).toContain('adminapiRoutes.get("/work/client/synch", adminAuth, AdminEnterpriseWechat.remoteWriteUnavailable)');
    expect(routes).toContain('adminapiRoutes.post("/work/synchMember", adminAuth, AdminEnterpriseWechat.remoteWriteUnavailable)');
    expect(controller).toContain("not_migrated_requires_idempotent_outbox");
    expect(controller).toContain("501");
    expect(service).toContain('pii_display: "masked"');
    expect(service).not.toMatch(/\bfetch\s*\(/);
    expect(publicRoutes).toContain('v1Routes.get("/work/config", EnterpriseWechatController.config)');
    expect(publicRoutes).toContain('v1Routes.get("/work/agentConfig", EnterpriseWechatController.agentConfig)');
    const workMutations = [...publicRoutes.matchAll(
      /v1Routes\.(post|put|patch|delete|all)\("(\/work[^"?]*)"/g,
    )].map((match) => `${match[1]} ${match[2]}`);
    expect(workMutations).toEqual([
      "all /work/serve",
      "post /work/context/challenge",
      "post /work/context/exchange",
    ]);
  });

  it("protects reads, action decisions, and remote-write placeholders with dedicated permissions", () => {
    expect(requiredAdminPermission("GET", "/adminapi/work/summary")).toBe("enterprise_wechat.view");
    expect(requiredAdminPermission("GET", "/adminapi/work/contact_action")).toBe("enterprise_wechat.view");
    expect(requiredAdminPermission("POST", "/adminapi/work/contact_action/123/decision")).toBe("enterprise_wechat.manage");
    expect(requiredAdminPermission("GET", "/adminapi/work/client/synch")).toBe("enterprise_wechat.manage");
    expect(requiredAdminPermission("POST", "/adminapi/work/welcome")).toBe("enterprise_wechat.manage");
  });

  it("wires a responsive Admin catalog with only the audited action decision control", () => {
    const router = readFileSync("../view/admin-ts/src/router/index.ts", "utf8");
    const layout = readFileSync("../view/admin-ts/src/layouts/AdminLayout.vue", "utf8");
    const api = readFileSync("../view/admin-ts/src/api/enterpriseWechat.ts", "utf8");
    const page = readFileSync("../view/admin-ts/src/pages/operations/EnterpriseWechat.vue", "utf8");
    expect(router).toContain('path: "operations/work"');
    expect(layout).toContain('index="/operations/work"');
    expect(api).toContain('get("/work/summary")');
    expect(api).toContain('get("/work/contact_action"');
    expect(api).toContain('post(`/work/contact_action/${id}/decision`');
    expect(page).toContain("目录同步与主动发送保持关闭");
    expect(page).toContain("目录只读 · 动作受控处置");
    expect(page).toContain("mobile-list");
    expect(page).toContain("客户后置动作台账");
    expect(page).toContain("C8 动作结构已进入生产数据库");
    expect(page).toContain("欢迎码是 20 秒内单次使用凭据");
    expect(page).toContain("decision.requestKey = crypto.randomUUID()");
    expect(page).toContain("request_key: decision.requestKey");
    expect(page).not.toMatch(/(?:新增|编辑|删除|同步|发送)[^<]{0,20}<\/el-button>/);
  });
});
