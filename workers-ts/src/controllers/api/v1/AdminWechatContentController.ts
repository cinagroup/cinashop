import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { WechatContentService } from "@/services/wechat/WechatContentService";
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

function service(c: C): WechatContentService {
  return new WechatContentService(c.get("container"));
}

export async function reservedReply(c: C) {
  return jsonOk(c, await service(c).reservedReply(c.req.query("key")));
}

export async function replyList(c: C) {
  return jsonOk(c, await service(c).replyList(c.req.query()));
}

export async function replyDetail(c: C) {
  return jsonOk(c, { info: await service(c).replyDetail(c.req.param("id")) });
}

export async function saveReply(c: C) {
  return jsonOk(
    c,
    await service(c).saveReply(c.req.param("id"), await boundedBody(c)),
    "保存成功",
  );
}

export async function deleteReply(c: C) {
  await service(c).deleteReply(c.req.param("id"));
  return jsonOk(c, null, "删除成功");
}

export async function setReplyStatus(c: C) {
  await service(c).setReplyStatus(c.req.param("id"), c.req.param("status"));
  return jsonOk(c, null, "设置成功");
}

export async function mediaList(c: C) {
  return jsonOk(c, await service(c).mediaList(c.req.query()));
}

export async function newsList(c: C) {
  return jsonOk(c, await service(c).newsList(c.req.query()));
}

export async function newsDetail(c: C) {
  return jsonOk(c, { info: await service(c).newsDetail(c.req.param("id")) });
}

export async function saveNews(c: C) {
  return jsonOk(c, await service(c).saveNews(await boundedBody(c)), "保存成功");
}

export async function deleteNews(c: C) {
  await service(c).deleteNews(c.req.param("id"));
  return jsonOk(c, null, "删除成功");
}

export async function messageList(c: C) {
  return jsonOk(c, await service(c).messageList(c.req.query()));
}

export async function messageTypes(c: C) {
  return jsonOk(c, await service(c).messageTypes());
}

export function replyQrUnavailable(): never {
  throw new ValidateException("回复二维码依赖尚未迁移的 qrcode 表和公众号接口，本批未启用外部调用");
}

export function pushUnavailable(): never {
  throw new ValidateException("公众号群发需要可重试队列、幂等投递记录和微信凭据，本批不会同步调用外部接口");
}
