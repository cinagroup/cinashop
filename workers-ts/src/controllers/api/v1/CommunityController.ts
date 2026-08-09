/**
 * 社区控制器
 *
 * 对应原版端点:
 *   - GET  /api/community/list
 *   - GET  /api/community/detail/:id
 *   - POST /api/community/like/:id
 *   - POST /api/community/comment/save
 *   - GET  /api/community/comment/list
 *   - POST /api/community_save (发布)
 *   - DELETE /api/community_delete/:id
 */
import type { Context } from "hono";
import { jsonOk, jsonFail } from "@/utils/json";
import { ValidateException } from "@/utils/errors";
import { CommunityService } from "@/services/community/CommunityService";
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

/** GET /api/community/list — 帖子列表 */
export async function communityList(c: C) {
  const q = c.req.query();
  const svc = new CommunityService(c.get("container"));
  return jsonOk(c, await svc.list(Number(q.page ?? 1), Number(q.limit ?? 10)));
}

/** GET /api/community/detail/:id — 帖子详情 */
export async function communityDetail(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const svc = new CommunityService(c.get("container"));
  try {
    return jsonOk(c, await svc.detail(id));
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/community/like/:id — 点赞 */
export async function communityLike(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const id = Number(c.req.param("id") ?? "0");
  const svc = new CommunityService(c.get("container"));
  await svc.like(id);
  return jsonOk(c, null, "点赞成功");
}

/** POST /api/community_save — 发布帖子 */
export async function communitySave(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    title?: string;
    content?: string;
    content_type?: number;
    image?: string;
    slider_image?: string[];
  };
  const svc = new CommunityService(c.get("container"));
  try {
    return jsonOk(
      c,
      await svc.create(uid, {
        title: body.title ?? "",
        content: body.content ?? "",
        contentType: body.content_type ?? 1,
        image: body.image,
        sliderImage: body.slider_image,
      }),
      "发布成功",
    );
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /api/community/comment/list — 评论列表 */
export async function communityCommentList(c: C) {
  const communityId = Number(c.req.query("community_id") ?? "0");
  if (!communityId) return jsonFail(c, "参数错误");
  const q = c.req.query();
  const svc = new CommunityService(c.get("container"));
  return jsonOk(
    c,
    await svc.commentList(communityId, Number(q.page ?? 1), Number(q.limit ?? 10)),
  );
}

/** POST /api/community/comment/save — 发表评论 */
export async function communityCommentSave(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    community_id?: number;
    content?: string;
  };
  if (!body.community_id) return jsonFail(c, "参数错误");
  const svc = new CommunityService(c.get("container"));
  try {
    return jsonOk(
      c,
      await svc.addComment(uid, {
        communityId: body.community_id,
        content: body.content ?? "",
      }),
      "评论成功",
    );
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** DELETE /api/community_delete/:id — 删除帖子 */
export async function communityDelete(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const id = Number(c.req.param("id") ?? "0");
  const svc = new CommunityService(c.get("container"));
  try {
    await svc.del(uid, id);
    return jsonOk(c, null, "删除成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}
