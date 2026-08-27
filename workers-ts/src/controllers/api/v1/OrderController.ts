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
import { StoreOrderInvoiceService } from "@/services/order/StoreOrderInvoiceService";
import { StoreDeliveryOrderService } from "@/services/order/StoreDeliveryOrderService";
import { ExpressService } from "@/services/order/ExpressService";
import { StoreIntegralOrderService } from "@/services/activity/StoreIntegralOrderService";
import { SystemMetadataService } from "@/services/system/SystemMetadataService";
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const MAX_CART_BODY_BYTES = 64 * 1024;

async function readBoundedJsonObject(c: C): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_CART_BODY_BYTES) {
    throw new ValidateException("请求体过大");
  }
  const stream = c.req.raw.body;
  if (!stream) return {};
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_CART_BODY_BYTES) {
      await reader.cancel("request body too large");
      throw new ValidateException("请求体过大");
    }
    chunks.push(next.value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(merged)) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ValidateException("JSON请求体无效");
  }
}

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
  try {
    const body = await readBoundedJsonObject(c) as {
      productId?: number;
      unique?: string;
      cartNum?: number;
      type?: number;
      isNew?: number;
      activityId?: number;
      activity_id?: number;
      discountId?: number;
      discount_id?: number;
      discountInfos?: unknown[];
      discount_infos?: unknown[];
    };
    const svc = new StoreCartService(c.get("container"), c.env);
    const discountId = Number(body.discountId ?? body.discount_id ?? 0);
    const discountInfos = body.discountInfos ?? body.discount_infos;
    if (Number(body.type ?? 0) === 5 || discountId > 0 || Array.isArray(discountInfos)) {
      if (!Number.isSafeInteger(discountId) || discountId <= 0 || !Array.isArray(discountInfos)) {
        return jsonFail(c, "套餐参数错误");
      }
      const selections = discountInfos.map((item) => {
        const row = item !== null && typeof item === "object"
          ? item as Record<string, unknown>
          : {};
        return {
          entryId: Number(row.id ?? row.entryId ?? row.entry_id ?? 0),
          productId: Number(row.productId ?? row.product_id ?? 0),
          unique: String(row.unique ?? ""),
        };
      });
      const result = await svc.addDiscountPackage({ uid, discountId, selections });
      return jsonOk(c, result, "套餐已加入结算");
    }
    if (!body.productId || !body.unique) return jsonFail(c, "参数错误");
    const result = await svc.add({
      uid,
      productId: Number(body.productId),
      unique: body.unique,
      cartNum: Number(body.cartNum ?? 1),
      type: Number(body.type ?? 0),
      isNew: body.isNew ?? 0,
      activityId: Number(body.activityId ?? body.activity_id ?? 0),
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
    cityId?: number;
    city_id?: number;
    userAddress?: string;
    mark?: string;
    shippingType?: number;
    shipping_type?: number;
    storeId?: number;
    store_id?: number;
    useIntegral?: number;
    /** M17: 活动下单参数 */
    type?: number;
    pinkId?: number;
    combinationId?: number;
    seckillId?: number;
    bargainUserId?: number;
    couponId?: number;
    customForm?: unknown;
    custom_form?: unknown;
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
      cityId: body.cityId ?? body.city_id,
      userAddress: body.userAddress,
      mark: body.mark,
      shippingType: body.shippingType ?? body.shipping_type,
      storeId: body.storeId ?? body.store_id,
      useIntegral: body.useIntegral,
      userIp: clientIp(c),
      type: body.type,
      pinkId: body.pinkId,
      combinationId: body.combinationId,
      seckillId: body.seckillId,
      bargainUserId: body.bargainUserId,
      couponId: body.couponId,
      customForm: body.customForm ?? body.custom_form,
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
    status: q.status !== undefined ? Number(q.status) : undefined,
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

/** POST /api/order/first_order_quote — 服务端只读首单报价，建单时仍会事务内复核。 */
export async function orderFirstOrderQuote(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as { cartIds?: number[] };
  if (!Array.isArray(body.cartIds) || !body.cartIds.length) {
    return jsonFail(c, "请选择要购买的商品");
  }
  try {
    const quote = await new StoreCartService(c.get("container"), c.env)
      .quoteFirstOrder(uid, body.cartIds.map(Number), c.env);
    return jsonOk(c, quote);
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
}

/** GET /api/order/system_form/:id — 结算页读取启用中的系统表单模板。 */
export async function orderSystemForm(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id <= 0) return jsonFail(c, "系统表单ID错误");
  return jsonOk(c, await new SystemMetadataService(c.get("container")).formInfo(id, false, true));
}

/** GET /api/store_integral/order/list — PHP unified integral-order compatibility. */
export async function integralOrderList(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const service = new StoreIntegralOrderService(c.get("container"), c.env);
  return jsonOk(
    c,
    await service.userList(
      uid,
      Number(c.req.query("page") ?? 1),
      Number(c.req.query("limit") ?? 10),
    ),
  );
}

/** GET /api/store_integral/order/detail/:uni */
export async function integralOrderDetail(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const orderId = c.req.param("uni");
  if (!orderId) return jsonFail(c, "参数错误");
  const service = new StoreIntegralOrderService(c.get("container"), c.env);
  return jsonOk(c, await service.userDetail(uid, orderId));
}

/** POST /api/store_integral/order/del */
export async function integralOrderDel(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as { order_id?: string; orderId?: string };
  const orderId = String(body.order_id ?? body.orderId ?? "").trim();
  if (!orderId) return jsonFail(c, "参数错误");
  const service = new StoreIntegralOrderService(c.get("container"), c.env);
  try {
    await service.userDelete(uid, orderId);
    return jsonOk(c, null, "删除成功");
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
}

/** GET /api/delivery_order/detail/:id — same-city delivery snapshot and status trail. */
export async function deliveryOrderDetail(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const service = new StoreDeliveryOrderService(c.get("container"));
  return jsonOk(c, await service.detail(uid, Number(c.req.param("id"))));
}

/** GET /api/order/invoice_list — 已支付且未退款的开票记录 */
export async function orderInvoiceList(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new StoreOrderInvoiceService(c.get("container"));
  return jsonOk(
    c,
    await svc.list(
      uid,
      Number(c.req.query("page") ?? 1),
      Number(c.req.query("limit") ?? 10),
    ),
  );
}

/** GET /api/order/invoice_detail/:uni — 带开票快照的订单详情 */
export async function orderInvoiceDetail(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const orderId = c.req.param("uni");
  if (!orderId) return jsonFail(c, "参数错误");
  const svc = new StoreOrderCreateService(c.get("container"), c.env);
  return jsonOk(c, await svc.detail(uid, orderId));
}

/** POST /api/order/make_up_invoice — 为既有订单补开发票 */
export async function orderMakeUpInvoice(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    order_id?: string | number;
    invoice_id?: number;
  };
  const svc = new StoreOrderInvoiceService(c.get("container"));
  try {
    return jsonOk(
      c,
      await svc.makeUp(uid, body.order_id ?? "", Number(body.invoice_id ?? 0)),
      "申请成功",
    );
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
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

/** GET /api/order/express/:orderId[/:type] — 订单/退款物流查询 */
export async function orderExpress(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const orderId = c.req.param("orderId") ?? "";
  const type = c.req.param("type") ?? "";
  const svc = new ExpressService(c.get("container"), c.env);
  try {
    const result = await svc.query(uid, orderId, type);
    return jsonOk(c, result);
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}
