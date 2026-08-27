import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("community social graph migration", () => {
  it("keeps the physical and embedded social indexes byte-equivalent", () => {
    const migration = readFileSync("migrations/0087_community_social_graph_indexes.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(
      /private migration_0094\(\): string \{\s*return `([\s\S]*?)`;\s*\}/,
    )?.[1]?.trim();
    expect(embedded).toBe(migration);
    expect(migration).toContain('WHERE "status" = 1 AND "is_verify" = 1 AND "is_del" = 0');
    expect(migration).toContain('WHERE "status" = 1 AND "is_del" = 0 AND "community_num" > 0');
  });

  it("restores every PHP community-user route with the original methods", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const expected = [
      '"/community/user_info/:authorUid"',
      '"/community/update_desc"',
      '"/community/set_interest/:authorUid"',
      '"/community/follow_list/:type"',
      '"/community/user_friend"',
      '"/community/recommend_list"',
      '"/community/follow"',
      '"/community/browse/:id"',
    ];
    for (const fragment of expected) expect(routes).toContain(fragment);
    expect(routes).toContain('v1Routes.put("/community/browse/:id"');
    expect(routes).toContain('v1Routes.post(\n  "/community/set_interest/:authorUid"');
  });

  it("bounds social request bodies and never falls back to unbounded Hono JSON parsing", () => {
    const controller = readFileSync("src/controllers/api/v1/CommunityController.ts", "utf8");
    expect(controller).toContain("MAX_COMMUNITY_BODY_BYTES = 256 * 1024");
    expect(controller).toContain("stream.getReader()");
    expect(controller).not.toContain("c.req.json()");
  });

  it("uses stable user locks, idempotent edges, duplicate guards and durable browse rows", () => {
    const service = readFileSync("src/services/community/CommunitySocialService.ts", "utf8");
    expect(service).toContain("sort((a, b) => a - b)");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain("existing.length === 0");
    expect(service).toContain("existing.length > 0");
    expect(service).toContain("社区用户资料存在重复，请先处理历史数据");
    expect(service).toContain('type: COMMUNITY_BROWSE');
    expect(service).toContain("GROUP BY right_id");
    expect(service).toContain("GROUP BY left_id");
    expect(service).toContain("SELECT DISTINCT ON (cu.relation_id)");
    expect(service).toContain('FROM "user" account');
    expect(service).toContain("eq(communityUser.relationId, 0)");
    expect(service).toContain("executeRows<");
    expect(service).not.toContain("tx.$client");
  });

  it("keeps production integration writes inside guarded disposable schemas", () => {
    const scenario = readFileSync("test/integration/CommunitySocialPostgresScenario.ts", "utf8");
    const worker = readFileSync("test/integration/CommunitySocialAuditWorker.ts", "utf8");
    const config = readFileSync("test/integration/community-social-audit.wrangler.toml", "utf8");
    expect(scenario).toContain("codex_community_social_");
    expect(scenario).toContain("SET LOCAL search_path");
    expect(scenario).toContain("publicStateUnchanged");
    expect(scenario).toContain("DROP SCHEMA");
    expect(scenario).not.toMatch(/insert\(.*public\./is);
    expect(worker).toContain("AUDIT_TOKEN_SHA256");
    expect(worker).toContain("timingSafeEqual");
    expect(worker).toContain('"/cleanup-schemas"');
    expect(worker).toContain("business_rows_unchanged");
    expect(config).toContain('id = "9748c294e21c49a99579c9cef70102e0"');
  });

  it("migrates the UniApp social API and a usable four-tab relationship screen", () => {
    const api = readFileSync("../view/uniapp-ts/src/api/community.ts", "utf8");
    const page = readFileSync("../view/uniapp-ts/src/pages/discover/people.vue", "utf8");
    const manifest = readFileSync("../view/uniapp-ts/src/pages.json", "utf8");
    expect(api).toContain("apiCommunitySetInterest");
    expect(api).toContain("apiCommunityFollowList");
    expect(api).toContain("apiCommunityRecommendations");
    expect(api).toContain("communityPreviewMode");
    expect(api).toContain("previewPeople");
    expect(page).toContain('{ key: "friend", label: "好友" }');
    expect(page).toContain('{ key: "follow", label: "关注" }');
    expect(page).toContain('{ key: "fans", label: "粉丝" }');
    expect(page).toContain('{ key: "recommend", label: "推荐" }');
    expect(page).toContain("apiCommunitySetInterest");
    expect(manifest).toContain('"path": "pages/discover/people"');
  });

  it("exposes the same social contract in the PC community surface", () => {
    const api = readFileSync("../view/pc-ts/src/api/community.ts", "utf8");
    const page = readFileSync("../view/pc-ts/src/pages/community/Community.vue", "utf8");
    for (const symbol of [
      "apiCommunityFollowHighlights",
      "apiCommunityFollowList",
      "apiCommunityFriendList",
      "apiCommunityRecommendations",
      "apiCommunitySetInterest",
    ]) expect(api).toContain(symbol);
    expect(page).toContain('type SocialTab = "friend" | "follow" | "fans" | "recommend"');
    expect(page).toContain("好友来自推广关系");
    expect(page).toContain("ElMessageBox.confirm");
    expect(page).toContain("apiCommunitySetInterest");
  });
});
