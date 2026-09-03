import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_MANIFEST_VERSION, MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import { printDocument, supplierTicketPrint, type PrintDocument } from "../src/models/schema";
import { requiredAdminPermission } from "../src/services/admin/AdminPermissionService";
import {
  buildPrintDocumentView,
  normalizePrintContent,
  normalizePrintDocumentInput,
  printDocumentReadiness,
} from "../src/services/system/PrintDocumentManagementService";

function row(overrides: Partial<PrintDocument> = {}): PrintDocument {
  return {
    id: 8,
    type: 1,
    supplierId: 27,
    printName: "后厨打印机",
    ylyUserId: "user-id",
    ylyAppId: "app-id",
    ylyAppSecret: "super-secret",
    ylySn: "K4-001",
    feyUser: "",
    feyUkey: "other-secret",
    feySn: "",
    times: 1,
    printType: 1,
    printContent: JSON.stringify({
      header: 1,
      delivery: 1,
      buyer_remarks: 1,
      goods: [0, 1],
      freight: 1,
      preferential: 1,
      pay: [0, 1],
      custom: 0,
      order: [0, 1, 2, 3],
      code: 0,
      code_url: "",
      show_notice: 0,
      notice_content: "",
    }),
    addTime: 1_700_000_000,
    status: 1,
    isDel: 0,
    ...overrides,
  };
}

describe("print-document migration and management boundary", () => {
  it("preserves both PHP tables and deterministic migration keys", () => {
    expect(getTableName(supplierTicketPrint)).toBe("supplier_ticket_print");
    expect(getTableName(printDocument)).toBe("print_document");
    expect(Object.keys(getTableColumns(supplierTicketPrint))).toEqual([
      "id", "supplierId", "developId", "apiKey", "clientId", "terminalNumber", "status",
    ]);
    expect(Object.keys(getTableColumns(printDocument))).toEqual([
      "id", "type", "supplierId", "printName", "ylyUserId", "ylyAppId",
      "ylyAppSecret", "ylySn", "feyUser", "feyUkey", "feySn", "times",
      "printType", "printContent", "addTime", "status", "isDel",
    ]);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "supplier_ticket_print")?.key)
      .toEqual(["id"]);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "print_document")?.key)
      .toEqual(["id"]);
    expect(MIGRATION_MANIFEST_VERSION).toBe("2026-08-11.57");
  });

  it("keeps external and Worker-embedded migration SQL identical", () => {
    const migration = readFileSync("migrations/0065_print_documents.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service
      .match(/private migration_0072\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    expect(embedded).toBe(migration);
    expect(migration).not.toMatch(/CREATE UNIQUE INDEX|FOREIGN KEY|REFERENCES/i);
    expect(migration).toContain('"print_content" TEXT');
    expect(migration).toContain('"print_document_active_lookup"');
  });

  it("never returns provider secrets and reports readiness separately", () => {
    const view = buildPrintDocumentView(row());
    expect(view).toMatchObject({
      supplier_id: 27,
      yly_app_secret: "",
      yly_app_secret_configured: true,
      fey_ukey: "",
      fey_ukey_configured: true,
      provider_ready: true,
      content_configured: true,
      content_valid: true,
      ready: true,
    });
    expect(JSON.stringify(view)).not.toContain("super-secret");
    expect(JSON.stringify(view)).not.toContain("other-secret");
    expect(printDocumentReadiness(row({ printContent: "{invalid" }))).toMatchObject({
      content_configured: true,
      content_valid: false,
      ready: false,
    });
  });

  it("preserves blank secrets on update and requires credentials when enabled", () => {
    const existing = row({ status: 0 });
    const normalized = normalizePrintDocumentInput({
      print_name: "新名称",
      yly_app_secret: "",
      status: 1,
    }, existing);
    expect(normalized.ylyAppSecret).toBe("super-secret");
    expect(normalized.printName).toBe("新名称");
    expect(() => normalizePrintDocumentInput({
      print_name: "未配置飞鹅云",
      type: 2,
      status: 1,
    })).toThrow(/飞鹅云/);
    expect(() => normalizePrintDocumentInput({
      print_name: "越权注入",
      supplier_id: 999,
    })).toThrow(/supplier_id/);
  });

  it("allowlists and bounds the print-content contract", () => {
    expect(normalizePrintContent({
      header: 1,
      delivery: 1,
      buyer_remarks: 0,
      goods: [1, 0, 1],
      freight: 1,
      preferential: 1,
      pay: [1],
      custom: 0,
      order: [3, 0],
      code: 1,
      code_url: "/pages/order/detail",
      show_notice: 1,
      notice_content: "请核对商品",
    })).toMatchObject({
      goods: [0, 1],
      order: [0, 3],
      code_url: "/pages/order/detail",
    });
    expect(() => normalizePrintContent({ code_url: "https://evil.example/q" }))
      .toThrow(/站内绝对路径/);
    expect(() => normalizePrintContent({ notice_content: "<QR>inject</QR>" }))
      .toThrow(/打印控制标记/);
    expect(() => normalizePrintContent({ goods: [1] })).toThrow(/商品明细/);
    expect(() => normalizePrintContent({ code: 1, code_url: "" })).toThrow(/站内路径/);
    expect(() => normalizePrintContent({ show_notice: 1, notice_content: "" }))
      .toThrow(/提示语/);
    expect(() => normalizePrintContent({ notice_content: "好".repeat(51) })).toThrow(/50/);
    expect(() => normalizePrintContent({ arbitrary: true })).toThrow(/arbitrary/);
  });

  it("mounts authenticated platform and supplier routes with a registered permission", () => {
    const supplierRoutes = readFileSync("src/routes/supplierapi.ts", "utf8");
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    const service = readFileSync(
      "src/services/system/PrintDocumentManagementService.ts",
      "utf8",
    );
    for (const route of [
      "/print/list", "/print/form/:id", "/print/save/:id",
      "/print/set_status/:id/:status", "/print/del/:id", "/print/content/:id",
      "/print/save_content/:id",
    ]) {
      expect(supplierRoutes).toContain(route);
      expect(adminRoutes).toContain(route);
    }
    expect(supplierRoutes.indexOf('use("/*", supplierAuthMiddleware)'))
      .toBeLessThan(supplierRoutes.indexOf('get("/print/list"'));
    expect(requiredAdminPermission("GET", "/adminapi/print/list")).toBe("print.view");
    expect(requiredAdminPermission("POST", "/api/admin/print/save/:id")).toBe("print.manage");
    expect(service.match(/eq\(printDocument\.supplierId, supplierId\)/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(6);
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain("SET LOCAL lock_timeout = '2s'");
    expect(service).toContain("SET LOCAL statement_timeout = '5s'");
    expect(service).toContain("tx.insert(systemLog)");
    expect(adminRoutes).toContain('post("/print/set_status/:id/:status"');
    expect(adminRoutes).toContain('put("/print/set_status/:id/:status"');
    expect(supplierRoutes).toContain('post("/print/set_status/:id/:status"');
  });
});
