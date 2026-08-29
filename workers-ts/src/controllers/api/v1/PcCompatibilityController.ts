import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { PcCompatibilityService } from "@/services/pc/PcCompatibilityService";
import { ScanLoginService } from "@/services/auth/ScanLoginService";
import {
  clearOauthBrowserVerifier,
  oauthBrowserVerifier,
  setOauthBrowserVerifier,
} from "@/services/auth/OauthBrowserCookie";
import { allowlistedAuthRequest } from "@/services/auth/TrustedAuthClient";
import { WechatOpenWebAuthService } from "@/services/wechat/WechatOpenWebAuthService";
import type { GoodsListParams } from "@/services/product/StoreProductService";
import { ValidateException } from "@/utils/errors";
import { jsonFail, jsonOk } from "@/utils/json";
import { orderRefundCartInfoList } from "@/controllers/api/v1/OrderController";

type C = Context<{
  Bindings: Env;
  Variables: AppVariables & { container: import("@/lib/di").Container };
}>;

function service(c: C) {
  c.header("Cache-Control", "private, no-store");
  return new PcCompatibilityService(c.get("container"), c.env);
}

function clientIp(c: C): string {
  return (
    c.req.header("CF-Connecting-IP")
    ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim()
    ?? c.req.header("X-Real-IP")
    ?? "0.0.0.0"
  ).slice(0, 128);
}

function scanService(c: C) {
  c.header("Cache-Control", "no-store, max-age=0");
  c.header("Referrer-Policy", "no-referrer");
  return new ScanLoginService(c.get("container"), c.env);
}

/** Create a QR key plus a browser-only poll secret. */
export async function key(c: C) {
  return jsonOk(c, await scanService(c).create(
    "pc_user",
    allowlistedAuthRequest(c.req.raw, c.env, "pc_user"),
    clientIp(c),
  ));
}

/** Polling never accepts the bearer-equivalent secret in the URL. */
export async function scan(c: C) {
  return jsonOk(c, await scanService(c).poll(
    "pc_user",
    c.req.param("key"),
    c.req.header("X-Scan-Poll-Token"),
    clientIp(c),
  ));
}

export async function oauthState(c: C) {
  c.header("Cache-Control", "no-store, max-age=0");
  c.header("Referrer-Policy", "no-referrer");
  const client = allowlistedAuthRequest(c.req.raw, c.env, "pc_user");
  const result = await new WechatOpenWebAuthService(c.get("container"), c.env)
    .createOauthState("pc_user", clientIp(c), client.origin);
  setOauthBrowserVerifier(c, "pc_user", result.state, result.verifier, result.expiresIn);
  return jsonOk(c, { state: result.state, expires_in: result.expiresIn });
}

/** Open-platform callback requires a one-time, audience/browser-bound state. */
export async function wechatAuth(c: C) {
  c.header("Cache-Control", "no-store, max-age=0");
  c.header("Referrer-Policy", "no-referrer");
  const state = c.req.query("state") ?? "";
  const result = await new WechatOpenWebAuthService(c.get("container"), c.env)
    .login(
      "pc_user",
      c.req.query("code"),
      state,
      oauthBrowserVerifier(c, "pc_user", state),
      clientIp(c),
    );
  clearOauthBrowserVerifier(c, "pc_user", state);
  return jsonOk(c, result, "登录成功");
}

export async function getAppid(c: C) {
  return jsonOk(c, await service(c).appId());
}

export async function getPayVipCode(c: C) {
  return jsonOk(c, await service(c).payVipCode());
}

export async function getProductPhoneBuy(c: C) {
  return jsonOk(c, await service(c).productPhoneBuy());
}

export async function getBanner(c: C) {
  return jsonOk(c, await service(c).banner());
}

export async function getCategoryProduct(c: C) {
  return jsonOk(c, await service(c).categoryProducts(
    c.get("uid") ?? 0,
    c.req.query("page"),
    c.req.query("limit"),
  ));
}

export async function getProducts(c: C) {
  const query = c.req.query();
  const params: GoodsListParams = {
    sid: query.sid ? Number(query.sid) : undefined,
    cid: query.cid ? Number(query.cid) : undefined,
    tid: query.tid ? Number(query.tid) : undefined,
    store_name: query.keyword || query.store_name,
    priceOrder: (query.priceOrder as "" | "asc" | "desc") || "",
    salesOrder: (query.salesOrder as "" | "asc" | "desc") || "",
    news: query.news ? Number(query.news) : undefined,
    type: query.type,
    ids: query.ids,
    selectId: query.selectId ? Number(query.selectId) : undefined,
    brand_id: query.brand_id,
    page: query.page ? Number(query.page) : 1,
    limit: query.limit ? Number(query.limit) : undefined,
  };
  return jsonOk(c, await service(c).productList(c.get("uid") ?? 0, params));
}

export async function getProductCode(c: C) {
  const productId = Number(c.req.param("product_id"));
  if (!Number.isSafeInteger(productId) || productId <= 0) return jsonFail(c, "商品ID错误");
  return jsonOk(c, await service(c).productCode(productId));
}

export async function getCity(c: C) {
  const pid = Number(c.req.param("pid"));
  if (!Number.isSafeInteger(pid) || pid < 0) return jsonFail(c, "城市ID错误");
  return jsonOk(c, await service(c).city(pid));
}

export async function checkOrderStatus(c: C) {
  const endTime = Number(c.req.param("end_time"));
  if (!Number.isFinite(endTime)) return jsonFail(c, "截止时间错误");
  return jsonOk(c, await service(c).orderStatus(c.req.param("order_id") ?? "", endTime));
}

export async function getCompanyInfo(c: C) {
  return jsonOk(c, await service(c).companyInfo());
}

export async function getRecommend(c: C) {
  return jsonOk(c, await service(c).recommend(
    c.get("uid") ?? 0,
    Number(c.req.param("type")),
    c.req.query("page"),
    c.req.query("limit"),
  ));
}

export async function getWechatQrcode(c: C) {
  return jsonOk(c, await service(c).wechatQrcode());
}

export async function getGoodProduct(c: C) {
  return jsonOk(c, await service(c).goodProducts(c.get("uid") ?? 0));
}

export async function getCartList(c: C) {
  return jsonOk(c, await service(c).cartList(c.get("uid")));
}

export async function getBalanceRecord(c: C) {
  const type = Number(c.req.param("type"));
  const query = c.req.query();
  return jsonOk(c, await service(c).balanceRecord(c.get("uid"), type, query));
}

export async function getOrderList(c: C) {
  try {
    return jsonOk(c, await service(c).orderList(c.get("uid"), c.req.query()));
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
}

export async function getCollectList(c: C) {
  return jsonOk(c, await service(c).collectList(
    c.get("uid"),
    c.req.query("page"),
    c.req.query("limit"),
  ));
}

export async function refundList(c: C) {
  return jsonOk(c, await service(c).refundList(
    c.get("uid"),
    c.req.query("refund_type"),
    c.req.query("page"),
    c.req.query("limit"),
  ));
}

export async function refundCartInfoList(c: C) {
  c.header("Cache-Control", "private, no-store");
  return orderRefundCartInfoList(c);
}
