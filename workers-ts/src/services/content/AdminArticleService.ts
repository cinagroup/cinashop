import { and, asc, desc, eq, ilike, sql, type SQL } from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import type { Env } from "@/env";
import { withTx } from "@/lib/di";
import { systemLog } from "@/models/schema/admin";
import { articleCategory, articleContent, systemArticle } from "@/models/schema/content";
import { storeProduct } from "@/models/schema/product";
import { ValidateException } from "@/utils/errors";
import {
  normalizePublishedArticleImageInput,
  normalizePublishedArticleLink,
  normalizePublishedArticleMediaReference,
  renderPublishedArticleMediaReferences,
  sanitizePublishedArticleHtml,
} from "@/services/content/ArticleContentPolicy";

const ARTICLE_LOCK_NAMESPACE = 903_401;
const CATEGORY_LOCK_NAMESPACE = 903_402;
const MAX_LIST_PAGE = 10_000;

export interface AdminArticleActor {
  id: number;
  name: string;
  ip: string;
}

export interface AdminArticleInput {
  id: number;
  cid: number;
  title: string;
  author: string;
  content: string;
  synopsis: string;
  status: 0 | 1;
  imageInput: string;
  shareTitle: string;
  shareSynopsis: string;
  sort: number;
  url: string;
  productId: number;
  isHot: 0 | 1;
  isBanner: 0 | 1;
}

export interface AdminArticleCategoryInput {
  title: string;
  intr: string;
  image: string;
  status: 0 | 1;
  sort: number;
}

function integer(value: unknown, label: string, minimum: number, maximum = 2_147_483_647): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidateException(`${label}格式错误`);
  }
  return parsed;
}

function text(value: unknown, label: string, maximum: number, required = false): string {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw new ValidateException(`${label}格式错误`);
  const normalized = value.trim();
  if ([...normalized].length > maximum) throw new ValidateException(`${label}不能超过${maximum}个字符`);
  if (required && !normalized) throw new ValidateException(`请输入${label}`);
  return normalized;
}

function binary(value: unknown, label: string, fallback: 0 | 1): 0 | 1 {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (parsed !== 0 && parsed !== 1) throw new ValidateException(`${label}只能为0或1`);
  return parsed;
}

function alias(input: Record<string, unknown>, snake: string, camel: string): unknown {
  return Object.hasOwn(input, snake) ? input[snake] : input[camel];
}

function rejectUnknown(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const permitted = new Set(allowed);
  const unknown = Object.keys(input).filter((key) => !permitted.has(key));
  if (unknown.length) throw new ValidateException(`${label}包含未知字段: ${unknown.join(", ")}`);
}

export function normalizeAdminArticleInput(input: Record<string, unknown>): AdminArticleInput {
  rejectUnknown(input, [
    "id", "cid", "title", "author", "content", "synopsis", "status", "sort", "url",
    "image_input", "imageInput", "share_title", "shareTitle", "share_synopsis", "shareSynopsis",
    "product_id", "productId", "is_hot", "isHot", "is_banner", "isBanner",
  ], "文章请求");
  const content = sanitizePublishedArticleHtml(text(input.content, "文章正文", 200_000, true));
  if (!content.trim()) throw new ValidateException("请输入文章正文");
  const imageInput = normalizePublishedArticleImageInput(alias(input, "image_input", "imageInput"));
  if (!imageInput) throw new ValidateException("请选择文章封面");
  const url = normalizePublishedArticleLink(input.url);
  if ([...url].length > 255) throw new ValidateException("文章链接不能超过255个字符");
  return {
    id: input.id === undefined || input.id === null || input.id === "" ? 0 : integer(input.id, "文章ID", 1),
    cid: integer(input.cid, "文章分类ID", 1),
    title: text(input.title, "标题", 255, true),
    author: text(input.author, "作者", 255),
    content,
    synopsis: text(input.synopsis, "文章摘要", 500),
    status: binary(input.status, "文章状态", 1),
    imageInput,
    shareTitle: text(alias(input, "share_title", "shareTitle"), "分享标题", 255),
    shareSynopsis: text(alias(input, "share_synopsis", "shareSynopsis"), "分享摘要", 255),
    sort: input.sort === undefined || input.sort === "" ? 0 : integer(input.sort, "排序", 0),
    url,
    productId: alias(input, "product_id", "productId") === undefined || alias(input, "product_id", "productId") === ""
      ? 0
      : integer(alias(input, "product_id", "productId"), "关联商品ID", 0),
    isHot: binary(alias(input, "is_hot", "isHot"), "热门状态", 0),
    isBanner: binary(alias(input, "is_banner", "isBanner"), "轮播状态", 0),
  };
}

export function normalizeAdminArticleCategoryInput(input: Record<string, unknown>): AdminArticleCategoryInput {
  rejectUnknown(input, ["title", "intr", "image", "status", "sort"], "分类请求");
  const image = normalizePublishedArticleMediaReference(input.image, "分类图片");
  if (!image) throw new ValidateException("请选择分类图片");
  return {
    title: text(input.title, "分类名称", 20, true),
    intr: text(input.intr, "分类简介", 255, true),
    image,
    status: binary(input.status, "分类状态", 1),
    sort: input.sort === undefined || input.sort === "" ? 0 : integer(input.sort, "排序", 0),
  };
}

function queryInteger(value: string | undefined, label: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === "") return fallback;
  return integer(value, label, minimum, maximum);
}

function positiveId(value: unknown, label: string): number {
  return integer(value, label, 1);
}

function articleSnapshot(db: DbClient, id: number) {
  return db.select({
    id: systemArticle.id,
    cid: systemArticle.cid,
    category_title: articleCategory.title,
    title: systemArticle.title,
    author: systemArticle.author,
    stored_content: systemArticle.content,
    mirrored_content: articleContent.content,
    content: sql<string>`COALESCE(NULLIF(${systemArticle.content}, ''), ${articleContent.content}, '')`,
    synopsis: systemArticle.synopsis,
    status: systemArticle.status,
    is_del: systemArticle.isDel,
    add_time: systemArticle.addTime,
    image_input: systemArticle.imageInput,
    share_title: systemArticle.shareTitle,
    share_synopsis: systemArticle.shareSynopsis,
    visit: systemArticle.visit,
    likes: systemArticle.likes,
    sort: systemArticle.sort,
    url: systemArticle.url,
    product_id: systemArticle.productId,
    product_name: storeProduct.storeName,
    is_hot: systemArticle.isHot,
    is_banner: systemArticle.isBanner,
  }).from(systemArticle)
    .leftJoin(articleContent, eq(articleContent.nid, systemArticle.id))
    .leftJoin(articleCategory, eq(articleCategory.id, systemArticle.cid))
    .leftJoin(storeProduct, eq(storeProduct.id, systemArticle.productId))
    .where(eq(systemArticle.id, id))
    .limit(1);
}

function publicArticleRow(row: Awaited<ReturnType<typeof articleSnapshot>>[number]) {
  const { stored_content: _stored, mirrored_content: _mirrored, ...result } = row;
  return result;
}

function firstImage(value: string): string {
  return value.split(",").map((item) => item.trim()).find(Boolean) ?? "";
}

async function configureWriteTx(tx: DbClient): Promise<void> {
  await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
  await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
}

async function audit(
  tx: DbClient,
  actor: AdminArticleActor,
  path: string,
  method: string,
  action: string,
): Promise<void> {
  await tx.insert(systemLog).values({
    adminId: actor.id,
    adminName: actor.name.slice(0, 64),
    path,
    page: "/content/article",
    method,
    action: action.slice(0, 255),
    ip: actor.ip.slice(0, 45),
    type: "article",
    addTime: Math.floor(Date.now() / 1_000),
  });
}

export class AdminArticleService {
  constructor(
    private readonly container: Container,
    private readonly env: Pick<Env, "APP_KEY">,
  ) {}

  private async withImagePreviews<T extends { image_input: string }>(rows: T[]) {
    const previews = await renderPublishedArticleMediaReferences(
      this.env.APP_KEY,
      rows.map((row) => firstImage(row.image_input)),
    );
    return rows.map((row, index) => ({ ...row, image_preview: previews[index] }));
  }

  private async withCategoryPreviews<T extends { image: string }>(rows: T[]) {
    const previews = await renderPublishedArticleMediaReferences(
      this.env.APP_KEY,
      rows.map((row) => firstImage(row.image)),
    );
    return rows.map((row, index) => ({ ...row, image_preview: previews[index] }));
  }

  async list(query: Record<string, string>) {
    const page = queryInteger(query.page, "页码", 1, 1, MAX_LIST_PAGE);
    const limit = queryInteger(query.limit, "每页数量", 20, 1, 100);
    const conditions: SQL[] = [eq(systemArticle.isDel, 0)];
    const cid = query.cid ? positiveId(query.cid, "文章分类ID") : 0;
    const status = query.status === undefined || query.status === "" ? null : binary(query.status, "文章状态", 1);
    const title = (query.title ?? "").trim().slice(0, 80);
    if (cid) conditions.push(eq(systemArticle.cid, cid));
    if (status !== null) conditions.push(eq(systemArticle.status, status));
    if (title) conditions.push(ilike(systemArticle.title, `%${title}%`));
    const where = and(...conditions)!;
    const [rows, totals] = await Promise.all([
      this.container.db.select({
        id: systemArticle.id,
        cid: systemArticle.cid,
        category_title: articleCategory.title,
        title: systemArticle.title,
        author: systemArticle.author,
        synopsis: systemArticle.synopsis,
        status: systemArticle.status,
        add_time: systemArticle.addTime,
        image_input: systemArticle.imageInput,
        visit: systemArticle.visit,
        sort: systemArticle.sort,
        product_id: systemArticle.productId,
        product_name: storeProduct.storeName,
        is_hot: systemArticle.isHot,
        is_banner: systemArticle.isBanner,
      }).from(systemArticle)
        .leftJoin(articleCategory, eq(articleCategory.id, systemArticle.cid))
        .leftJoin(storeProduct, eq(storeProduct.id, systemArticle.productId))
        .where(where)
        .orderBy(desc(systemArticle.sort), desc(systemArticle.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`count(*)::int` }).from(systemArticle).where(where),
    ]);
    return { list: await this.withImagePreviews(rows), count: Number(totals[0]?.count ?? 0), page, limit };
  }

  async detail(idValue: unknown) {
    const id = positiveId(idValue, "文章ID");
    const row = (await articleSnapshot(this.container.db, id))[0];
    if (!row || row.is_del !== 0) throw new ValidateException("文章不存在或已删除");
    return (await this.withImagePreviews([publicArticleRow(row)]))[0];
  }

  async save(rawInput: Record<string, unknown>, actor: AdminArticleActor) {
    const input = normalizeAdminArticleInput(rawInput);
    const result = await withTx(this.container, async (tx) => {
      await configureWriteTx(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${CATEGORY_LOCK_NAMESPACE}, ${input.cid})`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ARTICLE_LOCK_NAMESPACE}, ${input.id})`);

      const category = (await tx.select({ id: articleCategory.id }).from(articleCategory).where(and(
        eq(articleCategory.id, input.cid),
        eq(articleCategory.isDel, 0),
      )).limit(1).for("share"))[0];
      if (!category) throw new ValidateException("文章分类不存在或已删除");

      if (input.productId > 0) {
        const product = (await tx.select({ id: storeProduct.id }).from(storeProduct).where(and(
          eq(storeProduct.id, input.productId),
          eq(storeProduct.type, 0),
          eq(storeProduct.relationId, 0),
          eq(storeProduct.isDel, 0),
        )).limit(1).for("share"))[0];
        if (!product) throw new ValidateException("关联商品不存在或已删除");
      }

      let id = input.id;
      if (id > 0) {
        const existing = (await tx.select({ id: systemArticle.id }).from(systemArticle).where(and(
          eq(systemArticle.id, id),
          eq(systemArticle.isDel, 0),
        )).limit(1).for("update"))[0];
        if (!existing) throw new ValidateException("文章不存在或已删除");
        await tx.update(systemArticle).set({
          cid: input.cid,
          title: input.title,
          author: input.author,
          content: input.content,
          synopsis: input.synopsis,
          status: input.status,
          imageInput: input.imageInput,
          shareTitle: input.shareTitle,
          shareSynopsis: input.shareSynopsis,
          sort: input.sort,
          url: input.url,
          productId: input.productId,
          isHot: input.isHot,
          isBanner: input.isBanner,
          adminId: actor.id,
        }).where(and(eq(systemArticle.id, id), eq(systemArticle.isDel, 0)));
      } else {
        const inserted = await tx.insert(systemArticle).values({
          cid: input.cid,
          title: input.title,
          author: input.author,
          content: input.content,
          synopsis: input.synopsis,
          status: input.status,
          isDel: 0,
          addTime: Math.floor(Date.now() / 1_000),
          imageInput: input.imageInput,
          shareTitle: input.shareTitle,
          shareSynopsis: input.shareSynopsis,
          sort: input.sort,
          url: input.url,
          productId: input.productId,
          isHot: input.isHot,
          isBanner: input.isBanner,
          adminId: actor.id,
        }).returning({ id: systemArticle.id });
        id = inserted[0]?.id ?? 0;
        if (!id) throw new Error("article_insert_failed");
      }

      await tx.insert(articleContent).values({ nid: id, content: input.content })
        .onConflictDoUpdate({ target: articleContent.nid, set: { content: input.content } });
      const verified = (await articleSnapshot(tx, id))[0];
      if (!verified || verified.is_del !== 0 || verified.stored_content !== input.content
        || verified.mirrored_content !== input.content || verified.cid !== input.cid
        || verified.title !== input.title || verified.author !== input.author
        || verified.synopsis !== input.synopsis || verified.status !== input.status
        || verified.image_input !== input.imageInput || verified.share_title !== input.shareTitle
        || verified.share_synopsis !== input.shareSynopsis || verified.sort !== input.sort
        || verified.url !== input.url || verified.product_id !== input.productId
        || verified.is_hot !== input.isHot || verified.is_banner !== input.isBanner) {
        throw new Error("article_readback_mismatch");
      }
      await audit(
        tx,
        actor,
        "/adminapi/article/save",
        "POST",
        `article.${input.id ? "update" : "create"};id=${id};category=${input.cid};product=${input.productId}`,
      );
      return { article: publicArticleRow(verified), verified: true as const };
    });
    return { ...result, article: (await this.withImagePreviews([result.article]))[0] };
  }

  async remove(idValue: unknown, actor: AdminArticleActor) {
    const id = positiveId(idValue, "文章ID");
    return withTx(this.container, async (tx) => {
      await configureWriteTx(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ARTICLE_LOCK_NAMESPACE}, ${id})`);
      const existing = (await tx.select({ id: systemArticle.id }).from(systemArticle).where(and(
        eq(systemArticle.id, id),
        eq(systemArticle.isDel, 0),
      )).limit(1).for("update"))[0];
      if (!existing) throw new ValidateException("文章不存在或已删除");
      const updated = await tx.update(systemArticle).set({ isDel: 1, status: 0, adminId: actor.id })
        .where(and(eq(systemArticle.id, id), eq(systemArticle.isDel, 0)))
        .returning({ id: systemArticle.id, isDel: systemArticle.isDel, status: systemArticle.status });
      if (!updated[0] || updated[0].isDel !== 1 || updated[0].status !== 0) {
        throw new Error("article_delete_readback_mismatch");
      }
      await audit(tx, actor, `/adminapi/article/del/${id}`, "DELETE", `article.delete;id=${id}`);
      return { id, deleted: true as const, verified: true as const };
    });
  }

  async categories(query: Record<string, string>) {
    const page = queryInteger(query.page, "页码", 1, 1, MAX_LIST_PAGE);
    const limit = queryInteger(query.limit, "每页数量", 100, 1, 500);
    const conditions: SQL[] = [eq(articleCategory.isDel, 0)];
    const title = (query.title ?? "").trim().slice(0, 50);
    const status = query.status === undefined || query.status === "" ? null : binary(query.status, "分类状态", 1);
    if (title) conditions.push(ilike(articleCategory.title, `%${title}%`));
    if (status !== null) conditions.push(eq(articleCategory.status, status));
    const where = and(...conditions)!;
    const [rows, totals] = await Promise.all([
      this.container.db.select({
        id: articleCategory.id,
        pid: articleCategory.pid,
        title: articleCategory.title,
        intr: articleCategory.intr,
        image: articleCategory.image,
        status: articleCategory.status,
        sort: articleCategory.sort,
        hidden: articleCategory.hidden,
        add_time: articleCategory.addTime,
      }).from(articleCategory).where(where)
        .orderBy(desc(articleCategory.sort), asc(articleCategory.id))
        .limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`count(*)::int` }).from(articleCategory).where(where),
    ]);
    return { list: await this.withCategoryPreviews(rows), count: Number(totals[0]?.count ?? 0), page, limit };
  }

  async saveCategory(rawInput: Record<string, unknown>, actor: AdminArticleActor, idValue?: unknown) {
    const input = normalizeAdminArticleCategoryInput(rawInput);
    const id = idValue === undefined ? 0 : positiveId(idValue, "分类ID");
    const result = await withTx(this.container, async (tx) => {
      await configureWriteTx(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${CATEGORY_LOCK_NAMESPACE}, ${id})`);
      let categoryId = id;
      if (categoryId > 0) {
        const existing = (await tx.select({ id: articleCategory.id }).from(articleCategory).where(and(
          eq(articleCategory.id, categoryId), eq(articleCategory.isDel, 0),
        )).limit(1).for("update"))[0];
        if (!existing) throw new ValidateException("分类不存在或已删除");
        await tx.update(articleCategory).set(input)
          .where(and(eq(articleCategory.id, categoryId), eq(articleCategory.isDel, 0)));
      } else {
        const inserted = await tx.insert(articleCategory).values({
          pid: 0,
          ...input,
          isDel: 0,
          hidden: 0,
          addTime: Math.floor(Date.now() / 1_000),
        }).returning({ id: articleCategory.id });
        categoryId = inserted[0]?.id ?? 0;
        if (!categoryId) throw new Error("article_category_insert_failed");
      }
      const verified = (await tx.select({
        id: articleCategory.id,
        title: articleCategory.title,
        intr: articleCategory.intr,
        image: articleCategory.image,
        status: articleCategory.status,
        sort: articleCategory.sort,
        isDel: articleCategory.isDel,
      }).from(articleCategory).where(eq(articleCategory.id, categoryId)).limit(1))[0];
      if (!verified || verified.isDel !== 0 || verified.title !== input.title || verified.intr !== input.intr
        || verified.image !== input.image || verified.status !== input.status || verified.sort !== input.sort) {
        throw new Error("article_category_readback_mismatch");
      }
      await audit(
        tx,
        actor,
        id ? `/adminapi/article/category/${id}` : "/adminapi/article/category",
        id ? "PUT" : "POST",
        `article.category.${id ? "update" : "create"};id=${categoryId}`,
      );
      return { category: verified, verified: true as const };
    });
    return { ...result, category: (await this.withCategoryPreviews([result.category]))[0] };
  }

  async setCategoryStatus(idValue: unknown, statusValue: unknown, actor: AdminArticleActor) {
    const id = positiveId(idValue, "分类ID");
    const status = binary(statusValue, "分类状态", 1);
    return withTx(this.container, async (tx) => {
      await configureWriteTx(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${CATEGORY_LOCK_NAMESPACE}, ${id})`);
      const existing = (await tx.select({ id: articleCategory.id }).from(articleCategory).where(and(
        eq(articleCategory.id, id), eq(articleCategory.isDel, 0),
      )).limit(1).for("update"))[0];
      if (!existing) throw new ValidateException("分类不存在或已删除");
      const updated = await tx.update(articleCategory).set({ status })
        .where(and(eq(articleCategory.id, id), eq(articleCategory.isDel, 0)))
        .returning({ id: articleCategory.id, status: articleCategory.status });
      if (!updated[0] || updated[0].status !== status) throw new Error("article_category_status_readback_mismatch");
      await audit(tx, actor, `/adminapi/article/category/${id}/status`, "PUT", `article.category.status;id=${id};status=${status}`);
      return { id, status, verified: true as const };
    });
  }

  async removeCategory(idValue: unknown, actor: AdminArticleActor) {
    const id = positiveId(idValue, "分类ID");
    return withTx(this.container, async (tx) => {
      await configureWriteTx(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${CATEGORY_LOCK_NAMESPACE}, ${id})`);
      const existing = (await tx.select({ id: articleCategory.id }).from(articleCategory).where(and(
        eq(articleCategory.id, id), eq(articleCategory.isDel, 0),
      )).limit(1).for("update"))[0];
      if (!existing) throw new ValidateException("分类不存在或已删除");
      const referenced = await tx.select({ count: sql<number>`count(*)::int` }).from(systemArticle).where(and(
        eq(systemArticle.cid, id), eq(systemArticle.isDel, 0),
      ));
      if (Number(referenced[0]?.count ?? 0) > 0) throw new ValidateException("该分类下仍有文章，不能删除");
      const updated = await tx.update(articleCategory).set({ isDel: 1, status: 0 })
        .where(and(eq(articleCategory.id, id), eq(articleCategory.isDel, 0)))
        .returning({ id: articleCategory.id, isDel: articleCategory.isDel, status: articleCategory.status });
      if (!updated[0] || updated[0].isDel !== 1 || updated[0].status !== 0) {
        throw new Error("article_category_delete_readback_mismatch");
      }
      await audit(tx, actor, `/adminapi/article/category/${id}`, "DELETE", `article.category.delete;id=${id}`);
      return { id, deleted: true as const, verified: true as const };
    });
  }

  async productOptions(query: Record<string, string>) {
    const limit = queryInteger(query.limit, "候选数量", 30, 1, 50);
    const conditions: SQL[] = [
      eq(storeProduct.type, 0),
      eq(storeProduct.relationId, 0),
      eq(storeProduct.isDel, 0),
    ];
    const keyword = (query.keyword ?? "").trim().slice(0, 80);
    if (keyword) conditions.push(ilike(storeProduct.storeName, `%${keyword}%`));
    const rows = await this.container.db.select({
      id: storeProduct.id,
      name: storeProduct.storeName,
      image: storeProduct.image,
      is_show: storeProduct.isShow,
    }).from(storeProduct).where(and(...conditions))
      .orderBy(desc(storeProduct.id)).limit(limit);
    const previews = await renderPublishedArticleMediaReferences(this.env.APP_KEY, rows.map((row) => row.image));
    return rows.map((row, index) => ({ ...row, image_preview: previews[index] }));
  }
}
