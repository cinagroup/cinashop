import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  storeProduct,
  storeProductReply,
  storeProductReplyComment,
  systemAdmin,
  systemSupplier,
  systemRole,
  systemMenus,
} from "@/models/schema";
import { AuthException, HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from "@/utils/errors";
import { lockReviewProducts } from '@/services/product/ProductReviewRatingService';
import { assertSupplierVideoAuthority, type SupplierVideoActor } from './SupplierVideoAuthority';

const SUPPLIER_OWNER_TYPE = 2;
const MAX_PAGE = 1_000_000;
const MAX_LIMIT = 100;
const MAX_FILTER_LENGTH = 128;
const MAX_DATE_FILTER_LENGTH = 100;
const MAX_REPLY_CONTENT_LENGTH = 500;
const MAX_EPOCH_SECONDS = 2_147_483_647;

export interface SupplierProductReplyQuery {
  page: number;
  limit: number;
  isReply?: 0 | 1;
  productId?: number;
  productKeyword?: string;
  account?: string;
  startTime?: number;
  endTime?: number;
}

function positiveInteger(value: unknown, label: string, fallback: number, maximum: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ValidateException(`${label}无效`);
  }
  return parsed;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "" || value === 0 || value === "0") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
    throw new ValidateException(`${label}无效`);
  }
  return parsed;
}

function optionalBoundedText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ValidateException(`${label}无效`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > MAX_FILTER_LENGTH) throw new ValidateException(`${label}不能超过${MAX_FILTER_LENGTH}个字符`);
  return normalized;
}

function datePartEpoch(value: string, endOfDay: boolean): number | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (/^\d{10,13}$/.test(text)) {
    const numeric = Number(text);
    const seconds = text.length === 13 ? Math.floor(numeric / 1_000) : numeric;
    return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= MAX_EPOCH_SECONDS
      ? seconds
      : undefined;
  }
  const day = text.match(/^(\d{4}-\d{2}-\d{2})$/)?.[1];
  const parsed = Date.parse(day
    ? `${day}T${endOfDay ? "23:59:59" : "00:00:00"}+08:00`
    : text);
  const seconds = Math.floor(parsed / 1_000);
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= MAX_EPOCH_SECONDS
    ? seconds
    : undefined;
}

function dateRange(value: unknown): { startTime?: number; endTime?: number } {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "string" || value.length > MAX_DATE_FILTER_LENGTH) {
    throw new ValidateException("评价时间范围无效");
  }
  const parts = value.trim().split(/\s+(?:-|~|至)\s+|,/).map((item) => item.trim()).filter(Boolean);
  if (parts.length < 1 || parts.length > 2) throw new ValidateException("评价时间范围无效");
  const startTime = datePartEpoch(parts[0], false);
  const endTime = datePartEpoch(parts[1] ?? parts[0], true);
  if (startTime === undefined || endTime === undefined || startTime > endTime) {
    throw new ValidateException("评价时间范围无效");
  }
  return { startTime, endTime };
}

export function parseSupplierProductReplyQuery(
  query: Record<string, string | undefined>,
): SupplierProductReplyQuery {
  const rawIsReply = query.is_reply;
  let isReply: 0 | 1 | undefined;
  if (rawIsReply !== undefined && rawIsReply !== "") {
    const parsed = Number(rawIsReply);
    if (parsed !== 0 && parsed !== 1) throw new ValidateException("回复状态无效");
    isReply = parsed;
  }
  return {
    page: positiveInteger(query.page, "页码", 1, MAX_PAGE),
    limit: positiveInteger(query.limit, "每页数量", 15, MAX_LIMIT),
    isReply,
    productId: optionalPositiveInteger(query.product_id, "商品ID"),
    productKeyword: optionalBoundedText(query.store_name, "商品信息"),
    account: optionalBoundedText(query.account, "用户名称"),
    ...dateRange(query.data),
  };
}

export function normalizeSupplierProductReplyContent(value: unknown): string {
  if (typeof value !== "string") throw new ValidateException("请输入回复内容");
  const normalized = value.replace(/\0/g, "").trim();
  if (!normalized) throw new ValidateException("请输入回复内容");
  if (normalized.length > MAX_REPLY_CONTENT_LENGTH) {
    throw new ValidateException(`回复内容不能超过${MAX_REPLY_CONTENT_LENGTH}个字符`);
  }
  return normalized;
}

/** The old content-only PUT remains valid. The drill-through consumer also
 * binds the review to the product it actually displayed, without inventing CAS. */
export function parseSupplierProductReplyInput(value: unknown): { content: string; expectedProductId?: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('评价回复正文无效');
  const body = value as Record<string, unknown>;
  if (!Object.hasOwn(body, 'content') || Object.keys(body).some(key => !['content', 'expected_product_id'].includes(key))) {
    throw new ValidateException('评价回复字段无效');
  }
  if (Object.hasOwn(body, 'expected_product_id') && (typeof body.expected_product_id !== 'number'
    || !Number.isSafeInteger(body.expected_product_id) || body.expected_product_id < 1 || body.expected_product_id > MAX_EPOCH_SECONDS)) {
    throw new ValidateException('评价所属商品ID无效');
  }
  return { content: normalizeSupplierProductReplyContent(body.content),
    ...(Object.hasOwn(body, 'expected_product_id') ? { expectedProductId: body.expected_product_id as number } : {}) };
}

export async function assertSupplierProductReplyReadReady(tx: DbClient) {
  const [row] = await tx.execute(sql`SELECT current_user=session_user AND current_setting('transaction_read_only')::boolean
    AND NOT r.rolsuper AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND NOT r.rolbypassrls
    AND NOT has_schema_privilege(current_user,'public','CREATE')
    AND NOT EXISTS(WITH RECURSIVE parents(oid) AS(SELECT r.oid UNION SELECT m.roleid FROM pg_auth_members m JOIN parents p ON p.oid=m.member)
      SELECT 1 FROM parents p JOIN pg_roles unsafe ON unsafe.oid=p.oid WHERE unsafe.rolsuper OR unsafe.rolcreaterole OR unsafe.rolcreatedb OR unsafe.rolreplication OR unsafe.rolbypassrls)
    AND(SELECT count(*)=7 AND bool_and(c.relkind='r' AND has_table_privilege(current_user,c.oid,'SELECT')) FROM pg_class c
      WHERE c.relnamespace='public'::regnamespace AND c.relname IN('system_admin','system_supplier','system_role','system_menus','store_product','store_product_reply','store_product_reply_comment')) AS ready
    FROM pg_roles r WHERE r.rolname=current_user`);
  if (row?.ready !== true) throw new ServiceUnavailableException('供应商评价读取身份或权限尚未就绪');
}

/** Existing Supplier write protocol: live JWT authority, ordered actual-row
 * SHARE NOWAIT barriers, then the shared product-before-review write locks. */
async function lockReplyAuthority(tx: DbClient, actor: SupplierVideoActor, supplierId: number) {
  if (actor.supplierId !== supplierId) throw new AuthException('供应商评价操作身份不匹配', 400011);
  await assertSupplierVideoAuthority(tx, actor, 'supplier.product.manage');
  const [admin] = await tx.select().from(systemAdmin).where(and(eq(systemAdmin.id, actor.id), eq(systemAdmin.adminType, 4),
    eq(systemAdmin.relationId, supplierId), eq(systemAdmin.status, 1), eq(systemAdmin.isDel, 0))).limit(1).for('share', { noWait: true });
  const [supplier] = await tx.select().from(systemSupplier).where(and(eq(systemSupplier.id, supplierId),
    eq(systemSupplier.isShow, 1), eq(systemSupplier.isDel, 0))).limit(1).for('share', { noWait: true });
  if (!admin || !supplier) throw new AuthException('供应商评价操作身份已变化', 400011);
  if (supplier.adminId !== admin.id) {
    const ids = (value: string) => {
      const tokens = [...new Set(value.split(',').map(x => x.trim()).filter(Boolean))];
      if (tokens.length > 512) throw new ValidateException('供应商评价权限数量超出范围');
      return tokens.filter(x => /^[1-9]\d*$/.test(x)).map(Number).filter(x => Number.isSafeInteger(x) && x <= MAX_EPOCH_SECONDS).sort((a, b) => a - b);
    };
    const roleIds = ids(admin.roles), roles = roleIds.length ? await tx.select().from(systemRole).where(and(inArray(systemRole.id, roleIds),
      eq(systemRole.type, 4), eq(systemRole.relationId, supplierId), eq(systemRole.status, 1))).orderBy(asc(systemRole.id)).for('share', { noWait: true }) : [];
    const menuIds = [...new Set(roles.flatMap(row => ids(row.rules)))].sort((a, b) => a - b);
    if (menuIds.length > 512) throw new ValidateException('供应商评价菜单数量超出范围');
    if (menuIds.length) await tx.select({ id: systemMenus.id }).from(systemMenus).where(and(inArray(systemMenus.id, menuIds),
      eq(systemMenus.type, 4), eq(systemMenus.authType, 2), eq(systemMenus.access, 1), eq(systemMenus.isDel, 0)))
      .orderBy(asc(systemMenus.id)).for('share', { noWait: true });
  }
  await assertSupplierVideoAuthority(tx, actor, 'supplier.product.manage');
}

function replyFailure(error: unknown): never {
  let cause = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
    const code = 'code' in cause ? String(cause.code) : '';
    if (['55P03', '40P01', '40001'].includes(code)) throw new HttpApiException('评价、商品或权限正在变化，请重新读取后核对', 409, 409);
    if (['42501', '57014', '42P01', '42703'].includes(code)) throw new ServiceUnavailableException('供应商评价运行权限或处理容量尚未就绪');
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}

function assertSupplierId(supplierId: number): void {
  if (!Number.isSafeInteger(supplierId) || supplierId <= 0) {
    throw new ValidateException("供应商身份无效");
  }
}

function formatShanghaiEpoch(value: number): string {
  if (!value) return "";
  const date = new Date((value + 8 * 60 * 60) * 1_000);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function parsePics(value: string | null): string[] {
  if (!value || value.length > 32_768) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.length <= 2_048).slice(0, 8)
      : [];
  } catch {
    return [];
  }
}

export class SupplierProductReplyService {
  constructor(private readonly container: Container) {}

  async list(supplierId: number, rawQuery: Record<string, string | undefined>, actor?: SupplierVideoActor) {
    assertSupplierId(supplierId);
    const query = parseSupplierProductReplyQuery(rawQuery);
    try { return await withTx(this.container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    if (actor) {
      if (actor.supplierId !== supplierId) throw new AuthException('供应商评价读取身份不匹配', 400011);
      await assertSupplierProductReplyReadReady(tx);
      await assertSupplierVideoAuthority(tx, actor, 'supplier.product.view');
    }
    const conditions: SQL[] = [
      eq(storeProductReply.type, SUPPLIER_OWNER_TYPE),
      eq(storeProductReply.relationId, supplierId),
      eq(storeProductReply.isDel, 0),
      eq(storeProduct.type, SUPPLIER_OWNER_TYPE),
      eq(storeProduct.relationId, supplierId),
    ];
    if (query.isReply !== undefined) conditions.push(eq(storeProductReply.isReply, query.isReply));
    if (query.productId !== undefined) conditions.push(eq(storeProductReply.productId, query.productId));
    if (query.productKeyword) {
      const keyword = `%${query.productKeyword}%`;
      conditions.push(or(
        ilike(storeProduct.storeName, keyword),
        ilike(storeProduct.keyword, keyword),
        ilike(sql`${storeProductReply.id}::text`, keyword),
        ilike(sql`${storeProductReply.productId}::text`, keyword),
      )!);
    }
    if (query.account) conditions.push(ilike(storeProductReply.nickname, `%${query.account}%`));
    if (query.startTime !== undefined) conditions.push(gte(storeProductReply.addTime, query.startTime));
    if (query.endTime !== undefined) conditions.push(lte(storeProductReply.addTime, query.endTime));
    const where = and(...conditions);

    const [rows, totals] = await Promise.all([
      tx
        .select({
          id: storeProductReply.id,
          productId: storeProductReply.productId,
          storeName: storeProduct.storeName,
          productImage: storeProduct.image,
          nickname: storeProductReply.nickname,
          comment: storeProductReply.comment,
          sku: storeProductReply.sku,
          productScore: storeProductReply.productScore,
          serviceScore: storeProductReply.serviceScore,
          deliveryScore: storeProductReply.deliveryScore,
          pics: storeProductReply.pics,
          isReply: storeProductReply.isReply,
          addTime: storeProductReply.addTime,
        })
        .from(storeProductReply)
        .innerJoin(storeProduct, eq(storeProduct.id, storeProductReply.productId))
        .where(where)
        .orderBy(desc(storeProductReply.addTime), asc(storeProductReply.isReply), desc(storeProductReply.id))
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
      tx
        .select({ value: sql<number>`COUNT(*)::int` })
        .from(storeProductReply)
        .innerJoin(storeProduct, eq(storeProduct.id, storeProductReply.productId))
        .where(where),
    ]);

    const replyIds = rows.map((row) => row.id);
    const comments = replyIds.length
      ? await tx
          .select({
            id: storeProductReplyComment.id,
            replyId: storeProductReplyComment.replyId,
            content: storeProductReplyComment.content,
            addTime: storeProductReplyComment.addTime,
            updateTime: storeProductReplyComment.updateTime,
          })
          .from(storeProductReplyComment)
          .where(and(
            inArray(storeProductReplyComment.replyId, replyIds),
            eq(storeProductReplyComment.type, SUPPLIER_OWNER_TYPE),
            eq(storeProductReplyComment.relationId, supplierId),
            eq(storeProductReplyComment.uid, 0),
            eq(storeProductReplyComment.pid, 0),
            eq(storeProductReplyComment.isDel, 0),
          ))
          .orderBy(desc(storeProductReplyComment.updateTime), desc(storeProductReplyComment.id))
      : [];
    const commentByReply = new Map<number, typeof comments[number]>();
    for (const comment of comments) {
      if (!commentByReply.has(comment.replyId)) commentByReply.set(comment.replyId, comment);
    }

    const result = {
      list: rows.map((row) => {
        const replyComment = commentByReply.get(row.id);
        return {
          id: row.id,
          product_id: row.productId,
          store_name: row.storeName,
          image: row.productImage,
          nickname: row.nickname,
          account: row.nickname,
          comment: row.comment || "此用户没有填写评价",
          sku: row.sku,
          product_score: row.productScore,
          service_score: row.serviceScore,
          delivery_score: row.deliveryScore,
          score: Math.floor((row.productScore + row.serviceScore + row.deliveryScore) / 3),
          pics: parsePics(row.pics),
          is_reply: row.isReply,
          add_time: formatShanghaiEpoch(row.addTime),
          replyComment: replyComment ? {
            id: replyComment.id,
            content: replyComment.content,
            add_time: formatShanghaiEpoch(replyComment.addTime),
            update_time: formatShanghaiEpoch(replyComment.updateTime),
          } : null,
        };
      }),
      count: Number(totals[0]?.value ?? 0),
      page: query.page,
      limit: query.limit,
    };
    if (actor) await assertSupplierVideoAuthority(tx, actor, 'supplier.product.view');
    return result;
    }); } catch (error) { if (actor) return replyFailure(error); throw error; }
  }

  async setReply(supplierId: number, replyId: number, rawContent: unknown, actor?: SupplierVideoActor, expectedProductId?: number) {
    assertSupplierId(supplierId);
    if (!Number.isSafeInteger(replyId) || replyId <= 0) throw new ValidateException("评价ID无效");
    const content = normalizeSupplierProductReplyContent(rawContent);
    if (expectedProductId !== undefined && (!Number.isSafeInteger(expectedProductId) || expectedProductId < 1 || expectedProductId > MAX_EPOCH_SECONDS)) {
      throw new ValidateException('评价所属商品ID无效');
    }
    const now = Math.floor(Date.now() / 1_000);

    try { return await withTx(this.container, async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
      await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
      if (actor) await lockReplyAuthority(tx, actor, supplierId);
      const [located] = await tx.select({ productId: storeProductReply.productId }).from(storeProductReply).where(and(
        eq(storeProductReply.id, replyId), eq(storeProductReply.type, SUPPLIER_OWNER_TYPE),
        eq(storeProductReply.relationId, supplierId), eq(storeProductReply.isDel, 0),
      )).limit(1);
      if (!located) throw new NotFoundException("评论不存在或不属于当前供应商");
      if (expectedProductId !== undefined && located.productId !== expectedProductId) throw new HttpApiException('评价所属商品已变化，请重新读取', 409, 409);
      const product = (await lockReviewProducts(tx, [located.productId])).get(located.productId);
      if (!product || product.type !== SUPPLIER_OWNER_TYPE || product.relationId !== supplierId) {
        throw new NotFoundException("评论不存在或不属于当前供应商");
      }
      // A joined FOR UPDATE leaves row lock order to the SQL execution plan.
      // Creation/rating/deletion own the product before a review: take those
      // rows explicitly in the same order, then recheck the located parent.
      const rows = await tx
        .select({ id: storeProductReply.id, productId: storeProductReply.productId })
        .from(storeProductReply)
        .where(and(
          eq(storeProductReply.id, replyId),
          eq(storeProductReply.type, SUPPLIER_OWNER_TYPE),
          eq(storeProductReply.relationId, supplierId),
          eq(storeProductReply.isDel, 0),
        ))
        .limit(1)
        .for("update");
      if (!rows[0]) throw new NotFoundException("评论不存在或不属于当前供应商");
      if (rows[0].productId !== located.productId || expectedProductId !== undefined && rows[0].productId !== expectedProductId) {
        throw new HttpApiException('评价所属商品已变化，请重新读取', 409, 409);
      }
      if (actor) await assertSupplierVideoAuthority(tx, actor, 'supplier.product.manage');

      const existing = await tx
        .select({ id: storeProductReplyComment.id })
        .from(storeProductReplyComment)
        .where(and(
          eq(storeProductReplyComment.replyId, replyId),
          eq(storeProductReplyComment.uid, 0),
          eq(storeProductReplyComment.pid, 0),
          eq(storeProductReplyComment.type, SUPPLIER_OWNER_TYPE),
          eq(storeProductReplyComment.relationId, supplierId),
          eq(storeProductReplyComment.isDel, 0),
        ))
        .orderBy(desc(storeProductReplyComment.id))
        .limit(1);

      let commentId: number;
      if (existing[0]) {
        await tx.update(storeProductReplyComment)
          .set({ content, updateTime: now })
          .where(and(
            eq(storeProductReplyComment.id, existing[0].id),
            eq(storeProductReplyComment.replyId, replyId),
            eq(storeProductReplyComment.type, SUPPLIER_OWNER_TYPE),
            eq(storeProductReplyComment.relationId, supplierId),
          ));
        commentId = existing[0].id;
      } else {
        const inserted = await tx.insert(storeProductReplyComment).values({
          type: SUPPLIER_OWNER_TYPE,
          relationId: supplierId,
          replyId,
          pid: 0,
          uid: 0,
          nickname: "",
          avatar: "",
          content,
          praise: 0,
          isDel: 0,
          addTime: now,
          updateTime: now,
        }).returning({ id: storeProductReplyComment.id });
        commentId = inserted[0].id;
      }

      await tx.update(storeProductReply)
        .set({ isReply: 1 })
        .where(and(
          eq(storeProductReply.id, replyId),
          eq(storeProductReply.type, SUPPLIER_OWNER_TYPE),
          eq(storeProductReply.relationId, supplierId),
          eq(storeProductReply.isDel, 0),
        ));
      if (actor) await assertSupplierVideoAuthority(tx, actor, 'supplier.product.manage');
      return { id: replyId, comment_id: commentId, is_reply: 1 as const };
    }); } catch (error) { if (actor) return replyFailure(error); throw error; }
  }
}
