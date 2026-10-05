import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { storeCombination, storeOrder, storeOrderRefund, storePink } from "@/models/schema";
import { withTx, type Container } from "@/lib/di";
import type { Env } from "@/env";
import { lockPinkInventory } from './PinkInventoryLocks';
import { lockOrderSettlement } from '@/services/order/OrderBrokerageService';
import { enqueuePinkSuccessNotices } from './PinkSuccessNotice';
import { reachesPinkVirtualThreshold, validPinkPaidIdentity } from './PinkVirtualCompletion';
import {
  ensureAutomaticOrderRefund,
  StoreOrderRefundService,
} from "@/services/order/StoreOrderRefundService";

const MAX_AUTOMATIC_REFUNDS_PER_ORDER = 2;

export class PinkTimeoutService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async expireGroup(
    leaderId: number,
    now?: number,
  ): Promise<{ expired: boolean; orders: number; completedRefunds: number; pendingRefunds: number; completed?: boolean }> {
    if (now !== undefined && (!Number.isSafeInteger(now) || now < 0 || now > 2_147_483_647)) throw new Error('拼团结算时间无效');
    const transition = await withTx(this.container, async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      const [initial] = await tx.select().from(storePink).where(eq(storePink.id, leaderId)).limit(1);
      if (!initial || initial.kId !== 0) return null;
      // Match refund's inventory -> settlement advisories -> orders -> group
      // boundary. Payment may own an order before its compatible KEY SHARE;
      // never hold its leader while waiting for that order.
      await lockPinkInventory(tx, initial.combinationId);
      const linkedOrders = await tx
        .selectDistinct({ id: storeOrder.id })
        .from(storeOrder)
        .leftJoin(storePink, and(
          or(eq(storePink.id, leaderId), eq(storePink.kId, leaderId)),
          eq(storePink.isVirtual, 0), eq(storePink.uid, storeOrder.uid),
          eq(storeOrder.type, 3), eq(storeOrder.activityId, storePink.combinationId),
          or(and(ne(storePink.orderId, ''), eq(storeOrder.orderId, storePink.orderId)),
            and(ne(storePink.orderIdKey, ''), or(eq(storeOrder.unique, storePink.orderIdKey), sql`${storeOrder.id}::text = ${storePink.orderIdKey}`))),
        ))
        .where(or(and(eq(storeOrder.type, 3), eq(storeOrder.pinkId, leaderId)), sql`${storePink.id} IS NOT NULL`))
        .orderBy(asc(storeOrder.id));
      for (const order of linkedOrders) await lockOrderSettlement(tx, order.id);
      const lockedOrders = linkedOrders.length ? await tx.select().from(storeOrder)
        .where(inArray(storeOrder.id, linkedOrders.map(order => order.id))).orderBy(asc(storeOrder.id)).for('update') : [];
      const rows = await tx
        .select()
        .from(storePink)
        .where(eq(storePink.id, leaderId))
        .limit(1)
        .for("update");
      const leader = rows[0];
      if (!leader || leader.kId !== 0 || leader.combinationId !== initial.combinationId) return null;
      const members = await tx.select().from(storePink).where(eq(storePink.kId, leaderId)).orderBy(asc(storePink.id)).for('update');
      const [clock] = await tx.select({ milliseconds: sql<string>`floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint` }).from(sql`(values (1)) AS pink_clock(n)`);
      const settlementMilliseconds = Math.max(Number(clock.milliseconds), (now ?? 0) * 1000);
      const settledAt = Math.floor(settlementMilliseconds / 1000);
      const alreadyFailed = leader.status === 3;
      if (!alreadyFailed && leader.isRefund !== 0) return null;

      const paidOrders = await tx
        .selectDistinct({ id: storeOrder.id })
        .from(storePink)
        .innerJoin(
          storeOrder,
          and(
            eq(storeOrder.uid, storePink.uid),
            eq(storeOrder.type, 3),
            eq(storeOrder.activityId, storePink.combinationId),
            eq(storeOrder.paid, 1),
            or(
              and(ne(storePink.orderId, ""), eq(storeOrder.orderId, storePink.orderId)),
              and(
                ne(storePink.orderIdKey, ""),
                or(
                  eq(storeOrder.unique, storePink.orderIdKey),
                  sql`${storeOrder.id}::text = ${storePink.orderIdKey}`,
                ),
              ),
            ),
          ),
        )
        .where(
          and(
            or(eq(storePink.id, leaderId), eq(storePink.kId, leaderId)),
            eq(storePink.isVirtual, 0),
          ),
        );

      let deadline = leader.stopTime;
      if (leader.status === 1 && deadline === null && paidOrders.length > 0) {
        const combinations = await tx
          .select({ effectiveTime: storeCombination.effectiveTime })
          .from(storeCombination)
          .where(eq(storeCombination.id, leader.combinationId))
          .limit(1);
        if (combinations[0]) {
          deadline = new Date(
            (leader.addTime + Math.max(0, combinations[0].effectiveTime) * 3600) * 1000,
          );
          await tx
            .update(storePink)
            .set({ stopTime: deadline })
            .where(eq(storePink.id, leaderId));
        }
      }

      const timedOut = leader.status === 1
        && deadline !== null
        && deadline.getTime() <= settlementMilliseconds;
      const legacyOrphan = paidOrders.length === 0;
      if (!alreadyFailed && !timedOut && !legacyOrphan) return null;

      if (timedOut && !alreadyFailed && !legacyOrphan && leader.isRefund === 0 && leader.isVirtual === 0 && leader.uid > 0) {
        const [combination] = await tx.select().from(storeCombination).where(eq(storeCombination.id, leader.combinationId)).limit(1);
        const liveMembers = [leader, ...members].filter(member => member.isRefund === 0);
        const identities = liveMembers.map(member => ({ member, orders: lockedOrders.filter(order => validPinkPaidIdentity(member, order, leader)) }));
        const validOrders = identities.flatMap(identity => identity.orders);
        const pendingRefunds = linkedOrders.length ? await tx.select({ id: storeOrderRefund.id }).from(storeOrderRefund).where(and(
          inArray(storeOrderRefund.storeOrderId, linkedOrders.map(order => order.id)), eq(storeOrderRefund.isDel, 0), eq(storeOrderRefund.isCancel, 0),
          inArray(storeOrderRefund.refundType, [0, 1, 2, 4, 5]),
        )).limit(1) : [];
        const canonical = identities.every(identity => identity.orders.length === 1)
          && new Set(validOrders.map(order => order.id)).size === liveMembers.length
          && new Set(liveMembers.map(member => member.uid)).size === liveMembers.length
          && lockedOrders.filter(order => order.type === 3 && order.activityId === leader.combinationId
            && order.pinkId === leader.id && order.paid === 1 && order.refundStatus !== 2).length === validOrders.length;
        if (combination && canonical && pendingRefunds.length === 0
          && reachesPinkVirtualThreshold(liveMembers.length, leader.people, combination.virtual)) {
          const endedAt = new Date(settledAt * 1000);
          const missing = leader.people - liveMembers.length;
          if (missing > 0) await tx.insert(storePink).values(Array.from({ length: missing }, (_, index) => ({
            uid: 0, nickname: `虚拟团员${index + 1}`, avatar: '', orderId: '0', orderIdKey: '0', totalNum: 0, totalPrice: '0.00',
            combinationId: leader.combinationId, productId: leader.productId, kId: leader.id, people: leader.people,
            memberCount: 0, price: '0.00', status: 2, stopTime: endedAt, isVirtual: 1, isTpl: 1, isRefund: 0, addTime: settledAt,
          })));
          await tx.update(storePink).set({ status: 2, stopTime: endedAt }).where(inArray(storePink.id, liveMembers.map(member => member.id)));
          await tx.update(storePink).set({ memberCount: leader.people }).where(eq(storePink.id, leader.id));
          await enqueuePinkSuccessNotices(tx, leader.id, settledAt);
          return { completed: true as const, orderIds: [] };
        }
      }

      if (!alreadyFailed) {
        await tx
          .update(storePink)
          .set({ status: 3, stopTime: new Date(settledAt * 1000) })
          .where(or(eq(storePink.id, leaderId), eq(storePink.kId, leaderId)));
      }
      // A damaged member identity must never authorize success. Its actual
      // paid order can still prove membership through the persisted group FK;
      // retain it for failure compensation instead of stranding its money.
      const refundable = lockedOrders.filter(order => order.type === 3 && order.activityId === leader.combinationId
        && order.pinkId === leader.id && order.paid === 1 && order.uid > 0);
      return { completed: false as const, orderIds: [...new Set([...paidOrders.map(item => item.id), ...refundable.map(order => order.id)])].sort((a, b) => a - b) };
    });
    if (transition === null) {
      return { expired: false, orders: 0, completedRefunds: 0, pendingRefunds: 0 };
    }
    if (transition.completed) return { expired: false, completed: true, orders: 0, completedRefunds: 0, pendingRefunds: 0 };
    const orderIds = transition.orderIds;

    const refunds = new StoreOrderRefundService(this.container, this.env);
    let completedRefunds = 0;
    let pendingRefunds = 0;
    for (const orderId of orderIds) {
      let outcome: "completed" | "pending" | null = null;
      for (let attempt = 0; attempt < MAX_AUTOMATIC_REFUNDS_PER_ORDER; attempt += 1) {
        const order = await this.container.storeOrderDao.get(orderId);
        if (!order || !order.paid || order.refundStatus === 2) {
          outcome = order?.refundStatus === 2 ? "completed" : null;
          break;
        }
        const application = await ensureAutomaticOrderRefund(this.container, {
          uid: order.uid,
          orderId: order.orderId,
          refundReason: "拼团时间超时",
          refundExplain: "拼团未在有效时间内成团，系统自动原路退款",
          applyType: 1,
        });
        const result = await refunds.agreeRefund(application.refundId);
        if (!result.completed) {
          outcome = "pending";
          break;
        }
      }
      if (outcome === null) {
        const order = await this.container.storeOrderDao.get(orderId);
        if (order?.refundStatus === 2) outcome = "completed";
      }
      if (outcome === "completed") completedRefunds += 1;
      else if (outcome === "pending") pendingRefunds += 1;
      else {
        throw new Error(`拼团订单 ${orderId} 未能在限定步骤内完成或提交退款`);
      }
    }
    return {
      expired: true,
      orders: orderIds.length,
      completedRefunds,
      pendingRefunds,
    };
  }
}
