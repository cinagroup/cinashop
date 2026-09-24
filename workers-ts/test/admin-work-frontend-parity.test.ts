import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Route = {
  legacy: { path: string; resolvedComponent: string; behaviorSource: string; source: string; routerSha256: string; auth: string };
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
const report = JSON.parse(source("audit/admin-legacy-work-route-parity.json")) as Report;
const businessPaths = inventory.legacy.routes
  .filter((route) => route.surface === "page" && route.path.startsWith("/admin/work"))
  .map((route) => route.path);
const byPath = new Map(report.routes.map((route) => [route.legacy.path, route]));

describe("legacy Admin work route parity audit", () => {
  it("reviews exactly the 20 authoritative work pages in inventory order", () => {
    expect(businessPaths).toHaveLength(20);
    expect(report.routes.map((route) => route.legacy.path)).toEqual(businessPaths);
    expect(report.summary).toEqual({
      legacyRoutes: 20, reviewed: 20, candidate: 0, partial: 8,
      missing: 12, retired: 0, unreviewed: 0,
    });
  });

  it("keeps five ledgers disjoint and within the 274-page authority", () => {
    const content = JSON.parse(source("audit/admin-legacy-content-route-parity.json")) as { routes: { legacyPath: string }[] };
    const product = JSON.parse(source("audit/admin-legacy-product-route-parity.json")) as { routes: { legacyPath: string }[] };
    const setting = JSON.parse(source("audit/admin-legacy-setting-route-parity.json")) as { routes: { legacy: { path: string } }[] };
    const marketing = JSON.parse(source("audit/admin-legacy-marketing-route-parity.json")) as { routes: { legacy: { path: string } }[] };
    const paths = [
      ...content.routes.map((route) => route.legacyPath),
      ...product.routes.map((route) => route.legacyPath),
      ...setting.routes.map((route) => route.legacy.path),
      ...marketing.routes.map((route) => route.legacy.path),
      ...report.routes.map((route) => route.legacy.path),
    ];
    const authority = new Set(inventory.legacy.routes.filter((route) => route.surface === "page").map((route) => route.path));
    expect(authority.size).toBe(274);
    expect(paths).toHaveLength(169);
    expect(new Set(paths).size).toBe(169);
    expect(paths.every((path) => authority.has(path))).toBe(true);
  });

  it("pins old route provenance and validates only in-repository target evidence", () => {
    const routerHash = inventory.legacy.routeFiles.find((file) => file.file === "src/router/modules/work.js")?.sha256;
    expect(routerHash).toMatch(/^[a-f0-9]{64}$/u);
    const generator = source("scripts/admin-work-frontend-parity-audit.ts");
    expect(generator).not.toMatch(/readFileSync\([^\n]*cinashop-php/u);
    expect(generator).toContain("Legacy paths and meta.auth are static review evidence");
    expect(new Set(report.routes.map((route) => route.legacy.path)).size).toBe(20);
    for (const route of report.routes) {
      expect(route.legacy.resolvedComponent, route.legacy.path).toContain("cinashop-php/view/admin/src/pages/work/");
      expect(route.legacy.source, route.legacy.path).toMatch(/work\.js:\d+$/u);
      expect(route.legacy.behaviorSource, route.legacy.path).toMatch(/\.vue:\d+$/u);
      expect(route.legacy.routerSha256, route.legacy.path).toBe(routerHash);
      expect(route.legacy.auth, route.legacy.path).toMatch(/^\['[^']+'\]$/u);
      expect(route.evidence, route.legacy.path).toContain(route.legacy.resolvedComponent);
      expect(route.evidence, route.legacy.path).toContain(route.legacy.behaviorSource);
      expect(route.evidence, route.legacy.path).toContain("view/admin-ts/src/pages/operations/EnterpriseWechat.vue");
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

  it("does not promote API-only, 501, or same-table summaries to complete screens", () => {
    for (const path of [
      "/admin/work/createCode/:id?", "/admin/work/addWelcome/:id?",
      "/admin/work/addAuthGroup/:id?", "/admin/work/client/add_group",
      "/admin/work/client/add_moment", "/admin/work/group/add_template",
      "/admin/work/config", "/admin/work/client/statistical/:id?",
    ]) expect(byPath.get(path)?.status).toBe("missing");
    expect(byPath.get("/admin/work/auth_group")?.status).toBe("missing");
    expect(byPath.get("/admin/work/auth_group")?.targetApis).toContain("GET /adminapi/work/group_chat_auth");
    expect(byPath.get("/admin/work/client/list")?.targetScreens).toEqual(["/operations/work", "/user"]);
    expect(byPath.get("/admin/work/client/list")?.targetPermissions).toEqual(expect.arrayContaining([
      "enterprise_wechat.view", "enterprise_wechat.manage", "user.view",
    ]));
    expect(byPath.get("/admin/work/client/group")?.status).toBe("partial");
    expect(byPath.get("/admin/work/group/template")?.status).toBe("partial");
    expect(byPath.get("/admin/work/group/template")?.targetApis).toContain("GET /adminapi/work/group_template");
    expect(byPath.get("/admin/work/group/template_info/:id?")?.status).toBe("missing");
    expect(byPath.get("/admin/work/config")?.remaining.join(" ")).toMatch(/JS-SDK/u);
    expect(report.methodology.reviewBasis).toMatch(/API without an Admin operation surface/u);
    expect(report.methodology.validationBoundary).toMatch(/No production data/u);
  });

  it("matches the checked-in JSON byte for byte when generated in a single checkout", () => {
    const generated = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/admin-work-frontend-parity-audit.ts"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(generated).toBe(source("audit/admin-legacy-work-route-parity.json"));
  });
});
