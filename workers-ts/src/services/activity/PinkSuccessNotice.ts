import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderRefund, storePink } from '@/models/schema';
import { enqueueOrderPinkSuccessNoticeEvent } from '@/services/order/OrderNotificationOutboxService';

/** Runs inside the transaction that commits group success. Virtual members have
 * no order, inventory, bill or notice. Queue/provider delivery stays outside. */
export async function enqueuePinkSuccessNotices(tx: DbClient, leaderId: number, now: number): Promise<void> {
  if (!Number.isSafeInteger(leaderId) || leaderId <= 0 || leaderId > 2_147_483_647 ||
    !Number.isSafeInteger(now) || now < 0 || now > 2_147_483_647) throw new Error('拼团成功通知身份无效');
  const [leader] = await tx.select().from(storePink).where(eq(storePink.id, leaderId)).limit(1);
  if (!leader || leader.kId !== 0 || leader.status !== 2 || leader.isRefund !== 0 || leader.isVirtual !== 0 || leader.uid <= 0 ||
    !Number.isSafeInteger(leader.people) || leader.people < 2 || leader.people > 500) throw new Error('拼团成功通知缺少有效终态');
  const orders = await tx.selectDistinct({ id: storeOrder.id, orderNo: storeOrder.orderId, uid: storeOrder.uid })
    .from(storePink).innerJoin(storeOrder, and(eq(storeOrder.uid, storePink.uid),
      eq(storeOrder.type, 3), eq(storeOrder.activityId, leader.combinationId), eq(storeOrder.pinkId, leaderId),
      or(eq(storeOrder.orderId, storePink.orderId), eq(storeOrder.unique, storePink.orderIdKey), sql`${storeOrder.id}::text=${storePink.orderIdKey}`),
      or(inArray(storePink.orderId, ['', '0']), eq(storeOrder.orderId, storePink.orderId)),
      or(inArray(storePink.orderIdKey, ['', '0']), eq(storeOrder.unique, storePink.orderIdKey), sql`${storeOrder.id}::text=${storePink.orderIdKey}`)))
    .where(and(or(eq(storePink.id, leaderId), eq(storePink.kId, leaderId)),
      eq(storePink.combinationId, leader.combinationId), eq(storePink.productId, leader.productId),
      eq(storePink.status, 2), eq(storePink.isRefund, 0), eq(storePink.isVirtual, 0), sql`${storePink.uid}>0`,
      eq(storeOrder.paid, 1), eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0), inArray(storeOrder.refundStatus, [0, 3]),
      sql`NOT EXISTS (SELECT 1 FROM ${storeOrderRefund} WHERE ${storeOrderRefund.storeOrderId}=${storeOrder.id}
        AND ${storeOrderRefund.isCancel}=0 AND ${storeOrderRefund.isDel}=0 AND ${storeOrderRefund.refundType} IN (0,1,2,4,5))`))
    .orderBy(asc(storeOrder.id)).limit(501);
  if (orders.length > 500 || orders.length > leader.people) throw new Error('拼团成功通知订单超过完整成员容量');
  for (const order of orders) await enqueueOrderPinkSuccessNoticeEvent(tx, {
    orderId: order.id, orderNo: order.orderNo, userId: order.uid, pinkId: leaderId, people: leader.people,
  }, now);
}
