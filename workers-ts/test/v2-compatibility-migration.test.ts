import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { legacyUserInvoice } from "../src/services/user/UserFinanceService";

describe("API v2 compatibility migration", () => {
  it("mounts the audited legacy routes with the original auth boundary", () => {
    const routes = readFileSync("src/routes/v2/index.ts", "utf8");
    for (const route of [
      'v2Routes.get("/user/search_list", authMiddleware({ force: false })',
      'v2Routes.get("/user/clean_search", authMiddleware({ force: true })',
      'v2Routes.get("/user/service/record", authMiddleware({ force: true })',
      'v2Routes.get("/invoice", authMiddleware({ force: true })',
      'v2Routes.get("/invoice/detail/:id", authMiddleware({ force: true })',
      'v2Routes.post("/invoice/save", authMiddleware({ force: true })',
      'v2Routes.get("/invoice/del/:id", authMiddleware({ force: true })',
      'v2Routes.post("/order/make_up_invoice", authMiddleware({ force: true })',
      'v2Routes.get("/order/invoice_list", authMiddleware({ force: true })',
      'v2Routes.get("/order/invoice_detail/:uni", authMiddleware({ force: true })',
      'v2Routes.get("/agent/level_list", authMiddleware({ force: true })',
      'v2Routes.get("/agent/level_task_list", authMiddleware({ force: true })',
      'v2Routes.get("/reply/list/:id", authMiddleware({ force: false })',
    ]) expect(routes).toContain(route);
    expect(routes).toContain('UserFinanceController.invoiceListV2');
    expect(routes).toContain('UserFinanceController.invoiceSaveV2');
    expect(routes).toContain('UserFinanceController.invoiceGetDefaultV2');
  });

  it("projects invoice rows to the snake_case contract consumed by the old UniApp", () => {
    expect(legacyUserInvoice({
      id: 7,
      uid: 11,
      headerType: 2,
      type: 1,
      name: "示例公司",
      dutyNumber: "123456789012345",
      drawerPhone: "13800138000",
      email: "invoice@example.test",
      tell: "01012345678",
      address: "示例地址",
      bank: "示例银行",
      cardNumber: "6222000000000000",
      isDefault: 1,
      isDel: 0,
      addTime: 1_700_000_000,
    })).toEqual(expect.objectContaining({
      header_type: 2,
      duty_number: "123456789012345",
      drawer_phone: "13800138000",
      card_number: "6222000000000000",
      is_default: 1,
      add_time: 1_700_000_000,
    }));
  });

  it("keeps invoice writes owner-scoped and serialized per user", () => {
    const source = readFileSync("src/services/user/UserFinanceService.ts", "utf8");
    expect(source).toContain("pg_advisory_xact_lock");
    expect(source).toContain("eq(userInvoice.uid, uid)");
    expect(source).toContain("eq(userInvoice.isDel, 0)");
    expect(source).toContain("eq(userInvoice.headerType, invoice.headerType)");
    expect(source).toContain("eq(userInvoice.type, invoice.type)");
  });

  it("keeps the existing v1 camelCase response separate from the v2 adapter", () => {
    const controller = readFileSync("src/controllers/api/v1/UserFinanceController.ts", "utf8");
    expect(controller).toContain("jsonOk(c, await svc.invoiceList(uid))");
    expect(controller).toContain('jsonOk(c, { id: result.id }, "保存成功")');
    expect(controller).toContain("invoiceListLegacy");
    expect(controller).toContain("invoiceDetailLegacy");
    expect(controller).toContain("getDefaultLegacy");
  });
});
