import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { KefuInboxService, inboxInteger } from "@/services/kefu/KefuInboxService";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function scoped(c: C) {
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Authorization, Authori-zation, Cookie");
  return { service: new KefuInboxService(c.get("container")), principal: { id: c.get("kefuId") ?? 0, uid: c.get("kefuUid") ?? 0 } };
}
export async function list(c: C) {
  const { service, principal } = scoped(c);
  return jsonOk(c, await service.list(principal, c.req.query()));
}
export async function detail(c: C) {
  const { service, principal } = scoped(c);
  return jsonOk(c, await service.detail(principal, inboxInteger(c.req.param("id"), 0)));
}
export async function markRead(c: C) {
  const { service, principal } = scoped(c);
  return jsonOk(c, await service.markRead(principal, inboxInteger(c.req.param("id"), 0)));
}
