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
const report = JSON.parse(source("audit/admin-legacy-system-route-parity.json")) as Report;
const businessPaths = inventory.legacy.routes
  .filter((route) => route.surface === "page" && route.path.startsWith("/admin/system"))
  .map((route) => route.path);
const byPath = new Map(report.routes.map((route) => [route.legacy.path, route]));

describe("legacy Admin system route semantic audit", () => {
  it("reviews exactly the 17 system business pages in inventory order", () => {
    expect(businessPaths).toHaveLength(17);
    expect(report.routes.map((route) => route.legacy.path)).toEqual(businessPaths);
    expect(report.summary).toEqual({
      legacyRoutes: 17, reviewed: 17, candidate: 0, partial: 4,
      missing: 12, retired: 1, unreviewed: 0,
    });
    expect(report.methodology.scope).toContain("/admin/system.User/list.html is auxiliary");
  });

  it("keeps six semantic ledgers disjoint within the 274-page authority", () => {
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
    expect(paths).toHaveLength(186);
    expect(new Set(paths).size).toBe(186);
    expect(paths.every((path) => authority.has(path))).toBe(true);
  });

  it("pins both old routers and requires in-repository target evidence", () => {
    const routerHashes = new Map(inventory.legacy.routeFiles.map((file) => [file.file, file.sha256]));
    const generator = source("scripts/admin-system-frontend-parity-audit.ts");
    expect(generator).not.toMatch(/readFileSync\([^\n]*cinashop-php/u);
    expect(new Set(report.routes.map((route) => route.legacy.path)).size).toBe(17);
    for (const route of report.routes) {
      const router = route.legacy.source.includes("/modules/system.js:") ? "src/router/modules/system.js" : "src/router/routes.js";
      expect(route.legacy.source, route.legacy.path).toMatch(/\.js:\d+$/u);
      expect(route.legacy.routerSha256, route.legacy.path).toBe(routerHashes.get(router));
      expect(route.legacy.behaviorSource, route.legacy.path).toMatch(/\.vue:\d+$/u);
      expect(route.evidence, route.legacy.path).toContain(route.legacy.resolvedComponent);
      expect(route.evidence, route.legacy.path).toContain(route.legacy.behaviorSource);
      expect(route.legacy.auth, route.legacy.path).toMatch(/^(true|\['[^']+'\])$/u);
      for (const file of route.evidence.filter((item) => !item.startsWith("cinashop-php/"))) {
        expect(existsSync(resolve("..", file)), `${route.legacy.path}: ${file}`).toBe(true);
      }
      if (route.status === "missing") expect(route.targetScreens, route.legacy.path).toEqual([]);
      if (route.status === "partial") {
        expect(route.targetScreens.length, route.legacy.path).toBeGreaterThan(0);
        expect(route.targetPermissions.length, route.legacy.path).toBeGreaterThan(0);
        expect(route.remaining.length, route.legacy.path).toBeGreaterThan(0);
      }
    }
  });

  it("distinguishes frontend logs, API-only config, read-only timers, and the inert upgrade mock", () => {
    expect(byPath.get("/admin/system/log")?.status).toBe("missing");
    expect(byPath.get("/admin/system/log")?.remaining.join(" ")).toMatch(/Vuex/u);
    expect(byPath.get("/admin/system/maintain/system_log/index")?.status).toBe("partial");
    expect(byPath.get("/admin/system/config/system_config_tab/index")?.status).toBe("missing");
    expect(byPath.get("/admin/system/config/system_config_tab/index")?.targetApis).toContain("GET /adminapi/config_class");
    expect(byPath.get("/admin/system/crontab")?.status).toBe("partial");
    expect(byPath.get("/admin/system/crontab/create/:id?")?.status).toBe("missing");
    expect(byPath.get("/admin/system/system_upgradeclient/index")?.status).toBe("retired");
    expect(byPath.get("/admin/system/system_upgradeclient/index")?.covered.join(" ")).toMatch(/2020-07-15/u);
    expect(report.methodology.reviewBasis).toMatch(/API-only endpoint/u);
    expect(report.methodology.validationBoundary).toMatch(/No production role/u);
  });

  it("regenerates the checked-in JSON byte for byte", () => {
    const generated = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/admin-system-frontend-parity-audit.ts"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(generated).toBe(source("audit/admin-legacy-system-route-parity.json"));
  });
});
