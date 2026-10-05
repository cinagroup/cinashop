import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ledgerNames = [
  "content", "product", "setting", "marketing", "work", "app", "system", "kefu",
  "cross-module", "user-order", "supplier-agent",
] as const;

type Route = {
  legacyPath?: string;
  legacy?: { path: string };
  status: string;
};

const inventory = JSON.parse(readFileSync("audit/admin-frontend-inventory.json", "utf8")) as {
  legacy: { routes: Array<{ path: string; surface: string }> };
};

describe("complete legacy Admin page semantic inventory", () => {
  it("retires only the misnamed coupon alias while preserving the real settings and separate sign reward domains", () => {
    const current = JSON.parse(readFileSync("audit/admin-legacy-marketing-route-parity-marketing-config-followup-20260930.json", "utf8"));
    const alias = current.routes.find((row: Route) => row.legacy?.path === "/admin/marketing/coupon/system_config/:type?/:tab_id?");
    expect(alias).toMatchObject({ status: "retired", targetScreens: [], targetApis: [], targetPermissions: [] });
    expect(alias.remaining.join(" ")).toContain("generic保存API存在不等于有专用页面或消费者");
    const sign = current.routes.find((row: Route) => row.legacy?.path === "/admin/marketing/integral/signIn");
    expect(sign).toMatchObject({ status: "candidate", targetScreens: ["/marketing/sign-day-config"],
      targetPermissions: ["sign_day_config.view / sign_day_config.manage"] });
    expect(sign.remaining.join(" ")).toContain("不参与实际发奖");
    const settings = JSON.parse(readFileSync("audit/admin-legacy-setting-route-parity-speechcraft-followup-20260928.json", "utf8"));
    expect(settings.routes.find((row: Route) => (row.legacy?.path ?? row.legacyPath ?? "").includes("system_config"))?.status).toBe("partial");
  });
  it("classifies every authoritative business route exactly once across eleven ledgers", () => {
    const authority = inventory.legacy.routes
      .filter((route) => route.surface === "page")
      .map((route) => route.path);
    expect(authority).toHaveLength(274);
    expect(new Set(authority).size).toBe(274);

    const reviewed: string[] = [];
    const combinationStatuses: Record<string, string> = {};
    const couponStatuses: Record<string, string> = {};
    const statusCounts = { candidate: 0, partial: 0, missing: 0, retired: 0 };
    for (const name of ledgerNames) {
      const report = JSON.parse(readFileSync(`audit/admin-legacy-${name}-route-parity.json`, "utf8")) as {
        summary: { legacyRoutes: number };
        routes: Route[];
      };
      expect(report.routes.length, name).toBe(report.summary.legacyRoutes);
      for (const route of report.routes) {
        const path = route.legacyPath ?? route.legacy?.path;
        expect(path, name).toBeTruthy();
        reviewed.push(path!);
        if (path!.startsWith("/admin/marketing/store_combination/")) combinationStatuses[path!] = route.status;
        if (["/admin/marketing/store_coupon/index", "/admin/marketing/store_coupon_issue/index",
          "/admin/marketing/store_coupon_issue/create/:id?", "/admin/marketing/coupon/system_config/:type?/:tab_id?"].includes(path!)) {
          couponStatuses[path!] = route.status;
        }
        expect(route.status in statusCounts, `${name}: ${path}`).toBe(true);
        statusCounts[route.status as keyof typeof statusCounts] += 1;
      }
    }

    expect(reviewed).toHaveLength(274);
    expect(new Set(reviewed).size).toBe(274);
    expect(reviewed.sort()).toEqual(authority.sort());
    expect(statusCounts).toEqual({ candidate: 57, partial: 114, missing: 96, retired: 7 });
    expect(combinationStatuses).toEqual({
      "/admin/marketing/store_combination/index": "candidate",
      "/admin/marketing/store_combination/combina_list": "candidate",
      "/admin/marketing/store_combination/create/:id?/:copy?": "candidate",
      "/admin/marketing/store_combination/statistics/:id?": "candidate",
    });
    expect(couponStatuses).toEqual({
      "/admin/marketing/store_coupon/index": "candidate",
      "/admin/marketing/store_coupon_issue/index": "candidate",
      "/admin/marketing/store_coupon_issue/create/:id?": "candidate",
      "/admin/marketing/coupon/system_config/:type?/:tab_id?": "missing",
    });
  });

  it("keeps the latest dated follow-ups disjoint and reconciles all 274 screens", () => {
    const replacements: Partial<Record<(typeof ledgerNames)[number], string>> = {
      setting: "admin-legacy-setting-route-parity-city-delivery-records-followup-20261001.json",
      marketing: "admin-legacy-marketing-route-parity-marketing-config-followup-20260930.json",
      system: "admin-legacy-system-route-parity-read-followup-20260928.json",
      "cross-module": "admin-legacy-cross-module-route-parity-user-money-ledger-followup-20260928.json",
      "user-order": "admin-legacy-user-order-route-parity-invoice-followup-20260928.json",
      "supplier-agent": "admin-legacy-supplier-agent-route-parity-supplier-menu-followup-20260928.json",
    };
    const expectedChanges: Record<string, [string, string]> = {
      "/admin/setting/distribution/deliver": ["missing", "candidate"],
      "/admin/setting/city/delivery/record": ["missing", "partial"],
      "/admin/system/maintain/system_log/index": ["partial", "candidate"],
      "/admin/finance/user_recharge/index": ["missing", "partial"],
      "/admin/finance/finance/commission": ["missing", "partial"],
      "/admin/finance/finance/bill": ["partial", "candidate"],
      "/admin/setting/merchant/system_verify_order/index": ["missing", "partial"],
      "/admin/setting/store_service/feedback": ["partial", "candidate"],
      "/admin/setting/store_service/speechcraft": ["partial", "candidate"],
      "/admin/marketing/lottery/index": ["partial", "candidate"],
      "/admin/marketing/lottery/recording_list": ["partial", "candidate"],
      "/admin/marketing/user_point/index": ["partial", "candidate"],
      "/admin/marketing/activity_frame": ["missing", "candidate"],
      "/admin/marketing/activity_frame/create/:id?": ["missing", "candidate"],
      "/admin/marketing/activity_background": ["missing", "candidate"],
      "/admin/marketing/activity_background/create/:id?": ["missing", "candidate"],
      "/admin/marketing/discount/list": ["missing", "candidate"],
      "/admin/marketing/discount/add/:id?": ["missing", "candidate"],
      "/admin/marketing/discount/full_discount": ["missing", "candidate"],
      "/admin/marketing/discount/add_discount/:id?": ["missing", "candidate"],
      "/admin/marketing/discount/pieces_discount": ["missing", "candidate"],
      "/admin/marketing/discount/add_pieces/:id?": ["missing", "candidate"],
      "/admin/marketing/discount/give": ["missing", "partial"],
      "/admin/marketing/discount/add_give/:id?": ["missing", "partial"],
      "/admin/marketing/store_integral/add_store_integral": ["missing", "candidate"],
      "/admin/marketing/integral/signIn": ["missing", "candidate"],
      "/admin/marketing/coupon/system_config/:type?/:tab_id?": ["missing", "retired"],
      "/admin/order/invoice/list": ["missing", "partial"],
      "/admin/user/recharge/:id": ["missing", "partial"],
      "/admin/vipuser/grade/record": ["partial", "candidate"],
      "/admin/supplier/bill/index": ["missing", "candidate"],
      "/admin/supplier/bill/index/:type?": ["missing", "candidate"],
      "/admin/supplier/capital/index": ["missing", "candidate"],
      "/admin/supplier/orderStatistics/index": ["missing", "candidate"],
      "/admin/supplier/cash/index": ["partial", "candidate"],
      "/admin/supplier/apply": ["partial", "candidate"],
      "/admin/supplier/menu/list": ["missing", "partial"],
      "/admin/supplier/supplierAdd/:id?": ["missing", "candidate"],
      "/admin/agent/agreement": ["missing", "candidate"],
      "/admin/supplier/supplier/index": ["missing", "partial"],
    };
    const latest = new Map<string, string>();
    const changed: Record<string, [string, string]> = {};
    for (const name of ledgerNames) {
      const original = JSON.parse(readFileSync(`audit/admin-legacy-${name}-route-parity.json`, "utf8")) as { routes: Route[] };
      const followup = replacements[name]
        ? JSON.parse(readFileSync(`audit/${replacements[name]}`, "utf8")) as { routes: Route[] }
        : original;
      const before = new Map(original.routes.map(route => [route.legacyPath ?? route.legacy!.path, route.status]));
      expect(followup.routes).toHaveLength(original.routes.length);
      for (const route of followup.routes) {
        const path = route.legacyPath ?? route.legacy!.path;
        expect(latest.has(path), path).toBe(false);
        latest.set(path, route.status);
        const prior = before.get(path);
        expect(prior, path).toBeTruthy();
        if (prior !== route.status) changed[path] = [prior!, route.status];
      }
    }
    const authority = inventory.legacy.routes.filter(route => route.surface === "page").map(route => route.path);
    expect([...latest.keys()].sort()).toEqual(authority.sort());
    expect(changed).toEqual(expectedChanges);
    expect(Object.fromEntries(["candidate", "partial", "missing", "retired"]
      .map(status => [status, [...latest.values()].filter(value => value === status).length])))
      .toEqual({ candidate: 86, partial: 114, missing: 66, retired: 8 });
  });

  it("reproduces both newest domain ledgers from registered screens and APIs", () => {
    const cases = [
      {
        script: "admin-setting-frontend-parity-audit.ts",
        flag: "--speechcraft-followup",
        file: "admin-legacy-setting-route-parity-speechcraft-followup-20260928.json",
        path: "/admin/setting/store_service/speechcraft",
        screen: "/kefu/speechcraft",
        api: "POST /adminapi/wechat/speechcraft/categories",
        summary: { candidate: 19, partial: 23, missing: 29, retired: 5 },
      },
      {
        script: "admin-marketing-frontend-parity-audit.ts",
        flag: "--user-point-followup",
        file: "admin-legacy-marketing-route-parity-user-point-followup-20260928.json",
        path: "/admin/marketing/user_point/index",
        screen: "/marketing/user-point",
        api: "GET /adminapi/marketing/user-point/export",
        summary: { candidate: 21, partial: 12, missing: 15, retired: 0 },
      },
      {
        script: "admin-marketing-frontend-parity-audit.ts",
        flag: "--activity-frame-followup",
        file: "admin-legacy-marketing-route-parity-activity-frame-followup-20260930.json",
        path: "/admin/marketing/activity_frame/create/:id?",
        screen: "/marketing/activity-frame/create/:id?",
        api: "PATCH /adminapi/marketing/activity-frame/:id/status",
        summary: { candidate: 23, partial: 12, missing: 13, retired: 0 },
      },
      {
        script: "admin-marketing-frontend-parity-audit.ts",
        flag: "--activity-background-followup",
        file: "admin-legacy-marketing-route-parity-activity-background-followup-20260930.json",
        path: "/admin/marketing/activity_background/create/:id?",
        screen: "/marketing/activity-background/create/:id?",
        api: "DELETE /adminapi/marketing/activity-background/:id",
        summary: { candidate: 25, partial: 12, missing: 11, retired: 0 },
      },
      {
        script: "admin-marketing-frontend-parity-audit.ts",
        flag: "--time-discount-followup",
        file: "admin-legacy-marketing-route-parity-time-discount-followup-20260930.json",
        path: "/admin/marketing/discount/add/:id?",
        screen: "/marketing/time-discounts/create/:id?",
        api: "PATCH /adminapi/marketing/time-discounts/:id/status",
        summary: { candidate: 27, partial: 12, missing: 9, retired: 0 },
      },
      {
        script: "admin-marketing-frontend-parity-audit.ts",
        flag: "--full-discount-followup",
        file: "admin-legacy-marketing-route-parity-full-discount-followup-20260930.json",
        path: "/admin/marketing/discount/add_discount/:id?",
        screen: "/marketing/full-discounts/create/:id?",
        api: "PATCH /adminapi/marketing/full-discounts/:id/status",
        summary: { candidate: 29, partial: 12, missing: 7, retired: 0 },
      },
      {
        script: "admin-marketing-frontend-parity-audit.ts",
        flag: "--nth-discount-followup",
        file: "admin-legacy-marketing-route-parity-nth-discount-followup-20260930.json",
        path: "/admin/marketing/discount/add_pieces/:id?",
        screen: "/marketing/nth-discounts/create/:id?",
        api: "PATCH /adminapi/marketing/nth-discounts/:id/status",
        summary: { candidate: 31, partial: 12, missing: 5, retired: 0 },
      },
      {
        script: "admin-marketing-frontend-parity-audit.ts",
        flag: "--full-gift-followup",
        file: "admin-legacy-marketing-route-parity-full-gift-followup-20260930.json",
        path: "/admin/marketing/discount/add_give/:id?",
        screen: "/marketing/full-gifts/create/:id?",
        api: "PATCH /adminapi/marketing/full-gifts/:id/status",
        status: "partial",
        summary: { candidate: 31, partial: 14, missing: 3, retired: 0 },
      },
      {
        script: "admin-marketing-frontend-parity-audit.ts",
        flag: "--full-gift-refund-followup",
        file: "admin-legacy-marketing-route-parity-full-gift-refund-followup-20260930.json",
        path: "/admin/marketing/discount/add_give/:id?",
        screen: "/marketing/full-gifts/create/:id?",
        api: "PATCH /adminapi/marketing/full-gifts/:id/status",
        status: "partial",
        summary: { candidate: 31, partial: 14, missing: 3, retired: 0 },
      },
      {
        script: "admin-marketing-frontend-parity-audit.ts",
        flag: "--integral-batch-followup",
        file: "admin-legacy-marketing-route-parity-integral-batch-followup-20260930.json",
        path: "/admin/marketing/store_integral/add_store_integral",
        screen: "/activity/integral-batch",
        api: "POST /adminapi/activity/integral-batch",
        status: "candidate",
        summary: { candidate: 32, partial: 14, missing: 2, retired: 0 },
      },
      {
        script: "admin-marketing-frontend-parity-audit.ts",
        flag: "--marketing-config-followup",
        file: "admin-legacy-marketing-route-parity-marketing-config-followup-20260930.json",
        path: "/admin/marketing/integral/signIn",
        screen: "/marketing/sign-day-config",
        api: "GET /adminapi/marketing/sign-day-config/receipts/:requestId",
        status: "candidate",
        summary: { candidate: 33, partial: 14, missing: 0, retired: 1 },
      },
    ] as const;
    for (const item of cases) {
      const saved = readFileSync(`audit/${item.file}`, "utf8");
      const generated = execFileSync(process.execPath,
        ["node_modules/tsx/dist/cli.mjs", `scripts/${item.script}`, item.flag,
          ...(item.script === "admin-marketing-frontend-parity-audit.ts" ? ["--stdout-only"] : [])],
        { cwd: process.cwd(), encoding: "utf8" });
      if (item.flag === "--time-discount-followup") {
        // This dated ledger is immutable; later evidence text must not rewrite its historical snapshot.
        const semantic = (source: string) => (JSON.parse(source) as { routes: Array<{
          legacy: { path: string }; status: string; targetScreens: string[]; targetApis: string[]; targetPermissions: string[] }> })
          .routes.map(row => ({ path: row.legacy.path, status: row.status, screens: row.targetScreens,
            apis: row.targetApis, permissions: row.targetPermissions }));
        expect(semantic(generated), item.file).toEqual(semantic(saved));
      } else expect(generated, item.file).toBe(saved);
      const report = JSON.parse(saved) as { summary: Record<string, number>; routes: Array<{
        legacy: { path: string }; status: string; targetScreens: string[]; targetApis: string[] }> };
      expect(report.summary).toMatchObject(item.summary);
      const route = report.routes.find(row => row.legacy.path === item.path);
      expect(route?.status).toBe("status" in item ? item.status : "candidate");
      expect(route?.targetScreens).toContain(item.screen);
      expect(route?.targetApis).toContain(item.api);
    }
  });
});
