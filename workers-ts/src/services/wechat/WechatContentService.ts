import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  articleContent,
  systemArticle,
  wechatKey,
  wechatMedia,
  wechatMessage,
  wechatNewsCategory,
  wechatReply,
} from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";
import {
  normalizePublishedArticleLink,
  normalizePublishedArticleMediaReference,
  sanitizePublishedArticleHtml,
} from "@/services/content/ArticleContentPolicy";

const REPLY_TYPES = new Set(["text", "image", "news", "voice"]);
const RESERVED_KEYS = new Set(["subscribe", "default"]);
const REPLY_CATALOG_LOCK = 47_101;
const NEWS_CATALOG_LOCK = 47_102;

function pick(input: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (input[key] !== undefined) return input[key];
  return undefined;
}

function boundedString(
  value: unknown,
  label: string,
  max: number,
  options: { required?: boolean; trim?: boolean } = {},
): string {
  const raw = typeof value === "string" ? value : "";
  const text = options.trim === false ? raw : raw.trim();
  if (options.required && !text.trim()) throw new ValidateException(`请填写${label}`);
  if (text.length > max) throw new ValidateException(`${label}不能超过${max}个字符`);
  return text;
}

function integer(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; fallback?: number } = {},
): number {
  if ((value === undefined || value === "") && options.fallback !== undefined) return options.fallback;
  const parsed = Number(value);
  const min = options.min ?? 0;
  const max = options.max ?? 2_147_483_647;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidateException(`${label}格式错误`);
  }
  return parsed;
}

function pageValue(value: unknown, fallback: number, max = 10_000): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException(`${label}格式错误`);
  }
  return value as Record<string, unknown>;
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseSourceIds(value: string, max = 64): number[] {
  return value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((id) => Number.isSafeInteger(id) && id > 0)
    .slice(0, max);
}

function replyTypeName(type: string): string {
  if (type === "text") return "文字消息";
  if (type === "image") return "图片消息";
  if (type === "news") return "图文消息";
  if (type === "voice") return "语音消息";
  return "未知消息";
}

export interface NormalizedReplyInput {
  keys: string[];
  type: "text" | "image" | "news" | "voice";
  status: number;
  data: Record<string, unknown>;
}

export function normalizeReplyInput(input: Record<string, unknown>): NormalizedReplyInput {
  const rawKeys = pick(input, "key", "keys");
  const parts = Array.isArray(rawKeys)
    ? rawKeys
    : typeof rawKeys === "string"
      ? rawKeys.split(",")
      : [];
  const keys = [...new Set(parts.map((value) => String(value).trim()).filter(Boolean))];
  if (!keys.length) throw new ValidateException("请填写关键词");
  if (keys.length > 20) throw new ValidateException("每条回复最多配置20个关键词");
  if (keys.some((key) => key.length > 64)) throw new ValidateException("关键词不能超过64个字符");
  if (keys.some((key) => RESERVED_KEYS.has(key)) && keys.length !== 1) {
    throw new ValidateException("关注回复和默认回复必须单独配置");
  }

  const type = boundedString(pick(input, "type"), "回复类型", 32, { required: true });
  if (!REPLY_TYPES.has(type)) throw new ValidateException("回复类型错误");
  const status = integer(pick(input, "status"), "状态", { min: 0, max: 1, fallback: 1 });
  const rawData = objectValue(pick(input, "data"), "回复内容");
  let data: Record<string, unknown>;

  if (type === "text") {
    data = {
      content: boundedString(pick(rawData, "content"), "回复内容", 20_000, {
        required: true,
        trim: false,
      }),
    };
  } else if (type === "image" || type === "voice") {
    data = {
      src: boundedString(pick(rawData, "src", "path"), "素材路径", 128),
      media_id: boundedString(pick(rawData, "media_id", "mediaId"), "微信素材ID", 64, {
        required: true,
      }),
    };
  } else {
    const id = integer(pick(rawData, "id"), "文章ID", { min: 0, fallback: 0 });
    const title = boundedString(pick(rawData, "title"), "图文标题", 255, { required: true });
    const synopsis = boundedString(pick(rawData, "synopsis", "description"), "图文摘要", 500);
    const rawImages = pick(rawData, "image_input", "imageInput");
    const imageInput = Array.isArray(rawImages)
      ? rawImages.slice(0, 8).map((item, index) =>
        normalizePublishedArticleMediaReference(item, `第${index + 1}张图文图片`)
      ).filter(Boolean)
      : boundedString(rawImages, "图文图片", 255)
        ? [normalizePublishedArticleMediaReference(rawImages, "图文图片")]
        : [];
    const rawImage = boundedString(pick(rawData, "image"), "图文图片", 255) || imageInput[0] || "";
    const image = normalizePublishedArticleMediaReference(rawImage, "图文图片");
    const rawUrl = boundedString(pick(rawData, "url"), "图文链接", 2_000)
      || (id ? `/pages/extension/news_details/index?id=${id}` : "");
    const url = normalizePublishedArticleLink(rawUrl, "图文链接");
    if (!url) throw new ValidateException("请填写图文链接或选择已有文章");
    data = { id, title, synopsis, image, image_input: imageInput, url };
  }

  return { keys, type: type as NormalizedReplyInput["type"], status, data };
}

export interface NormalizedNewsArticle {
  id: number;
  title: string;
  author: string;
  content: string;
  synopsis: string;
  imageInput: string;
  url: string;
  sort: number;
}

export interface NormalizedNewsInput {
  id: number;
  sort: number;
  status: number;
  articles: NormalizedNewsArticle[];
}

export function normalizeNewsInput(input: Record<string, unknown>): NormalizedNewsInput {
  const id = integer(pick(input, "id"), "图文分类ID", { min: 0, fallback: 0 });
  const sort = integer(pick(input, "sort"), "排序", { min: 0, fallback: 0 });
  const status = integer(pick(input, "status"), "状态", { min: 0, max: 1, fallback: 1 });
  const list = pick(input, "list");
  if (!Array.isArray(list) || list.length < 1 || list.length > 8) {
    throw new ValidateException("每组图文必须包含1至8篇文章");
  }
  const seenIds = new Set<number>();
  const articles = list.map((raw, index): NormalizedNewsArticle => {
    const article = objectValue(raw, `第${index + 1}篇文章`);
    const articleId = integer(pick(article, "id"), `第${index + 1}篇文章ID`, {
      min: 0,
      fallback: 0,
    });
    if (articleId && seenIds.has(articleId)) throw new ValidateException("同一图文组不能重复选择文章");
    if (articleId) seenIds.add(articleId);
    const rawImage = pick(article, "image_input", "imageInput");
    const imageInput = boundedString(
      Array.isArray(rawImage) ? rawImage[0] : rawImage,
      `第${index + 1}篇文章封面`,
      255,
    );
    return {
      id: articleId,
      title: boundedString(pick(article, "title"), `第${index + 1}篇文章标题`, 255, { required: true }),
      author: boundedString(pick(article, "author"), `第${index + 1}篇文章作者`, 255, { required: true }),
      content: sanitizePublishedArticleHtml(boundedString(
        pick(article, "content"),
        `第${index + 1}篇文章正文`,
        200_000,
        { required: true, trim: false },
      )),
      synopsis: boundedString(pick(article, "synopsis"), `第${index + 1}篇文章摘要`, 500, { required: true }),
      imageInput: normalizePublishedArticleMediaReference(
        imageInput,
        `第${index + 1}篇文章封面`,
      ),
      url: normalizePublishedArticleLink(
        boundedString(pick(article, "url"), `第${index + 1}篇文章链接`, 255),
        `第${index + 1}篇文章链接`,
      ),
      sort: integer(pick(article, "sort"), `第${index + 1}篇文章排序`, { min: 0, fallback: index }),
    };
  });
  return { id, sort, status, articles };
}

export function maskWechatIdentifier(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return `${value[0] ?? ""}***`;
  if (value.length <= 8) return `${value.slice(0, 2)}***${value.slice(-2)}`;
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function redactPayload(value: unknown, identifiers: readonly string[], depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactPayload(item, identifiers, depth + 1));
  }
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return value;
    const redacted = identifiers.reduce(
      (text, identifier) => text.split(identifier).join(maskWechatIdentifier(identifier)),
      value,
    );
    return redacted.length > 2_000 ? `${redacted.slice(0, 2_000)}…` : redacted;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    const normalized = key.replace(/[_-]/g, "").toLowerCase();
    result[key] = ["openid", "unionid", "fromusername", "tousername"].includes(normalized)
      ? maskWechatIdentifier(String(item ?? ""))
      : redactPayload(item, identifiers, depth + 1);
  }
  return result;
}

export function redactWechatMessageResult(result: string, openid = ""): unknown {
  try {
    return redactPayload(JSON.parse(result), openid ? [openid] : []);
  } catch {
    const bounded = result.slice(0, 512);
    return openid ? bounded.split(openid).join(maskWechatIdentifier(openid)) : bounded;
  }
}

function articlePublic(row: {
  id: number;
  title: string;
  author: string;
  content: string | null;
  synopsis: string;
  imageInput: string;
  url: string;
  sort: number;
  status: number;
}) {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    content: row.content ?? "",
    synopsis: row.synopsis,
    image_input: row.imageInput ? [row.imageInput] : [],
    imageInput: row.imageInput,
    url: row.url,
    sort: row.sort,
    status: row.status,
  };
}

async function articlesByIds(db: DbClient, ids: readonly number[]) {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return new Map<number, ReturnType<typeof articlePublic>>();
  const rows = await db
    .select({
      id: systemArticle.id,
      title: systemArticle.title,
      author: systemArticle.author,
      content: sql<string | null>`COALESCE(NULLIF(${systemArticle.content}, ''), ${articleContent.content}, '')`,
      synopsis: systemArticle.synopsis,
      imageInput: systemArticle.imageInput,
      url: systemArticle.url,
      sort: systemArticle.sort,
      status: systemArticle.status,
    })
    .from(systemArticle)
    .leftJoin(articleContent, eq(articleContent.nid, systemArticle.id))
    .where(inArray(systemArticle.id, uniqueIds));
  return new Map(rows.map((row) => [row.id, articlePublic(row)]));
}

export class WechatContentService {
  constructor(private readonly container: Container) {}

  async replyList(query: Record<string, string | undefined>) {
    const page = pageValue(query.page, 1);
    const limit = pageValue(query.limit, 20, 100);
    const conditions: SQL[] = [eq(wechatReply.hide, 0)];
    const type = query.type?.trim();
    const keyword = query.key?.trim();
    if (type) {
      if (!REPLY_TYPES.has(type)) throw new ValidateException("回复类型错误");
      conditions.push(eq(wechatReply.type, type));
    }
    conditions.push(sql`NOT EXISTS (
      SELECT 1 FROM ${wechatKey} reserved
      WHERE reserved.reply_id = ${wechatReply.id}
        AND reserved.keys IN ('subscribe', 'default')
    )`);
    if (keyword) {
      if (keyword.length > 64) throw new ValidateException("关键词不能超过64个字符");
      conditions.push(sql`EXISTS (
        SELECT 1 FROM ${wechatKey} matched
        WHERE matched.reply_id = ${wechatReply.id}
          AND matched.keys ILIKE ${`%${keyword}%`}
      )`);
    }
    const where = and(...conditions);
    const [rows, totals] = await Promise.all([
      this.container.db
        .select()
        .from(wechatReply)
        .where(where)
        .orderBy(desc(wechatReply.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db.select({ count: count() }).from(wechatReply).where(where),
    ]);
    const keys = rows.length
      ? await this.container.db
          .select()
          .from(wechatKey)
          .where(inArray(wechatKey.replyId, rows.map((row) => row.id)))
          .orderBy(asc(wechatKey.id))
      : [];
    const keyMap = new Map<number, string[]>();
    for (const item of keys) keyMap.set(item.replyId, [...(keyMap.get(item.replyId) ?? []), item.keys]);
    return {
      list: rows.map((row) => this.replyView(row, keyMap.get(row.id) ?? [])),
      count: totals[0]?.count ?? 0,
    };
  }

  async replyDetail(idValue: unknown) {
    const id = integer(idValue, "回复ID", { min: 1 });
    const rows = await this.container.db.select().from(wechatReply).where(eq(wechatReply.id, id)).limit(1);
    if (!rows[0]) throw new NotFoundException("回复不存在");
    const keys = await this.container.db
      .select({ keys: wechatKey.keys })
      .from(wechatKey)
      .where(eq(wechatKey.replyId, id))
      .orderBy(asc(wechatKey.id));
    return this.replyView(rows[0], keys.map((row) => row.keys));
  }

  async reservedReply(keyValue: unknown) {
    const key = boundedString(keyValue, "回复标识", 64, { required: true });
    if (!RESERVED_KEYS.has(key)) throw new ValidateException("只支持 subscribe 或 default 回复");
    const links = await this.container.db
      .select({ keyId: wechatKey.id, reply: wechatReply })
      .from(wechatKey)
      .innerJoin(wechatReply, eq(wechatReply.id, wechatKey.replyId))
      .where(eq(wechatKey.keys, key))
      .orderBy(asc(wechatKey.id), asc(wechatReply.id))
      .limit(20);
    if (!links[0]) return { info: null, ambiguous: false };
    return {
      info: this.replyView(links[0].reply, [key]),
      ambiguous: links.some((item) => item.reply.id !== links[0].reply.id),
    };
  }

  async saveReply(idValue: unknown, input: Record<string, unknown>) {
    const id = integer(idValue, "回复ID", { min: 0, fallback: 0 });
    const normalized = normalizeReplyInput(input);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${REPLY_CATALOG_LOCK})`);
      if (id) {
        const existing = await tx
          .select({ id: wechatReply.id })
          .from(wechatReply)
          .where(eq(wechatReply.id, id))
          .for("update")
          .limit(1);
        if (!existing[0]) throw new NotFoundException("回复不存在");
      }
      const conflicts = await tx
        .select({ key: wechatKey.keys, replyId: wechatKey.replyId })
        .from(wechatKey)
        .where(and(inArray(wechatKey.keys, normalized.keys), id ? ne(wechatKey.replyId, id) : sql`true`))
        .limit(20);
      if (conflicts.length) {
        throw new ValidateException(`关键词已被其他回复使用: ${[...new Set(conflicts.map((item) => item.key))].join(",")}`);
      }
      if (normalized.type === "image" || normalized.type === "voice") {
        const mediaId = String(normalized.data.media_id);
        const media = await tx
          .select({ id: wechatMedia.id })
          .from(wechatMedia)
          .where(and(eq(wechatMedia.type, normalized.type), eq(wechatMedia.mediaId, mediaId)))
          .limit(1);
        if (!media[0]) throw new ValidateException("只能选择已迁移且类型匹配的微信素材");
      }
      let replyId = id;
      const values = {
        type: normalized.type,
        data: JSON.stringify(normalized.data),
        status: normalized.status,
        hide: 0,
      };
      if (replyId) {
        await tx.update(wechatReply).set(values).where(eq(wechatReply.id, replyId));
        await tx.delete(wechatKey).where(eq(wechatKey.replyId, replyId));
      } else {
        const inserted = await tx.insert(wechatReply).values(values).returning({ id: wechatReply.id });
        replyId = inserted[0].id;
      }
      await tx.insert(wechatKey).values(normalized.keys.map((keys) => ({ replyId, keys })));
      return { id: replyId };
    });
  }

  async deleteReply(idValue: unknown): Promise<void> {
    const id = integer(idValue, "回复ID", { min: 1 });
    await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${REPLY_CATALOG_LOCK})`);
      const rows = await tx
        .select({ id: wechatReply.id })
        .from(wechatReply)
        .where(eq(wechatReply.id, id))
        .for("update")
        .limit(1);
      if (!rows[0]) throw new NotFoundException("回复不存在");
      await tx.delete(wechatKey).where(eq(wechatKey.replyId, id));
      await tx.delete(wechatReply).where(eq(wechatReply.id, id));
    });
  }

  async setReplyStatus(idValue: unknown, statusValue: unknown): Promise<void> {
    const id = integer(idValue, "回复ID", { min: 1 });
    const status = integer(statusValue, "状态", { min: 0, max: 1 });
    const rows = await this.container.db
      .update(wechatReply)
      .set({ status })
      .where(eq(wechatReply.id, id))
      .returning({ id: wechatReply.id });
    if (!rows[0]) throw new NotFoundException("回复不存在");
  }

  async mediaList(query: Record<string, string | undefined>) {
    const page = pageValue(query.page, 1);
    const limit = pageValue(query.limit, 50, 100);
    const type = query.type?.trim();
    if (type && type !== "image" && type !== "voice") throw new ValidateException("素材类型错误");
    const where = type ? eq(wechatMedia.type, type) : undefined;
    const [list, totals] = await Promise.all([
      this.container.db
        .select()
        .from(wechatMedia)
        .where(where)
        .orderBy(desc(wechatMedia.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db.select({ count: count() }).from(wechatMedia).where(where),
    ]);
    return { list, count: totals[0]?.count ?? 0 };
  }

  async newsList(query: Record<string, string | undefined>) {
    const page = pageValue(query.page, 1);
    const limit = pageValue(query.limit, 20, 100);
    const conditions: SQL[] = [];
    const name = query.cate_name?.trim() || query.cateName?.trim();
    if (name) {
      if (name.length > 255) throw new ValidateException("图文名称不能超过255个字符");
      conditions.push(ilike(wechatNewsCategory.cateName, `%${name}%`));
    }
    if (query.status !== undefined && query.status !== "") {
      conditions.push(eq(wechatNewsCategory.status, integer(query.status, "状态", { min: 0, max: 1 })));
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const [rows, totals] = await Promise.all([
      this.container.db
        .select()
        .from(wechatNewsCategory)
        .where(where)
        .orderBy(desc(wechatNewsCategory.sort), desc(wechatNewsCategory.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db.select({ count: count() }).from(wechatNewsCategory).where(where),
    ]);
    const allIds = rows.flatMap((row) => parseSourceIds(row.newId));
    const articleMap = await articlesByIds(this.container.db, allIds);
    return {
      list: rows.map((row) => {
        const ids = parseSourceIds(row.newId);
        return {
          ...row,
          articleIds: ids,
          articleCount: ids.length,
          firstArticle: ids.map((id) => articleMap.get(id)).find(Boolean) ?? null,
        };
      }),
      count: totals[0]?.count ?? 0,
    };
  }

  async newsDetail(idValue: unknown) {
    const id = integer(idValue, "图文分类ID", { min: 1 });
    const rows = await this.container.db
      .select()
      .from(wechatNewsCategory)
      .where(eq(wechatNewsCategory.id, id))
      .limit(1);
    if (!rows[0]) throw new NotFoundException("图文分类不存在");
    const ids = parseSourceIds(rows[0].newId);
    const articleMap = await articlesByIds(this.container.db, ids);
    return {
      ...rows[0],
      articleIds: ids,
      articles: ids.map((articleId) => articleMap.get(articleId)).filter(Boolean),
    };
  }

  async saveNews(input: Record<string, unknown>) {
    const normalized = normalizeNewsInput(input);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${NEWS_CATALOG_LOCK})`);
      let categoryId = normalized.id;
      let allowedArticleIds = new Set<number>();
      let sharedArticleIds = new Set<number>();
      if (categoryId) {
        const current = await tx
          .select()
          .from(wechatNewsCategory)
          .where(eq(wechatNewsCategory.id, categoryId))
          .for("update")
          .limit(1);
        if (!current[0]) throw new NotFoundException("图文分类不存在");
        allowedArticleIds = new Set(parseSourceIds(current[0].newId));
        const others = await tx
          .select({ newId: wechatNewsCategory.newId })
          .from(wechatNewsCategory)
          .where(ne(wechatNewsCategory.id, categoryId));
        sharedArticleIds = new Set(others.flatMap((row) => parseSourceIds(row.newId)));
      } else if (normalized.articles.some((article) => article.id)) {
        throw new ValidateException("新建图文分类不能修改已有文章");
      }

      const now = Math.floor(Date.now() / 1000);
      const articleIds: number[] = [];
      for (const article of normalized.articles) {
        if (article.id && !allowedArticleIds.has(article.id)) {
          throw new ValidateException("只能编辑当前图文分类拥有的文章");
        }
        const values = {
          cid: 0,
          title: article.title,
          author: article.author,
          content: article.content,
          synopsis: article.synopsis,
          status: 1,
          isDel: 0,
          addTime: now,
          imageInput: article.imageInput,
          url: article.url,
          sort: article.sort,
        };
        let articleId = article.id;
        if (articleId && !sharedArticleIds.has(articleId)) {
          const updated = await tx
            .update(systemArticle)
            .set(values)
            .where(and(eq(systemArticle.id, articleId), eq(systemArticle.isDel, 0)))
            .returning({ id: systemArticle.id });
          if (!updated[0]) throw new NotFoundException("图文文章不存在或已删除");
        } else {
          const inserted = await tx.insert(systemArticle).values(values).returning({ id: systemArticle.id });
          articleId = inserted[0].id;
        }
        await tx
          .insert(articleContent)
          .values({ nid: articleId, content: article.content })
          .onConflictDoUpdate({ target: articleContent.nid, set: { content: article.content } });
        articleIds.push(articleId);
      }

      const categoryValues = {
        cateName: normalized.articles[0].title,
        sort: normalized.sort,
        status: normalized.status,
        newId: articleIds.join(","),
        addTime: String(now),
      };
      if (categoryId) {
        await tx.update(wechatNewsCategory).set(categoryValues).where(eq(wechatNewsCategory.id, categoryId));
      } else {
        const inserted = await tx
          .insert(wechatNewsCategory)
          .values(categoryValues)
          .returning({ id: wechatNewsCategory.id });
        categoryId = inserted[0].id;
      }
      return { id: categoryId, articleIds };
    });
  }

  async deleteNews(idValue: unknown): Promise<void> {
    const id = integer(idValue, "图文分类ID", { min: 1 });
    await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${NEWS_CATALOG_LOCK})`);
      const rows = await tx
        .select({ id: wechatNewsCategory.id })
        .from(wechatNewsCategory)
        .where(eq(wechatNewsCategory.id, id))
        .for("update")
        .limit(1);
      if (!rows[0]) throw new NotFoundException("图文分类不存在");
      await tx.delete(wechatNewsCategory).where(eq(wechatNewsCategory.id, id));
    });
  }

  async messageList(query: Record<string, string | undefined>) {
    const page = pageValue(query.page, 1);
    const limit = pageValue(query.limit, 20, 100);
    const conditions: SQL[] = [];
    const type = query.type?.trim();
    const openid = query.openid?.trim();
    if (type) {
      if (type.length > 100) throw new ValidateException("消息类型不能超过100个字符");
      conditions.push(eq(wechatMessage.type, type));
    }
    if (openid) {
      if (openid.length > 100) throw new ValidateException("OpenID不能超过100个字符");
      conditions.push(eq(wechatMessage.openid, openid));
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const [rows, totals] = await Promise.all([
      this.container.db
        .select()
        .from(wechatMessage)
        .where(where)
        .orderBy(desc(wechatMessage.addTime), desc(wechatMessage.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db.select({ count: count() }).from(wechatMessage).where(where),
    ]);
    return {
      list: rows.map((row) => ({
        id: row.id,
        openidMasked: maskWechatIdentifier(row.openid),
        type: row.type,
        result: redactWechatMessageResult(row.result, row.openid),
        addTime: row.addTime,
      })),
      count: totals[0]?.count ?? 0,
    };
  }

  async messageTypes() {
    const rows = await this.container.db
      .select({ type: wechatMessage.type, count: count() })
      .from(wechatMessage)
      .groupBy(wechatMessage.type)
      .orderBy(desc(count()), asc(wechatMessage.type))
      .limit(100);
    return rows.filter((row) => row.type).map((row) => ({ value: row.type, label: row.type, count: row.count }));
  }

  private replyView(row: typeof wechatReply.$inferSelect, keys: string[]) {
    return {
      ...row,
      data: parseJsonObject(row.data),
      key: keys.join(","),
      keys,
      typeName: replyTypeName(row.type),
    };
  }
}
