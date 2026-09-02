import { and, desc, eq, ilike, ne, sql } from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import { storeProductWords, systemLog } from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";

const PLATFORM_TYPE = 0;
const PLATFORM_RELATION_ID = 0;
const WORDS_LOCK_NAMESPACE = 731_614;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 10_000;
const MAX_NAME_LENGTH = 15;
const MAX_ICON_LENGTH = 128;
const COLOR_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_RGB = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i;
const SAFE_RELATIVE_ASSET = /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]+$/;

export interface ProductWordsActor {
  id: number;
  name: string;
  ip: string;
}

interface ProductWordInput {
  name: string;
  color: string;
  bgColor: string;
  borderColor: string;
  icon: string;
  sort: number;
  isSearch: number;
  isShow: number;
}

function integer(value: unknown, field: string, defaultValue: number, max: number): number {
  if (value === undefined || value === null || value === "") return defaultValue;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new ValidateException(`${field}必须是0至${max}的整数`);
  }
  return parsed;
}

function binaryFlag(value: unknown, field: string, defaultValue: number): number {
  if (value === undefined || value === null || value === "") return defaultValue;
  const parsed = value === true ? 1 : value === false ? 0 : Number(value);
  if (parsed !== 0 && parsed !== 1) throw new ValidateException(`${field}只能是0或1`);
  return parsed;
}

export function normalizeProductWordName(value: unknown): string {
  if (typeof value !== "string") throw new ValidateException("请填写热词名称");
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (!normalized) throw new ValidateException("请填写热词名称");
  if (length > MAX_NAME_LENGTH) {
    throw new ValidateException(`热词名称不能超过${MAX_NAME_LENGTH}个字符`);
  }
  return normalized;
}

export function normalizeProductWordColor(value: unknown, field: string): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new ValidateException(`${field}格式错误`);
  const normalized = value.trim();
  if (normalized === "transparent" || COLOR_HEX.test(normalized)) return normalized;
  const match = normalized.match(COLOR_RGB);
  if (!match) throw new ValidateException(`${field}仅支持十六进制、RGB或RGBA颜色`);
  const channels = match.slice(1, 4).map(Number);
  if (channels.some((channel) => channel < 0 || channel > 255)) {
    throw new ValidateException(`${field}RGB分量必须在0至255之间`);
  }
  if (match[4] !== undefined) {
    const alpha = Number(match[4]);
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
      throw new ValidateException(`${field}透明度必须在0至1之间`);
    }
  }
  return normalized;
}

export function normalizeProductWordIcon(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new ValidateException("图标地址格式错误");
  const normalized = value.trim();
  if (normalized.length > MAX_ICON_LENGTH) {
    throw new ValidateException(`图标地址不能超过${MAX_ICON_LENGTH}个字符`);
  }
  if (SAFE_RELATIVE_ASSET.test(normalized)) return normalized;
  try {
    const url = new URL(normalized);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("unsafe");
    const canonical = url.toString();
    if (canonical.length > MAX_ICON_LENGTH) throw new Error("too-long");
    return canonical;
  } catch {
    throw new ValidateException("图标地址必须是HTTPS或站内绝对路径");
  }
}

function normalizeInput(value: unknown): ProductWordInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("请求数据格式错误");
  }
  const body = value as Record<string, unknown>;
  return {
    name: normalizeProductWordName(body.name),
    color: normalizeProductWordColor(body.color, "文字颜色"),
    bgColor: normalizeProductWordColor(body.bg_color ?? body.bgColor, "背景颜色"),
    borderColor: normalizeProductWordColor(body.border_color ?? body.borderColor, "边框颜色"),
    icon: normalizeProductWordIcon(body.icon),
    sort: integer(body.sort, "排序", 0, 999),
    isSearch: binaryFlag(body.is_search ?? body.isSearch, "大家都在搜", 1),
    isShow: binaryFlag(body.is_show ?? body.isShow, "显示状态", 1),
  };
}

function platformScope() {
  return and(
    eq(storeProductWords.type, PLATFORM_TYPE),
    eq(storeProductWords.relationId, PLATFORM_RELATION_ID),
  );
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function safeStoredColor(value: string, field: string): string {
  try {
    return normalizeProductWordColor(value, field);
  } catch {
    return "";
  }
}

function safeStoredIcon(value: string): string {
  try {
    return normalizeProductWordIcon(value);
  } catch {
    return "";
  }
}

function formatWord(row: typeof storeProductWords.$inferSelect) {
  return {
    id: row.id,
    type: row.type,
    relation_id: row.relationId,
    name: row.name,
    color: safeStoredColor(row.color, "文字颜色"),
    bg_color: safeStoredColor(row.bgColor, "背景颜色"),
    border_color: safeStoredColor(row.borderColor, "边框颜色"),
    icon: safeStoredIcon(row.icon),
    is_show: row.isShow,
    sort: row.sort,
    is_search: row.isSearch,
    is_hot: row.isHot,
    is_del: row.isDel,
    add_time: row.addTime,
  };
}

async function writeAudit(
  tx: DbClient,
  actor: ProductWordsActor,
  method: "POST" | "PUT" | "DELETE",
  operation: string,
  id: number,
  now: number,
): Promise<void> {
  await tx.insert(systemLog).values({
    adminId: actor.id,
    adminName: actor.name.slice(0, 64),
    path: `/api/admin/product/words/${id}`,
    page: "/product/metadata",
    method,
    action: `product_words.${operation};id=${id}`,
    ip: actor.ip.slice(0, 45),
    type: "product_words",
    addTime: now,
  });
}

export class ProductWordsService {
  constructor(private readonly container: Container) {}

  async list(query: Record<string, string>) {
    const page = integer(query.page, "页码", 1, MAX_PAGE);
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, integer(query.limit, "每页数量", 20, MAX_PAGE_SIZE)));
    const conditions = [platformScope(), eq(storeProductWords.isDel, 0)];
    const name = query.name?.trim();
    if (name) {
      conditions.push(ilike(
        storeProductWords.name,
        `%${escapeLikePattern(name.slice(0, MAX_NAME_LENGTH))}%`,
      ));
    }
    const where = and(...conditions);
    const [rows, countRows] = await Promise.all([
      this.container.db
        .select()
        .from(storeProductWords)
        .where(where)
        .orderBy(desc(storeProductWords.sort), desc(storeProductWords.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storeProductWords)
        .where(where),
    ]);
    return { list: rows.map(formatWord), count: countRows[0]?.count ?? 0, page, limit };
  }

  async allVisible() {
    const rows = await this.container.db
      .select({ id: storeProductWords.id, name: storeProductWords.name })
      .from(storeProductWords)
      .where(and(platformScope(), eq(storeProductWords.isShow, 1), eq(storeProductWords.isDel, 0)))
      .orderBy(desc(storeProductWords.sort), desc(storeProductWords.id));
    return rows;
  }

  async publicKeywords() {
    const rows = await this.container.db
      .select({
        id: storeProductWords.id,
        name: storeProductWords.name,
        color: storeProductWords.color,
        bgColor: storeProductWords.bgColor,
        borderColor: storeProductWords.borderColor,
        icon: storeProductWords.icon,
      })
      .from(storeProductWords)
      .where(and(platformScope(), eq(storeProductWords.isShow, 1), eq(storeProductWords.isDel, 0)))
      .orderBy(desc(storeProductWords.sort), desc(storeProductWords.id))
      .limit(20);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      keyword: row.name,
      color: safeStoredColor(row.color, "文字颜色"),
      bg_color: safeStoredColor(row.bgColor, "背景颜色"),
      border_color: safeStoredColor(row.borderColor, "边框颜色"),
      icon: safeStoredIcon(row.icon),
    }));
  }

  async detail(id: number) {
    const rows = await this.container.db
      .select()
      .from(storeProductWords)
      .where(and(eq(storeProductWords.id, id), platformScope(), eq(storeProductWords.isDel, 0)))
      .limit(1);
    if (!rows[0]) throw new NotFoundException("搜索热词不存在");
    return formatWord(rows[0]);
  }

  async save(id: number, input: unknown, actor: ProductWordsActor) {
    const data = normalizeInput(input);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${WORDS_LOCK_NAMESPACE}, ${PLATFORM_RELATION_ID})`);
      if (id > 0) {
        const existing = await tx
          .select({ id: storeProductWords.id })
          .from(storeProductWords)
          .where(and(eq(storeProductWords.id, id), platformScope(), eq(storeProductWords.isDel, 0)))
          .limit(1);
        if (!existing[0]) throw new NotFoundException("搜索热词不存在");
      }
      const duplicateConditions = [
        platformScope(),
        eq(storeProductWords.isDel, 0),
        sql`lower(btrim(${storeProductWords.name})) = ${data.name.toLowerCase()}`,
      ];
      if (id > 0) duplicateConditions.push(ne(storeProductWords.id, id));
      const duplicate = await tx
        .select({ id: storeProductWords.id })
        .from(storeProductWords)
        .where(and(...duplicateConditions))
        .limit(1);
      if (duplicate[0]) throw new ValidateException("热词名称已经存在");
      const now = Math.floor(Date.now() / 1000);
      if (id > 0) {
        const updated = await tx.update(storeProductWords).set({
          name: data.name,
          color: data.color,
          bgColor: data.bgColor,
          borderColor: data.borderColor,
          icon: data.icon,
          sort: data.sort,
          isSearch: data.isSearch,
          isShow: data.isShow,
        }).where(and(eq(storeProductWords.id, id), platformScope(), eq(storeProductWords.isDel, 0)))
          .returning({ id: storeProductWords.id });
        if (!updated[0]) throw new NotFoundException("搜索热词不存在");
        await writeAudit(tx, actor, "POST", "update", id, now);
        return { id };
      }
      const inserted = await tx.insert(storeProductWords).values({
        type: PLATFORM_TYPE,
        relationId: PLATFORM_RELATION_ID,
        name: data.name,
        color: data.color,
        bgColor: data.bgColor,
        borderColor: data.borderColor,
        icon: data.icon,
        sort: data.sort,
        isSearch: data.isSearch,
        isShow: data.isShow,
        isHot: 0,
        isDel: 0,
        addTime: now,
      }).returning({ id: storeProductWords.id });
      const createdId = inserted[0].id;
      await writeAudit(tx, actor, "POST", "create", createdId, now);
      return { id: createdId };
    });
  }

  async setShow(id: number, isShow: number, actor: ProductWordsActor): Promise<void> {
    const status = binaryFlag(isShow, "显示状态", 1);
    await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${WORDS_LOCK_NAMESPACE}, ${PLATFORM_RELATION_ID})`);
      const updated = await tx.update(storeProductWords)
        .set({ isShow: status })
        .where(and(eq(storeProductWords.id, id), platformScope(), eq(storeProductWords.isDel, 0)))
        .returning({ id: storeProductWords.id });
      if (!updated[0]) throw new NotFoundException("搜索热词不存在");
      await writeAudit(tx, actor, "PUT", status ? "show" : "hide", id, Math.floor(Date.now() / 1000));
    });
  }

  async delete(id: number, actor: ProductWordsActor): Promise<void> {
    await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${WORDS_LOCK_NAMESPACE}, ${PLATFORM_RELATION_ID})`);
      const deleted = await tx.update(storeProductWords)
        .set({ isDel: 1, isShow: 0, isHot: 0 })
        .where(and(eq(storeProductWords.id, id), platformScope(), eq(storeProductWords.isDel, 0)))
        .returning({ id: storeProductWords.id });
      if (!deleted[0]) throw new NotFoundException("搜索热词不存在");
      await writeAudit(tx, actor, "DELETE", "soft_delete", id, Math.floor(Date.now() / 1000));
    });
  }
}
