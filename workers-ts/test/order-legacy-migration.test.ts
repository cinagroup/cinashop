import { readFileSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_MANIFEST_VERSION, MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import { storeOrder } from "../src/models/schema";

describe("order legacy migration parity", () => {
  it("preserves every PHP refund, fulfillment, form, reward, ERP, and shipping field", () => {
    const columns = getTableColumns(storeOrder);
    expect(Object.keys(columns)).toEqual(
      expect.arrayContaining([
        "refundExpress",
        "refundReasonWapImg",
        "refundReasonWapExplain",
        "refundReasonTime",
        "refundReasonWap",
        "expressDump",
        "kuaidiLabel",
        "merId",
        "cost",
        "staffId",
        "clerkId",
        "productType",
        "virtualInfo",
        "customForm",
        "promotionsGive",
        "giveIntegral",
        "giveCoupon",
        "erpId",
        "erpOrderId",
        "kuaidiTaskId",
        "kuaidiOrderId",
        "isStockUp",
      ]),
    );
    expect(columns.cost.getSQLType()).toBe("numeric(12, 2)");
    expect(columns.kuaidiTaskId.getSQLType()).toBe("varchar(128)");
  });

  it("keeps the order manifest explicit and advances its compatibility version", () => {
    expect(MIGRATION_TABLES.find((entry) => entry.table === "store_order")).toMatchObject({
      key: ["id"],
      phase: "commerce",
    });
    expect(MIGRATION_MANIFEST_VERSION).toBe("2026-08-11.57");
  });

  it("snapshots current Worker order cost and homogeneous legacy classifications", () => {
    const source = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    expect(source).toContain("const totalCostCents = orderItems.reduce");
    expect(source).toContain("const orderProductType = productTypes.size === 1");
    expect(source).toContain("const orderStaffId = staffIds.size === 1");
    expect(source).toContain("const orderMerId = merIds.size === 1");
    expect(source).toContain("cost: (totalCostCents / 100).toFixed(2)");
    expect(source).toContain("productType: orderProductType");
    expect(source).toContain("staffId: orderStaffId");
    expect(source).toContain("merId: orderMerId");
  });
});
