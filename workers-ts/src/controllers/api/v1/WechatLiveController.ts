import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { WechatLiveService } from "@/services/wechat/WechatLiveService";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C): WechatLiveService {
  return new WechatLiveService(c.get("container"), c.env);
}

export async function publicRooms(c: C) {
  return jsonOk(c, await service(c).publicRooms(c.req.query()));
}

export async function publicPlaybacks(c: C) {
  return jsonOk(
    c,
    await service(c).playbacks(c.req.param("id") ?? "", c.req.query()),
  );
}

export async function adminRooms(c: C) {
  return jsonOk(c, await service(c).adminRooms(c.req.query()));
}

export async function adminGoods(c: C) {
  return jsonOk(c, await service(c).adminGoods(c.req.query()));
}

export async function adminAnchors(c: C) {
  return jsonOk(c, await service(c).adminAnchors(c.req.query()));
}

export async function adminSync(c: C) {
  return jsonOk(c, await service(c).enqueueSync(), "直播状态同步已进入队列");
}
