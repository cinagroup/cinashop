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
const source = (path: string) => readFileSync(path, "utf8");
const inventory = JSON.parse(source("audit/admin-frontend-inventory.json")) as {
  legacy: { routes: { path: string; source: string; surface: string }[]; routeFiles: { file: string; sha256: string }[] };
};
const report = JSON.parse(source("audit/admin-legacy-kefu-route-parity.json")) as {
  methodology: { scope: string; reviewBasis: string; validationBoundary: string };
  summary: Record<string, number>;
  routes: Route[];
};
const businessPaths = inventory.legacy.routes
  .filter((route) => route.surface === "page" && route.source === "src/router/modules/frameOut.js" && route.path.startsWith("/kefu"))
  .map((route) => route.path);
const byPath = new Map(report.routes.map((route) => [route.legacy.path, route]));

describe("legacy Admin inventory kefu route semantic audit", () => {
  it("reviews exactly the 13 frameOut kefu business pages in inventory order", () => {
    expect(businessPaths).toHaveLength(13);
    expect(report.routes.map((route) => route.legacy.path)).toEqual(businessPaths);
    expect(report.summary).toEqual({ legacyRoutes: 13, reviewed: 13, candidate: 1, partial: 12, missing: 0, retired: 0, unreviewed: 0 });
    expect(inventory.legacy.routes.find((route) => route.path === "/admin/kefu/setup")?.surface).toBe("auxiliary");
  });

  it("keeps six ledgers disjoint and within the 274-page authority", () => {
    const content = JSON.parse(source("audit/admin-legacy-content-route-parity.json")) as { routes: { legacyPath: string }[] };
    const product = JSON.parse(source("audit/admin-legacy-product-route-parity.json")) as { routes: { legacyPath: string }[] };
    const setting = JSON.parse(source("audit/admin-legacy-setting-route-parity.json")) as { routes: { legacy: { path: string } }[] };
    const marketing = JSON.parse(source("audit/admin-legacy-marketing-route-parity.json")) as { routes: { legacy: { path: string } }[] };
    const work = JSON.parse(source("audit/admin-legacy-work-route-parity.json")) as { routes: { legacy: { path: string } }[] };
    const paths = [
      ...content.routes.map((route) => route.legacyPath), ...product.routes.map((route) => route.legacyPath),
      ...setting.routes.map((route) => route.legacy.path), ...marketing.routes.map((route) => route.legacy.path),
      ...work.routes.map((route) => route.legacy.path), ...report.routes.map((route) => route.legacy.path),
    ];
    const authority = new Set(inventory.legacy.routes.filter((route) => route.surface === "page").map((route) => route.path));
    expect(authority.size).toBe(274);
    expect(paths).toHaveLength(182);
    expect(new Set(paths).size).toBe(182);
    expect(paths.every((path) => authority.has(path))).toBe(true);
  });

  it("pins old provenance and validates in-repository target evidence", () => {
    const hash = inventory.legacy.routeFiles.find((file) => file.file === "src/router/modules/frameOut.js")?.sha256;
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    const generator = source("scripts/admin-kefu-frontend-parity-audit.ts");
    expect(generator).not.toMatch(/readFileSync\([^\n]*cinashop-php/u);
    expect(new Set(report.routes.map((route) => route.legacy.path)).size).toBe(13);
    for (const route of report.routes) {
      expect(route.legacy.resolvedComponent, route.legacy.path).toContain("cinashop-php/view/admin/src/pages/kefu/");
      expect(route.legacy.source, route.legacy.path).toMatch(/frameOut\.js:\d+$/u);
      expect(route.legacy.behaviorSource, route.legacy.path).toMatch(/\.vue:\d+$/u);
      expect(route.legacy.routerSha256).toBe(hash);
      expect(route.legacy.auth).toBe("auth: true; kefu: true");
      expect(route.evidence).toContain(route.legacy.behaviorSource);
      expect(route.targetScreens.length).toBeGreaterThan(0);
      expect(route.covered.length).toBeGreaterThan(0);
      expect(route.remaining.length).toBeGreaterThan(0);
      expect(route.targetPermissions.length).toBeGreaterThan(0);
      for (const file of route.evidence.filter((item) => !item.startsWith("cinashop-php/"))) {
        expect(existsSync(resolve("..", file)), `${route.legacy.path}: ${file}`).toBe(true);
      }
    }
  });

  it("does not mistake Admin 501, customer-side chat, or anonymous feedback for full parity", () => {
    const adminController = source("src/controllers/api/v1/AdminController.ts");
    expect(adminController).toContain("管理员不能读取客服私有会话");
    expect(adminController).toContain("管理员不能发送客服消息");
    expect(byPath.get("/kefu/pc_list")?.targetScreens).toEqual(["/workbench"]);
    expect(byPath.get("/kefu/pc_list")?.status).toBe("partial");
    expect(byPath.get("/kefu/appChat")?.targetScreens).toEqual(["/service"]);
    expect(byPath.get("/kefu/mobile_user_chat")?.targetScreens).toEqual(["/pages/user/kefu"]);
    expect(byPath.get("/kefu/mobile_feedback")?.status).toBe("partial");
    expect(byPath.get("/kefu/mobile_feedback")?.remaining.join(" ")).toMatch(/游客|匿名/u);
    expect(byPath.get("/kefu/orderDelivery/:id?/:orderId?")?.targetApis).toContain("PUT /kefuapi/order/split_delivery/:id");
    expect(report.methodology.reviewBasis).toMatch(/501/u);
    expect(report.methodology.validationBoundary).toMatch(/No real-role browser E2E/u);
  });

  it("matches checked-in JSON byte for byte when generated in this checkout", () => {
    const generated = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/admin-kefu-frontend-parity-audit.ts"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(generated).toBe(source("audit/admin-legacy-kefu-route-parity.json"));
  });
});
