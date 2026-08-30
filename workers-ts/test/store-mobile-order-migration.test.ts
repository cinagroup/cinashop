import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STORE_MOBILE_ORDER_REFUND_INDEX_SQL } from "../src/migrations/storeMobileCompatibility";
import { MigrationService } from "../src/services/MigrationService";
import { normalizeStoreSplitDeliveryInput } from "../src/services/store/StoreMobileOrderService";

function canonicalSql(value: string): string {
  return value.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();
}

describe("API-008 STORE-B mobile order compatibility", () => {
  it("ships a fail-closed refund lookup index migration", () => {
    const migration = readFileSync("migrations/0108_store_order_refund_lookup_index.sql", "utf8");
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS "sor_store_order_id"');
    expect(migration).toContain('ON "store_order_refund" ("store_order_id")');
    expect(migration).toContain("indexed.indisvalid AS is_valid");
    expect(migration).toContain("indexed.indisready AS is_ready");
    expect(migration).toContain("indexed.indislive AS is_live");
    expect(migration).toContain("indexed.indpred IS NULL AS has_no_predicate");
    expect(migration).toContain("actual.key_columns IS DISTINCT FROM ARRAY['store_order_id']::text[]");
    expect(migration).toContain("actual.key_options IS DISTINCT FROM ARRAY[0]::smallint[]");
    expect(new MigrationService({} as never).storeMobileOrderRefundIndexMigrationSqlForVerification())
      .toBe(STORE_MOBILE_ORDER_REFUND_INDEX_SQL);
    expect(canonicalSql(migration)).toBe(canonicalSql(STORE_MOBILE_ORDER_REFUND_INDEX_SQL));
  });

  it("normalizes only manual express, store delivery, and virtual fulfillment", () => {
    expect(normalizeStoreSplitDeliveryInput({
      type: 1,
      express_record_type: 1,
      delivery_name: "顺丰",
      delivery_code: "SF",
      delivery_id: "SF0001",
    })).toEqual({
      deliveryType: "express",
      deliveryName: "顺丰",
      deliveryCode: "SF",
      deliveryId: "SF0001",
      fictitiousContent: "",
      deliveryUid: 0,
    });
    expect(normalizeStoreSplitDeliveryInput({ type: 2, sh_delivery_uid: 88 })).toMatchObject({
      deliveryType: "send",
      deliveryUid: 88,
      deliveryName: "",
      deliveryId: "",
    });
    expect(normalizeStoreSplitDeliveryInput({ type: 3, fictitious_content: "兑换码已发放" }))
      .toMatchObject({ deliveryType: "fictitious", fictitiousContent: "兑换码已发放" });
    expect(() => normalizeStoreSplitDeliveryInput({
      type: 1,
      express_record_type: 2,
      delivery_name: "顺丰",
      delivery_id: "SF0001",
    })).toThrow("可重试面单任务");
    expect(() => normalizeStoreSplitDeliveryInput({ type: 2, delivery_type: 2, sh_delivery_uid: 88 }))
      .toThrow("第三方同城配送尚未接入");
  });

  it("registers all six exact PHP routes behind station-open and forced user auth", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    for (const [method, path, handler] of [
      ["get", "/store/refund/detail/:id", "StoreMobileOrder.refundDetail"],
      ["get", "/store/order/detail/:id", "StoreMobileOrder.orderDetail"],
      ["get", "/store/order/writeoff_info/:type", "StoreMobileOrder.writeoffInfo"],
      ["post", "/store/order/cart_info", "StoreMobileOrder.cartInfo"],
      ["get", "/store/order/delivery_info/:orderId", "StoreMobileOrder.deliveryInfo"],
      ["put", "/store/order/split_delivery/:id", "StoreMobileOrder.splitDelivery"],
    ] as const) {
      const start = routes.indexOf(`v1Routes.${method}(\n  "${path}"`);
      expect(start, `${method.toUpperCase()} ${path}`).toBeGreaterThan(-1);
      const registration = routes.slice(start, start + 220);
      expect(registration).toContain("stationOpenMiddleware()");
      expect(registration).toContain("authMiddleware({ force: true })");
      expect(registration).toContain(handler);
    }
  });

  it("closes the inherited IDOR and auth=0 writeoff bypasses", () => {
    const service = readFileSync("src/services/store/StoreMobileOrderService.ts", "utf8");
    const writeoff = readFileSync("src/services/order/StoreOrderWriteoffService.ts", "utf8");
    expect(service).toContain("eq(storeOrder.storeId, staff.storeId)");
    expect(service).toContain("eq(storeOrderRefund.storeId, staff.storeId)");
    expect(service).toContain("eq(systemStoreStaff.verifyStatus, 1)");
    expect(service).toContain("门店店员身份存在重复");
    expect(service).toContain("核销身份类型仅支持客服或配送员");
    expect(service).toContain("eq(storeService.customer, 1)");
    expect(writeoff).toContain("infoByOrderId(actor");
    expect(writeoff).toContain("MAX_LEGACY_SEARCH_RESULTS");
  });

  it("reuses the locked fulfillment state machine and validates the delivery identity in-transaction", () => {
    const service = readFileSync("src/services/store/StoreMobileOrderService.ts", "utf8");
    const fulfillment = readFileSync("src/services/supplier/SupplierFulfillmentService.ts", "utf8");
    expect(service).toContain("new SupplierFulfillmentService(this.container, this.env).splitDelivery(");
    expect(service).toContain("expectedStoreId: staff.storeId");
    expect(service).toContain('changeType: "store_staff_split_delivery"');
    expect(service).toContain('eq(deliveryService.type, 1)');
    expect(service).toContain('eq(deliveryService.relationId, staff.storeId)');
    expect(service).toContain('.for("key share")');
    expect(fulfillment).toContain("await lockOrderSettlement(tx, rootId)");
    expect(fulfillment).toContain('await tx.execute(sql.raw("SET LOCAL lock_timeout = \'2s\'"))');
    expect(fulfillment).toContain("await enqueueOrderDeliveryNoticeEvent");
  });

  it("marks every sensitive compatibility response private and bounded", () => {
    const controller = readFileSync("src/controllers/api/v1/StoreMobileOrderController.ts", "utf8");
    const service = readFileSync("src/services/store/StoreMobileOrderService.ts", "utf8");
    const writeoff = readFileSync("src/services/order/StoreOrderWriteoffService.ts", "utf8");
    expect(controller).toContain('c.header("Cache-Control", "private, no-store")');
    expect(controller).toContain('c.header("Pragma", "no-cache")');
    expect(controller.match(/privateResponse\(c\);/g)).toHaveLength(6);
    expect(service).toContain("MAX_JSON_SNAPSHOT_BYTES");
    expect(writeoff).toContain("MAX_JSON_SNAPSHOT_BYTES");
    expect(service).not.toContain("fetch(");
  });
});
