/**
 * 活动参与控制器 (拼团/砍价)
 */
import type { Context } from "hono";
import { jsonOk, jsonFail } from "@/utils/json";
import { ValidateException } from "@/utils/errors";
import { ActivityJoinService } from "@/services/activity/ActivityJoinService";
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

// ═══ 拼团 ═════════════════════════════════════════════════

/** GET /api/combination/pink/:id — 拼团详情含进行中的团 */
export async function pinkInfo(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  if (!id) return jsonFail(c, "参数错误");
  const uid = c.get("uid");
  const svc = new ActivityJoinService(c.get("container"));
  try {
    return jsonOk(c, await svc.pinkInfo(uid, id));
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/pink — 参与拼团 (k_id=0 开团, k_id>0 参团) */
export async function joinPink(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    combination_id?: number;
    product_id?: number;
    order_id?: string;
    k_id?: number;
  };
  if (!body.combination_id) return jsonFail(c, "参数错误");
  const svc = new ActivityJoinService(c.get("container"));
  try {
    const result = await svc.joinPink(uid, {
      combinationId: body.combination_id,
      productId: body.product_id ?? 0,
      orderId: body.order_id ?? `p${Date.now()}`,
      kId: body.k_id ?? 0,
    });
    return jsonOk(c, result, result.isLeader ? "开团成功" : "参团成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/combination/remove — 取消开团 */
export async function removePink(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as { id?: number };
  const svc = new ActivityJoinService(c.get("container"));
  await svc.removePink(uid, body.id ?? 0);
  return jsonOk(c, null, "已取消开团");
}

// ═══ 砍价 ═════════════════════════════════════════════════

/** POST /api/bargain/start — 发起砍价 */
export async function startBargain(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as { bargain_id?: number };
  if (!body.bargain_id) return jsonFail(c, "参数错误");
  const svc = new ActivityJoinService(c.get("container"));
  try {
    return jsonOk(c, await svc.startBargain(uid, body.bargain_id), "砍价已开启");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/bargain/help — 帮砍 */
export async function helpBargain(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as { bargain_user_id?: number };
  const svc = new ActivityJoinService(c.get("container"));
  try {
    return jsonOk(c, await svc.helpBargain(uid, body.bargain_user_id ?? 0), "帮砍成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /api/bargain/user/list — 我的砍价 */
export async function myBargains(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new ActivityJoinService(c.get("container"));
  return jsonOk(c, await svc.myBargains(uid));
}

/** POST /api/bargain/user/cancel — 取消砍价 */
export async function cancelBargain(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as { id?: number };
  const svc = new ActivityJoinService(c.get("container"));
  await svc.cancelBargain(uid, body.id ?? 0);
  return jsonOk(c, null, "已取消");
}
