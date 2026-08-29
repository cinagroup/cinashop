/**
 * 活动参与控制器 (拼团/砍价)
 */
import type { Context } from "hono";
import { jsonOk, jsonFail } from "@/utils/json";
import { ValidateException } from "@/utils/errors";
import { ActivityJoinService } from "@/services/activity/ActivityJoinService";
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function privateNoStore(c: C): void {
  c.header("Cache-Control", "private, no-store");
}

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

/** GET /api/combination/banner_list — 旧 UniApp 拼团轮播图。 */
export async function combinationBanner(c: C) {
  const svc = new ActivityJoinService(c.get("container"), c.env);
  return jsonOk(c, await svc.combinationBanner());
}

/** GET /api/combination/detail_code/:id — 拼团 H5 分享二维码。 */
export async function combinationDetailCode(c: C) {
  privateNoStore(c);
  const svc = new ActivityJoinService(c.get("container"), c.env);
  return jsonOk(c, await svc.activityDetailCode(
    3,
    Number(c.req.param("id") ?? "0"),
    Number(c.get("uid") ?? 0),
    {},
  ));
}

/** GET /api/combination/code/:id — 拼团小程序码。 */
export async function combinationCode(c: C) {
  privateNoStore(c);
  const svc = new ActivityJoinService(c.get("container"), c.env);
  return jsonOk(c, await svc.activityRoutineCode(3, Number(c.req.param("id") ?? "0"), c.get("uid")));
}

/** GET /api/combination/poster_info/:id — 当前用户拼团海报数据。 */
export async function combinationPosterInfo(c: C) {
  privateNoStore(c);
  const svc = new ActivityJoinService(c.get("container"), c.env);
  return jsonOk(c, await svc.combinationPoster(c.get("uid"), Number(c.req.param("id") ?? "0")));
}

/** GET /api/seckill/detail_code/:id — 秒杀 H5 分享二维码。 */
export async function seckillDetailCode(c: C) {
  privateNoStore(c);
  const svc = new ActivityJoinService(c.get("container"), c.env);
  return jsonOk(c, await svc.activityDetailCode(
    1,
    Number(c.req.param("id") ?? "0"),
    Number(c.get("uid") ?? 0),
    { time: c.req.query("time"), status: c.req.query("status") },
  ));
}

/** GET /api/seckill/code/:id — 秒杀小程序码。 */
export async function seckillCode(c: C) {
  privateNoStore(c);
  const svc = new ActivityJoinService(c.get("container"), c.env);
  return jsonOk(c, await svc.activityRoutineCode(1, Number(c.req.param("id") ?? "0"), c.get("uid")));
}

/** GET /api/bargain/config — 旧端砍价页配置。 */
export async function bargainConfig(c: C) {
  const svc = new ActivityJoinService(c.get("container"), c.env);
  return jsonOk(c, await svc.bargainConfig());
}

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

/** POST /api/bargain/start/user — 砍价发起人基本信息。 */
export async function bargainStartUser(c: C) {
  privateNoStore(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    bargainId?: number;
    bargain_id?: number;
    bargainUserUid?: number;
    bargain_user_uid?: number;
  };
  const svc = new ActivityJoinService(c.get("container"), c.env);
  return jsonOk(c, await svc.bargainStartUser(
    Number(body.bargainId ?? body.bargain_id ?? 0),
    Number(body.bargainUserUid ?? body.bargain_user_uid ?? 0),
  ));
}

/** POST /api/bargain/share — 原子累加分享次数并返回活动统计。 */
export async function bargainShare(c: C) {
  privateNoStore(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    bargainId?: number;
    bargain_id?: number;
  };
  const svc = new ActivityJoinService(c.get("container"), c.env);
  return jsonOk(c, await svc.bargainShare(Number(body.bargainId ?? body.bargain_id ?? 0)));
}

/** GET /api/bargain/poster_info/:bargainId — 当前用户砍价海报数据。 */
export async function bargainPosterInfo(c: C) {
  privateNoStore(c);
  const svc = new ActivityJoinService(c.get("container"), c.env);
  return jsonOk(c, await svc.bargainPoster(
    c.get("uid"),
    Number(c.req.param("bargainId") ?? "0"),
  ));
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
  return jsonOk(c, await svc.myBargains(
    uid,
    Number(c.req.query("page") ?? "1"),
    Number(c.req.query("limit") ?? "20"),
  ));
}

/** POST /api/bargain/user/cancel — 取消砍价 */
export async function cancelBargain(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number;
    bargainId?: number;
    bargain_id?: number;
  };
  const svc = new ActivityJoinService(c.get("container"));
  await svc.cancelBargain(uid, {
    id: Number(body.id ?? 0),
    bargainId: Number(body.bargainId ?? body.bargain_id ?? 0),
  });
  return jsonOk(c, null, "已取消");
}
