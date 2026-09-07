import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { jsonOk } from "@/utils/json";
import { ValidateException } from "@/utils/errors";
import { StoreOrderCreateService } from "@/services/order/StoreOrderCreateService";
import type { OrderCouponQuery } from "@/services/activity/OrderCouponService";

export function parseOrderCouponRequest(query: Record<string, string | undefined>) {
  const integer = (value: string | undefined, fallback: number, min: number, max: number) => {
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value)) throw new ValidateException("订单优惠券参数无效");
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) throw new ValidateException("订单优惠券参数无效");
    return number;
  };
  if (!query.cartId || query.cartId.length > 3200) throw new ValidateException("请选择要购买的商品");
  const rawIds = query.cartId.split(",");
  if (rawIds.length > 200) throw new ValidateException("单次下单商品不能超过200项");
  const cartIds = rawIds.map((value) => integer(value, 0, 1, Number.MAX_SAFE_INTEGER));
  if (new Set(cartIds).size !== cartIds.length) throw new ValidateException("购物车参数包含重复项");
  const unpaged = query.limit === undefined && query.before === undefined;
  if (query.page !== undefined && query.page !== "1") throw new ValidateException("订单优惠券请使用limit/before分页");
  const couponQuery: OrderCouponQuery = { unpaged, limit: unpaged ? 1000 : integer(query.limit, 20, 1, 100), before: integer(query.before, 0, 0, Number.MAX_SAFE_INTEGER) };
  return { cartIds, isNew: integer(query.new, 0, 0, 1), shippingType: integer(query.shipping_type, 1, 1, 2),
    storeId: integer(query.store_id, 0, 0, Number.MAX_SAFE_INTEGER), couponQuery };
}

/** PHP /coupons/order/:price uses owner cartId/new; the path price is never trusted or used. */
export async function orderCoupons(c: Context<{ Bindings: Env; Variables: AppVariables }>) {
  c.header("Cache-Control", "private, no-store");
  const uid = c.get("uid");
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("请先登录");
  const input = parseOrderCouponRequest(c.req.query());
  const container = c.get("container");
  const carts = await container.storeCartDao.getByIds(input.cartIds);
  if (carts.length !== input.cartIds.length || carts.some((cart) => cart.uid !== uid || cart.staffId !== 0 || cart.touristUid !== ""
    || cart.isNew !== input.isNew || cart.isPay !== 0 || cart.isDel !== 0 || cart.status !== 1 || cart.cartNum <= 0)) {
    throw new ValidateException("购物车商品已失效或不属于当前购买方式");
  }
  if (carts.some((cart) => cart.type !== carts[0]!.type)) throw new ValidateException("购物车活动类型不一致");
  // Marketing orders do not stack normal coupons. Do not invoke provider/creation paths to discover that fact.
  if (carts[0]!.type !== 0) return jsonOk(c, []);
  const quote = await new StoreOrderCreateService(container, c.env).quoteOrder({
    uid, cartIds: input.cartIds, shippingType: input.shippingType, storeId: input.storeId, type: 0, couponId: 0,
  }, input.couponQuery);
  if (!quote.couponPage) throw new Error("订单优惠券报价结果不完整");
  c.header("X-Coupon-Next-Cursor", quote.couponPage.nextCursor === null ? "" : String(quote.couponPage.nextCursor));
  return jsonOk(c, quote.couponPage.list);
}
