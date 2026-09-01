import {
  and,
  count,
  desc,
  eq,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  articleCategory,
  articleContent,
  storeProduct,
  systemArticle,
  userRelation,
} from "@/models/schema";
import {
  ApiException,
  AuthException,
  ValidateException,
} from "@/utils/errors";
import {
  normalizePublishedArticleLink,
  renderPublishedArticleHtml,
  renderPublishedArticleMediaReferences,
} from "@/services/content/ArticleContentPolicy";

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGED_SIZE = 20;
const MAX_PAGE_OFFSET = 10_000;
const MAX_UNPAGED_ROWS = 1_000;
const MAX_PAGE = 1_000_000;

export interface ArticlePagination {
  limit: number;
  offset: number;
  unpaged: boolean;
}

export interface LegacyArticleListItem {
  id: number;
  title: string;
  image_input: string[];
  visit: string;
  add_time: string;
  synopsis: string;
  url: string;
  likes?: number;
}

interface ArticleListRow {
  id: number;
  title: string;
  imageInput: string;
  visit: number;
  likes: number;
  addTime: number;
  synopsis: string;
  url: string;
}

type ListKind = "category" | "hot" | "new" | "banner";

/** PHP's AdminException is rendered as status=400 with an empty-array payload. */
export class PublicArticleUnavailableException extends ApiException {
  constructor(message = "文章不存在或已删除") {
    super(message, 400, []);
    this.name = "PublicArticleUnavailableException";
  }
}

function integerQueryValue(
  value: string | undefined,
  label: string,
  fallback: number,
  maximum = 2_147_483_647,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new ValidateException(`${label}格式错误`);
  }
  return parsed;
}

export function publicArticlePagination(
  query: Record<string, string | undefined>,
): ArticlePagination {
  const page = integerQueryValue(query.page, "页码", 0, MAX_PAGE);
  if (page === 0) {
    // PHP omits LIMIT entirely when page=0. Workers need a finite memory/CPU
    // boundary, so fetch one sentinel row and fail instead of truncating.
    return { limit: MAX_UNPAGED_ROWS + 1, offset: 0, unpaged: true };
  }

  const requestedLimit = integerQueryValue(query.limit, "每页数量", 0);
  const limit = requestedLimit === 0
    ? DEFAULT_PAGED_SIZE
    : Math.min(requestedLimit, MAX_PAGE_SIZE);
  const offset = (page - 1) * limit;
  if (!Number.isSafeInteger(offset) || offset > MAX_PAGE_OFFSET) {
    throw new ValidateException("分页偏移超过安全上限");
  }
  return { limit, offset, unpaged: false };
}

export function legacyArticleImages(value: string): string[] {
  // PHP explode(',', '') is ['']; do not trim or discard empty tokens.
  return value.split(",");
}

export function formatArticleShanghaiUnix(
  seconds: number,
  style: "day" | "minute",
): string {
  if (!Number.isSafeInteger(seconds)) return "";
  const shifted = new Date((seconds + 8 * 60 * 60) * 1_000);
  if (Number.isNaN(shifted.getTime())) return "";
  const iso = shifted.toISOString();
  return style === "day"
    ? iso.slice(0, 10)
    : iso.slice(0, 16).replace("T", " ");
}

function articleId(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new ValidateException("文章ID错误");
  }
  return parsed;
}

function categoryId(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new ValidateException("文章分类ID错误");
  }
  return parsed;
}

function visibleArticleConditions(): SQL[] {
  // The PHP DAO accidentally ignores status/hide and predates TS soft-delete.
  // A public Worker must not reproduce that disclosure bug.
  return [
    eq(systemArticle.status, 1),
    eq(systemArticle.hide, 0),
    eq(systemArticle.isDel, 0),
  ];
}

function articleListProjection(row: ArticleListRow, includeLikes: boolean): LegacyArticleListItem {
  const result: LegacyArticleListItem = {
    id: row.id,
    title: row.title,
    image_input: legacyArticleImages(row.imageInput),
    // The source MySQL column was varchar. Keep list payloads string-shaped;
    // details intentionally return the incremented integer.
    visit: String(row.visit),
    add_time: formatArticleShanghaiUnix(row.addTime, "minute"),
    synopsis: row.synopsis,
    url: safePublicArticleLink(row.url),
  };
  if (includeLikes) result.likes = row.likes;
  return result;
}

function safePublicArticleLink(value: string): string {
  try {
    return normalizePublishedArticleLink(value);
  } catch {
    return "";
  }
}

async function relationCount(tx: DbClient, id: number): Promise<number> {
  const rows = await tx
    .select({ value: count() })
    .from(userRelation)
    .where(and(
      eq(userRelation.relationId, id),
      eq(userRelation.type, "like"),
      eq(userRelation.category, "article"),
    ));
  return Number(rows[0]?.value ?? 0);
}

export class PublicArticleCompatibilityService {
  constructor(
    private readonly container: Container,
    private readonly appKey?: string,
  ) {}

  async categories(): Promise<Array<{ id: number; title: string }>> {
    const rows = await this.container.db
      .select({ id: articleCategory.id, title: articleCategory.title })
      .from(articleCategory)
      .where(and(
        eq(articleCategory.hidden, 0),
        eq(articleCategory.isDel, 0),
        eq(articleCategory.status, 1),
      ))
      // PHP only specifies sort DESC. The id tie-break makes pagination and
      // cross-engine verification deterministic without changing priority.
      .orderBy(desc(articleCategory.sort), desc(articleCategory.id));
    return [{ id: 0, title: "热门" }, ...rows];
  }

  async list(
    cidValue: unknown,
    query: Record<string, string | undefined>,
  ): Promise<LegacyArticleListItem[]> {
    const cid = categoryId(cidValue);
    return this.articleList("category", query, cid);
  }

  async hot(query: Record<string, string | undefined>): Promise<LegacyArticleListItem[]> {
    return this.articleList("hot", query);
  }

  async newest(query: Record<string, string | undefined>): Promise<LegacyArticleListItem[]> {
    return this.articleList("new", query);
  }

  async banner(query: Record<string, string | undefined>): Promise<LegacyArticleListItem[]> {
    return this.articleList("banner", query);
  }

  async details(uid: number, idValue: unknown): Promise<Record<string, unknown>> {
    const id = articleId(idValue);
    const safeUid = Number.isSafeInteger(uid) && uid > 0 ? uid : 0;

    const detail = await withTx(this.container, async (tx) => {
      const updated = await tx
        .update(systemArticle)
        .set({
          visit: sql<number>`LEAST(${systemArticle.visit}::bigint + 1, 2147483647)::integer`,
        })
        .where(and(eq(systemArticle.id, id), ...visibleArticleConditions()))
        .returning();
      const article = updated[0];
      if (!article) throw new PublicArticleUnavailableException();

      const related = (await tx
        .select({
          body: sql<string | null>`COALESCE(NULLIF(${systemArticle.content}, ''), ${articleContent.content})`,
          categoryTitle: articleCategory.title,
          productId: storeProduct.id,
          productName: storeProduct.storeName,
          productImage: storeProduct.image,
          productPrice: storeProduct.price,
          productOtPrice: storeProduct.otPrice,
          isLike: safeUid > 0
            ? sql<boolean>`EXISTS (
                SELECT 1 FROM "user_relation" AS relation
                WHERE relation."uid" = ${safeUid}
                  AND relation."relation_id" = ${id}
                  AND relation."type" = 'like'
                  AND relation."category" = 'article'
              )`
            : sql<boolean>`false`,
        })
        .from(systemArticle)
        .leftJoin(articleContent, eq(articleContent.nid, systemArticle.id))
        .leftJoin(articleCategory, eq(articleCategory.id, systemArticle.cid))
        .leftJoin(storeProduct, eq(storeProduct.id, systemArticle.productId))
        .where(eq(systemArticle.id, id))
        .limit(1))[0];

      const content = related?.body ?? null;
      const product = related?.productId === null || related?.productId === undefined
        ? null
        : {
            store_name: related.productName,
            image: related.productImage,
            price: related.productPrice,
            id: related.productId,
            ot_price: related.productOtPrice,
          };
      return {
        id: article.id,
        // The legacy MySQL column is varchar; detail responses preserve it.
        cid: String(article.cid),
        title: article.title,
        author: article.author,
        content,
        synopsis: article.synopsis,
        status: article.status,
        add_time: formatArticleShanghaiUnix(article.addTime, "day"),
        image_input: legacyArticleImages(article.imageInput),
        share_title: article.shareTitle,
        share_synopsis: article.shareSynopsis,
        visit: article.visit,
        likes: article.likes,
        sort: article.sort,
        url: safePublicArticleLink(article.url),
        hide: article.hide,
        admin_id: article.adminId,
        mer_id: article.merId,
        product_id: article.productId,
        is_hot: article.isHot,
        is_banner: article.isBanner,
        storeInfo: product,
        catename: related?.categoryTitle ?? null,
        store_info: product,
        is_like: Boolean(related?.isLike),
      };
    });
    const product = detail.store_info;
    const imageInput = detail.image_input;
    const mediaReferences = [
      ...imageInput,
      product?.image ?? "",
    ];
    const signed = await renderPublishedArticleMediaReferences(this.appKey, mediaReferences);
    const renderedProduct = product
      ? { ...product, image: signed[imageInput.length] ?? "" }
      : null;
    return {
      ...detail,
      content: detail.content === null
        ? null
        : await renderPublishedArticleHtml(this.appKey, detail.content),
      image_input: signed.slice(0, imageInput.length),
      storeInfo: renderedProduct,
      store_info: renderedProduct,
    };
  }

  async like(uid: number, idValue: unknown, statusValue: unknown): Promise<true> {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new AuthException();
    const id = articleId(idValue);
    const desired = Number(statusValue ?? 0) > 0 ? 1 : 0;

    await withTx(this.container, async (tx) => {
      const article = (await tx
        .select({ id: systemArticle.id })
        .from(systemArticle)
        .where(and(eq(systemArticle.id, id), ...visibleArticleConditions()))
        .limit(1)
        .for("update"))[0];
      if (!article) throw new PublicArticleUnavailableException();

      if (desired === 1) {
        await tx
          .insert(userRelation)
          .values({
            uid,
            relationId: id,
            type: "like",
            category: "article",
            addTime: Math.floor(Date.now() / 1_000),
          })
          .onConflictDoNothing({
            target: [
              userRelation.uid,
              userRelation.relationId,
              userRelation.type,
              userRelation.category,
            ],
            where: sql`${userRelation.type} <> 'play'`,
          });
      } else {
        await tx
          .delete(userRelation)
          .where(and(
            eq(userRelation.uid, uid),
            eq(userRelation.relationId, id),
            eq(userRelation.type, "like"),
            eq(userRelation.category, "article"),
          ));
      }

      // Treat the relation table as the source of truth. This makes repeated
      // add/cancel requests idempotent and repairs historical PHP drift.
      const likes = await relationCount(tx, id);
      await tx
        .update(systemArticle)
        .set({ likes })
        .where(eq(systemArticle.id, id));
    });
    return true;
  }

  private async articleList(
    kind: ListKind,
    query: Record<string, string | undefined>,
    cid = 0,
  ): Promise<LegacyArticleListItem[]> {
    const pagination = publicArticlePagination(query);
    const conditions = visibleArticleConditions();
    if (kind === "category" && cid > 0) conditions.push(eq(systemArticle.cid, cid));
    if (kind === "hot") conditions.push(eq(systemArticle.isHot, 1));
    if (kind === "banner") conditions.push(eq(systemArticle.isBanner, 1));
    if (kind === "category") {
      // PHP passed comma strings directly to MySQL NOT IN. PostgreSQL instead
      // makes the intended contract explicit and excludes every valid token.
      conditions.push(sql`NOT EXISTS (
        SELECT 1
        FROM "wechat_news_category" AS news
        CROSS JOIN LATERAL regexp_split_to_table(news."new_id", ',') AS token(value)
        WHERE btrim(token.value) ~ '^[0-9]+$'
          AND COALESCE(NULLIF(ltrim(btrim(token.value), '0'), ''), '0') = ${systemArticle.id}::text
      )`);
    }

    const rows = await this.container.db
      .select({
        id: systemArticle.id,
        title: systemArticle.title,
        imageInput: systemArticle.imageInput,
        visit: systemArticle.visit,
        likes: systemArticle.likes,
        addTime: systemArticle.addTime,
        synopsis: systemArticle.synopsis,
        url: systemArticle.url,
      })
      .from(systemArticle)
      .where(and(...conditions))
      .orderBy(desc(systemArticle.addTime), desc(systemArticle.id))
      .limit(pagination.limit)
      .offset(pagination.offset);
    if (pagination.unpaged && rows.length > MAX_UNPAGED_ROWS) {
      throw new ValidateException("文章数量超过安全上限，请传入分页参数");
    }
    const includeLikes = kind === "category";
    const items = rows.map((row) => articleListProjection(row, includeLikes));
    const references = items.flatMap((item) => item.image_input);
    const signed = await renderPublishedArticleMediaReferences(this.appKey, references);
    let cursor = 0;
    return items.map((item) => ({
      ...item,
      image_input: signed.slice(cursor, cursor += item.image_input.length),
    }));
  }
}
