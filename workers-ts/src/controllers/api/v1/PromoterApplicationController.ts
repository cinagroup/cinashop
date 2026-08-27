import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { PromoterApplicationService } from "@/services/agent/PromoterApplicationService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C) {
  return new PromoterApplicationService(c.get("container"), c.env);
}

async function body(c: C): Promise<Record<string, unknown>> {
  const value: unknown = await c.req.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("请求数据格式错误");
  }
  return value as Record<string, unknown>;
}

export async function applyInfo(c: C) {
  return jsonOk(c, await service(c).applyInfo(c.get("uid")));
}

export async function applyPromoter(c: C) {
  return jsonOk(
    c,
    await service(c).submit(c.get("uid"), c.req.param("id"), await body(c)),
    "申请成功",
  );
}

export async function adminList(c: C) {
  return jsonOk(c, await service(c).list(c.req.query()));
}

export async function adminExamine(c: C) {
  await service(c).examine(
    c.req.param("id"),
    c.req.param("uid"),
    c.req.param("status"),
    c.req.query("refusal_reason"),
  );
  return jsonOk(c, null, c.req.param("status") === "1" ? "审核通过" : "拒绝成功");
}

export async function adminDelete(c: C) {
  await service(c).delete(c.req.param("id"));
  return jsonOk(c, null, "删除成功");
}
