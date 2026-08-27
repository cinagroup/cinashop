import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { WechatMemberCardCatalogService } from "@/services/wechat/WechatMemberCardCatalogService";
import { jsonOk, jsonRaw } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C) {
  return new WechatMemberCardCatalogService(c.get("container"));
}

export async function summary(c: C) {
  return jsonOk(c, await service(c).summary());
}

export async function cards(c: C) {
  return jsonOk(c, await service(c).cards(c.req.query()));
}

export async function claims(c: C) {
  return jsonOk(c, await service(c).claims(c.req.query()));
}

export function remoteWriteUnavailable(c: C) {
  return jsonRaw(
    c,
    501,
    "公众号会员卡外部写入尚未迁移：需要幂等投递记录、回调验签与重放边界后才能启用",
    {
      runtime_status: "not_migrated_requires_idempotent_outbox",
      catalog_authority: "postgresql_imported_history",
      remote_write_authority: "disabled",
      callback_authority: "disabled",
    },
  );
}
