import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Route = {
  legacy: { path: string; resolvedComponent: string; behaviorSource: string; source: string; routerSha256: string; parentAuth: string | null; auth: string };
  status: "candidate" | "partial" | "missing" | "retired";
  targetScreens: string[]; targetApis: string[]; targetPermissions: string[];
  covered: string[]; remaining: string[]; evidence: string[];
};
type Report = { summary: Record<string, number>; methodology: Record<string, string>; routes: Route[] };
const source = (path: string) => readFileSync(path, "utf8");
const inventory = JSON.parse(source("audit/admin-frontend-inventory.json")) as {
  legacy: { routes: { source: string; surface: string; path: string }[]; routeFiles: { file: string; sha256: string }[] };
};
const report = JSON.parse(source("audit/admin-legacy-supplier-agent-route-parity.json")) as Report;
const routers = ["src/router/modules/supplier.js", "src/router/modules/agent.js"];
const businessPaths = inventory.legacy.routes.filter((route) => route.surface === "page" && routers.includes(route.source)).map((route) => route.path);
const byPath = new Map(report.routes.map((route) => [route.legacy.path, route]));

describe("legacy Admin supplier and agent route parity audit", () => {
  it("reviews precisely the 11 supplier and 8 agent business pages in inventory order", () => {
    expect(businessPaths).toHaveLength(19);
    expect(report.routes.map((route) => route.legacy.path)).toEqual(businessPaths);
    expect(report.summary).toEqual({ legacyRoutes: 19, reviewed: 19, candidate: 0, partial: 10, missing: 9, retired: 0, unreviewed: 0 });
    expect(businessPaths).not.toContain("/admin/supplier/finance/set");
  });

  it("adds 19 disjoint paths to the other ten reviewed ledgers", () => {
    const priorNames = ["content", "product", "setting", "marketing", "work", "app", "kefu", "system", "cross-module", "user-order"];
    const priorPaths = priorNames.flatMap((name) => {
      const ledger = JSON.parse(source(`audit/admin-legacy-${name}-route-parity.json`)) as { routes: { legacy?: { path: string }; legacyPath?: string }[] };
      return ledger.routes.map((route) => route.legacy?.path ?? route.legacyPath ?? "");
    });
    const currentPaths = report.routes.map((route) => route.legacy.path);
    const authority = new Set(inventory.legacy.routes.filter((route) => route.surface === "page").map((route) => route.path));
    expect(authority.size).toBe(274);
    expect(priorPaths).toHaveLength(255);
    expect(new Set(priorPaths).size).toBe(255);
    expect(currentPaths).toHaveLength(19);
    expect(new Set([...priorPaths, ...currentPaths]).size).toBe(274);
    expect([...priorPaths, ...currentPaths].every((path) => authority.has(path))).toBe(true);
  });

  it("pins old router hashes and auth while validating current-repo evidence", () => {
    expect(new Set(report.routes.map((route) => route.legacy.path)).size).toBe(19);
    for (const route of report.routes) {
      const router = route.legacy.source.includes("/supplier.js:") ? routers[0] : routers[1];
      const hash = inventory.legacy.routeFiles.find((item) => item.file === router)?.sha256;
      expect(hash).toMatch(/^[a-f0-9]{64}$/u);
      expect(route.legacy.routerSha256, route.legacy.path).toBe(hash);
      expect(route.legacy.source, route.legacy.path).toMatch(/cinashop-php\/view\/admin\/src\/router\/modules\/(supplier|agent)\.js:\d+$/u);
      expect(route.legacy.resolvedComponent, route.legacy.path).toMatch(/^cinashop-php\/view\/admin\/src\/pages\/.+\.vue$/u);
      expect(route.legacy.behaviorSource, route.legacy.path).toMatch(/\.vue:\d+$/u);
      expect(route.legacy.parentAuth, route.legacy.path).toBe(router === routers[1] ? "true" : null);
      expect(route.legacy.auth, route.legacy.path).toMatch(/^\['[^']+'\]$/u);
      expect(route.evidence, route.legacy.path).toContain(route.legacy.resolvedComponent);
      expect(route.evidence, route.legacy.path).toContain(route.legacy.behaviorSource);
      expect(route.remaining.length, route.legacy.path).toBeGreaterThan(0);
      for (const file of route.evidence.filter((item) => !item.startsWith("cinashop-php/"))) {
        expect(existsSync(resolve("..", file)), `${route.legacy.path}: ${file}`).toBe(true);
      }
      if (route.status === "missing") {
        expect(route.targetScreens, route.legacy.path).toEqual([]);
        expect(route.covered, route.legacy.path).toEqual([]);
      } else {
        expect(route.targetScreens.length, route.legacy.path).toBeGreaterThan(0);
        expect(route.covered.length, route.legacy.path).toBeGreaterThan(0);
        expect(route.targetPermissions.length, route.legacy.path).toBeGreaterThan(0);
      }
    }
    expect(source("scripts/admin-supplier-agent-frontend-parity-audit.ts")).not.toMatch(/readFileSync\([^\n]*cinashop-php/u);
  });

  it("keeps same-named routes, data entities and API-only coverage separate", () => {
    const missing = [
      "/admin/supplier/supplier/index", "/admin/supplier/menu/list", "/admin/supplier/supplierAdd/:id?",
      "/admin/supplier/orderStatistics/index", "/admin/supplier/capital/index", "/admin/supplier/bill/index",
      "/admin/supplier/bill/index/:type?", "/admin/agent/agreement", "/admin/agent/promoter/apply",
    ];
    for (const path of missing) expect(byPath.get(path)?.status, path).toBe("missing");
    expect(byPath.get("/admin/supplier/supplier/index")?.remaining.join(" ")).toMatch(/菜单\/规则树/u);
    expect(byPath.get("/admin/supplier/menu/list")?.remaining.join(" ")).toMatch(/供应商目录/u);
    expect(byPath.get("/admin/supplier/bill/index/:type?")?.remaining.join(" ")).toMatch(/fund_record/u);
    expect(byPath.get("/admin/agent/agreement")?.remaining.join(" ")).toMatch(/type=2/u);
    const promoter = byPath.get("/admin/agent/promoter/apply");
    expect(promoter?.targetApis).toContain("GET /adminapi/promoter/apply/examine/:id/:uid/:status");
    expect(promoter?.targetPermissions).toContain("distribution.manage");
    expect(promoter?.targetScreens).toEqual([]);
    expect(promoter?.remaining.join(" ")).toMatch(/本地候选修复.*distribution\.manage/u);
    expect(byPath.get("/admin/agent/statistics")?.remaining.join(" ")).toMatch(/trend API/u);
    expect(byPath.get("/admin/supplier/cash/index")?.remaining.join(" ")).toMatch(/mark API/u);
  });

  it("reproduces the checked-in JSON byte for byte in a single checkout", () => {
    const generated = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/admin-supplier-agent-frontend-parity-audit.ts"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(generated).toBe(source("audit/admin-legacy-supplier-agent-route-parity.json"));
  });
});
