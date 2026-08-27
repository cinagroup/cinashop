import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import {
  platformEnsureOwner,
  ProductExperienceService,
} from "@/services/product/ProductExperienceService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C) {
  return new ProductExperienceService(c.get("container"));
}

function positiveId(value: string | undefined, field = "ID"): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException(`${field}错误`);
  return id;
}

async function body(c: C): Promise<Record<string, unknown>> {
  const value: unknown = await c.req.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("请求数据格式错误");
  }
  return value as Record<string, unknown>;
}

export async function userVisitList(c: C) {
  return jsonOk(c, await service(c).userVisitList(c.get("uid"), c.req.query()));
}

export async function userVisitDelete(c: C) {
  const input = await body(c);
  return jsonOk(c, await service(c).deleteUserVisits(c.get("uid"), input.ids), "删除成功");
}

export async function adminEnsureList(c: C) {
  return jsonOk(c, await service(c).ensureList(platformEnsureOwner, c.req.query()));
}

export async function adminEnsureAll(c: C) {
  return jsonOk(c, await service(c).allEnsures(platformEnsureOwner));
}

export async function adminEnsureDetail(c: C) {
  return jsonOk(
    c,
    await service(c).ensureDetail(platformEnsureOwner, positiveId(c.req.param("id"))),
  );
}

export async function adminEnsureCreate(c: C) {
  return jsonOk(c, await service(c).saveEnsure(platformEnsureOwner, 0, await body(c)), "添加成功");
}

export async function adminEnsureUpdate(c: C) {
  return jsonOk(
    c,
    await service(c).saveEnsure(
      platformEnsureOwner,
      positiveId(c.req.param("id")),
      await body(c),
    ),
    "修改成功",
  );
}

export async function adminEnsureStatus(c: C) {
  const id = positiveId(c.req.param("id"));
  const status = Number(c.req.param("is_show"));
  await service(c).setEnsureStatus(platformEnsureOwner, id, status);
  return jsonOk(c, null, "设置成功");
}

export async function adminEnsureDelete(c: C) {
  await service(c).deleteEnsure(platformEnsureOwner, positiveId(c.req.param("id")));
  return jsonOk(c, null, "删除成功");
}
