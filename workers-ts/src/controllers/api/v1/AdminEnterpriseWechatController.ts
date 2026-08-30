import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { EnterpriseWechatCatalogService } from "@/services/work/EnterpriseWechatCatalogService";
import { jsonOk, jsonRaw } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C) {
  return new EnterpriseWechatCatalogService(c.get("container"), c.env);
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
