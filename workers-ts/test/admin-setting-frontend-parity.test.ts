import { readFileSync } from "node:fs";
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
}

interface Report {
  methodology: { productionAccess: string };
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
      reviewed: 15,
      candidate: 11,
      partial: 3,
      missing: 0,
      retired: 1,
      unreviewed: 61,
    });
    expect(report.methodology.productionAccess).toMatch(/READ ONLY transaction/);
    expect(report.methodology.productionAccess).toMatch(/no payment DDL\/DML ran/i);
    expect(report.methodology.productionAccess).toMatch(/idempotent second pass/);
    expect(report.methodology.productionAccess).toMatch(/no main Worker or frontend was deployed/i);
  });

  it("records the first reviewed print and notification routes without guessing the rest", () => {
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
    for (const route of report.routes.filter((entry) => entry.status === "unreviewed")) {
      expect(route.targetScreens).toEqual([]);
      expect(route.targetApis).toEqual([]);
      expect(route.covered).toEqual([]);
      expect(route.remaining.join(" ")).toContain("尚未逐屏比对");
    }
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
    expect(page).toContain("订单通知中心");
    expect(page).toContain("提供商模板");
    expect(reviewed).toHaveLength(2);
    expect(reviewed.every((route) => route.status === "partial")).toBe(true);
    expect(reviewed.flatMap((route) => route.remaining).join(" ")).toMatch(/type=1|会员消息目录/);
    expect(reviewed.flatMap((route) => route.remaining).join(" ")).toMatch(/type=2|平台消息目录/);
    expect(reviewed.flatMap((route) => route.remaining).join(" ")).toContain("企业微信");
    expect(reviewed.flatMap((route) => route.remaining).join(" ")).toContain("远端模板同步");
  });
});
