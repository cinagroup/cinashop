import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { OutApiService } from "@/services/out/OutApiService";
import { ValidateException } from "@/utils/errors";
import { jsonOk, jsonRaw } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const MAX_ADMIN_BODY_BYTES = 64 * 1024;

function service(c: C) {
  return new OutApiService(c.get("container"), c.env);
}

async function readJsonObject(c: C): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_ADMIN_BODY_BYTES) {
    throw new ValidateException("请求体过大");
  }
  const stream = c.req.raw.body;
  if (!stream) return {};
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_ADMIN_BODY_BYTES) {
      await reader.cancel("request body too large");
      throw new ValidateException("请求体过大");
    }
    chunks.push(next.value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(merged)) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ValidateException("JSON请求体无效");
  }
}

export async function accountList(c: C) {
  return jsonOk(c, await service(c).adminAccounts(c.req.query()));
}

export async function accountInfo(c: C) {
  return jsonOk(c, await service(c).adminAccountInfo(c.req.param("id")));
}

export async function accountCreate(c: C) {
  return jsonOk(c, await service(c).saveAdminAccount(0, await readJsonObject(c)), "保存成功");
}

export async function accountUpdate(c: C) {
  return jsonOk(
    c,
    await service(c).saveAdminAccount(c.req.param("id"), await readJsonObject(c)),
    "修改成功",
  );
}

export async function accountStatus(c: C) {
  return jsonOk(
    c,
    await service(c).setAdminAccountStatus(c.req.param("id"), c.req.param("status")),
    "设置成功",
  );
}

export async function accountDelete(c: C) {
  await service(c).deleteAdminAccount(c.req.param("id"));
  return jsonOk(c, null, "删除成功");
}

export async function interfaceList(c: C) {
  return jsonOk(c, await service(c).adminInterfaces());
}

export async function interfaceInfo(c: C) {
  return jsonOk(c, await service(c).adminInterfaceInfo(c.req.param("id")));
}

export async function auditList(c: C) {
  return jsonOk(c, await service(c).adminAuditList(c.req.query()));
}

export function pushUnavailable(c: C) {
  return jsonRaw(
    c,
    501,
    "外部推送未迁移：旧实现存储明文密码并允许请求任意URL",
    { runtime_status: "not_migrated_security_boundary" },
  );
}

export function interfaceWriteUnavailable(c: C) {
  return jsonRaw(
    c,
    501,
    "接口文档写入暂未迁移；当前目录来自已复制的PHP数据",
    { runtime_status: "read_only_catalog" },
  );
}
