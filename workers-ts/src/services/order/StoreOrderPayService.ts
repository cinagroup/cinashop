/**
 * 订单支付 Service (M4)
 *
 * 对应 PHP app/services/pay/YuePayServices.php + StoreOrderSuccessServices.php
 *
 * 策略:
 *   - 余额支付 (yue): Workers 直接实现 (扣 user.now_money → paySuccess)
 *   - 微信/支付宝: 回调必须验签，并以 paid=0 条件更新保证并发幂等
 *   - 支付宝未完整配置密钥和回调地址时拒绝创建支付，禁止返回伪支付 URL
 *
 * 关键: paySuccess 是唯一的支付状态写入口；paid=0→1 与 order.paid outbox 同事务提交。
 */
import { eq, and, sql } from "drizzle-orm";
import {
  user as userTable,
  storeOrder,
  userBill as userBillTable,
  storeOrderInvoice,
  storeOrderCartInfo,
  storeProductAttrValue,
  storeSeckill,
  storeBargain,
  storeCombination,
  storeOrderStatus,
} from "@/models/schema";
import { withTx, type Container, type DbClient } from "@/lib/di";
import type { Env } from "@/env";
import { ValidateException, NotFoundException } from "@/utils/errors";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";
import { signAlipayParams, type AlipayParams } from "@/utils/alipay";
import {
  enqueueOrderPaidEvent,
  OrderOutboxService,
} from "@/services/order/OrderOutboxService";
import {
  activatePaidPink,
  assertPinkOrderPayable,
} from "@/services/activity/PinkLifecycleService";
import { decimalToCents } from "@/services/order/OrderBrokerageService";
import { WechatPayService } from "@/services/wechat/WechatPayService";
import {
  assertWechatPaymentProfileAvailable,
  getPaymentReadiness,
} from "@/services/payment/PaymentReadinessService";
import { resolveWechatPaymentIdentity } from "@/services/payment/WechatPaymentIdentity";
import { registerPaymentReconciliationIntent } from "@/services/payment/PaymentReconciliationRegistry";
import {
  assertMarketingOfflinePaymentAllowed,
  getOrderInvalidTime,
} from "@/services/payment/OrderPaymentPolicy";

/** 支付方式常量 (对应 PHP PayServices) */
export const PayType = {
  WEIXIN: "weixin",
  YUE: "yue",
  OFFLINE: "offline",
  ALIPAY: "alipay",
  INTEGRAL: "integral",
} as const;

export interface ApplyStoreOrderPaymentInput {
  orderId: number;
  payType: string;
  tradeNo?: string;
  now?: number;
  /** Privileged callers can bind authorization to the locked order row. */
  authorizeBeforePayment?: (
    tx: DbClient,
    order: typeof storeOrder.$inferSelect,
  ) => Promise<void>;
  /** Narrow replay policy for trusted non-provider payment transitions. */
  allowAlreadyPaid?: (order: typeof storeOrder.$inferSelect) => boolean;
  /** Optional immutable actor audit committed with the paid transition. */
  audit?: {
    changeType: string;
    changeMessage: string;
  };
}

export type StoreOrderPaymentOutcome =
  | "paid"
  | "already-paid"
  | "not-payable"
  | "missing";

export interface ApplyStoreOrderPaymentResult {
  outcome: StoreOrderPaymentOutcome;
  outbox: { id: number; eventKey: string } | null;
}

export interface ApplyStoreOrderBalancePaymentInput {
  uid: number;
  orderId: string;
  now?: number;
}

async function debitRequiredOrderIntegral(
  tx: DbClient,
  order: typeof storeOrder.$inferSelect,
  now: number,
): Promise<void> {
  if (order.payIntegral <= 0) return;
  const updated = await tx
    .update(userTable)
    .set({ integral: sql`integral - ${order.payIntegral}` })
    .where(
      and(
        eq(userTable.uid, order.uid),
        eq(userTable.isDel, 0),
        sql`integral >= ${order.payIntegral}`,
      ),
    )
    .returning({ integral: userTable.integral });
  if (!updated[0]) throw new ValidateException(`积分不足, 需要 ${order.payIntegral} 积分`);
  await tx.insert(userBillTable).values({
    uid: order.uid,
    linkId: String(order.id),
    pm: 0,
    title: "积分兑换",
    category: "integral",
    type: "storeIntegral_use_integral",
    eventKey: "order_pay_integral",
    number: String(order.payIntegral),
    balance: String(updated[0].integral),
    mark: `支付积分订单 ${order.orderId}`,
    status: 1,
    addTime: now,
  });
}

/**
 * Marketing orders created by the current Worker always carry an immutable
 * activitySku id.  Pre-fix rows without that evidence cannot be paid safely:
 * a later cancellation/refund could not prove which activity inventory layer
 * to restore.  Keep the final callback transaction guarded as well as every
 * payment-initiation path so an old or bypassed client cannot evade the check.
 */
export async function assertActivityOrderPaymentEvidence(
  db: DbClient,
  order: typeof storeOrder.$inferSelect,
): Promise<void> {
  if (![1, 2, 3].includes(order.type)) return;
  const cartRows = await db
    .select({ cartInfo: storeOrderCartInfo.cartInfo })
    .from(storeOrderCartInfo)
    .where(eq(storeOrderCartInfo.oid, order.id));
  if (!cartRows.length) {
    throw new ValidateException("历史活动订单商品快照缺失，请取消后重新下单");
  }
  for (const cart of cartRows) {
    let activitySkuId = 0;
    try {
      const snapshot = JSON.parse(cart.cartInfo ?? "{}") as {
        activitySku?: { id?: unknown } | null;
      };
      const parsedId = Number(snapshot.activitySku?.id ?? 0);
      if (Number.isSafeInteger(parsedId) && parsedId > 0) activitySkuId = parsedId;
    } catch {
      activitySkuId = 0;
    }
    if (!activitySkuId) {
      throw new ValidateException("历史活动订单数据不完整，请取消后重新下单");
    }
    const activitySkuRows = await db
      .select({ id: storeProductAttrValue.id })
      .from(storeProductAttrValue)
      .where(and(
        eq(storeProductAttrValue.id, activitySkuId),
        eq(storeProductAttrValue.productId, order.activityId),
        eq(storeProductAttrValue.type, order.type),
      ))
      .limit(1);
    if (!activitySkuRows[0]) {
      throw new ValidateException("活动商品规格已失效，请取消后重新下单");
    }
  }

  const activityRows = order.type === 1
    ? await db.select({ id: storeSeckill.id }).from(storeSeckill)
        .where(eq(storeSeckill.id, order.activityId)).limit(1)
    : order.type === 2
      ? await db.select({ id: storeBargain.id }).from(storeBargain)
          .where(eq(storeBargain.id, order.activityId)).limit(1)
      : await db.select({ id: storeCombination.id }).from(storeCombination)
          .where(eq(storeCombination.id, order.activityId)).limit(1);
  if (!activityRows[0]) {
    throw new ValidateException("活动已失效，请取消后重新下单");
  }
}

/**
 * Atomically transition an unpaid order to paid and persist its outbox event.
 * Queue delivery is intentionally left to the service after this transaction.
 */
export async function applyStoreOrderPayment(
  container: Container,
  params: ApplyStoreOrderPaymentInput,
): Promise<ApplyStoreOrderPaymentResult> {
  if (!Number.isSafeInteger(params.orderId) || params.orderId <= 0) {
    throw new Error("订单 ID 无效");
  }
  const now = params.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("支付时间无效");
  if (params.audit && (
    !params.audit.changeType.trim() || params.audit.changeType.length > 32 ||
    !params.audit.changeMessage.trim() || params.audit.changeMessage.length > 256
  )) {
    throw new ValidateException("支付审计信息无效");
  }

  return withTx(container, async (tx) => {
    const orderRows = await tx
      .select()
      .from(storeOrder)
      .where(eq(storeOrder.id, params.orderId))
      .limit(1)
      .for("update");
    const order = orderRows[0];
    if (!order) return { outcome: "missing", outbox: null };
    await params.authorizeBeforePayment?.(tx, order);
    if (order.paid === 1) {
      if (params.allowAlreadyPaid?.(order)) {
        return { outcome: "already-paid", outbox: null };
      }
      const sameProviderEvidence = order.payType === params.payType
        && order.tradeNo === (params.tradeNo ?? "");
      if (!sameProviderEvidence) {
        throw new ValidateException("支付回调与已入账交易不匹配");
      }
      return { outcome: "already-paid", outbox: null };
    }
    if (order.status !== 0 || order.isDel !== 0) {
      return { outcome: "not-payable", outbox: null };
    }

    await assertActivityOrderPaymentEvidence(tx, order);

    await debitRequiredOrderIntegral(tx, order, now);

    const paidRows = await tx
      .update(storeOrder)
      .set({
        paid: 1,
        payType: params.payType,
        payTime: now,
        ...(params.tradeNo ? { tradeNo: params.tradeNo } : {}),
      })
      .where(
        and(
          eq(storeOrder.id, order.id),
          eq(storeOrder.paid, 0),
          eq(storeOrder.status, 0),
          eq(storeOrder.isDel, 0),
        ),
      )
      .returning();
    const paidOrder = paidRows[0];
    if (!paidOrder) return { outcome: "not-payable", outbox: null };

    await activatePaidPink(tx, paidOrder, now);
    await tx
      .update(storeOrderInvoice)
      .set({ isPay: 1 })
      .where(and(eq(storeOrderInvoice.orderId, order.id), eq(storeOrderInvoice.isDel, 0)));
    const outbox = await enqueueOrderPaidEvent(tx, paidOrder, now);
    if (params.audit) {
      await tx.insert(storeOrderStatus).values({
        oid: paidOrder.id,
        changeType: params.audit.changeType,
        changeMessage: params.audit.changeMessage,
        changeTime: now,
      });
    }
    return { outcome: "paid", outbox };
  });
}

/**
 * Lock the order before touching user funds, then atomically debit balance,
 * write the immutable ledger row, mark the order paid and persist its outbox.
 */
export async function applyStoreOrderBalancePayment(
  container: Container,
  params: ApplyStoreOrderBalancePaymentInput,
): Promise<ApplyStoreOrderPaymentResult> {
  if (!Number.isSafeInteger(params.uid) || params.uid <= 0) throw new Error("用户 ID 无效");
  if (!params.orderId.trim()) throw new Error("订单号无效");
  const now = params.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("支付时间无效");

  return withTx(container, async (tx) => {
    const orderRows = await tx
      .select()
      .from(storeOrder)
      .where(eq(storeOrder.orderId, params.orderId))
      .limit(1)
      .for("update");
    const order = orderRows[0];
    if (!order) return { outcome: "missing", outbox: null };
    if (order.uid !== params.uid) throw new ValidateException("订单不属于当前用户");
    if (order.paid === 1) return { outcome: "already-paid", outbox: null };
    if (order.status !== 0 || order.isDel !== 0) {
      return { outcome: "not-payable", outbox: null };
    }
    await assertActivityOrderPaymentEvidence(tx, order);
    await assertPinkOrderPayable(tx, order);
    await debitRequiredOrderIntegral(tx, order, now);

    const payCents = decimalToCents(order.payPrice);
    if (payCents < 0) throw new Error(`订单 ${order.orderId} 的支付金额无效`);
    const payAmount = (payCents / 100).toFixed(2);
    if (payCents > 0) {
      const updated = await tx
        .update(userTable)
        .set({ nowMoney: sql`now_money - ${payAmount}` })
        .where(and(
          eq(userTable.uid, params.uid),
          eq(userTable.isDel, 0),
          sql`now_money >= ${payAmount}`,
        ))
        .returning({ uid: userTable.uid, nowMoney: userTable.nowMoney });
      if (!updated.length) throw new ValidateException("余额不足");

      await tx.insert(userBillTable).values({
        uid: params.uid,
        linkId: order.orderId,
        pm: 0,
        title: "购买商品",
        category: "now_money",
        type: "pay_product",
        number: payAmount,
        balance: String(updated[0].nowMoney),
        mark: `余额支付订单 ${order.orderId}`,
        status: 1,
        addTime: now,
      });
    }

    const paidRows = await tx
      .update(storeOrder)
      .set({ paid: 1, payType: PayType.YUE, payTime: now })
      .where(and(
        eq(storeOrder.id, order.id),
        eq(storeOrder.paid, 0),
        eq(storeOrder.status, 0),
        eq(storeOrder.isDel, 0),
      ))
      .returning();
    const paidOrder = paidRows[0];
    if (!paidOrder) return { outcome: "not-payable", outbox: null };

    await activatePaidPink(tx, paidOrder, now);
    await tx
      .update(storeOrderInvoice)
      .set({ isPay: 1 })
      .where(and(eq(storeOrderInvoice.orderId, order.id), eq(storeOrderInvoice.isDel, 0)));
    const outbox = await enqueueOrderPaidEvent(tx, paidOrder, now);
    return { outcome: "paid", outbox };
  });
}

export class StoreOrderPayService {
  private readonly outbox: OrderOutboxService;

  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {
    this.outbox = new OrderOutboxService(container, env);
  }

  /**
   * 余额支付 (对应 PHP YuePayServices::yueOrderPay)
   *
   * 事务内:
   *   1. 检查余额 >= payPrice
   *   2. 扣 user.now_money (WHERE now_money >= payPrice 守卫)
   *   3. 记 user_bill 流水
   *   4. paySuccess (paid=1)
   */
  async yuePay(uid: number, orderId: string): Promise<{ paid: boolean }> {
    const result = await applyStoreOrderBalancePayment(this.container, { uid, orderId });
    if (result.outcome === "missing") throw new NotFoundException("订单不存在");
    if (result.outcome === "not-payable") throw new ValidateException("订单状态不允许支付");
    if (result.outcome === "paid") {
      if (!result.outbox) throw new Error("余额支付 outbox 未创建");
      await this.dispatchOutboxBestEffort(result.outbox.id);
    }

    return { paid: true };
  }

  /**
   * Server-authoritative payment dispatch for store orders. Zero-cash orders
   * settle without requiring an enabled funding rail; every positive payment
   * must pass the effective database + deployment readiness check.
   */
  async pay(
    uid: number,
    orderId: string,
    payType: string,
    from: unknown,
    payerClientIp?: string,
  ): Promise<Record<string, unknown>> {
    const normalizedPayType = payType.trim().toLowerCase();
    const supportedMethods: readonly string[] = [
      PayType.YUE,
      PayType.WEIXIN,
      PayType.ALIPAY,
      PayType.OFFLINE,
    ];
    if (!supportedMethods.includes(normalizedPayType)) {
      throw new ValidateException(`不支持的支付方式: ${normalizedPayType}`);
    }
    const order = await this.container.storeOrderDao.findByOrderId(orderId);
    if (!order || order.uid !== uid || order.isDel !== 0) throw new NotFoundException("订单不存在");
    if (order.paid === 1) return { order_id: orderId, paid: true, pay_type: order.payType };
    if (order.status !== 0) throw new ValidateException("订单状态不允许支付");
    await assertActivityOrderPaymentEvidence(this.container.db, order);
    await assertPinkOrderPayable(this.container.db, order);
    const invalidTime = await getOrderInvalidTime(
      this.container,
      this.env,
      order.type,
      order.addTime,
    );
    if (invalidTime > 0 && invalidTime <= Math.floor(Date.now() / 1000)) {
      throw new ValidateException("订单已超过支付时限");
    }
    if (normalizedPayType === PayType.OFFLINE) {
      assertMarketingOfflinePaymentAllowed(order.type, from);
    }

    if (decimalToCents(order.payPrice) === 0) {
      await this.yuePay(uid, orderId);
      return { order_id: orderId, paid: true, pay_type: PayType.YUE };
    }

    if (normalizedPayType !== PayType.WEIXIN) {
      const readiness = await getPaymentReadiness(this.container, this.env);
      const method = readiness[normalizedPayType as keyof typeof readiness];
      if (!method?.enabled) throw new ValidateException(method?.reason || "支付方式不可用");
    }

    if (normalizedPayType === PayType.YUE) {
      await this.yuePay(uid, orderId);
      return { order_id: orderId, paid: true, pay_type: PayType.YUE };
    }
    if (normalizedPayType === PayType.WEIXIN) {
      return this.wechatPay(uid, orderId, from, payerClientIp);
    }
    if (normalizedPayType === PayType.ALIPAY) {
      return {
        order_id: orderId,
        paid: false,
        pay_type: PayType.ALIPAY,
        payUrl: await this.alipayPay(uid, orderId),
      };
    }
    return this.offlinePay(uid, orderId, from);
  }

  async wechatPay(
    uid: number,
    orderId: string,
    from: unknown,
    payerClientIp?: string,
  ): Promise<Record<string, unknown>> {
    const order = await this.container.storeOrderDao.findByOrderId(orderId);
    if (!order || order.uid !== uid || order.isDel !== 0) throw new NotFoundException("订单不存在");
    if (order.paid === 1) throw new ValidateException("订单已支付");
    if (order.status !== 0) throw new ValidateException("订单状态不允许支付");
    await assertActivityOrderPaymentEvidence(this.container.db, order);
    await assertPinkOrderPayable(this.container.db, order);
    const identity = await resolveWechatPaymentIdentity(
      this.container,
      uid,
      from,
      payerClientIp,
    );
    await assertWechatPaymentProfileAvailable(this.container, this.env, identity.profile);
    await registerPaymentReconciliationIntent(this.container, {
      provider: "wechat",
      profile: identity.profile,
      orderDomain: "store_order",
      orderNo: order.orderId,
      expectedAmountCents: decimalToCents(order.payPrice),
      initiated: true,
    });
    const jsConfig = await new WechatPayService(this.container, this.env).createOrder({
      profile: identity.profile,
      type: identity.type,
      outTradeNo: order.orderId,
      description: order.mark || `CinaShop 订单 ${order.orderId}`,
      amount: Number(order.payPrice),
      ...(identity.openid ? { openid: identity.openid } : {}),
      ...(identity.payerClientIp ? { payerClientIp: identity.payerClientIp } : {}),
      attach: "product",
    });
    return {
      order_id: order.orderId,
      paid: false,
      pay_type: PayType.WEIXIN,
      pay_mode: identity.type,
      jsConfig,
    };
  }

  async offlinePay(
    uid: number,
    orderId: string,
    from: unknown = "h5",
  ): Promise<Record<string, unknown>> {
    return withTx(this.container, async (tx) => {
      const rows = await tx
        .select()
        .from(storeOrder)
        .where(eq(storeOrder.orderId, orderId))
        .limit(1)
        .for("update");
      const order = rows[0];
      if (!order || order.uid !== uid || order.isDel !== 0) throw new NotFoundException("订单不存在");
      if (order.paid === 1) return { order_id: orderId, paid: true, pay_type: order.payType };
      if (order.status !== 0) throw new ValidateException("订单状态不允许支付");
      assertMarketingOfflinePaymentAllowed(order.type, from);
      await assertActivityOrderPaymentEvidence(tx, order);
      await assertPinkOrderPayable(tx, order);
      await tx
        .update(storeOrder)
        .set({ payType: PayType.OFFLINE })
        .where(and(eq(storeOrder.id, order.id), eq(storeOrder.paid, 0)));
      return {
        order_id: orderId,
        paid: false,
        pay_type: PayType.OFFLINE,
        offline: true,
      };
    });
  }

  /**
   * 支付成功标记 (对应 PHP StoreOrderSuccessServices::paySuccess)
   *
   * 幂等: paid=0 条件更新确保并发回调只有一个调用者执行支付后置逻辑。
   */
  async paySuccess(
    orderId: number,
    payType: string,
    tradeNo?: string,
    options?: Pick<ApplyStoreOrderPaymentInput, "authorizeBeforePayment" | "audit">,
  ): Promise<boolean> {
    const paymentResult = await this.applyPayment({
      orderId,
      payType,
      tradeNo,
      ...options,
    });
    if (paymentResult.outcome === "not-payable") return false;
    // Missing callbacks are acknowledged to stop provider retries, matching PHP.
    return true;
  }

  /** Execute the paid transition and expose the exact outcome to trusted callers. */
  async applyPayment(params: ApplyStoreOrderPaymentInput): Promise<ApplyStoreOrderPaymentResult> {
    const paymentResult = await applyStoreOrderPayment(this.container, params);
    if (paymentResult.outcome === "paid") {
      if (!paymentResult.outbox) throw new Error("支付 outbox 未创建");
      await this.dispatchOutboxBestEffort(paymentResult.outbox.id);
    }
    return paymentResult;
  }

  private async dispatchOutboxBestEffort(outboxId: number): Promise<void> {
    try {
      await this.outbox.dispatchById(outboxId);
    } catch (error) {
      emitOperationalEvent("error", {
        event: "payment_outbox_dispatch_failed",
        component: "payment",
        operation: "outbox_dispatch",
        outcome: "failure",
        errorCode: operationalErrorCode(error),
      });
    }
  }

  // ═══ M23: 支付宝 + 通用回调 ═════════════════════════════════

  /**
   * 支付宝 H5 支付 (M23)
   *
   * 生成经过 RSA2 签名的支付宝 H5 网关 URL。
   * 配置不完整时直接拒绝，避免把占位链接误当作可用支付。
   */
  async alipayPay(uid: number, orderId: string): Promise<string> {
    const c = this.container;
    const order = await c.storeOrderDao.findByOrderId(orderId);
    if (!order) throw new NotFoundException("订单不存在");
    if (order.uid !== uid) throw new ValidateException("订单不属于当前用户");
    if (order.paid) throw new ValidateException("订单已支付");
    if (order.status !== 0 || order.isDel) throw new ValidateException("订单状态不允许支付");
    await assertActivityOrderPaymentEvidence(c.db, order);
    await assertPinkOrderPayable(c.db, order);

    const appId = this.env.ALIPAY_APP_ID;
    const privateKey = this.env.ALIPAY_PRIVATE_KEY;
    const notifyUrl = this.env.ALIPAY_NOTIFY_URL;
    const returnUrl = this.env.ALIPAY_RETURN_URL;
    if (!appId || !privateKey || !notifyUrl || !returnUrl) {
      throw new ValidateException("支付宝支付尚未完成商户配置");
    }

    await registerPaymentReconciliationIntent(this.container, {
      provider: "alipay",
      profile: "alipay",
      orderDomain: "store_order",
      orderNo: order.orderId,
      expectedAmountCents: decimalToCents(order.payPrice),
      initiated: true,
    });

    const gateway = "https://openapi.alipay.com/gateway.do";
    const params: AlipayParams = {
      app_id: appId,
      method: "alipay.trade.wap.pay",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: formatAlipayTimestamp(new Date()),
      version: "1.0",
      notify_url: notifyUrl,
      return_url: returnUrl,
      biz_content: JSON.stringify({
        out_trade_no: orderId,
        total_amount: Number(order.payPrice).toFixed(2),
        subject: `CinaShop 订单 ${orderId}`,
        product_code: "QUICK_WAP_WAY",
      }),
    };
    params.sign = await signAlipayParams(params, privateKey);
    return `${gateway}?${new URLSearchParams(params).toString()}`;
  }

  /**
   * 按订单号标记支付成功，供已完成验签和金额校验的支付回调调用。
   */
  async paySuccessByOrderId(orderId: string, payType: string, tradeNo?: string): Promise<boolean> {
    const c = this.container;
    const order = await c.storeOrderDao.findByOrderId(orderId);
    if (!order) return false;
    return this.paySuccess(order.id, payType, tradeNo);
  }
}

function formatAlipayTimestamp(date: Date): string {
  const chinaTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return chinaTime.toISOString().slice(0, 19).replace("T", " ");
}
