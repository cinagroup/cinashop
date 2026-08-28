import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { PcCompatibilityService } from "@/services/pc/PcCompatibilityService";
import type { GoodsListParams } from "@/services/product/StoreProductService";
import { ValidateException } from "@/utils/errors";
import { jsonFail, jsonOk, jsonRaw } from "@/utils/json";
import { orderRefundCartInfoList } from "@/controllers/api/v1/OrderController";

type C = Context<{
  Bindings: Env;
  Variables: AppVariables & { container: import("@/lib/di").Container };
}>;

function service(c: C) {
  c.header("Cache-Control", "private, no-store");
  return new PcCompatibilityService(c.get("container"), c.env);
}

function unavailable(c: C, message: string) {
  c.header("Cache-Control", "no-store");
  return jsonRaw(c, 501, message, { replacement: "/api/login" });
}

/** The PHP key was a bearer-equivalent cache key and is intentionally not recreated. */
export function keyUnavailable(c: C) {
  return unavailable(c, "PC 扫码登录挑战尚未安全迁移");
}

/** The PHP poll endpoint accepted an unbound caller key and could mint a token. */
export function scanUnavailable(c: C) {
  return unavailable(c, "PC 扫码登录轮询尚未安全迁移");
}

/** The old OAuth callback did not validate a one-time state and is login-CSRF prone. */
export function wechatAuthUnavailable(c: C) {
  return unavailable(c, "PC 微信 OAuth 需先完成一次性 state 挑战迁移");
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
