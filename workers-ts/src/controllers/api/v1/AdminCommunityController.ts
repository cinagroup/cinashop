import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { AdminCommunityService } from "@/services/community/AdminCommunityService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

const MAX_POST_BODY_BYTES = 512 * 1024;
const MAX_OPERATION_BODY_BYTES = 16 * 1024;

async function boundedBody(c: C, maxBytes = MAX_OPERATION_BODY_BYTES): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ValidateException(`请求数据不能超过${Math.ceil(maxBytes / 1024)} KiB`);
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
    if (total > maxBytes) {
      await reader.cancel();
      throw new ValidateException(`请求数据不能超过${Math.ceil(maxBytes / 1024)} KiB`);
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

function service(c: C): AdminCommunityService {
  return new AdminCommunityService(c.get("container"));
}

function clientIp(c: C): string {
  return (c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0] ?? "")
    .trim()
    .slice(0, 32);
}

function form(title: string, action: string, fields: Array<Record<string, unknown>>, method = "POST") {
  return { title, action, method, fields };
}

export async function allTopics(c: C) {
  return jsonOk(c, await service(c).topics(c.req.query(), true));
}

export async function topicList(c: C) {
  return jsonOk(c, await service(c).topics(c.req.query()));
}

export async function topicForm(c: C) {
  const id = Number(c.req.param("id") ?? 0);
  const info = id > 0 ? await service(c).topicDetail(id) : null;
  const definition = form("社区话题", `/community/topic/save/${id || 0}`, [
    { field: "name", title: "话题名称", type: "input", maxlength: 20, required: true },
    { field: "sort", title: "排序", type: "number", min: 0 },
    { field: "is_recommend", title: "推荐", type: "switch" },
    { field: "status", title: "显示", type: "switch" },
  ]);
  return jsonOk(c, { form: definition, info });
}

export async function topicSave(c: C) {
  const result = await service(c).saveTopic(c.req.param("id"), await boundedBody(c));
  return jsonOk(c, result, "保存成功");
}

export async function topicStatus(c: C) {
  await service(c).setTopicStatus(c.req.param("id"), c.req.param("status"));
  return jsonOk(c, null, "设置成功");
}

export async function topicRecommend(c: C) {
  await service(c).setTopicRecommend(c.req.param("id"), c.req.param("hot"));
  return jsonOk(c, null, "设置成功");
}

export async function topicDelete(c: C) {
  await service(c).deleteTopic(c.req.param("id"));
  return jsonOk(c, null, "删除成功");
}

export async function postHeader(c: C) {
  return jsonOk(c, await service(c).postHeader(c.req.query()));
}

export async function postList(c: C) {
  return jsonOk(c, await service(c).posts(c.req.query()));
}

export async function postInfo(c: C) {
  return jsonOk(c, await service(c).postDetail(c.req.param("id")));
}

export async function postSave(c: C) {
  const result = await service(c).savePost(c.req.param("id"), await boundedBody(c, MAX_POST_BODY_BYTES));
  return jsonOk(c, result, "保存社区内容成功");
}

export async function postStatus(c: C) {
  await service(c).setPostStatus(c.req.param("id"), c.req.param("status"));
  return jsonOk(c, null, Number(c.req.param("status")) === 1 ? "显示成功" : "隐藏成功");
}

export async function postStarForm(c: C) {
  const info = await service(c).postDetail(c.req.param("id"));
  return jsonOk(c, form("推荐指数", `/community/community/star/${info.id}`, [
    { field: "star", title: "推荐指数", type: "rate", min: 1, max: 5, value: info.star },
  ]));
}

export async function postStar(c: C) {
  const body = await boundedBody(c);
  await service(c).setPostStar(c.req.param("id"), body.star);
  return jsonOk(c, null, "设置成功");
}

export async function postRecommend(c: C) {
  await service(c).setPostRecommend(c.req.param("id"), c.req.param("recommend"));
  return jsonOk(c, null, "设置成功");
}

export async function postVerifyForm(c: C) {
  await service(c).postDetail(c.req.param("id"));
  return jsonOk(c, form("内容审核", `/community/community/set_verify/${c.req.param("id")}`, [
    { field: "is_verify", title: "审核状态", type: "radio", options: [{ value: 1, label: "通过" }, { value: -1, label: "拒绝" }] },
    { field: "refusal", title: "拒绝原因", type: "textarea", requiredWhen: { is_verify: -1 } },
  ]));
}

export async function postTakeDownForm(c: C) {
  await service(c).postDetail(c.req.param("id"));
  return jsonOk(c, form("强制下架", `/community/community/set_verify/${c.req.param("id")}`, [
    { field: "is_verify", type: "hidden", value: -2 },
    { field: "refusal", title: "下架原因", type: "textarea", required: true },
  ]));
}

export async function postVerify(c: C) {
  await service(c).setPostVerify(c.req.param("id"), await boundedBody(c));
  return jsonOk(c, null, "操作成功");
}

export async function postDelete(c: C) {
  await service(c).deletePost(c.req.param("id"));
  return jsonOk(c, null, "删除成功");
}

export async function commentList(c: C) {
  return jsonOk(c, await service(c).comments(c.req.query()));
}

export async function commentReplies(c: C) {
  return jsonOk(c, await service(c).commentReplies(c.req.param("id"), c.req.query()));
}

export async function commentReplyForm(c: C) {
  await service(c).commentReplies(c.req.param("id"), { page: "1", limit: "1" });
  return jsonOk(c, form("回复内容", `/community/comment/reply/${c.req.param("id")}`, [
    { field: "content", title: "回复内容", type: "textarea", required: true, maxlength: 1000 },
  ]));
}

export async function commentReply(c: C) {
  const result = await service(c).replyComment(c.req.param("id"), await boundedBody(c), clientIp(c));
  return jsonOk(c, result, "回复成功");
}

export async function commentVerifyForm(c: C) {
  return jsonOk(c, form("评论审核", `/community/comment/set_verify/${c.req.param("id")}`, [
    { field: "is_verify", title: "审核状态", type: "radio", options: [{ value: 1, label: "通过" }, { value: -1, label: "拒绝" }] },
  ]));
}

export async function commentTakeDownForm(c: C) {
  return jsonOk(c, form("强制下架", `/community/comment/set_verify/${c.req.param("id")}`, [
    { field: "is_verify", type: "hidden", value: -2 },
  ]));
}

export async function commentStatus(c: C) {
  await service(c).setCommentStatus(c.req.param("id"), c.req.param("status"));
  return jsonOk(c, null, "操作成功");
}

export async function commentVerify(c: C) {
  await service(c).setCommentVerify(c.req.param("id"), await boundedBody(c));
  return jsonOk(c, null, "操作成功");
}

export async function fictitiousCommentForm(c: C) {
  return jsonOk(c, form("添加虚拟评论", "/community/comment/save_fictitious", [
    { field: "community_id", type: "hidden", value: Number(c.req.param("id")) },
    { field: "type", title: "评论类型", type: "radio", options: [{ value: 0, label: "商家评论" }, { value: 3, label: "虚拟评论" }] },
    { field: "nickname", title: "用户名称", type: "input", maxlength: 64 },
    { field: "avatar", title: "用户头像", type: "input", maxlength: 255 },
    { field: "add_time", title: "评论时间", type: "datetime" },
    { field: "content", title: "评论内容", type: "textarea", maxlength: 1000, required: true },
  ]));
}

export async function saveFictitiousComment(c: C) {
  const result = await service(c).saveFictitiousComment(await boundedBody(c), clientIp(c));
  return jsonOk(c, result, "添加成功");
}

export async function commentDelete(c: C) {
  await service(c).deleteComment(c.req.param("id"));
  return jsonOk(c, null, "删除成功");
}
