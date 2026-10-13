import type { Context, MiddlewareHandler } from "hono";
import type { AppVariables, Env } from "@/env";
import { SupplierProductCategoryService } from "@/services/supplier/SupplierProductCategoryService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";
import { readBoundedJsonObject } from "@/utils/request-body";
import { extractToken } from "@/middleware/auth";
import { verifyToken } from "@/utils/jwt";
import { ApiErrorCode, AuthException } from "@/utils/errors";

type SupplierApp = { Bindings: Env; Variables: AppVariables };
type C = Context<SupplierApp>;
export const privateResponse: MiddlewareHandler<SupplierApp> = async (c, next) => {
  c.header("Cache-Control", "private, no-store, max-age=0"); c.header("Pragma", "no-cache"); await next();
};
function service(c: C) { return new SupplierProductCategoryService(c.get("container")); }
function supplier(c: C) { const id = c.get("supplierId"); if (!id) throw new Error("supplier auth context missing"); return id; }
function id(c: C) {
  const value = c.req.param("id");
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2_147_483_647) throw new ValidateException("分类ID错误");
  return Number(value);
}
export async function categoryActor(c: C) {
  const value = c.get("supplierAdminInfo"); if (!value) throw new Error("supplier admin context missing");
  const token = extractToken(c);
  if (!token) throw new AuthException("请重新登录", ApiErrorCode.ERR_LOGIN);
  let payload: Awaited<ReturnType<typeof verifyToken>>;
  try { payload = await verifyToken(token, c.env.APP_KEY); } catch { throw new AuthException("登录已过期", ApiErrorCode.ERR_EXPIRED); }
  if (payload.type !== "supplier" || payload.id !== value.id || !payload.auth) throw new AuthException("供应商会话无效", ApiErrorCode.ERR_AUTH);
  return { id: payload.id, authVersion: payload.auth, expiresAt: payload.exp, ip: (c.req.header("CF-Connecting-IP") ?? "").slice(0, 45) };
}
function query(c: C) {
  const result: Record<string, string> = {};
  for (const [key, values] of Object.entries(c.req.queries())) {
    if (values.length !== 1) throw new ValidateException("分类查询参数不能重复");
    result[key] = values[0];
  }
  return result;
}
export async function list(c: C) { return jsonOk(c, await service(c).legacyList(supplier(c), query(c))); }
export async function tier(c: C) { return jsonOk(c, await service(c).legacyTier(supplier(c), c.req.param("type") ?? "0")); }
export async function cascader(c: C) { return jsonOk(c, await service(c).cascader(supplier(c), c.req.param("type"))); }
export async function createForm(c: C) { return jsonOk(c, await service(c).form(supplier(c))); }
export async function editForm(c: C) { return jsonOk(c, await service(c).form(supplier(c), id(c))); }
export async function modernTree(c: C) { const input = query(c); return jsonOk(c, await service(c).modernTree(supplier(c), input.is_show !== "1")); }
export async function modernDetail(c: C) { return jsonOk(c, await service(c).modernDetail(supplier(c), id(c))); }
export async function create(c: C) {
  return jsonOk(c, await service(c).save(supplier(c), 0, await readBoundedJsonObject(c.req.raw, 8 * 1024), await categoryActor(c)), "分类创建成功");
}
export async function update(c: C) {
  return jsonOk(c, await service(c).save(supplier(c), id(c), await readBoundedJsonObject(c.req.raw, 8 * 1024), await categoryActor(c)), "分类修改成功");
}
export async function remove(c: C) {
  const input = await readBoundedJsonObject(c.req.raw, 1024);
  await service(c).delete(supplier(c), id(c), input.expected_revision, await categoryActor(c));
  return jsonOk(c, null, "分类删除成功");
}
export async function setShow(c: C) {
  const value = c.req.param("is_show"); if (value !== "0" && value !== "1") throw new ValidateException("分类状态错误");
  const input = await readBoundedJsonObject(c.req.raw, 1024);
  return jsonOk(c, await service(c).setShow(supplier(c), id(c), Number(value), input.expected_revision, await categoryActor(c)), "分类及子级状态已更新");
}
