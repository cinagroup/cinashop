import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Route = {
  legacy: { path: string; resolvedComponent: string; behaviorSource: string; source: string; routerSha256: string; parentAuth: string; auth: string };
  status: "candidate" | "partial" | "missing" | "retired";
  targetScreens: string[];
  targetApis: string[];
  targetPermissions: string[];
  covered: string[];
  remaining: string[];
  evidence: string[];
};
type Report = {
  methodology: { scope: string; reviewBasis: string; validationBoundary: string };
  summary: Record<string, number>;
  routes: Route[];
};

const source = (path: string) => readFileSync(path, "utf8");
const inventory = JSON.parse(source("audit/admin-frontend-inventory.json")) as {
  legacy: { routes: { path: string; surface: string }[]; routeFiles: { file: string; sha256: string }[] };
};
const report = JSON.parse(source("audit/admin-legacy-app-route-parity.json")) as Report;
const businessPaths = inventory.legacy.routes
  .filter((route) => route.surface === "page" && route.path.startsWith("/admin/app/"))
  .map((route) => route.path);
const byPath = new Map(report.routes.map((route) => [route.legacy.path, route]));

describe("legacy Admin app route parity audit", () => {
  it("reviews exactly the 20 authoritative app pages in inventory order", () => {
    expect(businessPaths).toHaveLength(20);
    expect(report.routes.map((route) => route.legacy.path)).toEqual(businessPaths);
    expect(report.summary).toEqual({
      legacyRoutes: 20, reviewed: 20, candidate: 0, partial: 8,
      missing: 12, retired: 0, unreviewed: 0,
    });
  });

  it("keeps six completed ledgers disjoint within the 274-page authority", () => {
    const content = JSON.parse(source("audit/admin-legacy-content-route-parity.json")) as { routes: { legacyPath: string }[] };
    const product = JSON.parse(source("audit/admin-legacy-product-route-parity.json")) as { routes: { legacyPath: string }[] };
    const setting = JSON.parse(source("audit/admin-legacy-setting-route-parity.json")) as { routes: { legacy: { path: string } }[] };
    const marketing = JSON.parse(source("audit/admin-legacy-marketing-route-parity.json")) as { routes: { legacy: { path: string } }[] };
    const work = JSON.parse(source("audit/admin-legacy-work-route-parity.json")) as { routes: { legacy: { path: string } }[] };
    const paths = [
      ...content.routes.map((route) => route.legacyPath),
      ...product.routes.map((route) => route.legacyPath),
      ...setting.routes.map((route) => route.legacy.path),
      ...marketing.routes.map((route) => route.legacy.path),
      ...work.routes.map((route) => route.legacy.path),
      ...report.routes.map((route) => route.legacy.path),
    ];
    const authority = new Set(inventory.legacy.routes.filter((route) => route.surface === "page").map((route) => route.path));
    expect(authority.size).toBe(274);
    expect(paths).toHaveLength(189);
    expect(new Set(paths).size).toBe(189);
    expect(paths.every((path) => authority.has(path))).toBe(true);
  });

  it("pins legacy route and permission evidence while validating in-repository targets", () => {
    const routerHash = inventory.legacy.routeFiles.find((file) => file.file === "src/router/modules/app.js")?.sha256;
    expect(routerHash).toMatch(/^[a-f0-9]{64}$/u);
    const generator = source("scripts/admin-app-frontend-parity-audit.ts");
    expect(generator).not.toMatch(/readFileSync\([^\n]*cinashop-php/u);
    expect(generator).toContain("Legacy paths and meta.auth are static reviewed evidence");
    expect(new Set(report.routes.map((route) => route.legacy.path)).size).toBe(20);
    for (const route of report.routes) {
      expect(route.legacy.resolvedComponent, route.legacy.path).toContain("cinashop-php/view/admin/src/pages/app/");
      expect(route.legacy.source, route.legacy.path).toMatch(/app\.js:\d+$/u);
      expect(route.legacy.behaviorSource, route.legacy.path).toMatch(/\.vue:\d+$/u);
      expect(route.legacy.routerSha256, route.legacy.path).toBe(routerHash);
      expect(route.legacy.parentAuth).toBe("['admin-app']");
      expect(route.legacy.auth, route.legacy.path).toMatch(/^\['[^']+'\]$/u);
      expect(route.evidence, route.legacy.path).toContain(route.legacy.resolvedComponent);
      expect(route.evidence, route.legacy.path).toContain(route.legacy.behaviorSource);
      expect(route.remaining.length, route.legacy.path).toBeGreaterThan(0);
      for (const file of route.evidence.filter((item) => !item.startsWith("cinashop-php/"))) {
        expect(existsSync(resolve("..", file)), `${route.legacy.path}: ${file}`).toBe(true);
      }
      if (route.status === "missing") expect(route.targetScreens, route.legacy.path).toEqual([]);
      else {
        expect(route.targetScreens.length, route.legacy.path).toBeGreaterThan(0);
        expect(route.covered.length, route.legacy.path).toBeGreaterThan(0);
        expect(route.targetPermissions.length, route.legacy.path).toBeGreaterThan(0);
      }
    }
  });

  it("keeps different data entities and absent delivery flows distinct", () => {
    for (const path of [
      "/admin/app/wechat/base", "/admin/app/wechat_open", "/admin/app/pc", "/admin/app/app",
      "/admin/app/wechat/setting/menus/index", "/admin/app/wechat/setting/template/index",
      "/admin/app/wechat/wechat_user/user/index", "/admin/app/wechat/wechat_user/user/tag",
      "/admin/app/wechat/wechat_user/user/group", "/admin/app/wechat/wechat_user/user/message",
      "/admin/app/routine/routine_template/index", "/admin/app/routine/download",
    ]) expect(byPath.get(path)?.status, path).toBe("missing");
    expect(byPath.get("/admin/app/wechat/wechat_user/user/index")?.targetApis).toContain("GET /adminapi/user/list");
    expect(byPath.get("/admin/app/wechat/wechat_user/user/message")?.targetApis).toContain("GET /adminapi/wechat/message");
    expect(byPath.get("/admin/app/wechat/wechat_user/user/message")?.remaining.join(" ")).toMatch(/wechat_message/u);
    expect(byPath.get("/admin/app/wechat/wechat_user/user/group")?.remaining.join(" ")).toMatch(/复用 tag\.vue/u);
    for (const path of [
      "/admin/app/wechat/news_category/index", "/admin/app/wechat/news_category/save/:id?",
      "/admin/app/wechat/reply/follow/:key", "/admin/app/wechat/reply/keyword",
      "/admin/app/wechat/reply/keyword/save/:id?", "/admin/app/wechat/reply/index/:key",
      "/admin/app/wechat/card", "/admin/app/wechat/reply",
    ]) expect(byPath.get(path)?.status, path).toBe("partial");
    expect(byPath.get("/admin/app/wechat/card")?.targetPermissions).toContain("wechat_member_card.view");
    expect(byPath.get("/admin/app/wechat/card")?.remaining.join(" ")).toMatch(/501/u);
    expect(byPath.get("/admin/app/wechat/news_category/index")?.remaining.join(" ")).toMatch(/100 条/u);
    expect(report.methodology.reviewBasis).toMatch(/generic user screen/u);
    expect(report.methodology.validationBoundary).toMatch(/No production data/u);
  });

  it("matches the checked-in JSON byte for byte when regenerated in a single checkout", () => {
    const generated = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/admin-app-frontend-parity-audit.ts"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(generated).toBe(source("audit/admin-legacy-app-route-parity.json"));
  });
});
