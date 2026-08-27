/**
 * 用户中心 + 营销活动控制器 (M5)
 */
import type { Context } from "hono";
import { jsonOk, jsonFail } from "@/utils/json";
import { ValidateException } from "@/utils/errors";
import { UserCenterService } from "@/services/user/UserCenterService";
import { ActivityService } from "@/services/activity/ActivityService";
import { StoreDiscountService } from "@/services/activity/StoreDiscountService";
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

// ─── 用户中心: 地址 ─────────────────────────────────────────

export async function addressList(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new UserCenterService(c.get("container"));
  return jsonOk(c, await svc.addressList(uid));
}

export async function addressDefault(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new UserCenterService(c.get("container"));
  return jsonOk(c, await svc.addressDefault(uid));
}

export async function addressEdit(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number;
    realName?: string;
    real_name?: string;
    phone?: string;
    province?: string;
    city?: string;
    district?: string;
    detail?: string;
    isDefault?: number;
    is_default?: number;
  };
  const svc = new UserCenterService(c.get("container"));
  try {
    const id = await svc.addressSave(uid, {
      id: body.id,
      // 兼容 snake_case (前端) 与 camelCase (原版契约)
      realName: body.realName ?? body.real_name ?? "",
      phone: body.phone ?? "",
      province: body.province ?? "",
      city: body.city ?? "",
      district: body.district ?? "",
      detail: body.detail ?? "",
      isDefault: body.isDefault ?? body.is_default,
    });
    return jsonOk(c, { id }, "保存成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

export async function addressDel(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as { id?: number };
  if (!body.id) return jsonFail(c, "参数错误");
  const svc = new UserCenterService(c.get("container"));
  await svc.addressDel(uid, body.id);
  return jsonOk(c, null, "删除成功");
}

// ─── 用户中心: 收藏 ─────────────────────────────────────────

export async function collectAdd(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as { ids?: number[] };
  if (!body.ids?.length) return jsonFail(c, "参数错误");
  const svc = new UserCenterService(c.get("container"));
  const count = await svc.collectAdd(uid, body.ids);
  return jsonOk(c, { count }, "收藏成功");
}

export async function collectDel(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as { ids?: number[] };
  if (!body.ids?.length) return jsonFail(c, "参数错误");
  const svc = new UserCenterService(c.get("container"));
  await svc.collectDel(uid, body.ids);
  return jsonOk(c, null, "取消收藏");
}

export async function collectList(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new UserCenterService(c.get("container"));
  return jsonOk(c, await svc.collectList(uid));
}

// ─── 用户中心: 签到 ─────────────────────────────────────────

export async function signDo(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new UserCenterService(c.get("container"));
  try {
    const result = await svc.sign(uid);
    return jsonOk(c, result, "签到成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

export async function signStatus(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new UserCenterService(c.get("container"));
  return jsonOk(c, await svc.signStatus(uid));
}

// ─── 营销活动: 优惠券 ───────────────────────────────────────

export async function couponList(c: C) {
  const svc = new ActivityService(c.get("container"));
  return jsonOk(c, await svc.couponList());
}

export async function couponReceive(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as { id?: number };
  if (!body.id) return jsonFail(c, "参数错误");
  const svc = new ActivityService(c.get("container"));
  try {
    return jsonOk(c, await svc.receiveCoupon(uid, body.id), "领取成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

export async function myCoupons(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const q = c.req.query("status");
  const svc = new ActivityService(c.get("container"));
  return jsonOk(c, await svc.myCoupons(uid, q !== undefined ? Number(q) : undefined));
}

// ─── 营销活动: 秒杀/拼团/砍价/积分 ─────────────────────────

export async function seckillIndex(c: C) {
  const svc = new ActivityService(c.get("container"));
  return jsonOk(c, await svc.seckillTimes());
}

/** GET /api/store_discounts/list/:product_id — legacy bundle list. */
export async function discountList(c: C) {
  const service = new StoreDiscountService(c.get("container"));
  const productId = Number(c.req.param("product_id"));
  const page = Number(c.req.query("page") ?? "1");
  const limit = Number(c.req.query("limit") ?? "10");
  return jsonOk(c, await service.listForProduct(productId, page, limit));
}

export async function seckillList(c: C) {
  const svc = new ActivityService(c.get("container"));
  // 路由 /seckill/list/:time 是路径参数
  const timeId = c.req.param("time") ?? "";
  return jsonOk(c, await svc.seckillList(timeId));
}

export async function seckillDetail(c: C) {
  const svc = new ActivityService(c.get("container"));
  return jsonOk(c, await svc.seckillDetail(Number(c.req.param("id"))));
}

export async function combinationList(c: C) {
  const svc = new ActivityService(c.get("container"));
  return jsonOk(c, await svc.combinationList());
}

export async function combinationDetail(c: C) {
  const svc = new ActivityService(c.get("container"));
  return jsonOk(c, await svc.combinationDetail(Number(c.req.param("id"))));
}

export async function bargainList(c: C) {
  const svc = new ActivityService(c.get("container"));
  return jsonOk(c, await svc.bargainList());
}

export async function bargainDetail(c: C) {
  const svc = new ActivityService(c.get("container"));
  return jsonOk(c, await svc.bargainDetail(Number(c.req.param("id"))));
}

export async function integralList(c: C) {
  const svc = new ActivityService(c.get("container"));
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 10);
  return jsonOk(c, await svc.integralList(page, limit));
}

export async function integralDetail(c: C) {
  const svc = new ActivityService(c.get("container"));
  return jsonOk(c, await svc.integralDetail(Number(c.req.param("id"))));
}

/** POST /api/store_integral/exchange/:id — 积分兑换 */
export async function integralExchange(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const id = Number(c.req.param("id") ?? "0");
  if (!id) return jsonFail(c, "参数错误");
  const body = (await c.req.json().catch(() => ({}))) as {
    num?: number;
    unique?: string;
    key?: string;
    customForm?: unknown;
    custom_form?: unknown;
  };
  const svc = new ActivityService(c.get("container"));
  try {
    const result = await svc.exchange(
      uid,
      id,
      Number(body.num ?? 1),
      body.unique ?? "",
      body.key ?? c.req.header("Idempotency-Key") ?? "",
      body.customForm ?? body.custom_form,
    );
    return jsonOk(c, result, "兑换成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}
