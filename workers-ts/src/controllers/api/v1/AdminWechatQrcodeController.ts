import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { WechatContentService } from "@/services/wechat/WechatContentService";
import { OfficialAccountQrcodeService } from "@/services/wechat/OfficialAccountQrcodeService";
import { WechatQrcodeAdminService } from "@/services/wechat/WechatQrcodeAdminService";
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

function service(c: C): WechatQrcodeAdminService {
  return new WechatQrcodeAdminService(c.get("container"), c.env);
}

export async function categoryList(c: C) {
  return jsonOk(c, await service(c).categoryList());
}

export async function categoryDetail(c: C) {
  return jsonOk(c, { info: await service(c).categoryDetail(c.req.param("id")) });
}

export async function saveCategory(c: C) {
  return jsonOk(c, await service(c).saveCategory(await boundedBody(c)), "保存成功");
}

export async function deleteCategory(c: C) {
  await service(c).deleteCategory(c.req.param("id"));
  return jsonOk(c, null, "删除成功");
}

export async function channelList(c: C) {
  return jsonOk(c, await service(c).channelList(c.req.query()));
}

export async function channelDetail(c: C) {
  return jsonOk(c, { info: await service(c).channelDetail(c.req.param("id")) });
}

export async function saveChannel(c: C) {
  return jsonOk(
    c,
    await service(c).saveChannel(c.req.param("id"), await boundedBody(c)),
    "保存成功，二维码将异步生成",
  );
}

export async function deleteChannel(c: C) {
  await service(c).deleteChannel(c.req.param("id"));
  return jsonOk(c, null, "删除成功");
}

export async function setChannelStatus(c: C) {
  await service(c).setChannelStatus(c.req.param("id"), c.req.param("status"));
  return jsonOk(c, null, "设置成功");
}

export async function provisionChannel(c: C) {
  return jsonOk(c, await service(c).provisionChannel(c.req.param("id")), "已提交生成任务");
}

export async function channelUsers(c: C) {
  return jsonOk(c, await service(c).userList(c.req.param("qid"), c.req.query()));
}

export async function channelStatistics(c: C) {
  return jsonOk(c, await service(c).statistics(c.req.param("qid"), c.req.query()));
}

export async function replyCodeStatus(c: C) {
  const container = c.get("container");
  const id = Number(c.req.param("id"));
  await new WechatContentService(container).replyDetail(id);
  return jsonOk(c, await new OfficialAccountQrcodeService(container, c.env).status("reply", id));
}

export async function provisionReplyCode(c: C) {
  const container = c.get("container");
  const id = Number(c.req.param("id"));
  await new WechatContentService(container).replyDetail(id);
  return jsonOk(
    c,
    await new OfficialAccountQrcodeService(container, c.env).requestPermanent("reply", id),
    "已提交生成任务",
  );
}
