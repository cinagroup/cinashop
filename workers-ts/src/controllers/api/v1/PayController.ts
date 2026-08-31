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
import {
  LegacyOrderCompatibilityService,
  parseLegacyRefundSelections,
} from "@/services/order/LegacyOrderCompatibilityService";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";

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
    if (result.pay_type === "alipay" && result.paid === false) {
      result.pay_key = await new LegacyOrderCompatibilityService(c.get("container"), c.env)
        .createAlipayKey(uid, body.uni);
    }
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
    emitOperationalEvent("error", {
      event: "payment_callback_failed",
      component: "payment",
      operation: "alipay_callback",
      outcome: "failure",
      errorCode: "provider_configuration_missing",
    });
    return c.text("failure", 500);
  }
  try {
    const body = await c.req.parseBody({ all: false });
    const params: AlipayParams = {};
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === "string") params[key] = value;
    }

    if (!(await verifyAlipayNotification(params, publicKey))) {
      emitOperationalEvent("warn", {
        event: "payment_callback_rejected",
        component: "payment",
        operation: "alipay_callback",
        outcome: "rejected",
        errorCode: "signature_verification_failed",
      });
      return c.text("failure", 400);
    }
    if (params.app_id !== appId) {
      emitOperationalEvent("warn", {
        event: "payment_callback_rejected",
        component: "payment",
        operation: "alipay_callback",
        outcome: "rejected",
        errorCode: "application_mismatch",
      });
      return c.text("failure", 400);
    }
    if (c.env.ALIPAY_SELLER_ID && params.seller_id !== c.env.ALIPAY_SELLER_ID) {
      emitOperationalEvent("warn", {
        event: "payment_callback_rejected",
        component: "payment",
        operation: "alipay_callback",
        outcome: "rejected",
        errorCode: "seller_mismatch",
      });
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
      emitOperationalEvent("warn", {
        event: "payment_callback_rejected",
        component: "payment",
        operation: "alipay_callback",
        outcome: "rejected",
        errorCode: "order_identity_invalid",
      });
      return c.text("failure", 400);
    }

    const notifiedCents = moneyToCents(params.total_amount);
    const expectedCents = moneyToCents(
      order?.payPrice ?? membershipOrder?.payPrice ?? rechargeOrder?.price,
    );
    if (notifiedCents === null || expectedCents === null || notifiedCents !== expectedCents) {
      emitOperationalEvent("warn", {
        event: "payment_callback_rejected",
        component: "payment",
        operation: "alipay_callback",
        outcome: "rejected",
        errorCode: "amount_mismatch",
      });
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
      emitOperationalEvent("warn", {
        event: "payment_callback_rejected",
        component: "payment",
        operation: "alipay_callback",
        outcome: "rejected",
        errorCode: "order_not_payable",
      });
      return c.text("failure", 400);
    }
    emitOperationalEvent("info", {
      event: "payment_callback_completed",
      component: "payment",
      operation: "alipay_callback",
      outcome: "success",
    });
    return c.text("success", 200);
  } catch (e) {
    emitOperationalEvent("error", {
      event: "payment_callback_failed",
      component: "payment",
      operation: "alipay_callback",
      outcome: "failure",
      errorCode: operationalErrorCode(e),
    });
    return c.text("failure", 500);
  }
}

/** GET /api/ali_pay — five-minute opaque-key compatibility redirect payload. */
export async function aliPay(c: C) {
  const key = c.req.query("key") ?? "";
  if (!key) return jsonFail(c, "该订单无法支付");
  try {
    const compatibility = new LegacyOrderCompatibilityService(c.get("container"), c.env);
    const payment = await compatibility.consumeAlipayKey(key);
    const payContent = await new StoreOrderPayService(c.get("container"), c.env)
      .alipayPay(payment.uid, payment.orderId);
    return jsonOk(c, { pay_content: payContent });
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
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
    text?: string;
    refund_reason_wap_explain?: string;
    refund_reason_wap_img?: string | string[];
    refund_type?: number;
    cart_ids?: unknown[];
  };

  let authoritativeOrderId = orderId;
  const internalId = Number(orderId);
  if (Number.isSafeInteger(internalId) && internalId > 0) {
    const order = await c.get("container").storeOrderDao.get(internalId);
    if (order) {
      if (order.uid !== uid) return jsonFail(c, "订单不存在");
      authoritativeOrderId = order.orderId;
    }
  }
  let legacySelections: Array<{ cartId: number; cartNum: number }> | undefined;
  try {
    const parsed = parseLegacyRefundSelections(body.cart_ids);
    legacySelections = parsed.length
      ? parsed.map((item) => ({ cartId: item.cartId, cartNum: item.cartNum ?? 0 }))
      : undefined;
    if (legacySelections?.some((item) => item.cartNum <= 0)) {
      return jsonFail(c, "请重新选择退款商品，或件数");
    }
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
  const legacyImage = Array.isArray(body.refund_reason_wap_img)
    ? JSON.stringify(body.refund_reason_wap_img)
    : body.refund_reason_wap_img;

  const svc = new StoreOrderRefundService(c.get("container"), c.env);
  try {
    const result = await svc.applyRefund({
      uid,
      orderId: authoritativeOrderId,
      refundReason: body.refundReason ?? body.text ?? "",
      refundExplain: body.refundExplain ?? body.refund_reason_wap_explain ?? "",
      refundImg: body.refundImg ?? legacyImage,
      applyType: body.applyType ?? body.refund_type ?? 1,
      ...(legacySelections ? { cartSelections: legacySelections } : { cartIds: body.cartIds }),
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
  const identifier = c.req.param("uni") ?? "";
  if (!identifier) return jsonFail(c, "参数错误");
  const svc = new StoreOrderRefundService(c.get("container"), c.env);
  try {
    await svc.cancelApplyByIdentifier(uid, identifier);
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
  const refundId = c.req.param("uni") ?? "";
  if (!refundId) return jsonFail(c, "参数错误");
  const svc = new StoreOrderRefundService(c.get("container"), c.env);
  const detail = await svc.detail(uid, refundId);
  return jsonOk(c, detail);
}

/** POST /api/order/refund/verify — legacy apply-by-order-number alias. */
export async function refundVerify(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const orderId = String(body.uni ?? "").trim();
  const reason = String(body.text ?? body.refundReason ?? "").trim();
  if (!orderId || !reason) return jsonFail(c, "参数错误");
  try {
    const selections = parseLegacyRefundSelections(body.cart_ids ?? body.cartIds);
    const exact = selections.length
      ? selections.map((item) => {
          if (!item.cartNum) throw new ValidateException("请重新选择退款商品，或件数");
          return { cartId: item.cartId, cartNum: item.cartNum };
        })
      : undefined;
    const rawImages = body.refund_reason_wap_img ?? body.refundImg ?? "";
    const refundImg = Array.isArray(rawImages) ? JSON.stringify(rawImages) : String(rawImages);
    const result = await new StoreOrderRefundService(c.get("container"), c.env).applyRefund({
      uid,
      orderId,
      refundReason: reason,
      refundExplain: String(body.refund_reason_wap_explain ?? body.refundExplain ?? ""),
      refundImg,
      applyType: Number(body.refund_type ?? body.applyType ?? 1),
      ...(exact ? { cartSelections: exact } : {}),
    });
    return jsonOk(c, result, "提交申请成功");
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
}

/** POST /api/order/refund/express — authenticated return tracking transition. */
export async function refundExpress(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const rawImages = body.refund_goods_img ?? body.refund_img ?? "";
    await new StoreOrderRefundService(c.get("container"), c.env).submitReturnExpress(uid, {
      id: Number(body.id ?? 0),
      refundExpress: String(body.refund_express ?? body.refundExpress ?? ""),
      refundPhone: String(body.refund_phone ?? body.refundPhone ?? ""),
      refundExpressName: String(body.refund_express_name ?? body.refundExpressName ?? ""),
      refundGoodsImg: Array.isArray(rawImages) ? JSON.stringify(rawImages) : String(rawImages),
      refundGoodsExplain: String(body.refund_goods_explain ?? body.refundGoodsExplain ?? ""),
    });
    return jsonOk(c, null, "提交成功");
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
}

/** POST /api/order/refund/again/:id */
export async function refundAgain(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id <= 0) return jsonFail(c, "参数错误");
  try {
    return jsonOk(
      c,
      await new StoreOrderRefundService(c.get("container"), c.env).reapply(uid, id),
      "申请成功",
    );
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
}

/** GET /api/order/refund/del/:uni */
export async function refundDelete(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const identifier = c.req.param("uni") ?? "";
  if (!identifier) return jsonFail(c, "参数错误");
  try {
    await new StoreOrderRefundService(c.get("container"), c.env).deleteTerminal(uid, identifier);
    return jsonOk(c, null, "删除成功");
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
}
