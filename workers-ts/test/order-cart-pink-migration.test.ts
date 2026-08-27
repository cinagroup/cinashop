import { readFileSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import { storeOrderCartInfo, storePink } from "../src/models/schema";

describe("order cart and group-buy migration parity", () => {
  it("preserves all PHP order-line promotion and write-off fields", () => {
    const columns = getTableColumns(storeOrderCartInfo);
    expect(Object.keys(columns)).toEqual(
      expect.arrayContaining([
        "promotionsId",
        "writeTimes",
        "writeSurplusTimes",
        "writeStart",
        "writeEnd",
        "isAdventSms",
        "isExpireSms",
        "isWriteoff",
        "writeoffTime",
        "addTime",
      ]),
    );
  });

  it("maps PHP group-buy IDs and explicitly converts varchar epoch fields", () => {
    const spec = MIGRATION_TABLES.find((entry) => entry.table === "store_pink");
    expect(spec?.columnMappings).toEqual({ cid: "combination_id", pid: "product_id" });
    expect(spec?.columnConversions).toEqual({
      add_time: "numeric_string_to_integer",
      stop_time: "epoch_string_to_timestamp",
    });
    const columns = getTableColumns(storePink);
    expect(columns.isRefund.getSQLType()).toBe("integer");
    expect(Object.keys(columns)).toEqual(
      expect.arrayContaining([
        "nickname",
        "avatar",
        "totalNum",
        "totalPrice",
        "price",
        "isTpl",
        "isRefund",
        "isVirtual",
        "memberCount",
      ]),
    );
  });

  it("widens the PHP refund-reference field in both external and embedded migrations", () => {
    const migration = readFileSync("migrations/0079_pink_refund_reference.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(
      /private migration_0086\(\): string \{\s*return `([\s\S]*?)`;\s*\}/,
    )?.[1].trim();
    expect(embedded).toBe(migration);
    expect(service).toContain("this.migration_0086()");
    expect(migration).toContain('ALTER COLUMN "is_refund" TYPE INTEGER');
  });

  it("keeps required group size separate from serialized runtime occupancy", () => {
    const orderSource = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    const activitySource = readFileSync("src/services/activity/ActivityJoinService.ts", "utf8");
    const lifecycleSource = readFileSync("src/services/activity/PinkLifecycleService.ts", "utf8");
    const paymentSource = readFileSync("src/services/order/StoreOrderPayService.ts", "utf8");
    const routesSource = readFileSync("src/routes/v1/index.ts", "utf8");
    expect(orderSource).toContain("await reservePinkJoin(tx");
    expect(orderSource).toContain("pinkId: finalPinkId");
    expect(orderSource).not.toContain(".insert(storePink)");
    expect(lifecycleSource).toContain("eq(storeOrder.paid, 0)");
    expect(lifecycleSource).toContain("activePeople + reservedPeople >= requiredPeople");
    expect(lifecycleSource).toContain("async function createPaidPinkLeader");
    expect(lifecycleSource).toContain("orderIdKey: String(order.id)");
    expect(lifecycleSource).toContain("memberCount: 1");
    expect(lifecycleSource).toContain('.for("update")');
    expect(paymentSource.match(/await activatePaidPink\(tx, paidOrder, now\);/g)).toHaveLength(2);
    expect(routesSource).toContain('v1Routes.get("/pink"');
    expect(routesSource).not.toContain('v1Routes.post("/pink"');
    expect(orderSource).toContain("writeSurplusTimes: writeTimes");
    expect(activitySource).toContain("requiredPeople: pink.people");
    expect(activitySource).toContain("eq(storePink.kId, 0)");
    expect(activitySource).toContain("withTx(this.container");
  });

  it("keeps payment, legacy cleanup, refunds, and fulfillment on one group state machine", () => {
    const lifecycleSource = readFileSync("src/services/activity/PinkLifecycleService.ts", "utf8");
    const timeoutSource = readFileSync("src/services/activity/PinkTimeoutService.ts", "utf8");
    const refundSource = readFileSync("src/services/order/StoreOrderRefundService.ts", "utf8");
    const adminSource = readFileSync("src/controllers/api/v1/AdminCrudController.ts", "utf8");
    const supplierSource = readFileSync("src/services/supplier/SupplierFulfillmentService.ts", "utf8");

    expect(lifecycleSource).toContain("pinkBelongsToOrder(leader, order)");
    expect(lifecycleSource).toContain("legacyOwnLeader");
    expect(lifecycleSource).toContain("orderIdKey: String(order.id)");
    expect(timeoutSource).toContain(".selectDistinct({ id: storeOrder.id })");
    expect(timeoutSource).toContain("eq(storeOrder.orderId, storePink.orderId)");
    expect(timeoutSource).toContain("eq(storeOrder.unique, storePink.orderIdKey)");
    expect(timeoutSource).toContain("const legacyOrphan = paidOrders.length === 0");
    expect(refundSource).toContain("await reconcileRefundedPink(");
    expect(refundSource).toContain("refundStatus: fullyRefunded ? 2 : 3");
    expect(adminSource).toContain("拼团尚未成功，不能发货");
    expect(supplierSource.match(/await assertPinkCompleted\(tx,/g)).toHaveLength(2);
  });
});
