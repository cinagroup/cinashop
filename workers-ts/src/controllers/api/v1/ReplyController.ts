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
  if (!productId) return jsonFail(c, "参数错误");
  const svc = new ReplyService(c.get("container"));
  return jsonOk(c, await svc.replyConfig(productId));
}

/** GET /reply/list/:productId — 评价列表 */
export async function replyList(c: C) {
  const productId = Number(c.req.param("productId") ?? "0");
  if (!productId) return jsonFail(c, "参数错误");
  const q = c.req.query();
  const svc = new ReplyService(c.get("container"));
  return jsonOk(c, await svc.replyList(productId, Number(q.page ?? 1), Number(q.limit ?? 10)));
}

/** POST /reply/submit — 提交评价 (订单完成后) */
export async function submitReply(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    unique?: string;
    comment?: string;
    productScore?: number;
    serviceScore?: number;
    logisticsScore?: number;
    pics?: string[];
  };
  const svc = new ReplyService(c.get("container"));
  try {
    const result = await svc.submitReply(uid, {
      unique: body.unique ?? "",
      comment: body.comment ?? "",
      productScore: body.productScore ?? 5,
      serviceScore: body.serviceScore ?? 5,
      logisticsScore: body.logisticsScore ?? 5,
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
  if (!id) return jsonFail(c, "参数错误");
  const svc = new ReplyService(c.get("container"));
  return jsonOk(c, await svc.praise(uid, id));
}
