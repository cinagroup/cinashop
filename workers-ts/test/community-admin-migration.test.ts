import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";
import {
  normalizeAdminCommunityPostInput,
  normalizeCommunityTopicInput,
} from "@/services/community/AdminCommunityService";

describe("community admin migration", () => {
  it("keeps the external and embedded moderation indexes byte-equivalent", () => {
    const migration = readFileSync("migrations/0088_community_admin_indexes.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(
      /private migration_0095\(\): string \{\s*return `([\s\S]*?)`;\s*\}/,
    )?.[1]?.trim();
    expect(embedded).toBe(migration);
    expect(migration).toContain('"c_admin_moderation"');
    expect(migration).toContain('"cc_admin_moderation"');
    expect(migration).toContain('"ct_admin_catalog"');
    expect(migration).toMatch(/CREATE INDEX IF NOT EXISTS[\s\S]+WHERE "is_del" = 0/);
  });

  it("normalizes bounded post/topic inputs and rejects incomplete content", () => {
    expect(normalizeAdminCommunityPostInput({
      content_type: 1,
      title: "  发布公告  ",
      content: "正文",
      slider_image: ["a.jpg", "a.jpg", "b.jpg"],
      topic_id: [3, "3", 4],
      product_id: "5,6",
      status: 1,
      is_recommend: 0,
      star: 4,
    })).toMatchObject({
      title: "发布公告",
      image: "a.jpg",
      sliderImage: ["a.jpg", "b.jpg"],
      topicIds: [3, 4],
      productIds: [5, 6],
      star: 4,
    });
    expect(normalizeCommunityTopicInput({ name: "  售后分享 ", status: 1 })).toMatchObject({
      name: "售后分享",
      status: 1,
    });
    expect(() => normalizeAdminCommunityPostInput({ title: "缺少话题" })).toThrow("请至少选择一个话题");
    expect(() => normalizeAdminCommunityPostInput({
      content_type: 2,
      title: "视频",
      topic_id: [1],
    })).toThrow("视频内容必须填写视频地址");
    expect(() => normalizeCommunityTopicInput({ name: "x".repeat(21) })).toThrow("话题名称不能超过20个字符");
  });

  it("restores every PHP admin community route before the 501 fallback", () => {
    const routes = readFileSync("src/routes/adminapi.ts", "utf8");
    const expected = [
      '"/community/all_topic"',
      '"/community/topic/list"',
      '"/community/topic/save_form/:id"',
      '"/community/topic/save/:id"',
      '"/community/topic/set_status/:id/:status"',
      '"/community/topic/set_hot/:id/:hot"',
      '"/community/topic/del/:id"',
      '"/community/community/header"',
      '"/community/community/list"',
      '"/community/community/info/:id"',
      '"/community/community/save/:id"',
      '"/community/community/set_status/:id/:status"',
      '"/community/community/star/form/:id"',
      '"/community/community/star/:id"',
      '"/community/community/set_recommend/:id/:recommend"',
      '"/community/community/verify/form/:id"',
      '"/community/community/take_down/form/:id"',
      '"/community/community/set_verify/:id"',
      '"/community/community/del/:id"',
      '"/community/comment/list"',
      '"/community/comment/reply/:id"',
      '"/community/comment/reply/form/:id"',
      '"/community/comment/del/:id"',
      '"/community/comment/verify/form/:id"',
      '"/community/comment/take_down/form/:id"',
      '"/community/comment/set_status/:id/:status"',
      '"/community/comment/set_verify/:id"',
      '"/community/comment/fictitious/:id"',
      '"/community/comment/save_fictitious"',
    ];
    for (const fragment of expected) expect(routes).toContain(fragment);
    expect(routes.indexOf('"/community/all_topic"')).toBeLessThan(routes.indexOf('adminapiRoutes.all("/*"'));
  });

  it("bounds JSON bodies, preserves ownership on edit, and serializes lifecycle writes", () => {
    const controller = readFileSync("src/controllers/api/v1/AdminCommunityController.ts", "utf8");
    const service = readFileSync("src/services/community/AdminCommunityService.ts", "utf8");
    const client = readFileSync("src/services/community/CommunityService.ts", "utf8");
    expect(controller).toContain("MAX_POST_BODY_BYTES = 512 * 1024");
    expect(controller).toContain("MAX_OPERATION_BODY_BYTES = 16 * 1024");
    expect(controller).toContain("stream.getReader()");
    expect(controller).not.toContain("c.req.json()");
    expect(service).toContain("ownerType = existing?.type ?? 0");
    expect(service).toContain("ownerId = existing?.relationId ?? 0");
    expect(service).toContain("await tx.update(community).set(values).where(eq(community.id, existing.id))");
    expect(service).toMatch(/else \{[\s\S]{0,200}tx\.insert\(community\)[\s\S]{0,200}type:\s*0,[\s\S]{0,100}relationId:\s*0/);
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain('.for("update")');
    expect(client).toContain('.for("update")');
    expect(client).toContain("COMMUNITY_LIFECYCLE_LOCK_NAMESPACE = 17_349");
  });

  it("enforces view/manage permissions including legacy GET mutations", () => {
    expect(requiredAdminPermission("GET", "/adminapi/community/community/list")).toBe("community.view");
    expect(requiredAdminPermission("POST", "/adminapi/community/community/save/0")).toBe("community.manage");
    expect(requiredAdminPermission("GET", "/adminapi/community/topic/set_status/4/0")).toBe("community.manage");
    expect(requiredAdminPermission("GET", "/adminapi/community/topic/set_hot/4/1")).toBe("community.manage");
    expect(requiredAdminPermission("DELETE", "/adminapi/community/comment/del/9")).toBe("community.manage");
  });

  it("wires a complete permission-aware Admin UI without production preview fallbacks", () => {
    const api = readFileSync("../view/admin-ts/src/api/community.ts", "utf8");
    const page = readFileSync("../view/admin-ts/src/pages/community/CommunityOperations.vue", "utf8");
    const router = readFileSync("../view/admin-ts/src/router/index.ts", "utf8");
    const layout = readFileSync("../view/admin-ts/src/layouts/AdminLayout.vue", "utf8");
    expect(api).toContain("import.meta.env.DEV && new URLSearchParams(window.location.search).get(\"preview\") === \"1\"");
    expect(api).toContain('get("/community/community/list"');
    expect(api).toContain('post(`/community/comment/reply/${id}`');
    expect(page).toContain('authStore.uniqueAuth.includes("community.manage")');
    expect(page).toContain('name="topics"');
    expect(page).toContain('name="comments"');
    expect(page).toContain("apiCommunityFictitiousComment");
    expect(router).toContain('path: "community"');
    expect(router).toContain('import("@/pages/community/CommunityOperations.vue")');
    expect(layout).toContain('index="/community"');
    expect(layout).toContain('path.startsWith("/community")');
  });

  it("keeps production writes inside an authenticated disposable-schema audit", () => {
    const scenario = readFileSync("test/integration/CommunityAdminPostgresScenario.ts", "utf8");
    const worker = readFileSync("test/integration/CommunityAdminAuditWorker.ts", "utf8");
    const config = readFileSync("test/integration/community-admin-audit.wrangler.toml", "utf8");
    expect(scenario).toContain("codex_community_admin_");
    expect(scenario).toContain("SET LOCAL search_path");
    expect(scenario).toContain("public_state_unchanged");
    expect(scenario).toContain("DROP SCHEMA");
    expect(scenario).not.toMatch(/insert\(.*public\./is);
    expect(worker).toContain("AUDIT_TOKEN_SHA256");
    expect(worker).toContain("timingSafeEqual");
    expect(worker).toContain('"/cleanup-schemas"');
    expect(worker).toContain("business_rows_unchanged");
    expect(config).toContain('id = "9748c294e21c49a99579c9cef70102e0"');
  });
});
