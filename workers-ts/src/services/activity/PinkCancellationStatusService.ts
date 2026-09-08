import { and, eq, sql } from "drizzle-orm";
import { withTx, type Container } from "@/lib/di";
import { storeOrder, storeOrderRefund, storeOrderRefundPayment, storePink, user } from "@/models/schema";
import { amountToCents } from "@/services/payment/RefundGateway";
import { AuthException, NotFoundException, ValidateException } from "@/utils/errors";

export type PinkCancellationState = "not_applied" | "accepted" | "processing" | "unknown" | "completed" | "needs_attention";

function id(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2_147_483_647) {
    throw new ValidateException("拼团取消查询参数无效");
  }
  return Number(value);
}

/** A persisted receipt, not a provider query or permission to cancel.
 * Read the ORIGINAL leader identity even after refund/promotion/expiry. Product
 * visibility must not hide an owner's cancellation result. No Env is accepted:
 * GET cannot apply, retry, reconcile, finalize or contact a refund provider.
 */
export class PinkCancellationStatusService {
  constructor(private readonly container: Container) {}

  async read(uid: number, rawPinkId: unknown, rawCombinationId: unknown) {
    if (!Number.isSafeInteger(uid) || uid <= 0 || uid > 2_147_483_647) throw new AuthException();
    const pinkId = id(rawPinkId), combinationId = id(rawCombinationId);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      const [account] = await tx.select({ uid: user.uid }).from(user)
        .where(and(eq(user.uid, uid), eq(user.status, 1), eq(user.isDel, 0))).limit(1);
      if (!account) throw new AuthException("请重新登录");
      const [pink] = await tx.select({ id: storePink.id, orderIdKey: storePink.orderIdKey,
        orderId: storePink.orderId, isRefund: storePink.isRefund }).from(storePink)
        .where(and(eq(storePink.id, pinkId), eq(storePink.uid, uid), eq(storePink.kId, 0),
          eq(storePink.combinationId, combinationId))).limit(1);
      if (!pink) throw new NotFoundException("未查到本人的拼团取消记录");
      // Never reinterpret a member, activity ID or refund replacement as the
      // original cancellation. Validate the legacy varchar BEFORE conversion.
      const orderKey = id(pink.orderIdKey);
      const [order] = await tx.select({ id: storeOrder.id, orderId: storeOrder.orderId, pid: storeOrder.pid,
        payType: storeOrder.payType, payPrice: storeOrder.payPrice, totalNum: storeOrder.totalNum,
        status: storeOrder.status, refundStatus: storeOrder.refundStatus, refundPrice: storeOrder.refundPrice })
        .from(storeOrder).where(and(eq(storeOrder.id, orderKey), eq(storeOrder.orderId, pink.orderId),
          eq(storeOrder.uid, uid), eq(storeOrder.type, 3), eq(storeOrder.activityId, combinationId),
          eq(storeOrder.pinkId, pinkId), eq(storeOrder.paid, 1), eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0))).limit(1);
      if (!order) throw new NotFoundException("未查到本人的拼团取消记录");
      const result = (state: PinkCancellationState) => ({ uid, pink_id: pinkId, combination_id: combinationId,
        current_pink_order: order.orderId, state, completed: state === "completed",
        // A resume is an explicit POST to the SAME identity; never an automatic
        // side effect of GET. The write core still revalidates all mutable state.
        resumable: state === "accepted" || state === "processing" || state === "unknown" });
      const receipts = await tx.select().from(storeOrderRefund).where(and(
        eq(storeOrderRefund.storeOrderId, order.id), eq(storeOrderRefund.orderId, `pink_cancel_${pinkId}_${order.id}`),
      )).limit(2);
      // Absence only describes this snapshot. It cannot prove an in-flight or
      // timed-out POST failed; clients must retain their original intent.
      if (!receipts.length) return result("not_applied");
      if (receipts.length !== 1) return result("needs_attention");
      const receipt = receipts[0], cents = amountToCents(order.payPrice);
      if (cents === null || cents <= 0 || order.totalNum <= 0 || receipt.uid !== uid || receipt.applyType !== 1 ||
          receipt.refundNum !== order.totalNum || receipt.refundReason !== "用户手动取消拼团" ||
          receipt.refundExplain !== "用户手动取消未成团的拼团订单" || amountToCents(receipt.refundPrice) !== cents ||
          receipt.isCancel !== 0 || receipt.isDel !== 0 || ![0, 1, 2, 4, 5, 6].includes(receipt.refundType)) {
        return result("needs_attention");
      }
      const payments = await tx.select().from(storeOrderRefundPayment)
        .where(eq(storeOrderRefundPayment.refundId, receipt.id)).limit(2);
      if (payments.length > 1) return result("needs_attention");
      const payment = payments[0];
      if (payment) {
        const provider = order.payType === "weixin" ? "wechat" : order.payType === "alipay" ? "alipay" : null;
        const [root] = order.pid > 0 ? await tx.select({ uid: storeOrder.uid, paid: storeOrder.paid,
          payType: storeOrder.payType, payPrice: storeOrder.payPrice, isDel: storeOrder.isDel, isSystemDel: storeOrder.isSystemDel })
          .from(storeOrder).where(eq(storeOrder.id, order.pid)).limit(1) : [{ uid, paid: 1, payType: order.payType,
            payPrice: order.payPrice, isDel: 0, isSystemDel: 0 }];
        if (!provider || !root || root.uid !== uid || root.paid !== 1 || root.isDel !== 0 || root.isSystemDel !== 0 ||
            root.payType !== order.payType || payment.provider !== provider || payment.storeOrderId !== order.id ||
            payment.outRefundNo !== `CNSR${receipt.id}` || payment.requestAmount !== cents ||
            payment.totalAmount !== amountToCents(root.payPrice) || payment.totalAmount < cents) return result("needs_attention");
      }
      if (receipt.refundType === 6) {
        const complete = order.refundStatus === 2 && pink.isRefund === pinkId &&
          amountToCents(receipt.refundedPrice) === cents && amountToCents(order.refundPrice) === cents &&
          (order.payType === "yue" && !payment || payment?.providerStatus === "SUCCESS");
        return result(complete ? "completed" : "needs_attention");
      }
      if (order.status !== 0 || order.refundStatus !== 0 || pink.isRefund !== 0 ||
          amountToCents(receipt.refundedPrice) !== 0) return result("needs_attention");
      if (!payment) return result(["yue", "weixin", "alipay"].includes(order.payType) ? "accepted" : "needs_attention");
      switch (payment.providerStatus) {
        case "CREATED": return result("accepted");
        case "REQUESTING": case "PROCESSING": case "SUCCESS": return result("processing");
        case "UNKNOWN": return result("unknown");
        default: return result("needs_attention");
      }
    });
  }
}
