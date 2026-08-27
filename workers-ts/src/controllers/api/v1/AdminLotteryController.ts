import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { LotteryAdminService } from "@/services/activity/LotteryAdminService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

const MAX_BODY_BYTES = 256 * 1024;

async function boundedBody(c: C): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ValidateException("请求数据不能超过256 KiB");
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
      throw new ValidateException("请求数据不能超过256 KiB");
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

function service(c: C): LotteryAdminService {
  return new LotteryAdminService(c.get("container"));
}

export async function list(c: C) {
  return jsonOk(c, await service(c).list(c.req.query()));
}

export async function detail(c: C) {
  return jsonOk(c, await service(c).detail(c.req.param("id")));
}

export async function factorInfo(c: C) {
  return jsonOk(c, await service(c).factorInfo(c.req.param("factor")));
}

export async function add(c: C) {
  return jsonOk(c, await service(c).save(undefined, await boundedBody(c)), "保存成功");
}

export async function edit(c: C) {
  return jsonOk(c, await service(c).save(c.req.param("id"), await boundedBody(c)), "保存成功");
}

export async function remove(c: C) {
  await service(c).delete(c.req.param("id"));
  return jsonOk(c, null, "删除成功");
}

export async function setStatus(c: C) {
  await service(c).setStatus(c.req.param("id"), c.req.param("status"));
  return jsonOk(c, null, "设置成功");
}

export async function records(c: C) {
  return jsonOk(c, await service(c).records(c.req.query()));
}

export async function activityRecords(c: C) {
  return jsonOk(c, await service(c).records(c.req.query(), c.req.param("id")));
}

export async function recordDetail(c: C) {
  return jsonOk(c, await service(c).recordDetail(c.req.param("id")));
}

export async function deliver(c: C) {
  await service(c).deliver(await boundedBody(c), c.req.param("id") || undefined);
  return jsonOk(c, null, "处理成功");
}
