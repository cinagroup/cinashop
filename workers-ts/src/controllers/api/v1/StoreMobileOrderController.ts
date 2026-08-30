import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { StoreMobileOrderService } from "@/services/store/StoreMobileOrderService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C) {
  return new StoreMobileOrderService(c.get("container"), c.env);
}

function uid(c: C): number {
  return Number(c.get("uid") ?? 0);
}

function privateResponse(c: C) {
  c.header("Cache-Control", "private, no-store");
  c.header("Pragma", "no-cache");
}

async function requestBody(c: C): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidateException("请求数据格式错误");
  }
  return body as Record<string, unknown>;
}

/** GET /api/store/refund/detail/:id */
export async function refundDetail(c: C) {
  privateResponse(c);
  return jsonOk(c, await service(c).refundDetail(uid(c), c.req.param("id")));
}

/** GET /api/store/order/detail/:id */
export async function orderDetail(c: C) {
  privateResponse(c);
  return jsonOk(c, await service(c).orderDetail(uid(c), c.req.param("id")));
}

/** GET /api/store/order/writeoff_info/:type */
export async function writeoffInfo(c: C) {
  privateResponse(c);
  const query = c.req.query();
  return jsonOk(
    c,
    await service(c).writeoffInfo(uid(c), c.req.param("type"), query.verify_code ?? query.code),
  );
}

/** POST /api/store/order/cart_info */
export async function cartInfo(c: C) {
  privateResponse(c);
  const body = await requestBody(c);
  return jsonOk(c, await service(c).writeoffCartInfo(uid(c), body.auth, body.oid));
}

/** GET /api/store/order/delivery_info/:orderId */
export async function deliveryInfo(c: C) {
  privateResponse(c);
  return jsonOk(c, await service(c).deliveryInfo(uid(c), c.req.param("orderId")));
}

/** PUT /api/store/order/split_delivery/:id */
export async function splitDelivery(c: C) {
  privateResponse(c);
  const result = await service(c).splitDelivery(uid(c), c.req.param("id"), await requestBody(c));
  return jsonOk(c, result, "SUCCESS");
}
