import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { LotteryService } from "@/services/activity/LotteryService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

const MAX_BODY_BYTES = 8 * 1024;

async function boundedBody(c: C): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ValidateException("请求数据不能超过8 KiB");
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
      throw new ValidateException("请求数据不能超过8 KiB");
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

function service(c: C): LotteryService {
  return new LotteryService(c.get("container"));
}

export async function info(c: C) {
  return jsonOk(c, await service(c).info(c.get("uid"), c.req.param("factor") || 1));
}

export async function draw(c: C) {
  return jsonOk(c, await service(c).draw(c.get("uid"), await boundedBody(c)), "抽奖成功");
}

export async function receive(c: C) {
  await service(c).receive(c.get("uid"), await boundedBody(c));
  return jsonOk(c, null, "领取成功");
}

export async function records(c: C) {
  return jsonOk(c, await service(c).records(c.get("uid"), c.req.query()));
}
