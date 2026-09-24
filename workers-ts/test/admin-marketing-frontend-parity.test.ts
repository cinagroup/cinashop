import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Route = {
  legacy: { path: string; resolvedComponent: string; source: string; routerSha256: string; auth: string };
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
const report = JSON.parse(source("audit/admin-legacy-marketing-route-parity.json")) as Report;
const businessPaths = inventory.legacy.routes
  .filter((route) => route.surface === "page" && route.path.startsWith("/admin/marketing"))
  .map((route) => route.path);

describe("legacy Admin marketing route parity audit", () => {
  it("reviews the exact 48 business pages and excludes four auxiliary routes", () => {
    expect(businessPaths).toHaveLength(48);
    expect(inventory.legacy.routes.filter((route) => route.path.startsWith("/admin/marketing"))).toHaveLength(52);
    expect(report.routes.map((route) => route.legacy.path)).toEqual(businessPaths);
    expect(report.summary).toEqual({
      legacyRoutes: 48, reviewed: 48, candidate: 4, partial: 22,
      missing: 22, retired: 0, unreviewed: 0,
    });
  });

  it("keeps the four reviewed ledgers disjoint and inside the 274-page authority", () => {
    const content = JSON.parse(source("audit/admin-legacy-content-route-parity.json")) as { routes: { legacyPath: string }[] };
    const product = JSON.parse(source("audit/admin-legacy-product-route-parity.json")) as { routes: { legacyPath: string }[] };
    const setting = JSON.parse(source("audit/admin-legacy-setting-route-parity.json")) as { routes: { legacy: { path: string } }[] };
    const paths = [
      ...content.routes.map((route) => route.legacyPath),
      ...product.routes.map((route) => route.legacyPath),
      ...setting.routes.map((route) => route.legacy.path),
      ...report.routes.map((route) => route.legacy.path),
    ];
    const authority = new Set(inventory.legacy.routes.filter((route) => route.surface === "page").map((route) => route.path));
    expect(authority.size).toBe(274);
    expect(paths).toHaveLength(149);
    expect(new Set(paths).size).toBe(149);
    expect(paths.every((path) => authority.has(path))).toBe(true);
  });

  it("keeps every conclusion traceable to a real legacy component and a permission boundary", () => {
    const routerHash = inventory.legacy.routeFiles.find((file) => file.file === "src/router/modules/marketing.js")?.sha256;
    expect(routerHash).toMatch(/^[a-f0-9]{64}$/u);
    const generator = source("scripts/admin-marketing-frontend-parity-audit.ts");
    expect(generator).not.toMatch(/readFileSync\([^\n]*cinashop-php/u);
    expect(generator).toContain("Legacy paths and meta.auth are recorded static review evidence");
    expect(new Set(report.routes.map((route) => route.legacy.path)).size).toBe(48);
    for (const route of report.routes) {
      expect(route.legacy.resolvedComponent, route.legacy.path).toContain("cinashop-php/view/admin/src/");
      expect(route.legacy.source, route.legacy.path).toMatch(/marketing\.js:\d+$/u);
      expect(route.legacy.routerSha256, route.legacy.path).toBe(routerHash);
      expect(route.legacy.auth.length, route.legacy.path).toBeGreaterThan(0);
      expect(route.evidence, route.legacy.path).toContain(route.legacy.resolvedComponent);
      expect(route.remaining.length, route.legacy.path).toBeGreaterThan(0);
      if (route.status === "missing") expect(route.targetScreens, route.legacy.path).toEqual([]);
      else {
        expect(route.targetScreens.length, route.legacy.path).toBeGreaterThan(0);
        expect(route.covered.length, route.legacy.path).toBeGreaterThan(0);
        expect(route.targetPermissions.length, route.legacy.path).toBeGreaterThan(0);
      }
    }
    const undeclaredAuth = report.routes.filter((route) => route.legacy.auth === "not declared in route");
    expect(undeclaredAuth.map((route) => route.legacy.path)).toEqual([
      "/admin/marketing/store_combination/statistics/:id?",
      "/admin/marketing/store_bargain/statistics/:id?",
      "/admin/marketing/store_seckill/statistics/:id?",
    ]);
  });

  it("does not mistake a shared catalog or API-only endpoint for an old screen", () => {
    const byPath = new Map(report.routes.map((route) => [route.legacy.path, route]));
    expect(byPath.get("/admin/marketing/store_coupon/index")?.status).toBe("missing");
    expect(byPath.get("/admin/marketing/store_coupon_issue/index")?.status).toBe("partial");
    expect(byPath.get("/admin/marketing/store_coupon_issue/create/:id?")?.status).toBe("partial");
    const couponRecord = byPath.get("/admin/marketing/store_coupon_user/index");
    expect(couponRecord?.status).toBe("candidate");
    expect(couponRecord?.targetScreens).toEqual(["/marketing/coupon-records"]);
    expect(couponRecord?.targetApis).toEqual(["GET /adminapi/marketing/coupon-records/list"]);
    expect(couponRecord?.targetPermissions).toEqual(["coupon_record.view"]);
    expect(couponRecord?.covered.join(" ")).toContain("store_coupon_user");
    expect(couponRecord?.remaining.join(" ")).toContain("真实历史领取记录");
    expect(byPath.get("/admin/marketing/store_seckill/list")?.status).toBe("missing");
    expect(byPath.get("/admin/marketing/store_seckill_data/index")?.status).toBe("missing");
    expect(byPath.get("/admin/marketing/sign_rewards")?.status).toBe("missing");
    expect(byPath.get("/admin/marketing/sign_rewards")?.targetApis).toContain("GET /adminapi/setting/sign/rewards");
    const integralLog = byPath.get("/admin/marketing/user_point/index");
    expect(integralLog?.status).toBe("partial");
    expect(integralLog?.targetScreens).toEqual(["/marketing/user-point"]);
    expect(integralLog?.targetApis).toEqual([
      "GET /adminapi/marketing/user-point/logs",
      "GET /adminapi/marketing/user-point/statistics",
    ]);
    expect(integralLog?.targetPermissions).toEqual(["integral_log.view"]);
    expect(integralLog?.covered.join(" ")).toContain("统计卡在初始化时单独加载");
    expect(integralLog?.remaining.join(" ")).toContain("导出");
    const pointStatistic = byPath.get("/admin/marketing/point_statistic");
    expect(pointStatistic?.status).toBe("candidate");
    expect(pointStatistic?.targetScreens).toEqual(["/marketing/point-statistic"]);
    expect(pointStatistic?.targetApis).toHaveLength(4);
    expect(pointStatistic?.targetPermissions).toEqual(["point_statistic.view"]);
    expect(pointStatistic?.covered.join(" ")).toContain("gain 双标签");
    for (const path of [
      "/admin/marketing/store_discounts/index",
      "/admin/marketing/store_discounts/create",
    ]) expect(byPath.get(path)?.status).toBe("candidate");
    for (const path of [
      "/admin/marketing/channel_code",
      "/admin/marketing/channel_code/create/:id?",
      "/admin/marketing/channel_code/statistic/:id?",
    ]) {
      expect(byPath.get(path)?.status).toBe("partial");
      expect(byPath.get(path)?.targetScreens).toContain("/content/wechat-qrcode");
    }
    expect(report.methodology.reviewBasis).toMatch(/API without an Admin operation surface/u);
    expect(report.methodology.validationBoundary).toMatch(/No production data/u);
  });

  it("matches its committed report byte for byte when regenerated", () => {
    const generated = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/admin-marketing-frontend-parity-audit.ts"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(generated).toBe(source("audit/admin-legacy-marketing-route-parity.json"));
  });
});
