import { and, eq, sql } from "drizzle-orm";
import type { Env } from "@/env";
import { withTx, type Container } from "@/lib/di";
import { user as userTable, userBill, userRecharge } from "@/models/schema";
import { decimalToCents } from "@/services/order/OrderBrokerageService";
import { assertWechatPaymentProfileAvailable } from "@/services/payment/PaymentReadinessService";
import { resolveWechatPaymentIdentity } from "@/services/payment/WechatPaymentIdentity";
import { registerPaymentReconciliationIntent } from "@/services/payment/PaymentReconciliationRegistry";
import { WechatPayService } from "@/services/wechat/WechatPayService";
import { NotFoundException, ValidateException } from "@/utils/errors";

export type RechargePaymentOutcome = "paid" | "already-paid" | "missing";

export interface ApplyRechargePaymentInput {
  orderId: string;
  payType: "weixin" | "alipay";
  tradeNo: string;
  expectedAmountCents: number;
  uid?: number;
  now?: number;
}

export interface ApplyRechargePaymentResult {
  outcome: RechargePaymentOutcome;
  balance: string | null;
}

function assertRechargeOrderId(orderId: string): void {
  if (!/^cz[A-Za-z0-9_-]{1,30}$/.test(orderId)) {
    throw new ValidateException("充值订单号格式错误");
  }
}

export async function findRechargeOrderByOrderId(container: Container, orderId: string) {
  if (!orderId) return null;
  const rows = await container.db
    .select()
    .from(userRecharge)
    .where(eq(userRecharge.orderId, orderId))
    .limit(2);
  if (rows.length > 1) throw new ValidateException("充值订单号存在重复，请联系管理员处理");
  return rows[0] ?? null;
}

/** Settle one provider-verified recharge exactly once. */
export async function applyRechargePayment(
  container: Container,
  params: ApplyRechargePaymentInput,
): Promise<ApplyRechargePaymentResult> {
  const orderId = params.orderId.trim();
  assertRechargeOrderId(orderId);
  if (!params.tradeNo || params.tradeNo.length > 100) {
    throw new ValidateException("支付交易号格式错误");
  }
  if (!Number.isSafeInteger(params.expectedAmountCents) || params.expectedAmountCents <= 0) {
    throw new ValidateException("回调金额格式错误");
  }
  const now = params.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("充值支付时间无效");

  return withTx(container, async (tx) => {
    const orders = await tx
      .select()
      .from(userRecharge)
      .where(eq(userRecharge.orderId, orderId))
      .limit(2)
      .for("update");
    if (!orders.length) return { outcome: "missing", balance: null };
    if (orders.length !== 1) throw new ValidateException("充值订单号存在重复，请联系管理员处理");
    const order = orders[0];
    if (params.uid !== undefined && order.uid !== params.uid) {
      throw new ValidateException("订单不属于当前用户");
    }

    const priceCents = decimalToCents(order.price);
    const giveCents = decimalToCents(order.givePrice);
    if (priceCents !== params.expectedAmountCents) {
      throw new ValidateException("充值支付回调金额不匹配");
    }
    if (priceCents <= 0 || giveCents < 0) throw new ValidateException("充值订单金额无效");
    if (order.paid === 1) {
      if (order.rechargeType !== params.payType || order.tradeNo !== params.tradeNo) {
        throw new ValidateException("支付回调与已入账交易不匹配");
      }
      return { outcome: "already-paid", balance: null };
    }

    const totalCents = priceCents + giveCents;
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
      throw new ValidateException("充值入账金额无效");
    }
    const total = (totalCents / 100).toFixed(2);
    const updatedUsers = await tx
      .update(userTable)
      .set({ nowMoney: sql`now_money + ${total}` })
      .where(and(eq(userTable.uid, order.uid), eq(userTable.isDel, 0)))
      .returning({ nowMoney: userTable.nowMoney });
    if (!updatedUsers.length) throw new NotFoundException("用户不存在");
    const balance = String(updatedUsers[0].nowMoney);

    const paidRows = await tx
      .update(userRecharge)
      .set({
        paid: 1,
        payTime: now,
        rechargeType: params.payType,
        tradeNo: params.tradeNo,
      })
      .where(and(eq(userRecharge.id, order.id), eq(userRecharge.paid, 0)))
      .returning({ id: userRecharge.id });
    if (!paidRows.length) throw new Error("充值订单支付状态更新失败");

    await tx.insert(userBill).values({
      uid: order.uid,
      linkId: order.orderId,
      pm: 1,
      title: "充值到账",
      category: "now_money",
      type: "recharge",
      eventKey: "recharge_external_payment",
      number: total,
      balance,
      mark: giveCents > 0
        ? `充值 ¥${(priceCents / 100).toFixed(2)} 赠送 ¥${(giveCents / 100).toFixed(2)}`
        : `充值 ¥${(priceCents / 100).toFixed(2)}`,
      status: 1,
      addTime: now,
    });

    return { outcome: "paid", balance };
  });
}

export class RechargePaymentService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async startWechatPayment(
    uid: number,
    orderId: string,
    from: unknown,
    payerClientIp?: string,
  ): Promise<Record<string, unknown>> {
    assertRechargeOrderId(orderId);
    const order = await findRechargeOrderByOrderId(this.container, orderId);
    if (!order || order.uid !== uid) throw new NotFoundException("充值订单不存在");
    if (order.paid === 1) throw new ValidateException("充值订单已支付");
    const priceCents = decimalToCents(order.price);
    if (priceCents <= 0) throw new ValidateException("充值订单金额无效");

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
      orderDomain: "recharge",
      orderNo: order.orderId,
      expectedAmountCents: priceCents,
      initiated: true,
    });
    const jsConfig = await new WechatPayService(this.container, this.env).createOrder({
      profile: identity.profile,
      type: identity.type,
      outTradeNo: order.orderId,
      description: "CinaShop 用户充值",
      amount: priceCents / 100,
      ...(identity.openid ? { openid: identity.openid } : {}),
      ...(identity.payerClientIp ? { payerClientIp: identity.payerClientIp } : {}),
      attach: "user_recharge",
    });
    return {
      order_id: order.orderId,
      paid: false,
      pay_type: "weixin",
      pay_mode: identity.type,
      jsConfig,
    };
  }

  async settleExternalPayment(
    orderId: string,
    payType: "weixin" | "alipay",
    tradeNo: string,
    amountCents: number,
  ): Promise<boolean> {
    const result = await applyRechargePayment(this.container, {
      orderId,
      payType,
      tradeNo,
      expectedAmountCents: amountCents,
    });
    return result.outcome === "paid" || result.outcome === "already-paid";
  }
}
