import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
type Report = {
  methodology: { scope: string; reviewBasis: string; validationBoundary: string };
  summary: { legacyRoutes: number; reviewed: number; bySource: Record<string, number>; candidate: number; partial: number; missing: number; retired: number; unreviewed: number };
  routes: Route[];
};
const source = (path: string) => readFileSync(path, "utf8");
const inventory = JSON.parse(source("audit/admin-frontend-inventory-20260928.json")) as {
  legacy: { routes: { path: string; surface: string; source: string }[]; routeFiles: { file: string; sha256: string }[] };
};
const report = JSON.parse(source("audit/admin-legacy-user-order-route-parity-20260928.json")) as Report;
const userRouter = "src/router/modules/user.js";
const orderRouter = "src/router/modules/order.js";
const businessRoutes = inventory.legacy.routes.filter((route) => route.surface === "page" && [userRouter, orderRouter].includes(route.source));
const byPath = new Map(report.routes.map((route) => [route.legacy.path, route]));
const otherLedgerFiles = readdirSync("audit").filter((name) =>
  /^admin-legacy-.+-route-parity\.json$/u.test(name) && name !== "admin-legacy-user-order-route-parity.json");

describe("legacy Admin user and order route semantic audit", () => {
  it("reviews exactly the 12 user and 6 order business pages in inventory order", () => {
    expect(businessRoutes).toHaveLength(18);
    expect(report.routes.map((route) => route.legacy.path)).toEqual(businessRoutes.map((route) => route.path));
    expect(report.summary).toEqual({
      legacyRoutes: 18, reviewed: 18, bySource: { [userRouter]: 12, [orderRouter]: 6 },
      candidate: 2, partial: 14, missing: 2, retired: 0, unreviewed: 0,
    });
    expect(report.methodology.scope).toContain("auxiliary components are excluded");
  });

  it("adds 18 unique authority paths without overlapping any other route ledger", () => {
    const authority = new Set(inventory.legacy.routes.filter((route) => route.surface === "page").map((route) => route.path));
    expect(authority.size).toBe(274);
    const own = report.routes.map((route) => route.legacy.path);
    expect(new Set(own).size).toBe(18);
    expect(otherLedgerFiles.length).toBeGreaterThanOrEqual(9);
    const prior = otherLedgerFiles.flatMap((name) => {
      const ledger = JSON.parse(source(`audit/${name}`)) as {
        routes: { legacyPath?: string; legacy?: { path: string } }[];
      };
      return ledger.routes.map((route) => route.legacyPath ?? route.legacy?.path ?? "");
    });
    const priorSet = new Set(prior);
    for (const path of own) {
      expect(authority.has(path), path).toBe(true);
      expect(priorSet.has(path), path).toBe(false);
    }
    expect([...priorSet].every((path) => authority.has(path))).toBe(true);
    expect(prior.length + own.length).toBe(274);
    expect(new Set([...prior, ...own]).size).toBe(priorSet.size + 18);
    expect(new Set([...prior, ...own])).toEqual(authority);
  });

  it("pins both old routers and requires concrete target evidence inside this repository", () => {
    const hashes = new Map(inventory.legacy.routeFiles.map((file) => [file.file, file.sha256]));
    const generator = source("scripts/admin-user-order-frontend-parity-audit.ts");
    expect(generator).not.toMatch(/readFileSync\([^\n]*cinashop-php/u);
    for (const route of report.routes) {
      const router = route.legacy.source.includes("/modules/user.js:") ? userRouter : orderRouter;
      expect(route.legacy.source, route.legacy.path).toMatch(/\.js:\d+$/u);
      expect(route.legacy.routerSha256, route.legacy.path).toBe(hashes.get(router));
      expect(route.legacy.behaviorSource, route.legacy.path).toMatch(/\.vue:\d+$/u);
      expect(route.evidence, route.legacy.path).toContain(route.legacy.resolvedComponent);
      expect(route.evidence, route.legacy.path).toContain(route.legacy.behaviorSource);
      expect(route.legacy.auth, route.legacy.path).toMatch(/^(\['[^']+'\]|none \(commented out\))$/u);
      for (const file of route.evidence.filter((item) => !item.startsWith("cinashop-php/"))) {
        expect(existsSync(resolve("..", file)), `${route.legacy.path}: ${file}`).toBe(true);
      }
      if (route.status === "missing") {
        expect(route.targetScreens, route.legacy.path).toEqual([]);
        expect(route.remaining.length, route.legacy.path).toBeGreaterThan(0);
      } else {
        expect(route.targetScreens.length, route.legacy.path).toBeGreaterThan(0);
        expect(route.targetPermissions.length, route.legacy.path).toBeGreaterThan(0);
        expect(route.covered.length, route.legacy.path).toBeGreaterThan(0);
        expect(route.remaining.length, route.legacy.path).toBeGreaterThan(0);
      }
    }
  });

  it("preserves important semantic distinctions and candidate gates", () => {
    expect(byPath.get("/admin/order/offline")?.status).toBe("candidate");
    expect(byPath.get("/admin/order/offline")?.remaining.join(" ")).toMatch(/真实旧记录/u);
    expect(byPath.get("/admin/order/refund")?.status).toBe("partial");
    expect(byPath.get("/admin/order/refund")?.targetApis).toContain("POST /adminapi/refund/operations/execute/:id");
    expect(byPath.get("/admin/order/refund")?.remaining.join(" ")).toMatch(/410/u);
    expect(byPath.get("/admin/order/invoice/list")?.status).toBe("missing");
    expect(byPath.get("/admin/order/queue/list")?.remaining.join(" ")).toMatch(/只读/u);
    expect(byPath.get("/admin/user/group")?.status).toBe("candidate");
    expect(byPath.get("/admin/user/group")?.targetScreens).toEqual(["/user/groups"]);
    expect(byPath.get("/admin/user/group")?.targetApis).toContain("GET /adminapi/user_group/list");
    expect(byPath.get("/admin/user/group")?.targetApis).toContain("POST /adminapi/user_group/save");
    expect(byPath.get("/admin/user/group")?.targetApis).toContain("DELETE /adminapi/user_group/del/:id");
    expect(byPath.get("/admin/user/group")?.targetPermissions).toEqual(["user.view", "user.manage"]);
    expect(byPath.get("/admin/user/group")?.remaining.join(" ")).toMatch(/真实分组和受限角色/u);
    expect(byPath.get("/admin/user/recharge/:id")?.status).toBe("missing");
    const setup = byPath.get("/admin/user/setup_user");
    expect(setup?.status).toBe("partial");
    expect(setup?.targetScreens).toContain("/config/level-activation");
    expect(setup?.targetApis).toEqual(expect.arrayContaining([
      "GET /adminapi/config/level-activation", "GET /adminapi/config/level-activation/coupons",
      "POST /adminapi/config/level-activation",
    ]));
    expect(setup?.targetPermissions).toContain("config.manage");
    expect(setup?.remaining.join(" ")).toMatch(/基础资料定义编辑.*order_give_exp.*SVIP/u);
    expect(byPath.get("/admin/vipuser/grade/card")?.remaining.join(" ")).toMatch(/历史卡密/u);
    expect(byPath.get("/admin/vipuser/grade/list/:id")?.remaining.join(" ")).toMatch(/历史卡密码永久隐藏/u);
    expect(report.methodology.reviewBasis).toMatch(/API-only stub/u);
    expect(report.methodology.validationBoundary).toMatch(/No production payment/u);
  });

  it("regenerates the checked-in JSON byte for byte", () => {
    const generated = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/admin-user-order-frontend-parity-audit.ts"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(generated).toBe(source("audit/admin-legacy-user-order-route-parity-20260928.json"));
  });

  it("maps the current recharge subdomain without claiming the old generic filter and pager are complete", () => {
    const current = JSON.parse(source("audit/admin-legacy-user-order-route-parity-paid-membership-20260928.json")) as Report;
    expect(current.summary).toEqual({ ...report.summary, partial: 15, missing: 1 });
    const recharge = current.routes.find((route) => route.legacy.path === "/admin/user/recharge/:id");
    expect(recharge?.status).toBe("partial");
    expect(recharge?.targetScreens).toEqual(["/marketing/recharge-options"]);
    expect(recharge?.targetApis).toEqual([
      "GET /adminapi/marketing/recharge-quotas", "GET /adminapi/marketing/recharge-quotas/:id",
      "POST /adminapi/marketing/recharge-quotas", "PUT /adminapi/marketing/recharge-quotas/:id",
      "PUT /adminapi/marketing/recharge-quotas/:id/status", "DELETE /adminapi/marketing/recharge-quotas/:id",
    ]);
    expect(recharge?.targetPermissions).toEqual(["recharge_quota.view", "recharge_quota.manage"]);
    expect(recharge?.covered.join(" ")).toMatch(/user_recharge_quota.*充值金额.*赠送金额/u);
    expect(recharge?.covered.join(" ")).toMatch(/金额快照.*不改写已有订单/u);
    expect(recharge?.remaining.join(" ")).toMatch(/显隐筛选.*20条分页.*100条.*拒绝展示/u);
    expect(recharge?.remaining.join(" ")).toMatch(/任意 gid.*partial/u);
    expect(recharge?.evidence).toContain("view/admin-ts/src/api/rechargeQuota.ts");
    expect(recharge?.evidence).toContain("workers-ts/src/services/payment/RechargeQuotaPolicy.ts");
    for (const file of recharge?.evidence.filter((item) => !item.startsWith("cinashop-php/")) ?? []) {
      expect(existsSync(resolve("..", file)), file).toBe(true);
    }
    expect(current.routes.filter((route) => route.status !== byPath.get(route.legacy.path)?.status)
      .map((route) => route.legacy.path)).toEqual(["/admin/user/recharge/:id"]);
  });

  it("derives the current 274-route totals from ten historical domains and the paid membership review", () => {
    expect(otherLedgerFiles).toHaveLength(10);
    const ledgerFiles = [...otherLedgerFiles, "admin-legacy-user-order-route-parity-paid-membership-20260928.json"];
    const routes = ledgerFiles.flatMap((name) => {
      const ledger = JSON.parse(source(`audit/${name}`)) as {
        routes: { legacyPath?: string; legacy?: { path: string }; status: Route["status"] }[];
      };
      return ledger.routes;
    });
    const paths = routes.map((route) => route.legacyPath ?? route.legacy?.path ?? "");
    expect(paths).toHaveLength(274);
    expect(new Set(paths)).toEqual(new Set(inventory.legacy.routes.filter((route) => route.surface === "page").map((route) => route.path)));
    const counts = { candidate: 0, partial: 0, missing: 0, retired: 0 };
    for (const route of routes) counts[route.status] += 1;
    expect(counts).toEqual({ candidate: 57, partial: 115, missing: 95, retired: 7 });
  });

  it("regenerates only the selected current snapshot and preserves the nine-key report bytes", () => {
    const generated = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/admin-user-order-frontend-parity-audit.ts", "--paid-membership"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(generated).toBe(source("audit/admin-legacy-user-order-route-parity-paid-membership-20260928.json"));
    expect(createHash("sha256").update(readFileSync("audit/admin-legacy-user-order-route-parity-20260928.json")).digest("hex"))
      .toBe("7c4981334726c9d4c11a9d7ff15196ed37ce8161fde58c5b9741db0a7519dac9");
  });

  it("records the invoice Admin screen as partial under its independent permission", () => {
    const invoiceReport = JSON.parse(source("audit/admin-legacy-user-order-route-parity-invoice-admin-20260928.json")) as Report;
    expect(invoiceReport.summary).toEqual({ ...report.summary, partial: 16, missing: 0 });
    const invoice = invoiceReport.routes.find((route) => route.legacy.path === "/admin/order/invoice/list");
    expect(invoice?.status).toBe("partial");
    expect(invoice?.targetScreens).toEqual(["/order/invoice"]);
    expect(invoice?.targetApis).toEqual([
      "GET /adminapi/order/invoices", "GET /adminapi/order/invoices/:id",
      "POST /adminapi/order/invoices/:id/process",
    ]);
    expect(invoice?.targetPermissions).toEqual(["invoice.view", "invoice.manage"]);
    expect(invoice?.remaining.join(" ")).toMatch(/完整订单信息.*order\.view.*0\.00.*partial/u);
    expect(invoice?.evidence).toContain("workers-ts/src/services/admin/AdminInvoiceService.ts");
    expect(invoiceReport.routes.filter((route) => route.status !== byPath.get(route.legacy.path)?.status)
      .map((route) => route.legacy.path)).toEqual(["/admin/order/invoice/list", "/admin/user/recharge/:id"]);
    const generated = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/admin-user-order-frontend-parity-audit.ts", "--invoice-admin"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(generated).toBe(source("audit/admin-legacy-user-order-route-parity-invoice-admin-20260928.json"));
  });

  it("derives the invoice batch's 274-screen distribution without replacing older ledgers", () => {
    const ledgerFiles = [...otherLedgerFiles, "admin-legacy-user-order-route-parity-invoice-admin-20260928.json"];
    const entries = ledgerFiles.flatMap((name) => (JSON.parse(source(`audit/${name}`)) as {
      routes: { legacyPath?: string; legacy?: { path: string }; status: Route["status"] }[];
    }).routes);
    const paths = entries.map((entry) => entry.legacyPath ?? entry.legacy?.path ?? "");
    expect(paths).toHaveLength(274);
    expect(new Set(paths).size).toBe(274);
    const status = { candidate: 0, partial: 0, missing: 0, retired: 0 };
    for (const entry of entries) status[entry.status]++;
    expect(status).toEqual({ candidate: 57, partial: 116, missing: 94, retired: 7 });
  });

  it("records the invoice detail and paid member record follow-up without rewriting the prior review", () => {
    const current = JSON.parse(source("audit/admin-legacy-user-order-route-parity-invoice-followup-20260928.json")) as Report;
    expect(current.summary).toEqual({ ...report.summary, candidate: 3, partial: 15, missing: 0 });
    const invoice = current.routes.find((route) => route.legacy.path === "/admin/order/invoice/list");
    const member = current.routes.find((route) => route.legacy.path === "/admin/vipuser/grade/record");
    expect(invoice?.status).toBe("partial");
    expect(invoice?.targetApis).toContain("GET /adminapi/order/invoices/:id/order-info");
    expect(invoice?.remaining.join(" ")).toMatch(/all 搜索.*历史 0\.00/u);
    expect(member?.status).toBe("candidate");
    expect(member?.covered.join(" ")).toMatch(/上海时间.*卡密.*免费/u);
    const generated = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/admin-user-order-frontend-parity-audit.ts", "--invoice-followup"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(generated).toBe(source("audit/admin-legacy-user-order-route-parity-invoice-followup-20260928.json"));
    const ledgerFiles = [...otherLedgerFiles, "admin-legacy-user-order-route-parity-invoice-followup-20260928.json"];
    const routes = ledgerFiles.flatMap((name) => (JSON.parse(source(`audit/${name}`)) as {
      routes: { legacyPath?: string; legacy?: { path: string }; status: Route["status"] }[];
    }).routes);
    expect(routes).toHaveLength(274);
    expect(new Set(routes.map((entry) => entry.legacyPath ?? entry.legacy?.path ?? "")).size).toBe(274);
    const status = { candidate: 0, partial: 0, missing: 0, retired: 0 };
    for (const entry of routes) status[entry.status]++;
    expect(status).toEqual({ candidate: 58, partial: 115, missing: 94, retired: 7 });
  });
});
