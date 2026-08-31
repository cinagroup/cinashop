/**
 * 微信控制器 (M6)
 *
 * 对应 PHP app/controller/api/v1/wechat/Wechat.php + Routine.php
 *
 * 接口:
 *   POST /api/wechat/mp_auth        小程序登录
 *   POST /api/wechat/auth_binding_phone  小程序手机号解密绑定
 *   GET  /api/wechat/auth           公众号 OAuth 授权
 *   GET  /api/wechat/config         JS-SDK 配置签名
 */
import type { Context } from "hono";
import { jsonOk, jsonFail } from "@/utils/json";
import { ValidateException } from "@/utils/errors";
import { WechatAuthService } from "@/services/wechat/WechatAuthService";
import { WechatPayService } from "@/services/wechat/WechatPayService";
import { StoreOrderPayService } from "@/services/order/StoreOrderPayService";
import { StoreOrderRefundService } from "@/services/order/StoreOrderRefundService";
import {
  findMembershipOrderByOrderId,
  PaidMembershipService,
} from "@/services/user/PaidMembershipService";
import {
  findRechargeOrderByOrderId,
  RechargePaymentService,
} from "@/services/payment/RechargePaymentService";
import { clientIp } from "@/controllers/api/v1/UserBehaviorController";
import { readBoundedJsonObject } from "@/utils/request-body";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const MAX_SOCIAL_AUTH_BODY_BYTES = 8 * 1024;

/** POST /api/wechat/mp_auth — 小程序登录 */
export async function mpAuth(c: C) {
  const body = await readBoundedJsonObject(c.req.raw, MAX_SOCIAL_AUTH_BODY_BYTES);
  const code = String(body.code ?? "").trim();
  const spreadCandidate = Number(body.spread_spid ?? 0);
  const spreadUid = Number.isSafeInteger(spreadCandidate) && spreadCandidate > 0
    ? spreadCandidate
    : 0;
  if (!code) return jsonFail(c, "code 不能为空");
  const svc = new WechatAuthService(c.get("container"), c.env);
  try {
    const result = await svc.mpLogin({
      code,
      spreadUid,
      ip: clientIp(c),
    });
    return jsonOk(c, result, "登录成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/wechat/auth_binding_phone — 小程序手机号解密绑定 */
export async function authBindingPhone(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = await readBoundedJsonObject(c.req.raw, MAX_SOCIAL_AUTH_BODY_BYTES);
  const iv = String(body.iv ?? "");
  const encryptedData = String(body.encryptedData ?? "");
  if (!iv || !encryptedData) {
    return jsonFail(c, "参数错误");
  }
  const svc = new WechatAuthService(c.get("container"), c.env);
  try {
    const result = await svc.bindPhoneByCrypto({
      uid,
      iv,
      encryptedData,
    });
    return jsonOk(c, result, "绑定成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /api/wechat/auth — 公众号 OAuth 授权登录 */
export async function wechatAuth(c: C) {
  const code = c.req.query("code");
  if (!code) return jsonFail(c, "code 不能为空");
  const svc = new WechatAuthService(c.get("container"), c.env);
  try {
    const result = await svc.oauthLogin(code, clientIp(c), {
      state: c.req.query("state"),
      spreadUid: Number.parseInt(c.req.query("spread_spid") ?? "0", 10) || 0,
    });
    c.header("Cache-Control", "private, no-store, max-age=0");
    return jsonOk(c, result, "登录成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/wechat/oauth_state — create a one-time login-CSRF state. */
export async function wechatOauthState(c: C) {
  try {
    const result = await new WechatAuthService(c.get("container"), c.env)
      .createOauthState(clientIp(c));
    c.header("Cache-Control", "no-store, max-age=0");
    return jsonOk(c, {
      state: result.state,
      expires_in: result.expiresIn,
    });
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /api/wechat/config — JS-SDK 配置签名 */
export async function wechatConfig(c: C) {
  const url = c.req.query("url");
  if (!url) return jsonFail(c, "url 不能为空");
  const svc = new WechatAuthService(c.get("container"), c.env);
  try {
    const config = await svc.jsSdkConfig(url);
    return jsonOk(c, config);
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/**
 * ANY /api/pay/notify/wechat — 微信支付 V3 回调 (M6 升级: 直连验签)
 *
 * 流程:
 *   1. 读取原始 body + Wechatpay-* 头
 *   2. V3 验签 + AES-GCM 解密
 *   3. 调 paySuccess 标记订单已支付
 *   4. 返回 {"code":"SUCCESS"} (V3 规范)
 */
export async function wechatPayNotify(c: C) {
  const rawBody = await c.req.text();
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });

  const paySvc = new WechatPayService(c.get("container"), c.env);
  try {
    const notify = await paySvc.verifyAndParseNotify(headers, rawBody);
    if (notify.tradeState === "SUCCESS") {
      // 查订单 → paySuccess
      const container = c.get("container");
      const [order, membershipOrder, rechargeOrder] = await Promise.all([
        container.storeOrderDao.findByOrderId(notify.outTradeNo),
        findMembershipOrderByOrderId(container, notify.outTradeNo),
        findRechargeOrderByOrderId(container, notify.outTradeNo),
      ]);
      if ([order, membershipOrder, rechargeOrder].filter(Boolean).length !== 1) {
        throw new ValidateException("支付订单不存在或订单号存在跨域冲突");
      }
      const expectedTotal = Math.round(
        Number(order?.payPrice ?? membershipOrder?.payPrice ?? rechargeOrder?.price) * 100,
      );
      if (!Number.isSafeInteger(expectedTotal) || notify.amountTotal !== expectedTotal) {
        throw new ValidateException("微信支付回调金额不匹配");
      }
      if (rechargeOrder) {
        const rechargePaySvc = new RechargePaymentService(container, c.env);
        if (!(await rechargePaySvc.settleExternalPayment(
          notify.outTradeNo,
          "weixin",
          notify.transactionId,
          notify.amountTotal,
        ))) {
          throw new ValidateException("充值订单状态不允许支付入账");
        }
      } else if (membershipOrder) {
        const membershipPaySvc = new PaidMembershipService(container, c.env);
        if (!(await membershipPaySvc.settleExternalPayment(
          notify.outTradeNo,
          "weixin",
          notify.transactionId,
          notify.amountTotal,
        ))) {
          throw new ValidateException("会员订单状态不允许支付入账");
        }
      } else if (order && !order.paid) {
        const orderPaySvc = new StoreOrderPayService(container, c.env);
        if (!(await orderPaySvc.paySuccess(order.id, "weixin", notify.transactionId))) {
          throw new ValidateException("订单状态不允许支付入账");
        }
      } else if (order && (order.payType !== "weixin" || order.tradeNo !== notify.transactionId)) {
        throw new ValidateException("微信支付回调与已入账交易不匹配");
      }
    }
    emitOperationalEvent("info", {
      event: "payment_callback_completed",
      component: "payment",
      operation: "wechat_callback",
      outcome: "success",
    });
    return c.json({ code: "SUCCESS", message: "成功" });
  } catch (e) {
    emitOperationalEvent("warn", {
      event: "payment_callback_rejected",
      component: "payment",
      operation: "wechat_callback",
      outcome: "rejected",
      errorCode: operationalErrorCode(e),
    });
    return c.json({ code: "FAIL", message: e instanceof Error ? e.message : "验签失败" }, 400);
  }
}

/** POST /api/pay/notify/wechat/refund — 微信退款结果回调。 */
export async function wechatRefundNotify(c: C) {
  const rawBody = await c.req.text();
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  try {
    const payService = new WechatPayService(c.get("container"), c.env);
    const notification = await payService.verifyAndParseRefundNotify(headers, rawBody);
    const refundService = new StoreOrderRefundService(c.get("container"), c.env);
    await refundService.handleWechatRefundNotification(notification);
    emitOperationalEvent("info", {
      event: "refund_callback_completed",
      component: "refund",
      operation: "wechat_callback",
      outcome: "success",
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    emitOperationalEvent("warn", {
      event: "refund_callback_rejected",
      component: "refund",
      operation: "wechat_callback",
      outcome: "rejected",
      errorCode: operationalErrorCode(error),
    });
    return c.json(
      { code: "FAIL", message: error instanceof Error ? error.message : "验签失败" },
      400,
    );
  }
}

/**
 * POST /api/order/wechat_pay — backwards-compatible WeChat payment alias.
 * Client-supplied openid is intentionally ignored; identity is server-resolved.
 */
export async function wechatPayOrder(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    orderId?: string;
    from?: string;
  };
  if (!body.orderId) return jsonFail(c, "参数错误");
  try {
    const result = await new StoreOrderPayService(c.get("container"), c.env).pay(
      uid,
      body.orderId,
      "weixin",
      body.from ?? c.req.header("Form-type") ?? "h5",
      clientIp(c),
    );
    return jsonOk(c, result);
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}
