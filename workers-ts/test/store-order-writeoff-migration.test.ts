import { readFileSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { storeOrderCartInfo, storeOrderWriteoff, systemStore, systemStoreStaff } from "../src/models/schema";
import {
  calculateWriteoffLinePrice,
  normalizePickupVerifyCode,
} from "../src/services/order/StoreOrderWriteoffService";

describe("pickup-store and writeoff migration", () => {
  it("preserves the PHP writeoff evidence and per-line counters", () => {
    expect(Object.keys(getTableColumns(storeOrderWriteoff))).toEqual(expect.arrayContaining([
      "oid",
      "orderCartId",
      "writeoffNum",
      "writeoffPrice",
      "writeoffCode",
      "staffId",
      "isAdmin",
      "adminId",
    ]));
    expect(Object.keys(getTableColumns(storeOrderCartInfo))).toEqual(expect.arrayContaining([
      "writeTimes",
      "writeSurplusTimes",
      "writeStart",
      "writeEnd",
      "isWriteoff",
      "writeoffTime",
      "staffId",
    ]));
    expect(Object.keys(getTableColumns(systemStore))).toContain("isStore");
    expect(Object.keys(getTableColumns(systemStoreStaff))).toEqual(expect.arrayContaining([
      "storeId",
      "uid",
      "verifyStatus",
      "status",
      "isDel",
    ]));
  });

  it("validates 12-digit codes and prices both Worker and legacy PHP snapshots", () => {
    expect(normalizePickupVerifyCode(" 001122334455 ")).toBe("001122334455");
    expect(() => normalizePickupVerifyCode("112233")).toThrow("12位核销码");
    expect(calculateWriteoffLinePrice(JSON.stringify({ sku: { price: "12.34" } }), 2)).toBe("24.68");
    expect(calculateWriteoffLinePrice(JSON.stringify({ productInfo: { truePrice: "8.05" } }), 3)).toBe("24.15");
    expect(() => calculateWriteoffLinePrice("{}", 1)).toThrow("价格快照无效");
  });

  it("serializes writeoff, rejects refund races, and applies stable lock order", () => {
    const source = readFileSync("src/services/order/StoreOrderWriteoffService.ts", "utf8");
    const refund = readFileSync("src/services/order/StoreOrderRefundService.ts", "utf8");
    expect(source).toContain("await lockOrderSettlement(tx, candidates[0].id)");
    expect(source).toContain('.orderBy(asc(storeOrderCartInfo.id))');
    expect(source).toContain('.for("update")');
    expect(source).toContain("eq(systemStoreStaff.storeId, order.storeId)");
    expect(source).toContain("eq(systemStoreStaff.verifyStatus, 1)");
    expect(source).toContain("inArray(storeOrderRefund.refundType, OPEN_REFUND_TYPES)");
    expect(refund).toContain("Refund applications, writeoff, receipt, and refund execution share one order lock");
    expect(refund).toContain("export async function applyOrderRefund(");
    expect(refund).toContain('get("refund_time_available")');
    expect(refund).toContain(
      "return applyOrderRefund(this.container, params, parseRefundTimeDays(configured))",
    );
    expect(refund).toContain("await lockOrderSettlement(tx, candidate.id)");
    expect(refund).toContain("item.writeTimes > item.writeSurplusTimes");
    expect(refund).toContain("订单已有核销记录，请仅选择未核销商品申请售后");
  });

  it("keeps a production-PostgreSQL isolation scenario for the remaining concurrency guards", () => {
    const integration = readFileSync(
      "test/integration/StoreOrderWriteoffPostgresScenario.ts",
      "utf8",
    );
    expect(integration).toContain('return `codex_writeoff_it_');
    expect(integration).toContain('SET LOCAL lock_timeout = \'3s\'');
    expect(integration).toContain('SELECT to_regnamespace(${schemaName}) IS NULL AS schema_removed');
    expect(integration).toContain('"store_order_refund"');
    expect(integration).toContain("duplicate staff identity must be reported");
    expect(integration).toContain("duplicate delivery identity must be reported");
    expect(integration).toContain("unformed combination must fail at the group guard");
    expect(integration).toContain("refund/writeoff race must have exactly one winner");
    expect(integration).toContain("refund/writeoff loser must be rejected by a business invariant");
    expect(integration).toContain("public business rows or sequences changed");
  });

  it("rotates partial codes and reuses the one receipt settlement state machine", () => {
    const source = readFileSync("src/services/order/StoreOrderWriteoffService.ts", "utf8");
    const brokerage = readFileSync("src/services/order/OrderBrokerageService.ts", "utf8");
    expect(source).toContain("const nextCode = await generatePickupVerifyCode(tx, order.id)");
    expect(source).toContain("status: 5, verifyCode: nextCode");
    expect(source).toContain('status: 2, verifyCode: ""');
    expect(source).toContain("await settleCompletedOrderInTx(");
    expect(brokerage).toContain("export async function settleCompletedOrderInTx");
    expect(brokerage).toContain("await settleSupplierPayment");
    expect(brokerage).toContain("await settleOrderRewards");
    expect(brokerage).toContain("await settleOrderBrokerage");
  });

  it("creates pickup orders only for active stores and exposes protected operator routes", () => {
    const create = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    const store = readFileSync("src/services/store/StoreOperationsService.ts", "utf8");
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    expect(create).toContain("eq(systemStore.isStore, 1)");
    expect(create).toContain("verifyCode = await generatePickupVerifyCode(tx)");
    expect(create).toContain("storeId: pickupStoreId");
    expect(store).toContain("async publicPickupStores()");
    expect(store).toContain("eq(systemStore.isShow, 1)");
    expect(routes).toContain('v1Routes.get("/store/list"');
    expect(routes).toContain('"/store/order/writeoff"');
    expect(routes).toContain("authMiddleware({ force: true })");
    expect(adminRoutes).toContain('adminapiRoutes.post("/order/writeoff"');
  });

  it("closes the platform-delivery writeoff path without allowing receipt bypasses", () => {
    const writeoff = readFileSync("src/services/order/StoreOrderWriteoffService.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/AdminCrudController.ts", "utf8");
    const create = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    const scheduled = readFileSync("src/services/order/ScheduledMaintenanceService.ts", "utf8");
    const settlement = readFileSync("src/services/order/OrderBrokerageService.ts", "utf8");
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const operatorPage = readFileSync("../view/uniapp-ts/src/pages/operator/writeoff.vue", "utf8");
    const adminOrders = readFileSync("../view/admin-ts/src/pages/order/OrderList.vue", "utf8");
    const supplierFulfillment = readFileSync("src/services/supplier/SupplierFulfillmentService.ts", "utf8");
    const supplierOrders = readFileSync("../view/supplier-ts/src/pages/Orders.vue", "utf8");
    expect(writeoff).toContain('| { kind: "delivery"; uid: number }');
    expect(writeoff).toContain('eq(storeOrder.deliveryType, "send")');
    expect(writeoff).toContain("eq(storeOrder.deliveryUid, actor.uid)");
    expect(writeoff).toContain("eq(deliveryService.type, 0)");
    expect(writeoff).toContain("deliveryId: operator.deliveryId");
    expect(controller).toContain("verifyCode = await generatePickupVerifyCode(tx)");
    expect(create).toContain('order.deliveryType === "send"');
    expect(create).toContain("该订单必须使用核销码完成履约");
    expect(scheduled).toContain('conditions.push(ne(storeOrder.deliveryType, "send"))');
    expect(settlement).toContain('ne(storeOrder.shippingType, 2)');
    expect(settlement).toContain('ne(storeOrder.deliveryType, "send")');
    expect(routes).toContain('"/store/operator/profile"');
    expect(routes).toContain('"/delivery/order/writeoff"');
    expect(operatorPage).toContain("uni.scanCode({");
    expect(operatorPage).toContain("apiOperatorWriteoff(");
    expect(adminOrders).toContain("apiAdminDeliveryOptions");
    expect(adminOrders).toContain('delivery_type === \'send\'');
    expect(supplierFulfillment).toContain('if (deliveryType === "send")');
    expect(supplierFulfillment).toContain("供应商同城配送尚未接入实名配送员与核销链路");
    expect(supplierOrders).not.toContain('<el-radio-button value="send">');
  });

  it("keeps the production verify-code lookup index in an idempotent migration", () => {
    const migration = readFileSync("migrations/0078_fulfillment_lookup_indexes.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(
      /private migration_0085\(\): string \{\s*return `([\s\S]*?)`;\s*\}/,
    )?.[1].trim();
    expect(embedded).toBe(migration);
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS "so_verify_code"');
    expect(service).toContain("this.migration_0085()");
  });
});
