/**
 * 社区 Service
 *
 * 对应原版端点: community/topic, list, detail, community_like, comment, save
 */
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  community as communityTable,
  communityComment,
  communityRelevance,
  communityTopic,
  communityUser,
  storeProduct,
  storeProductLog,
  user,
  userRelation,
} from "@/models/schema";
import { withTx, type Container } from "@/lib/di";
import { ValidateException, NotFoundException } from "@/utils/errors";
import { CommunitySocialService } from "@/services/community/CommunitySocialService";
import { AdminCommunityService } from "@/services/community/AdminCommunityService";

// Shared with AdminCommunityService so client writes and moderation lifecycle
// changes serialize on the same logical profile/topic keys.
const COMMUNITY_LIFECYCLE_LOCK_NAMESPACE = 17_349;
const COMMUNITY_LIKE = "community_like";
const COMMUNITY_TOPIC = "community_topic";
const COMMUNITY_PRODUCT = "community_product";
const COMMUNITY_COMMENT_LIKE = "community_comment_like";
const COMMUNITY_INTEREST = "community_interest";
const MAX_PAGE_SIZE = 100;

export interface CommunityPostQuery {
  page?: unknown;
  limit?: unknown;
  topic_id?: unknown;
  keyword?: unknown;
  is_follow?: unknown;
  relation_id?: unknown;
  content_type?: unknown;
  start_id?: unknown;
  ids?: unknown;
  order?: unknown;
}

function positiveInteger(value: unknown, fallback: number, maximum = 2_147_483_647): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeIdList(value: unknown, maximum = 100): number[] {
  if (value === undefined || value === null || value === "") return [];
  let source: unknown = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      source = JSON.parse(trimmed);
    } catch {
      source = trimmed.split(",");
    }
  }
  const items: unknown[] = Array.isArray(source) ? source : [source];
  const ids = [...new Set(items.map((item) => Number(item)))];
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || ids.length > maximum) {
    throw new ValidateException("ID列表格式错误");
  }
  return ids;
}

function parseStoredIds(value: string | null): number[] {
  try {
    return normalizeIdList(value, 100);
  } catch {
    return [];
  }
}

function parseStoredStrings(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export class CommunityService {
  constructor(private readonly container: Container) {}

  /** 公开话题列表 (community/topic) */
  async topics() {
    return this.container.db
      .select({
        id: communityTopic.id,
        name: communityTopic.name,
        isRecommend: communityTopic.isRecommend,
      })
      .from(communityTopic)
      .where(and(eq(communityTopic.status, 1), eq(communityTopic.isDel, 0)))
      .orderBy(desc(communityTopic.sort), desc(communityTopic.id));
  }

  /** 帖子列表 (community/list) — 保留 PHP 的筛选、所有者预览与排序合同。 */
  async list(
    queryOrPage: CommunityPostQuery | number = {},
    legacyLimit = 10,
    uid?: number,
  ) {
    const query: CommunityPostQuery = typeof queryOrPage === "number"
      ? { page: queryOrPage, limit: legacyLimit }
      : queryOrPage;
    const page = positiveInteger(query.page, 1);
    const limit = Math.min(MAX_PAGE_SIZE, positiveInteger(query.limit, 10, MAX_PAGE_SIZE));
    const conditions: SQL[] = [eq(communityTable.isDel, 0)];
    const relationId = optionalPositiveInteger(query.relation_id);
    if (relationId) conditions.push(eq(communityTable.relationId, relationId));
    if (!relationId || relationId !== uid) {
      conditions.push(
        eq(communityTable.status, 1),
        eq(communityTable.isVerify, 1),
      );
    }
    const contentType = optionalPositiveInteger(query.content_type);
    if (contentType !== undefined) {
      if (contentType !== 1 && contentType !== 2) throw new ValidateException("内容类型格式错误");
      conditions.push(eq(communityTable.contentType, contentType));
    }
    const topicIds = normalizeIdList(query.topic_id, 50);
    if (topicIds.length) {
      const topicParameters = sql.join(topicIds.map((topicId) => sql`${topicId}`), sql`, `);
      conditions.push(sql`EXISTS (
        SELECT 1 FROM community_relevance cr
        WHERE cr.left_id = ${communityTable.id}
          AND cr.type = ${COMMUNITY_TOPIC}
          AND cr.right_id IN (${topicParameters})
      )`);
    }
    const requestedIds = normalizeIdList(query.ids, 100);
    if (requestedIds.length) conditions.push(inArray(communityTable.id, requestedIds));
    const startId = optionalPositiveInteger(query.start_id);
    if (startId) conditions.push(sql`${communityTable.id} <= ${startId}`);
    if (typeof query.keyword === "string" && query.keyword.trim()) {
      const pattern = `%${query.keyword.trim().slice(0, 100)}%`;
      conditions.push(or(
        ilike(communityTable.title, pattern),
        ilike(communityTable.content, pattern),
        sql`EXISTS (
          SELECT 1 FROM "user" u
          WHERE u.uid = ${communityTable.relationId} AND u.nickname ILIKE ${pattern}
        )`,
      )!);
    }
    const wantsFollow = String(query.is_follow ?? "").trim() !== ""
      && String(query.is_follow) !== "0";
    if (wantsFollow) {
      if (!uid) return [];
      conditions.push(sql`EXISTS (
        SELECT 1 FROM community_relevance cr
        WHERE cr.left_id = ${uid}
          AND cr.right_id = ${communityTable.relationId}
          AND cr.type = ${COMMUNITY_INTEREST}
      )`);
    }
    const order = Number(query.order ?? 2) === 1
      ? [desc(communityTable.addTime), desc(communityTable.id)]
      : [desc(communityTable.star), desc(communityTable.addTime), desc(communityTable.id)];
    const rows = await this.container.db
      .select()
      .from(communityTable)
      .where(and(...conditions))
      .orderBy(...order)
      .limit(limit)
      .offset((page - 1) * limit);
    return this.formatPosts(rows, uid);
  }

  /** 帖子详情 (community/detail/:id) */
  async detail(id: number, uid?: number) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("参数错误");
    const item = (await this.container.db
      .select()
      .from(communityTable)
      .where(and(eq(communityTable.id, id), eq(communityTable.isDel, 0)))
      .limit(1))[0];
    const isPublic = item?.status === 1 && item.isVerify === 1;
    if (!item || (!isPublic && (item.type !== 2 || item.relationId !== uid))) {
      throw new NotFoundException("帖子不存在");
    }
    // 作者可以预览待审/下架内容，但预览不应计入公开曝光；recordBrowse
    // 本身也只接受公开帖子，因此仅在公开详情路径上调用。
    const playNum = isPublic
      ? (await new CommunitySocialService(this.container).recordBrowse(id, uid)).play_num
      : item.playNum;
    const [formatted] = await this.formatPosts([{ ...item, playNum }], uid);
    return formatted;
  }

  /** 发布帖子 (community_save) */
  async create(
    uid: number,
    params: {
      title: string;
      content: string;
      contentType: number;
      image?: string;
      videoUrl?: string;
      sliderImage?: string[];
      topicIds?: number[];
      productIds?: number[];
    },
    isVerify: 0 | 1 = 1,
  ): Promise<{ id: number }> {
    return new AdminCommunityService(this.container).saveUserPost(uid, 0, params, isVerify);
  }

  async update(
    uid: number,
    id: number,
    input: Record<string, unknown>,
    isVerify: 0 | 1,
  ): Promise<{ id: number }> {
    return new AdminCommunityService(this.container).saveUserPost(uid, id, input, isVerify);
  }

  /** 幂等点赞/取消点赞 (community_like/:id) */
  async like(uid: number, id: number, status = 1): Promise<{ likeNum: number; status: 0 | 1 }> {
    if (!Number.isInteger(id) || id <= 0) throw new ValidateException("参数错误");
    const desiredStatus = status === 0 ? 0 : 1;

    return withTx(this.container, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${COMMUNITY_LIFECYCLE_LOCK_NAMESPACE}, hashtext(${`community-like:${uid}:${id}`}))`,
      );
      const [post] = await tx
        .select({
          id: communityTable.id,
          type: communityTable.type,
          relationId: communityTable.relationId,
          likeNum: communityTable.likeNum,
        })
        .from(communityTable)
        .where(
          and(
            eq(communityTable.id, id),
            eq(communityTable.status, 1),
            eq(communityTable.isVerify, 1),
            eq(communityTable.isDel, 0),
          ),
        )
        .limit(1)
        .for("update");
      if (!post) throw new NotFoundException("帖子不存在");

      const [existing] = await tx
        .select({ id: communityRelevance.id })
        .from(communityRelevance)
        .where(
          and(
            eq(communityRelevance.leftId, uid),
            eq(communityRelevance.rightId, id),
            eq(communityRelevance.type, COMMUNITY_LIKE),
          ),
        )
        .limit(1);

      if (desiredStatus === 1 && existing) return { likeNum: post.likeNum, status: 1 };
      if (desiredStatus === 0 && !existing) return { likeNum: post.likeNum, status: 0 };

      if (desiredStatus === 1) {
        await tx.insert(communityRelevance).values({
          leftId: uid,
          rightId: id,
          type: COMMUNITY_LIKE,
        });
      } else {
        // 删除所有历史重复三元组，但计数只回退一次，避免把旧脏数据放大成负数。
        await tx
          .delete(communityRelevance)
          .where(
            and(
              eq(communityRelevance.leftId, uid),
              eq(communityRelevance.rightId, id),
              eq(communityRelevance.type, COMMUNITY_LIKE),
            ),
          );
      }

      const delta = desiredStatus === 1 ? 1 : -1;
      const [updated] = await tx
        .update(communityTable)
        .set({ likeNum: sql`GREATEST(${communityTable.likeNum} + ${delta}, 0)` })
        .where(eq(communityTable.id, id))
        .returning({ likeNum: communityTable.likeNum });
      await tx
        .update(communityUser)
        .set({ likeNum: sql`GREATEST(${communityUser.likeNum} + ${delta}, 0)` })
        .where(
          and(
            eq(communityUser.type, post.type),
            eq(communityUser.relationId, post.relationId),
            eq(communityUser.isDel, 0),
          ),
        );
      return { likeNum: updated.likeNum, status: desiredStatus };
    });
  }

  /** 评论/回复列表 (community/comment/list) */
  async commentList(
    communityId: number,
    page = 1,
    limit = 10,
    uid?: number,
    replyId = 0,
  ) {
    if (!Number.isSafeInteger(communityId) || communityId <= 0) {
      throw new ValidateException("参数错误");
    }
    const safePage = positiveInteger(page, 1);
    const safeLimit = Math.min(MAX_PAGE_SIZE, positiveInteger(limit, 10, MAX_PAGE_SIZE));
    const conditions: SQL[] = [
      eq(communityComment.communityId, communityId),
      eq(communityComment.isDel, 0),
      eq(communityComment.isShow, 1),
      eq(communityComment.isVerify, 1),
    ];
    if (replyId > 0) conditions.push(
      eq(communityComment.replyId, replyId),
      eq(communityComment.isReply, 0),
    );
    else conditions.push(eq(communityComment.isReply, 1));
    const where = and(...conditions);
    const [rows, counts] = await Promise.all([
      this.container.db.select().from(communityComment).where(where)
        .orderBy(
          ...(replyId > 0
            ? [asc(communityComment.addTime), asc(communityComment.id)]
            : [desc(communityComment.addTime), desc(communityComment.id)]),
        )
        .limit(safeLimit)
        .offset((safePage - 1) * safeLimit),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` })
        .from(communityComment)
        .where(where),
    ]);
    return {
      list: await this.formatComments(rows, uid),
      count: counts[0]?.count ?? 0,
    };
  }

  /** 发表评论 (community/comment/save) */
  async addComment(
    uid: number,
    params: {
      communityId: number;
      content: string;
      replyCommentId?: number;
      ip?: string;
      isVerify?: 0 | 1;
    },
  ): Promise<{ id: number }> {
    return new AdminCommunityService(this.container).addUserComment(
      uid,
      params.communityId,
      params.content,
      params.ip ?? "",
      params.replyCommentId ?? 0,
      params.isVerify ?? 1,
    );
  }

  /** 删除帖子 (community_delete/:id) */
  async del(uid: number, id: number): Promise<void> {
    await new AdminCommunityService(this.container).deleteOwnedPost(id, uid);
  }

  async deleteComment(uid: number, id: number): Promise<void> {
    await new AdminCommunityService(this.container).deleteOwnedComment(id, uid);
  }

  async likeComment(
    uid: number,
    id: number,
    status = 1,
  ): Promise<{ likeNum: number; status: 0 | 1 }> {
    if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(id) || id <= 0) {
      throw new ValidateException("参数错误");
    }
    const desiredStatus: 0 | 1 = status === 0 ? 0 : 1;
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(
        ${COMMUNITY_LIFECYCLE_LOCK_NAMESPACE},
        hashtext(${`community-comment-like:${uid}:${id}`})
      )`);
      const comment = (await tx.select({ id: communityComment.id, likeNum: communityComment.likeNum })
        .from(communityComment)
        .where(and(
          eq(communityComment.id, id),
          eq(communityComment.isDel, 0),
          eq(communityComment.isShow, 1),
          eq(communityComment.isVerify, 1),
        ))
        .limit(1)
        .for("update"))[0];
      if (!comment) throw new NotFoundException("评论不存在或不可点赞");
      const existing = await tx.select({ id: communityRelevance.id }).from(communityRelevance)
        .where(and(
          eq(communityRelevance.leftId, uid),
          eq(communityRelevance.rightId, id),
          eq(communityRelevance.type, COMMUNITY_COMMENT_LIKE),
        ))
        .limit(1);
      if ((desiredStatus === 1 && existing[0]) || (desiredStatus === 0 && !existing[0])) {
        return { likeNum: comment.likeNum, status: desiredStatus };
      }
      if (desiredStatus === 1) {
        await tx.insert(communityRelevance).values({
          leftId: uid,
          rightId: id,
          type: COMMUNITY_COMMENT_LIKE,
        });
      } else {
        await tx.delete(communityRelevance).where(and(
          eq(communityRelevance.leftId, uid),
          eq(communityRelevance.rightId, id),
          eq(communityRelevance.type, COMMUNITY_COMMENT_LIKE),
        ));
      }
      const delta = desiredStatus === 1 ? 1 : -1;
      const updated = await tx.update(communityComment)
        .set({ likeNum: sql`GREATEST(${communityComment.likeNum} + ${delta}, 0)` })
        .where(eq(communityComment.id, id))
        .returning({ likeNum: communityComment.likeNum });
      return { likeNum: updated[0]?.likeNum ?? 0, status: desiredStatus };
    });
  }

  async share(id: number): Promise<{ shareNum: number }> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("参数错误");
    const updated = await this.container.db.update(communityTable)
      .set({ shareNum: sql`${communityTable.shareNum} + 1` })
      .where(and(
        eq(communityTable.id, id),
        eq(communityTable.status, 1),
        eq(communityTable.isVerify, 1),
        eq(communityTable.isDel, 0),
      ))
      .returning({ shareNum: communityTable.shareNum });
    if (!updated[0]) throw new NotFoundException("帖子不存在");
    return { shareNum: updated[0].shareNum };
  }

  async topicCount(id: number): Promise<{ count: number }> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("参数错误");
    const topic = await this.container.db.select({ id: communityTopic.id }).from(communityTopic)
      .where(and(eq(communityTopic.id, id), eq(communityTopic.status, 1), eq(communityTopic.isDel, 0)))
      .limit(1);
    if (!topic[0]) throw new NotFoundException("话题不存在");
    const rows = await this.container.db.select({ count: sql<number>`COUNT(DISTINCT ${communityTable.id})::int` })
      .from(communityRelevance)
      .innerJoin(communityTable, eq(communityTable.id, communityRelevance.leftId))
      .where(and(
        eq(communityRelevance.type, COMMUNITY_TOPIC),
        eq(communityRelevance.rightId, id),
        eq(communityTable.status, 1),
        eq(communityTable.isVerify, 1),
        eq(communityTable.isDel, 0),
      ));
    return { count: rows[0]?.count ?? 0 };
  }

  async likedPosts(uid: number, query: { page?: unknown; limit?: unknown; keyword?: unknown }) {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("用户参数错误");
    return this.joinedPostList(
      uid,
      query,
      sql`EXISTS (
        SELECT 1 FROM community_relevance cr
        WHERE cr.left_id = ${uid}
          AND cr.right_id = ${communityTable.id}
          AND cr.type = ${COMMUNITY_LIKE}
      )`,
      [desc(communityTable.id)],
    );
  }

  async elegantPosts(
    uid: number | undefined,
    productId: number,
    query: { page?: unknown; limit?: unknown; order?: unknown },
  ) {
    if (!Number.isSafeInteger(productId) || productId <= 0) throw new ValidateException("商品不能为空");
    const order = Number(query.order ?? 2) === 1
      ? [desc(communityTable.id)]
      : [desc(communityTable.star), desc(communityTable.addTime), desc(communityTable.id)];
    return this.joinedPostList(
      uid,
      query,
      sql`EXISTS (
        SELECT 1 FROM community_relevance cr
        WHERE cr.left_id = ${communityTable.id}
          AND cr.right_id = ${productId}
          AND cr.type = ${COMMUNITY_PRODUCT}
      )`,
      order,
    );
  }

  async userProductList(
    uid: number | undefined,
    query: { page?: unknown; limit?: unknown; type?: unknown; keyword?: unknown },
  ) {
    if (!uid) return [];
    const page = positiveInteger(query.page, 1);
    const limit = Math.min(MAX_PAGE_SIZE, positiveInteger(query.limit, 10, MAX_PAGE_SIZE));
    const type = typeof query.type === "string" && query.type.trim() ? query.type.trim() : "pay";
    if (!new Set(["pay", "visit", "collect"]).has(type)) throw new ValidateException("商品来源类型错误");
    const conditions: SQL[] = [eq(storeProduct.isShow, 1), eq(storeProduct.isDel, 0)];
    const keyword = typeof query.keyword === "string" ? query.keyword.trim().slice(0, 100) : "";
    if (keyword) {
      const pattern = `%${keyword}%`;
      conditions.push(or(ilike(storeProduct.storeName, pattern), ilike(storeProduct.keyword, pattern))!);
    }
    if (type === "collect") {
      const rows = await this.container.db.select({
        product_id: storeProduct.id,
        image: storeProduct.image,
        store_name: storeProduct.storeName,
        price: storeProduct.price,
      }).from(userRelation)
        .innerJoin(storeProduct, eq(storeProduct.id, userRelation.relationId))
        .where(and(
          ...conditions,
          eq(userRelation.uid, uid),
          eq(userRelation.type, "collect"),
          eq(userRelation.category, "product"),
        ))
        .orderBy(desc(userRelation.addTime), desc(userRelation.id))
        .limit(limit)
        .offset((page - 1) * limit);
      return rows;
    }
    const logConditions: SQL[] = [
      ...conditions,
      eq(storeProductLog.uid, uid),
      eq(storeProductLog.type, type),
    ];
    if (type === "visit") logConditions.push(isNull(storeProductLog.deleteTime));
    return this.container.db.select({
      product_id: storeProduct.id,
      image: storeProduct.image,
      store_name: storeProduct.storeName,
      price: storeProduct.price,
      latest: sql<number>`MAX(${storeProductLog.addTime})::int`,
    }).from(storeProductLog)
      .innerJoin(storeProduct, eq(storeProduct.id, storeProductLog.productId))
      .where(and(...logConditions))
      .groupBy(storeProduct.id, storeProduct.image, storeProduct.storeName, storeProduct.price)
      .orderBy(desc(sql`MAX(${storeProductLog.addTime})`), desc(storeProduct.id))
      .limit(limit)
      .offset((page - 1) * limit);
  }

  /** Bidirectional referral friends (community/user_friend). */
  async friendList(uid: number, page = 1, limit = 10) {
    return new CommunitySocialService(this.container).friendList(uid, page, limit);
  }

  private async joinedPostList(
    uid: number | undefined,
    query: { page?: unknown; limit?: unknown; keyword?: unknown },
    extra: SQL,
    order: SQL[],
  ) {
    const page = positiveInteger(query.page, 1);
    const limit = Math.min(MAX_PAGE_SIZE, positiveInteger(query.limit, 10, MAX_PAGE_SIZE));
    const conditions: SQL[] = [
      eq(communityTable.status, 1),
      eq(communityTable.isVerify, 1),
      eq(communityTable.isDel, 0),
      extra,
    ];
    const keyword = typeof query.keyword === "string" ? query.keyword.trim().slice(0, 100) : "";
    if (keyword) {
      const pattern = `%${keyword}%`;
      conditions.push(or(ilike(communityTable.title, pattern), ilike(communityTable.content, pattern))!);
    }
    const where = and(...conditions);
    const [rows, counts] = await Promise.all([
      this.container.db.select().from(communityTable).where(where)
        .orderBy(...order)
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` })
        .from(communityTable)
        .where(where),
    ]);
    return { list: await this.formatPosts(rows, uid), count: counts[0]?.count ?? 0 };
  }

  private async formatPosts(rows: Array<typeof communityTable.$inferSelect>, uid?: number) {
    if (!rows.length) return [];
    const postIds = rows.map((row) => row.id);
    const userIds = [...new Set(rows.filter((row) => row.type === 2).map((row) => row.relationId))];
    const [users, profiles, relations, likedIds, followedIds] = await Promise.all([
      userIds.length
        ? this.container.db.select({ uid: user.uid, nickname: user.nickname, avatar: user.avatar })
          .from(user)
          .where(inArray(user.uid, userIds))
        : Promise.resolve([]),
      this.container.db.select({
        type: communityUser.type,
        relationId: communityUser.relationId,
        nickname: communityUser.nickname,
        avatar: communityUser.avatar,
      }).from(communityUser).where(and(
        eq(communityUser.isDel, 0),
        or(...rows.map((row) => and(
          eq(communityUser.type, row.type),
          eq(communityUser.relationId, row.relationId),
        )))!,
      )),
      this.container.db.select({
        leftId: communityRelevance.leftId,
        rightId: communityRelevance.rightId,
        type: communityRelevance.type,
      }).from(communityRelevance).where(and(
        inArray(communityRelevance.leftId, postIds),
        inArray(communityRelevance.type, [COMMUNITY_TOPIC, COMMUNITY_PRODUCT]),
      )),
      this.relevanceIds(uid, postIds, COMMUNITY_LIKE),
      uid && userIds.length
        ? this.container.db.select({ rightId: communityRelevance.rightId }).from(communityRelevance)
          .where(and(
            eq(communityRelevance.leftId, uid),
            eq(communityRelevance.type, COMMUNITY_INTEREST),
            inArray(communityRelevance.rightId, userIds),
          ))
        : Promise.resolve([]),
    ]);
    const userMap = new Map(users.map((row) => [row.uid, row]));
    const profileMap = new Map(profiles.map((row) => [`${row.type}:${row.relationId}`, row]));
    const followed = new Set(followedIds.map((row) => row.rightId));
    const topicIds = [...new Set(relations.filter((row) => row.type === COMMUNITY_TOPIC).map((row) => row.rightId))];
    const productIds = [...new Set(relations.filter((row) => row.type === COMMUNITY_PRODUCT).map((row) => row.rightId))];
    const [topics, products] = await Promise.all([
      topicIds.length
        ? this.container.db.select({ id: communityTopic.id, name: communityTopic.name })
          .from(communityTopic)
          .where(and(inArray(communityTopic.id, topicIds), eq(communityTopic.isDel, 0)))
        : Promise.resolve([]),
      productIds.length
        ? this.container.db.select({
          id: storeProduct.id,
          store_name: storeProduct.storeName,
          image: storeProduct.image,
          price: storeProduct.price,
        }).from(storeProduct).where(and(
          inArray(storeProduct.id, productIds),
          eq(storeProduct.isDel, 0),
        ))
        : Promise.resolve([]),
    ]);
    const topicMap = new Map(topics.map((row) => [row.id, row]));
    const productMap = new Map(products.map((row) => [row.id, row]));
    const relationMap = new Map<number, { topics: number[]; products: number[] }>();
    for (const id of postIds) relationMap.set(id, { topics: [], products: [] });
    for (const relation of relations) {
      const item = relationMap.get(relation.leftId);
      if (!item) continue;
      if (relation.type === COMMUNITY_TOPIC && !item.topics.includes(relation.rightId)) {
        item.topics.push(relation.rightId);
      }
      if (relation.type === COMMUNITY_PRODUCT && !item.products.includes(relation.rightId)) {
        item.products.push(relation.rightId);
      }
    }
    return rows.map((row) => {
      const owner = row.type === 2
        ? userMap.get(row.relationId) ?? profileMap.get(`2:${row.relationId}`)
        : profileMap.get(`${row.type}:${row.relationId}`);
      const related = relationMap.get(row.id) ?? {
        topics: parseStoredIds(row.topicId),
        products: parseStoredIds(row.productId),
      };
      const topic = related.topics.map((id) => topicMap.get(id)).filter(Boolean);
      const product = related.products.map((id) => productMap.get(id)).filter(Boolean);
      const sliderImage = parseStoredStrings(row.sliderImage);
      const isLike = likedIds.has(row.id) ? 1 : 0;
      const isFollow = row.type === 2 && followed.has(row.relationId) ? 1 : 0;
      return {
        ...row,
        relation_id: row.relationId,
        content_type: row.contentType,
        video_url: row.videoUrl,
        sliderImage,
        slider_image: sliderImage,
        topicId: related.topics,
        topic_id: related.topics,
        productId: related.products,
        product_id: related.products,
        topic,
        product,
        productCount: product.length,
        like_num: row.likeNum,
        play_num: row.playNum,
        comment_num: row.commentNum,
        share_num: row.shareNum,
        add_time: row.addTime,
        is_verify: row.isVerify,
        is_del: row.isDel,
        is_self: uid && row.type === 2 && row.relationId === uid ? 1 : 0,
        isLike,
        is_like: isLike,
        is_follow: isFollow,
        author: owner?.nickname ?? (row.type === 0 ? "平台" : `用户 #${row.relationId}`),
        author_image: owner?.avatar ?? "",
      };
    });
  }

  private async formatComments(rows: Array<typeof communityComment.$inferSelect>, uid?: number) {
    if (!rows.length) return [];
    const userIds = [...new Set(rows.filter((row) => row.type === 2).flatMap((row) => [
      row.uid,
      row.commentReplyUid,
    ]).filter((id) => id > 0))];
    const users = userIds.length
      ? await this.container.db.select({ uid: user.uid, nickname: user.nickname, avatar: user.avatar })
        .from(user)
        .where(inArray(user.uid, userIds))
      : [];
    const userMap = new Map(users.map((row) => [row.uid, row]));
    const liked = await this.relevanceIds(uid, rows.map((row) => row.id), COMMUNITY_COMMENT_LIKE);
    return rows.map((row) => {
      const author = row.type === 2 ? userMap.get(row.uid) : undefined;
      const replyAuthor = row.commentReplyUid > 0 ? userMap.get(row.commentReplyUid) : undefined;
      const isLike = liked.has(row.id) ? 1 : 0;
      return {
        ...row,
        reply_id: row.replyId,
        reply_uid: row.replyUid,
        comment_reply_id: row.commentReplyId,
        comment_reply_uid: row.commentReplyUid,
        community_id: row.communityId,
        comment_num: row.commentNum,
        like_num: row.likeNum,
        is_verify: row.isVerify,
        is_show: row.isShow,
        is_reply: row.isReply,
        is_del: row.isDel,
        add_time: row.addTime,
        isLike,
        is_like: isLike,
        author: author?.nickname ?? (row.type === 0 ? "平台" : row.type === 3 ? row.nickname : `用户 #${row.uid}`),
        author_image: author?.avatar ?? (row.type === 3 ? row.avatar : ""),
        comment_author: replyAuthor?.nickname ?? "",
        comment_author_image: replyAuthor?.avatar ?? "",
      };
    });
  }

  private async relevanceIds(uid: number | undefined, ids: number[], type: string): Promise<Set<number>> {
    if (!uid || !ids.length) return new Set<number>();
    const rows = await this.container.db
      .select({ rightId: communityRelevance.rightId })
      .from(communityRelevance)
      .where(
        and(
          eq(communityRelevance.leftId, uid),
          eq(communityRelevance.type, type),
          inArray(communityRelevance.rightId, ids),
        ),
      );
    return new Set(rows.map((row) => row.rightId));
  }

}
