import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseSupplierExportIds,
  safeSpreadsheetCell,
  supplierExportOrderStatus,
  SupplierExportService,
} from "@/services/supplier/SupplierExportService";
import { requiredSupplierPermissions } from "@/services/supplier/SupplierPermissionService";
import type { Container } from "@/lib/di";

describe("supplier export migration", () => {
  it("parses a strict bounded ID set", () => {
    expect(parseSupplierExportIds("3, 2,3")).toEqual([3, 2]);
    expect(parseSupplierExportIds("")).toEqual([]);
    expect(() => parseSupplierExportIds("", true)).toThrow("导出记录ID不能为空");
    expect(() => parseSupplierExportIds("1,-2")).toThrow("正整数");
    expect(() => parseSupplierExportIds(Array.from({ length: 1001 }, (_, index) => index + 1).join(","))).toThrow("1000");
  });

  it("neutralizes spreadsheet formulas after leading whitespace", () => {
    expect(safeSpreadsheetCell("=HYPERLINK(\"https://evil\")")).toBe("'=HYPERLINK(\"https://evil\")");
    expect(safeSpreadsheetCell("  @SUM(A1:A2)")).toBe("'  @SUM(A1:A2)");
    expect(safeSpreadsheetCell("ordinary text")).toBe("ordinary text");
    expect(safeSpreadsheetCell("a\0b")).toBe("ab");
    expect(safeSpreadsheetCell("\u00a0\u000b=1+1")).toBe("'\u00a0\u000b=1+1");
    expect(() => safeSpreadsheetCell("abcdef", 5)).toThrow("导出字段过长");
  });

  it.each(['2','1e0','0','-1','1.0',' 1'])('rejects exact export page %s before accessing the database',async page=>{
    const container=new Proxy({} as Container,{get(){throw Error('Database must not be accessed');}});
    await expect(new SupplierExportService(container).storeOrder(7,{selection:'exact',ids:'25',page}))
      .rejects.toThrow(/页码无效|精确导出/);
  });

  it("preserves the legacy order-status labels", () => {
    expect(supplierExportOrderStatus({ paid: 0, status: 0, shippingType: 1, refundStatus: 0 })).toBe("待付款");
    expect(supplierExportOrderStatus({ paid: 1, status: 4, shippingType: 1, refundStatus: 0 })).toBe("部分发货");
    expect(supplierExportOrderStatus({ paid: 1, status: 1, shippingType: 1, refundStatus: 0 })).toBe("待收货");
    expect(supplierExportOrderStatus({ paid: 1, status: 3, shippingType: 1, refundStatus: 0 })).toBe("已完成");
  });

  it("keeps legacy status filtering separate from stored status labels", () => {
    const service = readFileSync("src/services/supplier/SupplierExportService.ts", "utf8");
    expect(service).toContain('case "1"');
    expect(service).toContain("inArray(storeOrder.status, [0, 4])");
    expect(service).toContain('case "-4"');
    expect(service).toContain("eq(storeOrder.isDel, 1)");
  });

  it("mounts four exact contracts with least-privilege export permissions", () => {
    const routes = readFileSync("src/routes/supplierapi.ts", "utf8");
    expect(routes).toContain('get("/export/storeOrder", SupplierExportController.storeOrder)');
    expect(routes).toContain('get("/export/expressList", SupplierExportController.expressList)');
    expect(routes).toContain('get("/export/batchOrderDelivery/:id/:queueType/:cacheType", SupplierExportController.batchOrderDelivery)');
    expect(routes).toContain('get("/export/financeRecord", SupplierExportController.financeRecord)');
    expect(requiredSupplierPermissions("GET", "/supplierapi/export/storeOrder")).toEqual(["supplier.order.manage"]);
    expect(requiredSupplierPermissions("GET", "/supplierapi/export/expressList")).toEqual(["supplier.order.view"]);
    expect(requiredSupplierPermissions("GET", "/supplierapi/export/batchOrderDelivery/1/7/3")).toEqual(["supplier.order.manage"]);
    expect(requiredSupplierPermissions("GET", "/supplierapi/export/financeRecord")).toEqual(["supplier.finance.manage"]);
  });

  it("scopes every sensitive source and omits queue payload/secrets", () => {
    const service = readFileSync("src/services/supplier/SupplierExportService.ts", "utf8");
    expect(service).toContain("eq(storeOrder.supplierId, supplierId)");
    expect(service).toContain("eq(supplierFlowingWater.supplierId, supplierId)");
    expect(service).toContain("eq(storeOrder.id, queueAuxiliary.relationId)");
    expect(service).toContain("safeSpreadsheetCell");
    expect(service).not.toContain("queueList.queueInValue");
    expect(service).not.toContain("queueAuxiliary.other");
    expect(service).not.toContain("expressCompany.account");
    expect(service).not.toContain("expressCompany.key");
  });
});
