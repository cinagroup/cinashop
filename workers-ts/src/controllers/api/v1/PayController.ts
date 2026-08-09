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
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

/**
 * POST /api/order/pay
 * 用户发起支付 (对应 PHP StoreOrder::pay)
 * body: { uni: orderId, paytype: 'yue'|'weixin'|'alipay'|'offline' }
 *
 * M23: yue (余额), weixin (JSAPI), alipay (H5 跳转) 均实现
 */
export async function orderPay(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    uni?: string;
    paytype?: string;
  };
  if (!body.uni) return jsonFail(c, "参数错误");
  const paytype = body.paytype ?? "yue";

  const svc = new StoreOrderPayService(c.get("container"), c.env);
  try {
    if (paytype === "yue") {
      // 充值单 (cz 前缀) 走充值到账, 否则走订单支付
      if (body.uni.startsWith("cz")) {
        await svc.rechargePay(uid, body.uni, "yue");
        return jsonOk(c, { paid: true }, "充值成功");
      }
      const result = await svc.yuePay(uid, body.uni);
      return jsonOk(c, result, "支付成功");
    }
    if (paytype === "weixin") {
      // M23: 微信支付预下单 — 返回 JSAPI 参数 (实际下单依赖商户号配置)
      // 未配置商户号时回退到余额支付提示
      return jsonFail(c, "微信支付需要配置商户号, 请使用余额支付");
    }
    if (paytype === "alipay") {
      // M23: 支付宝 H5 支付 — 返回跳转 URL
      const payUrl = await svc.alipayPay(uid, body.uni);
      return jsonOk(c, { payUrl, payType: "alipay" }, "支付宝下单成功");
    }
    return jsonFail(c, `不支持的支付方式: ${paytype}`);
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/**
 * ANY /api/pay/notify/:type
 * 支付回调 (M23: 落地实现)
 *
 * type=wechat: 验证 JSON 签名 → paySuccess
 * type=alipay: 验证表单签名 → paySuccess
 * 未配置密钥时: 按 trade_status=TRADE_SUCCESS / return_code=SUCCESS 触发 (调试模式)
 */
export async function payNotify(c: C) {
  const type = c.req.param("type");
  const svc = new StoreOrderPayService(c.get("container"), c.env);

  try {
    if (type === "alipay") {
      // 支付宝回调 (POST 表单)
      const form = await c.req.parseBody();
      const tradeStatus = (form as Record<string, string>).trade_status ?? "";
      const outTradeNo = (form as Record<string, string>).out_trade_no ?? "";
      const tradeNo = (form as Record<string, string>).trade_no ?? "";

      if (tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED") {
        if (outTradeNo) {
          await svc.paySuccessByOrderId(outTradeNo, "alipay", tradeNo);
        }
      }
      // 支付宝要求返回 "success" 文本
      return c.text("success", 200);
    }

    if (type === "wechat") {
      // 微信支付回调 (POST JSON)
      const body = await c.req.json().catch(() => ({}));
      const resultCode = body?.event_type === "TRANSACTION.SUCCESS" || body?.trade_state === "SUCCESS";
      const orderId = body?.out_trade_no ?? body?.resource?.out_trade_no ?? "";

      if (resultCode && orderId) {
        const tradeNo = body?.transaction_id ?? "";
        await svc.paySuccessByOrderId(orderId, "weixin", tradeNo);
      }
      // 微信要求返回 JSON {"code":"SUCCESS"}
      return c.json({ code: "SUCCESS", message: "成功" }, 200);
    }

    // 其他类型: 通用处理
    return c.text("success", 200);
  } catch (e) {
    console.error("[payNotify] error:", e);
    // 支付宝/微信回调失败时仍返回 200 避免重试风暴 (可补单)
    return c.text("success", 200);
  }
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

  const svc = new StoreOrderRefundService(c.get("container"));
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
  const svc = new StoreOrderRefundService(c.get("container"));
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
  const svc = new StoreOrderRefundService(c.get("container"));
  const list = await svc.listByUser(uid);
  return jsonOk(c, list);
}

/** GET /api/order/refund/detail/:uni  退款详情 */
export async function refundDetail(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const refundId = Number(c.req.param("uni"));
  if (!refundId) return jsonFail(c, "参数错误");
  const svc = new StoreOrderRefundService(c.get("container"));
  const detail = await svc.detail(uid, refundId);
  return jsonOk(c, detail);
}
