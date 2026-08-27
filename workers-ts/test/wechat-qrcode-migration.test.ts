import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { qrcode, wechatQrcode, wechatQrcodeCate, wechatQrcodeRecord } from "@/models/schema";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";
import {
  isOfficialAccountQrcodeMessage,
} from "@/services/wechat/OfficialAccountQrcodeService";
import { normalizeChannelInput } from "@/services/wechat/WechatQrcodeAdminService";
import { MIGRATION_MANIFEST_VERSION, MIGRATION_TABLES } from "../scripts/data-migration/manifest";

function validChannel(overrides: Record<string, unknown> = {}) {
  return {
    uid: 1001,
    name: "上海旗舰店",
    cate_id: 2,
    label_id: [8, 12],
    type: "text",
    content: { content: "欢迎关注" },
    time: 30,
    status: 1,
    ...overrides,
  };
}

describe("official-account QR and channel-code migration", () => {
  it("preserves all four source tables and exact source columns", () => {
    expect(getTableName(qrcode)).toBe("qrcode");
    expect(getTableName(wechatQrcode)).toBe("wechat_qrcode");
    expect(getTableName(wechatQrcodeCate)).toBe("wechat_qrcode_cate");
    expect(getTableName(wechatQrcodeRecord)).toBe("wechat_qrcode_record");
    expect(Object.keys(getTableColumns(qrcode))).toEqual([
      "id", "thirdType", "thirdId", "ticket", "expireSeconds", "status", "addTime",
      "url", "qrcodeUrl", "scan", "type",
    ]);
    expect(Object.keys(getTableColumns(wechatQrcode))).toEqual([
      "id", "uid", "name", "image", "cateId", "labelId", "type", "content", "data",
      "follow", "scan", "addTime", "continueTime", "endTime", "status", "isDel",
    ]);
    expect(Object.keys(getTableColumns(wechatQrcodeCate))).toEqual(["id", "cateName", "addTime", "isDel"]);
    expect(Object.keys(getTableColumns(wechatQrcodeRecord))).toEqual(["id", "qid", "uid", "isFollow", "addTime"]);
    for (const table of ["qrcode", "wechat_qrcode", "wechat_qrcode_cate", "wechat_qrcode_record"]) {
      expect(MIGRATION_TABLES.find((entry) => entry.table === table)?.key).toEqual(["id"]);
    }
    expect(MIGRATION_MANIFEST_VERSION).toBe("2026-08-11.57");
  });

  it("keeps external 0072 and embedded 0079 SQL exactly equivalent", () => {
    const migration = readFileSync("migrations/0072_wechat_qrcode.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(
      /private migration_0079\(\): string \{\s*return `([\s\S]*?)`;\s*\}/,
    )?.[1]?.trim();
    expect(embedded).toBe(migration);
    expect(migration).not.toMatch(/FOREIGN KEY\s*\(|REFERENCES\s+"/i);
    expect(migration.match(/CREATE UNIQUE INDEX/gi)).toHaveLength(1);
    expect(migration).toContain('ON "qrcode" ("third_type", "third_id")');
    expect(migration).toContain('"add_time" VARCHAR(255) DEFAULT \'0\' NOT NULL');
  });

  it("normalizes all supported channel replies and bounds legacy fields", () => {
    const text = normalizeChannelInput(validChannel());
    expect(text).toMatchObject({ uid: 1001, cateId: 2, labelIds: [8, 12], type: "text", continueTime: 30 });
    expect(text.data).toEqual({ content: "欢迎关注" });
    expect(normalizeChannelInput(validChannel({ type: "image", content: { media_id: "m1", src: "/m1.png" } })).data)
      .toEqual({ media_id: "m1", src: "/m1.png" });
    expect(normalizeChannelInput(validChannel({ type: "url", content: { content: "https://shop.example.com/a" } })).data)
      .toEqual({ content: "https://shop.example.com/a" });
    expect(normalizeChannelInput(validChannel({ type: "news", content: { list: { id: 9, title: "活动", synopsis: "摘要", image: "/cover.png", url: "/pages/news?id=9" } } })).data)
      .toMatchObject({ id: 9, title: "活动" });
    expect(() => normalizeChannelInput(validChannel({ label_id: [] }))).toThrow("至少一个用户标签");
    expect(() => normalizeChannelInput(validChannel({ time: 10_001 }))).toThrow("有效期格式错误");
    expect(() => normalizeChannelInput(validChannel({ type: "url", content: { content: "ftp://example.com" } }))).toThrow("HTTP 或 HTTPS");
    expect(() => normalizeChannelInput(validChannel({ type: "voice", content: { src: "/voice.mp3" } }))).toThrow("微信素材ID");
  });

  it("accepts only bounded queue messages for supported targets", () => {
    expect(isOfficialAccountQrcodeMessage({ action: "provisionOfficialAccountQrcode", thirdType: "reply", thirdId: 9 })).toBe(true);
    expect(isOfficialAccountQrcodeMessage({ action: "provisionOfficialAccountQrcode", thirdType: "wechatqrcode", thirdId: 18 })).toBe(true);
    expect(isOfficialAccountQrcodeMessage({ action: "provisionOfficialAccountQrcode", thirdType: "user", thirdId: 9 })).toBe(false);
    expect(isOfficialAccountQrcodeMessage({ action: "provisionOfficialAccountQrcode", thirdType: "reply", thirdId: 0 })).toBe(false);
    expect(isOfficialAccountQrcodeMessage({ action: "other", thirdType: "reply", thirdId: 9 })).toBe(false);
  });

  it("restores legacy routes and isolates view/manage permissions", () => {
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    const aliases = readFileSync("src/routes/v1/index.ts", "utf8");
    for (const path of [
      "/wechat_qrcode/cate/list", "/wechat_qrcode/cate/save", "/wechat_qrcode/save/:id",
      "/wechat_qrcode/list", "/wechat_qrcode/user_list/:qid", "/wechat_qrcode/statistic/:qid",
    ]) expect(adminRoutes).toContain(path);
    expect(aliases).toContain('/admin/wechat_qrcode/provision/:id');
    expect(adminRoutes).toContain('/wechat/code_reply/:id/provision');
    expect(requiredAdminPermission("GET", "/adminapi/wechat_qrcode/list")).toBe("wechat_qrcode.view");
    expect(requiredAdminPermission("GET", "/adminapi/wechat_qrcode/statistic/18")).toBe("wechat_qrcode.view");
    expect(requiredAdminPermission("POST", "/adminapi/wechat_qrcode/save/0")).toBe("wechat_qrcode.manage");
    expect(requiredAdminPermission("POST", "/adminapi/wechat/code_reply/9/provision")).toBe("wechat_content.manage");
  });

  it("keeps external calls out of transactions and bounds WeChat responses", () => {
    const runtime = readFileSync("src/services/wechat/OfficialAccountQrcodeService.ts", "utf8");
    const adminRuntime = readFileSync("src/services/wechat/WechatQrcodeAdminService.ts", "utf8");
    const queue = readFileSync("src/index.ts", "utf8");
    expect(runtime).toContain("const MAX_API_JSON_BYTES = 64 * 1024");
    expect(runtime).toContain("response.body.getReader()");
    expect(runtime).not.toContain("response.json(");
    expect(runtime).not.toContain("response.text(");
    expect(runtime).not.toContain("response.arrayBuffer(");
    expect(runtime.indexOf("await this.createPermanent")).toBeLessThan(runtime.indexOf("const result = await withTx"));
    expect(adminRuntime).toContain("微信素材不存在或类型不匹配");
    expect(adminRuntime).toContain("pg_advisory_xact_lock");
    expect(queue).toContain("isOfficialAccountQrcodeMessage");
    expect(queue).toContain("official_qrcode_provision_failed");
    expect(queue).toContain("msg.retry({ delaySeconds })");
  });

  it("wires responsive Admin workflows and keeps callback limitations visible", () => {
    const router = readFileSync("../view/admin-ts/src/router/index.ts", "utf8");
    const layout = readFileSync("../view/admin-ts/src/layouts/AdminLayout.vue", "utf8");
    const page = readFileSync("../view/admin-ts/src/pages/content/WechatQrcode.vue", "utf8");
    const contentPage = readFileSync("../view/admin-ts/src/pages/content/WechatContent.vue", "utf8");
    expect(router).toContain('path: "content/wechat-qrcode"');
    expect(layout).toContain('index="/content/wechat-qrcode"');
    expect(page).toContain("二维码由队列异步生成");
    expect(page).toContain("公众号扫码回调尚未启用");
    expect(page).toContain("apiChannelStatistics");
    expect(page).toContain("apiChannelUsers");
    expect(page).toContain("mobile-list");
    expect(contentPage).toContain("openReplyCode(row)");
    expect(contentPage).not.toContain("apiWechatPush");
  });
});
