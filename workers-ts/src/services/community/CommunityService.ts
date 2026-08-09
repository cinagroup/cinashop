/**
 * 社区 Service
 *
 * 对应原版端点: community/list, detail, like, comment, save
 */
import { eq, sql } from "drizzle-orm";
import { community as communityTable } from "@/models/schema";
import type { Container } from "@/lib/di";
import { ValidateException, NotFoundException } from "@/utils/errors";

export class CommunityService {
  constructor(private readonly container: Container) {}

  /** 帖子列表 (community/list) */
  async list(page = 1, limit = 10) {
    const list = await this.container.communityDao.list(page, limit);
    // 解析 JSON 字段
    return list.map((item) => ({
      ...item,
      sliderImage: this.parseJson(item.sliderImage),
      topicId: this.parseJson(item.topicId),
      productId: this.parseJson(item.productId),
    }));
  }

  /** 帖子详情 (community/detail/:id) */
  async detail(id: number) {
    const item = await this.container.communityDao.getById(id);
    if (!item) throw new NotFoundException("帖子不存在");
    // 浏览 +1
    await this.container.db
      .update(communityTable)
      .set({ playNum: sql`play_num + 1` })
      .where(eq(communityTable.id, id))
      .catch(() => {});
    return {
      ...item,
      sliderImage: this.parseJson(item.sliderImage),
      topicId: this.parseJson(item.topicId),
      productId: this.parseJson(item.productId),
    };
  }

  /** 发布帖子 (community_save) */
  async create(
    uid: number,
    params: {
      title: string;
      content: string;
      contentType: number;
      image?: string;
      sliderImage?: string[];
    },
  ): Promise<{ id: number }> {
    if (!params.title && !params.content) {
      throw new ValidateException("帖子内容不能为空");
    }
    const row = await this.container.communityDao.save({
      type: 2, // 用户帖
      relationId: uid,
      contentType: params.contentType,
      title: params.title,
      content: params.content,
      image: params.image ?? "",
      sliderImage: params.sliderImage ? JSON.stringify(params.sliderImage) : "[]",
      status: 1,
      isVerify: 1,
      addTime: Math.floor(Date.now() / 1000),
    });
    return { id: row.id };
  }

  /** 点赞 (community_like/:id) */
  async like(id: number): Promise<void> {
    await this.container.communityDao.incLike(id);
  }

  /** 评论列表 (community/comment/list) */
  async commentList(communityId: number, page = 1, limit = 10) {
    return this.container.communityCommentDao.listByCommunity(communityId, page, limit);
  }

  /** 发表评论 (community/comment/save) */
  async addComment(
    uid: number,
    params: { communityId: number; content: string },
  ): Promise<{ id: number }> {
    if (!params.content) throw new ValidateException("评论内容不能为空");
    const row = await this.container.communityCommentDao.save({
      type: 2,
      uid,
      communityId: params.communityId,
      content: params.content,
      ip: "",
      addTime: Math.floor(Date.now() / 1000),
    });
    // 评论数 +1
    await this.container.db
      .update(communityTable)
      .set({ commentNum: sql`comment_num + 1` })
      .where(eq(communityTable.id, params.communityId))
      .catch(() => {});
    return { id: row.id };
  }

  /** 删除帖子 (community_delete/:id) */
  async del(uid: number, id: number): Promise<void> {
    const item = await this.container.communityDao.getById(id);
    if (!item) throw new NotFoundException("帖子不存在");
    if (item.relationId !== uid) throw new ValidateException("只能删除自己的帖子");
    await this.container.communityDao.update(id, { status: 0 });
  }

  private parseJson(raw: string | null): unknown {
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
}
