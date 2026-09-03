import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import {
  AdminCommerceSettingsService,
  type CommerceSettingsActor,
} from "@/services/system/AdminCommerceSettingsService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";
import { readBoundedJsonObject } from "@/utils/request-body";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const MAX_COMMERCE_SETTINGS_BODY_BYTES = 32 * 1024;

function service(c: C) {
  return new AdminCommerceSettingsService(c.get("container"), c.env);
}

function clientIp(c: C): string {
  return (c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0] ?? "")
    .trim()
    .slice(0, 45);
}

function actor(c: C): CommerceSettingsActor {
  const admin = c.get("adminInfo");
  if (!admin) throw new ValidateException("管理员身份不存在");
  return {
    adminId: admin.id,
    adminName: admin.realName || admin.account,
    ip: clientIp(c),
  };
}

function noStore(c: C): void {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
}

export async function settings(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).settings());
}

export async function save(c: C) {
  noStore(c);
  return jsonOk(
    c,
    await service(c).save(
      actor(c),
      await readBoundedJsonObject(c.req.raw, MAX_COMMERCE_SETTINGS_BODY_BYTES),
    ),
    "商城运行设置已保存",
  );
}
