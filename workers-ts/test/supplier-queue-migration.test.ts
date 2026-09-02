import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseSupplierQueueHistoryQuery,
  supplierQueueTypeForCacheType,
} from "@/services/supplier/SupplierQueueHistoryService";
import { requiredSupplierPermissions } from "@/services/supplier/SupplierPermissionService";

describe("supplier legacy queue migration", () => {
  it("parses bounded history filters in the legacy Asia/Shanghai business calendar", () => {
    expect(parseSupplierQueueHistoryQuery({
      page: "2",
      limit: "25",
      type: "8",
      status: "3",
      data: "2026-08-01 - 2026-08-02",
    })).toEqual({
      page: 2,
      limit: 25,
      type: 8,
      status: 3,
      startTime: 1_785_513_600,
      endTime: 1_785_686_399,
      unsupportedType: false,
    });
    expect(parseSupplierQueueHistoryQuery({ type: "6" }).unsupportedType).toBe(true);
    expect(() => parseSupplierQueueHistoryQuery({ limit: "101" })).toThrow("每页数量无效");
    expect(() => parseSupplierQueueHistoryQuery({ status: "4" })).toThrow("任务状态无效");
  });

  it("accepts only the four order-fulfillment auxiliary types", () => {
    expect(supplierQueueTypeForCacheType("3")).toBe(7);
    expect(supplierQueueTypeForCacheType("4")).toBe(8);
    expect(supplierQueueTypeForCacheType("5")).toBe(9);
    expect(supplierQueueTypeForCacheType("6")).toBe(10);
    expect(() => supplierQueueTypeForCacheType("2")).toThrow("明细类型无效");
  });

  it("mounts only the two read contracts behind order-view permission", () => {
    const routes = readFileSync("src/routes/supplierapi.ts", "utf8");
    expect(routes).toContain('get("/queue/index", SupplierQueueController.queueList)');
    expect(routes).toContain('get("/queue/delivery/log/:id/:type", SupplierQueueController.deliveryLog)');
    expect(routes).not.toContain('get("/queue/again/do_queue/');
    expect(routes).not.toContain('get("/queue/del/wrong_queue/');
    expect(routes).not.toContain('get("/queue/stop/wrong_queue/');
    expect(requiredSupplierPermissions("GET", "/supplierapi/queue/index"))
      .toEqual(["supplier.order.view"]);
    expect(requiredSupplierPermissions("GET", "/supplierapi/queue/delivery/log/7/4"))
      .toEqual(["supplier.order.view"]);
  });

  it("derives visibility from an owned order and never projects opaque queue payloads", () => {
    const service = readFileSync("src/services/supplier/SupplierQueueHistoryService.ts", "utf8");
    expect(service).toContain("eq(storeOrder.id, queueAuxiliary.relationId)");
    expect(service).toContain("eq(storeOrder.supplierId, supplierId)");
    expect(service).toContain("COUNT(DISTINCT ${queueAuxiliary.id})");
    expect(service).not.toContain("queueList.queueInValue");
    expect(service).not.toContain("queueList.executeKey");
    expect(service).toContain('history_authority: "legacy_history_only"');
    expect(service).toContain("mutation_routes_retired: true");
  });

  it("records all three global GET mutations as evidence-backed retirements", () => {
    const decisions = JSON.parse(readFileSync("audit/legacy-route-decisions.json", "utf8")) as {
      decisions: Array<Record<string, unknown>>;
    };
    for (const path of [
      "/supplierapi/queue/again/do_queue/:id/:type",
      "/supplierapi/queue/del/wrong_queue/:id/:type",
      "/supplierapi/queue/stop/wrong_queue/:id",
    ]) {
      expect(decisions.decisions).toEqual(expect.arrayContaining([
        expect.objectContaining({ surface: "supplier", method: "GET", path, status: "retired" }),
      ]));
    }
  });
});
