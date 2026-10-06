import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { PromoterApplicationService, type PromoterApplicationAdminActor } from "@/services/agent/PromoterApplicationService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";
import { readBoundedJsonObject } from "@/utils/request-body";

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
  c.header("Cache-Control", "private, no-store");
  return jsonOk(c, await service(c).list(new URL(c.req.url).searchParams));
}

function actor(c: C): PromoterApplicationAdminActor {
  const admin = c.get("adminInfo");
  if (!admin) throw new ValidateException("管理员身份不存在");
  return { id: admin.id, method: c.req.method as PromoterApplicationAdminActor['method'] };
}

export async function adminExamine(c: C) {
  c.header("Cache-Control", "private, no-store");
  const query = new URL(c.req.url).searchParams;
  let reason: unknown;
  let revision: unknown;
  if (c.req.method === "POST") {
    if (query.size) throw new ValidateException("审核不接受查询参数");
    const input = await readBoundedJsonObject(c.req.raw, 8 * 1024);
    if (Object.keys(input).some(key => key !== "refusal_reason" && key !== "revision")) throw new ValidateException("不支持的审核字段");
    reason = input.refusal_reason;
    revision = input.revision;
  } else {
    // PHP's GET review did not supply a reason. Preserve that empty legacy
    // rejection while requiring an explicit reason on the modern POST path.
    if ([...query.keys()].some(key => key !== "refusal_reason") || query.getAll("refusal_reason").length > 1) {
      throw new ValidateException("不支持或重复的审核参数");
    }
    reason = query.get("refusal_reason") ?? undefined;
  }
  await service(c).examine(
    c.req.param("id"),
    c.req.param("uid"),
    c.req.param("status"),
    reason,
    actor(c),
    revision,
  );
  return jsonOk(c, null, c.req.param("status") === "1" ? "审核通过" : "拒绝成功");
}

export async function adminDelete(c: C) {
  c.header("Cache-Control", "private, no-store");
  if (new URL(c.req.url).searchParams.size) throw new ValidateException("删除不接受查询参数");
  // The PHP DELETE had no body. Only that legacy form lacks a revision guard.
  const hasBody = c.req.raw.body !== null;
  const input = hasBody ? await readBoundedJsonObject(c.req.raw, 1024) : {};
  if (Object.keys(input).some(key => key !== "revision")) throw new ValidateException("不支持的删除字段");
  if (hasBody && (typeof input.revision !== "string" || !/^[a-f0-9]{64}$/.test(input.revision))) {
    throw new ValidateException("申请版本无效，请刷新后重新确认");
  }
  await service(c).delete(c.req.param("id"), actor(c), hasBody ? input.revision : null);
  return jsonOk(c, null, "删除成功");
}
