import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { ShortVideoService } from "@/services/activity/ShortVideoService";
import { DiyHomeCompatibilityService } from "@/services/content/DiyHomeCompatibilityService";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C) {
  return new DiyHomeCompatibilityService(c.get("container"), c.env);
}

function noStore(c: C, personalized = false): void {
  c.header("Cache-Control", personalized ? "private, no-store" : "no-store");
}

export async function getDiy(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).getDiy(c.req.param("id")));
}

export async function diyVersion(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).diyVersion(c.req.param("id")));
}

export async function userInfo(c: C) {
  noStore(c, true);
  return jsonOk(c, await service(c).userInfo(c.get("uid") ?? 0));
}

export async function videoList(c: C) {
  noStore(c, true);
  const uid = c.get("uid") ?? 0;
  const result = await service(c).videoList(uid, c.req.query());
  if (result.playIds.length) {
    c.executionCtx.waitUntil(
      new ShortVideoService(c.get("container"), c.env)
        .recordPlays(result.playIds, uid)
        .catch((error) => console.error(JSON.stringify({
          event: "diy_home_video_play_record_failed",
          error: String(error),
        }))),
    );
  }
  return jsonOk(c, result.list);
}

export async function newcomerList(c: C) {
  noStore(c, true);
  return jsonOk(c, await service(c).newcomerList(c.get("uid") ?? 0, c.req.query()));
}

export async function productRank(c: C) {
  noStore(c, true);
  return jsonOk(c, await service(c).productRank(c.get("uid") ?? 0, c.req.query("limit")));
}

export async function sign(c: C) {
  noStore(c, true);
  return jsonOk(c, await service(c).homeSign(c.get("uid") ?? 0));
}

export async function suspended(c: C) {
  noStore(c, true);
  return jsonOk(c, await service(c).suspended());
}
