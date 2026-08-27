import { and, eq, ne, or, sql } from "drizzle-orm";
import { storeCombination, storeOrder, storePink } from "@/models/schema";
import { withTx, type Container } from "@/lib/di";
import type { Env } from "@/env";
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
    now = Math.floor(Date.now() / 1000),
  ): Promise<{ expired: boolean; orders: number; completedRefunds: number; pendingRefunds: number }> {
    const orderIds = await withTx(this.container, async (tx) => {
      const rows = await tx
        .select()
        .from(storePink)
        .where(eq(storePink.id, leaderId))
        .limit(1)
        .for("update");
      const leader = rows[0];
      if (!leader || leader.kId !== 0) return null;
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
        && deadline.getTime() <= now * 1000;
      const legacyOrphan = paidOrders.length === 0;
      if (!alreadyFailed && !timedOut && !legacyOrphan) return null;

      if (!alreadyFailed) {
        await tx
          .update(storePink)
          .set({ status: 3, stopTime: new Date(now * 1000) })
          .where(or(eq(storePink.id, leaderId), eq(storePink.kId, leaderId)));
      }
      return paidOrders.map((item) => item.id);
    });
    if (orderIds === null) {
      return { expired: false, orders: 0, completedRefunds: 0, pendingRefunds: 0 };
    }

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
