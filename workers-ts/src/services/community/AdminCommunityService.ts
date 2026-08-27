import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  community,
  communityComment,
  communityRelevance,
  communityTopic,
  communityUser,
  storeProduct,
  user,
} from "@/models/schema";
import { withTx, type Container, type DbClient } from "@/lib/di";
import { NotFoundException, ValidateException } from "@/utils/errors";

const COMMUNITY_TOPIC = "community_topic";
const COMMUNITY_PRODUCT = "community_product";
const COMMUNITY_LIKE = "community_like";
const COMMUNITY_BROWSE = "community_browse";
const COMMUNITY_COMMENT_LIKE = "community_comment_like";
const COMMUNITY_ADMIN_LOCK_NAMESPACE = 17_349;
const MAX_RELATIONS = 50;

type CommunityRow = typeof community.$inferSelect;
type CommunityCommentRow = typeof communityComment.$inferSelect;

export interface NormalizedAdminPostInput {
  contentType: number;
  title: string;
  content: string;
  image: string;
  videoUrl: string;
  sliderImage: string[];
  topicIds: number[];
  productIds: number[];
  status: number;
  isRecommend: number;
  star: number;
  sort: number;
}

export interface NormalizedCommunityTopicInput {
  name: string;
  sort: number;
  isRecommend: number;
  status: number;
}

export interface NormalizedClientCommunityPostInput {
  contentType: number;
  title: string;
  content: string;
  image: string;
  videoUrl: string;
  sliderImage: string[];
  topicIds: number[];
  productIds: number[];
  isVerify: 0 | 1;
}

function pick(input: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (input[key] !== undefined) return input[key];
  return undefined;
}

function integer(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; fallback?: number } = {},
): number {
  if ((value === undefined || value === null || value === "") && options.fallback !== undefined) {
    return options.fallback;
  }
  const parsed = Number(value);
  const min = options.min ?? 0;
  const max = options.max ?? 2_147_483_647;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidateException(`${label}格式错误`);
  }
  return parsed;
}

function optionalInteger(value: unknown, allowed: ReadonlySet<number>): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && allowed.has(parsed) ? parsed : undefined;
}

function boundedString(value: unknown, label: string, max: number, required = false): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw new ValidateException(`请填写${label}`);
  if (text.length > max) throw new ValidateException(`${label}不能超过${max}个字符`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new ValidateException(`${label}包含不支持的控制字符`);
  }
  return text;
}

function idArray(value: unknown, label: string, required = false): number[] {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ValidateException(`请至少选择一个${label}`);
    return [];
  }
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(parsed)) throw new ValidateException(`${label}格式错误`);
  const ids = [...new Set(parsed.map(Number))];
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new ValidateException(`${label}格式错误`);
  }
  if (ids.length > MAX_RELATIONS) throw new ValidateException(`${label}不能超过${MAX_RELATIONS}项`);
  if (required && !ids.length) throw new ValidateException(`请至少选择一个${label}`);
  return ids;
}

function stringArray(value: unknown, label: string, maxItems = 20): string[] {
  if (value === undefined || value === null || value === "") return [];
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(parsed)) throw new ValidateException(`${label}格式错误`);
  const values = [...new Set(parsed.map((item) => boundedString(item, label, 255)).filter(Boolean))];
  if (values.length > maxItems) throw new ValidateException(`${label}不能超过${maxItems}项`);
  return values;
}

function parseStoredStrings(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string").slice(0, 20)
      : [];
  } catch {
    return [];
  }
}

function positivePage(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseStoredIds(value: string | null): number[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return [...new Set(parsed.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
    }
  } catch {
    return [...new Set(value.split(",").map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  }
  return [];
}

function epoch(value: unknown, label: string, fallback?: number): number {
  if ((value === undefined || value === null || value === "") && fallback !== undefined) return fallback;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  if (typeof value === "string") {
    const millis = Date.parse(value);
    if (Number.isFinite(millis) && millis >= 0) return Math.floor(millis / 1000);
  }
  throw new ValidateException(`${label}格式错误`);
}

function parseTimeRange(query: Record<string, string | undefined>): [number | undefined, number | undefined] {
  let start = query.start_time ? epoch(query.start_time, "开始时间") : undefined;
  let end = query.end_time ? epoch(query.end_time, "结束时间") : undefined;
  const raw = query.data?.trim();
  if (raw && start === undefined && end === undefined) {
    let values: unknown = raw;
    try {
      values = JSON.parse(raw);
    } catch {
      values = raw.split(/\s+-\s+|,/).map((item) => item.trim()).filter(Boolean);
    }
    if (Array.isArray(values) && values.length >= 2) {
      start = epoch(values[0], "开始时间");
      end = epoch(values[1], "结束时间");
    }
  }
  if (start !== undefined && end !== undefined && end < start) {
    throw new ValidateException("结束时间不能早于开始时间");
  }
  return [start, end];
}

export function normalizeAdminCommunityPostInput(
  input: Record<string, unknown>,
  defaults: Partial<NormalizedAdminPostInput> = {},
): NormalizedAdminPostInput {
  const contentType = integer(pick(input, "content_type", "contentType"), "内容类型", {
    min: 1,
    max: 2,
    fallback: defaults.contentType ?? 1,
  });
  const sliderImage = pick(input, "slider_image", "sliderImage") === undefined
    ? defaults.sliderImage ?? []
    : stringArray(pick(input, "slider_image", "sliderImage"), "图集");
  const image = boundedString(
    pick(input, "image") ?? defaults.image ?? sliderImage[0] ?? "",
    "封面图",
    255,
  ) || sliderImage[0] || "";
  const videoUrl = boundedString(
    pick(input, "video_url", "videoUrl") ?? defaults.videoUrl ?? "",
    "视频地址",
    255,
  );
  if (contentType === 2 && !videoUrl) throw new ValidateException("视频内容必须填写视频地址");
  const topicValue = pick(input, "topic_id", "topicIds");
  const productValue = pick(input, "product_id", "productIds");
  const topicIds = topicValue === undefined
    ? defaults.topicIds ?? []
    : idArray(topicValue, "话题", true);
  if (!topicIds.length) throw new ValidateException("请至少选择一个话题");
  return {
    contentType,
    title: boundedString(pick(input, "title") ?? defaults.title ?? "", "社区内容标题", 255, true),
    content: boundedString(pick(input, "content") ?? defaults.content ?? "", "社区内容", 200_000),
    image,
    videoUrl,
    sliderImage,
    topicIds,
    productIds: productValue === undefined
      ? defaults.productIds ?? []
      : idArray(productValue, "商品"),
    status: integer(pick(input, "status"), "显示状态", {
      min: 0,
      max: 1,
      fallback: defaults.status ?? 1,
    }),
    isRecommend: integer(pick(input, "is_recommend", "isRecommend"), "推荐状态", {
      min: 0,
      max: 1,
      fallback: defaults.isRecommend ?? 1,
    }),
    star: integer(pick(input, "star"), "推荐指数", { min: 1, max: 5, fallback: defaults.star ?? 1 }),
    sort: integer(pick(input, "sort"), "排序", {
      min: -2_147_483_648,
      max: 2_147_483_647,
      fallback: defaults.sort ?? 0,
    }),
  };
}

export function normalizeCommunityTopicInput(
  input: Record<string, unknown>,
  defaults: Partial<NormalizedCommunityTopicInput> = {},
): NormalizedCommunityTopicInput {
  return {
    name: boundedString(pick(input, "name") ?? defaults.name ?? "", "话题名称", 20, true),
    sort: integer(pick(input, "sort"), "排序", {
      min: -2_147_483_648,
      max: 2_147_483_647,
      fallback: defaults.sort ?? 0,
    }),
    isRecommend: integer(pick(input, "is_recommend", "isRecommend"), "推荐状态", {
      min: 0,
      max: 1,
      fallback: defaults.isRecommend ?? 0,
    }),
    status: integer(pick(input, "status"), "显示状态", {
      min: 0,
      max: 1,
      fallback: defaults.status ?? 0,
    }),
  };
}

export function normalizeClientCommunityPostInput(
  input: Record<string, unknown>,
  isVerifyValue: unknown,
  defaults: Partial<NormalizedClientCommunityPostInput> = {},
): NormalizedClientCommunityPostInput {
  const contentType = integer(pick(input, "content_type", "contentType"), "内容类型", {
    min: 1,
    max: 2,
    fallback: defaults.contentType ?? 1,
  });
  const sliderValue = pick(input, "slider_image", "sliderImage");
  const sliderImage = sliderValue === undefined
    ? defaults.sliderImage ?? []
    : stringArray(sliderValue, "图集");
  const title = boundedString(pick(input, "title") ?? defaults.title ?? "", "标题", 255);
  const content = boundedString(
    pick(input, "content") ?? defaults.content ?? "",
    "社区内容",
    200_000,
  );
  if (!title && !content) throw new ValidateException("帖子内容不能为空");
  const image = boundedString(
    pick(input, "image") ?? defaults.image ?? sliderImage[0] ?? "",
    "封面图",
    255,
  ) || sliderImage[0] || "";
  const videoUrl = boundedString(
    pick(input, "video_url", "videoUrl") ?? defaults.videoUrl ?? "",
    "视频地址",
    255,
  );
  if (contentType === 2 && !videoUrl) throw new ValidateException("视频内容必须填写视频地址");
  const topicValue = pick(input, "topic_id", "topicIds");
  const productValue = pick(input, "product_id", "productIds");
  const isVerify = integer(isVerifyValue, "审核状态", { min: 0, max: 1 }) as 0 | 1;
  return {
    contentType,
    title,
    content,
    image,
    videoUrl,
    sliderImage,
    topicIds: topicValue === undefined ? defaults.topicIds ?? [] : idArray(topicValue, "话题"),
    productIds: productValue === undefined ? defaults.productIds ?? [] : idArray(productValue, "商品"),
    isVerify,
  };
}

function postView(row: CommunityRow, author?: { nickname: string; avatar: string }) {
  const topicIds = parseStoredIds(row.topicId);
  const productIds = parseStoredIds(row.productId);
  return {
    ...row,
    relation_id: row.relationId,
    content_type: row.contentType,
    video_url: row.videoUrl,
    slider_image: parseStoredStrings(row.sliderImage),
    topic_id: topicIds,
    product_id: productIds,
    like_num: row.likeNum,
    collect_num: row.collectNum,
    play_num: row.playNum,
    comment_num: row.commentNum,
    share_num: row.shareNum,
    is_recommend: row.isRecommend,
    is_verify: row.isVerify,
    is_del: row.isDel,
    verify_time: row.verifyTime,
    add_time: row.addTime,
    author: author?.nickname ?? (row.type === 0 ? "平台" : row.type === 1 ? `门店 #${row.relationId}` : `用户 #${row.relationId}`),
    author_image: author?.avatar ?? "",
  };
}

function topicView(row: typeof communityTopic.$inferSelect, communityNum?: number) {
  return {
    ...row,
    is_recommend: row.isRecommend,
    use_num: row.useNum,
    view_num: row.viewNum,
    is_del: row.isDel,
    add_time: row.addTime,
    community_num: communityNum ?? row.useNum,
  };
}

function commentView(
  row: CommunityCommentRow,
  options: {
    author?: { nickname: string; avatar: string };
    communityTitle?: string;
    replyContent?: string;
    replyCount?: number;
  } = {},
) {
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
    update_time: row.updateTime,
    add_time: row.addTime,
    author: options.author?.nickname ?? (row.type === 0 ? "平台" : row.type === 3 ? row.nickname || "虚拟用户" : `用户 #${row.uid}`),
    author_image: options.author?.avatar ?? (row.type === 3 ? row.avatar : ""),
    community_title: options.communityTitle ?? "",
    comment_reply_content: options.replyContent ?? "-",
    verify_count: options.replyCount ?? 0,
  };
}

export class AdminCommunityService {
  constructor(private readonly container: Container) {}

  async postHeader(query: Record<string, string | undefined>) {
    const conditions = this.postConditions(query, false);
    const grouped = await this.container.db
      .select({ isVerify: community.isVerify, count: sql<number>`COUNT(*)::int` })
      .from(community)
      .where(and(...conditions))
      .groupBy(community.isVerify);
    const counts = new Map(grouped.map((row) => [row.isVerify, row.count]));
    return [
      { is_verify: 1, name: "已发布", count: counts.get(1) ?? 0 },
      { is_verify: 0, name: "待审核", count: counts.get(0) ?? 0 },
      { is_verify: -1, name: "审核未通过", count: counts.get(-1) ?? 0 },
      { is_verify: -2, name: "强制下架", count: counts.get(-2) ?? 0 },
    ];
  }

  async posts(query: Record<string, string | undefined>) {
    const page = positivePage(query.page, 1);
    const limit = Math.min(100, positivePage(query.limit, 20));
    const conditions = this.postConditions(query, true);
    const [rows, counts] = await Promise.all([
      this.container.db.select().from(community)
        .where(and(...conditions))
        .orderBy(desc(community.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` }).from(community).where(and(...conditions)),
    ]);
    return { list: await this.formatPosts(rows), count: counts[0]?.count ?? 0 };
  }

  async postDetail(idValue: unknown) {
    const id = integer(idValue, "社区内容", { min: 1 });
    const rows = await this.container.db.select().from(community)
      .where(and(eq(community.id, id), eq(community.isDel, 0))).limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException("社区内容不存在");
    const relations = await this.container.db.select({ rightId: communityRelevance.rightId, type: communityRelevance.type })
      .from(communityRelevance)
      .where(and(eq(communityRelevance.leftId, id), inArray(communityRelevance.type, [COMMUNITY_TOPIC, COMMUNITY_PRODUCT])));
    const topicIds = [...new Set(relations.filter((item) => item.type === COMMUNITY_TOPIC).map((item) => item.rightId))];
    const productIds = [...new Set(relations.filter((item) => item.type === COMMUNITY_PRODUCT).map((item) => item.rightId))];
    const [formatted] = await this.formatPosts([row]);
    const [topics, products] = await Promise.all([
      topicIds.length
        ? this.container.db.select({ id: communityTopic.id, name: communityTopic.name }).from(communityTopic).where(inArray(communityTopic.id, topicIds))
        : Promise.resolve([]),
      productIds.length
        ? this.container.db.select({ id: storeProduct.id, store_name: storeProduct.storeName, image: storeProduct.image }).from(storeProduct).where(inArray(storeProduct.id, productIds))
        : Promise.resolve([]),
    ]);
    return { ...formatted, topic_id: topicIds, product_id: productIds, topic: topics, productInfo: products };
  }

  async savePost(idValue: unknown, input: Record<string, unknown>): Promise<{ id: number }> {
    const id = idValue === undefined || idValue === null || idValue === ""
      ? 0
      : integer(idValue, "社区内容", { min: 0 });
    return withTx(this.container, async (tx) => {
      let existing: CommunityRow | undefined;
      let oldTopicIds: number[] = [];
      if (id) {
        await this.lock(tx, `post:${id}`);
        const rows = await tx.select().from(community)
          .where(and(eq(community.id, id), eq(community.isDel, 0))).limit(1).for("update");
        existing = rows[0];
        if (!existing) throw new NotFoundException("社区内容不存在");
        oldTopicIds = await this.relationIds(tx, id, COMMUNITY_TOPIC);
      } else {
        await this.lock(tx, "post:create");
      }
      const normalized = normalizeAdminCommunityPostInput(input, existing ? {
        contentType: existing.contentType,
        title: existing.title,
        content: existing.content ?? "",
        image: existing.image,
        videoUrl: existing.videoUrl,
        sliderImage: parseStoredStrings(existing.sliderImage),
        topicIds: await this.relationIds(tx, existing.id, COMMUNITY_TOPIC),
        productIds: await this.relationIds(tx, existing.id, COMMUNITY_PRODUCT),
        status: existing.status,
        isRecommend: existing.isRecommend,
        star: existing.star,
        sort: existing.sort,
      } : undefined);
      await this.validateReferences(tx, normalized.topicIds, normalized.productIds);
      const values = {
        contentType: normalized.contentType,
        title: normalized.title,
        content: normalized.content,
        image: normalized.image,
        videoUrl: normalized.videoUrl,
        sliderImage: JSON.stringify(normalized.sliderImage),
        topicId: JSON.stringify(normalized.topicIds),
        productId: JSON.stringify(normalized.productIds),
        status: normalized.status,
        isRecommend: normalized.isRecommend,
        star: normalized.star,
        sort: normalized.sort,
        refusal: "",
      };
      const now = Math.floor(Date.now() / 1000);
      let postId = id;
      let ownerType = existing?.type ?? 0;
      let ownerId = existing?.relationId ?? 0;
      if (existing) {
        await tx.update(community).set(values).where(eq(community.id, existing.id));
      } else {
        const inserted = await tx.insert(community).values({
          ...values,
          type: 0,
          relationId: 0,
          isVerify: 1,
          verifyTime: now,
          isDel: 0,
          addTime: now,
        }).returning({ id: community.id });
        postId = inserted[0]?.id ?? 0;
        if (!postId) throw new Error("社区内容创建失败");
        ownerType = 0;
        ownerId = 0;
      }
      await tx.delete(communityRelevance).where(and(
        eq(communityRelevance.leftId, postId),
        inArray(communityRelevance.type, [COMMUNITY_TOPIC, COMMUNITY_PRODUCT]),
      ));
      const relations = [
        ...normalized.topicIds.map((rightId) => ({ leftId: postId, rightId, type: COMMUNITY_TOPIC })),
        ...normalized.productIds.map((rightId) => ({ leftId: postId, rightId, type: COMMUNITY_PRODUCT })),
      ];
      if (relations.length) await tx.insert(communityRelevance).values(relations);
      await this.syncAuthorPostCount(tx, ownerType, ownerId, now);
      await this.syncTopicCounts(tx, [...new Set([...oldTopicIds, ...normalized.topicIds])]);
      return { id: postId };
    });
  }

  /**
   * Create or edit a user-owned post with the same lifecycle locks and exact
   * projections as Admin moderation. Editing is intentionally owner-scoped;
   * the PHP controller accepted any existing id and therefore exposed an IDOR.
   */
  async saveUserPost(
    uidValue: unknown,
    idValue: unknown,
    input: Record<string, unknown>,
    isVerifyValue: unknown,
  ): Promise<{ id: number }> {
    const uid = integer(uidValue, "用户", { min: 1 });
    const id = idValue === undefined || idValue === null || idValue === ""
      ? 0
      : integer(idValue, "社区内容", { min: 0 });
    return withTx(this.container, async (tx) => {
      await this.lock(tx, id ? `post:${id}` : `post:create:${uid}`);
      const existing = id
        ? (await tx.select().from(community)
          .where(and(eq(community.id, id), eq(community.isDel, 0)))
          .limit(1)
          .for("update"))[0]
        : undefined;
      if (id && !existing) throw new NotFoundException("社区内容不存在");
      if (existing && (existing.type !== 2 || existing.relationId !== uid)) {
        throw new ValidateException("只能编辑自己的帖子");
      }
      const oldTopicIds = existing ? await this.relationIds(tx, existing.id, COMMUNITY_TOPIC) : [];
      const normalized = normalizeClientCommunityPostInput(input, isVerifyValue, existing ? {
        contentType: existing.contentType,
        title: existing.title,
        content: existing.content ?? "",
        image: existing.image,
        videoUrl: existing.videoUrl,
        sliderImage: parseStoredStrings(existing.sliderImage),
        topicIds: oldTopicIds,
        productIds: await this.relationIds(tx, existing.id, COMMUNITY_PRODUCT),
      } : undefined);
      await this.validateReferences(tx, normalized.topicIds, normalized.productIds, true);
      const now = Math.floor(Date.now() / 1000);
      const values = {
        contentType: normalized.contentType,
        title: normalized.title,
        content: normalized.content,
        image: normalized.image,
        videoUrl: normalized.videoUrl,
        sliderImage: JSON.stringify(normalized.sliderImage),
        topicId: JSON.stringify(normalized.topicIds),
        productId: JSON.stringify(normalized.productIds),
        status: 1,
        isVerify: normalized.isVerify,
        refusal: "",
        verifyTime: normalized.isVerify === 1 ? now : 0,
      };
      let postId = id;
      if (existing) {
        await tx.update(community).set(values).where(eq(community.id, existing.id));
      } else {
        const inserted = await tx.insert(community).values({
          ...values,
          type: 2,
          relationId: uid,
          isRecommend: 0,
          star: 1,
          sort: 0,
          isDel: 0,
          addTime: now,
        }).returning({ id: community.id });
        postId = inserted[0]?.id ?? 0;
        if (!postId) throw new Error("社区内容创建失败");
      }
      await tx.delete(communityRelevance).where(and(
        eq(communityRelevance.leftId, postId),
        inArray(communityRelevance.type, [COMMUNITY_TOPIC, COMMUNITY_PRODUCT]),
      ));
      const relations = [
        ...normalized.topicIds.map((rightId) => ({ leftId: postId, rightId, type: COMMUNITY_TOPIC })),
        ...normalized.productIds.map((rightId) => ({ leftId: postId, rightId, type: COMMUNITY_PRODUCT })),
      ];
      if (relations.length) await tx.insert(communityRelevance).values(relations);
      await this.syncAuthorPostCount(tx, 2, uid, now);
      await this.syncTopicCounts(tx, [...new Set([...oldTopicIds, ...normalized.topicIds])]);
      return { id: postId };
    });
  }

  async setPostStatus(idValue: unknown, statusValue: unknown): Promise<void> {
    const id = integer(idValue, "社区内容", { min: 1 });
    const status = integer(statusValue, "显示状态", { min: 0, max: 1 });
    await this.updatePostLifecycle(id, { status });
  }

  async setPostRecommend(idValue: unknown, value: unknown): Promise<void> {
    const id = integer(idValue, "社区内容", { min: 1 });
    const isRecommend = integer(value, "推荐状态", { min: 0, max: 1 });
    await this.updatePostLifecycle(id, { isRecommend }, false);
  }

  async setPostStar(idValue: unknown, value: unknown): Promise<void> {
    const id = integer(idValue, "社区内容", { min: 1 });
    const star = integer(value, "推荐指数", { min: 1, max: 5 });
    await this.updatePostLifecycle(id, { star }, false);
  }

  async setPostVerify(idValue: unknown, input: Record<string, unknown>): Promise<void> {
    const id = integer(idValue, "社区内容", { min: 1 });
    const isVerify = integer(pick(input, "is_verify", "isVerify"), "审核状态", { min: -2, max: 1 });
    if (![1, 0, -1, -2].includes(isVerify)) throw new ValidateException("审核状态格式错误");
    const refusal = boundedString(pick(input, "refusal"), "审核原因", 255, isVerify === -1 || isVerify === -2);
    await this.updatePostLifecycle(id, {
      isVerify,
      refusal: isVerify === 1 || isVerify === 0 ? "" : refusal,
      verifyTime: Math.floor(Date.now() / 1000),
    });
  }

  async deletePost(idValue: unknown): Promise<void> {
    const id = integer(idValue, "社区内容", { min: 1 });
    await this.deletePostRecord(id);
  }

  /** Reuse the same locked cascade for the authenticated client delete route. */
  async deleteOwnedPost(idValue: unknown, uidValue: unknown): Promise<void> {
    const id = integer(idValue, "社区内容", { min: 1 });
    const uid = integer(uidValue, "用户", { min: 1 });
    await this.deletePostRecord(id, uid);
  }

  /** Insert a user top-level comment under the same post lock as moderation. */
  async addUserComment(
    uidValue: unknown,
    communityIdValue: unknown,
    contentValue: unknown,
    ip = "",
    replyCommentIdValue: unknown = 0,
    isVerifyValue: unknown = 1,
  ): Promise<{ id: number }> {
    const uid = integer(uidValue, "用户", { min: 1 });
    const communityId = integer(communityIdValue, "社区内容", { min: 1 });
    const content = boundedString(contentValue, "评论内容", 1000, true);
    const replyCommentId = integer(replyCommentIdValue, "回复评论", { min: 0, fallback: 0 });
    const isVerify = integer(isVerifyValue, "审核状态", { min: 0, max: 1 });
    return withTx(this.container, async (tx) => {
      const post = await this.lockPost(tx, communityId);
      if (!post || post.status !== 1 || post.isVerify !== 1) {
        throw new NotFoundException("社区内容不存在或不可评论");
      }
      let replyId = 0;
      let replyUid = 0;
      let commentReplyId = 0;
      let commentReplyUid = 0;
      let isReply = 1;
      if (replyCommentId > 0) {
        const target = (await tx.select().from(communityComment)
          .where(and(
            eq(communityComment.id, replyCommentId),
            eq(communityComment.communityId, communityId),
            eq(communityComment.isDel, 0),
            eq(communityComment.isShow, 1),
            eq(communityComment.isVerify, 1),
          ))
          .limit(1)
          .for("update"))[0];
        if (!target) throw new NotFoundException("评论不存在或已删除");
        isReply = 0;
        if (target.isReply === 1) {
          replyId = target.id;
          replyUid = target.uid;
        } else {
          const parent = (await tx.select().from(communityComment)
            .where(and(
              eq(communityComment.id, target.replyId),
              eq(communityComment.communityId, communityId),
              eq(communityComment.isDel, 0),
            ))
            .limit(1)
            .for("update"))[0];
          if (!parent) throw new NotFoundException("上级评论不存在或已删除");
          replyId = parent.id;
          replyUid = parent.uid;
          commentReplyId = target.id;
          commentReplyUid = target.uid;
        }
      }
      const inserted = await tx.insert(communityComment).values({
        type: 2,
        uid,
        replyId,
        replyUid,
        commentReplyId,
        commentReplyUid,
        communityId,
        content,
        ip: boundedString(ip, "IP", 32),
        isVerify,
        isShow: 1,
        isReply,
        isDel: 0,
        addTime: Math.floor(Date.now() / 1000),
      }).returning({ id: communityComment.id });
      await this.syncCommentCounts(tx, communityId, replyId > 0 ? [replyId] : []);
      return { id: inserted[0]?.id ?? 0 };
    });
  }

  private async deletePostRecord(id: number, ownerUid?: number): Promise<void> {
    await withTx(this.container, async (tx) => {
      await this.lock(tx, `post:${id}`);
      const rows = await tx.select().from(community)
        .where(and(eq(community.id, id), eq(community.isDel, 0))).limit(1).for("update");
      const row = rows[0];
      if (!row) throw new NotFoundException("社区内容不存在或已删除");
      if (ownerUid !== undefined && (row.type !== 2 || row.relationId !== ownerUid)) {
        throw new ValidateException("只能删除自己的帖子");
      }
      const topicIds = await this.relationIds(tx, id, COMMUNITY_TOPIC);
      const comments = await tx.select({ id: communityComment.id }).from(communityComment)
        .where(and(eq(communityComment.communityId, id), eq(communityComment.isDel, 0))).for("update");
      const commentIds = comments.map((item) => item.id);
      await tx.update(community).set({ status: 0, isDel: 1 }).where(eq(community.id, id));
      await tx.update(communityComment).set({ isShow: 0, isDel: 1 })
        .where(and(eq(communityComment.communityId, id), eq(communityComment.isDel, 0)));
      await tx.delete(communityRelevance).where(or(
        and(eq(communityRelevance.leftId, id), inArray(communityRelevance.type, [COMMUNITY_TOPIC, COMMUNITY_PRODUCT])),
        and(eq(communityRelevance.rightId, id), inArray(communityRelevance.type, [COMMUNITY_LIKE, COMMUNITY_BROWSE])),
        ...(commentIds.length
          ? [and(inArray(communityRelevance.rightId, commentIds), eq(communityRelevance.type, COMMUNITY_COMMENT_LIKE))]
          : []),
      ));
      await this.syncAuthorPostCount(tx, row.type, row.relationId, Math.floor(Date.now() / 1000));
      await this.syncTopicCounts(tx, topicIds);
    });
  }

  async topics(query: Record<string, string | undefined>, onlyActive = false) {
    const page = positivePage(query.page, 1);
    // PHP's all_topic endpoint is an unpaginated selector. Keep a generous hard
    // cap for a bounded Worker response while avoiding the old implicit 100-row
    // truncation in post edit forms.
    const limit = Math.min(onlyActive ? 1_000 : 100, positivePage(query.limit, onlyActive ? 1_000 : 20));
    const conditions: SQL[] = [eq(communityTopic.isDel, 0)];
    if (onlyActive) conditions.push(eq(communityTopic.status, 1));
    if (query.name?.trim()) {
      const pattern = `%${query.name.trim()}%`;
      conditions.push(or(ilike(communityTopic.name, pattern), sql`${communityTopic.id}::text ILIKE ${pattern}`)!);
    }
    const status = optionalInteger(query.status, new Set([0, 1]));
    if (status !== undefined) conditions.push(eq(communityTopic.status, status));
    const isRecommend = optionalInteger(query.is_recommend, new Set([0, 1]));
    if (isRecommend !== undefined) conditions.push(eq(communityTopic.isRecommend, isRecommend));
    const [rows, counts] = await Promise.all([
      this.container.db.select().from(communityTopic).where(and(...conditions))
        .orderBy(desc(communityTopic.sort), desc(communityTopic.id)).limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` }).from(communityTopic).where(and(...conditions)),
    ]);
    const usage = await this.topicUsage(rows.map((row) => row.id));
    const list = rows.map((row) => topicView(row, usage.get(row.id) ?? 0));
    return onlyActive ? list.map(({ id, name, is_recommend }) => ({ id, name, is_recommend })) : { list, count: counts[0]?.count ?? 0 };
  }

  async topicDetail(idValue: unknown) {
    const id = integer(idValue, "话题", { min: 1 });
    const rows = await this.container.db.select().from(communityTopic)
      .where(and(eq(communityTopic.id, id), eq(communityTopic.isDel, 0))).limit(1);
    if (!rows[0]) throw new NotFoundException("话题不存在");
    return topicView(rows[0], (await this.topicUsage([id])).get(id) ?? 0);
  }

  async saveTopic(idValue: unknown, input: Record<string, unknown>): Promise<{ id: number }> {
    const id = idValue === undefined || idValue === null || idValue === ""
      ? 0
      : integer(idValue, "话题", { min: 0 });
    return withTx(this.container, async (tx) => {
      await this.lock(tx, "topic:catalog");
      const current = id
        ? (await tx.select().from(communityTopic).where(and(eq(communityTopic.id, id), eq(communityTopic.isDel, 0))).limit(1).for("update"))[0]
        : undefined;
      if (id && !current) throw new NotFoundException("话题不存在");
      const normalized = normalizeCommunityTopicInput(input, current ? {
        name: current.name,
        sort: current.sort,
        isRecommend: current.isRecommend,
        status: current.status,
      } : undefined);
      const duplicate = await tx.select({ id: communityTopic.id }).from(communityTopic)
        .where(and(
          sql`LOWER(${communityTopic.name}) = LOWER(${normalized.name})`,
          eq(communityTopic.isDel, 0),
          ...(id ? [ne(communityTopic.id, id)] : []),
        )).limit(1);
      if (duplicate[0]) throw new ValidateException("话题已存在");
      if (current) {
        await tx.update(communityTopic).set(normalized).where(eq(communityTopic.id, id));
        return { id };
      }
      const inserted = await tx.insert(communityTopic).values({
        ...normalized,
        addTime: Math.floor(Date.now() / 1000),
        isDel: 0,
      }).returning({ id: communityTopic.id });
      const insertedId = inserted[0]?.id ?? 0;
      if (!insertedId) throw new Error("话题创建失败");
      return { id: insertedId };
    });
  }

  async setTopicStatus(idValue: unknown, value: unknown): Promise<void> {
    await this.updateTopicFlag(idValue, { status: integer(value, "显示状态", { min: 0, max: 1 }) });
  }

  async setTopicRecommend(idValue: unknown, value: unknown): Promise<void> {
    await this.updateTopicFlag(idValue, { isRecommend: integer(value, "推荐状态", { min: 0, max: 1 }) });
  }

  async deleteTopic(idValue: unknown): Promise<void> {
    const id = integer(idValue, "话题", { min: 1 });
    await withTx(this.container, async (tx) => {
      await this.lock(tx, "topic:catalog");
      const rows = await tx.select({ id: communityTopic.id }).from(communityTopic)
        .where(and(eq(communityTopic.id, id), eq(communityTopic.isDel, 0))).limit(1).for("update");
      if (!rows[0]) throw new NotFoundException("删除的数据不存在");
      await tx.update(communityTopic).set({ status: 0, isDel: 1 }).where(eq(communityTopic.id, id));
    });
  }

  async comments(query: Record<string, string | undefined>) {
    const page = positivePage(query.page, 1);
    const limit = Math.min(100, positivePage(query.limit, 20));
    const conditions = this.commentConditions(query);
    const [rows, counts] = await Promise.all([
      this.container.db.select().from(communityComment).where(and(...conditions))
        .orderBy(desc(communityComment.addTime), desc(communityComment.id))
        .limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` }).from(communityComment).where(and(...conditions)),
    ]);
    return { list: await this.formatComments(rows), count: counts[0]?.count ?? 0 };
  }

  async commentReplies(idValue: unknown, query: Record<string, string | undefined>) {
    const id = integer(idValue, "评论", { min: 1 });
    const parent = await this.container.db.select({ id: communityComment.id }).from(communityComment)
      .where(and(eq(communityComment.id, id), eq(communityComment.isDel, 0))).limit(1);
    if (!parent[0]) throw new NotFoundException("评论不存在或已删除");
    return this.comments({ ...query, reply_id: String(id), is_reply: undefined });
  }

  async replyComment(idValue: unknown, input: Record<string, unknown>, ip = ""): Promise<{ id: number }> {
    const id = integer(idValue, "评论", { min: 1 });
    const content = boundedString(pick(input, "content"), "回复内容", 1000, true);
    return withTx(this.container, async (tx) => {
      const initial = (await tx.select().from(communityComment)
        .where(and(eq(communityComment.id, id), eq(communityComment.isDel, 0))).limit(1))[0];
      if (!initial) throw new NotFoundException("评论不存在或已删除");
      const post = await this.lockPost(tx, initial.communityId);
      if (!post) throw new NotFoundException("社区内容不存在");
      const target = (await tx.select().from(communityComment)
        .where(and(eq(communityComment.id, id), eq(communityComment.isDel, 0))).limit(1).for("update"))[0];
      if (!target) throw new NotFoundException("评论不存在或已删除");
      let replyId = target.id;
      let replyUid = target.uid;
      let commentReplyId = 0;
      let commentReplyUid = 0;
      if (target.isReply === 0) {
        const parent = (await tx.select().from(communityComment)
          .where(and(eq(communityComment.id, target.replyId), eq(communityComment.isDel, 0))).limit(1).for("update"))[0];
        if (!parent) throw new NotFoundException("上级评论不存在或已删除");
        replyId = parent.id;
        replyUid = parent.uid;
        commentReplyId = target.id;
        commentReplyUid = target.uid;
      }
      const inserted = await tx.insert(communityComment).values({
        type: 0,
        uid: 0,
        replyId,
        replyUid,
        commentReplyId,
        commentReplyUid,
        communityId: target.communityId,
        content,
        ip: boundedString(ip, "IP", 32),
        isVerify: 1,
        isShow: 1,
        isReply: 0,
        isDel: 0,
        addTime: Math.floor(Date.now() / 1000),
      }).returning({ id: communityComment.id });
      await this.syncCommentCounts(tx, target.communityId, [replyId]);
      return { id: inserted[0]?.id ?? 0 };
    });
  }

  async saveFictitiousComment(input: Record<string, unknown>, ip = ""): Promise<{ id: number }> {
    const communityId = integer(pick(input, "community_id", "communityId"), "社区内容", { min: 1 });
    const type = integer(pick(input, "type"), "评论类型", { min: 0, max: 3, fallback: 0 });
    if (type !== 0 && type !== 3) throw new ValidateException("评论类型仅支持平台或虚拟用户");
    const content = boundedString(pick(input, "content"), "评论内容", 1000, true);
    const nickname = boundedString(pick(input, "nickname"), "用户名称", 64, type === 3);
    const avatar = boundedString(pick(input, "avatar"), "用户头像", 255);
    const now = Math.floor(Date.now() / 1000);
    const addTime = epoch(pick(input, "add_time", "addTime"), "评论时间", now);
    if (addTime > now) throw new ValidateException("评论时间应小于当前时间");
    return withTx(this.container, async (tx) => {
      const post = await this.lockPost(tx, communityId);
      if (!post) throw new NotFoundException("社区内容不存在");
      const inserted = await tx.insert(communityComment).values({
        type,
        uid: 0,
        communityId,
        nickname,
        avatar,
        content,
        ip: boundedString(ip, "IP", 32),
        isVerify: 1,
        isShow: 1,
        isReply: 1,
        isDel: 0,
        addTime,
      }).returning({ id: communityComment.id });
      await this.syncCommentCounts(tx, communityId, []);
      return { id: inserted[0]?.id ?? 0 };
    });
  }

  async setCommentStatus(idValue: unknown, value: unknown): Promise<void> {
    const status = integer(value, "显示状态", { min: 0, max: 1 });
    await this.updateCommentLifecycle(idValue, { isShow: status });
  }

  async setCommentVerify(idValue: unknown, input: Record<string, unknown>): Promise<void> {
    const isVerify = integer(pick(input, "is_verify", "isVerify"), "审核状态", { min: -2, max: 1 });
    if (![1, 0, -1, -2].includes(isVerify)) throw new ValidateException("审核状态格式错误");
    await this.updateCommentLifecycle(idValue, { isVerify });
  }

  async deleteComment(idValue: unknown): Promise<void> {
    const id = integer(idValue, "评论", { min: 1 });
    await this.deleteCommentRecord(id);
  }

  async deleteOwnedComment(idValue: unknown, uidValue: unknown): Promise<void> {
    const id = integer(idValue, "评论", { min: 1 });
    const uid = integer(uidValue, "用户", { min: 1 });
    await this.deleteCommentRecord(id, uid);
  }

  private async deleteCommentRecord(id: number, ownerUid?: number): Promise<void> {
    await withTx(this.container, async (tx) => {
      const initial = (await tx.select().from(communityComment)
        .where(and(eq(communityComment.id, id), eq(communityComment.isDel, 0))).limit(1))[0];
      if (!initial) throw new NotFoundException("评论不存在或已删除");
      const post = await this.lockPost(tx, initial.communityId);
      if (!post) throw new NotFoundException("社区内容不存在");
      const target = (await tx.select().from(communityComment)
        .where(and(eq(communityComment.id, id), eq(communityComment.isDel, 0))).limit(1).for("update"))[0];
      if (!target) throw new NotFoundException("评论不存在或已删除");
      if (ownerUid !== undefined && (target.type !== 2 || target.uid !== ownerUid)) {
        throw new ValidateException("只能删除自己的评论");
      }
      const ids = target.isReply === 1
        ? (await tx.select({ id: communityComment.id }).from(communityComment)
          .where(and(or(eq(communityComment.id, id), eq(communityComment.replyId, id)), eq(communityComment.isDel, 0))).for("update"))
          .map((item) => item.id)
        : [id];
      await tx.update(communityComment).set({ isShow: 0, isDel: 1 }).where(inArray(communityComment.id, ids));
      await tx.delete(communityRelevance).where(and(
        eq(communityRelevance.type, COMMUNITY_COMMENT_LIKE),
        inArray(communityRelevance.rightId, ids),
      ));
      await this.syncCommentCounts(tx, target.communityId, target.isReply === 1 ? [id] : [target.replyId]);
    });
  }

  private postConditions(query: Record<string, string | undefined>, includeVerify: boolean): SQL[] {
    const conditions: SQL[] = [eq(community.isDel, 0)];
    const type = optionalInteger(query.type, new Set([0, 1, 2]));
    if (type !== undefined) conditions.push(eq(community.type, type));
    const contentType = optionalInteger(query.content_type, new Set([1, 2]));
    if (contentType !== undefined) conditions.push(eq(community.contentType, contentType));
    const star = optionalInteger(query.star, new Set([1, 2, 3, 4, 5]));
    if (star !== undefined) conditions.push(eq(community.star, star));
    const topicId = Number(query.topic_id ?? 0);
    if (Number.isSafeInteger(topicId) && topicId > 0) {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM community_relevance cr
        WHERE cr.left_id = ${community.id} AND cr.right_id = ${topicId} AND cr.type = ${COMMUNITY_TOPIC}
      )`);
    }
    if (includeVerify) {
      const isVerify = optionalInteger(query.is_verify, new Set([-2, -1, 0, 1]));
      if (isVerify !== undefined) conditions.push(eq(community.isVerify, isVerify));
    }
    if (query.keyword?.trim()) {
      const pattern = `%${query.keyword.trim()}%`;
      conditions.push(or(ilike(community.title, pattern), sql`${community.id}::text ILIKE ${pattern}`)!);
    }
    const [start, end] = parseTimeRange(query);
    if (start !== undefined) conditions.push(gte(community.addTime, start));
    if (end !== undefined) conditions.push(lte(community.addTime, end));
    return conditions;
  }

  private commentConditions(query: Record<string, string | undefined>): SQL[] {
    const conditions: SQL[] = [eq(communityComment.isDel, 0)];
    const replyId = Number(query.reply_id ?? 0);
    if (Number.isSafeInteger(replyId) && replyId > 0) {
      conditions.push(eq(communityComment.replyId, replyId));
    } else {
      const isReply = optionalInteger(query.is_reply, new Set([0, 1])) ?? 1;
      conditions.push(eq(communityComment.isReply, isReply));
    }
    const communityId = Number(query.community_id ?? 0);
    if (Number.isSafeInteger(communityId) && communityId > 0) {
      conditions.push(eq(communityComment.communityId, communityId));
    }
    const isVerify = optionalInteger(query.is_verify, new Set([-2, -1, 0, 1]));
    if (isVerify !== undefined) conditions.push(eq(communityComment.isVerify, isVerify));
    const field = query.field_key;
    const keyword = query.keyword?.trim();
    if (keyword && field === "id") {
      const id = Number(keyword);
      conditions.push(Number.isSafeInteger(id) && id > 0 ? eq(communityComment.id, id) : sql`FALSE`);
    } else if (keyword && field === "comment") {
      conditions.push(ilike(communityComment.content, `%${keyword}%`));
    } else if (keyword && field === "community") {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM community c
        WHERE c.id = ${communityComment.communityId}
          AND (c.title ILIKE ${`%${keyword}%`} OR c.content ILIKE ${`%${keyword}%`})
      )`);
    } else if (keyword && field === "user") {
      conditions.push(sql`(
        ${communityComment.nickname} ILIKE ${`%${keyword}%`}
        OR EXISTS (SELECT 1 FROM "user" u WHERE u.uid = ${communityComment.uid} AND u.nickname ILIKE ${`%${keyword}%`})
      )`);
    }
    const [start, end] = parseTimeRange(query);
    if (start !== undefined) conditions.push(gte(communityComment.addTime, start));
    if (end !== undefined) conditions.push(lte(communityComment.addTime, end));
    return conditions;
  }

  private async formatPosts(rows: CommunityRow[]) {
    const userIds = [...new Set(rows.filter((row) => row.type === 2).map((row) => row.relationId))];
    const users = userIds.length
      ? await this.container.db.select({ uid: user.uid, nickname: user.nickname, avatar: user.avatar })
        .from(user).where(inArray(user.uid, userIds))
      : [];
    const userMap = new Map(users.map((row) => [row.uid, row]));
    return rows.map((row) => postView(row, row.type === 2 ? userMap.get(row.relationId) : undefined));
  }

  private async formatComments(rows: CommunityCommentRow[]) {
    if (!rows.length) return [];
    const userIds = [...new Set(rows.filter((row) => row.type === 2).map((row) => row.uid))];
    const postIds = [...new Set(rows.map((row) => row.communityId))];
    const replyContentIds = [...new Set(rows.map((row) => row.commentReplyId).filter((id) => id > 0))];
    const topIds = rows.filter((row) => row.isReply === 1).map((row) => row.id);
    const [users, posts, replyContent, replyCounts] = await Promise.all([
      userIds.length
        ? this.container.db.select({ uid: user.uid, nickname: user.nickname, avatar: user.avatar }).from(user).where(inArray(user.uid, userIds))
        : Promise.resolve([]),
      this.container.db.select({ id: community.id, title: community.title }).from(community).where(inArray(community.id, postIds)),
      replyContentIds.length
        ? this.container.db.select({ id: communityComment.id, content: communityComment.content }).from(communityComment).where(inArray(communityComment.id, replyContentIds))
        : Promise.resolve([]),
      topIds.length
        ? this.container.db.select({ replyId: communityComment.replyId, count: sql<number>`COUNT(*)::int` })
          .from(communityComment)
          .where(and(inArray(communityComment.replyId, topIds), eq(communityComment.isDel, 0)))
          .groupBy(communityComment.replyId)
        : Promise.resolve([]),
    ]);
    const userMap = new Map(users.map((row) => [row.uid, row]));
    const postMap = new Map(posts.map((row) => [row.id, row.title]));
    const replyMap = new Map(replyContent.map((row) => [row.id, row.content]));
    const countMap = new Map(replyCounts.map((row) => [row.replyId, row.count]));
    return rows.map((row) => commentView(row, {
      author: row.type === 2 ? userMap.get(row.uid) : undefined,
      communityTitle: postMap.get(row.communityId),
      replyContent: replyMap.get(row.commentReplyId),
      replyCount: countMap.get(row.id),
    }));
  }

  private async relationIds(tx: DbClient, postId: number, type: string): Promise<number[]> {
    const rows = await tx.select({ rightId: communityRelevance.rightId }).from(communityRelevance)
      .where(and(eq(communityRelevance.leftId, postId), eq(communityRelevance.type, type)));
    return [...new Set(rows.map((row) => row.rightId))];
  }

  private async validateReferences(
    tx: DbClient,
    topicIds: number[],
    productIds: number[],
    requirePublicReferences = false,
  ): Promise<void> {
    if (topicIds.length) {
      const rows = await tx.select({ id: communityTopic.id }).from(communityTopic)
        .where(and(
          inArray(communityTopic.id, topicIds),
          eq(communityTopic.isDel, 0),
          ...(requirePublicReferences ? [eq(communityTopic.status, 1)] : []),
        )).for("update");
      if (rows.length !== topicIds.length) {
        throw new ValidateException(requirePublicReferences
          ? "部分社区话题不存在或已停用"
          : "部分社区话题不存在或已删除");
      }
    }
    if (productIds.length) {
      const rows = await tx.select({ id: storeProduct.id }).from(storeProduct)
        .where(and(
          inArray(storeProduct.id, productIds),
          eq(storeProduct.isDel, 0),
          ...(requirePublicReferences ? [eq(storeProduct.isShow, 1), eq(storeProduct.isVerify, 1)] : []),
        ));
      if (rows.length !== productIds.length) {
        throw new ValidateException(requirePublicReferences
          ? "部分商品不存在、未审核或已下架"
          : "部分商品不存在或已删除");
      }
    }
  }

  private async updatePostLifecycle(
    id: number,
    values: Partial<typeof community.$inferInsert>,
    syncCount = true,
  ): Promise<void> {
    await withTx(this.container, async (tx) => {
      await this.lock(tx, `post:${id}`);
      const rows = await tx.select().from(community)
        .where(and(eq(community.id, id), eq(community.isDel, 0))).limit(1).for("update");
      const row = rows[0];
      if (!row) throw new NotFoundException("社区内容不存在");
      await tx.update(community).set(values).where(eq(community.id, id));
      if (syncCount) {
        await this.syncAuthorPostCount(tx, row.type, row.relationId, Math.floor(Date.now() / 1000));
      }
    });
  }

  private async updateTopicFlag(idValue: unknown, values: Partial<typeof communityTopic.$inferInsert>): Promise<void> {
    const id = integer(idValue, "话题", { min: 1 });
    await withTx(this.container, async (tx) => {
      await this.lock(tx, "topic:catalog");
      const rows = await tx.select({ id: communityTopic.id }).from(communityTopic)
        .where(and(eq(communityTopic.id, id), eq(communityTopic.isDel, 0))).limit(1).for("update");
      if (!rows[0]) throw new NotFoundException("话题不存在");
      await tx.update(communityTopic).set(values).where(eq(communityTopic.id, id));
    });
  }

  private async updateCommentLifecycle(idValue: unknown, values: Partial<typeof communityComment.$inferInsert>): Promise<void> {
    const id = integer(idValue, "评论", { min: 1 });
    await withTx(this.container, async (tx) => {
      const initial = (await tx.select().from(communityComment)
        .where(and(eq(communityComment.id, id), eq(communityComment.isDel, 0))).limit(1))[0];
      if (!initial) throw new NotFoundException("评论不存在或已删除");
      const post = await this.lockPost(tx, initial.communityId);
      if (!post) throw new NotFoundException("社区内容不存在");
      const target = (await tx.select().from(communityComment)
        .where(and(eq(communityComment.id, id), eq(communityComment.isDel, 0))).limit(1).for("update"))[0];
      if (!target) throw new NotFoundException("评论不存在或已删除");
      await tx.update(communityComment).set(values).where(eq(communityComment.id, id));
      await this.syncCommentCounts(tx, target.communityId, target.isReply === 1 ? [target.id] : [target.replyId]);
    });
  }

  private async syncAuthorPostCount(tx: DbClient, type: number, relationId: number, now: number): Promise<void> {
    await this.lock(tx, `profile:${type}:${relationId}`);
    const counts = await tx.select({ count: sql<number>`COUNT(*)::int` }).from(community).where(and(
      eq(community.type, type),
      eq(community.relationId, relationId),
      eq(community.status, 1),
      eq(community.isVerify, 1),
      eq(community.isDel, 0),
    ));
    const communityNum = counts[0]?.count ?? 0;
    const updated = await tx.update(communityUser).set({ communityNum }).where(and(
      eq(communityUser.type, type),
      eq(communityUser.relationId, relationId),
      eq(communityUser.isDel, 0),
    )).returning({ id: communityUser.id });
    if (updated.length) return;
    let nickname = "";
    let avatar = "";
    if (type === 2) {
      const source = (await tx.select({ nickname: user.nickname, avatar: user.avatar }).from(user)
        .where(and(eq(user.uid, relationId), eq(user.isDel, 0))).limit(1))[0];
      nickname = source?.nickname ?? "";
      avatar = source?.avatar ?? "";
    }
    await tx.insert(communityUser).values({
      type,
      relationId,
      nickname,
      avatar,
      communityNum,
      status: 1,
      isDel: 0,
      addTime: now,
    });
  }

  private async syncTopicCounts(tx: DbClient, ids: number[]): Promise<void> {
    for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
      await this.lock(tx, `topic:${id}`);
      const counts = await tx.select({ count: sql<number>`COUNT(DISTINCT ${communityRelevance.leftId})::int` })
        .from(communityRelevance)
        .innerJoin(community, eq(community.id, communityRelevance.leftId))
        .where(and(
          eq(communityRelevance.type, COMMUNITY_TOPIC),
          eq(communityRelevance.rightId, id),
          eq(community.isDel, 0),
        ));
      await tx.update(communityTopic).set({ useNum: counts[0]?.count ?? 0 }).where(eq(communityTopic.id, id));
    }
  }

  private async topicUsage(ids: number[]): Promise<Map<number, number>> {
    if (!ids.length) return new Map();
    const rows = await this.container.db
      .select({ id: communityRelevance.rightId, count: sql<number>`COUNT(DISTINCT ${communityRelevance.leftId})::int` })
      .from(communityRelevance)
      .innerJoin(community, eq(community.id, communityRelevance.leftId))
      .where(and(
        eq(communityRelevance.type, COMMUNITY_TOPIC),
        inArray(communityRelevance.rightId, ids),
        eq(community.isDel, 0),
      ))
      .groupBy(communityRelevance.rightId);
    return new Map(rows.map((row) => [row.id, row.count]));
  }

  private async syncCommentCounts(tx: DbClient, communityId: number, topIds: number[]): Promise<void> {
    const counts = await tx.select({ count: sql<number>`COUNT(*)::int` }).from(communityComment).where(and(
      eq(communityComment.communityId, communityId),
      eq(communityComment.isDel, 0),
      eq(communityComment.isShow, 1),
      eq(communityComment.isVerify, 1),
    ));
    await tx.update(community).set({ commentNum: counts[0]?.count ?? 0 }).where(eq(community.id, communityId));
    for (const topId of [...new Set(topIds.filter((id) => id > 0))].sort((a, b) => a - b)) {
      const childCounts = await tx.select({ count: sql<number>`COUNT(*)::int` }).from(communityComment).where(and(
        eq(communityComment.replyId, topId),
        eq(communityComment.isDel, 0),
        eq(communityComment.isShow, 1),
        eq(communityComment.isVerify, 1),
      ));
      await tx.update(communityComment).set({ commentNum: childCounts[0]?.count ?? 0 })
        .where(eq(communityComment.id, topId));
    }
  }

  private async lockPost(tx: DbClient, id: number): Promise<CommunityRow | undefined> {
    await this.lock(tx, `post:${id}`);
    return (await tx.select().from(community)
      .where(and(eq(community.id, id), eq(community.isDel, 0))).limit(1).for("update"))[0];
  }

  private async lock(tx: DbClient, key: string): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${COMMUNITY_ADMIN_LOCK_NAMESPACE}, hashtext(${key}))`);
  }
}
