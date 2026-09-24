import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

interface InventoryRoute {
  path: string;
  surface: string;
}

interface ReportRoute {
  legacy: { path: string };
  status: "candidate" | "partial" | "missing" | "retired" | "unreviewed";
  targetScreens: string[];
  targetApis: string[];
  covered: string[];
  remaining: string[];
  evidence: string[];
}

interface Report {
  methodology: { productionAccess: string; reviewBasis: string };
  summary: Record<string, number>;
  routes: ReportRoute[];
}

function source(file: string): string {
  return readFileSync(file, "utf8");
}

describe("legacy Admin setting route parity audit", () => {
  const inventory = JSON.parse(source("audit/admin-frontend-inventory.json")) as {
    legacy: { routes: InventoryRoute[] };
  };
  const report = JSON.parse(source("audit/admin-legacy-setting-route-parity.json")) as Report;
  const expectedPaths = inventory.legacy.routes
    .filter((route) => route.surface === "page" && route.path.startsWith("/admin/setting"))
    .map((route) => route.path);

  it("keeps every one of the 76 authoritative legacy setting routes in order", () => {
    expect(expectedPaths).toHaveLength(76);
    expect(report.routes.map((route) => route.legacy.path)).toEqual(expectedPaths);
    expect(report.summary).toMatchObject({
      legacyRoutes: 76,
      reviewed: 76,
      candidate: 17,
      partial: 24,
      missing: 30,
      retired: 5,
      unreviewed: 0,
    });
    expect(report.methodology.reviewBasis).toMatch(/code-only audit/);
    expect(report.methodology.productionAccess).toMatch(/READ ONLY transaction/);
    expect(report.methodology.productionAccess).toMatch(/no payment DDL\/DML ran/i);
    expect(report.methodology.productionAccess).toMatch(/idempotent second pass/);
    expect(report.methodology.productionAccess).toMatch(/no main Worker or frontend was deployed/i);
  });

  it("retains the first 15 print, notification, and commerce conclusions", () => {
    const status = Object.fromEntries(report.routes.map((route) => [route.legacy.path, route.status]));
    expect(status).toMatchObject({
      "/admin/setting/document": "candidate",
      "/admin/setting/document/config": "retired",
      "/admin/setting/document/content": "candidate",
      "/admin/setting/notification/index": "partial",
      "/admin/setting/notification/notificationEdit": "partial",
      "/admin/setting/system/create": "candidate",
      "/admin/setting/system_config": "partial",
      "/admin/setting/shop/base": "candidate",
      "/admin/setting/shop/product": "candidate",
      "/admin/setting/shop/trade": "candidate",
      "/admin/setting/shop/pay": "candidate",
      "/admin/setting/shop/agreemant": "candidate",
      "/admin/setting/shop/division": "candidate",
      "/admin/setting/system_form": "candidate",
      "/admin/setting/system_form/data": "candidate",
    });
    const retiredPrintConfig = report.routes.find((route) => route.legacy.path === "/admin/setting/document/config");
    expect(retiredPrintConfig?.evidence).toContain("cinashop-php/view/admin/src/pages/setting/document/config.vue:82");
    expect(retiredPrintConfig?.evidence).toContain("cinashop-php/view/admin/src/pages/setting/document/config.vue:192");
    expect(retiredPrintConfig?.evidence).toContain("cinashop-php/view/admin/src/pages/setting/document/config.vue:202");
    expect(retiredPrintConfig?.evidence).toContain("cinashop-php/view/admin/src/pages/setting/document/config.vue:215");
  });

  it("classifies all 61 newly reviewed routes with route-specific evidence", () => {
    const byPath = new Map(report.routes.map((route) => [route.legacy.path, route]));
    expect(report.routes).toHaveLength(76);
    for (const route of report.routes) {
      expect(route.status).not.toBe("unreviewed");
      expect(route.evidence.length, route.legacy.path).toBeGreaterThan(0);
      expect(route.covered.length + route.remaining.length, route.legacy.path).toBeGreaterThan(0);
      if (route.status === "candidate") expect(route.targetScreens.length, route.legacy.path).toBeGreaterThan(0);
      if (route.status === "retired") expect(route.remaining).toEqual([]);
    }

    const groupData = report.routes.filter((route) =>
      route.legacy.path.startsWith("/admin/setting/system_group_data")
      && route.legacy.path !== "/admin/setting/system_group_data/kf_adv");
    expect(groupData).toHaveLength(17);
    expect(groupData.every((route) => route.status === "missing")).toBe(true);
    expect(byPath.get("/admin/setting/system_group_data/kf_adv")?.status).toBe("candidate");

    for (const path of [
      "/admin/setting/freight/shipping_templates/list",
      "/admin/setting/merchant/system_store/list",
      "/admin/setting/merchant/system_store_staff/index",
      "/admin/setting/delivery_service/index",
      "/admin/setting/userAgreement/index",
    ]) expect(byPath.get(path)?.status).toBe("candidate");

    for (const path of [
      "/admin/setting/platform/list/index",
      "/admin/setting/platform/order/index",
      "/admin/setting/platform/bill/index",
      "/admin/setting/platform/setting/index",
    ]) expect(byPath.get(path)?.status).toBe("retired");
    expect(byPath.get("/admin/setting/platform/index")?.status).toBe("partial");
    expect(byPath.get("/admin/setting/membership_level/index")?.status).toBe("missing");
    expect(byPath.get("/admin/setting/system_menus/index")?.status).toBe("missing");
    expect(byPath.get("/admin/setting/merchant/system_store/index")?.status).toBe("partial");
    expect(byPath.get("/admin/setting/freight/express/index")?.status).toBe("partial");
    expect(byPath.get("/admin/setting/system_visualization_data")?.status).toBe("partial");
    expect(byPath.get("/admin/setting/storage")?.status).toBe("partial");
    expect(byPath.get("/admin/setting/pages/fab")?.status).toBe("partial");
    expect(byPath.get("/admin/setting/city/delivery/setting")?.status).toBe("missing");
    expect(byPath.get("/admin/setting/city/delivery/record")?.status).toBe("missing");
  });

  it("keeps the generated ledger byte-for-byte aligned with the review source", () => {
    const generated = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/admin-setting-frontend-parity-audit.ts"], {
      cwd: process.cwd(), encoding: "utf8",
    });
    expect(generated).toBe(source("audit/admin-legacy-setting-route-parity.json"));
  });

  it("closes the three system-form screens with a bounded editor and data viewer", () => {
    const byPath = new Map(report.routes.map((route) => [route.legacy.path, route]));
    for (const path of [
      "/admin/setting/system/create",
      "/admin/setting/system_form",
      "/admin/setting/system_form/data",
    ]) {
      expect(byPath.get(path)?.status).toBe("candidate");
      expect(byPath.get(path)?.targetScreens.join(" ")).toContain("/config/forms");
    }
    expect(byPath.get("/admin/setting/system/create")?.covered.join(" ")).toContain("10类受控组件");
    expect(byPath.get("/admin/setting/system_form")?.covered.join(" ")).toContain("停用和删除前检查");
    expect(byPath.get("/admin/setting/system_form/data")?.covered.join(" ")).toContain("公式注入");
  });

  it("records the second core-settings batch with explicit safe targets and remaining gaps", () => {
    const byPath = new Map(report.routes.map((route) => [route.legacy.path, route]));
    const systemForm = byPath.get("/admin/setting/system/create")!;
    const generic = byPath.get("/admin/setting/system_config")!;
    const basic = byPath.get("/admin/setting/shop/base")!;
    const product = byPath.get("/admin/setting/shop/product")!;
    const trade = byPath.get("/admin/setting/shop/trade")!;
    const payment = byPath.get("/admin/setting/shop/pay")!;
    const agreement = byPath.get("/admin/setting/shop/agreemant")!;
    const division = byPath.get("/admin/setting/shop/division")!;

    expect(systemForm.targetScreens.join(" ")).toContain("/config/forms");
    expect(generic.targetScreens).toContain("/config/commerce");
    expect(generic.remaining.join(" ")).toContain("任意键编辑器");
    expect(basic.covered.join(" ")).toContain("HTTPS");
    expect(basic.covered.join(" ")).toContain("Durable Object");
    expect(basic.covered.join(" ")).toContain("UniApp首页分享钩子");
    expect(basic.remaining.join(" ")).toContain("生产历史素材");
    expect(product.covered.join(" ")).toContain("is_police");
    expect(trade.status).toBe("candidate");
    expect(trade.covered.join(" ")).toContain("is_advent_sms");
    expect(trade.covered.join(" ")).toContain("平台顺序");
    expect(trade.remaining.join(" ")).toContain("生产当前无次卡行");
    expect(trade.remaining.join(" ")).toContain("真实短信");
    expect(payment.status).toBe("candidate");
    expect(payment.covered.join(" ")).toContain("实际可用状态");
    expect(payment.covered.join(" ")).toContain("商户API证书序列号");
    expect(payment.covered.join(" ")).toContain("共享一套APIv3商户凭据");
    expect(payment.covered.join(" ")).toContain("旧独立小程序商户号分支明确退休");
    expect(payment.remaining.join(" ")).toContain("全部微信部署Secret当前均未配置");
    expect(agreement.covered.join(" ")).toContain("五类协议");
    expect(division.covered.join(" ")).toContain("两个旧开关");
  });

  it("backs the print candidate with bounded writes, audit logs, legacy aliases, and UI parity", () => {
    const controller = source("src/controllers/system/PrintDocumentController.ts");
    const service = source("src/services/system/PrintDocumentManagementService.ts");
    const adminRoutes = source("src/routes/adminapi.ts");
    const supplierRoutes = source("src/routes/supplierapi.ts");
    const page = source("../view/admin-ts/src/pages/setting/PrintOperations.vue");
    const api = source("../view/admin-ts/src/api/printing.ts");

    expect(controller).toContain("readBoundedJsonObject(c.req.raw, MAX_PRINT_BODY_BYTES)");
    expect(controller).toContain('Cache-Control", "private, no-store');
    expect(service).toContain("SET LOCAL lock_timeout = '2s'");
    expect(service).toContain("SET LOCAL statement_timeout = '5s'");
    expect(service).toContain("tx.insert(systemLog)");
    expect(service).toContain("回读不一致");
    expect(adminRoutes).toContain('post("/print/set_status/:id/:status"');
    expect(adminRoutes).toContain('put("/print/set_status/:id/:status"');
    expect(supplierRoutes).toContain('post("/print/set_status/:id/:status"');
    expect(page).toContain("搜索打印机名称");
    expect(page).toContain('limit: 15');
    expect(page).toContain('aria-label="小票实时预览"');
    expect(page).toContain('maxlength="50"');
    expect(api).toContain("filtered.slice(start, start + limit)");
  });

  it("keeps notification parity partial until the old catalogs and enterprise channel are covered", () => {
    const page = source("../view/admin-ts/src/pages/setting/NotificationList.vue");
    const reviewed = report.routes.filter((route) => route.legacy.path.includes("/notification/"));
    expect(page).toContain("业务通知中心");
    expect(page).toContain("row.withdrawalId");
    expect(page).toContain("提现 #");
    expect(page).toContain("提供商模板");
    expect(reviewed).toHaveLength(2);
    expect(reviewed.every((route) => route.status === "partial")).toBe(true);
    expect(reviewed.flatMap((route) => route.remaining).join(" ")).toMatch(/type=1|会员消息目录/);
    expect(reviewed.flatMap((route) => route.remaining).join(" ")).toMatch(/type=2|平台消息目录/);
    expect(reviewed.flatMap((route) => route.remaining).join(" ")).toContain("企业微信");
    expect(reviewed.flatMap((route) => route.remaining).join(" ")).toContain("远端模板同步");
  });
});
