import { and, count, desc as orderDesc, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "@/env";
import { type Container, type DbClient, withTx } from "@/lib/di";
import {
  liveRoom,
  storeProduct,
  user,
  userRelation,
  video,
  videoComment,
} from "@/models/schema";
import { StoreProductService } from "@/services/product/StoreProductService";
import { signAttachmentReferences } from "@/services/system/AttachmentService";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { NotFoundException, ValidateException } from "@/utils/errors";

const RELATION_LOCK_NAMESPACE = 505_633;
const COMMENT_LOCK_NAMESPACE = 505_634;
const MAX_VIDEO_PAGE = 10;
const MAX_COMMENT_PAGE = 20;
type RelationType = "like" | "collect" | "share";

function positiveId(value: unknown, label = "参数"): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new ValidateException(`${label}错误`);
  }
  return parsed;
}

function paging(pageValue: unknown, limitValue: unknown, cap: number) {
  const page = Number(pageValue);
  const limit = Number(limitValue);
  const safePage = Number.isSafeInteger(page) && page > 0 ? Math.min(page, 1_000_000) : 1;
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, cap) : cap;
  return { limit: safeLimit, offset: (safePage - 1) * safeLimit };
}

function relationType(value: unknown): RelationType {
  if (value === "like" || value === "collect" || value === "share") return value;
  throw new ValidateException("操作类型错误");
}

function parseProductIds(raw: string): number[] {
  const seen = new Set<number>();
  for (const part of raw.split(",")) {
    const id = Number(part.trim());
    if (Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647) seen.add(id);
    if (seen.size >= 100) break;
  }
  return [...seen];
}

function shanghaiParts(epoch: number): Record<string, string> {
  if (!Number.isSafeInteger(epoch) || epoch <= 0) return {};
  const result: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epoch * 1000))) {
    if (part.type !== "literal") result[part.type] = part.value;
  }
  return result;
}

function formatEpoch(epoch: number): string {
  const p = shanghaiParts(epoch);
  return p.year ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}` : "";
}

function formatMonthDay(epoch: number): string {
  const p = shanghaiParts(epoch);
  return p.month ? `${p.month}月${p.day}日` : "";
}

function visibleVideo(id?: number) {
  return and(
    id ? eq(video.id, id) : undefined,
    eq(video.isShow, 1),
    eq(video.isDel, 0),
    eq(video.isVerify, 1),
  );
}

async function adjustVideoCounter(
  tx: DbClient,
  id: number,
  type: RelationType,
  delta: 1 | -1,
) {
  if (type === "like") {
    await tx.update(video).set({ likeNum: sql`GREATEST(${video.likeNum} + ${delta}, 0)` }).where(eq(video.id, id));
  } else if (type === "collect") {
    await tx.update(video).set({ collectNum: sql`GREATEST(${video.collectNum} + ${delta}, 0)` }).where(eq(video.id, id));
  } else {
    await tx.update(video).set({ shareNum: sql`GREATEST(${video.shareNum} + ${delta}, 0)` }).where(eq(video.id, id));
  }
}

async function adjustCommentCounter(
  tx: DbClient,
  id: number,
  type: RelationType,
  delta: 1 | -1,
) {
  if (type === "like") {
    await tx.update(videoComment).set({ likeNum: sql`GREATEST(${videoComment.likeNum} + ${delta}, 0)` }).where(eq(videoComment.id, id));
  } else if (type === "collect") {
    await tx.update(videoComment).set({ collectNum: sql`GREATEST(${videoComment.collectNum} + ${delta}, 0)` }).where(eq(videoComment.id, id));
  } else {
    await tx.update(videoComment).set({ shareNum: sql`GREATEST(${videoComment.shareNum} + ${delta}, 0)` }).where(eq(videoComment.id, id));
  }
}

export class ShortVideoService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async list(uid: number, params: Record<string, string | undefined>) {
    const configs = await new SystemConfigService(this.container, this.env).getMany([
      "video_func_status",
      "site_name",
      "wap_login_logo",
    ]);
    if (Number(configs.video_func_status || "1") === 0) return { list: [], playIds: [] as number[] };

    const page = paging(params.page, params.limit, MAX_VIDEO_PAGE);
    const selectedId = params.id ? positiveId(params.id, "视频ID") : 0;
    const orderType = Number(params.order_type ?? 0);
    const listWhere = !selectedId && orderType === 2
      ? and(visibleVideo(), eq(video.isRecommend, 1))
      : visibleVideo();
    const order = orderType === 1
      ? [orderDesc(video.id), orderDesc(video.sort)]
      : orderType === 2
        ? [orderDesc(video.isRecommend), orderDesc(video.sort), orderDesc(video.id)]
        : [orderDesc(video.sort), orderDesc(video.id)];
    const rows = await this.container.db
      .select()
      .from(video)
      .where(listWhere)
      .orderBy(
        ...(selectedId ? [sql`CASE WHEN ${video.id} = ${selectedId} THEN 0 ELSE 1 END`] : []),
        ...order,
      )
      .limit(page.limit)
      .offset(page.offset);
    if (rows.length === 0) return { list: [], playIds: [] as number[] };

    const ids = rows.map((row) => row.id);
    const productIdsByVideo = new Map(rows.map((row) => [row.id, parseProductIds(row.productId)]));
    const allProductIds = [...new Set([...productIdsByVideo.values()].flat())];
    const visibleProducts = allProductIds.length
      ? await this.container.db.select({ id: storeProduct.id }).from(storeProduct).where(and(
        inArray(storeProduct.id, allProductIds),
        eq(storeProduct.isShow, 1),
        eq(storeProduct.isDel, 0),
        eq(storeProduct.isVerify, 1),
      ))
      : [];
    const visibleProductIds = new Set(visibleProducts.map((item) => item.id));
    const relations = uid > 0
      ? await this.container.db.select({ relationId: userRelation.relationId, type: userRelation.type })
        .from(userRelation)
        .where(and(
          eq(userRelation.uid, uid),
          eq(userRelation.category, "video"),
          inArray(userRelation.relationId, ids),
          inArray(userRelation.type, ["like", "collect"]),
        ))
      : [];
    const relationSet = new Set(relations.map((item) => `${item.relationId}:${item.type}`));
    const [live] = await this.container.db.select({ value: count() }).from(liveRoom).where(and(
      eq(liveRoom.isShow, 1),
      eq(liveRoom.isDel, 0),
      eq(liveRoom.status, 1),
      inArray(liveRoom.liveStatus, [101, 105, 106]),
    ));
    const media = await signAttachmentReferences(
      this.env.APP_KEY,
      rows.flatMap((row) => [row.image, row.videoUrl]),
    );

    return {
      playIds: ids,
      list: rows.map((row, index) => {
        const productIds = productIdsByVideo.get(row.id) ?? [];
        return {
          id: String(row.id),
          type: row.type,
          relation_id: row.relationId,
          image: media[index * 2],
          desc: row.desc,
          video_url: media[index * 2 + 1],
          product_id: productIds,
          product_num: productIds.filter((id) => visibleProductIds.has(id)).length,
          is_show: row.isShow,
          is_recommend: row.isRecommend,
          sort: row.sort,
          is_verify: row.isVerify,
          comment_num: row.commentNum,
          like_num: row.likeNum,
          collect_num: row.collectNum,
          share_num: row.shareNum,
          play_num: row.playNum,
          add_time: formatEpoch(row.addTime),
          date: formatMonthDay(row.addTime),
          is_del: row.isDel,
          type_name: configs.site_name ?? "",
          type_image: configs.wap_login_logo ?? "",
          is_like: relationSet.has(`${row.id}:like`),
          is_collect: relationSet.has(`${row.id}:collect`),
          is_live: Number(live?.value ?? 0) > 0,
          isMore: false,
          state: "pause",
          playIng: false,
          isShowimage: false,
          isShowProgressBarTime: false,
          isplay: true,
        };
      }),
    };
  }

  async recordPlays(ids: number[]): Promise<void> {
    const unique = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, MAX_VIDEO_PAGE);
    if (!unique.length) return;
    await this.container.db.update(video)
      .set({ playNum: sql`GREATEST(${video.playNum} + 1, 0)` })
      .where(and(inArray(video.id, unique), visibleVideo()));
  }

  async info(idValue: unknown) {
    const id = positiveId(idValue, "视频ID");
    const [recommend] = await this.container.db
      .select({ id: video.id, desc: video.desc })
      .from(video)
      // PHP omitted is_verify here; enforcing storefront visibility prevents an
      // unreviewed recommendation from leaking through this secondary query.
      .where(and(visibleVideo(), eq(video.isRecommend, 1), sql`${video.id} <> ${id}`))
      .orderBy(sql`random()`)
      .limit(1);
    return { recommend: recommend ?? {} };
  }

  async products(uid: number, videoIdValue: unknown) {
    const videoId = positiveId(videoIdValue, "视频ID");
    const [row] = await this.container.db.select({ productId: video.productId }).from(video)
      .where(visibleVideo(videoId)).limit(1);
    if (!row) throw new NotFoundException("视频不存在");
    const ids = parseProductIds(row.productId);
    if (!ids.length) return { list: [], count: 0 };
    const result = await new StoreProductService(this.container, this.env).getGoodsList({
      ids: ids.join(","),
      page: 1,
      limit: Math.min(ids.length, 100),
    }, uid);
    for (const item of result.list) {
      if (!item.promotions || typeof item.promotions !== "object") item.promotions = {};
      item.store_id = Number(item.relation_id ?? 0) > 0 && Number(item.type ?? 0) === 1
        ? Number(item.relation_id)
        : 0;
    }
    return { list: result.list, count: result.count ?? result.list.length };
  }

  async comments(uid: number, videoIdValue: unknown, pidValue: unknown, pageValue: unknown, limitValue: unknown) {
    const videoId = positiveId(videoIdValue, "视频ID");
    const pid = Number(pidValue ?? 0);
    if (!Number.isSafeInteger(pid) || pid < 0) throw new ValidateException("评论ID错误");
    const [parentVideo] = await this.container.db.select({ id: video.id }).from(video)
      .where(visibleVideo(videoId)).limit(1);
    if (!parentVideo) throw new NotFoundException("视频不存在");
    if (pid > 0) {
      const [parent] = await this.container.db.select({ id: videoComment.id }).from(videoComment).where(and(
        eq(videoComment.id, pid), eq(videoComment.videoId, videoId), eq(videoComment.isDel, 0),
      )).limit(1);
      if (!parent) throw new NotFoundException("评论不存在");
    }
    const page = paging(pageValue, limitValue, MAX_COMMENT_PAGE);
    const rows = await this.container.db.select({
      id: videoComment.id,
      pid: videoComment.pid,
      videoId: videoComment.videoId,
      uid: videoComment.uid,
      nickname: videoComment.nickname,
      avatar: videoComment.avatar,
      content: videoComment.content,
      likeNum: videoComment.likeNum,
      city: videoComment.city,
      addTime: videoComment.addTime,
      isMoneyLevel: user.isMoneyLevel,
    }).from(videoComment).leftJoin(user, eq(user.uid, videoComment.uid)).where(and(
      eq(videoComment.videoId, videoId),
      eq(videoComment.pid, pid),
      eq(videoComment.isDel, 0),
    )).orderBy(orderDesc(videoComment.id)).limit(page.limit).offset(page.offset);
    if (!rows.length) return [];
    const commentIds = rows.map((row) => row.id);
    const replies = await this.container.db.select({ pid: videoComment.pid, value: count() }).from(videoComment)
      .where(and(inArray(videoComment.pid, commentIds), eq(videoComment.isDel, 0)))
      .groupBy(videoComment.pid);
    const replyCounts = new Map(replies.map((row) => [row.pid, Number(row.value)]));
    const likes = uid > 0
      ? await this.container.db.select({ relationId: userRelation.relationId }).from(userRelation).where(and(
        eq(userRelation.uid, uid),
        eq(userRelation.category, "video_comment"),
        eq(userRelation.type, "like"),
        inArray(userRelation.relationId, commentIds),
      ))
      : [];
    const liked = new Set(likes.map((row) => row.relationId));
    const avatars = await signAttachmentReferences(this.env.APP_KEY, rows.map((row) => row.avatar));
    return rows.map((row, index) => ({
      id: row.id,
      pid: row.pid,
      video_id: row.videoId,
      uid: row.uid,
      nickname: row.nickname,
      avatar: avatars[index],
      content: row.content,
      like_num: row.likeNum,
      city: row.city,
      add_time: formatEpoch(row.addTime),
      is_money_level: row.isMoneyLevel ?? 0,
      is_like: liked.has(row.id),
      reply: [],
      reply_count: replyCounts.get(row.id) ?? 0,
    }));
  }

  async commentReplies(uid: number, parentIdValue: unknown, pageValue: unknown, limitValue: unknown) {
    const parentId = positiveId(parentIdValue, "评论ID");
    const [parent] = await this.container.db.select({
      id: videoComment.id,
      pid: videoComment.pid,
      videoId: videoComment.videoId,
    }).from(videoComment).where(and(
      eq(videoComment.id, parentId),
      eq(videoComment.isDel, 0),
    )).limit(1);
    if (!parent) throw new NotFoundException("评论不存在");
    const rootId = parent.pid > 0 ? parent.pid : parent.id;
    return this.comments(uid, parent.videoId, rootId, pageValue, limitValue);
  }

  async saveComment(uid: number, videoIdValue: unknown, pidValue: unknown, contentValue: unknown) {
    const videoId = positiveId(videoIdValue, "视频ID");
    const inputPid = Number(pidValue ?? 0);
    if (!Number.isSafeInteger(inputPid) || inputPid < 0) throw new ValidateException("评论ID错误");
    if (typeof contentValue !== "string") throw new ValidateException("请输入评论内容");
    const content = contentValue.trim();
    if (!content) throw new ValidateException("请输入评论内容");
    if ([...content].length > 500) throw new ValidateException("评论内容不能超过500个字符");
    if (/[\u0000-\u001f\u007f]/u.test(content)) throw new ValidateException("评论内容不能包含控制字符");
    const created = await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${COMMENT_LOCK_NAMESPACE}, hashtext(${`video-comment:${videoId}`}))`);
      const [parentVideo] = await tx.select({ id: video.id, type: video.type, relationId: video.relationId })
        .from(video).where(visibleVideo(videoId)).limit(1).for("update");
      if (!parentVideo) throw new NotFoundException("视频不存在");
      const [author] = await tx.select({ nickname: user.nickname, avatar: user.avatar }).from(user).where(and(
        eq(user.uid, uid), eq(user.status, 1), eq(user.isDel, 0),
      )).limit(1);
      if (!author) throw new NotFoundException("用户不存在");
      let pid = 0;
      if (inputPid > 0) {
        const [parent] = await tx.select({ id: videoComment.id, pid: videoComment.pid }).from(videoComment).where(and(
          eq(videoComment.id, inputPid),
          eq(videoComment.videoId, videoId),
          eq(videoComment.isDel, 0),
        )).limit(1).for("update");
        if (!parent) throw new NotFoundException("评论不存在");
        pid = parent.pid > 0 ? parent.pid : parent.id;
      }
      const addTime = Math.floor(Date.now() / 1000);
      const [saved] = await tx.insert(videoComment).values({
        type: parentVideo.type,
        relationId: parentVideo.relationId,
        pid,
        videoId,
        uid,
        nickname: author.nickname,
        avatar: author.avatar,
        content,
        // Do not retain request IP/geolocation merely for legacy parity.
        ip: "",
        city: "",
        isReply: pid > 0 ? 1 : 0,
        addTime,
      }).returning();
      await tx.update(video).set({ commentNum: sql`GREATEST(${video.commentNum} + 1, 0)` }).where(eq(video.id, videoId));
      return saved;
    });
    const [avatar] = await signAttachmentReferences(this.env.APP_KEY, [created.avatar]);
    return {
      id: created.id,
      pid: created.pid,
      video_id: created.videoId,
      uid: created.uid,
      nickname: created.nickname,
      avatar,
      content: created.content,
      like_num: created.likeNum,
      city: created.city,
      add_time: formatEpoch(created.addTime),
      is_like: false,
      reply: [],
      reply_count: 0,
    };
  }

  async deleteComment(uid: number, commentIdValue: unknown) {
    const commentId = positiveId(commentIdValue, "评论ID");
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${COMMENT_LOCK_NAMESPACE}, hashtext(${`video-comment-delete:${commentId}`}))`);
      const [row] = await tx.select({ id: videoComment.id, uid: videoComment.uid, videoId: videoComment.videoId })
        .from(videoComment).where(and(eq(videoComment.id, commentId), eq(videoComment.isDel, 0)))
        .limit(1).for("update");
      if (!row) throw new NotFoundException("评论不存在");
      if (row.uid !== uid) throw new ValidateException("无权删除该评论");
      await tx.update(videoComment).set({ isDel: 1 }).where(eq(videoComment.id, commentId));
      await tx.update(video).set({ commentNum: sql`GREATEST(${video.commentNum} - 1, 0)` }).where(eq(video.id, row.videoId));
      return { id: commentId };
    });
  }

  async toggleVideoRelation(uid: number, typeValue: unknown, idValue: unknown) {
    return this.toggleRelation(uid, "video", relationType(typeValue), positiveId(idValue, "视频ID"));
  }

  async toggleCommentRelation(uid: number, typeValue: unknown, idValue: unknown) {
    return this.toggleRelation(uid, "video_comment", relationType(typeValue), positiveId(idValue, "评论ID"));
  }

  private async toggleRelation(
    uid: number,
    category: "video" | "video_comment",
    type: RelationType,
    id: number,
  ) {
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(
        ${RELATION_LOCK_NAMESPACE}, hashtext(${`${category}:${uid}:${id}:${type}`})
      )`);
      if (category === "video") {
        const [target] = await tx.select({ id: video.id }).from(video).where(visibleVideo(id)).limit(1).for("update");
        if (!target) throw new NotFoundException("视频不存在");
      } else {
        const [target] = await tx.select({ id: videoComment.id }).from(videoComment).innerJoin(
          video, eq(video.id, videoComment.videoId),
        ).where(and(eq(videoComment.id, id), eq(videoComment.isDel, 0), visibleVideo())).limit(1).for("update", { of: videoComment });
        if (!target) throw new NotFoundException("评论不存在");
      }
      const [existing] = await tx.select({ id: userRelation.id }).from(userRelation).where(and(
        eq(userRelation.uid, uid),
        eq(userRelation.relationId, id),
        eq(userRelation.type, type),
        eq(userRelation.category, category),
      )).limit(1);
      const status: 0 | 1 = existing ? 0 : 1;
      if (existing) {
        await tx.delete(userRelation).where(and(
          eq(userRelation.uid, uid),
          eq(userRelation.relationId, id),
          eq(userRelation.type, type),
          eq(userRelation.category, category),
        ));
      } else {
        await tx.insert(userRelation).values({ uid, relationId: id, type, category, addTime: Math.floor(Date.now() / 1000) });
      }
      const delta = status === 1 ? 1 : -1;
      if (category === "video") await adjustVideoCounter(tx, id, type, delta);
      else await adjustCommentCounter(tx, id, type, delta);
      return { status };
    });
  }
}
