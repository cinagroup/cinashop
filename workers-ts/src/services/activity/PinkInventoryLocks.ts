import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import { storeCombination, storeOrder } from "@/models/schema";
import { lockOrderSettlement } from "@/services/order/OrderBrokerageService";
import { ValidateException } from "@/utils/errors";

/** Inventory writers serialize before carts/orders/users/groups. NO KEY UPDATE
 * deliberately permits payment activation's KEY SHARE: that payment may already
 * own an order row which a refund must wait for before touching its group. */
export async function lockPinkInventory(tx: DbClient, activityId: number): Promise<void> {
  if (activityId <= 0) return;
  await tx.select({ id: storeCombination.id }).from(storeCombination)
    .where(eq(storeCombination.id, activityId)).limit(1).for("no key update");
}

/** Must run before the refund's own order advisory/row lock and all user/pink
 * locks. Leader promotion rewrites other orders, including unpaid reservations.
 * Lock their settlement advisories first, then their rows in the same ID order;
 * do not invert the advisory -> row order used by receipt/refund application. */
export async function lockPinkRefundOrders(tx: DbClient, orderId: number): Promise<boolean> {
  const [initial] = await tx.select({ type: storeOrder.type, activityId: storeOrder.activityId })
    .from(storeOrder).where(eq(storeOrder.id, orderId)).limit(1);
  if (!initial || initial.type !== 3) return false;
  await lockPinkInventory(tx, initial.activityId);
  // Another refund may have promoted a new leader during the activity wait.
  const [current] = await tx.select({ type: storeOrder.type, activityId: storeOrder.activityId, pinkId: storeOrder.pinkId })
    .from(storeOrder).where(eq(storeOrder.id, orderId)).limit(1);
  if (!current || current.type !== 3 || current.activityId !== initial.activityId) {
    throw new ValidateException("拼团订单活动已变化，请重试");
  }
  const orders = await tx.select({ id: storeOrder.id }).from(storeOrder).where(or(
    eq(storeOrder.id, orderId),
    current.pinkId > 0 ? and(eq(storeOrder.type, 3), eq(storeOrder.pinkId, current.pinkId)) : undefined,
  )).orderBy(asc(storeOrder.id));
  for (const order of orders) await lockOrderSettlement(tx, order.id);
  const locked = await tx.select({ id: storeOrder.id, type: storeOrder.type,
    activityId: storeOrder.activityId, pinkId: storeOrder.pinkId }).from(storeOrder)
    .where(inArray(storeOrder.id, orders.map(order => order.id))).orderBy(asc(storeOrder.id)).for("update");
  const own = locked.find(order => order.id === orderId);
  if (!own || own.type !== 3 || own.activityId !== current.activityId || own.pinkId !== current.pinkId) {
    throw new ValidateException("拼团订单关联已变化，请重试");
  }
  return true;
}
