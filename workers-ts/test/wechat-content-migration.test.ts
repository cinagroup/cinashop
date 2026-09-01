import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  wechatKey,
  wechatMedia,
  wechatMessage,
  wechatNewsCategory,
  wechatReply,
} from "@/models/schema";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";
import {
  maskWechatIdentifier,
  normalizeNewsInput,
  normalizeReplyInput,
  redactWechatMessageResult,
} from "@/services/wechat/WechatContentService";
import { MIGRATION_MANIFEST_VERSION, MIGRATION_TABLES } from "../scripts/data-migration/manifest";

function textReply(overrides: Record<string, unknown> = {}) {
  return { key: "订单,物流", type: "text", status: 1, data: { content: "查看订单详情" }, ...overrides };
}

function article(index = 0) {
  return {
    id: 0,
    title: `文章${index + 1}`,
    author: "运营",
    synopsis: "摘要",
    content: "正文",
    image_input: "/cover.png",
    url: "",
  };
}

describe("official-account content migration", () => {
  it("preserves all five source tables and their source column counts", () => {
    expect(getTableName(wechatKey)).toBe("wechat_key");
    expect(getTableName(wechatMedia)).toBe("wechat_media");
    expect(getTableName(wechatMessage)).toBe("wechat_message");
    expect(getTableName(wechatNewsCategory)).toBe("wechat_news_category");
    expect(getTableName(wechatReply)).toBe("wechat_reply");
    expect(Object.keys(getTableColumns(wechatKey))).toEqual(["id", "replyId", "keys"]);
    expect(Object.keys(getTableColumns(wechatMedia))).toHaveLength(7);
    expect(Object.keys(getTableColumns(wechatMessage))).toHaveLength(5);
    expect(Object.keys(getTableColumns(wechatNewsCategory))).toEqual([
      "id", "cateName", "sort", "status", "newId", "addTime",
    ]);
    expect(Object.keys(getTableColumns(wechatReply))).toEqual(["id", "type", "data", "status", "hide"]);
    for (const table of ["wechat_key", "wechat_media", "wechat_message", "wechat_news_category", "wechat_reply"]) {
      expect(MIGRATION_TABLES.find((entry) => entry.table === table)?.key).toEqual(["id"]);
    }
    expect(MIGRATION_MANIFEST_VERSION).toBe("2026-08-11.57");
  });

  it("keeps external 0071 and embedded 0078 SQL exactly equivalent", () => {
    const migration = readFileSync("migrations/0071_wechat_reply_content.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(
      /private migration_0078\(\): string \{\s*return `([\s\S]*?)`;\s*\}/,
    )?.[1]?.trim();
    expect(embedded).toBe(migration);
    expect(migration).not.toMatch(/FOREIGN KEY\s*\(|REFERENCES\s+"/i);
    expect(migration.match(/CREATE UNIQUE INDEX/gi)).toHaveLength(1);
    expect(migration).toContain('"add_time" VARCHAR(255) DEFAULT \'\' NOT NULL');
    expect(migration).toContain('ON "wechat_media" ("type", "media_id")');
  });

  it("normalizes reply data and prevents new keyword ambiguity", () => {
    expect(normalizeReplyInput(textReply()).keys).toEqual(["订单", "物流"]);
    expect(normalizeReplyInput(textReply({ key: "订单,订单" })).keys).toEqual(["订单"]);
    expect(normalizeReplyInput(textReply({ key: "subscribe" })).keys).toEqual(["subscribe"]);
    expect(() => normalizeReplyInput(textReply({ key: "subscribe,欢迎" }))).toThrow("必须单独配置");
    expect(() => normalizeReplyInput(textReply({ type: "video" }))).toThrow("回复类型错误");
    expect(() => normalizeReplyInput({ key: "图片", type: "image", data: { src: "/a.png" } })).toThrow("微信素材ID");
    expect(normalizeReplyInput({ key: "图片", type: "image", data: { src: "/a.png", media_id: "m1" } }).data).toEqual({ src: "/a.png", media_id: "m1" });
  });

  it("bounds news writes and preserves source-shaped article linkage", () => {
    const normalized = normalizeNewsInput({ id: 0, sort: 2, status: 1, list: [article()] });
    expect(normalized.articles).toHaveLength(1);
    expect(normalized.articles[0].imageInput).toBe("/cover.png");
    const safePublished = normalizeNewsInput({
      id: 0,
      list: [{
        ...article(),
        content: '<p onclick="alert(1)"><img src="/api/assets/7?expires=1&signature=stale"></p>',
        image_input: "/api/assets/8?expires=1&signature=stale",
      }],
    }).articles[0];
    expect(safePublished.content).toBe('<p><img src="/api/assets/7" width="100%"></p>');
    expect(safePublished.imageInput).toBe("/api/assets/8");
    expect(() => normalizeNewsInput({
      id: 0,
      list: [{ ...article(), image_input: "javascript:alert(1)" }],
    })).toThrow("必须使用HTTPS或站内路径");
    expect(() => normalizeNewsInput({ list: [] })).toThrow("1至8篇");
    expect(() => normalizeNewsInput({ list: Array.from({ length: 9 }, (_, index) => article(index)) })).toThrow("1至8篇");
    expect(() => normalizeNewsInput({ list: [{ ...article(), author: "" }] })).toThrow("作者");
    expect(() => normalizeNewsInput({ id: 1, list: [{ ...article(), id: 9 }, { ...article(1), id: 9 }] })).toThrow("不能重复选择文章");
  });

  it("redacts user identifiers before returning imported message history", () => {
    expect(maskWechatIdentifier("o123456789abcd")).toBe("o123***abcd");
    expect(redactWechatMessageResult(JSON.stringify({
      FromUserName: "o123456789abcd",
      Content: "订单",
      Detail: "received from o123456789abcd",
    }), "o123456789abcd")).toEqual({
      FromUserName: "o123***abcd",
      Content: "订单",
      Detail: "received from o123***abcd",
    });
    expect(redactWechatMessageResult("openid=o123456789abcd", "o123456789abcd")).toBe("openid=o123***abcd");
  });

  it("restores legacy Admin routes and registers view/manage permissions", () => {
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    expect(adminRoutes).toContain('adminapiRoutes.get("/wechat/reply"');
    expect(adminRoutes).toContain('adminapiRoutes.post("/wechat/keyword/:id"');
    expect(adminRoutes).toContain('adminapiRoutes.get("/wechat/news"');
    expect(adminRoutes).toContain('adminapiRoutes.get("/wechat/message"');
    expect(adminRoutes).toContain('adminapiRoutes.post("/wechat/push"');
    expect(requiredAdminPermission("GET", "/adminapi/wechat/keyword")).toBe("wechat_content.view");
    expect(requiredAdminPermission("POST", "/adminapi/wechat/keyword/0")).toBe("wechat_content.manage");
    expect(requiredAdminPermission("DELETE", "/adminapi/wechat/news/1")).toBe("wechat_content.manage");
    expect(requiredAdminPermission("GET", "/adminapi/wechat/speechcraft")).toBe("service.view");
  });

  it("uses transactional catalog locks and refuses unsafe external fanout", () => {
    const runtime = readFileSync("src/services/wechat/WechatContentService.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/AdminWechatContentController.ts", "utf8");
    expect(runtime).toContain("pg_advisory_xact_lock");
    expect(runtime).toContain('.for("update")');
    expect(runtime).toContain("只能选择已迁移且类型匹配的微信素材");
    expect(runtime).not.toContain("fetch(");
    expect(controller).toContain("const MAX_BODY_BYTES = 512 * 1024");
    expect(controller).toContain("可重试队列、幂等投递记录和微信凭据");
    expect(controller).toContain("qrcode 表和公众号接口");
  });

  it("wires a previewable Admin page without exposing push controls", () => {
    const router = readFileSync("../view/admin-ts/src/router/index.ts", "utf8");
    const layout = readFileSync("../view/admin-ts/src/layouts/AdminLayout.vue", "utf8");
    const page = readFileSync("../view/admin-ts/src/pages/content/WechatContent.vue", "utf8");
    expect(router).toContain('path: "content/wechat"');
    expect(layout).toContain('index="/content/wechat"');
    expect(page).toContain("回复二维码现通过可靠队列异步生成");
    expect(page).toContain("公众号扫码回调、用户/卡券事件链与群发仍保持关闭");
    expect(page).toContain("查看脱敏详情");
    expect(page).not.toContain("apiWechatPush");
  });
});
