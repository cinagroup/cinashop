import { buildOrderLifecycleLog, readOrderLifecycleRows, withOrderLifecycleSnapshot, type LifecycleRow } from './OrderLifecycleTimeline';
import { and, asc, eq } from "drizzle-orm";
import { storeDeliveryOrder, storeOrder } from "@/models/schema";
import type { Container } from "@/lib/di";
import { NotFoundException, ValidateException } from "@/utils/errors";

export type DeliveryOrderBase = Pick<
  typeof storeOrder.$inferSelect,
  "id" | "pid" | "orderId" | "status" | "deliveryType" | "deliveryId" | "deliveryName"
>;
export type DeliverySnapshot = typeof storeDeliveryOrder.$inferSelect;
export type DeliveryStatusRow = LifecycleRow;

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
    order_log: buildOrderLifecycleLog(statusRows, true),
  };
}

export class StoreDeliveryOrderService {
  constructor(private readonly container: Container) {}

  /** PHP GET delivery_order/detail/:id; id is the main store-order primary key. */
  async detail(uid: number, orderId: number) {
    if (!Number.isSafeInteger(orderId) || orderId <= 0 || orderId > 2_147_483_647) {
      throw new ValidateException("参数错误");
    }
    return withOrderLifecycleSnapshot(this.container, async db => {
      const [order] = await db
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
        db
          .select()
          .from(storeDeliveryOrder)
          .where(eq(storeDeliveryOrder.oid, order.id))
          .orderBy(asc(storeDeliveryOrder.id))
          .limit(1),
        readOrderLifecycleRows(db, order.id, true),
      ]);

      return buildDeliveryOrderDetail(order, deliveryRows[0] ?? null, statusRows);
    });
  }
}
