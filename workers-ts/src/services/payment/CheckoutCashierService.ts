import { eq } from "drizzle-orm";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { userRecharge } from "@/models/schema";
import { findMembershipOrderByOrderId } from "@/services/user/PaidMembershipService";
import {
  getPaymentReadiness,
  type CheckoutPaymentMethod,
  type PaymentMethodReadiness,
  type PaymentReadiness,
} from "@/services/payment/PaymentReadinessService";
import { getOrderInvalidTime } from "@/services/payment/OrderPaymentPolicy";
import { decimalToCents } from "@/services/order/OrderBrokerageService";
import { NotFoundException, ValidateException } from "@/utils/errors";

export type CashierOrderType = "order" | "vip" | "recharge";

export interface CheckoutCashierResult {
  type: CashierOrderType;
  order_id: string;
  pay_price: string;
  pay_postage: string;
  pay_integral: number;
  now_money: string;
  integral: number;
  invalid_time: number;
  paid: boolean;
  payable: boolean;
  payable_reason: string;
  zero_pay: boolean;
  methods: PaymentReadiness;
  offline_pay_status: 1 | 2;
  yue_pay_status: 1 | 2;
  ali_pay_status: 0 | 1;
  pay_weixin_open: 0 | 1;
}

function expiresAt(addTime: number, hours: number): number {
  return hours > 0 ? addTime + Math.ceil(hours * 3600) : 0;
}

function disableAll(readiness: PaymentReadiness, reason: string): PaymentReadiness {
  return Object.fromEntries(
    Object.entries(readiness).map(([method]) => [method, { enabled: false, reason }]),
  ) as PaymentReadiness;
}

function disableMethod(
  readiness: PaymentReadiness,
  method: CheckoutPaymentMethod,
  reason: string,
): PaymentReadiness {
  return { ...readiness, [method]: { enabled: false, reason } };
}

function legacyEnabled(method: PaymentMethodReadiness): boolean {
  return method.enabled;
}

export class CheckoutCashierService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async get(uid: number, orderId: string, requestedType: string): Promise<CheckoutCashierResult> {
    const type = requestedType.trim().toLowerCase() as CashierOrderType;
    if (!(["order", "vip", "recharge"] as string[]).includes(type)) {
      throw new ValidateException("暂不支持其他类型订单支付");
    }
    if (!orderId.trim()) throw new ValidateException("订单号不能为空");

    const account = await this.container.userDao.findForAuth(uid);
    if (!account) throw new NotFoundException("用户不存在");
    let payPrice = "0.00";
    let payPostage = "0.00";
    let payIntegral = 0;
    let invalidTime = 0;
    let paid = false;
    let payable = true;
    let payableReason = "";

    if (type === "order") {
      const order = await this.container.storeOrderDao.findByOrderId(orderId);
      if (!order || order.uid !== uid || order.isDel !== 0) {
        throw new NotFoundException("您支付的订单不存在");
      }
      payPrice = order.payPrice;
      payPostage = order.payPostage;
      payIntegral = order.payIntegral;
      invalidTime = await getOrderInvalidTime(
        this.container,
        this.env,
        order.type,
        order.addTime,
      );
      paid = order.paid === 1;
      if (paid) payableReason = "订单已支付";
      else if (order.status !== 0) payableReason = "订单状态不允许支付";
      else if (invalidTime > 0 && invalidTime <= Math.floor(Date.now() / 1000)) {
        payableReason = "订单已超过支付时限";
      } else if (payIntegral > account.integral) {
        payableReason = `积分不足, 需要 ${payIntegral} 积分`;
      }
      payable = !payableReason;
    } else if (type === "vip") {
      const order = await findMembershipOrderByOrderId(this.container, orderId);
      if (!order || order.uid !== uid || order.isDel !== 0) {
        throw new NotFoundException("您支付的订单不存在");
      }
      payPrice = order.payPrice;
      invalidTime = expiresAt(order.addTime, 30);
      paid = order.paid === 1;
      payableReason = paid
        ? "订单已支付"
        : invalidTime > 0 && invalidTime <= Math.floor(Date.now() / 1000)
          ? "订单已超过支付时限"
          : "";
      payable = !payableReason;
    } else {
      const orders = await this.container.db
        .select()
        .from(userRecharge)
        .where(eq(userRecharge.orderId, orderId))
        .limit(2);
      if (orders.length > 1) throw new ValidateException("充值订单号存在重复，请联系管理员处理");
      const order = orders[0];
      if (!order || order.uid !== uid) throw new NotFoundException("您支付的订单不存在");
      payPrice = order.price;
      invalidTime = expiresAt(order.addTime, 30);
      paid = order.paid === 1;
      payableReason = paid
        ? "订单已支付"
        : invalidTime > 0 && invalidTime <= Math.floor(Date.now() / 1000)
          ? "订单已超过支付时限"
          : "";
      payable = !payableReason;
    }

    let methods = await getPaymentReadiness(this.container, this.env);
    if (type === "recharge") {
      methods = disableMethod(methods, "yue", "充值不能使用账户余额支付");
      methods = disableMethod(methods, "alipay", "充值暂不支持支付宝");
      methods = disableMethod(methods, "offline", "充值暂不支持线下支付");
    }
    if (decimalToCents(payPrice) > decimalToCents(account.nowMoney)) {
      methods = disableMethod(methods, "yue", "余额不足");
    }
    if (!payable) methods = disableAll(methods, payableReason);

    return {
      type,
      order_id: orderId,
      pay_price: Number(payPrice).toFixed(2),
      pay_postage: Number(payPostage).toFixed(2),
      pay_integral: payIntegral,
      now_money: Number(account.nowMoney).toFixed(2),
      integral: account.integral,
      invalid_time: invalidTime,
      paid,
      payable,
      payable_reason: payableReason,
      zero_pay: decimalToCents(payPrice) === 0,
      methods,
      offline_pay_status: legacyEnabled(methods.offline) ? 1 : 2,
      yue_pay_status: legacyEnabled(methods.yue) ? 1 : 2,
      ali_pay_status: legacyEnabled(methods.alipay) ? 1 : 0,
      pay_weixin_open: legacyEnabled(methods.weixin) ? 1 : 0,
    };
  }
}
