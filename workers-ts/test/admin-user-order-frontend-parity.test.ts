import { execFileSync } from "node:child_process";
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
const inventory = JSON.parse(source("audit/admin-frontend-inventory.json")) as {
  legacy: { routes: { path: string; surface: string; source: string }[]; routeFiles: { file: string; sha256: string }[] };
};
const report = JSON.parse(source("audit/admin-legacy-user-order-route-parity.json")) as Report;
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
      candidate: 1, partial: 14, missing: 3, retired: 0, unreviewed: 0,
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

  it("preserves important semantic distinctions and the only candidate gate", () => {
    expect(byPath.get("/admin/order/offline")?.status).toBe("candidate");
    expect(byPath.get("/admin/order/offline")?.remaining.join(" ")).toMatch(/真实旧记录/u);
    expect(byPath.get("/admin/order/refund")?.status).toBe("partial");
    expect(byPath.get("/admin/order/refund")?.targetApis).toContain("POST /adminapi/refund/operations/execute/:id");
    expect(byPath.get("/admin/order/refund")?.remaining.join(" ")).toMatch(/410/u);
    expect(byPath.get("/admin/order/invoice/list")?.status).toBe("missing");
    expect(byPath.get("/admin/order/queue/list")?.remaining.join(" ")).toMatch(/只读/u);
    expect(byPath.get("/admin/user/group")?.status).toBe("missing");
    expect(byPath.get("/admin/user/group")?.targetApis).toContain("GET /adminapi/user_group/list");
    expect(byPath.get("/admin/user/recharge/:id")?.status).toBe("missing");
    expect(byPath.get("/admin/vipuser/grade/card")?.remaining.join(" ")).toMatch(/历史卡密/u);
    expect(byPath.get("/admin/vipuser/grade/list/:id")?.remaining.join(" ")).toMatch(/历史卡密码永久隐藏/u);
    expect(report.methodology.reviewBasis).toMatch(/API-only stub/u);
    expect(report.methodology.validationBoundary).toMatch(/No production payment/u);
  });

  it("regenerates the checked-in JSON byte for byte", () => {
    const generated = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/admin-user-order-frontend-parity-audit.ts"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(generated).toBe(source("audit/admin-legacy-user-order-route-parity.json"));
  });
});
