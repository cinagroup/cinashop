import { and, asc, eq, inArray, like, or } from "drizzle-orm";
import { storeDeliveryOrder, storeOrder, storeOrderStatus } from "@/models/schema";
import type { Container } from "@/lib/di";
import { NotFoundException, ValidateException } from "@/utils/errors";

const DELIVERY_STATUS_LABELS: Record<string, string> = {
  "-1": "已取消",
  "2": "待取货",
  "3": "配送中",
  "4": "已完成",
  "9": "物品返回中",
  "10": "物品返回完成",
  "100": "骑士到店",
};

export type DeliveryOrderBase = Pick<
  typeof storeOrder.$inferSelect,
  "id" | "pid" | "orderId" | "status" | "deliveryType" | "deliveryId" | "deliveryName"
>;
export type DeliverySnapshot = typeof storeDeliveryOrder.$inferSelect;
export type DeliveryStatusRow = Pick<
  typeof storeOrderStatus.$inferSelect,
  "changeType" | "changeTime"
>;

function formatUnix(seconds: number, dateOnly: boolean): string {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return "";
  const chinaTime = new Date((seconds + 8 * 60 * 60) * 1000).toISOString();
  return dateOnly ? chinaTime.slice(0, 10) : chinaTime.slice(0, 19).replace("T", " ");
}

function serializeDelivery(delivery: DeliverySnapshot | null) {
  if (!delivery) return null;
  return {
    id: delivery.id,
    oid: delivery.oid,
    station_type: delivery.stationType,
    order_id: delivery.orderId,
    user_name: delivery.userName,
    receiver_phone: delivery.receiverPhone,
    to_address: delivery.toAddress,
    delivery_no: delivery.deliveryNo,
    finish_code: delivery.finishCode,
    distance: delivery.distance,
    fee: delivery.fee,
    status: delivery.status,
  };
}

/** Rebuild the PHP delivery_order/detail/:id response without provider network calls. */
export function buildDeliveryOrderDetail(
  order: DeliveryOrderBase,
  delivery: DeliverySnapshot | null,
  statusRows: DeliveryStatusRow[],
) {
  const times = new Map<string, number>();
  const cityDelivery: Array<{ time: string; label: string }> = [];
  for (const row of statusRows) {
    times.set(row.changeType, row.changeTime);
    if (!row.changeType.startsWith("city_delivery_")) continue;
    const status = row.changeType.slice("city_delivery_".length);
    cityDelivery.push({
      time: formatUnix(row.changeTime, false),
      label: DELIVERY_STATUS_LABELS[status] ?? "配送中",
    });
  }
  const deliveryOrder = serializeDelivery(delivery);
  return {
    id: order.id,
    pid: order.pid,
    order_id: order.orderId,
    status: order.status,
    delivery_type: order.deliveryType,
    delivery_id: order.deliveryId,
    delivery_name: order.deliveryName,
    deliveryOrder,
    delivery_order: deliveryOrder,
    order_log: {
      create: formatUnix(times.get("cache_key_create_order") ?? 0, true),
      pay: formatUnix(times.get("pay_success") ?? 0, true),
      city_delivery: cityDelivery,
      take: formatUnix(times.get("take_delivery") ?? 0, true),
      complete: formatUnix(times.get("check_order_over") ?? 0, true),
    },
  };
}

export class StoreDeliveryOrderService {
  constructor(private readonly container: Container) {}

  /** PHP GET delivery_order/detail/:id; id is the main store-order primary key. */
  async detail(uid: number, orderId: number) {
    if (!Number.isSafeInteger(orderId) || orderId <= 0) {
      throw new ValidateException("参数错误");
    }
    const [order] = await this.container.db
      .select({
        id: storeOrder.id,
        pid: storeOrder.pid,
        orderId: storeOrder.orderId,
        status: storeOrder.status,
        deliveryType: storeOrder.deliveryType,
        deliveryId: storeOrder.deliveryId,
        deliveryName: storeOrder.deliveryName,
      })
      .from(storeOrder)
      .where(and(eq(storeOrder.id, orderId), eq(storeOrder.uid, uid), eq(storeOrder.isDel, 0)))
      .limit(1);
    if (!order) throw new NotFoundException("订单不存在");

    const [deliveryRows, statusRows] = await Promise.all([
      this.container.db
        .select()
        .from(storeDeliveryOrder)
        .where(eq(storeDeliveryOrder.oid, order.id))
        .orderBy(asc(storeDeliveryOrder.id))
        .limit(1),
      this.container.db
        .select({
          changeType: storeOrderStatus.changeType,
          changeTime: storeOrderStatus.changeTime,
        })
        .from(storeOrderStatus)
        .where(
          and(
            eq(storeOrderStatus.oid, order.id),
            or(
              inArray(storeOrderStatus.changeType, [
                "cache_key_create_order",
                "pay_success",
                "take_delivery",
                "check_order_over",
              ]),
              like(storeOrderStatus.changeType, "city_delivery_%"),
            ),
          ),
        )
        .orderBy(asc(storeOrderStatus.changeTime), asc(storeOrderStatus.id)),
    ]);

    return buildDeliveryOrderDetail(order, deliveryRows[0] ?? null, statusRows);
  }
}
