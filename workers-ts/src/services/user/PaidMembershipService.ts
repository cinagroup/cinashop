import { and, desc, eq, sql } from "drizzle-orm";
import type { Env } from "@/env";
import { withTx, type Container } from "@/lib/di";
import {
  agreement,
  memberCard,
  memberCardBatch,
  memberRight,
  memberShip,
  otherOrder,
  otherOrderStatus,
  storeCouponIssue,
  storeOrderEconomize,
  user as userTable,
  userBill as userBillTable,
} from "@/models/schema";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { decimalToCents } from "@/services/order/OrderBrokerageService";
import { PayType } from "@/services/order/StoreOrderPayService";
import { WechatPayService } from "@/services/wechat/WechatPayService";
import {
  assertPaymentMethodAvailable,
  assertWechatPaymentProfileAvailable,
} from "@/services/payment/PaymentReadinessService";
import { resolveWechatPaymentIdentity } from "@/services/payment/WechatPaymentIdentity";
import { registerPaymentReconciliationIntent } from "@/services/payment/PaymentReconciliationRegistry";
import { signAlipayParams, type AlipayParams } from "@/utils/alipay";
import { parseConfigInteger } from "@/utils/config";
import { NotFoundException, ValidateException } from "@/utils/errors";

const MEMBER_CHANNELS: Readonly<Record<string, string>> = {
  weixin: "wechat",
  wechat: "wechat",
  weixinh5: "weixinh5",
  routine: "routine",
  h5: "h5",
};

const DAY_SECONDS = 86_400;
const MEMBERSHIP_ORDER_TYPES = new Set([0, 1]);
const MEMBERSHIP_PAY_TYPES: ReadonlySet<string> = new Set([
  PayType.YUE,
  PayType.WEIXIN,
  PayType.ALIPAY,
]);

export interface CreateMembershipOrderInput {
  uid: number;
  planId: number;
  orderId: string;
  channel: string;
  now?: number;
}

export interface CreateMembershipOrderResult {
  id: number;
  order_id: string;
  pay_price: string;
  paid: boolean;
  overdue_time: number;
}

export type MembershipPaymentOutcome =
  | "paid"
  | "already-paid"
  | "not-payable"
  | "missing";

export interface ApplyMembershipPaymentInput {
  orderId: string;
  payType: string;
  tradeNo?: string;
  uid?: number;
  debitBalance?: boolean;
  expectedAmountCents?: number;
  now?: number;
}

export interface MembershipPaymentResult {
  outcome: MembershipPaymentOutcome;
  overdue_time: number | null;
}

export function normalizeMemberChannel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return MEMBER_CHANNELS[value.trim().toLowerCase()] ?? null;
}

export function calculateMembershipExpiry(
  vipDay: number,
  isMoneyLevel: number,
  currentOverdueTime: number,
  now: number,
): number {
  if (!Number.isSafeInteger(vipDay) || vipDay <= 0) {
    throw new ValidateException("会员有效天数无效");
  }
  const base = isMoneyLevel > 0 && currentOverdueTime > now ? currentOverdueTime : now;
  const result = base + vipDay * DAY_SECONDS;
  if (!Number.isSafeInteger(result) || result <= now) {
    throw new ValidateException("会员有效期超出支持范围");
  }
  return result;
}

export async function timingSafeSecretEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (left: ArrayBuffer, right: ArrayBuffer) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(leftHash, rightHash);
  }
  // Node's WebCrypto used by unit tests does not yet expose the Workers
  // extension. Both inputs are fixed-length SHA-256 digests, so this loop does
  // not leak the original card-secret length and never short-circuits.
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

function positivePage(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function expiryDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleDateString("sv-SE", {
    timeZone: "Asia/Shanghai",
  });
}

function membershipState(
  account: { isMoneyLevel: number; overdueTime: number },
  vipDay: number,
  permanent: boolean,
  now: number,
): { isMoneyLevel: number; isEverLevel: number; overdueTime: number } {
  if (permanent) return { isMoneyLevel: 1, isEverLevel: 1, overdueTime: 0 };
  return {
    isMoneyLevel: 1,
    isEverLevel: 0,
    overdueTime: calculateMembershipExpiry(vipDay, account.isMoneyLevel, account.overdueTime, now),
  };
}

function assertMembershipOrderId(orderId: string): void {
  if (!/^[A-Za-z0-9_-]{2,32}$/.test(orderId)) {
    throw new ValidateException("会员订单号格式错误");
  }
}

/**
 * Resolve one historical other_order row without silently choosing between
 * duplicates. Only type=0/1 rows are membership purchases.
 */
export async function findMembershipOrderByOrderId(
  container: Container,
  orderId: string,
) {
  if (!orderId) return null;
  const rows = await container.db
    .select()
    .from(otherOrder)
    .where(eq(otherOrder.orderId, orderId))
    .limit(2);
  if (rows.length > 1) throw new ValidateException("会员订单号存在重复，请联系管理员处理");
  const order = rows[0] ?? null;
  return order && MEMBERSHIP_ORDER_TYPES.has(order.type) ? order : null;
}

/**
 * Create a server-priced membership order. A free plan is claimed and settled
 * inside the same transaction so two concurrent requests cannot claim it twice.
 */
export async function createMembershipOrder(
  container: Container,
  params: CreateMembershipOrderInput,
): Promise<CreateMembershipOrderResult> {
  if (!Number.isSafeInteger(params.uid) || params.uid <= 0) {
    throw new ValidateException("用户 ID 无效");
  }
  if (!Number.isSafeInteger(params.planId) || params.planId <= 0) {
    throw new ValidateException("请选择会员套餐");
  }
  assertMembershipOrderId(params.orderId);
  const channel = normalizeMemberChannel(params.channel);
  if (!channel) throw new ValidateException("非法渠道");
  const now = params.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("会员订单时间无效");

  return withTx(container, async (tx) => {
    // The user lock serializes free-plan eligibility and membership extension.
    const users = await tx
      .select({
        uid: userTable.uid,
        isMoneyLevel: userTable.isMoneyLevel,
        isEverLevel: userTable.isEverLevel,
        overdueTime: userTable.overdueTime,
      })
      .from(userTable)
      .where(and(eq(userTable.uid, params.uid), eq(userTable.isDel, 0)))
      .limit(1)
      .for("update");
    const account = users[0];
    if (!account) throw new NotFoundException("用户不存在，请重新登录");
    if (account.isMoneyLevel > 0 && account.isEverLevel === 1) {
      throw new ValidateException("您已是永久会员，无需再次购买");
    }

    const plans = await tx
      .select()
      .from(memberShip)
      .where(and(eq(memberShip.id, params.planId), eq(memberShip.isDel, 0)))
      .limit(1)
      .for("update");
    const plan = plans[0];
    if (!plan) throw new NotFoundException("会员套餐不存在或已停用");

    const isFree = plan.type === "free";
    const isPermanent = plan.type === "ever";
    if (!isPermanent && (!Number.isSafeInteger(plan.vipDay) || plan.vipDay <= 0)) {
      throw new ValidateException("会员套餐有效天数无效");
    }
    const payCents = isFree ? 0 : decimalToCents(plan.prePrice);
    if (!isFree && payCents <= 0) throw new ValidateException("会员套餐优惠价无效");

    if (isFree) {
      const prior = await tx
        .select({ id: otherOrder.id })
        .from(otherOrder)
        .where(and(eq(otherOrder.uid, params.uid), eq(otherOrder.isFree, 1)))
        .limit(1);
      if (prior.length) throw new ValidateException("您已经领取过免费会员");
    }

    const payPrice = (payCents / 100).toFixed(2);
    const state = membershipState(account, plan.vipDay, isPermanent, now);
    const orderOverdueTime = isPermanent ? -1 : state.overdueTime;
    const inserted = await tx
      .insert(otherOrder)
      .values({
        uid: params.uid,
        type: isFree ? 0 : 1,
        orderId: params.orderId,
        memberType: String(plan.id),
        payType: isFree ? PayType.YUE : "",
        paid: isFree ? 1 : 0,
        payPrice,
        memberPrice: payPrice,
        payTime: isFree ? now : 0,
        channelType: channel,
        isFree: isFree ? 1 : 0,
        isPermanent: isPermanent ? 1 : 0,
        overdueTime: orderOverdueTime,
        vipDay: plan.vipDay,
        addTime: now,
        money: payPrice,
        remarks: `会员套餐 ${plan.id}: ${plan.title}`,
      })
      .returning({ id: otherOrder.id });
    const order = inserted[0];
    if (!order) throw new Error("会员订单创建失败");

    await tx.insert(otherOrderStatus).values({
      oid: order.id,
      changeType: "create_member_order",
      changeMessage: "会员订单生成",
      shopType: isFree ? 0 : 1,
      changeTime: now,
    });

    if (isFree) {
      const updated = await tx
        .update(userTable)
        .set(state)
        .where(and(eq(userTable.uid, params.uid), eq(userTable.isDel, 0)))
        .returning({ uid: userTable.uid });
      if (!updated.length) throw new Error("免费会员状态更新失败");
      await tx.insert(otherOrderStatus).values({
        oid: order.id,
        changeType: "pay_success",
        changeMessage: "免费会员领取成功",
        shopType: 0,
        changeTime: now,
      });
    }

    return {
      id: order.id,
      order_id: params.orderId,
      pay_price: payPrice,
      paid: isFree,
      overdue_time: orderOverdueTime,
    };
  });
}

/**
 * Atomically debit optional balance, update the membership, mark the order
 * paid, write the immutable balance bill and append payment evidence.
 */
export async function applyMembershipPayment(
  container: Container,
  params: ApplyMembershipPaymentInput,
): Promise<MembershipPaymentResult> {
  const orderId = params.orderId.trim();
  assertMembershipOrderId(orderId);
  if (!MEMBERSHIP_PAY_TYPES.has(params.payType)) {
    throw new ValidateException("不支持的会员支付方式");
  }
  if (params.tradeNo && params.tradeNo.length > 50) {
    throw new ValidateException("支付交易号格式错误");
  }
  if (params.debitBalance && params.payType !== PayType.YUE) {
    throw new Error("余额扣款必须使用 yue 支付方式");
  }
  if (params.debitBalance && (!Number.isSafeInteger(params.uid) || Number(params.uid) <= 0)) {
    throw new ValidateException("用户 ID 无效");
  }
  if (
    params.expectedAmountCents !== undefined
    && (!Number.isSafeInteger(params.expectedAmountCents) || params.expectedAmountCents < 0)
  ) {
    throw new ValidateException("回调金额格式错误");
  }
  const now = params.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("会员支付时间无效");

  return withTx(container, async (tx) => {
    const orders = await tx
      .select()
      .from(otherOrder)
      .where(eq(otherOrder.orderId, orderId))
      .limit(2)
      .for("update");
    if (!orders.length || !MEMBERSHIP_ORDER_TYPES.has(orders[0].type)) {
      return { outcome: "missing", overdue_time: null };
    }
    if (orders.length !== 1) {
      throw new ValidateException("会员订单号存在重复，请联系管理员处理");
    }
    const order = orders[0];
    if (params.uid !== undefined && order.uid !== params.uid) {
      throw new ValidateException("订单不属于当前用户");
    }

    const payCents = decimalToCents(order.payPrice);
    if (
      params.expectedAmountCents !== undefined
      && payCents !== params.expectedAmountCents
    ) {
      throw new ValidateException("会员支付回调金额不匹配");
    }
    if (order.paid === 1) {
      if (
        params.tradeNo
        && (order.payType !== params.payType || order.tradeNo !== params.tradeNo)
      ) {
        throw new ValidateException("支付回调与已入账交易不匹配");
      }
      return { outcome: "already-paid", overdue_time: order.overdueTime };
    }
    if (order.isDel !== 0) return { outcome: "not-payable", overdue_time: null };
    if (order.type === 0 && (order.isFree !== 1 || payCents !== 0)) {
      throw new ValidateException("免费会员订单快照无效");
    }
    if (order.type === 1 && (order.isFree !== 0 || payCents <= 0)) {
      throw new ValidateException("付费会员订单快照无效");
    }
    const permanent = order.isPermanent === 1;
    if (!permanent && (!Number.isSafeInteger(order.vipDay) || order.vipDay <= 0)) {
      throw new ValidateException("会员订单有效天数无效");
    }

    const users = await tx
      .select({
        uid: userTable.uid,
        nowMoney: userTable.nowMoney,
        isMoneyLevel: userTable.isMoneyLevel,
        isEverLevel: userTable.isEverLevel,
        overdueTime: userTable.overdueTime,
      })
      .from(userTable)
      .where(and(eq(userTable.uid, order.uid), eq(userTable.isDel, 0)))
      .limit(1)
      .for("update");
    const account = users[0];
    if (!account) throw new NotFoundException("用户不存在");
    if (account.isMoneyLevel > 0 && account.isEverLevel === 1) {
      throw new ValidateException("您已是永久会员，该订单不能继续支付");
    }
    const state = membershipState(account, order.vipDay, permanent, now);
    const orderOverdueTime = permanent ? -1 : state.overdueTime;

    let balance = account.nowMoney;
    if (params.debitBalance && payCents > 0) {
      const payAmount = (payCents / 100).toFixed(2);
      const updated = await tx
        .update(userTable)
        .set({ ...state, nowMoney: sql`now_money - ${payAmount}` })
        .where(and(
          eq(userTable.uid, order.uid),
          eq(userTable.isDel, 0),
          sql`now_money >= ${payAmount}`,
        ))
        .returning({ nowMoney: userTable.nowMoney });
      if (!updated.length) throw new ValidateException("余额不足");
      balance = updated[0].nowMoney;
      await tx.insert(userBillTable).values({
        uid: order.uid,
        linkId: order.orderId,
        pm: 0,
        title: "购买会员",
        category: "now_money",
        type: "pay_member",
        eventKey: "membership_balance",
        number: payAmount,
        balance: String(balance),
        mark: `余额支付会员订单 ${order.orderId}`,
        status: 1,
        addTime: now,
      });
    } else {
      const updated = await tx
        .update(userTable)
        .set(state)
        .where(and(eq(userTable.uid, order.uid), eq(userTable.isDel, 0)))
        .returning({ uid: userTable.uid });
      if (!updated.length) throw new Error("会员状态更新失败");
    }

    const paid = await tx
      .update(otherOrder)
      .set({
        paid: 1,
        payType: params.payType,
        payTime: now,
        overdueTime: orderOverdueTime,
        ...(params.tradeNo ? { tradeNo: params.tradeNo } : {}),
      })
      .where(and(eq(otherOrder.id, order.id), eq(otherOrder.paid, 0), eq(otherOrder.isDel, 0)))
      .returning({ id: otherOrder.id });
    if (!paid.length) throw new Error("会员订单支付状态更新失败");

    await tx.insert(otherOrderStatus).values({
      oid: order.id,
      changeType: "pay_success",
      changeMessage: "用户付款成功",
      shopType: order.type,
      changeTime: now,
    });
    return { outcome: "paid", overdue_time: orderOverdueTime };
  });
}

export class PaidMembershipService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async createOrder(
    uid: number,
    input: { memberType?: unknown; from?: unknown },
  ): Promise<CreateMembershipOrderResult> {
    const planId = Number(input.memberType);
    if (!Number.isSafeInteger(planId) || planId <= 0) {
      throw new ValidateException("请选择会员套餐");
    }
    const channel = normalizeMemberChannel(input.from ?? "weixin");
    if (!channel) throw new ValidateException("非法渠道");
    const enabled = await new SystemConfigService(this.container, this.env).get("member_card_status");
    if (parseConfigInteger(enabled, 1) !== 1) {
      throw new ValidateException("付费会员功能暂未开启");
    }
    return createMembershipOrder(this.container, {
      uid,
      planId,
      orderId: await this.nextOrderId(),
      channel,
    });
  }

  async payOrder(
    uid: number,
    input: {
      orderId?: unknown;
      payType?: unknown;
      from?: unknown;
      payerClientIp?: string;
    },
  ): Promise<Record<string, unknown>> {
    const orderId = typeof input.orderId === "string" ? input.orderId.trim() : "";
    const payType = typeof input.payType === "string" ? input.payType.trim().toLowerCase() : "";
    assertMembershipOrderId(orderId);
    if (!MEMBERSHIP_PAY_TYPES.has(payType)) throw new ValidateException("不支持的会员支付方式");
    const order = await findMembershipOrderByOrderId(this.container, orderId);
    if (!order || order.uid !== uid || order.isDel !== 0) {
      throw new NotFoundException("会员订单不存在");
    }
    if (order.paid === 1) {
      return { order_id: order.orderId, paid: true, overdue_time: order.overdueTime };
    }
    const payCents = decimalToCents(order.payPrice);
    if (payType === PayType.YUE || payCents === 0) {
      if (payCents > 0) {
        await assertPaymentMethodAvailable(this.container, this.env, PayType.YUE);
      }
      const result = await applyMembershipPayment(this.container, {
        uid,
        orderId,
        payType: PayType.YUE,
        debitBalance: payCents > 0,
      });
      if (result.outcome === "missing") throw new NotFoundException("会员订单不存在");
      if (result.outcome === "not-payable") throw new ValidateException("会员订单状态不允许支付");
      return {
        order_id: orderId,
        paid: true,
        overdue_time: result.overdue_time,
        pay_type: PayType.YUE,
      };
    }
    if (payType === PayType.WEIXIN) {
      const channel = normalizeMemberChannel(input.from ?? order.channelType);
      if (!channel) throw new ValidateException("非法渠道");
      const identity = await resolveWechatPaymentIdentity(
        this.container,
        uid,
        channel,
        input.payerClientIp,
      );
      await assertWechatPaymentProfileAvailable(this.container, this.env, identity.profile);
      await registerPaymentReconciliationIntent(this.container, {
        provider: "wechat",
        profile: identity.profile,
        orderDomain: "membership",
        orderNo: order.orderId,
        expectedAmountCents: payCents,
        initiated: true,
      });
      const config = await new WechatPayService(this.container, this.env).createOrder({
        profile: identity.profile,
        type: identity.type,
        outTradeNo: orderId,
        description: `CinaShop 会员 ${order.memberType}`,
        amount: payCents / 100,
        ...(identity.openid ? { openid: identity.openid } : {}),
        ...(identity.payerClientIp ? { payerClientIp: identity.payerClientIp } : {}),
        attach: "member",
      });
      return { order_id: orderId, paid: false, pay_type: PayType.WEIXIN, jsConfig: config };
    }
    await assertPaymentMethodAvailable(this.container, this.env, PayType.ALIPAY);
    await registerPaymentReconciliationIntent(this.container, {
      provider: "alipay",
      profile: "alipay",
      orderDomain: "membership",
      orderNo: order.orderId,
      expectedAmountCents: payCents,
      initiated: true,
    });
    return {
      order_id: orderId,
      paid: false,
      pay_type: PayType.ALIPAY,
      payUrl: await this.createAlipayUrl(order.orderId, order.payPrice, order.memberType),
    };
  }

  async settleExternalPayment(
    orderId: string,
    payType: "weixin" | "alipay",
    tradeNo: string,
    amountCents: number,
  ): Promise<boolean> {
    const result = await applyMembershipPayment(this.container, {
      orderId,
      payType,
      tradeNo,
      expectedAmountCents: amountCents,
    });
    return result.outcome === "paid" || result.outcome === "already-paid";
  }

  async projectedExpiry(uid: number, memberType: unknown): Promise<{ data: string }> {
    const planId = Number(memberType);
    if (!Number.isSafeInteger(planId) || planId <= 0) throw new ValidateException("请选择会员套餐");
    const [users, plans] = await Promise.all([
      this.container.db
        .select({
          isMoneyLevel: userTable.isMoneyLevel,
          isEverLevel: userTable.isEverLevel,
          overdueTime: userTable.overdueTime,
        })
        .from(userTable)
        .where(and(eq(userTable.uid, uid), eq(userTable.isDel, 0)))
        .limit(1),
      this.container.db
        .select({ type: memberShip.type, vipDay: memberShip.vipDay })
        .from(memberShip)
        .where(and(eq(memberShip.id, planId), eq(memberShip.isDel, 0)))
        .limit(1),
    ]);
    const account = users[0];
    const plan = plans[0];
    if (!account) throw new NotFoundException("用户不存在");
    if (!plan) throw new NotFoundException("会员套餐不存在或已停用");
    if (account.isEverLevel === 1 || plan.type === "ever") return { data: "永久会员" };
    const overdueTime = calculateMembershipExpiry(
      plan.vipDay,
      account.isMoneyLevel,
      account.overdueTime,
      Math.floor(Date.now() / 1000),
    );
    return { data: expiryDate(overdueTime) };
  }

  private async nextOrderId(): Promise<string> {
    const sequenceId = this.env.SEQUENCE.idFromName("seq");
    const sequence = this.env.SEQUENCE.get(sequenceId);
    const response = await sequence.fetch("https://internal/next-order-id?prefix=hy");
    if (!response.ok) throw new Error("会员订单号生成失败");
    const orderId = (await response.text()).trim();
    assertMembershipOrderId(orderId);
    return orderId;
  }

  private async createAlipayUrl(orderId: string, payPrice: string, memberType: string): Promise<string> {
    const appId = this.env.ALIPAY_APP_ID;
    const privateKey = this.env.ALIPAY_PRIVATE_KEY;
    const notifyUrl = this.env.ALIPAY_NOTIFY_URL;
    const returnUrl = this.env.ALIPAY_RETURN_URL;
    if (!appId || !privateKey || !notifyUrl || !returnUrl) {
      throw new ValidateException("支付宝支付尚未完成商户配置");
    }
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
        total_amount: Number(payPrice).toFixed(2),
        subject: `CinaShop 会员 ${memberType}`,
        product_code: "QUICK_WAP_WAY",
      }),
    };
    params.sign = await signAlipayParams(params, privateKey);
    return `https://openapi.alipay.com/gateway.do?${new URLSearchParams(params).toString()}`;
  }

  async index(uid: number): Promise<Record<string, unknown>> {
    const now = Math.floor(Date.now() / 1000);
    const [users, rights, agreements, plans, freeRecords, economizeRows, config, coupons] =
      await Promise.all([
        this.container.db
          .select({
            uid: userTable.uid,
            nickname: userTable.nickname,
            avatar: userTable.avatar,
            phone: userTable.phone,
            nowMoney: userTable.nowMoney,
            isEverLevel: userTable.isEverLevel,
            isMoneyLevel: userTable.isMoneyLevel,
            overdueTime: userTable.overdueTime,
            addTime: userTable.addTime,
          })
          .from(userTable)
          .where(eq(userTable.uid, uid))
          .limit(1),
        this.container.db
          .select()
          .from(memberRight)
          .where(eq(memberRight.status, 1))
          .orderBy(desc(memberRight.sort), memberRight.id),
        this.container.db
          .select()
          .from(agreement)
          .where(and(eq(agreement.type, 1), eq(agreement.status, 1)))
          .orderBy(desc(agreement.sort), desc(agreement.id))
          .limit(1),
        this.container.db
          .select()
          .from(memberShip)
          .where(eq(memberShip.isDel, 0))
          .orderBy(desc(memberShip.sort), memberShip.id),
        this.container.db
          .select({ id: otherOrder.id })
          .from(otherOrder)
          .where(and(eq(otherOrder.uid, uid), eq(otherOrder.isFree, 1)))
          .limit(1),
        this.container.db
          .select({
            amount: sql<string>`COALESCE(SUM(
              ${storeOrderEconomize.postagePrice}
              + ${storeOrderEconomize.memberPrice}
              + ${storeOrderEconomize.offlinePrice}
              + ${storeOrderEconomize.couponPrice}
            ), 0)::text`,
          })
          .from(storeOrderEconomize)
          .where(eq(storeOrderEconomize.uid, uid)),
        new SystemConfigService(this.container, this.env).getMany([
          "member_card_status",
          "site_name",
        ]),
        this.memberCoupons(uid, 1, 4),
      ]);

    const account = users[0];
    if (!account) throw new NotFoundException("用户不存在");
    const enabled = parseConfigInteger(config.member_card_status, 1) === 1;

    const memberTypes = enabled
      ? plans.map((plan) => {
          const permanent = plan.type === "ever";
          const overdueTime = permanent
            ? "永久会员"
            : plan.vipDay > 0
              ? expiryDate(
                  calculateMembershipExpiry(
                    plan.vipDay,
                    account.isMoneyLevel,
                    account.overdueTime,
                    now,
                  ),
                )
              : "";
          return {
            id: plan.id,
            title: plan.title,
            type: plan.type,
            vip_day: plan.vipDay,
            pre_price: plan.prePrice,
            is_label: plan.isLabel,
            price: plan.price,
            overdue_time: overdueTime,
          };
        })
      : [];

    const freePlan = plans.find((plan) => plan.type === "free");
    return {
      member_rights: enabled
        ? rights.map((right) => ({
            id: right.id,
            right_type: right.rightType,
            title: right.showTitle,
            pic: right.image,
            explain: right.explain,
            content: right.content,
            number: right.number,
          }))
        : [],
      is_get_free: {
        price: 0,
        pre_price: 0,
        title: "免费会员",
        type: "free",
        vip_day: freePlan?.vipDay ?? 0,
        is_record: freeRecords.length > 0 ? 1 : 0,
        user_info: {
          uid: account.uid,
          nickname: account.nickname,
          avatar: account.avatar,
          phone: account.phone,
          now_money: account.nowMoney,
          is_ever_level: account.isEverLevel,
          is_money_level: account.isMoneyLevel,
          overdue_time: account.overdueTime,
          register_days: Math.max(0, Math.floor((now - account.addTime) / DAY_SECONDS)),
          economize_money: Number(economizeRows[0]?.amount ?? 0).toFixed(2),
          shop_name: config.site_name ?? "",
        },
      },
      member_explain: agreements[0] ?? "",
      member_type: memberTypes,
      member_coupons: enabled ? coupons : [],
    };
  }

  async memberCoupons(uid: number, pageValue: unknown, limitValue: unknown) {
    const page = positivePage(pageValue, 1);
    const limit = Math.min(50, positivePage(limitValue, 4));
    const now = new Date();
    const [issues, received] = await Promise.all([
      this.container.db
        .select()
        .from(storeCouponIssue)
        .where(
          and(
            eq(storeCouponIssue.category, 2),
            eq(storeCouponIssue.status, 1),
            eq(storeCouponIssue.isDel, 0),
            sql`(${storeCouponIssue.startTime} IS NULL OR ${storeCouponIssue.startTime} <= ${now})`,
            sql`(${storeCouponIssue.endTime} IS NULL OR ${storeCouponIssue.endTime} >= ${now})`,
          ),
        )
        .orderBy(desc(storeCouponIssue.sort), desc(storeCouponIssue.addTime), desc(storeCouponIssue.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.storeCouponUserDao.listByUid(uid),
    ]);

    const latestByIssue = new Map<number, (typeof received)[number]>();
    for (const coupon of received) {
      if (!latestByIssue.has(coupon.issueCouponId)) latestByIssue.set(coupon.issueCouponId, coupon);
    }
    return issues.map((issue) => {
      const used = latestByIssue.get(issue.id) ?? null;
      return {
        ...issue,
        is_use: used !== null,
        used,
      };
    });
  }

  async redeem(
    uid: number,
    input: { cardCode?: unknown; cardPassword?: unknown; from?: unknown },
  ): Promise<{ order_id: string; overdue_time: number }> {
    const cardCode = typeof input.cardCode === "string" ? input.cardCode.trim() : "";
    const cardPassword = typeof input.cardPassword === "string" ? input.cardPassword.trim() : "";
    const channel = normalizeMemberChannel(input.from ?? "weixin");
    if (!cardCode) throw new ValidateException("请输入会员卡号");
    if (!cardPassword) throw new ValidateException("请输入领取卡密");
    if (cardCode.length > 20 || cardPassword.length > 12) {
      throw new ValidateException("会员卡号或卡密格式错误");
    }
    if (!channel) throw new ValidateException("非法渠道");

    const enabled = await new SystemConfigService(this.container, this.env).get("member_card_status");
    if (parseConfigInteger(enabled, 1) !== 1) {
      throw new ValidateException("会员功能暂未开启");
    }

    const sequenceId = this.env.SEQUENCE.idFromName("seq");
    const sequence = this.env.SEQUENCE.get(sequenceId);
    const sequenceResponse = await sequence.fetch("https://internal/next-order-id?prefix=hy");
    if (!sequenceResponse.ok) throw new Error("会员订单号生成失败");
    const orderId = (await sequenceResponse.text()).trim();
    if (!orderId || orderId.length > 32) throw new Error("会员订单号生成失败");

    const now = Math.floor(Date.now() / 1000);
    return withTx(this.container, async (tx) => {
      // Fixed lock order: user -> card -> batch. No external I/O occurs after
      // the transaction starts, keeping Hyperdrive/PostgreSQL locks short.
      const users = await tx
        .select({
          uid: userTable.uid,
          isMoneyLevel: userTable.isMoneyLevel,
          isEverLevel: userTable.isEverLevel,
          overdueTime: userTable.overdueTime,
        })
        .from(userTable)
        .where(eq(userTable.uid, uid))
        .limit(1)
        .for("update");
      const account = users[0];
      if (!account) throw new NotFoundException("用户不存在，请重新登录");
      if (account.isMoneyLevel > 0 && account.isEverLevel === 1) {
        throw new ValidateException("您已是永久会员，无需再领取");
      }

      const cards = await tx
        .select()
        .from(memberCard)
        .where(eq(memberCard.cardNumber, cardCode))
        .limit(2)
        .for("update");
      if (!cards.length) throw new ValidateException("会员卡不存在");
      if (cards.length !== 1) throw new ValidateException("会员卡号存在重复，请联系管理员处理");
      const card = cards[0];

      const batches = await tx
        .select()
        .from(memberCardBatch)
        .where(eq(memberCardBatch.id, card.cardBatchId))
        .limit(1)
        .for("update");
      const batch = batches[0];
      if (!batch || batch.status !== 1) throw new ValidateException("会员卡未激活，暂无法使用");
      if (card.status !== 1) throw new ValidateException("会员卡暂未激活");
      if (card.useUid > 0 || card.useTime > 0) throw new ValidateException("会员卡已使用");
      if (!(await timingSafeSecretEqual(card.cardPassword.trim(), cardPassword))) {
        throw new ValidateException("会员卡密码有误");
      }

      const overdueTime = calculateMembershipExpiry(
        batch.useDay,
        account.isMoneyLevel,
        account.overdueTime,
        now,
      );
      const updatedCards = await tx
        .update(memberCard)
        .set({ useUid: uid, useTime: now, updateTime: now })
        .where(
          and(
            eq(memberCard.id, card.id),
            eq(memberCard.cardBatchId, card.cardBatchId),
            eq(memberCard.status, 1),
            eq(memberCard.useUid, 0),
            eq(memberCard.useTime, 0),
          ),
        )
        .returning({ id: memberCard.id });
      if (!updatedCards.length) throw new ValidateException("会员卡已被领取");

      const updatedBatches = await tx
        .update(memberCardBatch)
        .set({ useNum: sql`${memberCardBatch.useNum} + 1`, updateTime: now })
        .where(and(eq(memberCardBatch.id, batch.id), eq(memberCardBatch.status, 1)))
        .returning({ id: memberCardBatch.id });
      if (!updatedBatches.length) throw new ValidateException("会员卡批次已停用");

      const updatedUsers = await tx
        .update(userTable)
        .set({ isMoneyLevel: 2, isEverLevel: 0, overdueTime })
        .where(eq(userTable.uid, uid))
        .returning({ uid: userTable.uid });
      if (!updatedUsers.length) throw new Error("会员状态更新失败");

      const orders = await tx
        .insert(otherOrder)
        .values({
          uid,
          type: 2,
          orderId,
          memberType: "free",
          code: card.cardNumber,
          paid: 1,
          payTime: now,
          channelType: channel,
          overdueTime,
          vipDay: batch.useDay,
          addTime: now,
          remarks: `卡密激活批次 ${batch.id}`,
        })
        .returning({ id: otherOrder.id });
      const membershipOrder = orders[0];
      if (!membershipOrder) throw new Error("会员激活记录创建失败");

      await tx.insert(otherOrderStatus).values({
        oid: membershipOrder.id,
        changeType: "card_redeem",
        changeMessage: "用户卡密激活会员",
        shopType: 2,
        changeTime: now,
      });
      return { order_id: orderId, overdue_time: overdueTime };
    });
  }
}

function formatAlipayTimestamp(date: Date): string {
  const chinaTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return chinaTime.toISOString().slice(0, 19).replace("T", " ");
}
