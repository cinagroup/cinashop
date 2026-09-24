import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Route = {
  legacy: { path: string; source: string; resolvedComponent: string; behaviorSource: string; routerSha256: string; auth: string };
  status: "candidate" | "partial" | "missing" | "retired";
  targetScreens: string[];
  targetApis: string[];
  targetPermissions: string[];
  covered: string[];
  remaining: string[];
  evidence: string[];
};
const source = (file: string) => readFileSync(file, "utf8");
const inventory = JSON.parse(source("audit/admin-frontend-inventory.json")) as {
  legacy: { routes: { path: string; source: string; surface: string }[]; routeFiles: { file: string; sha256: string }[] };
};
const report = JSON.parse(source("audit/admin-legacy-cross-module-route-parity.json")) as {
  methodology: { scope: string; reviewBasis: string; validationBoundary: string };
  summary: Record<string, number>;
  routes: Route[];
};
const fileCounts: Record<string, number> = {
  "src/router/routes.js": 2, "src/router/modules/statistic.js": 6,
  "src/router/modules/finance.js": 4, "src/router/modules/echarts.js": 2,
  "src/router/modules/frameOut.js": 1, "src/router/modules/index.js": 1,
  "src/router/modules/system.js": 2,
};
const byPath = new Map(report.routes.map((route) => [route.legacy.path, route]));

describe("legacy Admin cross-module route semantic audit", () => {
  it("reviews exactly the 18 previously unclassified business pages in inventory order", () => {
    const alreadyReviewed = new Set(["/admin/system/log", "/admin/system/user", "/admin/setting/system/create"]);
    const business = inventory.legacy.routes.filter((route) => route.surface === "page" && route.source in fileCounts && !alreadyReviewed.has(route.path)
      && (route.source !== "src/router/modules/frameOut.js" || route.path === "/admin/login")
      && (route.source !== "src/router/modules/system.js" || ["/admin/out", "/admin/out_interface"].includes(route.path)));
    expect(business).toHaveLength(18);
    for (const [file, count] of Object.entries(fileCounts)) expect(business.filter((route) => route.source === file)).toHaveLength(count);
    expect(report.routes.map((route) => route.legacy.path)).toEqual(business.map((route) => route.path));
    expect(report.summary).toEqual({ legacyRoutes: 18, reviewed: 18, candidate: 4, partial: 10, missing: 3, retired: 1, unreviewed: 0 });
  });

  it("keeps nine audit ledgers disjoint inside the 274-page authority", () => {
    const names = ["content", "product", "setting", "marketing", "work", "kefu", "app", "system", "cross-module"];
    const paths = names.flatMap((name) => {
      const ledger = JSON.parse(source(`audit/admin-legacy-${name}-route-parity.json`)) as {
        routes: Array<{ legacyPath?: string; legacy?: { path: string } }>;
      };
      return ledger.routes.map((route) => route.legacyPath ?? route.legacy?.path ?? "");
    });
    const authority = new Set(inventory.legacy.routes.filter((route) => route.surface === "page").map((route) => route.path));
    expect(authority.size).toBe(274);
    expect(paths).toHaveLength(237);
    expect(new Set(paths).size).toBe(237);
    expect(paths.every((path) => authority.has(path))).toBe(true);
  });

  it("pins seven old router snapshots and validates in-repository target evidence", () => {
    const hashes = new Map(inventory.legacy.routeFiles.map((file) => [file.file, file.sha256]));
    const generator = source("scripts/admin-cross-module-frontend-parity-audit.ts");
    expect(generator).not.toMatch(/readFileSync\([^\n]*cinashop-php/u);
    for (const route of report.routes) {
      const router = route.legacy.source.split("cinashop-php/view/admin/")[1]?.split(":")[0];
      expect(router).toBeTruthy();
      expect(route.legacy.routerSha256).toBe(hashes.get(router));
      expect(route.legacy.resolvedComponent).toMatch(/^cinashop-php\/view\/admin\/src\/pages\//u);
      expect(route.legacy.behaviorSource).toMatch(/\.vue:\d+$/u);
      expect(route.legacy.auth).toBeTruthy();
      expect(route.evidence).toContain(route.legacy.behaviorSource);
      expect(route.remaining.length).toBeGreaterThan(0);
      for (const file of route.evidence.filter((item) => !item.startsWith("cinashop-php/"))) {
        expect(existsSync(resolve("..", file)), `${route.legacy.path}: ${file}`).toBe(true);
      }
      if (route.status === "missing" || route.status === "retired") expect(route.targetScreens).toEqual([]);
      else {
        expect(route.targetScreens.length).toBeGreaterThan(0);
        expect(route.targetPermissions.length).toBeGreaterThan(0);
        expect(route.covered.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the live order count partial while retiring only its demo chart and tables", () => {
    expect(byPath.get("/admin/echarts/trade/product")?.status).toBe("retired");
    expect(byPath.get("/admin/echarts/trade/order")?.status).toBe("partial");
    expect(byPath.get("/admin/echarts/trade/order")?.targetScreens).toEqual(["/order", "/statistic"]);
    expect(byPath.get("/admin/echarts/trade/order")?.covered.join(" ")).toMatch(/实时订单状态计数/u);
    expect(byPath.get("/admin/echarts/trade/order")?.remaining.join(" ")).toMatch(/GET \/adminapi\/order\/chart/u);
    expect(byPath.get("/admin/echarts/trade/order")?.remaining.join(" ")).toMatch(/演示|样例/u);
    expect(byPath.has("/admin/system/log")).toBe(false);
    expect(byPath.has("/admin/system/user")).toBe(false);
    expect(byPath.has("/admin/setting/system/create")).toBe(false);
    expect(byPath.get("/admin/finance/user_recharge/index")?.status).toBe("missing");
    expect(byPath.get("/admin/finance/finance/commission")?.status).toBe("missing");
    expect(byPath.get("/admin/statistic/capital")?.status).toBe("candidate");
    expect(byPath.get("/admin/statistic/capital")?.targetScreens).toEqual(["/finance/capital-flow"]);
    expect(byPath.get("/admin/statistic/capital")?.targetPermissions).toEqual(["capital_flow.view/capital_flow.manage"]);
    expect(byPath.get("/admin/statistic/capital")?.targetApis).toContain("GET /adminapi/flow/get_list");
    expect(byPath.get("/admin/statistic/capital")?.targetApis).toContain("POST /adminapi/flow/set_mark/:id");
    expect(byPath.get("/admin/statistic/capital")?.remaining.join(" ")).toMatch(/真实角色/u);
    expect(byPath.get("/admin/finance/finance/bill")?.targetScreens).toEqual(["/finance/bill"]);
    expect(byPath.get("/admin/login")?.status).toBe("partial");
    expect(byPath.get("/")?.status).toBe("partial");
    expect(byPath.get("/")?.targetScreens).toEqual(["/dashboard"]);
    expect(byPath.get("/admin/out")?.targetScreens).toEqual(["/system/out"]);
    expect(byPath.get("/admin/out")?.remaining.join(" ")).toMatch(/推送/u);
    expect(byPath.get("/admin/out_interface")?.targetScreens).toEqual(["/system/out"]);
    expect(byPath.get("/admin/out_interface")?.remaining.join(" ")).toMatch(/只读/u);
    expect(report.methodology.reviewBasis).toMatch(/API-only/u);
    expect(report.methodology.validationBoundary).toMatch(/no real-role browser E2E/u);
  });

  it("regenerates the checked-in JSON byte for byte", () => {
    const generated = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/admin-cross-module-frontend-parity-audit.ts"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(generated).toBe(source("audit/admin-legacy-cross-module-route-parity.json"));
  });
});
