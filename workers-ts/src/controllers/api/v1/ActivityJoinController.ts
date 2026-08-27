/**
 * 活动参与控制器 (拼团/砍价)
 */
import type { Context } from "hono";
import { jsonOk, jsonFail } from "@/utils/json";
import { ValidateException } from "@/utils/errors";
import { ActivityJoinService } from "@/services/activity/ActivityJoinService";
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

interface BargainHelpBody {
  bargain_user_id?: number;
  bargainId?: number;
  bargainUserUid?: number;
}

async function resolveBargainUserId(
  svc: ActivityJoinService,
  body: BargainHelpBody,
): Promise<number> {
  if (Number.isSafeInteger(body.bargain_user_id) && (body.bargain_user_id ?? 0) > 0) {
    return body.bargain_user_id!;
  }
  return svc.resolveBargainUserId(Number(body.bargainId ?? 0), Number(body.bargainUserUid ?? 0));
}

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

/** GET /api/pink — 拼团成功人数与头像；实际参团只能经订单创建。 */
export async function pinkStats(c: C) {
  const type = Number(c.req.query("type") ?? "1");
  const svc = new ActivityJoinService(c.get("container"));
  return jsonOk(c, await svc.pinkStats(Number.isSafeInteger(type) ? type : 1));
}

/** POST /api/combination/remove — 取消开团 */
export async function removePink(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as { id?: number; cid?: number };
  if (!body.id || !body.cid) return jsonFail(c, "缺少参数");
  const svc = new ActivityJoinService(c.get("container"), c.env);
  const result = await svc.removePink(uid, body.id, body.cid);
  return jsonOk(c, result, result.completed ? "拼团已取消并退款" : "退款处理中");
}

// ═══ 砍价 ═════════════════════════════════════════════════

/** POST /api/bargain/start — 发起砍价 */
export async function startBargain(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    bargain_id?: number;
    bargainId?: number;
  };
  const bargainId = Number(body.bargain_id ?? body.bargainId ?? 0);
  if (!bargainId) return jsonFail(c, "参数错误");
  const svc = new ActivityJoinService(c.get("container"));
  try {
    return jsonOk(c, await svc.startBargain(uid, bargainId), "砍价已开启");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/bargain/help — 帮砍 */
export async function helpBargain(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as BargainHelpBody;
  const svc = new ActivityJoinService(c.get("container"));
  try {
    const bargainUserId = await resolveBargainUserId(svc, body);
    return jsonOk(c, await svc.helpBargain(uid, bargainUserId), "帮砍成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/bargain/help/price — 当前用户本次砍掉金额 */
export async function bargainHelpPrice(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as BargainHelpBody;
  const svc = new ActivityJoinService(c.get("container"));
  try {
    return jsonOk(c, await svc.bargainHelpPrice(uid, await resolveBargainUserId(svc, body)));
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/bargain/help/count — 帮砍进度和当前用户资格 */
export async function bargainHelpCount(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as BargainHelpBody;
  const svc = new ActivityJoinService(c.get("container"));
  try {
    return jsonOk(c, await svc.bargainHelpCount(uid, await resolveBargainUserId(svc, body)));
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/bargain/help/list — 帮砍明细 */
export async function bargainHelpList(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as BargainHelpBody & {
    page?: number;
    limit?: number;
  };
  const svc = new ActivityJoinService(c.get("container"));
  try {
    const bargainUserId = await resolveBargainUserId(svc, body);
    return jsonOk(c, await svc.bargainHelpList(
      bargainUserId,
      Number(body.page ?? 1),
      Number(body.limit ?? 20),
    ));
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
