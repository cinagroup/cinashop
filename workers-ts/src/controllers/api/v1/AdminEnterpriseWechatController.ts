import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { EnterpriseWechatCatalogService } from "@/services/work/EnterpriseWechatCatalogService";
import { EnterpriseWechatContactActionService } from "@/services/work/EnterpriseWechatContactActionService";
import { readBoundedJsonObject } from "@/utils/request-body";
import { ValidateException } from "@/utils/errors";
import { jsonOk, jsonRaw } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C) {
  return new EnterpriseWechatCatalogService(c.get("container"), c.env);
}

function actionService(c: C) {
  return new EnterpriseWechatContactActionService(c.get("container"), c.env);
}

function adminId(c: C): number {
  const id = Number(c.get("adminId"));
  if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("管理员身份无效");
  return id;
}

export async function summary(c: C) { return jsonOk(c, await service(c).summary()); }
export async function departments(c: C) { return jsonOk(c, await service(c).departments(c.req.query())); }
export async function members(c: C) { return jsonOk(c, await service(c).members(c.req.query())); }
export async function clients(c: C) { return jsonOk(c, await service(c).clients(c.req.query())); }
export async function groups(c: C) { return jsonOk(c, await service(c).groups(c.req.query())); }
export async function groupMembers(c: C) { return jsonOk(c, await service(c).groupMembers(c.req.param("id") ?? "", c.req.query())); }
export async function channels(c: C) { return jsonOk(c, await service(c).channels(c.req.query())); }
export async function groupAuths(c: C) { return jsonOk(c, await service(c).groupAuths(c.req.query())); }
export async function labels(c: C) { return jsonOk(c, await service(c).labels(c.req.query())); }
export async function templates(c: C) { return jsonOk(c, await service(c).templates(c.req.query())); }
export async function moments(c: C) { return jsonOk(c, await service(c).moments(c.req.query())); }
export async function welcomes(c: C) { return jsonOk(c, await service(c).welcomes(c.req.query())); }
export async function contactActions(c: C) {
  return jsonOk(c, await actionService(c).listForAdmin(c.req.query()));
}
export async function decideContactAction(c: C) {
  const id = Number(c.req.param("id"));
  const body = await readBoundedJsonObject(c.req.raw, 32 * 1024);
  return jsonOk(c, await actionService(c).decide(adminId(c), id, body));
}

export function remoteWriteUnavailable(c: C) {
  return jsonRaw(
    c,
    501,
    "企业微信外部写入尚未迁移：需要 Cloudflare Queue、幂等投递记录、重试边界和专用凭据后才能启用",
    {
      runtime_status: "not_migrated_requires_idempotent_outbox",
      catalog_authority: "postgresql_imported_history",
      remote_write_authority: "disabled",
    },
  );
}
