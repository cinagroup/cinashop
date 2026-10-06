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
    expect(report.summary).toEqual({ legacyRoutes: 19, reviewed: 19, candidate: 1, partial: 10, missing: 8, retired: 0, unreviewed: 0 });
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
      "/admin/supplier/bill/index/:type?", "/admin/agent/agreement",
    ];
    for (const path of missing) expect(byPath.get(path)?.status, path).toBe("missing");
    expect(byPath.get("/admin/supplier/supplier/index")?.remaining.join(" ")).toMatch(/菜单\/规则树/u);
    expect(byPath.get("/admin/supplier/menu/list")?.remaining.join(" ")).toMatch(/供应商目录/u);
    expect(byPath.get("/admin/supplier/bill/index/:type?")?.remaining.join(" ")).toMatch(/fund_record/u);
    expect(byPath.get("/admin/agent/agreement")?.remaining.join(" ")).toMatch(/type=2/u);
    const promoter = byPath.get("/admin/agent/promoter/apply");
    expect(promoter?.status).toBe("candidate");
    expect(promoter?.targetApis).toContain("POST /adminapi/promoter/apply/examine/:id/:uid/:status");
    expect(promoter?.targetApis).not.toContain("GET /adminapi/promoter/apply/examine/:id/:uid/:status");
    expect(promoter?.targetPermissions).toContain("distribution.manage");
    expect(promoter?.targetScreens).toEqual(["/agent/promoter-applications"]);
    expect(promoter?.covered.join(" ")).toContain("行版本");
    expect(promoter?.remaining.join(" ")).toContain("旧GET审核");
    expect(promoter?.remaining.join(" ")).toContain("受限角色");
    expect(byPath.get("/admin/agent/statistics")?.remaining.join(" ")).toMatch(/trend API/u);
    expect(byPath.get("/admin/supplier/cash/index")?.remaining.join(" ")).toMatch(/mark API/u);
  });

  it("reproduces the checked-in JSON byte for byte in a single checkout", () => {
    const generated = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/admin-supplier-agent-frontend-parity-audit.ts"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(generated).toBe(source("audit/admin-legacy-supplier-agent-route-parity.json"));
  });

  it("keeps the dated statistics follow-up scoped to the one old screen", () => {
    const datedFile = "audit/admin-legacy-supplier-agent-route-parity-division-statistics-followup-20260928.json";
    const followup = JSON.parse(source(datedFile)) as Report;
    expect(followup.summary).toEqual(report.summary);
    expect(followup.routes.map((route) => route.legacy.path)).toEqual(report.routes.map((route) => route.legacy.path));
    const original = new Map(report.routes.map((route) => [route.legacy.path, route]));
    for (const route of followup.routes) {
      const before = original.get(route.legacy.path);
      expect(before).toBeDefined();
      if (route.legacy.path !== "/admin/agent/statistics") expect(route).toEqual(before);
    }
    const statistics = followup.routes.find((route) => route.legacy.path === "/admin/agent/statistics")!;
    expect(statistics.status).toBe("partial");
    expect(statistics.targetScreens).toEqual(["/division/statistics"]);
    expect(statistics.targetApis).toEqual([
      "GET /adminapi/agent/division/statistics-screen/summary",
      "GET /adminapi/agent/division/statistics-screen/trend",
      "GET /adminapi/agent/division/statistics-screen/ranking",
    ]);
    expect(statistics.targetPermissions).toEqual(["division_statistics.view"]);
    expect(statistics.remaining.join(" ")).toContain("跨事业部");
    const generated = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/admin-supplier-agent-frontend-parity-audit.ts", "--division-statistics-followup"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(generated).toBe(source(datedFile));
  });

  it("reconciles the supplier bill follow-up without rewriting prior snapshots", () => {
    const priorFile = "audit/admin-legacy-supplier-agent-route-parity-division-statistics-followup-20260928.json";
    const datedFile = "audit/admin-legacy-supplier-agent-route-parity-supplier-bill-followup-20260928.json";
    const prior = JSON.parse(source(priorFile)) as Report;
    const followup = JSON.parse(source(datedFile)) as Report;
    expect(followup.summary).toEqual({ legacyRoutes: 19, reviewed: 19, candidate: 3, partial: 10, missing: 6, retired: 0, unreviewed: 0 });
    expect(followup.routes.map((route) => route.legacy.path)).toEqual(prior.routes.map((route) => route.legacy.path));
    const before = new Map(prior.routes.map((route) => [route.legacy.path, route]));
    const changed = followup.routes.filter((route) => JSON.stringify(route) !== JSON.stringify(before.get(route.legacy.path)));
    expect(changed.map((route) => route.legacy.path).sort()).toEqual([
      "/admin/agent/apply_list",
      "/admin/supplier/apply",
      "/admin/supplier/bill/index",
      "/admin/supplier/bill/index/:type?",
    ]);
    for (const path of ["/admin/supplier/bill/index", "/admin/supplier/bill/index/:type?"]) {
      const bill = followup.routes.find((route) => route.legacy.path === path)!;
      expect(bill.status).toBe("candidate");
      expect(bill.targetScreens).toEqual(["/supplier/bills"]);
      expect(bill.targetPermissions).toEqual(["supplier_bill.view"]);
      expect(bill.targetApis).toContain("GET /adminapi/supplier/bill-screen/export");
      expect(bill.remaining.join(" ")).toContain("导出");
    }
    expect(followup.routes.find((route) => route.legacy.path === "/admin/supplier/apply")?.status).toBe("partial");
    expect(followup.routes.find((route) => route.legacy.path === "/admin/agent/apply_list")?.status).toBe("partial");
    const adminRoutes = source("src/routes/adminapi.ts");
    expect(adminRoutes).not.toContain('adminapiRoutes.get("/supplier/flowing_water/fund_record"');
    expect(adminRoutes).not.toContain('adminapiRoutes.get("/supplier/flowing_water/fund_record_info"');
    expect(adminRoutes).not.toContain('adminapiRoutes.get("/export/supplierWaterRecord"');
    const generated = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/admin-supplier-agent-frontend-parity-audit.ts", "--supplier-bill-followup"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(generated).toBe(source(datedFile));
  });

  it("adds only the supplier capital-flow screen to the next dated ledger", () => {
    const priorFile = "audit/admin-legacy-supplier-agent-route-parity-supplier-bill-followup-20260928.json";
    const datedFile = "audit/admin-legacy-supplier-agent-route-parity-supplier-capital-followup-20260928.json";
    const prior = JSON.parse(source(priorFile)) as Report;
    const followup = JSON.parse(source(datedFile)) as Report;
    expect(followup.summary).toEqual({ legacyRoutes: 19, reviewed: 19, candidate: 4, partial: 10, missing: 5, retired: 0, unreviewed: 0 });
    const before = new Map(prior.routes.map((route) => [route.legacy.path, route]));
    const changed = followup.routes.filter((route) => JSON.stringify(route) !== JSON.stringify(before.get(route.legacy.path)));
    expect(changed.map((route) => route.legacy.path)).toEqual(["/admin/supplier/capital/index"]);
    const capital = changed[0];
    expect(capital.status).toBe("candidate");
    expect(capital.targetScreens).toEqual(["/supplier/capital-flow"]);
    expect(capital.targetPermissions).toEqual(["supplier_capital.view", "supplier_capital.manage"]);
    expect(capital.targetApis).toContain("PUT /adminapi/supplier/capital-screen/remark/:id");
    expect(capital.remaining.join(" ")).toContain("系统血缘");
    const generated = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/admin-supplier-agent-frontend-parity-audit.ts", "--supplier-capital-followup"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(generated).toBe(source(datedFile));
  });

  it("adds only the supplier order statistics screen to its dated ledger", () => {
    const priorFile = "audit/admin-legacy-supplier-agent-route-parity-supplier-capital-followup-20260928.json";
    const datedFile = "audit/admin-legacy-supplier-agent-route-parity-supplier-order-statistics-followup-20260928.json";
    const prior = JSON.parse(source(priorFile)) as Report;
    const followup = JSON.parse(source(datedFile)) as Report;
    expect(followup.summary).toEqual({ legacyRoutes: 19, reviewed: 19, candidate: 5, partial: 10, missing: 4, retired: 0, unreviewed: 0 });
    const before = new Map(prior.routes.map((route) => [route.legacy.path, route]));
    const changed = followup.routes.filter((route) => JSON.stringify(route) !== JSON.stringify(before.get(route.legacy.path)));
    expect(changed.map((route) => route.legacy.path)).toEqual(["/admin/supplier/orderStatistics/index"]);
    const statistics = changed[0];
    expect(statistics.status).toBe("candidate");
    expect(statistics.targetScreens).toEqual(["/supplier/order-statistics"]);
    expect(statistics.targetPermissions).toEqual(["supplier_order_statistics.view"]);
    expect(statistics.targetApis).toContain("GET /adminapi/supplier/order-statistics-screen/supplier-table");
    expect(statistics.covered.join(" ")).toContain("pid>=0");
    expect(statistics.remaining.join(" ")).toContain("旧供应商表忽略 supplier_id");
    const generated = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/admin-supplier-agent-frontend-parity-audit.ts", "--supplier-order-statistics-followup"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(generated).toBe(source(datedFile));
  });

  it("adds only the supplier cash screen to its dated ledger", () => {
    const priorFile = "audit/admin-legacy-supplier-agent-route-parity-supplier-order-statistics-followup-20260928.json";
    const datedFile = "audit/admin-legacy-supplier-agent-route-parity-supplier-cash-followup-20260928.json";
    const prior = JSON.parse(source(priorFile)) as Report;
    const followup = JSON.parse(source(datedFile)) as Report;
    expect(followup.summary).toEqual({ legacyRoutes: 19, reviewed: 19, candidate: 6, partial: 9, missing: 4, retired: 0, unreviewed: 0 });
    const before = new Map(prior.routes.map((route) => [route.legacy.path, route]));
    const changed = followup.routes.filter((route) => JSON.stringify(route) !== JSON.stringify(before.get(route.legacy.path)));
    expect(changed.map((route) => route.legacy.path)).toEqual(["/admin/supplier/cash/index"]);
    const cash = changed[0];
    expect(cash.status).toBe("candidate");
    expect(cash.targetScreens).toEqual(["/finance/supplier-extract"]);
    expect(cash.targetPermissions).toEqual(["supplier_extract.view", "supplier_extract.manage"]);
    expect(cash.targetApis).toContain("GET /adminapi/supplier/extract/suppliers");
    expect(cash.covered.join(" ")).toContain("supplier_extract.view/manage 分离");
    expect(cash.remaining.join(" ")).toContain("旧动态转账表单");
    const generated = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/admin-supplier-agent-frontend-parity-audit.ts", "--supplier-cash-followup"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(generated).toBe(source(datedFile));
  });

  it("records the supplier application, directory form and agent agreement follow-up", () => {
    const prior = JSON.parse(source("audit/admin-legacy-supplier-agent-route-parity-supplier-cash-followup-20260928.json")) as Report;
    const datedFile = "audit/admin-legacy-supplier-agent-route-parity-supplier-closure-followup-20260928.json";
    const followup = JSON.parse(source(datedFile)) as Report;
    expect(followup.summary).toEqual({ legacyRoutes: 19, reviewed: 19, candidate: 9,
      partial: 9, missing: 1, retired: 0, unreviewed: 0 });
    const before = new Map(prior.routes.map((route) => [route.legacy.path, route]));
    const changed = followup.routes.filter((route) => JSON.stringify(route) !== JSON.stringify(before.get(route.legacy.path)));
    expect(changed.map((route) => route.legacy.path)).toEqual([
      "/admin/agent/agreement",
      "/admin/supplier/apply", "/admin/supplier/menu/list", "/admin/supplier/supplierAdd/:id?",
    ]);
    expect(changed.map((route) => route.status)).toEqual(["candidate", "candidate", "partial", "candidate"]);
    expect(changed[1].targetPermissions).toEqual(["supplier_application.view", "supplier_application.manage"]);
    expect(changed[2].remaining.join(" ")).toContain("快捷登录");
    expect(changed[0].targetPermissions).toEqual(["agent_agreement.view", "agent_agreement.manage"]);
    const generated = execFileSync(process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/admin-supplier-agent-frontend-parity-audit.ts", "--supplier-closure-followup"],
      { cwd: process.cwd(), encoding: "utf8" });
    expect(generated).toBe(source(datedFile));
  });

  it("keeps the supplier menu rules screen partial while only the read contract is visible", () => {
    const prior = JSON.parse(source("audit/admin-legacy-supplier-agent-route-parity-supplier-closure-followup-20260928.json")) as Report;
    const datedFile = "audit/admin-legacy-supplier-agent-route-parity-supplier-menu-followup-20260928.json";
    const followup = JSON.parse(source(datedFile)) as Report;
    expect(followup.summary).toEqual({ legacyRoutes: 19, reviewed: 19, candidate: 9,
      partial: 10, missing: 0, retired: 0, unreviewed: 0 });
    const before = new Map(prior.routes.map((route) => [route.legacy.path, route]));
    const changed = followup.routes.filter((route) => JSON.stringify(route) !== JSON.stringify(before.get(route.legacy.path)));
    expect(changed.map((route) => route.legacy.path)).toEqual(["/admin/supplier/supplier/index"]);
    expect(changed[0].status).toBe("partial");
    expect(changed[0].targetScreens).toEqual(["/supplier/menu-rules"]);
    expect(changed[0].targetPermissions).toEqual(["supplier_menu_rules.view"]);
    expect(changed[0].remaining.join(" ")).toContain("新导航不由 system_menus 生成");
    const generated = execFileSync(process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/admin-supplier-agent-frontend-parity-audit.ts", "--supplier-menu-followup"],
      { cwd: process.cwd(), encoding: "utf8" });
    expect(generated).toBe(source(datedFile));
  });
});
