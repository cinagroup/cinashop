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
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

/** POST /api/wechat/mp_auth — 小程序登录 */
export async function mpAuth(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    code?: string;
    spread_spid?: number;
  };
  if (!body.code) return jsonFail(c, "code 不能为空");
  const svc = new WechatAuthService(c.get("container"), c.env);
  try {
    const result = await svc.mpLogin({ code: body.code, spreadUid: body.spread_spid });
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
  const body = (await c.req.json().catch(() => ({}))) as {
    openid?: string;
    iv?: string;
    encryptedData?: string;
  };
  if (!body.openid || !body.iv || !body.encryptedData) {
    return jsonFail(c, "参数错误");
  }
  const svc = new WechatAuthService(c.get("container"), c.env);
  try {
    const result = await svc.bindPhoneByCrypto({
      openid: body.openid,
      iv: body.iv,
      encryptedData: body.encryptedData,
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
    const result = await svc.oauthLogin(code);
    return jsonOk(c, result, "登录成功");
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
      const order = await c.get("container").storeOrderDao.findByOrderId(notify.outTradeNo);
      if (order && !order.paid) {
        const orderPaySvc = new StoreOrderPayService(c.get("container"), c.env);
        await orderPaySvc.paySuccess(order.id, "weixin", notify.transactionId);
      }
    }
    return c.json({ code: "SUCCESS", message: "成功" });
  } catch (e) {
    console.error("[wechatPayNotify]", e instanceof Error ? e.message : e);
    return c.json({ code: "FAIL", message: e instanceof Error ? e.message : "验签失败" }, 400);
  }
}

/**
 * POST /api/order/wechat_pay — 微信支付下单 (JSAPI)
 * body: { orderId, openid }
 */
export async function wechatPayOrder(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    orderId?: string;
    openid?: string;
  };
  if (!body.orderId || !body.openid) return jsonFail(c, "参数错误");

  const container = c.get("container");
  const order = await container.storeOrderDao.findByOrderId(body.orderId);
  if (!order || order.uid !== uid) return jsonFail(c, "订单不存在");
  if (order.paid) return jsonFail(c, "订单已支付");

  const paySvc = new WechatPayService(container, c.env);
  try {
    const result = await paySvc.createOrder({
      type: "jsapi",
      outTradeNo: body.orderId,
      description: order.mark || `订单 ${body.orderId}`,
      amount: Number(order.payPrice),
      openid: body.openid,
      attach: "product",
    });
    return jsonOk(c, result);
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}
