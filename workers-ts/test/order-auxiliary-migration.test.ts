import { readFileSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import {
  storeOrderEconomize,
  storeOrderInvoice,
  storeOrderPromotions,
  storeOrderWriteoff,
} from "../src/models/schema";

describe("order auxiliary migration", () => {
  it("preserves the four legacy tables and their accounting field types", () => {
    const economize = getTableColumns(storeOrderEconomize);
    const invoice = getTableColumns(storeOrderInvoice);
    const promotions = getTableColumns(storeOrderPromotions);
    const writeoff = getTableColumns(storeOrderWriteoff);

    expect(Object.keys(economize)).toEqual([
      "id",
      "orderId",
      "uid",
      "orderType",
      "payPrice",
      "postagePrice",
      "memberPrice",
      "offlinePrice",
      "couponPrice",
      "addTime",
      "status",
    ]);
    expect(Object.keys(invoice)).toEqual(
      expect.arrayContaining([
        "orderId",
        "invoiceId",
        "dutyNumber",
        "isPay",
        "isRefund",
        "isInvoice",
        "invoiceAmount",
        "invoiceTime",
      ]),
    );
    expect(Object.keys(promotions)).toEqual([
      "id",
      "oid",
      "uid",
      "promotionsId",
      "productId",
      "promotionsPrice",
      "addTime",
    ]);
    expect(Object.keys(writeoff)).toEqual(
      expect.arrayContaining([
        "oid",
        "orderCartId",
        "relationId",
        "staffId",
        "productId",
        "writeoffNum",
        "writeoffPrice",
        "writeoffCode",
        "adminId",
      ]),
    );
    expect(economize.payPrice.getSQLType()).toBe("numeric(12, 2)");
    expect(invoice.invoiceAmount.getSQLType()).toBe("numeric(12, 2)");
    expect(promotions.promotionsPrice.getSQLType()).toBe("numeric(12, 2)");
    expect(writeoff.writeoffPrice.getSQLType()).toBe("numeric(10, 2)");
  });

  it("copies all four tables in the commerce phase", () => {
    for (const table of [
      "store_order_economize",
      "store_order_invoice",
      "store_order_promotions",
      "store_order_writeoff",
    ]) {
      expect(MIGRATION_TABLES.find((entry) => entry.table === table)).toMatchObject({
        key: ["id"],
        phase: "commerce",
      });
    }
  });

  it("restores invoice and audit evidence in order reads and lifecycle updates", () => {
    const detail = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    const invoice = readFileSync("src/services/order/StoreOrderInvoiceService.ts", "utf8");
    const pay = readFileSync("src/services/order/StoreOrderPayService.ts", "utf8");
    const refund = readFileSync("src/services/order/StoreOrderRefundService.ts", "utf8");
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");

    expect(detail).toContain("const [economizeRows, invoiceRows, promotionsDetail, writeoffRecords, pinkRows, pickupStoreRows]");
    expect(detail).toContain("eq(storeOrderEconomize.orderId, order.orderId)");
    expect(detail).toContain("eq(storeOrderInvoice.orderId, order.id)");
    expect(detail).toContain(".from(storeOrderPromotions)");
    expect(detail).toContain(".from(storeOrderWriteoff)");

    expect(invoice).toContain("pg_advisory_xact_lock");
    expect(invoice).toContain("eq(userInvoice.uid, uid)");
    expect(invoice).toContain("invoiceAmount: order.payPrice");
    expect(invoice).toContain("eq(storeOrderInvoice.isRefund, 0)");
    expect(pay.match(/\.set\(\{ isPay: 1 \}\)/g)).toHaveLength(2);
    expect(refund).toContain(".set({ isRefund: 1 })");

    expect(routes).toContain('v1Routes.get("/order/invoice_list"');
    expect(routes).toContain('v1Routes.get("/order/invoice_detail/:uni"');
    expect(routes).toContain('v1Routes.post("/order/make_up_invoice"');
  });
});
