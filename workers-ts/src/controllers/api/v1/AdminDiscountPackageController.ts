import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { AdminDiscountPackageService } from "@/services/activity/AdminDiscountPackageService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

const MAX_BODY_BYTES = 512 * 1024;

async function boundedBody(c: C): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ValidateException("请求数据不能超过512 KiB");
  }
  const stream = c.req.raw.body;
  if (!stream) return {};
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ValidateException("请求数据不能超过512 KiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Normalized below.
  }
  throw new ValidateException("请求数据格式错误");
}

function service(c: C) {
  return new AdminDiscountPackageService(c.get("container"));
}

function positivePathInteger(c: C, key: string, field: string): number {
  const value = Number(c.req.param(key));
  if (!Number.isSafeInteger(value) || value <= 0) throw new ValidateException(`${field}格式错误`);
  return value;
}

export async function list(c: C) {
  return jsonOk(c, await service(c).list(c.req.query()));
}

export async function detail(c: C) {
  return jsonOk(c, await service(c).detail(positivePathInteger(c, "id", "套餐 ID")));
}

export async function productOptions(c: C) {
  return jsonOk(c, await service(c).productOptions(c.req.query()));
}

export async function labelOptions(c: C) {
  return jsonOk(c, await service(c).labelOptions(c.req.query()));
}

export async function save(c: C) {
  return jsonOk(c, await service(c).save(await boundedBody(c)), "保存成功");
}

export async function setStatus(c: C) {
  const id = positivePathInteger(c, "id", "套餐 ID");
  const status = Number(c.req.param("status"));
  if (status !== 0 && status !== 1) throw new ValidateException("套餐状态格式错误");
  return jsonOk(c, await service(c).setStatus(id, status), "操作成功");
}

export async function remove(c: C) {
  return jsonOk(c, await service(c).remove(positivePathInteger(c, "id", "套餐 ID")), "删除成功");
}
