/**
 * 商品评价 DAO
 */
import { eq, and, sql, desc } from "drizzle-orm";
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
  async listByProduct(productId: number, page = 1, limit = 10) {
    return this.db
      .select()
      .from(storeProductReply)
      .where(
        and(
          eq(storeProductReply.productId, productId),
          eq(storeProductReply.status, 1),
          eq(storeProductReply.isDel, 0),
        ),
      )
      .orderBy(desc(storeProductReply.top), desc(storeProductReply.addTime))
      .limit(limit)
      .offset((page - 1) * limit);
  }

  /** 评价统计 (好评率/总数/平均分) */
  async stats(productId: number) {
    const rows = await this.db
      .select({
        total: sql<number>`COUNT(*)::int`,
        avgScore: sql<number>`COALESCE(AVG(${storeProductReply.productScore}), 0)::numeric(2,1)`,
        goodCount: sql<number>`COUNT(*) FILTER (WHERE ${storeProductReply.productScore} >= 4)::int`,
        picsCount: sql<number>`COUNT(*) FILTER (WHERE ${storeProductReply.pics} != '[]' AND ${storeProductReply.pics} != '')::int`,
      })
      .from(storeProductReply)
      .where(
        and(
          eq(storeProductReply.productId, productId),
          eq(storeProductReply.status, 1),
          eq(storeProductReply.isDel, 0),
        ),
      );
    const r = rows[0] ?? { total: 0, avgScore: "5.0", goodCount: 0, picsCount: 0 };
    const total = Number(r.total) || 0;
    const good = Number(r.goodCount) || 0;
    return {
      total,
      avgScore: String(r.avgScore ?? "5.0"),
      goodRate: total > 0 ? Math.round((good / total) * 100) : 100,
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
