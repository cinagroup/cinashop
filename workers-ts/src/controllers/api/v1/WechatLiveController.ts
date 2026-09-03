import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import {
  type AdminLiveActor,
  WechatLiveService,
} from "@/services/wechat/WechatLiveService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";
import { readBoundedJsonObject } from "@/utils/request-body";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const MAX_ANCHOR_BODY_BYTES = 16 * 1024;

function service(c: C): WechatLiveService {
  return new WechatLiveService(c.get("container"), c.env);
}

function actor(c: C): AdminLiveActor {
  const admin = c.get("adminInfo");
  if (!admin) throw new ValidateException("管理员身份不存在");
  const ip = (c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0] ?? "")
    .trim().slice(0, 45);
  return { id: admin.id, name: admin.realName || admin.account, ip };
}

function noStore(c: C): void {
  c.header("Cache-Control", "private, no-store");
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
  noStore(c);
  return jsonOk(c, await service(c).adminRooms(c.req.query()));
}

export async function adminRoomDetail(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).adminRoomDetail(c.req.param("id")));
}

export async function adminRoomShow(c: C) {
  noStore(c);
  const show = c.req.param("is_show");
  return jsonOk(
    c,
    await service(c).setRoomVisibility(c.req.param("id"), show, actor(c)),
    Number(show) === 1 ? "直播间已显示并核验" : "直播间已隐藏并核验",
  );
}

export async function adminRoomDelete(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).removeRoom(c.req.param("id"), actor(c)), "直播间已删除并核验");
}

export async function adminGoods(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).adminGoods(c.req.query()));
}

export async function adminGoodsDetail(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).adminGoodsDetail(c.req.param("id")));
}

export async function adminGoodsShow(c: C) {
  noStore(c);
  const show = c.req.param("is_show");
  return jsonOk(
    c,
    await service(c).setGoodsVisibility(c.req.param("id"), show, actor(c)),
    Number(show) === 1 ? "直播商品已显示并核验" : "直播商品已隐藏并核验",
  );
}

export async function adminAnchors(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).adminAnchors(c.req.query()));
}

export async function adminAnchorForm(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).adminAnchorForm(c.req.param("id")));
}

export async function adminAnchorSave(c: C) {
  noStore(c);
  const result = await service(c).saveAnchor(
    await readBoundedJsonObject(c.req.raw, MAX_ANCHOR_BODY_BYTES),
    actor(c),
  );
  return jsonOk(c, result, "主播已保存、身份已核验");
}

export async function adminAnchorShow(c: C) {
  noStore(c);
  const show = c.req.param("is_show");
  return jsonOk(
    c,
    await service(c).setAnchorVisibility(c.req.param("id"), show, actor(c)),
    Number(show) === 1 ? "主播已显示并核验" : "主播已隐藏并核验",
  );
}

export async function adminAnchorDelete(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).removeAnchor(c.req.param("id"), actor(c)), "主播已删除并核验");
}

export async function adminSync(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).enqueueSync(), "直播状态同步已进入队列");
}
