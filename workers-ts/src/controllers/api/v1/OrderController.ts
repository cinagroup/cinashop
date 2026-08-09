/**
 * 购物车 + 订单控制器
 *
 * 对应 PHP app/controller/api/v1/order/StoreCart.php + StoreOrder.php
 */
import type { Context } from "hono";
import { jsonOk, jsonFail } from "@/utils/json";
import { ValidateException } from "@/utils/errors";
import { StoreCartService } from "@/services/order/StoreCartService";
import { StoreOrderCreateService } from "@/services/order/StoreOrderCreateService";
import { ExpressService } from "@/services/order/ExpressService";
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function clientIp(c: C): string {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0].trim() ??
    "0.0.0.0"
  );
}

// ─── 购物车 ──────────────────────────────────────────────────

/** POST /api/cart/add */
export async function cartAdd(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    productId?: number;
    unique?: string;
    cartNum?: number;
    type?: number;
    isNew?: number;
  };
  if (!body.productId || !body.unique) return jsonFail(c, "参数错误");

  const svc = new StoreCartService(c.get("container"));
  try {
    const result = await svc.add({
      uid,
      productId: Number(body.productId),
      unique: body.unique,
      cartNum: Number(body.cartNum ?? 1),
      type: body.type ?? 0,
      isNew: body.isNew ?? 0,
    });
    return jsonOk(c, result, "加入购物车成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /api/cart/list */
export async function cartList(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new StoreCartService(c.get("container"));
  const list = await svc.list(uid);
  return jsonOk(c, list);
}

/** POST /api/cart/num */
export async function cartNum(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number;
    cartNum?: number;
  };
  if (!body.id) return jsonFail(c, "参数错误");
  const svc = new StoreCartService(c.get("container"));
  try {
    await svc.setNum(uid, Number(body.id), Number(body.cartNum ?? 1));
    return jsonOk(c, null, "修改成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/cart/del */
export async function cartDel(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as { ids?: number[] };
  if (!body.ids?.length) return jsonFail(c, "参数错误");
  const svc = new StoreCartService(c.get("container"));
  await svc.del(uid, body.ids);
  return jsonOk(c, null, "删除成功");
}

/** GET /api/cart/count */
export async function cartCount(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonOk(c, { count: 0 });
  const svc = new StoreCartService(c.get("container"));
  const count = await svc.count(uid);
  return jsonOk(c, { count });
}

// ─── 订单 ────────────────────────────────────────────────────

/** POST /api/order/create/:key */
export async function orderCreate(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const key = c.req.param("key");
  if (!key) return jsonFail(c, "参数错误");

  const body = (await c.req.json().catch(() => ({}))) as {
    cartIds?: number[];
    realName?: string;
    userPhone?: string;
    province?: string;
    userAddress?: string;
    mark?: string;
    shippingType?: number;
    useIntegral?: number;
    /** M17: 活动下单参数 */
    type?: number;
    pinkId?: number;
    combinationId?: number;
    seckillId?: number;
    bargainUserId?: number;
    couponId?: number;
  };
  if (!body.cartIds?.length) return jsonFail(c, "请选择要购买的商品");

  const svc = new StoreOrderCreateService(c.get("container"), c.env);
  try {
    const result = await svc.createOrder({
      uid,
      key,
      cartIds: body.cartIds,
      realName: body.realName,
      userPhone: body.userPhone,
      province: body.province,
      userAddress: body.userAddress,
      mark: body.mark,
      shippingType: body.shippingType,
      useIntegral: body.useIntegral,
      userIp: clientIp(c),
      type: body.type,
      pinkId: body.pinkId,
      combinationId: body.combinationId,
      seckillId: body.seckillId,
      bargainUserId: body.bargainUserId,
      couponId: body.couponId,
    });
    return jsonOk(c, result, "订单创建成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /api/order/list */
export async function orderList(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const q = c.req.query();
  const svc = new StoreOrderCreateService(c.get("container"), c.env);
  const list = await svc.list(uid, {
    type: q.type !== undefined ? Number(q.type) : undefined,
    page: q.page ? Number(q.page) : 1,
    limit: q.limit ? Number(q.limit) : 10,
  });
  return jsonOk(c, list);
}

/** GET /api/order/detail/:uni */
export async function orderDetail(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const orderId = c.req.param("uni");
  if (!orderId) return jsonFail(c, "参数错误");
  const svc = new StoreOrderCreateService(c.get("container"), c.env);
  const detail = await svc.detail(uid, orderId);
  return jsonOk(c, detail);
}

// ═══ 订单操作 (补全) ═══════════════════════════════════════

/** POST /api/order/take — 确认收货 */
export async function orderTake(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as { order_id?: string };
  const svc = new StoreOrderCreateService(c.get("container"), c.env);
  try {
    await svc.take(uid, body.order_id ?? "");
    return jsonOk(c, null, "已确认收货");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/order/cancel — 取消订单 */
export async function orderCancel(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as { order_id?: string };
  const svc = new StoreOrderCreateService(c.get("container"), c.env);
  try {
    await svc.cancel(uid, body.order_id ?? "");
    return jsonOk(c, null, "已取消");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/order/del — 删除订单 */
export async function orderDel(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as { order_id?: string };
  const svc = new StoreOrderCreateService(c.get("container"), c.env);
  await svc.del(uid, body.order_id ?? "");
  return jsonOk(c, null, "已删除");
}

/** POST /api/order/again — 再次购买 */
export async function orderAgain(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as { order_id?: string };
  const svc = new StoreOrderCreateService(c.get("container"), c.env);
  try {
    const result = await svc.again(uid, body.order_id ?? "");
    return jsonOk(c, result, "已加入购物车");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /api/order/express/:orderId — 物流查询 */
export async function orderExpress(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const orderId = c.req.param("orderId") ?? "";
  const svc = new ExpressService(c.get("container"));
  try {
    const result = await svc.query(uid, orderId);
    return jsonOk(c, result);
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}
