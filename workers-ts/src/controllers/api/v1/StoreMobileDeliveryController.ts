import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { StoreMobileDeliveryService } from "@/services/store/StoreMobileDeliveryService";
import { DeliveryReadService } from "@/services/store/DeliveryReadService";
import { deliveryActor } from "@/services/store/DeliveryPrincipalScope";
import { deliveryWriteoffActions } from "@/services/store/DeliveryOrderWriteoffService";
import { md5 } from "@/utils/jwt";
import { AuthException, ValidateException } from "@/utils/errors";
import { jsonFail, jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C) {
  return new StoreMobileDeliveryService(c.get("container"), c.env, deliveryWriteoffActions);
}

function uid(c: C): number {
  return Number(c.get("uid") ?? 0);
}

function privateResponse(c: C) {
  c.header("Cache-Control", "private, no-store");
  c.header("Pragma", "no-cache");
}

export function workbenchActor(c: C) {
  const user = c.get("user"), actorUid = c.get("uid");
  if (!c.get("isLogin") || !user || user.uid !== actorUid || c.get("socketAuthId") !== actorUid || typeof c.get("socketAuthVersion") !== "string") throw new AuthException("配送会话未通过用户鉴权");
  return deliveryActor({ uid: actorUid, authVersion: md5(user.pwd), expiresAt: c.get("socketTokenExp") ?? 0 });
}
function query(c: C): Record<string, string> {
  const pairs = new URL(c.req.url).searchParams, result: Record<string, string> = Object.create(null) as Record<string, string>;
  if (pairs.size > 16) throw new ValidateException("配送读取参数过多");
  for (const [key, value] of pairs) { if (Object.hasOwn(result, key)) throw new ValidateException("配送读取参数重复"); result[key] = value; }
  return result;
}
function workbench(c: C) { return new DeliveryReadService(c.get("container"), c.env, deliveryWriteoffActions); }
export async function context(c: C) { privateResponse(c); return jsonOk(c, await workbench(c).context(workbenchActor(c), query(c))); }
export async function workbenchStatistics(c: C) { privateResponse(c); return jsonOk(c, await workbench(c).statistics(workbenchActor(c), query(c))); }
export async function daily(c: C) { privateResponse(c); return jsonOk(c, await workbench(c).daily(workbenchActor(c), query(c))); }
export async function workbenchOrders(c: C) { privateResponse(c); return jsonOk(c, await workbench(c).orders(workbenchActor(c), query(c))); }
export async function orderDetail(c: C) { privateResponse(c); return jsonOk(c, await workbench(c).detail(workbenchActor(c), c.req.param("id"), query(c))); }

/** GET /api/store/delivery/info */
export async function info(c: C) {
  privateResponse(c);
  if (!uid(c)) return jsonFail(c, "请先登录");
  return jsonOk(c, await service(c).info(workbenchActor(c)));
}

/** GET /api/store/delivery/statistics */
export async function statistics(c: C) {
  privateResponse(c);
  if (!uid(c)) return jsonFail(c, "请先登录");
  return jsonOk(c, await service(c).statistics(workbenchActor(c), query(c)));
}

/** GET /api/store/delivery/data */
export async function data(c: C) {
  privateResponse(c);
  if (!uid(c)) return jsonFail(c, "请先登录");
  return jsonOk(c, await service(c).data(workbenchActor(c), query(c)));
}

/** GET /api/store/delivery/order */
export async function orderList(c: C) {
  privateResponse(c);
  if (!uid(c)) return jsonFail(c, "请先登录");
  return jsonOk(c, await service(c).orders(workbenchActor(c), query(c)));
}

/** GET /api/store/delivery/list — active delivery staff in the current clerk's store. */
export async function deliveryList(c: C) {
  privateResponse(c);
  if (!uid(c)) return jsonFail(c, "请先登录");
  return jsonOk(c, await service(c).deliveryList(workbenchActor(c), query(c)));
}
