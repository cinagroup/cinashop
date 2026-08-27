import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { UserBehaviorService } from "@/services/user/UserBehaviorService";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

export function clientIp(c: C): string {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    ""
  );
}

function clientRegion(c: C): string {
  return String((c.req.raw.cf as { region?: string } | undefined)?.region ?? "");
}

export async function searchList(c: C) {
  const service = new UserBehaviorService(c.get("container"));
  return jsonOk(
    c,
    await service.searchHistory(c.get("uid"), c.req.query("page"), c.req.query("limit")),
  );
}

export async function cleanSearch(c: C) {
  await new UserBehaviorService(c.get("container")).cleanSearchHistory(c.get("uid"));
  return jsonOk(c, null, "删除成功");
}

export async function setVisit(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    url?: string;
    stay_time?: unknown;
  };
  await new UserBehaviorService(c.get("container")).recordVisit({
    uid: c.get("uid"),
    url: String(body.url ?? ""),
    stayTime: body.stay_time,
    ip: clientIp(c),
    province: clientRegion(c),
  });
  return jsonOk(c, null, "添加用户访问记录成功");
}
