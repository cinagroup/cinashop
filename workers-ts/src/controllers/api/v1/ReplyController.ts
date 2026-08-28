/**
 * 商品评价控制器
 *
 * 对应原版端点:
 *   - GET  /reply/config/:productId  评价统计
 *   - GET  /reply/list/:productId    评价列表
 *   - POST /reply/submit             提交评价
 *   - POST /reply/praise/:id         评价点赞
 */
import type { Context } from "hono";
import { jsonOk, jsonFail } from "@/utils/json";
import { ValidateException } from "@/utils/errors";
import { ReplyService } from "@/services/product/ReplyService";
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

/** GET /reply/config/:productId — 评价统计 */
export async function replyConfig(c: C) {
  const productId = Number(c.req.param("productId") ?? "0");
  if (!Number.isSafeInteger(productId) || productId <= 0) return jsonFail(c, "参数错误");
  const svc = new ReplyService(c.get("container"));
  return jsonOk(c, await svc.replyConfig(productId));
}

/** GET /reply/list/:productId — 评价列表 */
export async function replyList(c: C) {
  const productId = Number(c.req.param("productId") ?? "0");
  if (!Number.isSafeInteger(productId) || productId <= 0) return jsonFail(c, "参数错误");
  const q = c.req.query();
  const svc = new ReplyService(c.get("container"));
  return jsonOk(
    c,
    await svc.replyList(
      productId,
      Number(q.page ?? 1),
      Number(q.limit ?? 10),
      c.get("uid") ?? 0,
      Number(q.type ?? 0),
    ),
  );
}

/** GET /reply/comment/:id — public nested replies for a product review. */
export async function commentList(c: C) {
  const replyId = Number(c.req.param("id") ?? "0");
  if (!Number.isSafeInteger(replyId) || replyId <= 0) return jsonFail(c, "缺少参数");
  const q = c.req.query();
  return jsonOk(c, await new ReplyService(c.get("container")).commentList(
    replyId,
    Number(q.page ?? 1),
    Number(q.limit ?? 10),
    c.get("uid") ?? 0,
  ));
}

/** POST /reply/submit — 提交评价 (订单完成后) */
export async function submitReply(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    unique?: string;
    comment?: string;
    productScore?: unknown;
    product_score?: unknown;
    serviceScore?: unknown;
    service_score?: unknown;
    logisticsScore?: unknown;
    logistics_score?: unknown;
    delivery_score?: unknown;
    replyScore?: unknown;
    reply_score?: unknown;
    pics?: unknown;
  };
  const svc = new ReplyService(c.get("container"));
  try {
    const result = await svc.submitReply(uid, {
      unique: body.unique ?? "",
      comment: body.comment ?? "",
      productScore: body.productScore ?? body.product_score ?? 5,
      serviceScore: body.serviceScore ?? body.service_score ?? 5,
      logisticsScore:
        body.logisticsScore ?? body.logistics_score ?? body.delivery_score ?? 5,
      replyScore: body.replyScore ?? body.reply_score ?? 3,
      pics: body.pics,
    });
    return jsonOk(c, result, "评价成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /reply/praise/:id — 评价点赞 */
export async function praiseReply(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const id = Number(c.req.param("id") ?? "0");
  if (!Number.isSafeInteger(id) || id <= 0) return jsonFail(c, "参数错误");
  const svc = new ReplyService(c.get("container"));
  return jsonOk(c, await svc.praise(uid, id));
}

/** POST /reply/un_reply_praise/:id — 取消评价点赞 */
export async function unpraiseReply(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const id = Number(c.req.param("id") ?? "0");
  if (!Number.isSafeInteger(id) || id <= 0) return jsonFail(c, "参数错误");
  const svc = new ReplyService(c.get("container"));
  return jsonOk(c, await svc.unpraise(uid, id));
}
