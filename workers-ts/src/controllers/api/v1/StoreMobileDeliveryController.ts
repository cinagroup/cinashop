import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { StoreMobileDeliveryService } from "@/services/store/StoreMobileDeliveryService";
import { jsonFail, jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C) {
  return new StoreMobileDeliveryService(c.get("container"));
}

function uid(c: C): number {
  return Number(c.get("uid") ?? 0);
}

function privateResponse(c: C) {
  c.header("Cache-Control", "private, no-store");
  c.header("Pragma", "no-cache");
}

/** GET /api/store/delivery/info */
export async function info(c: C) {
  privateResponse(c);
  if (!uid(c)) return jsonFail(c, "请先登录");
  return jsonOk(c, await service(c).info(uid(c)));
}

/** GET /api/store/delivery/statistics */
export async function statistics(c: C) {
  privateResponse(c);
  if (!uid(c)) return jsonFail(c, "请先登录");
  return jsonOk(c, await service(c).statistics(uid(c), c.req.query()));
}

/** GET /api/store/delivery/data */
export async function data(c: C) {
  privateResponse(c);
  if (!uid(c)) return jsonFail(c, "请先登录");
  return jsonOk(c, await service(c).data(uid(c), c.req.query()));
}

/** GET /api/store/delivery/order */
export async function orderList(c: C) {
  privateResponse(c);
  if (!uid(c)) return jsonFail(c, "请先登录");
  return jsonOk(c, await service(c).orders(uid(c), c.req.query()));
}

/** GET /api/store/delivery/list — active delivery staff in the current clerk's store. */
export async function deliveryList(c: C) {
  privateResponse(c);
  if (!uid(c)) return jsonFail(c, "请先登录");
  return jsonOk(c, await service(c).deliveryList(uid(c), c.req.query()));
}
