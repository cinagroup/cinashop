/**
 * 商品评价 Service
 *
 * 对齐 PHP StoreOrderCommentServices：评价归属订单，逐商品幂等；全部非赠品
 * 评价完成后订单由 status=2 进入 status=3。自动评价走同一事务状态机。
 */
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  storeOrder,
  storeOrderCartInfo,
  storeOrderStatus,
  storeProductReply,
  storeProductReplyComment,
  user,
  userRelation,
} from "@/models/schema";
import type { Container, DbClient } from "@/lib/di";
import { ValidateException } from "@/utils/errors";
import { grantLotteryEntitlement } from "@/services/activity/LotteryService";

const REVIEW_LOCK_NAMESPACE = 46_301;
const MAX_COMMENT_LENGTH = 512;
const MAX_PICTURES = 9;
const MAX_PICTURE_URL_LENGTH = 2_048;

type CartRow = typeof storeOrderCartInfo.$inferSelect;
type OrderRow = typeof storeOrder.$inferSelect;

export interface SubmitReplyInput {
  unique: string;
  comment: string;
  productScore: unknown;
  serviceScore: unknown;
  logisticsScore: unknown;
  replyScore?: unknown;
  pics?: unknown;
}

export interface NormalizedReplyInput {
  unique: string;
  comment: string;
  productScore: number;
  serviceScore: number;
  logisticsScore: number;
  replyScore: number;
  pics: string[];
}

function normalizeScore(value: unknown, label: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidateException(`${label}必须是 ${min}-${max} 的整数`);
  }
  return parsed;
}

function normalizePictures(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  const source = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (!source) throw new ValidateException("评价图片格式错误");
  const pictures = source.map((item) => String(item).trim()).filter(Boolean);
  if (pictures.length > MAX_PICTURES) {
    throw new ValidateException(`评价图片最多 ${MAX_PICTURES} 张`);
  }
  for (const picture of pictures) {
    if (picture.length > MAX_PICTURE_URL_LENGTH) throw new ValidateException("评价图片地址过长");
    if (!/^(https?:\/\/|\/)/i.test(picture)) {
      throw new ValidateException("评价图片地址只支持 HTTP(S) 或站内路径");
    }
  }
  return [...new Set(pictures)];
}

export function normalizeReplyInput(input: SubmitReplyInput): NormalizedReplyInput {
  const unique = String(input.unique ?? "").trim();
  const comment = String(input.comment ?? "").trim();
  if (!unique) throw new ValidateException("缺少订单商品标识");
  if (unique.length > 50) throw new ValidateException("订单商品标识无效");
  if (!comment) throw new ValidateException("评价内容不能为空");
  if (comment.length > MAX_COMMENT_LENGTH) {
    throw new ValidateException(`评价内容不能超过 ${MAX_COMMENT_LENGTH} 个字符`);
  }
  return {
    unique,
    comment,
    productScore: normalizeScore(input.productScore, "商品评分", 1, 5),
    serviceScore: normalizeScore(input.serviceScore, "服务评分", 1, 5),
    logisticsScore: normalizeScore(input.logisticsScore, "物流评分", 1, 5),
    replyScore: normalizeScore(input.replyScore ?? 3, "综合评价", 1, 3),
    pics: normalizePictures(input.pics),
  };
}

function assertReviewableOrder(order: OrderRow, uid: number): void {
  if (order.uid !== uid || order.isDel !== 0) throw new ValidateException("订单商品不存在");
  if (order.pid === -1 || order.supplierAllocationStatus === 1) {
    throw new ValidateException("请评价拆分后的履约订单");
  }
  if (order.paid !== 1) throw new ValidateException("订单未支付，不能评价");
  if (order.status !== 2) {
    throw new ValidateException(order.status === 3 ? "订单已完成评价" : "请在确认收货后评价");
  }
  if (![0, 3].includes(order.refundStatus)) throw new ValidateException("售后处理中的订单不能评价");
}

function extractSku(cartInfo: string | null): { name: string; unique: string } {
  if (!cartInfo) return { name: "", unique: "" };
  try {
    const info = JSON.parse(cartInfo) as Record<string, any>;
    return {
      name:
        String(
          info?.sku?.suk ??
            info?.productInfo?.attrInfo?.suk ??
            info?.product?.attrInfo?.suk ??
            info?.attrInfo?.suk ??
            "",
        ),
      unique: String(
        info?.sku?.unique ??
          info?.productInfo?.attrInfo?.unique ??
          info?.product?.attrInfo?.unique ??
          info?.attrInfo?.unique ??
          "",
      ),
    };
  } catch {
    return { name: "", unique: "" };
  }
}

function anonymizeNickname(value: string): string {
  const chars = Array.from(value.trim());
  if (!chars.length) return "用户";
  if (chars.length === 1) return `${chars[0]}***`;
  return `${chars[0]}***${chars.at(-1)}`;
}

async function lockOrder(tx: DbClient, orderId: number): Promise<OrderRow | null> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${REVIEW_LOCK_NAMESPACE}, ${orderId})`);
  const rows = await tx
    .select()
    .from(storeOrder)
    .where(eq(storeOrder.id, orderId))
    .limit(1)
    .for("update");
  return rows[0] ?? null;
}

async function lockOrderCarts(tx: DbClient, orderId: number): Promise<CartRow[]> {
  return tx
    .select()
    .from(storeOrderCartInfo)
    .where(eq(storeOrderCartInfo.oid, orderId))
    .orderBy(storeOrderCartInfo.id)
    .for("update");
}

async function reviewedCartIds(tx: DbClient, orderId: number, carts: CartRow[]): Promise<Set<number>> {
  if (!carts.length) return new Set();
  const cartIds = carts.map((cart) => cart.id);
  const rows = await tx
    .select({
      orderCartInfoId: storeProductReply.orderCartInfoId,
      oid: storeProductReply.oid,
      unique: storeProductReply.unique,
    })
    .from(storeProductReply)
    .where(
      and(
        eq(storeProductReply.isDel, 0),
        or(
          eq(storeProductReply.oid, orderId),
          inArray(storeProductReply.orderCartInfoId, cartIds),
        ),
      ),
    );
  const knownIds = new Set(cartIds);
  const ids = new Set<number>();
  for (const row of rows) {
    if (row.orderCartInfoId !== null && knownIds.has(row.orderCartInfoId)) {
      ids.add(row.orderCartInfoId);
      continue;
    }
    if (row.oid === orderId) {
      for (const cart of carts) if (cart.unique === row.unique) ids.add(cart.id);
    }
  }
  return ids;
}

async function completeOrderIfReviewed(
  tx: DbClient,
  order: OrderRow,
  carts: CartRow[],
  reviewedIds: Set<number>,
  now: number,
  automatic: boolean,
): Promise<boolean> {
  const required = carts.filter((cart) => cart.isGift === 0);
  if (!required.every((cart) => reviewedIds.has(cart.id))) return false;
  const updated = await tx
    .update(storeOrder)
    .set({ status: 3 })
    .where(and(eq(storeOrder.id, order.id), eq(storeOrder.status, 2)))
    .returning({ id: storeOrder.id });
  if (!updated.length) return false;
  await tx.insert(storeOrderStatus).values({
    oid: order.id,
    changeType: "check_order_over",
    changeMessage: automatic ? "已评价[自动评价]" : "用户评价",
    changeTime: now,
  });
  return true;
}

function replyValues(
  order: OrderRow,
  cart: CartRow,
  user: { nickname?: string | null; avatar?: string | null },
  input: Omit<NormalizedReplyInput, "unique">,
  now: number,
) {
  const sku = extractSku(cart.cartInfo);
  return {
    productId: cart.productId,
    oid: order.id,
    orderCartInfoId: cart.id,
    unique: cart.unique,
    uid: order.uid,
    nickname: user.nickname || "用户",
    avatar: user.avatar || "",
    comment: input.comment,
    sku: sku.name,
    skuUnique: cart.skuUnique || sku.unique,
    type: cart.type,
    relationId: cart.relationId,
    replyType: "product",
    replyScore: input.replyScore,
    productScore: input.productScore,
    serviceScore: input.serviceScore,
    logisticsScore: input.logisticsScore,
    deliveryScore: input.logisticsScore,
    pics: JSON.stringify(input.pics),
    isReply: 0,
    merchantReply: "",
    merchantReplyContent: "",
    merchantReplyTime: 0,
    praise: 0,
    viewsNum: 0,
    status: 1,
    top: 0,
    isDel: 0,
    addTime: now,
  } as const;
}

export class ReplyService {
  constructor(private readonly container: Container) {}

  async replyConfig(productId: number) {
    return this.container.replyDao.stats(productId);
  }

  async replyList(productId: number, page = 1, limit = 10, uid = 0, type = 0) {
    const safePage = Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 100)) : 10;
    const safeType = [1, 2, 3].includes(type) ? type : 0;
    const list = await this.container.replyDao.listByProduct(productId, safePage, safeLimit, safeType);
    let praised = new Set<number>();
    if (uid && list.length) {
      const relations = await this.container.db
        .select({ id: userRelation.relationId })
        .from(userRelation)
        .where(
          and(
            eq(userRelation.uid, uid),
            eq(userRelation.type, "like"),
            eq(userRelation.category, "reply"),
            inArray(userRelation.relationId, list.map((item) => item.id)),
          ),
        );
      praised = new Set(relations.map((item) => item.id));
    }
    return list.map((item) => ({
      id: item.id,
      product_id: item.productId,
      uid: item.uid,
      nickname: anonymizeNickname(item.nickname),
      avatar: item.avatar,
      comment: item.comment || "此用户没有填写评价",
      suk: item.sku,
      sku: item.sku,
      product_score: item.productScore,
      service_score: item.serviceScore,
      delivery_score: item.deliveryScore,
      star: Math.round((item.productScore + item.serviceScore + item.deliveryScore) / 3),
      pics: this.parsePics(item.pics),
      merchant_reply: item.merchantReply,
      merchant_reply_content: item.merchantReplyContent,
      merchant_reply_time: this.formatTime(item.merchantReplyTime),
      add_time: this.formatTime(item.addTime),
      praise: item.praise,
      is_praise: praised.has(item.id),
    }));
  }

  async commentList(replyId: number, page = 1, limit = 10, uid = 0) {
    const safePage = Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1;
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 100)) : 10;
    const roots = await this.container.db.select().from(storeProductReplyComment).where(and(
      eq(storeProductReplyComment.replyId, replyId),
      eq(storeProductReplyComment.pid, 0),
      eq(storeProductReplyComment.isDel, 0),
    )).orderBy(desc(storeProductReplyComment.praise), desc(storeProductReplyComment.addTime))
      .limit(safeLimit).offset((safePage - 1) * safeLimit);
    if (!roots.length) return [];
    const children = await this.container.db.select().from(storeProductReplyComment).where(and(
      inArray(storeProductReplyComment.pid, roots.map((item) => item.id)),
      eq(storeProductReplyComment.isDel, 0),
    )).orderBy(desc(storeProductReplyComment.praise), desc(storeProductReplyComment.addTime));
    const commentIds = [...roots, ...children].map((item) => item.id);
    const userIds = [...new Set([...roots, ...children].map((item) => item.uid).filter(Boolean))];
    const [users, relations] = await Promise.all([
      userIds.length ? this.container.db.select({
        uid: user.uid, nickname: user.nickname, avatar: user.avatar,
      }).from(user).where(inArray(user.uid, userIds)) : [],
      uid ? this.container.db.select({ id: userRelation.relationId }).from(userRelation).where(and(
        eq(userRelation.uid, uid), eq(userRelation.type, "like"),
        eq(userRelation.category, "comment"), inArray(userRelation.relationId, commentIds),
      )) : [],
    ]);
    const userMap = new Map(users.map((item) => [item.uid, item]));
    const praised = new Set(relations.map((item) => item.id));
    const serialize = (item: typeof storeProductReplyComment.$inferSelect) => {
      const current = userMap.get(item.uid);
      return {
        id: item.id, reply_id: item.replyId, pid: item.pid, uid: item.uid,
        content: item.content, praise: item.praise,
        create_time: this.formatTime(item.addTime, true),
        update_time: this.formatTime(item.updateTime, true),
        is_praise: praised.has(item.id),
        user: {
          uid: item.uid,
          nickname: anonymizeNickname(current?.nickname || item.nickname || "用户"),
          avatar: current?.avatar || item.avatar || "",
          level_name: "",
          vip_status: "",
        },
      };
    };
    return roots.map((root) => ({
      ...serialize(root),
      children: children.filter((item) => item.pid === root.id).map(serialize)[0] ?? null,
    }));
  }

  async submitReply(
    uid: number,
    rawInput: SubmitReplyInput,
  ): Promise<{ id: number; oid: number; completed: boolean; to_lottery: boolean }> {
    const input = normalizeReplyInput(rawInput);
    const c = this.container;
    const [matches, user] = await Promise.all([
      c.db
        .select({ id: storeOrderCartInfo.id, oid: storeOrderCartInfo.oid })
        .from(storeOrderCartInfo)
        .where(and(eq(storeOrderCartInfo.unique, input.unique), eq(storeOrderCartInfo.uid, uid)))
        .limit(2),
      c.userDao.findForAuth(uid),
    ]);
    if (matches.length !== 1) throw new ValidateException("订单商品不存在");
    if (!user) throw new ValidateException("用户不存在");

    return c.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DbClient;
      const order = await lockOrder(tx, matches[0].oid);
      if (!order) throw new ValidateException("订单不存在");
      assertReviewableOrder(order, uid);
      const carts = await lockOrderCarts(tx, order.id);
      const cart = carts.find(
        (item) => item.id === matches[0].id && item.unique === input.unique && item.uid === uid,
      );
      if (!cart) throw new ValidateException("订单商品不存在");

      const reviewed = await reviewedCartIds(tx, order.id, carts);
      if (reviewed.has(cart.id)) throw new ValidateException("该商品已评价");
      const now = Math.floor(Date.now() / 1_000);
      const inserted = await tx
        .insert(storeProductReply)
        .values(replyValues(order, cart, user, input, now))
        .onConflictDoNothing()
        .returning({ id: storeProductReply.id });
      if (!inserted[0]) throw new ValidateException("该商品已评价");
      reviewed.add(cart.id);
      const completed = await completeOrderIfReviewed(tx, order, carts, reviewed, now, false);
      const entitlement = await grantLotteryEntitlement(tx, {
        uid,
        factor: 4,
        sourceType: "comment",
        sourceId: inserted[0].id,
        now,
      });
      return { id: inserted[0].id, oid: order.id, completed, to_lottery: entitlement.activityId > 0 };
    });
  }

  /** PHP 自动评价：真实补齐缺失评价后才完成订单。 */
  async autoCommentOrder(orderId: number): Promise<{ inserted: number; completed: boolean }> {
    const preliminary = await this.container.db
      .select({ uid: storeOrder.uid })
      .from(storeOrder)
      .where(eq(storeOrder.id, orderId))
      .limit(1);
    if (!preliminary[0]) return { inserted: 0, completed: false };
    const user = (await this.container.userDao.findForAuth(preliminary[0].uid)) ?? {
      nickname: "用户",
      avatar: "",
    };
    return this.container.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DbClient;
      const order = await lockOrder(tx, orderId);
      if (!order || order.status !== 2) return { inserted: 0, completed: order?.status === 3 };
      assertReviewableOrder(order, order.uid);
      const carts = await lockOrderCarts(tx, order.id);
      if (!carts.length) throw new ValidateException("评价商品不存在");
      const reviewed = await reviewedCartIds(tx, order.id, carts);
      const now = Math.floor(Date.now() / 1_000);
      let insertedCount = 0;
      const defaults: Omit<NormalizedReplyInput, "unique"> = {
        comment: "此用户未作评价",
        productScore: 5,
        serviceScore: 5,
        logisticsScore: 5,
        replyScore: 3,
        pics: [],
      };
      for (const cart of carts) {
        if (reviewed.has(cart.id) || !cart.unique) continue;
        const inserted = await tx
          .insert(storeProductReply)
          .values(replyValues(order, cart, user, defaults, now))
          .onConflictDoNothing()
          .returning({ id: storeProductReply.id });
        if (inserted.length) {
          insertedCount += 1;
          reviewed.add(cart.id);
        }
      }
      const completed = await completeOrderIfReviewed(tx, order, carts, reviewed, now, true);
      return { inserted: insertedCount, completed };
    });
  }

  async praise(uid: number, replyId: number): Promise<{ praise: number; isPraise: true }> {
    return this.container.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DbClient;
      const replies = await tx
        .select({ id: storeProductReply.id, praise: storeProductReply.praise })
        .from(storeProductReply)
        .where(
          and(
            eq(storeProductReply.id, replyId),
            eq(storeProductReply.status, 1),
            eq(storeProductReply.isDel, 0),
          ),
        )
        .limit(1)
        .for("update");
      if (!replies[0]) throw new ValidateException("点赞的评价不存在");
      const relation = await tx
        .insert(userRelation)
        .values({
          uid,
          relationId: replyId,
          type: "like",
          category: "reply",
          addTime: Math.floor(Date.now() / 1_000),
        })
        .onConflictDoNothing()
        .returning({ id: userRelation.id });
      let praise = replies[0].praise;
      if (relation.length) {
        const updated = await tx
          .update(storeProductReply)
          .set({ praise: sql`${storeProductReply.praise} + 1` })
          .where(eq(storeProductReply.id, replyId))
          .returning({ praise: storeProductReply.praise });
        praise = updated[0]?.praise ?? praise + 1;
      }
      return { praise, isPraise: true as const };
    });
  }

  async unpraise(uid: number, replyId: number): Promise<{ praise: number; isPraise: false }> {
    return this.container.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DbClient;
      const replies = await tx
        .select({ id: storeProductReply.id, praise: storeProductReply.praise })
        .from(storeProductReply)
        .where(and(eq(storeProductReply.id, replyId), eq(storeProductReply.isDel, 0)))
        .limit(1)
        .for("update");
      if (!replies[0]) throw new ValidateException("点赞的评价不存在");
      const removed = await tx
        .delete(userRelation)
        .where(
          and(
            eq(userRelation.uid, uid),
            eq(userRelation.relationId, replyId),
            eq(userRelation.type, "like"),
            eq(userRelation.category, "reply"),
          ),
        )
        .returning({ id: userRelation.id });
      let praise = replies[0].praise;
      if (removed.length) {
        const updated = await tx
          .update(storeProductReply)
          .set({ praise: sql`GREATEST(${storeProductReply.praise} - 1, 0)` })
          .where(eq(storeProductReply.id, replyId))
          .returning({ praise: storeProductReply.praise });
        praise = updated[0]?.praise ?? Math.max(0, praise - 1);
      }
      return { praise, isPraise: false as const };
    });
  }

  private parsePics(pics: string | null): string[] {
    if (!pics) return [];
    try {
      const arr = JSON.parse(pics);
      return Array.isArray(arr) ? arr.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }

  private formatTime(value: number, seconds = false): string {
    if (!value) return "";
    const date = new Date(value * 1_000);
    const iso = date.toISOString().replace("T", " ");
    return seconds ? iso.slice(0, 19) : iso.slice(0, 16);
  }
}
