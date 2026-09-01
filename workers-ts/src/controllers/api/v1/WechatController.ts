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
 *   ANY  /api/wechat/serve          公众号安全模式消息回调
 *   ANY  /api/wechat/miniServe      小程序安全模式消息回调
 */
import type { Context } from "hono";
import { jsonOk, jsonFail } from "@/utils/json";
import { ValidateException } from "@/utils/errors";
import { WechatAuthService } from "@/services/wechat/WechatAuthService";
import {
  WechatPayService,
  type WechatPayProfile,
} from "@/services/wechat/WechatPayService";
import { StoreOrderPayService } from "@/services/order/StoreOrderPayService";
import { StoreOrderRefundService } from "@/services/order/StoreOrderRefundService";
import { PaymentCallbackEventService } from "@/services/payment/PaymentCallbackEventService";
import { WechatCallbackService } from "@/services/wechat/WechatCallbackService";
import type { WechatCallbackQuery, WechatCallbackSource } from "@/services/wechat/WechatCallbackCrypto";
import { clientIp } from "@/controllers/api/v1/UserBehaviorController";
import { readBoundedJsonObject, readBoundedUtf8Text } from "@/utils/request-body";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const MAX_SOCIAL_AUTH_BODY_BYTES = 8 * 1024;
const MAX_PAYMENT_CALLBACK_BODY_BYTES = 64 * 1024;
const MAX_WECHAT_CALLBACK_BODY_BYTES = 64 * 1024;

function callbackQuery(c: C): WechatCallbackQuery {
  return {
    signature: c.req.query("signature") ?? "",
    msgSignature: c.req.query("msg_signature") ?? "",
    timestamp: c.req.query("timestamp") ?? "",
    nonce: c.req.query("nonce") ?? "",
  };
}

async function callbackServe(c: C, source: WechatCallbackSource): Promise<Response> {
  c.header("Cache-Control", "no-store, max-age=0");
  const service = new WechatCallbackService(c.get("container"), c.env);
  try {
    if (c.req.method === "GET") {
      const echo = c.req.query("echostr") ?? "";
      const verified = await service.verifyChallenge(source, callbackQuery(c), echo);
      return c.text(verified, 200, { "Content-Type": "text/plain; charset=utf-8" });
    }
    if (c.req.method !== "POST") {
      c.header("Allow", "GET, POST");
      return c.text("method not allowed", 405);
    }
    const contentType = (c.req.header("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/xml" && contentType !== "text/xml") {
      return c.text("unsupported media type", 415);
    }
    const rawBody = await readBoundedUtf8Text(c.req.raw, MAX_WECHAT_CALLBACK_BODY_BYTES);
    const received = await service.receiveEncrypted(source, callbackQuery(c), rawBody);
    c.executionCtx.waitUntil(service.dispatchById(received.outboxId).catch((error) => {
      emitOperationalEvent("error", {
        event: "wechat_callback_outbox_dispatch_failed",
        component: "queue",
        operation: "wechat_callback_dispatch",
        outcome: "failure",
        errorCode: operationalErrorCode(error, "callback_dispatch_failed"),
      });
    }));
    emitOperationalEvent("info", {
      event: "wechat_callback_persisted",
      component: "queue",
      operation: "wechat_callback_receive",
      outcome: "success",
      result: received.duplicate ? "duplicate-persisted" : "persisted",
      source,
    });
    return c.text(received.responseBody, 200, {
      "Content-Type": received.responseBody.startsWith("<xml>")
        ? "application/xml; charset=utf-8"
        : "text/plain; charset=utf-8",
    });
  } catch (error) {
    emitOperationalEvent("warn", {
      event: "wechat_callback_rejected",
      component: "queue",
      operation: "wechat_callback_receive",
      outcome: "rejected",
      source,
      errorCode: operationalErrorCode(error),
    });
    // Never acknowledge a callback whose authentication, decryption or durable
    // persistence failed. WeChat can safely retry the same immutable event.
    return c.text("callback rejected", 400);
  }
}

export function callbackServeOfficial(c: C): Promise<Response> {
  return callbackServe(c, "official");
}

export function callbackServeMini(c: C): Promise<Response> {
  return callbackServe(c, "mini");
}

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
 *   3. 短事务写入事件账本 + Queue outbox
 *   4. 立即返回 {"code":"SUCCESS"}；幂等入账由 Queue 消费者完成
 */
export async function wechatPayNotify(c: C, profile: WechatPayProfile = "wechat") {
  try {
    const rawBody = await readBoundedUtf8Text(c.req.raw, MAX_PAYMENT_CALLBACK_BODY_BYTES);
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const paySvc = new WechatPayService(c.get("container"), c.env);
    const notify = await paySvc.verifyAndParseNotify(headers, rawBody, profile);
    const callbackService = new PaymentCallbackEventService(c.get("container"), c.env);
    const received = await callbackService.receive({
      provider: "wechat",
      profile,
      providerEventId: notify.eventId,
      orderNo: notify.outTradeNo,
      transactionId: notify.transactionId,
      tradeState: notify.tradeState,
      amountCents: notify.amountTotal,
      currency: "CNY",
      providerEventTime: notify.providerEventTime,
    });
    if (!received.terminalConflict) {
      c.executionCtx.waitUntil(callbackService.dispatchById(received.outboxId).catch((error) => {
        emitOperationalEvent("error", {
          event: "payment_callback_failed",
          component: "queue",
          operation: "wechat_callback_dispatch",
          outcome: "failure",
          errorCode: operationalErrorCode(error, "callback_dispatch_failed"),
        });
      }));
    }
    emitOperationalEvent("info", {
      event: "payment_callback_persisted",
      component: "payment",
      operation: "wechat_callback",
      outcome: "success",
      result: received.duplicate ? "duplicate-persisted" : "persisted",
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
    return c.json({ code: "FAIL", message: "验签或持久化失败" }, 400);
  }
}

/** POST /api/pay/notify/wechat/refund — 微信退款结果回调。 */
export async function wechatRefundNotify(c: C) {
  try {
    const rawBody = await readBoundedUtf8Text(c.req.raw, MAX_PAYMENT_CALLBACK_BODY_BYTES);
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
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
