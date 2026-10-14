import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { ProductExperienceService } from "@/services/product/ProductExperienceService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C) {
  return new ProductExperienceService(c.get("container"));
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
