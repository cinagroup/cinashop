import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import {
  capitalFlow,
  storeFinanceFlow,
  supplierFlowingWater,
  userBill,
} from "../src/models/schema";
import { formatUserCapitalRow } from "../src/services/finance/CapitalFlowService";

describe("legacy finance ledger migration", () => {
  it("preserves the active 12-column platform cash-flow contract", () => {
    const columns = getTableColumns(capitalFlow);
    expect(Object.keys(columns)).toEqual([
      "id",
      "flowId",
      "orderId",
      "storeId",
      "uid",
      "nickname",
      "phone",
      "price",
      "tradingType",
      "payType",
      "mark",
      "addTime",
    ]);
    expect(columns.price.getSQLType()).toBe("numeric(12, 2)");
    expect(columns.mark.getSQLType()).toBe("varchar(500)");
  });

  it("preserves the dormant 19-column store ledger without folding it into another account", () => {
    const columns = getTableColumns(storeFinanceFlow);
    expect(Object.keys(columns)).toEqual([
      "id",
      "storeId",
      "uid",
      "staffId",
      "orderId",
      "linkId",
      "pm",
      "number",
      "type",
      "payType",
      "payPrice",
      "totalPrice",
      "rate",
      "tradeType",
      "remark",
      "mark",
      "tradeTime",
      "addTime",
      "isDel",
    ]);
    expect(getTableName(storeFinanceFlow)).toBe("store_finance_flow");
    expect(getTableName(capitalFlow)).toBe("capital_flow");
    expect(getTableName(userBill)).toBe("user_bill");
    expect(getTableName(supplierFlowingWater)).toBe("supplier_flowing_water");
  });

  it("documents both ledgers as separate finance-phase migration units", () => {
    expect(MIGRATION_TABLES.find((entry) => entry.table === "capital_flow")).toMatchObject({
      key: ["id"],
      phase: "finance",
      note: expect.stringContaining("separate from user_bill"),
    });
    expect(MIGRATION_TABLES.find((entry) => entry.table === "store_finance_flow")).toMatchObject({
      key: ["id"],
      phase: "finance",
      note: expect.stringContaining("Dormant store ledger"),
    });
  });

  it("formats user type-9 records with the legacy grouping and labels", () => {
    expect(
      formatUserCapitalRow({
        id: 1,
        flowId: "ZJ1",
        orderId: "wx1",
        storeId: 0,
        uid: 8,
        nickname: "会员",
        phone: "13800138000",
        price: "19.90",
        tradingType: 7,
        payType: "weixin",
        mark: "",
        addTime: 1_704_067_200,
      }),
    ).toMatchObject({
      flow_id: "ZJ1",
      order_id: "wx1",
      time_key: "2024-01",
      day: "2024-01-01",
      add_time: "2024/01/01 08:00",
      type: 7,
      type_name: "购买会员",
      title: "购买会员",
    });
  });

  it("routes capital-flow APIs to their dedicated service instead of admin user bills", () => {
    const apiRoutes = readFileSync("src/routes/v1/index.ts", "utf8");
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    const service = readFileSync("src/services/finance/CapitalFlowService.ts", "utf8");
    expect(apiRoutes).toContain('"/user/money_list/9"');
    expect(apiRoutes).toContain('"/admin/flow/get_list"');
    expect(adminRoutes).toContain('"/flow/get_list"');
    expect(service).toContain(".from(capitalFlow)");
    expect(service).not.toContain("userBill");
    expect(service).not.toContain("supplierFlowingWater");
  });
});
