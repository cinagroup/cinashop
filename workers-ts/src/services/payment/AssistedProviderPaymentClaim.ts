import { and, eq, gt, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { withTx, type Container, type DbClient } from "@/lib/di";
import { paymentReconciliationCase, storeOrder } from "@/models/schema";
import { decimalToCents } from "@/services/order/OrderBrokerageService";
import { registerPaymentReconciliationTx } from "@/services/payment/PaymentReconciliationRegistry";
import { lockStoreOrderPaymentBoundary } from "@/services/payment/StoreOrderPaymentBoundary";
import { NotFoundException, ValidateException } from "@/utils/errors";

type AssistedProvider = "wechat" | "alipay";
type AssistedProfile = "wechat" | "routine" | "app" | "alipay";

const INITIATED_MESSAGE = "扫码支付已发起，请查询支付状态；结果未知时请先人工对账";

export class AssistedProviderPaymentPending extends ValidateException {
  constructor() { super("扫码支付已发起，请先人工对账后处理取消"); }
}

/** An intent or verified callback freezes assisted repricing until reconciliation. */
export async function hasInitiatedAssistedProviderPayment(tx: DbClient, orderNo: string): Promise<boolean> {
  // The caller already holds this store_order row. A callback or another
  // provider's claim must commit before this READ COMMITTED evidence query.
  await lockStoreOrderPaymentBoundary(tx, orderNo);
  const rows = await tx.select({ id: paymentReconciliationCase.id }).from(paymentReconciliationCase)
    .where(and(inArray(paymentReconciliationCase.provider, ["wechat", "alipay"]),
      eq(paymentReconciliationCase.orderNo, orderNo), or(
      gt(paymentReconciliationCase.initiatedTime, 0),
      isNotNull(paymentReconciliationCase.callbackEventId),
      ne(paymentReconciliationCase.providerTransactionId, ""),
    )))
    .limit(1);
  return rows.length > 0;
}

/**
 * Claim one provider initiation in a short transaction, then release every SQL
 * lock before the caller contacts the provider. A committed claim is deliberately
 * not retried on timeout/crash: reconciliation queries the original order number.
 * Even NO_PAYMENT needs an explicit, separately audited manual reissue protocol.
 */
export async function claimAssistedProviderPayment(container: Container, input: {
  adminId: number;
  uid: number;
  orderId: number;
  orderNo: string;
  provider: AssistedProvider;
  profile: AssistedProfile;
  expectedPayCents: number;
}): Promise<void> {
  if (!Number.isSafeInteger(input.adminId) || input.adminId <= 0
    || (input.provider === "alipay" && input.profile !== "alipay")
    || (input.provider === "wechat" && !["wechat", "routine", "app"].includes(input.profile))) {
    throw new ValidateException("代客支付渠道或归属无效");
  }
  if (!Number.isSafeInteger(input.expectedPayCents) || input.expectedPayCents <= 0
    || input.expectedPayCents > 2_147_483_647) {
    throw new ValidateException("订单金额超出扫码支付范围");
  }
  await withTx(container, async (tx) => {
    await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
    await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
    const [order] = await tx.select().from(storeOrder).where(eq(storeOrder.id, input.orderId))
      .limit(1).for("update");
    if (!order || order.orderId !== input.orderNo) throw new NotFoundException("订单不存在");
    if (order.uid !== input.uid || order.staffId !== input.adminId || order.isChannel !== 2
      || order.isDel !== 0 || order.isSystemDel !== 0) {
      throw new ValidateException("订单不属于当前代客会话");
    }
    if (decimalToCents(order.payPrice) !== input.expectedPayCents) {
      throw new ValidateException("订单应付金额已变化，请刷新后重新确认支付");
    }
    if (order.paid !== 0 || order.status !== 0) throw new ValidateException("订单状态不允许支付");
    await lockStoreOrderPaymentBoundary(tx, input.orderNo);
    // All payment evidence now shares this order boundary. The provider lock
    // still serializes same-channel reconciliation after the order is checked.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(
      hashtextextended(${`payment-reconciliation:${input.provider}:${input.orderNo}`}, 0)
    )`);
    const [prior] = await tx.select().from(paymentReconciliationCase).where(and(
      eq(paymentReconciliationCase.provider, input.provider),
      eq(paymentReconciliationCase.orderNo, input.orderNo),
    )).limit(1).for("update");
    if (prior && (prior.initiatedTime > 0 || prior.status !== "OPEN" || prior.providerStatus !== "UNKNOWN"
      || prior.callbackEventId !== null || prior.providerTransactionId !== ""
      || prior.expectedAmountCents !== input.expectedPayCents
      || (prior.orderDomain !== "" && prior.orderDomain !== "store_order")
      || prior.profile !== input.profile)) {
      throw new ValidateException(INITIATED_MESSAGE);
    }
    const intent = await registerPaymentReconciliationTx(tx, {
      provider: input.provider,
      profile: input.profile,
      orderDomain: "store_order",
      orderNo: input.orderNo,
      expectedAmountCents: input.expectedPayCents,
      initiated: true,
    });
    if (intent.status !== "OPEN" || intent.expectedAmountCents !== input.expectedPayCents) {
      throw new ValidateException(INITIATED_MESSAGE);
    }
    const [other] = await tx.select({ id: paymentReconciliationCase.id })
      .from(paymentReconciliationCase).where(and(
        eq(paymentReconciliationCase.orderNo, input.orderNo),
        eq(paymentReconciliationCase.provider, input.provider === "wechat" ? "alipay" : "wechat"),
        or(gt(paymentReconciliationCase.initiatedTime, 0),
          isNotNull(paymentReconciliationCase.callbackEventId),
          ne(paymentReconciliationCase.providerTransactionId, "")),
      )).limit(1);
    if (other) throw new ValidateException(INITIATED_MESSAGE);
  });
}
