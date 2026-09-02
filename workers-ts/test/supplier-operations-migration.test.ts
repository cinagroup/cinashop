import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  orderSupplierMenuRows,
  parseSupplierReportRange,
} from "@/services/supplier/SupplierCompatibilityService";
import {
  buildLegacyPrinterConfigView,
  buildSupplierConfigView,
  normalizeLegacyPrinterConfigInput,
} from "@/services/store/StoreScopedConfigService";

describe("supplier operations compatibility migration", () => {
  it("parses legacy reporting selectors into bounded UTC+8 ranges", () => {
    const now = Date.UTC(2026, 8, 2, 4, 0, 0);
    const sevenDays = parseSupplierReportRange("sevenday", now);
    expect(new Date(sevenDays.start * 1_000).toISOString()).toBe("2026-08-26T16:00:00.000Z");
    expect(new Date(sevenDays.end * 1_000).toISOString()).toBe("2026-09-02T15:59:59.000Z");

    const custom = parseSupplierReportRange("2026/08/01-2026/08/31", now);
    expect(new Date(custom.start * 1_000).toISOString()).toBe("2026-07-31T16:00:00.000Z");
    expect(new Date(custom.end * 1_000).toISOString()).toBe("2026-08-31T15:59:59.000Z");
    expect(() => parseSupplierReportRange("2025/01/01-2026/09/02", now)).toThrow(
      "不能超过366天",
    );
    expect(() => parseSupplierReportRange("2026/02/30-2026/03/01", now)).toThrow(
      "时间范围格式错误",
    );
  });

  it("returns a deterministic parent-before-child supplier menu search order", () => {
    const rows = [
      { id: 20, pid: 10, menu_name: "订单列表", menu_path: "/orders", unique_auth: "orders", sort: 90, type: 0 as const },
      { id: 30, pid: 0, menu_name: "设置", menu_path: "/settings", unique_auth: "settings", sort: 80, type: 0 as const },
      { id: 10, pid: 0, menu_name: "订单", menu_path: "/order", unique_auth: "order", sort: 100, type: 1 as const },
      { id: 40, pid: 999, menu_name: "孤立菜单", menu_path: "/orphan", unique_auth: "orphan", sort: 70, type: 0 as const },
    ];
    expect(orderSupplierMenuRows(rows).map((row) => row.id)).toEqual([30, 10, 20, 40]);
  });

  it("adapts the legacy single-printer contract without exposing the stored secret", () => {
    const view = buildSupplierConfigView("store_printing_deploy", [
      { id: 1, keyName: "store_pay_success_printing_switch", value: "1" },
      { id: 2, keyName: "store_develop_id", value: '"dev-7"' },
      { id: 3, keyName: "store_printing_api_key", value: '"production-secret"' },
      { id: 4, keyName: "store_printing_client_id", value: '"client-7"' },
      { id: 5, keyName: "store_terminal_number", value: '"terminal-7"' },
    ]);
    expect(buildLegacyPrinterConfigView(7, view)).toEqual({
      id: 0,
      supplier_id: 7,
      status: 1,
      develop_id: "dev-7",
      api_key: "",
      client_id: "client-7",
      terminal_number: "terminal-7",
    });
    expect(normalizeLegacyPrinterConfigInput({
      id: 0,
      supplier_id: 7,
      status: 1,
      develop_id: "dev-8",
      api_key: "",
      client_id: "client-8",
      terminal_number: "terminal-8",
    })).toEqual({
      store_pay_success_printing_switch: 1,
      store_develop_id: "dev-8",
      store_printing_api_key: "",
      store_printing_client_id: "client-8",
      store_terminal_number: "terminal-8",
    });
    expect(() => normalizeLegacyPrinterConfigInput({ api_key: "x", supplier_override: 9 }))
      .toThrow("不支持的小票打印配置项");
  });

  it("mounts all audited exact routes behind supplier authentication", () => {
    const routes = readFileSync("src/routes/supplierapi.ts", "utf8");
    const controller = readFileSync("src/controllers/supplier/SupplierController.ts", "utf8");
    const middleware = readFileSync("src/middleware/supplier-auth.ts", "utf8");
    const service = readFileSync("src/services/supplier/SupplierCompatibilityService.ts", "utf8");
    const frontendApi = readFileSync("../view/supplier-ts/src/api/supplier.ts", "utf8");
    for (const route of [
      'get("/jnotice"',
      'get("/city"',
      'get("/menusList"',
      'put("/updatePwd"',
      'get("/printing"',
      'put("/printing"',
      'get("/home/order_channel"',
      'get("/home/order_type"',
      'get("/system/form/info/:id"',
      'get("/system/form/all_system_form"',
      'get("/system/config/edit_new_build/:type"',
      'post("/system/config"',
    ]) {
      expect(routes).toContain(route);
    }
    expect(routes.indexOf('use("/*", supplierAuthMiddleware)')).toBeLessThan(
      routes.indexOf('get("/jnotice"'),
    );
    expect(controller).toContain("readRequestJsonObject(c.req.raw, MAX_SIMPLE_BODY_BYTES)");
    expect(controller).toContain("clearToken(md5(token), c.env)");
    expect(controller).toContain('c.header("Cache-Control", "private, no-store, max-age=0")');
    expect(middleware).toContain('c.header("Cache-Control", "private, no-store, max-age=0")');
    expect(service).toContain("MAX_REPORT_DAYS = 366");
    expect(service).toContain("eq(storeOrder.supplierId, supplierId)");
    expect(service).toContain("eq(storeOrderRefund.supplierId, supplierId)");
    expect(frontendApi).toContain('url: "/home/dashboard"');
    expect(frontendApi).toContain('url: "/updatePwd"');
  });
});
