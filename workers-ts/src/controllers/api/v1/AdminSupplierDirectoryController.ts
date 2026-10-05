import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { AdminSupplierDirectoryService, type SupplierDirectoryActor } from "@/services/admin/AdminSupplierDirectoryService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";
import { readBoundedJsonObject } from "@/utils/request-body";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C) {
  return new AdminSupplierDirectoryService(c.get("container"));
}

function noStore(c: C) {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
}

function actor(c: C): SupplierDirectoryActor {
  const admin = c.get("adminInfo");
  if (!admin || !Number.isSafeInteger(admin.id) || admin.id <= 0) {
    throw new ValidateException("管理员身份缺失");
  }
  return {
    id: admin.id,
    name: admin.realName || admin.account,
    ip: (c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0] ?? "")
      .trim().slice(0, 45),
  };
}

async function body(c: C) {
  return readBoundedJsonObject(c.req.raw, 4 * 1024);
}

export async function list(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).list(new URL(c.req.url).searchParams));
}

export async function detail(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).detail(c.req.param("id")));
}

export async function create(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).create(await body(c), actor(c)), "添加成功");
}

export async function update(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).update(c.req.param("id"), await body(c), actor(c)), "修改成功");
}

export async function setStatus(c: C) {
  noStore(c);
  const result = await service(c).setStatus(c.req.param("id"), c.req.param("status"), await body(c), actor(c));
  return jsonOk(c, result, result.is_show === 1 ? "开启成功" : "关闭成功");
}

export async function remove(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).delete(c.req.param("id"), await body(c), actor(c)), "删除成功");
}
