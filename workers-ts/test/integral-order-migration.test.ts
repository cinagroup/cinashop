import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import {
  storeIntegralOrder,
  storeIntegralOrderStatus,
} from "../src/models/schema";
import {
  formatIntegralOrder,
  integralOrderStatusName,
} from "../src/services/activity/StoreIntegralOrderService";

describe("integral order migration", () => {
  it("preserves all 44 historical order columns and the four-column append-only trail", () => {
    expect(Object.keys(getTableColumns(storeIntegralOrder))).toEqual([
      "id",
      "orderId",
      "tradeNo",
      "uid",
      "realName",
      "userPhone",
      "userAddress",
      "productId",
      "image",
      "storeName",
      "suk",
      "unique",
      "cartInfo",
      "totalNum",
      "price",
      "totalPrice",
      "integral",
      "totalIntegral",
      "paid",
      "payTime",
      "payType",
      "addTime",
      "status",
      "deliveryName",
      "deliveryCode",
      "deliveryType",
      "deliveryId",
      "fictitiousContent",
      "deliveryUid",
      "mark",
      "isDel",
      "remark",
      "merId",
      "isMerCheck",
      "isRemind",
      "isSystemDel",
      "channelType",
      "province",
      "expressDump",
      "kuaidiLabel",
      "verifyCode",
      "productType",
      "virtualInfo",
      "customForm",
    ]);
    expect(Object.keys(getTableColumns(storeIntegralOrderStatus))).toEqual([
      "oid",
      "changeType",
      "changeMessage",
      "changeTime",
    ]);
    expect(getTableName(storeIntegralOrder)).toBe("store_integral_order");
    expect(getTableName(storeIntegralOrderStatus)).toBe("store_integral_order_status");
    expect(getTableColumns(storeIntegralOrder).price.getSQLType()).toBe("numeric(12, 2)");
  });

  it("keeps old tables historical while current writes use unified store_order(type=4)", () => {
    expect(MIGRATION_TABLES.find((entry) => entry.table === "store_integral_order")).toMatchObject({
      key: ["id"],
      phase: "commerce",
      note: expect.stringContaining("store_order type=4"),
    });
    expect(
      MIGRATION_TABLES.find((entry) => entry.table === "store_integral_order_status"),
    ).toMatchObject({
      key: [],
      copyStrategy: "append_multiset",
      phase: "commerce",
      note: expect.stringContaining("multiset"),
    });

    const activity = readFileSync("src/services/activity/ActivityService.ts", "utf8");
    const controller = readFileSync(
      "src/controllers/api/v1/UserActivityController.ts",
      "utf8",
    );
    const exchange = activity.match(/async exchange\([\s\S]*?\n  private async runInTx/)?.[0] ?? "";
    expect(exchange).toContain("type: 4");
    expect(exchange).toContain("activityId: integralId");
    expect(exchange).toContain(".returning({ id: storeIntegral.id })");
    expect(exchange).toContain(".update(storeProductAttrValue)");
    expect(exchange).toContain(".update(storeProduct)");
    expect(exchange).toContain("tx.insert(storeOrderCartInfo)");
    expect(exchange).toContain("tx.insert(storeOrderStatus)");
    expect(exchange).toContain('.for("update")');
    expect(exchange).toContain("idempotencyKey");
    expect(exchange.match(/COALESCE\(SUM/g)).toHaveLength(2);
    expect(exchange).toContain("积分加现金或运费商品请走统一购物车下单流程");
    expect(exchange).toContain("该积分商品请走统一购物车下单流程");
    expect(exchange).toContain("enqueueOrderPaidEvent(tx as unknown as DbClient, order, now)");
    expect(exchange).not.toContain("type: 3");
    expect(controller).toContain('c.req.header("Idempotency-Key")');
  });

  it("restores PHP user/admin route aliases without exposing cross-user details", () => {
    const apiRoutes = readFileSync("src/routes/v1/index.ts", "utf8");
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    const service = readFileSync(
      "src/services/activity/StoreIntegralOrderService.ts",
      "utf8",
    );
    expect(apiRoutes).toContain('"/store_integral/order/list"');
    expect(apiRoutes).toContain('"/store_integral/order/detail/:uni"');
    expect(apiRoutes).toContain('"/store_integral/order/del"');
    expect(apiRoutes).toContain('"/admin/integral/order/list"');
    expect(adminRoutes).toContain('"/integral/order/list"');
    expect(adminRoutes).toContain('"/integral/order/chart"');
    expect(service).toContain("order.uid !== uid");
    expect(service).toContain("order.type !== INTEGRAL_ORDER_TYPE");
    expect(service).toContain("paid: 1");
  });

  it("formats the unified order state machine for legacy clients", () => {
    expect(integralOrderStatusName({ paid: 0, status: 0 })).toBe("待付款");
    expect(integralOrderStatusName({ paid: 1, status: 0 })).toBe("待发货");
    expect(integralOrderStatusName({ paid: 1, status: 1 })).toBe("待收货");
    expect(integralOrderStatusName({ paid: 1, status: 2 })).toBe("待评价");
    expect(integralOrderStatusName({ paid: 1, status: 3 })).toBe("已完成");
    expect(formatIntegralOrder({ id: 7, paid: 1, status: 0 })).toMatchObject({
      id: 7,
      statusName: "待发货",
      status_name: "待发货",
    });
  });

  it("routes cash, freight and address-bearing integral goods through the unified cart/order/payment chain", () => {
    const cart = readFileSync("src/services/order/StoreCartService.ts", "utf8");
    const create = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    const pay = readFileSync("src/services/order/StoreOrderPayService.ts", "utf8");
    const storefront = readFileSync("../view/uniapp-ts/src/pages/user/integral.vue", "utf8");
    expect(cart).toContain("resolveIntegralSku");
    expect(cart).toContain("积分商品与关联商品不匹配");
    expect(create).toContain("cinashop:integral-order:");
    expect(create).toContain("payIntegral: requiredIntegral");
    expect(create).toContain("积分商品不能使用优惠券");
    expect(create).toContain("积分商品不能叠加普通订单积分抵扣");
    expect(create).toContain("请填写完整的收货人、手机号和收货地址");
    expect(pay).toContain("debitRequiredOrderIntegral");
    expect(storefront).toContain("apiCartAdd");
    expect(storefront).toContain("/pages/order/confirm?mode=buy");
    expect(storefront).not.toContain("/store_integral/exchange/");
  });
});
