import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MigrationService } from "../src/services/MigrationService";

const routes = readFileSync("src/routes/v1/index.ts", "utf8");
const controller = readFileSync("src/controllers/api/v1/ShortVideoController.ts", "utf8");
const service = readFileSync("src/services/activity/ShortVideoService.ts", "utf8");
const schema = readFileSync("src/models/schema/short_video.ts", "utf8");
const migration = readFileSync("migrations/0102_short_video_compatibility.sql", "utf8");

function routeStatement(method: string, path: string): string {
  const start = routes.indexOf(`v1Routes.${method}("${path}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  return routes.slice(start, routes.indexOf(";", start));
}

function sourceBlock(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("API-006 short-video compatibility", () => {
  it("registers all nine PHP paths with the original authentication boundaries", () => {
    for (const path of [
      "/marketing/short_video",
      "/marketing/short_video/info/:id",
      "/marketing/short_video/comment/:id",
      "/marketing/short_video/product/:id",
    ]) {
      expect(routeStatement("get", path)).toContain("authMiddleware({ force: false })");
    }
    for (const [method, path] of [
      ["post", "/marketing/short_video/comment/:id/:pid"],
      ["get", "/marketing/short_video/comment_reply/:pid"],
      ["delete", "/marketing/short_video/comment/:id"],
      ["get", "/marketing/short_video/comment/:type/:id"],
      ["get", "/marketing/short_video/:type/:id"],
    ]) {
      expect(routeStatement(method, path)).toContain("authMiddleware({ force: true })");
    }
  });

  it("keeps viewer-specific and legacy GET-write responses out of shared caches", () => {
    expect(controller).toContain('c.header("Cache-Control", "private, no-store")');
    expect(controller).toContain("c.executionCtx.waitUntil(");
  });

  it("records every visible play event with its atomic counter update", () => {
    const recordPlays = sourceBlock(service, "async recordPlays(", "async info(");
    expect(controller).toContain('recordPlays(result.playIds, c.get("uid") ?? 0)');
    expect(recordPlays).toContain("ids: number[], uid: number");
    expect(recordPlays).toContain("withTx(this.container, async (tx)");
    expect(recordPlays).toContain("GREATEST(${video.playNum} + 1, 0)");
    expect(recordPlays).toContain(".returning({ id: video.id })");
    expect(recordPlays).toContain("tx.insert(userRelation)");
    expect(recordPlays).toContain("played.map(({ id })");
    expect(recordPlays).toContain('type: "play"');
    expect(recordPlays).toContain('category: "video"');
    expect(recordPlays).not.toContain("onConflictDoNothing");
  });

  it("enforces storefront visibility and does not leak unreviewed recommendations", () => {
    for (const check of [
      "eq(video.isShow, 1)",
      "eq(video.isDel, 0)",
      "eq(video.isVerify, 1)",
    ]) expect(service).toContain(check);
    expect(service).toContain("orderType === 2");
    expect(service).toContain("eq(video.isRecommend, 1)");
    expect(service).toContain("PHP omitted is_verify here");
  });

  it("uses private attachment signatures for cover, video, and avatar references", () => {
    expect(service.match(/signAttachmentReferences\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(service).toContain("rows.flatMap((row) => [row.image, row.videoUrl])");
    expect(service).not.toContain("ASSETS_BUCKET");
  });

  it("serializes relation toggles and keeps counters nonnegative", () => {
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain('eq(userRelation.category, category)');
    expect(service).toContain("GREATEST(${video.likeNum} + ${delta}, 0)");
    expect(service).toContain("GREATEST(${videoComment.likeNum} + ${delta}, 0)");
  });

  it("binds replies to the supplied video and minimizes comment PII", () => {
    expect(service).toContain("eq(videoComment.videoId, videoId)");
    expect(service).toContain('ip: ""');
    expect(service).toContain('city: ""');
    expect(service).toContain("评论内容不能超过500个字符");
  });

  it("defines every field actually read or written by the legacy runtime", () => {
    for (const field of [
      "videoUrl", "productId", "isRecommend", "isVerify", "commentNum",
      "likeNum", "collectNum", "shareNum", "playNum", "isReply",
    ]) expect(schema).toContain(`${field}:`);
    expect(schema).toContain('varchar("video_url", { length: 2048 })');
    expect(schema).toContain('content: text("content")');
  });

  it("ships byte-equivalent external and embedded idempotent DDL", () => {
    const embedded = new MigrationService({} as never)
      .shortVideoCompatibilityMigrationSqlForVerification();
    expect(embedded.replace(/\r\n/g, "\n").trim()).toBe(migration.replace(/\r\n/g, "\n").trim());
    for (const name of [
      "video_storefront_latest",
      "video_storefront_sort",
      "video_storefront_recommended",
      "video_comment_thread",
      "video_comment_owner",
    ]) expect(migration).toContain(name);
    expect(migration.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(2);
    expect(migration.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(5);
  });
});
