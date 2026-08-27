import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { LegacyContentService } from "@/services/system/LegacyContentService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

async function boundedBody(c: C, maxBytes: number): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ValidateException(`请求数据不能超过${Math.trunc(maxBytes / 1024)} KiB`);
  }
  const stream = c.req.raw.body;
  if (!stream) throw new ValidateException("请求数据格式错误");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("request body too large");
      throw new ValidateException(`请求数据不能超过${Math.trunc(maxBytes / 1024)} KiB`);
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
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Normalized below.
  }
  throw new ValidateException("请求数据格式错误");
}

function service(c: C) {
  return new LegacyContentService(c.get("container"));
}

function adminId(c: C): number {
  const id = c.get("adminId") ?? 0;
  if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("管理员参数错误");
  return id;
}

export async function getKfAdv(c: C) {
  return jsonOk(c, { content: await service(c).kfAdv() });
}

export async function setKfAdv(c: C) {
  const body = await boundedBody(c, 256 * 1024);
  return jsonOk(c, { content: await service(c).saveKfAdv(body.content) }, "设置成功");
}

export async function getOpenAdv(c: C) {
  return jsonOk(c, await service(c).openAdv());
}

export async function setOpenAdv(c: C) {
  return jsonOk(c, await service(c).saveOpenAdv(await boundedBody(c, 256 * 1024)), "保存成功");
}

export async function getUniAppUrls(c: C) {
  return jsonOk(c, { url: await service(c).uniAppUrls() });
}

export async function getAgreement(c: C) {
  return jsonOk(c, { content: await service(c).agreement(c.req.param("type")) });
}

export async function setAgreement(c: C) {
  const body = await boundedBody(c, 256 * 1024);
  return jsonOk(
    c,
    { content: await service(c).saveAgreement(c.req.param("type"), body.content) },
    "设置成功",
  );
}

export async function runtimeContent(c: C) {
  return jsonOk(c, await service(c).runtimeContent());
}

export async function saveRuntimeContent(c: C) {
  return jsonOk(
    c,
    await service(c).saveRuntimeContent(await boundedBody(c, 512 * 1024)),
    "保存成功",
  );
}

export async function getProductDraft(c: C) {
  return jsonOk(c, { info: await service(c).productDraft(adminId(c)) });
}

export async function saveProductDraft(c: C) {
  return jsonOk(
    c,
    { info: await service(c).saveProductDraft(adminId(c), await boundedBody(c, 512 * 1024)) },
    "草稿已保存",
  );
}

export async function deleteProductDraft(c: C) {
  await service(c).deleteProductDraft(adminId(c));
  return jsonOk(c, null, "草稿已删除");
}
