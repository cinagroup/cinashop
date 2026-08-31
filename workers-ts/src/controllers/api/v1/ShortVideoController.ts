import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { ShortVideoService } from "@/services/activity/ShortVideoService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C) {
  c.header("Cache-Control", "private, no-store");
  return new ShortVideoService(c.get("container"), c.env);
}

async function commentBody(c: C): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > 8 * 1024) throw new ValidateException("请求正文过大");
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > 8 * 1024) throw new ValidateException("请求正文过大");
  try {
    const parsed: unknown = JSON.parse(text || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Normalized below.
  }
  throw new ValidateException("请求正文格式错误");
}

export async function list(c: C) {
  const result = await service(c).list(c.get("uid") ?? 0, c.req.query());
  if (result.playIds.length) {
    c.executionCtx.waitUntil(
      service(c).recordPlays(result.playIds, c.get("uid") ?? 0)
        .catch((error) => emitOperationalEvent("error", {
          event: "short_video_play_record_failed",
          component: "http",
          operation: "analytics_write",
          outcome: "failure",
          errorCode: operationalErrorCode(error),
        })),
    );
  }
  return jsonOk(c, result.list);
}

export async function info(c: C) {
  return jsonOk(c, await service(c).info(c.req.param("id")));
}

export async function comments(c: C) {
  return jsonOk(c, await service(c).comments(
    c.get("uid") ?? 0,
    c.req.param("id"),
    0,
    c.req.query("page"),
    c.req.query("limit"),
  ));
}

export async function products(c: C) {
  return jsonOk(c, await service(c).products(c.get("uid") ?? 0, c.req.param("id")));
}

export async function saveComment(c: C) {
  const body = await commentBody(c);
  return jsonOk(c, await service(c).saveComment(
    c.get("uid"),
    c.req.param("id"),
    c.req.param("pid"),
    body.content,
  ), "评论成功");
}

export async function commentReplies(c: C) {
  return jsonOk(c, await service(c).commentReplies(
    c.get("uid"),
    c.req.param("pid"),
    c.req.query("page"),
    c.req.query("limit"),
  ));
}

export async function deleteComment(c: C) {
  return jsonOk(c, await service(c).deleteComment(c.get("uid"), c.req.param("id")), "删除成功");
}

export async function commentRelation(c: C) {
  const result = await service(c).toggleCommentRelation(c.get("uid"), c.req.param("type"), c.req.param("id"));
  return jsonOk(c, result, result.status ? "操作成功" : "取消成功");
}

export async function videoRelation(c: C) {
  const result = await service(c).toggleVideoRelation(c.get("uid"), c.req.param("type"), c.req.param("id"));
  return jsonOk(c, result, result.status ? "操作成功" : "取消成功");
}
