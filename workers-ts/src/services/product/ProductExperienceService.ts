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
} from "drizzle-orm";
import type { Container } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  storeProduct,
  storeProductEnsure,
  storeProductLog,
  storeProductRelation,
  storeVisit,
} from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";

const ENSURE_LOCK_NAMESPACE = 731_614;
const VISIT_LOCK_NAMESPACE = 731_615;
const PRODUCT_ENSURE_RELATION_TYPE = 5;
const VISIT_THROTTLE_SECONDS = 20;
const MAX_PAGE_SIZE = 100;

export interface ProductEnsureOwner {
  type: 0 | 2;
  relationId: number;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("参数格式错误");
  }
  return value as Record<string, unknown>;
}

function textValue(value: unknown, field: string, maxLength: number, required = true): string {
  if (typeof value !== "string") {
    if (!required && (value === undefined || value === null)) return "";
    throw new ValidateException(`请填写${field}`);
  }
  const result = value.trim();
  if (required && !result) throw new ValidateException(`请填写${field}`);
  if (result.length > maxLength) throw new ValidateException(`${field}不能超过${maxLength}个字符`);
  return result;
}

function nonNegativeInteger(value: unknown, field: string, fallback = 0): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new ValidateException(`${field}必须是非负整数`);
  }
  return parsed;
}

export function normalizeProductExperienceIds(value: unknown, maximum = 200): number[] {
  let source: unknown[];
  if (Array.isArray(value)) {
    source = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new ValidateException("ID列表格式错误");
      }
      if (!Array.isArray(parsed)) throw new ValidateException("ID列表格式错误");
      source = parsed;
    } else {
      source = trimmed.split(",");
    }
  } else if (value === undefined || value === null || value === "") {
    return [];
  } else {
    source = [value];
  }
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const item of source) {
    const id = Number(typeof item === "string" ? item.trim() : item);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("ID列表格式错误");
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length > maximum) throw new ValidateException(`一次最多处理${maximum}个ID`);
  return ids;
}

function dateParts(epochSeconds: number): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochSeconds * 1000));
  const get = (type: "year" | "month" | "day") => parts.find((part) => part.type === type)?.value ?? "";
  return { year: get("year"), month: get("month"), day: get("day") };
}

export function productVisitTimeKey(epochSeconds: number, nowEpochSeconds: number): string {
  const value = dateParts(epochSeconds);
  const now = dateParts(nowEpochSeconds);
  return value.year === now.year
    ? `${value.month}月${value.day}日`
    : `${value.year}年${value.month}月${value.day}日`;
}

function ownerScope(owner: ProductEnsureOwner) {
  return and(
    eq(storeProductEnsure.type, owner.type),
    eq(storeProductEnsure.relationId, owner.relationId),
  );
}

function pageValues(query: Record<string, string>): { page: number; limit: number } {
  const page = Math.max(1, nonNegativeInteger(query.page, "页码", 1));
  const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, nonNegativeInteger(query.limit, "每页数量", 20)));
  return { page, limit };
}

export class ProductExperienceService {
  constructor(private readonly container: Container) {}

  async ensureList(owner: ProductEnsureOwner, query: Record<string, string>) {
    const { page, limit } = pageValues(query);
    const conditions = [ownerScope(owner)];
    const name = query.name?.trim();
    if (name) conditions.push(ilike(storeProductEnsure.name, `%${name}%`));
    const where = and(...conditions);
    const [list, countRows] = await Promise.all([
      this.container.db
        .select()
        .from(storeProductEnsure)
        .where(where)
        .orderBy(desc(storeProductEnsure.sort), desc(storeProductEnsure.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storeProductEnsure)
        .where(where),
    ]);
    return { list: list.map((item) => this.formatEnsure(item)), count: countRows[0]?.count ?? 0, page, limit };
  }

  async allEnsures(owner: ProductEnsureOwner) {
    const scope = owner.type === 0
      ? ownerScope(owner)
      : or(
          and(eq(storeProductEnsure.type, 0), eq(storeProductEnsure.relationId, 0)),
          ownerScope(owner),
        );
    const rows = await this.container.db
      .select()
      .from(storeProductEnsure)
      .where(and(scope, eq(storeProductEnsure.status, 1)))
      .orderBy(desc(storeProductEnsure.sort), asc(storeProductEnsure.id));
    return rows.map((item) => this.formatEnsure(item));
  }

  async ensureDetail(owner: ProductEnsureOwner, id: number) {
    const row = (
      await this.container.db
        .select()
        .from(storeProductEnsure)
        .where(and(eq(storeProductEnsure.id, id), ownerScope(owner)))
        .limit(1)
    )[0];
    if (!row) throw new NotFoundException("商品保障服务不存在");
    return this.formatEnsure(row);
  }

  async saveEnsure(owner: ProductEnsureOwner, id: number, input: unknown) {
    const body = record(input);
    const name = textValue(body.name, "保障服务条款", 255);
    const image = textValue(body.image, "保障服务图标", 255);
    const descValue = textValue(body.desc, "保障服务描述", 255);
    const sort = nonNegativeInteger(body.sort, "排序");
    const status = nonNegativeInteger(body.status, "状态", 1);
    if (status !== 0 && status !== 1) throw new ValidateException("状态只能是0或1");
    return withTx(this.container, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${ENSURE_LOCK_NAMESPACE}, ${owner.relationId})`,
      );
      if (id > 0) {
        const existing = await tx
          .select({ id: storeProductEnsure.id })
          .from(storeProductEnsure)
          .where(and(eq(storeProductEnsure.id, id), ownerScope(owner)))
          .limit(1)
          .for("update");
        if (!existing[0]) throw new NotFoundException("商品保障服务不存在");
      }
      const duplicate = await tx
        .select({ id: storeProductEnsure.id })
        .from(storeProductEnsure)
        .where(
          and(
            ownerScope(owner),
            eq(storeProductEnsure.name, name),
            id > 0 ? sql`${storeProductEnsure.id} <> ${id}` : sql`TRUE`,
          ),
        )
        .limit(1);
      if (duplicate[0]) throw new ValidateException("保障服务条款已存在");
      if (id > 0) {
        await tx
          .update(storeProductEnsure)
          .set({ name, image, desc: descValue, sort, status })
          .where(eq(storeProductEnsure.id, id));
        return { id };
      }
      const inserted = await tx
        .insert(storeProductEnsure)
        .values({
          type: owner.type,
          relationId: owner.relationId,
          name,
          image,
          desc: descValue,
          sort,
          status,
          addTime: Math.floor(Date.now() / 1000),
        })
        .returning({ id: storeProductEnsure.id });
      return { id: inserted[0].id };
    });
  }

  async setEnsureStatus(owner: ProductEnsureOwner, id: number, status: number) {
    if (status !== 0 && status !== 1) throw new ValidateException("状态只能是0或1");
    const updated = await this.container.db
      .update(storeProductEnsure)
      .set({ status })
      .where(and(eq(storeProductEnsure.id, id), ownerScope(owner)))
      .returning({ id: storeProductEnsure.id });
    if (!updated[0]) throw new NotFoundException("商品保障服务不存在");
  }

  async deleteEnsure(owner: ProductEnsureOwner, id: number) {
    return withTx(this.container, async (tx) => {
      const existing = await tx
        .select({ id: storeProductEnsure.id })
        .from(storeProductEnsure)
        .where(and(eq(storeProductEnsure.id, id), ownerScope(owner)))
        .limit(1)
        .for("update");
      if (!existing[0]) throw new NotFoundException("商品保障服务不存在");
      const relation = await tx
        .select({ id: storeProductRelation.id })
        .from(storeProductRelation)
        .where(
          and(
            eq(storeProductRelation.type, PRODUCT_ENSURE_RELATION_TYPE),
            eq(storeProductRelation.relationId, id),
          ),
        )
        .limit(1);
      const legacy = await tx
        .select({ id: storeProduct.id })
        .from(storeProduct)
        .where(sql`(',' || COALESCE(${storeProduct.ensureId}, '') || ',') LIKE ${`%,${id},%`}`)
        .limit(1);
      if (relation[0] || legacy[0]) throw new ValidateException("该保障服务仍被商品使用，不能删除");
      await tx.delete(storeProductEnsure).where(eq(storeProductEnsure.id, id));
    });
  }

  async productEnsures(productId: number, legacyIds: unknown) {
    const relationRows = await this.container.db
      .select({ id: storeProductRelation.relationId })
      .from(storeProductRelation)
      .where(
        and(
          eq(storeProductRelation.productId, productId),
          eq(storeProductRelation.type, PRODUCT_ENSURE_RELATION_TYPE),
          eq(storeProductRelation.status, 1),
        ),
      );
    const ids = normalizeProductExperienceIds([
      ...normalizeProductExperienceIds(legacyIds),
      ...relationRows.map((row) => row.id),
    ]);
    if (!ids.length) return [];
    const rows = await this.container.db
      .select()
      .from(storeProductEnsure)
      .where(and(inArray(storeProductEnsure.id, ids), eq(storeProductEnsure.status, 1)))
      .orderBy(desc(storeProductEnsure.sort), asc(storeProductEnsure.id));
    return rows.map((item) => ({ id: item.id, name: item.name, image: item.image, desc: item.desc }));
  }

  async recordVisit(uid: number, productId: number, cateId = 0, now = Math.floor(Date.now() / 1000)) {
    if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(productId) || productId <= 0) {
      throw new ValidateException("浏览记录参数错误");
    }
    return withTx(this.container, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${VISIT_LOCK_NAMESPACE}, hashtext(${`${uid}:${productId}:product`}))`,
      );
      await tx.insert(storeProductLog).values({
        type: "visit",
        productId,
        uid,
        visitNum: 1,
        addTime: now,
      });
      const existing = await tx
        .select()
        .from(storeVisit)
        .where(
          and(
            eq(storeVisit.uid, uid),
            eq(storeVisit.productId, productId),
            eq(storeVisit.productType, "product"),
          ),
        )
        .orderBy(desc(storeVisit.id))
        .limit(1)
        .for("update");
      if (!existing[0]) {
        await tx.insert(storeVisit).values({
          productId,
          productType: "product",
          cateId: Math.max(0, cateId),
          type: "view",
          uid,
          count: 1,
          content: "",
          addTime: now,
        });
      } else if (existing[0].addTime + VISIT_THROTTLE_SECONDS < now) {
        await tx
          .update(storeVisit)
          .set({ count: existing[0].count + 1, cateId: Math.max(0, cateId), addTime: now })
          .where(eq(storeVisit.id, existing[0].id));
      }
    });
  }

  async userVisitList(uid: number, query: Record<string, string>, now = Math.floor(Date.now() / 1000)) {
    const { page, limit } = pageValues(query);
    const where = and(
      eq(storeProductLog.uid, uid),
      eq(storeProductLog.type, "visit"),
      isNull(storeProductLog.deleteTime),
    );
    const [rows, countRows] = await Promise.all([
      this.container.db
        .select({
          id: sql<number>`MAX(${storeProductLog.id})::int`,
          product_id: storeProductLog.productId,
          add_time: sql<number>`MAX(${storeProductLog.addTime})::int`,
          store_name: storeProduct.storeName,
          image: storeProduct.image,
          product_price: storeProduct.price,
          stock: storeProduct.stock,
          is_show: storeProduct.isShow,
        })
        .from(storeProductLog)
        .innerJoin(storeProduct, eq(storeProduct.id, storeProductLog.productId))
        .where(where)
        .groupBy(
          storeProductLog.productId,
          storeProduct.storeName,
          storeProduct.image,
          storeProduct.price,
          storeProduct.stock,
          storeProduct.isShow,
        )
        .orderBy(desc(sql`MAX(${storeProductLog.addTime})`), desc(storeProductLog.productId))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(DISTINCT ${storeProductLog.productId})::int` })
        .from(storeProductLog)
        .where(where),
    ]);
    const list = rows.map((item) => ({
      ...item,
      time_key: productVisitTimeKey(item.add_time, now),
    }));
    return {
      list,
      count: countRows[0]?.count ?? 0,
      time: [...new Set(list.map((item) => item.time_key))],
      page,
      limit,
    };
  }

  async deleteUserVisits(uid: number, rawIds: unknown) {
    const ids = normalizeProductExperienceIds(rawIds);
    if (!ids.length) return { deleted: 0 };
    const deleted = await this.container.db
      .update(storeProductLog)
      .set({ deleteTime: new Date() })
      .where(
        and(
          eq(storeProductLog.uid, uid),
          eq(storeProductLog.type, "visit"),
          isNull(storeProductLog.deleteTime),
          inArray(storeProductLog.productId, ids),
        ),
      )
      .returning({ id: storeProductLog.id });
    return { deleted: deleted.length };
  }

  private formatEnsure(item: typeof storeProductEnsure.$inferSelect) {
    return {
      id: item.id,
      type: item.type,
      relation_id: item.relationId,
      name: item.name,
      image: item.image,
      desc: item.desc,
      sort: item.sort,
      status: item.status,
      add_time: item.addTime,
    };
  }
}

export const platformEnsureOwner: ProductEnsureOwner = { type: 0, relationId: 0 };
export function supplierEnsureOwner(relationId: number): ProductEnsureOwner {
  if (!Number.isSafeInteger(relationId) || relationId <= 0) throw new ValidateException("供应商ID错误");
  return { type: 2, relationId };
}
