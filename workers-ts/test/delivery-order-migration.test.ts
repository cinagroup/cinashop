import { readFileSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import { storeDeliveryOrder } from "../src/models/schema";
import {
  buildDeliveryOrderDetail,
  type DeliveryOrderBase,
  type DeliverySnapshot,
} from "../src/services/order/StoreDeliveryOrderService";

function delivery(overrides: Partial<DeliverySnapshot> = {}): DeliverySnapshot {
  return {
    id: 9,
    type: 0,
    relationId: 0,
    oid: 7,
    uid: 5,
    stationType: 1,
    orderId: "dd-provider-order",
    deliveryNo: "provider-9",
    cityCode: "西安",
    cargoPrice: "88.00",
    finishCode: "2468",
    userName: "张三",
    receiverPhone: "13800138000",
    fromAddress: "起点",
    toAddress: "终点",
    fromLat: "34.1",
    fromLng: "108.1",
    toLat: "34.2",
    toLng: "108.2",
    distance: 1800,
    fee: "6.50",
    deductFee: "0.00",
    merId: 0,
    mark: "",
    status: 3,
    reason: "",
    addTime: 1_704_067_200,
    ...overrides,
  };
}

const order: DeliveryOrderBase = {
  id: 7,
  pid: 0,
  orderId: "wx-main-order",
  status: 1,
  deliveryType: "send",
  deliveryId: "13800138000",
  deliveryName: "配送员",
};

describe("same-city delivery order migration", () => {
  it("preserves all 27 install SQL columns and their location/fee types", () => {
    const columns = getTableColumns(storeDeliveryOrder);
    expect(Object.keys(columns)).toEqual([
      "id",
      "type",
      "relationId",
      "oid",
      "uid",
      "stationType",
      "orderId",
      "deliveryNo",
      "cityCode",
      "cargoPrice",
      "finishCode",
      "userName",
      "receiverPhone",
      "fromAddress",
      "toAddress",
      "fromLat",
      "fromLng",
      "toLat",
      "toLng",
      "distance",
      "fee",
      "deductFee",
      "merId",
      "mark",
      "status",
      "reason",
      "addTime",
    ]);
    expect(columns.cargoPrice.getSQLType()).toBe("numeric(8, 2)");
    expect(columns.distance.getSQLType()).toBe("real");
    expect(columns.receiverPhone.getSQLType()).toBe("varchar(11)");
    expect(columns).not.toHaveProperty("info");
    expect(getTableConfig(storeDeliveryOrder).uniqueConstraints).toHaveLength(0);
  });

  it("places delivery snapshots after their parent order in the commerce phase", () => {
    const names = MIGRATION_TABLES.map((entry) => entry.table);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "store_delivery_order")).toMatchObject({
      key: ["id"],
      phase: "commerce",
    });
    expect(names.indexOf("store_order")).toBeLessThan(names.indexOf("store_delivery_order"));
  });

  it("rebuilds provider status labels and the PHP-compatible status trail", () => {
    const result = buildDeliveryOrderDetail(order, delivery(), [
      { changeType: "cache_key_create_order", changeTime: 1_704_067_200 },
      { changeType: "pay_success", changeTime: 1_704_067_260 },
      { changeType: "city_delivery_2", changeTime: 1_704_067_320 },
      { changeType: "city_delivery_100", changeTime: 1_704_067_380 },
      { changeType: "take_delivery", changeTime: 1_704_067_440 },
      { changeType: "check_order_over", changeTime: 1_704_067_500 },
    ]);

    expect(result).toMatchObject({
      id: 7,
      order_id: "wx-main-order",
      delivery_order: {
        oid: 7,
        station_type: 1,
        delivery_no: "provider-9",
        finish_code: "2468",
        fee: "6.50",
      },
      order_log: {
        create: "2024-01-01",
        pay: "2024-01-01",
        city_delivery: [
          { time: "2024-01-01 08:02:00", label: "待取货" },
          { time: "2024-01-01 08:03:00", label: "骑士到店" },
        ],
        take: "2024-01-01",
        complete: "2024-01-01",
      },
    });
    expect(result.deliveryOrder).toEqual(result.delivery_order);
  });

  it("authorizes the parent order before batch-loading delivery and status rows", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const service = readFileSync("src/services/order/StoreDeliveryOrderService.ts", "utf8");
    expect(routes).toContain('"/delivery_order/detail/:id"');
    expect(service).toContain("eq(storeOrder.uid, uid)");
    expect(service.indexOf("eq(storeOrder.uid, uid)")).toBeLessThan(
      service.indexOf("const [deliveryRows, statusRows] = await Promise.all"),
    );
  });
});
