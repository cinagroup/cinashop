/**
 * 用户中心 + 营销活动控制器 (M5)
 */
import type { Context } from "hono";
import { jsonOk, jsonFail } from "@/utils/json";
import { ValidateException } from "@/utils/errors";
import { UserCenterService } from "@/services/user/UserCenterService";
import { UserSignCompatibilityService } from "@/services/user/UserSignCompatibilityService";
import { UserCollectCompatibilityService } from "@/services/user/UserCollectCompatibilityService";
import { ActivityService } from "@/services/activity/ActivityService";
import { V2CouponCompatibilityService } from "@/services/activity/V2CouponCompatibilityService";
import { StoreDiscountService } from "@/services/activity/StoreDiscountService";
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const MAX_COMPAT_BODY_BYTES = 16 * 1024;

function privateNoStore(c: C): void {
  c.header("Cache-Control", "private, no-store");
}

function formParams(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [rawKey, value] of new URLSearchParams(raw)) {
    const nested = /^address\[([a-zA-Z0-9_]+)\]$/.exec(rawKey);
    if (nested) {
      const address = result.address && typeof result.address === "object"
        ? result.address as Record<string, unknown>
        : {};
      address[nested[1]] = value;
      result.address = address;
      continue;
    }
    const isArray = rawKey.endsWith("[]");
    const key = isArray ? rawKey.slice(0, -2) : rawKey;
    if (isArray || key in result) {
      const previous = result[key];
      result[key] = Array.isArray(previous)
        ? [...previous, value]
        : previous === undefined
          ? [value]
          : [previous, value];
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function compatibilityParams(c: C): Promise<Record<string, unknown>> {
  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_COMPAT_BODY_BYTES) {
    throw new ValidateException("请求数据不能超过16 KiB");
  }
  const query: Record<string, unknown> = { ...c.req.query() };
  const stream = c.req.raw.body;
  if (!stream) return query;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_COMPAT_BODY_BYTES) {
      await reader.cancel();
      throw new ValidateException("请求数据不能超过16 KiB");
    }
    chunks.push(value);
  }
  if (total === 0) return query;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const raw = new TextDecoder().decode(bytes);
  const contentType = (c.req.header("content-type") ?? "application/json")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  let body: unknown;
  if (contentType === "application/x-www-form-urlencoded") {
    body = formParams(raw);
  } else if (contentType === "application/json") {
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
  } else {
    throw new ValidateException("请求数据类型不支持");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidateException("请求数据格式错误");
  }
  return { ...query, ...body as Record<string, unknown> };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function collectIdValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "number") return [value];
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function positivePage(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new ValidateException("分页参数错误");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new ValidateException("分页参数错误");
  }
  return parsed;
}

function enabledFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function integerField(value: unknown, fallback?: number): number | undefined {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return Number.NaN;
}

function binaryFlagField(value: unknown): number | undefined {
  if (value === true) return 1;
  if (value === false) return 0;
  return integerField(value);
}

// ─── 用户中心: 地址 ─────────────────────────────────────────

export async function addressList(c: C) {
  privateNoStore(c);
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new UserCenterService(c.get("container"));
  return jsonOk(c, await svc.addressList(uid));
}

export async function addressDefault(c: C) {
  privateNoStore(c);
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new UserCenterService(c.get("container"));
  const address = await svc.addressDefault(uid);
  return jsonOk(c, address, Array.isArray(address) ? "empty" : "ok");
}

export async function addressDetail(c: C) {
  privateNoStore(c);
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  return jsonOk(c, await new UserCenterService(c.get("container")).addressDetail(
    uid,
    c.req.param("id"),
  ));
}

export async function addressDefaultSet(c: C) {
  privateNoStore(c);
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = await compatibilityParams(c);
  await new UserCenterService(c.get("container")).addressSetDefault(uid, body.id);
  return jsonOk(c, null);
}

export async function addressEdit(c: C) {
  privateNoStore(c);
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = await compatibilityParams(c);
  const nested = body.address && typeof body.address === "object" && !Array.isArray(body.address)
    ? body.address as Record<string, unknown>
    : {};
  const svc = new UserCenterService(c.get("container"));
  try {
    const id = await svc.addressSave(uid, {
      id: body.id,
      // 兼容 snake_case (前端) 与 camelCase (原版契约)
      realName: stringField(body.realName ?? body.real_name),
      phone: stringField(body.phone),
      province: stringField(body.province ?? nested.province),
      city: stringField(body.city ?? nested.city),
      district: stringField(body.district ?? nested.district),
      street: stringField(body.street ?? nested.street),
      cityId: integerField(body.cityId ?? body.city_id ?? nested.city_id, 0),
      detail: stringField(body.detail),
      postCode: integerField(body.postCode ?? body.post_code, 0),
      longitude: stringField(body.longitude),
      latitude: stringField(body.latitude),
      // Missing is_default on an edit means "preserve", not "clear".
      isDefault: binaryFlagField(body.isDefault ?? body.is_default),
    });
    return jsonOk(c, { id }, "保存成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

export async function addressDel(c: C) {
  privateNoStore(c);
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = await compatibilityParams(c);
  const svc = new UserCenterService(c.get("container"));
  await svc.addressDel(uid, body.id);
  return jsonOk(c, null, "删除成功");
}

// ─── 用户中心: 收藏 ─────────────────────────────────────────

export async function collectAdd(c: C) {
  privateNoStore(c);
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = await compatibilityParams(c);
  const svc = new UserCenterService(c.get("container"));
  const count = await svc.collectAdd(
    uid,
    collectIdValues(body.id ?? body.ids),
    stringField(body.category) || "product",
  );
  return jsonOk(c, { count }, "收藏成功");
}

export async function collectDel(c: C) {
  privateNoStore(c);
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = await compatibilityParams(c);
  const svc = new UserCenterService(c.get("container"));
  await svc.collectDel(
    uid,
    collectIdValues(body.id ?? body.ids),
    stringField(body.category) || "product",
  );
  return jsonOk(c, null, "取消收藏");
}

export async function collectList(c: C) {
  privateNoStore(c);
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const category = stringField(c.req.query("category")) || "product";
  const page = positivePage(c.req.query("page"), 1, 1_000_000);
  const limit = positivePage(c.req.query("limit"), 20, 100);
  return jsonOk(c, await new UserCollectCompatibilityService(
    c.get("container"),
    c.env,
  ).list(uid, page, limit, category));
}

export async function collectAll(c: C) {
  privateNoStore(c);
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = await compatibilityParams(c);
  await new UserCenterService(c.get("container")).collectAdd(
    uid,
    collectIdValues(body.id),
    stringField(body.category) || "product",
  );
  return jsonOk(c, null, "收藏成功");
}

// ─── 用户中心: 签到 ─────────────────────────────────────────

export async function signDo(c: C) {
  privateNoStore(c);
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
  privateNoStore(c);
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new UserCenterService(c.get("container"));
  return jsonOk(c, await svc.signStatus(uid));
}

export async function signConfig(c: C) {
  privateNoStore(c);
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  return jsonOk(c, await new UserSignCompatibilityService(c.get("container")).config(uid));
}

export async function signList(c: C) {
  privateNoStore(c);
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  return jsonOk(c, await new UserSignCompatibilityService(c.get("container")).list(
    uid,
    c.req.query("page"),
    c.req.query("limit"),
  ));
}

export async function signMonth(c: C) {
  privateNoStore(c);
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  return jsonOk(c, await new UserSignCompatibilityService(c.get("container")).month(
    uid,
    c.req.query("page"),
    c.req.query("limit"),
  ));
}

export async function signUser(c: C) {
  privateNoStore(c);
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = await compatibilityParams(c);
  return jsonOk(c, await new UserSignCompatibilityService(c.get("container")).user(uid, {
    sign: enabledFlag(body.sign),
    integral: enabledFlag(body.integral),
    all: enabledFlag(body.all),
  }));
}

export async function signRemind(c: C) {
  privateNoStore(c);
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  await new UserSignCompatibilityService(c.get("container")).setRemind(
    uid,
    c.req.param("status"),
  );
  return jsonOk(c, null, "设置成功");
}

export async function signCalendar(c: C) {
  privateNoStore(c);
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  return jsonOk(c, await new UserSignCompatibilityService(c.get("container")).calendar(
    uid,
    c.req.query("time"),
  ));
}

// ─── 营销活动: 优惠券 ───────────────────────────────────────

export async function couponList(c: C) {
  const svc = new ActivityService(c.get("container"));
  return jsonOk(c, await svc.couponList());
}

/** GET /api/v2/coupons — PHP v2 scoped coupon catalogue. */
export async function couponListV2(c: C) {
  const service = new V2CouponCompatibilityService(c.get("container"));
  try {
    return jsonOk(c, await service.available(c.get("uid") ?? 0, c.req.query()));
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
}

/** GET /api/v2/new_coupon — read-only newcomer coupon popup contract. */
export async function couponNewV2(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const service = new V2CouponCompatibilityService(c.get("container"));
  try {
    return jsonOk(c, await service.newCoupons(uid));
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
}

/** GET /api/v2/get_today_coupon — optional-user daily coupon popup contract. */
export async function couponTodayV2(c: C) {
  const service = new V2CouponCompatibilityService(c.get("container"));
  try {
    return jsonOk(c, await service.today(c.get("uid") ?? 0));
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
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
  return jsonOk(c, await svc.seckillList(timeId, c.req.query("page"), c.req.query("limit")));
}

export async function seckillDetail(c: C) {
  const svc = new ActivityService(c.get("container"));
  return jsonOk(c, await svc.seckillDetail(Number(c.req.param("id"))));
}

export async function combinationList(c: C) {
  const svc = new ActivityService(c.get("container"));
  return jsonOk(c, await svc.combinationList(c.req.query("page"), c.req.query("limit")));
}

export async function combinationDetail(c: C) {
  const svc = new ActivityService(c.get("container"));
  return jsonOk(c, await svc.combinationDetail(Number(c.req.param("id"))));
}

export async function bargainList(c: C) {
  const svc = new ActivityService(c.get("container"));
  return jsonOk(c, await svc.bargainList(c.req.query("page"), c.req.query("limit")));
}

export async function bargainDetail(c: C) {
  const svc = new ActivityService(c.get("container"));
  return jsonOk(c, await svc.bargainDetail(Number(c.req.param("id"))));
}

export async function integralList(c: C) {
  const svc = new ActivityService(c.get("container"), c.env);
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 10);
  return jsonOk(c, await svc.integralList(page, limit, {
    storeName: c.req.query("store_name"),
    priceOrder: c.req.query("priceOrder"),
    salesOrder: c.req.query("salesOrder"),
    range: c.req.query("range"),
  }));
}

export async function integralHome(c: C) {
  privateNoStore(c);
  const svc = new ActivityService(c.get("container"), c.env);
  return jsonOk(c, await svc.integralHome(
    c.get("uid") ?? 0,
    c.req.query("page"),
    c.req.query("limit"),
  ));
}

export async function integralCategories(c: C) {
  const svc = new ActivityService(c.get("container"), c.env);
  return jsonOk(c, await svc.integralCategories());
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
