import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("supplier frontend export and queue-history migration", () => {
  const api = readFileSync("../view/supplier-ts/src/api/supplier.ts", "utf8");
  const orders = readFileSync("../view/supplier-ts/src/pages/Orders.vue", "utf8");
  const finance = readFileSync("../view/supplier-ts/src/pages/Finance.vue", "utf8");
  const exporter = readFileSync("../view/supplier-ts/src/utils/legacy-export.ts", "utf8");
  const parity = JSON.parse(readFileSync("audit/supplier-frontend-parity.json", "utf8")) as {
    counting: { legacy: Record<string, number>; target: Record<string, number> };
    screens: Array<{ legacyPath: string; status: string }>;
    checklist: Array<{ id: string; done: boolean }>;
  };

  it("uses navigable screens rather than raw Vue file count for the parity denominator", () => {
    expect(parity.counting.legacy.pageVueFiles).toBe(41);
    expect(parity.counting.legacy.distinctNavigableBusinessScreens).toBe(19);
    expect(parity.counting.legacy.embeddedPageComponents).toBe(16);
    expect(parity.counting.legacy.unroutedOrFrameworkScaffoldPages).toBe(7);
    expect(parity.counting.target.pageVueFiles).toBe(18);
    expect(parity.counting.target.screenRouteRecords).toBe(19);
    expect(parity.screens).toHaveLength(19);
    expect(parity.screens.filter((screen) => screen.status === "candidate_covered")).toHaveLength(17);
    expect(parity.screens.filter((screen) => screen.status === "partial_replacement")).toHaveLength(2);
    expect(parity.screens.filter((screen) => screen.status === "missing_actionable")).toEqual([]);
    expect(parity.checklist).toHaveLength(12);
    expect(parity.checklist.filter((item) => item.done).map((item) => item.id)).toEqual([
      "FE-004A", "FE-004B", "FE-004C", "FE-004D", "FE-004E", "FE-004F", "FE-004G",
    ]);
  });

  it("connects all bounded manifest and read-only history contracts", () => {
    for (const route of [
      'url: "/export/storeOrder"',
      'url: "/export/expressList"',
      "url: `/export/batchOrderDelivery/${id}/${queueType}/${cacheType}`",
      'url: "/export/financeRecord"',
      'url: "/queue/index"',
      "url: `/queue/delivery/log/${id}/${cacheType}`",
    ]) expect(api).toContain(route);
  });

  it("exports only explicitly selected order and finance rows", () => {
    expect(orders).toContain('ids: selectedOrders.value.map((row) => row.id).join(",")');
    expect(orders).toContain('@selection-change="selectOrders"');
    expect(finance).toContain("exportSupplierFinance(selectedFlows.value.map((row) => row.id))");
    expect(finance).toContain('@selection-change="selectFlows"');
  });

  it("keeps sensitive downloads and mutations behind manage permissions", () => {
    expect(orders).toContain('auth.can("supplier.order.manage")');
    expect(orders).toContain('auth.can("supplier.print.manage")');
    expect(orders).toContain('auth.can("supplier.waybill.manage")');
    expect(finance).toContain('auth.can("supplier.finance.manage")');
    expect(finance).toContain('v-if="canManageFinance" type="primary" @click="openExtractDialog"');
  });

  it("does not restore retired global queue mutations", () => {
    expect(orders).toContain("旧队列的入口已安全退役");
    for (const route of ["queueAgain", "queueDel", "stopWrongQueue", "/queue/again/", "/queue/del/", "/queue/stop/"]) {
      expect(api).not.toContain(route);
      expect(orders).not.toContain(route);
    }
  });

  it("creates a BOM CSV with client-side formula and filename hardening", () => {
    expect(exporter).toContain('/^[\\t\\r\\n ]*[=+\\-@]/');
    expect(exporter).toContain('.replace(/\\0/g, "")');
    expect(exporter).toContain('["\\uFEFF", lines.join("\\r\\n")]');
    expect(exporter).toContain("URL.revokeObjectURL(url)");
    expect(exporter).toContain('.replace(/[<>:"/\\\\|?*\\u0000-\\u001f]/g, "_")');
  });
});
