import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import { storeOrder, storeOrderRefund, storePink, user } from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";

function pendingCancellation(orderId: number | SQL, uid: number | SQL, application: string | SQL) {
  return and(eq(storeOrderRefund.storeOrderId, orderId), eq(storeOrderRefund.uid, uid),
    eq(storeOrderRefund.orderId, application), eq(storeOrderRefund.isCancel, 0), eq(storeOrderRefund.isDel, 0),
    inArray(storeOrderRefund.refundType, [0, 1, 2, 4, 5]));
}

/** Correlated predicate for catalog filtering BEFORE LIMIT, without per-group queries.
 * CASE protects the cast even for malformed legacy keys; the int order ID cannot
 * match an out-of-range bigint. Keep identity and refund states shared with admission. */
export function pendingPinkCancellationExists(): SQL<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM ${storeOrderRefund} WHERE ${pendingCancellation(
    sql`CASE WHEN ${storePink.orderIdKey} ~ '^[1-9][0-9]{0,9}$' THEN ${storePink.orderIdKey}::bigint ELSE NULL END`,
    sql`${storePink.uid}`, sql`concat('pink_cancel_', ${storePink.id}::text, '_', ${storePink.orderIdKey})`,
  )})`;
}

/** The dedicated refund row is the durable cancellation intent. No new pink
 * status is invented, and provider failure never masquerades as money returned. */
export async function hasPendingPinkCancellation(
  db: DbClient,
  leader: Pick<typeof storePink.$inferSelect, "id" | "uid" | "orderIdKey">,
): Promise<boolean> {
  if (!/^[1-9]\d{0,9}$/.test(leader.orderIdKey) || Number(leader.orderIdKey) > 2_147_483_647) return false;
  const pending = await db.select({ id: storeOrderRefund.id }).from(storeOrderRefund).where(pendingCancellation(
    Number(leader.orderIdKey), leader.uid, `pink_cancel_${leader.id}_${leader.orderIdKey}`,
  )).limit(1);
  return pending.length > 0;
}

/** Called by the refund core AFTER its order lock, BEFORE a new application is
 * inserted. The leader lock is retained until that same transaction commits,
 * matching reservation/payment activation and timeout's group boundary. */
export async function authorizePinkCancellationApplication(
  tx: DbClient,
  order: typeof storeOrder.$inferSelect,
  input: { uid: number; pinkId: number; combinationId: number },
): Promise<void> {
  const { uid, pinkId, combinationId } = input;
  if (order.uid !== uid || order.type !== 3 || order.activityId !== combinationId || order.pinkId !== pinkId ||
      order.paid !== 1 || order.status !== 0 || order.refundStatus !== 0 || order.isDel !== 0 || order.isSystemDel !== 0) {
    throw new ValidateException("拼团订单状态已变化，请刷新后重试");
  }
  const [leader] = await tx.select().from(storePink).where(eq(storePink.id, pinkId)).limit(1).for("update");
  if (!leader || leader.uid !== uid || leader.combinationId !== combinationId || leader.kId !== 0 ||
      leader.status !== 1 || leader.isRefund !== 0 || leader.orderIdKey !== String(order.id) || leader.orderId !== order.orderId) {
    throw new ValidateException("拼团状态已变化，不能取消");
  }
  // Do not use the transaction start time, or a deadline evaluated BEFORE a
  // lock wait. This statement runs after the leader lock is actually acquired.
  const [deadline] = await tx.select({ active: sql<boolean | null>`${storePink.stopTime} > (clock_timestamp() AT TIME ZONE 'UTC')` })
    .from(storePink).where(eq(storePink.id, pinkId));
  if (deadline?.active !== true) throw new ValidateException("拼团已到期，等待结算");
  const [account] = await tx.select({ uid: user.uid }).from(user).where(and(
    eq(user.uid, uid), eq(user.status, 1), eq(user.isDel, 0),
  )).limit(1);
  if (!account) throw new NotFoundException("用户不存在或已停用");
  const [members] = await tx.select({ count: sql<number>`COUNT(*)::int` }).from(storePink)
    .where(and(eq(storePink.kId, pinkId), eq(storePink.isRefund, 0)));
  if (leader.people <= 1 || Number(members.count) + 1 >= leader.people) {
    throw new ValidateException("拼团人数已满或配置无效，不能取消");
  }
  if (Number(members.count) === 0) {
    const pending = await tx.select({ id: storeOrder.id }).from(storeOrder).where(and(
      eq(storeOrder.type, 3), eq(storeOrder.pinkId, pinkId), eq(storeOrder.paid, 0),
      eq(storeOrder.status, 0), eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0),
    )).limit(1);
    if (pending[0]) throw new ValidateException("该团仍有待支付参团订单，暂不能取消");
  }
}
