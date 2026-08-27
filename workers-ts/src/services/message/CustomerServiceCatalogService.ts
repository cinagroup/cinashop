import {
  and,
  asc,
  desc,
  eq,
  ilike,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Container } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  legacyCategory,
  storeServiceFeedback,
  storeServiceSpeechcraft,
} from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";

const SPEECHCRAFT_LOCK_NAMESPACE = 731_616;
const MAX_PAGE_SIZE = 100;

function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("请求数据格式错误");
  }
  return value as Record<string, unknown>;
}

function inputText(
  value: unknown,
  label: string,
  maximum: number,
  required = true,
): string {
  if (typeof value !== "string") {
    if (!required && (value === undefined || value === null)) return "";
    throw new ValidateException(`请填写${label}`);
  }
  const result = value.trim();
  if (required && !result) throw new ValidateException(`请填写${label}`);
  if (result.length > maximum) throw new ValidateException(`${label}不能超过${maximum}个字符`);
  return result;
}

function nonNegativeInteger(value: unknown, label: string, fallback = 0): number {
  if (value === undefined || value === null || value === "") return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > 2_147_483_647) {
    throw new ValidateException(`${label}必须是非负整数`);
  }
  return result;
}

function pageValues(query: Record<string, string>) {
  const page = Math.max(1, nonNegativeInteger(query.page, "页码", 1));
  const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, nonNegativeInteger(query.limit, "每页数量", 20)));
  return { page, limit };
}

export function escapeCustomerServiceFeedback(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] ?? character);
}

export class CustomerServiceCatalogService {
  constructor(private readonly container: Container) {}

  async submitFeedback(uid: number, input: unknown) {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("用户ID错误");
    const body = inputRecord(input);
    const relaName = inputText(body.rela_name, "真实姓名", 255);
    const phone = inputText(body.phone, "手机号", 30);
    if (!/^1[3-9]\d{9}$/.test(phone)) throw new ValidateException("手机号格式错误");
    const content = escapeCustomerServiceFeedback(inputText(body.content, "反馈内容", 500));
    if (content.length > 500) {
      throw new ValidateException("反馈内容包含特殊字符，转义后不能超过500个字符");
    }
    const rows = await this.container.db
      .insert(storeServiceFeedback)
      .values({
        uid,
        relaName,
        phone,
        content,
        addTime: Math.floor(Date.now() / 1000),
      })
      .returning({ id: storeServiceFeedback.id });
    return { id: rows[0].id };
  }

  async feedbackList(query: Record<string, string>) {
    const { page, limit } = pageValues(query);
    const conditions: SQL[] = [];
    const title = query.title?.trim();
    if (title) {
      const pattern = `%${title}%`;
      conditions.push(sql`(
        ${storeServiceFeedback.relaName} ILIKE ${pattern}
        OR ${storeServiceFeedback.phone} ILIKE ${pattern}
        OR ${storeServiceFeedback.content} ILIKE ${pattern}
        OR CAST(${storeServiceFeedback.uid} AS TEXT) ILIKE ${pattern}
      )`);
    }
    if (query.status !== undefined && query.status !== "") {
      const status = nonNegativeInteger(query.status, "状态");
      if (status !== 0 && status !== 1) throw new ValidateException("状态只能是0或1");
      conditions.push(eq(storeServiceFeedback.status, status));
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const [rows, countRows] = await Promise.all([
      this.container.db
        .select()
        .from(storeServiceFeedback)
        .where(where)
        .orderBy(desc(storeServiceFeedback.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storeServiceFeedback)
        .where(where),
    ]);
    return {
      data: rows.map((row) => this.formatFeedback(row)),
      count: countRows[0]?.count ?? 0,
      page,
      limit,
    };
  }

  async feedbackDetail(id: number) {
    const row = (
      await this.container.db
        .select()
        .from(storeServiceFeedback)
        .where(eq(storeServiceFeedback.id, id))
        .limit(1)
    )[0];
    if (!row) throw new NotFoundException("反馈内容不存在");
    return this.formatFeedback(row);
  }

  async updateFeedback(id: number, input: unknown) {
    const body = inputRecord(input);
    const changes: { make?: string; status?: number } = {};
    if (body.make !== undefined) changes.make = inputText(body.make, "备注", 255, false);
    if (body.status !== undefined) {
      const status = nonNegativeInteger(body.status, "状态");
      if (status !== 0 && status !== 1) throw new ValidateException("状态只能是0或1");
      changes.status = status;
    }
    if (!Object.keys(changes).length) throw new ValidateException("没有可修改的字段");
    const updated = await this.container.db
      .update(storeServiceFeedback)
      .set(changes)
      .where(eq(storeServiceFeedback.id, id))
      .returning({ id: storeServiceFeedback.id });
    if (!updated[0]) throw new NotFoundException("反馈内容不存在");
  }

  async deleteFeedback(id: number) {
    const deleted = await this.container.db
      .delete(storeServiceFeedback)
      .where(eq(storeServiceFeedback.id, id))
      .returning({ id: storeServiceFeedback.id });
    if (!deleted[0]) throw new NotFoundException("反馈内容不存在");
  }

  async speechcraftList(kefuId: number, query: Record<string, string>) {
    const { page, limit } = pageValues(query);
    const conditions: SQL[] = [eq(storeServiceSpeechcraft.kefuId, kefuId)];
    const title = query.title?.trim();
    if (title) conditions.push(ilike(storeServiceSpeechcraft.title, `%${title}%`));
    const message = query.message?.trim();
    if (message) conditions.push(eq(storeServiceSpeechcraft.message, message));
    if (query.cate_id !== undefined && query.cate_id !== "") {
      conditions.push(eq(storeServiceSpeechcraft.cateId, nonNegativeInteger(query.cate_id, "分类ID")));
    }
    const where = and(...conditions);
    const [list, countRows] = await Promise.all([
      this.container.db
        .select()
        .from(storeServiceSpeechcraft)
        .where(where)
        .orderBy(desc(storeServiceSpeechcraft.sort), asc(storeServiceSpeechcraft.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storeServiceSpeechcraft)
        .where(where),
    ]);
    return { list: list.map((row) => this.formatSpeechcraft(row)), count: countRows[0]?.count ?? 0, page, limit };
  }

  async speechcraftDetail(kefuId: number, id: number) {
    const row = (
      await this.container.db
        .select()
        .from(storeServiceSpeechcraft)
        .where(and(eq(storeServiceSpeechcraft.id, id), eq(storeServiceSpeechcraft.kefuId, kefuId)))
        .limit(1)
    )[0];
    if (!row) throw new NotFoundException("话术不存在");
    return this.formatSpeechcraft(row);
  }

  async saveSpeechcraft(kefuId: number, id: number, input: unknown) {
    if (!Number.isSafeInteger(kefuId) || kefuId < 0) throw new ValidateException("客服ID错误");
    const body = inputRecord(input);
    const title = inputText(body.title, "话术标题", 100, false);
    const message = inputText(body.message, "话术内容", 255);
    const cateId = nonNegativeInteger(body.cate_id, "分类ID");
    const sort = nonNegativeInteger(body.sort, "排序");
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SPEECHCRAFT_LOCK_NAMESPACE}, ${kefuId})`);
      if (id > 0) {
        const existing = await tx
          .select({ id: storeServiceSpeechcraft.id })
          .from(storeServiceSpeechcraft)
          .where(and(eq(storeServiceSpeechcraft.id, id), eq(storeServiceSpeechcraft.kefuId, kefuId)))
          .limit(1)
          .for("update");
        if (!existing[0]) throw new NotFoundException("话术不存在");
      }
      if (cateId > 0) {
        const category = await tx
          .select({ id: legacyCategory.id })
          .from(legacyCategory)
          .where(and(
            eq(legacyCategory.id, cateId),
            eq(legacyCategory.ownerId, kefuId),
            eq(legacyCategory.type, 0),
            eq(legacyCategory.group, 1),
          ))
          .limit(1);
        if (!category[0]) throw new ValidateException("话术分类不存在");
      }
      const duplicate = await tx
        .select({ id: storeServiceSpeechcraft.id })
        .from(storeServiceSpeechcraft)
        .where(and(
          eq(storeServiceSpeechcraft.kefuId, kefuId),
          eq(storeServiceSpeechcraft.message, message),
          id > 0 ? sql`${storeServiceSpeechcraft.id} <> ${id}` : sql`TRUE`,
        ))
        .limit(1);
      if (duplicate[0]) throw new ValidateException("话术不能重复添加");
      if (id > 0) {
        await tx
          .update(storeServiceSpeechcraft)
          .set({ title, message, cateId, sort })
          .where(eq(storeServiceSpeechcraft.id, id));
        return { id };
      }
      const inserted = await tx
        .insert(storeServiceSpeechcraft)
        .values({ kefuId, cateId, title, message, sort, addTime: Math.floor(Date.now() / 1000) })
        .returning({ id: storeServiceSpeechcraft.id });
      return { id: inserted[0].id };
    });
  }

  async deleteSpeechcraft(kefuId: number, id: number) {
    const deleted = await this.container.db
      .delete(storeServiceSpeechcraft)
      .where(and(eq(storeServiceSpeechcraft.id, id), eq(storeServiceSpeechcraft.kefuId, kefuId)))
      .returning({ id: storeServiceSpeechcraft.id });
    if (!deleted[0]) throw new NotFoundException("话术不存在");
  }

  async speechcraftCategories(kefuId: number) {
    const rows = await this.container.db
      .select({ id: legacyCategory.id, name: legacyCategory.name, sort: legacyCategory.sort })
      .from(legacyCategory)
      .where(and(
        eq(legacyCategory.ownerId, kefuId),
        eq(legacyCategory.type, 0),
        eq(legacyCategory.group, 1),
      ))
      .orderBy(desc(legacyCategory.sort), asc(legacyCategory.id));
    return rows;
  }

  async saveSpeechcraftCategory(kefuId: number, id: number, input: unknown) {
    if (!Number.isSafeInteger(kefuId) || kefuId <= 0) {
      throw new ValidateException("客服ID错误");
    }
    if (!Number.isSafeInteger(id) || id < 0) throw new ValidateException("分类ID错误");
    const body = inputRecord(input);
    const name = inputText(body.name, "分类名称", 255);
    const sort = nonNegativeInteger(body.sort, "排序");
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SPEECHCRAFT_LOCK_NAMESPACE}, ${kefuId})`);
      if (id > 0) {
        const existing = await tx
          .select({ id: legacyCategory.id })
          .from(legacyCategory)
          .where(and(
            eq(legacyCategory.id, id),
            eq(legacyCategory.ownerId, kefuId),
            eq(legacyCategory.type, 0),
            eq(legacyCategory.group, 1),
          ))
          .limit(1)
          .for("update");
        if (!existing[0]) throw new NotFoundException("话术分类不存在");
      }
      const duplicate = await tx
        .select({ id: legacyCategory.id })
        .from(legacyCategory)
        .where(and(
          eq(legacyCategory.ownerId, kefuId),
          eq(legacyCategory.type, 0),
          eq(legacyCategory.group, 1),
          eq(legacyCategory.name, name),
          id > 0 ? ne(legacyCategory.id, id) : sql`TRUE`,
        ))
        .limit(1);
      if (duplicate[0]) throw new ValidateException("话术分类不能重复添加");
      if (id > 0) {
        await tx
          .update(legacyCategory)
          .set({ name, sort })
          .where(eq(legacyCategory.id, id));
        return { id };
      }
      const inserted = await tx
        .insert(legacyCategory)
        .values({
          ownerId: kefuId,
          type: 0,
          group: 1,
          relationId: 0,
          name,
          sort,
          addTime: Math.floor(Date.now() / 1000),
        })
        .returning({ id: legacyCategory.id });
      return { id: inserted[0].id };
    });
  }

  async deleteSpeechcraftCategory(kefuId: number, id: number) {
    if (!Number.isSafeInteger(kefuId) || kefuId <= 0) {
      throw new ValidateException("客服ID错误");
    }
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("分类ID错误");
    return withTx(this.container, async (tx) => {
      const category = await tx
        .select({ id: legacyCategory.id })
        .from(legacyCategory)
        .where(and(
          eq(legacyCategory.id, id),
          eq(legacyCategory.ownerId, kefuId),
          eq(legacyCategory.type, 0),
          eq(legacyCategory.group, 1),
        ))
        .limit(1)
        .for("update");
      if (!category[0]) throw new NotFoundException("话术分类不存在");
      const used = await tx
        .select({ id: storeServiceSpeechcraft.id })
        .from(storeServiceSpeechcraft)
        .where(and(
          eq(storeServiceSpeechcraft.kefuId, kefuId),
          eq(storeServiceSpeechcraft.cateId, id),
        ))
        .limit(1);
      if (used[0]) throw new ValidateException("该分类仍有话术，不能删除");
      await tx.delete(legacyCategory).where(eq(legacyCategory.id, id));
    });
  }

  private formatFeedback(row: typeof storeServiceFeedback.$inferSelect) {
    return {
      id: row.id,
      uid: row.uid,
      rela_name: row.relaName,
      phone: row.phone,
      content: row.content,
      make: row.make,
      status: row.status,
      add_time: row.addTime,
    };
  }

  private formatSpeechcraft(row: typeof storeServiceSpeechcraft.$inferSelect) {
    return {
      id: row.id,
      kefu_id: row.kefuId,
      cate_id: row.cateId,
      title: row.title,
      message: row.message,
      sort: row.sort,
      add_time: row.addTime,
    };
  }
}
