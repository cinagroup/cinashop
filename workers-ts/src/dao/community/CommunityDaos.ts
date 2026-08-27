/**
 * 社区 Dao
 */
import { eq, and, sql } from "drizzle-orm";
import { BaseDao, type DB } from "@/dao/BaseDao";
import { community, communityComment } from "@/models/schema";

export class CommunityDao extends BaseDao<typeof community> {
  constructor(db: DB) {
    super(db, community, {
      id: (v) => eq(community.id, Number(v)),
      type: (v) => eq(community.type, Number(v)),
      status: (v) => eq(community.status, Number(v)),
      isVerify: (v) => eq(community.isVerify, Number(v)),
      isDel: (v) => eq(community.isDel, Number(v)),
    });
  }

  /** 帖子列表 (已审核+显示) */
  async list(page = 1, limit = 10) {
    return this.db
      .select()
      .from(community)
      .where(and(eq(community.status, 1), eq(community.isVerify, 1), eq(community.isDel, 0)))
      .orderBy(sql`${community.addTime} DESC`)
      .limit(limit)
      .offset((page - 1) * limit);
  }

  /** 帖子详情 */
  async getById(id: number) {
    const rows = await this.db
      .select()
      .from(community)
      .where(eq(community.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Public detail must obey the same moderation/deletion gates as the feed. */
  async getVisibleById(id: number) {
    const rows = await this.db
      .select()
      .from(community)
      .where(
        and(
          eq(community.id, id),
          eq(community.status, 1),
          eq(community.isVerify, 1),
          eq(community.isDel, 0),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** 点赞数 +1 */
  async incLike(id: number): Promise<void> {
    await this.db
      .update(community)
      .set({ likeNum: sql`like_num + 1` })
      .where(eq(community.id, id));
  }
}

export class CommunityCommentDao extends BaseDao<typeof communityComment> {
  constructor(db: DB) {
    super(db, communityComment, {
      communityId: (v) => eq(communityComment.communityId, Number(v)),
      uid: (v) => eq(communityComment.uid, Number(v)),
      isDel: (v) => eq(communityComment.isDel, Number(v)),
    });
  }

  /** 帖子评论列表 */
  async listByCommunity(communityId: number, page = 1, limit = 10) {
    return this.db
      .select()
      .from(communityComment)
      .where(
        and(
          eq(communityComment.communityId, communityId),
          eq(communityComment.isDel, 0),
          eq(communityComment.isShow, 1),
          eq(communityComment.isVerify, 1),
        ),
      )
      .orderBy(sql`${communityComment.addTime} DESC`)
      .limit(limit)
      .offset((page - 1) * limit);
  }
}
