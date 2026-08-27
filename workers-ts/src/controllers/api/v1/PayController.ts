/**
 * 支付 + 售后控制器 (M4)
 *
 * 对应 PHP app/controller/api/v1/Pay.php + order/StoreOrder.php(pay) + order/StoreOrderRefund.php
 */
import type { Context } from "hono";
import { jsonOk, jsonFail } from "@/utils/json";
import { ValidateException } from "@/utils/errors";
import { StoreOrderPayService } from "@/services/order/StoreOrderPayService";
import { StoreOrderRefundService } from "@/services/order/StoreOrderRefundService";
import {
  findMembershipOrderByOrderId,
  PaidMembershipService,
} from "@/services/user/PaidMembershipService";
import { CheckoutCashierService } from "@/services/payment/CheckoutCashierService";
import {
  findRechargeOrderByOrderId,
  RechargePaymentService,
} from "@/services/payment/RechargePaymentService";
import { getPaymentReadiness } from "@/services/payment/PaymentReadinessService";
import { clientIp } from "@/controllers/api/v1/UserBehaviorController";
import type { AppVariables, Env } from "@/env";
import { verifyAlipayNotification, type AlipayParams } from "@/utils/alipay";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

/**
 * POST /api/order/pay
 * 用户发起支付 (对应 PHP StoreOrder::pay)
 * body: { uni: orderId, paytype: 'yue'|'weixin'|'alipay'|'offline' }
 *
 * Every positive-value rail is dispatched after effective readiness checks.
 */
export async function orderPay(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    uni?: string;
    paytype?: string;
    from?: string;
  };
  if (!body.uni) return jsonFail(c, "参数错误");
  const paytype = body.paytype ?? "yue";
  if (body.uni.startsWith("cz")) return jsonFail(c, "充值订单请使用充值支付接口");

  const svc = new StoreOrderPayService(c.get("container"), c.env);
  try {
    const result = await svc.pay(
      uid,
      body.uni,
      paytype,
      body.from ?? c.req.header("Form-type") ?? "h5",
      clientIp(c),
    );
    return jsonOk(c, result, result.paid === true ? "支付成功" : "支付下单成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/**
 * POST /api/pay/notify/alipay
 * 支付宝异步回调：RSA2 验签，并校验 app_id、seller_id、订单号和金额。
 */
export async function alipayNotify(c: C) {
  const publicKey = c.env.ALIPAY_PUBLIC_KEY;
  const appId = c.env.ALIPAY_APP_ID;
  if (!publicKey || !appId) {
    console.error("[alipayNotify] missing ALIPAY_PUBLIC_KEY or ALIPAY_APP_ID");
    return c.text("failure", 500);
  }
  try {
    const body = await c.req.parseBody({ all: false });
    const params: AlipayParams = {};
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === "string") params[key] = value;
    }

    if (!(await verifyAlipayNotification(params, publicKey))) {
      console.warn("[alipayNotify] signature verification failed");
      return c.text("failure", 400);
    }
    if (params.app_id !== appId) {
      console.warn("[alipayNotify] app_id mismatch");
      return c.text("failure", 400);
    }
    if (c.env.ALIPAY_SELLER_ID && params.seller_id !== c.env.ALIPAY_SELLER_ID) {
      console.warn("[alipayNotify] seller_id mismatch");
      return c.text("failure", 400);
    }

    const tradeStatus = params.trade_status ?? "";
    if (tradeStatus !== "TRADE_SUCCESS" && tradeStatus !== "TRADE_FINISHED") {
      return c.text("success", 200);
    }

    const outTradeNo = params.out_trade_no ?? "";
    const tradeNo = params.trade_no ?? "";
    const container = c.get("container");
    const [order, membershipOrder, rechargeOrder] = outTradeNo
      ? await Promise.all([
          container.storeOrderDao.findByOrderId(outTradeNo),
          findMembershipOrderByOrderId(container, outTradeNo),
          findRechargeOrderByOrderId(container, outTradeNo),
        ])
      : [null, null, null];
    if ([order, membershipOrder, rechargeOrder].filter(Boolean).length !== 1 || !tradeNo) {
      console.warn("[alipayNotify] order or trade number missing");
      return c.text("failure", 400);
    }

    const notifiedCents = moneyToCents(params.total_amount);
    const expectedCents = moneyToCents(
      order?.payPrice ?? membershipOrder?.payPrice ?? rechargeOrder?.price,
    );
    if (notifiedCents === null || expectedCents === null || notifiedCents !== expectedCents) {
      console.warn("[alipayNotify] amount mismatch");
      return c.text("failure", 400);
    }

    const settled = rechargeOrder
      ? await new RechargePaymentService(container, c.env).settleExternalPayment(
          outTradeNo,
          "alipay",
          tradeNo,
          notifiedCents,
        )
      : membershipOrder
      ? await new PaidMembershipService(container, c.env).settleExternalPayment(
          outTradeNo,
          "alipay",
          tradeNo,
          notifiedCents,
        )
      : await new StoreOrderPayService(container, c.env).paySuccessByOrderId(
          outTradeNo,
          "alipay",
          tradeNo,
        );
    if (!settled) {
      return c.text("failure", 400);
    }
    return c.text("success", 200);
  } catch (e) {
    console.error("[alipayNotify] processing failed:", e);
    return c.text("failure", 500);
  }
}

/** GET /api/order/cashier/:orderId/:type? */
export async function orderCashier(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const orderId = c.req.param("orderId");
  if (!orderId) return jsonFail(c, "参数错误");
  try {
    const result = await new CheckoutCashierService(c.get("container"), c.env)
      .get(uid, orderId, c.req.param("type") || "order");
    return jsonOk(c, result);
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
}

/** GET /api/payment/readiness — public method state without credential values. */
export async function paymentReadiness(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  return jsonOk(c, await getPaymentReadiness(c.get("container"), c.env));
}

/** POST /api/recharge/pay — provider-backed recharge payment only. */
export async function rechargePay(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    uni?: string;
    paytype?: string;
    from?: string;
  };
  if (!body.uni) return jsonFail(c, "参数错误");
  if ((body.paytype ?? "weixin") !== "weixin") {
    return jsonFail(c, "充值暂仅支持微信支付");
  }
  try {
    const result = await new RechargePaymentService(c.get("container"), c.env)
      .startWechatPayment(
        uid,
        body.uni,
        body.from ?? c.req.header("Form-type") ?? "h5",
        clientIp(c),
      );
    return jsonOk(c, result, "支付下单成功");
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
}

function moneyToCents(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(value)) {
    return null;
  }
  const amount = Number(value);
  if (!Number.isSafeInteger(Math.round(amount * 100))) {
    return null;
  }
  return Math.round(amount * 100);
}

// ─── 售后退款 ────────────────────────────────────────────────

/** POST /api/order/refund/apply/:id  申请退款 */
export async function refundApply(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const orderId = c.req.param("id");
  if (!orderId) return jsonFail(c, "参数错误");
  const body = (await c.req.json().catch(() => ({}))) as {
    refundReason?: string;
    refundExplain?: string;
    refundImg?: string;
    applyType?: number;
    cartIds?: number[];
  };

  const svc = new StoreOrderRefundService(c.get("container"), c.env);
  try {
    const result = await svc.applyRefund({
      uid,
      orderId,
      refundReason: body.refundReason ?? "",
      refundExplain: body.refundExplain ?? "",
      refundImg: body.refundImg,
      applyType: body.applyType ?? 1,
      cartIds: body.cartIds,
    });
    return jsonOk(c, result, "申请成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/order/refund/cancel/:uni  取消退款申请 */
export async function refundCancel(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const refundId = Number(c.req.param("uni"));
  if (!refundId) return jsonFail(c, "参数错误");
  const svc = new StoreOrderRefundService(c.get("container"), c.env);
  try {
    await svc.cancelApply(uid, refundId);
    return jsonOk(c, null, "取消成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /api/order/refund/list  退款列表 */
export async function refundList(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new StoreOrderRefundService(c.get("container"), c.env);
  const list = await svc.listByUser(uid);
  return jsonOk(c, list);
}

/** GET /api/order/refund/detail/:uni  退款详情 */
export async function refundDetail(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const refundId = Number(c.req.param("uni"));
  if (!refundId) return jsonFail(c, "参数错误");
  const svc = new StoreOrderRefundService(c.get("container"), c.env);
  const detail = await svc.detail(uid, refundId);
  return jsonOk(c, detail);
}
