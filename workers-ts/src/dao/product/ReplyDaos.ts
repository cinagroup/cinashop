/**
 * 商品评价 DAO
 */
import { eq, and, sql, desc, or, ne, gt, lte } from "drizzle-orm";
import { BaseDao, type DB } from "@/dao/BaseDao";
import { storeProductReply, storeProductReplyComment } from "@/models/schema";

export class StoreProductReplyDao extends BaseDao<typeof storeProductReply> {
  constructor(db: DB) {
    super(db, storeProductReply, {
      productId: (v) => eq(storeProductReply.productId, Number(v)),
      uid: (v) => eq(storeProductReply.uid, Number(v)),
      status: (v) => eq(storeProductReply.status, Number(v)),
    });
  }

  /** 商品评价列表 (按商品 ID, status=1 已通过) */
  async listByProduct(productId: number, page = 1, limit = 10, type = 0) {
    const scoreFilter = type === 1
      ? and(
        eq(storeProductReply.productScore, 5),
        eq(storeProductReply.serviceScore, 5),
        eq(storeProductReply.deliveryScore, 5),
      )
      : type === 2
        ? and(
          or(
            ne(storeProductReply.productScore, 5),
            ne(storeProductReply.serviceScore, 5),
            ne(storeProductReply.deliveryScore, 5),
          ),
          gt(storeProductReply.productScore, 2),
          gt(storeProductReply.serviceScore, 2),
          gt(storeProductReply.deliveryScore, 2),
        )
        : type === 3
          ? or(
            lte(storeProductReply.productScore, 2),
            lte(storeProductReply.serviceScore, 2),
            lte(storeProductReply.deliveryScore, 2),
          )
          : undefined;
    return this.db
      .select()
      .from(storeProductReply)
      .where(
        and(
          eq(storeProductReply.productId, productId),
          eq(storeProductReply.status, 1),
          eq(storeProductReply.isDel, 0),
          scoreFilter,
        ),
      )
      .orderBy(desc(storeProductReply.top), desc(storeProductReply.addTime))
      .limit(limit)
      .offset((page - 1) * limit);
  }

  /** PHP-compatible score buckets and good-review percentage. */
  async stats(productId: number) {
    const rows = await this.db
      .select({
        total: sql<number>`COUNT(*)::int`,
        goodCount: sql<number>`COUNT(*) FILTER (WHERE ${storeProductReply.productScore} = 5 AND ${storeProductReply.serviceScore} = 5 AND ${storeProductReply.deliveryScore} = 5)::int`,
        middleCount: sql<number>`COUNT(*) FILTER (WHERE (${storeProductReply.productScore} <> 5 OR ${storeProductReply.serviceScore} <> 5 OR ${storeProductReply.deliveryScore} <> 5) AND ${storeProductReply.productScore} > 2 AND ${storeProductReply.serviceScore} > 2 AND ${storeProductReply.deliveryScore} > 2)::int`,
        poorCount: sql<number>`COUNT(*) FILTER (WHERE ${storeProductReply.productScore} <= 2 OR ${storeProductReply.serviceScore} <= 2 OR ${storeProductReply.deliveryScore} <= 2)::int`,
        scoreSum: sql<number>`COALESCE(SUM(${storeProductReply.productScore} + ${storeProductReply.serviceScore}), 0)::int`,
        picsCount: sql<number>`COUNT(*) FILTER (WHERE ${storeProductReply.pics} IS NOT NULL AND ${storeProductReply.pics} <> '' AND ${storeProductReply.pics} <> '[]')::int`,
      })
      .from(storeProductReply)
      .where(
        and(
          eq(storeProductReply.productId, productId),
          eq(storeProductReply.status, 1),
          eq(storeProductReply.isDel, 0),
        ),
      );
    const r = rows[0] ?? { total: 0, goodCount: 0, middleCount: 0, poorCount: 0, scoreSum: 0, picsCount: 0 };
    const total = Number(r.total) || 0;
    const good = Number(r.goodCount) || 0;
    return {
      sum_count: total,
      good_count: good,
      in_count: Number(r.middleCount) || 0,
      poor_count: Number(r.poorCount) || 0,
      reply_chance: total > 0 ? Math.trunc((good / total) * 100) : 100,
      reply_star: total > 0 ? Math.round(Number(r.scoreSum) / (total * 2)) : 5,
      total,
      avgScore: total > 0 ? (Number(r.scoreSum) / (total * 2)).toFixed(1) : "5.0",
      goodRate: total > 0 ? Math.trunc((good / total) * 100) : 100,
      picsCount: Number(r.picsCount) || 0,
    };
  }
}

export class ReplyCommentDao extends BaseDao<typeof storeProductReplyComment> {
  constructor(db: DB) {
    super(db, storeProductReplyComment, {
      replyId: (v) => eq(storeProductReplyComment.replyId, Number(v)),
      uid: (v) => eq(storeProductReplyComment.uid, Number(v)),
    });
  }

  async listByReply(replyId: number, page = 1, limit = 10) {
    return this.db
      .select()
      .from(storeProductReplyComment)
      .where(
        and(
          eq(storeProductReplyComment.replyId, replyId),
          eq(storeProductReplyComment.isDel, 0),
        ),
      )
      .orderBy(desc(storeProductReplyComment.addTime))
      .limit(limit)
      .offset((page - 1) * limit);
  }
}
