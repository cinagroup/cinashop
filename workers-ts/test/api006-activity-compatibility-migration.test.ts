import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { calculateBargainHelpCutCents } from "../src/services/activity/ActivityJoinService";

const routes = readFileSync("src/routes/v1/index.ts", "utf8");
const controller = readFileSync("src/controllers/api/v1/ActivityJoinController.ts", "utf8");
const service = readFileSync("src/services/activity/ActivityJoinService.ts", "utf8");
const codeService = readFileSync("src/services/wechat/WechatMiniProgramCodeService.ts", "utf8");
const migrationService = readFileSync("src/services/MigrationService.ts", "utf8");
const migration = readFileSync("migrations/0101_activity_compatibility_indexes.sql", "utf8");

function routeStatement(path: string): string {
  const start = routes.indexOf(`"${path}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  return routes.slice(start, routes.indexOf(";", start));
}

describe("API-006 legacy activity compatibility", () => {
  it("registers all 11 missing PHP activity routes", () => {
    const expected = [
      ["get", "/seckill/detail/:id/:time?"],
      ["get", "/seckill/detail_code/:id"],
      ["get", "/seckill/code/:id"],
      ["get", "/combination/detail_code/:id"],
      ["get", "/combination/banner_list"],
      ["get", "/combination/poster_info/:id"],
      ["get", "/combination/code/:id"],
      ["get", "/bargain/config"],
      ["post", "/bargain/start/user"],
      ["post", "/bargain/share"],
      ["get", "/bargain/poster_info/:bargainId"],
    ] as const;
    for (const [method, path] of expected) {
      expect(routes).toContain(`v1Routes.${method}("${path}"`);
    }
  });

  it("keeps public catalogs and H5 codes optional-auth, but protects personalized codes and posters", () => {
    for (const path of [
      "/seckill/detail/:id/:time?",
      "/seckill/detail_code/:id",
      "/combination/detail_code/:id",
      "/combination/banner_list",
      "/bargain/config",
    ]) {
      expect(routeStatement(path)).toContain("authMiddleware({ force: false })");
    }
    for (const path of [
      "/seckill/code/:id",
      "/combination/code/:id",
      "/combination/poster_info/:id",
      "/bargain/start/user",
      "/bargain/share",
      "/bargain/poster_info/:bargainId",
    ]) {
      expect(routeStatement(path)).toContain("authMiddleware({ force: true })");
    }
  });

  it("builds legacy activity mini-program scenes in memory without public attachments", () => {
    expect(codeService).toContain('scene: `id=${id}&spid=${uid}&type=1`');
    expect(codeService).toContain('scene: `id=${id}&spid=${uid}&type=3`');
    expect(codeService).toContain('page: "pages/activity/goods_bargain_details/index"');
    expect(codeService).toContain('page: "pages/activity/goods_combination_status/index"');
    expect(codeService).toContain("descriptor.scene).byteLength > 32");
    expect(codeService).toContain("routine_code:activity:");
    const method = codeService.slice(
      codeService.indexOf("async createActivityDataUrl"),
      codeService.indexOf("async createUserSpreadDataUrl"),
    );
    expect(method).not.toContain("attachment");
    expect(method).not.toContain("insert(");
  });

  it("owner-scopes poster and cancellation operations and accepts the old bargainId payload", () => {
    expect(service).toContain("eq(storePink.uid, uid)");
    expect(service).toContain("eq(storeBargainUser.uid, uid)");
    expect(service).toContain("id ? eq(storeBargainUser.id, id) : eq(storeBargainUser.bargainId, bargainId)");
    expect(controller).toContain("body.bargainId ?? body.bargain_id");
  });

  it("bounds compatibility pagination and returns the legacy bargain projection", () => {
    expect(service).toContain("Math.min(page, 10_000)");
    expect(service).toContain("Math.min(limit, 100)");
    for (const field of ["bargain_id", "residue_price", "pay_status", "datatime", "title", "image"]) {
      expect(service).toContain(field);
    }
  });

  it("ships matching embedded partial indexes for the audited production query shapes", () => {
    for (const indexName of ["sbu_uid_bargain_active", "so_activity_type_visible"]) {
      expect(migration).toContain(indexName);
      expect(migrationService).toContain(indexName);
    }
    expect(migration).toContain('WHERE "is_del" = 0');
    expect(migration).toContain('"type" IN (1, 2, 3)');
    expect(service).toContain("eq(storeOrder.isSystemDel, 0)");
  });

  it("never cuts below one cent per remaining helper and gives the last helper the remainder", () => {
    expect(calculateBargainHelpCutCents({
      remainingCents: 100,
      remainingPeople: 1,
      percent: 10,
    })).toBe(100);
    expect(calculateBargainHelpCutCents({
      remainingCents: 100,
      remainingPeople: 80,
      percent: 10,
    })).toBe(2);
    expect(() => calculateBargainHelpCutCents({
      remainingCents: 0,
      remainingPeople: 1,
      percent: 10,
    })).toThrow("砍价剩余金额无效");
  });
});
