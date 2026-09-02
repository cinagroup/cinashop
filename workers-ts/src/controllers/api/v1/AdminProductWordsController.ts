import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { ProductWordsService, type ProductWordsActor } from "@/services/product/ProductWordsService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";
import { readBoundedJsonObject } from "@/utils/request-body";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const MAX_BODY_BYTES = 8 * 1024;

function service(c: C): ProductWordsService {
  return new ProductWordsService(c.get("container"));
}

function id(c: C): number {
  const value = Number(c.req.param("id"));
  if (!Number.isSafeInteger(value) || value <= 0) throw new ValidateException("热词ID错误");
  return value;
}

function actor(c: C): ProductWordsActor {
  const admin = c.get("adminInfo");
  if (!admin) throw new ValidateException("管理员身份不存在");
  return {
    id: admin.id,
    name: admin.realName || admin.account,
    ip: c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? "",
  };
}

function noStore(c: C): void {
  c.header("Cache-Control", "private, no-store");
}

export async function list(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).list(c.req.query()));
}

export async function all(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).allVisible());
}

export async function detail(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).detail(id(c)));
}

export async function save(c: C) {
  noStore(c);
  const wordId = Number(c.req.param("id") ?? "0");
  if (!Number.isSafeInteger(wordId) || wordId < 0) throw new ValidateException("热词ID错误");
  const result = await service(c).save(
    wordId,
    await readBoundedJsonObject(c.req.raw, MAX_BODY_BYTES),
    actor(c),
  );
  return jsonOk(c, result, wordId ? "修改成功" : "保存成功");
}

export async function setShow(c: C) {
  noStore(c);
  const isShow = Number(c.req.param("is_show"));
  await service(c).setShow(id(c), isShow, actor(c));
  return jsonOk(c, null, isShow === 1 ? "显示成功" : "隐藏成功");
}

export async function remove(c: C) {
  noStore(c);
  await service(c).delete(id(c), actor(c));
  return jsonOk(c, null, "删除成功");
}
