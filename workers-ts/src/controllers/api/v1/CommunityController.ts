/**
 * 社区控制器
 *
 * 对应原版端点:
 *   - GET  /api/community/topic
 *   - GET  /api/community/list
 *   - GET  /api/community/detail/:id
 *   - POST /api/community/like/:id
 *   - POST /api/community/comment/save
 *   - GET  /api/community/comment/list
 *   - POST /api/community_save (发布)
 *   - DELETE /api/community_delete/:id
 *   - GET/POST /api/community/user_info, update_desc, set_interest
 *   - GET /api/community/follow_list, user_friend, recommend_list, follow
 */
import type { Context } from "hono";
import { jsonOk, jsonFail } from "@/utils/json";
import { ValidateException } from "@/utils/errors";
import { CommunityService } from "@/services/community/CommunityService";
import { CommunitySocialService } from "@/services/community/CommunitySocialService";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { parseConfigInteger } from "@/utils/config";
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const MAX_COMMUNITY_BODY_BYTES = 256 * 1024;

async function readJsonObject(c: C, maxBytes = MAX_COMMUNITY_BODY_BYTES): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ValidateException(`请求正文不能超过${Math.floor(maxBytes / 1024)} KiB`);
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
      throw new ValidateException(`请求正文不能超过${Math.floor(maxBytes / 1024)} KiB`);
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
  throw new ValidateException("请求正文格式错误");
}

function social(c: C) {
  return new CommunitySocialService(c.get("container"));
}

function config(c: C) {
  return new SystemConfigService(c.get("container"), c.env);
}

function flag(value: string | undefined, fallback = 1): 0 | 1 {
  return parseConfigInteger(value, fallback) === 0 ? 0 : 1;
}

async function moderationFlag(c: C, contentType: number): Promise<0 | 1> {
  const key = contentType === 2 ? "community_video_verify" : "community_verify";
  return flag(await config(c).get(key)) === 1 ? 0 : 1;
}

/** GET /api/community/config — feature flags consumed by PHP clients. */
export async function communityConfig(c: C) {
  const values = await config(c).getMany([
    "community_status",
    "community_comment_status",
    "community_comment_add",
  ]);
  return jsonOk(c, {
    community_status: flag(values.community_status),
    community_comment_status: flag(values.community_comment_status),
    community_comment_add: flag(values.community_comment_add),
  });
}

/** GET /api/community/topic — 可用话题 */
export async function communityTopic(c: C) {
  const svc = new CommunityService(c.get("container"));
  return jsonOk(c, await svc.topics());
}

/** GET /api/community/list — 帖子列表 */
export async function communityList(c: C) {
  const q = c.req.query();
  const svc = new CommunityService(c.get("container"));
  try {
    return jsonOk(c, await svc.list(q, 10, c.get("uid") || undefined));
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /api/community/detail/:id — 帖子详情 */
export async function communityDetail(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const svc = new CommunityService(c.get("container"));
  try {
    return jsonOk(c, await svc.detail(id, c.get("uid") || undefined));
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
  const body = await readJsonObject(c, 4 * 1024);
  const status = body.status === 0 ? 0 : 1;
  const svc = new CommunityService(c.get("container"));
  const result = await svc.like(uid, id, status);
  return jsonOk(c, result, status === 1 ? "点赞成功" : "取消点赞");
}

/** POST /api/community_save — 发布帖子 */
export async function communitySave(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = await readJsonObject(c);
  const svc = new CommunityService(c.get("container"));
  try {
    const contentType = Number(body.content_type ?? 1);
    return jsonOk(
      c,
      await svc.create(uid, {
        title: typeof body.title === "string" ? body.title : "",
        content: typeof body.content === "string" ? body.content : "",
        contentType,
        image: typeof body.image === "string" ? body.image : undefined,
        videoUrl: typeof body.video_url === "string" ? body.video_url : undefined,
        sliderImage: Array.isArray(body.slider_image) ? body.slider_image.map(String) : undefined,
        topicIds: Array.isArray(body.topic_id) ? body.topic_id.map(Number) : undefined,
        productIds: Array.isArray(body.product_id) ? body.product_id.map(Number) : undefined,
      }, await moderationFlag(c, contentType)),
      "添加社区内容成功!",
    );
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/community/community_update/:id — owner-scoped edit and re-review. */
export async function communityUpdate(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const id = Number(c.req.param("id") ?? "0");
  const body = await readJsonObject(c);
  const contentType = Number(body.content_type ?? body.contentType ?? 1);
  try {
    return jsonOk(
      c,
      await new CommunityService(c.get("container")).update(
        uid,
        id,
        body,
        await moderationFlag(c, contentType),
      ),
      "提交成功",
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
  try {
    return jsonOk(
      c,
      await svc.commentList(
        communityId,
        Number(q.page ?? 1),
        Number(q.limit ?? 10),
        c.get("uid") || undefined,
        Number(q.reply_id ?? 0),
      ),
    );
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/community/comment/save — 发表评论 */
export async function communityCommentSave(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = await readJsonObject(c, 8 * 1024);
  const communityId = Number(body.community_id ?? 0);
  if (!Number.isSafeInteger(communityId) || communityId <= 0) return jsonFail(c, "参数错误");
  const svc = new CommunityService(c.get("container"));
  try {
    const values = await config(c).getMany([
      "community_comment_status",
      "community_comment_add",
      "community_comment_verify",
    ]);
    if (flag(values.community_comment_status) === 0) return jsonFail(c, "评论功能未开启");
    if (flag(values.community_comment_add) === 0) return jsonFail(c, "评论发布功能未开启");
    const isVerify: 0 | 1 = flag(values.community_comment_verify, 0) === 1 ? 0 : 1;
    return jsonOk(
      c,
      await svc.addComment(uid, {
        communityId,
        content: typeof body.content === "string" ? body.content : "",
        replyCommentId: Number(body.comment_reply_id ?? 0),
        ip: c.req.header("CF-Connecting-IP") ?? "",
        isVerify,
      }),
      isVerify === 1 ? "评论成功" : "评论成功，等待审核",
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

/** GET /api/community/product_list — current user's purchased/collected/visited products. */
export async function communityProductList(c: C) {
  try {
    return jsonOk(
      c,
      await new CommunityService(c.get("container")).userProductList(
        c.get("uid") || undefined,
        c.req.query(),
      ),
    );
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /api/community/topic_count/:id */
export async function communityTopicCount(c: C) {
  try {
    return jsonOk(
      c,
      await new CommunityService(c.get("container")).topicCount(Number(c.req.param("id") ?? "0")),
    );
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /api/community/like_list */
export async function communityLikeList(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  try {
    return jsonOk(c, await new CommunityService(c.get("container")).likedPosts(uid, c.req.query()));
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /api/community/elegant_list */
export async function communityElegantList(c: C) {
  try {
    return jsonOk(
      c,
      await new CommunityService(c.get("container")).elegantPosts(
        c.get("uid") || undefined,
        Number(c.req.query("product_id") ?? "0"),
        c.req.query(),
      ),
    );
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /api/community/share/:id */
export async function communityShare(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  try {
    return jsonOk(
      c,
      await new CommunityService(c.get("container")).share(Number(c.req.param("id") ?? "0")),
      "分享成功",
    );
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/community/comment_like/:id */
export async function communityCommentLike(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = await readJsonObject(c, 4 * 1024);
  const status = body.status === 0 ? 0 : 1;
  try {
    return jsonOk(
      c,
      await new CommunityService(c.get("container")).likeComment(
        uid,
        Number(c.req.param("id") ?? "0"),
        status,
      ),
      status === 1 ? "点赞成功" : "取消点赞",
    );
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** DELETE /api/community/comment_delete/:id */
export async function communityCommentDelete(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  try {
    await new CommunityService(c.get("container")).deleteComment(
      uid,
      Number(c.req.param("id") ?? "0"),
    );
    return jsonOk(c, null, "删除成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /api/community/user_friend — referral-derived friend profiles */
export async function communityUserFriend(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const query = c.req.query();
  return jsonOk(
    c,
    await social(c).friendList(
      uid,
      Number(query.page ?? 1),
      Number(query.limit ?? 10),
    ),
  );
}

/** GET /api/community/user_info/:authorUid — PHP-compatible community profile. */
export async function communityUserInfo(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  return jsonOk(c, await social(c).profile(c.req.param("authorUid"), uid));
}

/** POST /api/community/update_desc — update only the authenticated profile. */
export async function communityUpdateDesc(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = await readJsonObject(c, 4 * 1024);
  return jsonOk(c, await social(c).updateDescription(uid, body.desc), "修改成功");
}

/** POST /api/community/set_interest/:authorUid — idempotent follow/unfollow. */
export async function communitySetInterest(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = await readJsonObject(c, 4 * 1024);
  const result = await social(c).setInterest(uid, c.req.param("authorUid"), body.status);
  return jsonOk(c, result, result.status === 1 ? "关注成功" : "取消成功");
}

/** GET /api/community/follow_list/:type — deduplicated legacy follow graph. */
export async function communityFollowList(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const kind = c.req.param("type");
  if (kind !== "follow" && kind !== "fans") return jsonFail(c, "参数错误");
  const query = c.req.query();
  return jsonOk(c, await social(c).followList(uid, kind, query.page, query.limit));
}

/** GET /api/community/recommend_list — active authors not already followed. */
export async function communityRecommendList(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const query = c.req.query();
  return jsonOk(c, await social(c).recommendations(uid, query.page, query.limit));
}

/** GET /api/community/follow — up to ten followed authors, unread first. */
export async function communityFollow(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  return jsonOk(c, await social(c).followHighlights(uid));
}

/** PUT /api/community/browse/:id — durable replacement for PHP Redis browse sets. */
export async function communityBrowse(c: C) {
  await social(c).recordBrowse(c.req.param("id"), c.get("uid") || undefined);
  return jsonOk(c, null, "浏览成功");
}
