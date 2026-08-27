import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { PageNavigationService } from "@/services/content/PageNavigationService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

const MAX_BODY_BYTES = 8 * 1024;

function service(c: C): PageNavigationService {
  return new PageNavigationService(c.get("container"));
}

async function body(c: C): Promise<Record<string, unknown>> {
  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new ValidateException("请求数据不能超过8 KiB");
  }
  const contentType = (c.req.header("content-type") ?? "application/json")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json" && contentType !== "application/x-www-form-urlencoded") {
    throw new ValidateException("请求数据类型不支持");
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
  const raw = new TextDecoder().decode(bytes);

  let value: unknown;
  if (contentType === "application/x-www-form-urlencoded") {
    value = Object.fromEntries(new URLSearchParams(raw));
  } else {
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("请求数据格式错误");
  }
  return value as Record<string, unknown>;
}

export async function getPageCategory(c: C) {
  return jsonOk(c, await service(c).categoryTree());
}

export async function getPageLinks(c: C) {
  return jsonOk(c, await service(c).links(c.req.param("cate_id"), c.req.query()));
}

export async function savePageLink(c: C) {
  return jsonOk(
    c,
    await service(c).saveLink(c.req.param("cate_id"), await body(c)),
    "保存成功",
  );
}

export async function deletePageLink(c: C) {
  await service(c).deleteLink(c.req.param("id"));
  return jsonOk(c, null, "删除成功");
}
