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
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  storeProduct,
  storeProductEnsure,
  storeProductLog,
  storeProductRelation,
  storeVisit,
} from "@/models/schema";
import { NotFoundException, ServiceUnavailableException, ValidateException } from "@/utils/errors";
import { formatParameterSpecTime } from './ProductMetadataService';

const ENSURE_LOCK_NAMESPACE = 731_614;
const VISIT_LOCK_NAMESPACE = 731_615;
const PRODUCT_ENSURE_RELATION_TYPE = 5;
const VISIT_THROTTLE_SECONDS = 20;
const MAX_PAGE_SIZE = 100;
const MAX_ENSURE_READ_ROWS = 2000;

async function lockEnsureLifecycle(tx: DbClient, owner: ProductEnsureOwner): Promise<void> {
  if (!(owner.type === 0 && owner.relationId === 0 || owner.type === 2 && Number.isSafeInteger(owner.relationId)
    && owner.relationId > 0 && owner.relationId <= 2147483647)) throw new ValidateException('保障服务归属错误');
  await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
  await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${ENSURE_LOCK_NAMESPACE}, ${owner.relationId})`);
}

function ensureString(value: unknown, label: string, required = true): string {
  if (!required && (value === undefined || value === null)) return '';
  if (typeof value !== 'string') throw new ValidateException(`请填写${label}`);
  const text = value.trim();
  if (required && !text) throw new ValidateException(`请填写${label}`);
  if ([...text].length > 255 || /[\u0000\ud800-\udfff]/u.test(text)) throw new ValidateException(`${label}长度或字符错误`);
  return text;
}

function ensureInteger(value: unknown, label: string, fallback = 0): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 0 || n > 2147483647) throw new ValidateException(`${label}必须是非负整数`);
  return n;
}

function ensureId(id: number, create = false): void {
  if (!Number.isSafeInteger(id) || id < (create ? 0 : 1) || id > 2147483647) throw new ValidateException('保障服务ID错误');
}

function sameEnsureRow(actual: object, expected: object): boolean {
  const a = actual as Record<string, unknown>, e = expected as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(e).length && Object.keys(e).every(key => a[key] === e[key]);
}

function echoEnsureInteger(value: unknown, expected: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value === expected
    || typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) && Number(value) === expected;
}

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
    if (name) conditions.push(or(ilike(storeProductEnsure.name, `%${name}%`),
      sql`${storeProductEnsure.id}::text ILIKE ${`%${name}%`}`)!);
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
      .orderBy(desc(storeProductEnsure.sort), asc(storeProductEnsure.id)).limit(MAX_ENSURE_READ_ROWS + 1);
    if (rows.length > MAX_ENSURE_READ_ROWS) throw new ServiceUnavailableException('保障服务超过2000项，请缩小范围');
    return rows.map((item) => this.formatEnsure(item));
  }

  async ensureDetail(owner: ProductEnsureOwner, id: number) {
    ensureId(id);
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

  async saveEnsure(owner: ProductEnsureOwner, id: number, input: unknown, legacy = false) {
    ensureId(id, true);
    const body = record(input);
    if (Object.keys(body).some(key => !['id', 'type', 'relation_id', 'name', 'image', 'desc', 'sort',
      'status', 'add_time', 'product_count'].includes(key))) throw new ValidateException('保障服务包含未知字段');
    const name = ensureString(body.name, "保障服务条款");
    const image = ensureString(body.image, "保障服务图标");
    const descValue = ensureString(body.desc, "保障服务描述", !legacy);
    const sort = ensureInteger(body.sort, "排序");
    return withTx(this.container, async (tx) => {
      await lockEnsureLifecycle(tx, owner);
      let original: typeof storeProductEnsure.$inferSelect | undefined;
      if (id > 0) {
        const existing = await tx
          .select()
          .from(storeProductEnsure)
          .where(and(eq(storeProductEnsure.id, id), ownerScope(owner)))
          .limit(1)
          .for("update");
        if (!existing[0]) throw new NotFoundException("商品保障服务不存在");
        original = existing[0];
      }
      for (const [key, expected] of [['id', id], ['type', owner.type], ['relation_id', owner.relationId]] as const) {
        if (Object.hasOwn(body, key) && !echoEnsureInteger(body[key], expected)) throw new ValidateException('保障服务回显身份或归属已变化');
      }
      const originalTime = original?.addTime ?? 0;
      if (Object.hasOwn(body, 'add_time') && !(echoEnsureInteger(body.add_time, originalTime)
        || body.add_time === formatParameterSpecTime(originalTime))) throw new ValidateException('保障服务创建时间不能修改');
      if (legacy && Object.hasOwn(body, 'status') && !echoEnsureInteger(body.status, original?.status ?? 1)) {
        throw new ValidateException('旧编辑表单不能修改保障服务状态');
      }
      if (Object.hasOwn(body, 'product_count')) {
        const [count] = id ? await tx.select({ count: sql<number>`COUNT(*)::int` }).from(storeProduct)
          .where(sql`position(${`,` + id + `,`} in (',' || coalesce(${storeProduct.ensureId}, '') || ',')) > 0`) : [{ count: 0 }];
        if (!echoEnsureInteger(body.product_count, count?.count ?? 0)) throw new ValidateException('保障服务使用数量回显已变化');
      }
      const status = legacy ? original?.status ?? 1 : ensureInteger(body.status, '状态', original?.status ?? 1);
      if (status !== 0 && status !== 1) throw new ValidateException("状态只能是0或1");
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
        const rows = await tx
          .update(storeProductEnsure)
          .set({ name, image, desc: descValue, sort, status })
          .where(and(eq(storeProductEnsure.id, id), ownerScope(owner))).returning();
        const expected = { ...original!, name, image, desc: descValue, sort, status };
        if (rows.length !== 1 || !sameEnsureRow(rows[0], expected)) throw Error('保障服务更新回执不完整');
        const [after] = await tx.select().from(storeProductEnsure).where(eq(storeProductEnsure.id, id)).limit(1);
        if (!after || !sameEnsureRow(after, expected)) throw Error('保障服务保存后核验失败');
        return { id };
      }
      const now = Math.floor(Date.now() / 1000);
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
          addTime: now,
        })
        .returning();
      const saved = inserted[0];
      if (inserted.length !== 1 || !saved || !Number.isSafeInteger(saved.id) || saved.id <= 0) throw Error('保障服务创建回执不完整');
      const expected = { id: saved.id, type: owner.type, relationId: owner.relationId, name, image, desc: descValue, sort, status, addTime: now };
      const [after] = await tx.select().from(storeProductEnsure).where(eq(storeProductEnsure.id, saved.id)).limit(1);
      if (!sameEnsureRow(saved, expected) || !after || !sameEnsureRow(after, expected)) throw Error('保障服务创建后核验失败');
      return { id: saved.id };
    });
  }

  async setEnsureStatus(owner: ProductEnsureOwner, id: number, status: number) {
    ensureId(id);
    if (status !== 0 && status !== 1) throw new ValidateException("状态只能是0或1");
    return withTx(this.container, async tx => {
      await lockEnsureLifecycle(tx, owner);
      const [original] = await tx.select().from(storeProductEnsure)
        .where(and(eq(storeProductEnsure.id, id), ownerScope(owner))).limit(1).for('update');
      if (!original) throw new NotFoundException("商品保障服务不存在");
      const expected = { ...original, status };
      const updated = await tx.update(storeProductEnsure).set({ status })
        .where(and(eq(storeProductEnsure.id, id), ownerScope(owner))).returning();
      const [after] = await tx.select().from(storeProductEnsure).where(eq(storeProductEnsure.id, id)).limit(1);
      if (updated.length !== 1 || !sameEnsureRow(updated[0], expected) || !after || !sameEnsureRow(after, expected)) {
        throw Error('保障服务状态回执不完整');
      }
    });
  }

  async deleteEnsure(owner: ProductEnsureOwner, id: number) {
    ensureId(id);
    return withTx(this.container, async (tx) => {
      await lockEnsureLifecycle(tx, owner);
      const existing = await tx
        .select()
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
      const deleted = await tx.delete(storeProductEnsure).where(and(eq(storeProductEnsure.id, id), ownerScope(owner))).returning();
      if (deleted.length !== 1 || !sameEnsureRow(deleted[0], existing[0])) throw Error('保障服务删除回执不完整');
      const remaining = await tx.select({ id: storeProductEnsure.id }).from(storeProductEnsure)
        .where(eq(storeProductEnsure.id, id)).limit(1);
      if (remaining.length) throw Error('保障服务删除后核验失败');
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
