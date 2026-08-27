import {
  and,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { withTx, type Container } from "@/lib/di";
import {
  agreement,
  memberCard,
  memberCardBatch,
  memberRight,
  memberShip,
  otherOrder,
  user as userTable,
} from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";

const MEMBERSHIP_TYPES = new Set(["free", "month", "quarter", "year", "ever"]);
const CARD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_BATCH_SIZE = 6_000;
const CARD_INSERT_CHUNK = 500;

function pick(input: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (input[key] !== undefined) return input[key];
  return undefined;
}

function integer(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; fallback?: number } = {},
): number {
  if ((value === undefined || value === "") && options.fallback !== undefined) {
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

function positiveId(value: unknown, label = "ID"): number {
  return integer(value, label, { min: 1 });
}

function boundedString(
  value: unknown,
  label: string,
  max: number,
  required = false,
): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw new ValidateException(`请填写${label}`);
  if (text.length > max) throw new ValidateException(`${label}不能超过${max}个字符`);
  return text;
}

function decimal(value: unknown, label: string): string {
  const text = String(value ?? "0").trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) {
    throw new ValidateException(`${label}格式错误`);
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed >= 10_000_000_000) {
    throw new ValidateException(`${label}超出支持范围`);
  }
  return parsed.toFixed(2);
}

function positivePage(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function randomToken(length: number): string {
  let result = "";
  const ceiling = 256 - (256 % CARD_ALPHABET.length);
  while (result.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(Math.max(16, length - result.length)));
    for (const byte of bytes) {
      if (byte >= ceiling) continue;
      result += CARD_ALPHABET[byte % CARD_ALPHABET.length];
      if (result.length === length) break;
    }
  }
  return result;
}

function base36(value: number, width: number, label: string): string {
  const token = value.toString(36).toUpperCase();
  if (token.length > width) throw new ValidateException(`${label}超出制卡范围`);
  return token.padStart(width, "0");
}

export interface IssuedCardSecret {
  card_number: string;
  card_password: string;
}

export function buildIssuedCards(batchId: number, total: number): IssuedCardSecret[] {
  positiveId(batchId, "批次 ID");
  integer(total, "卡片数量", { min: 1, max: MAX_BATCH_SIZE });
  const batchToken = base36(batchId, 8, "批次 ID");
  return Array.from({ length: total }, (_, index) => ({
    card_number: `MC${batchToken}${base36(index + 1, 6, "卡片序号")}${randomToken(4)}`,
    card_password: randomToken(12),
  }));
}

export interface NormalizedMembershipBatch {
  title: string;
  totalNum: number;
  useDay: number;
  status: number;
  sort: number;
  remark: string;
}

export function normalizeMembershipBatch(
  input: Record<string, unknown>,
  editing = false,
): NormalizedMembershipBatch {
  return {
    title: boundedString(pick(input, "title"), "批次名称", 100, true),
    totalNum: editing
      ? 0
      : integer(pick(input, "total_num", "totalNum"), "卡片数量", {
          min: 1,
          max: MAX_BATCH_SIZE,
        }),
    useDay: integer(pick(input, "use_day", "useDay"), "会员有效天数", {
      min: 1,
      max: 36_500,
    }),
    status: integer(pick(input, "status"), "批次状态", { min: 0, max: 1, fallback: 0 }),
    sort: integer(pick(input, "sort"), "排序", {
      min: -2_147_483_648,
      max: 2_147_483_647,
      fallback: 0,
    }),
    remark: boundedString(pick(input, "remark"), "备注", 512),
  };
}

export interface NormalizedMembershipPlan {
  type: string;
  title: string;
  vipDay: number;
  price: string;
  prePrice: string;
  isLabel: number;
  sort: number;
}

export function normalizeMembershipPlan(
  input: Record<string, unknown>,
): NormalizedMembershipPlan {
  const type = boundedString(pick(input, "type"), "会员类型", 20, true).toLowerCase();
  if (!MEMBERSHIP_TYPES.has(type)) throw new ValidateException("会员类型不支持");
  let vipDay = integer(pick(input, "vip_day", "vipDay"), "会员有效天数", {
    min: type === "ever" ? -1 : 1,
    max: 36_500,
    fallback: type === "ever" ? -1 : undefined,
  });
  // Preserve the PHP contract: price is the struck-through list price and
  // pre_price is the discounted amount actually charged at checkout.
  let price = decimal(pick(input, "price"), "划线原价");
  let prePrice = decimal(pick(input, "pre_price", "prePrice"), "优惠价");
  if (type === "ever") vipDay = -1;
  if (type === "free") {
    price = "0.00";
    prePrice = "0.00";
  } else if (Number(price) <= 0 || Number(prePrice) <= 0) {
    throw new ValidateException("付费会员套餐价格必须大于0");
  } else if (Number(prePrice) > Number(price)) {
    throw new ValidateException("会员优惠价不能高于划线原价");
  }
  return {
    type,
    title: boundedString(pick(input, "title"), "会员名称", 200, true),
    vipDay,
    price,
    prePrice,
    isLabel: integer(pick(input, "is_label", "isLabel"), "推荐标记", {
      min: 0,
      max: 1,
      fallback: 0,
    }),
    sort: integer(pick(input, "sort"), "排序", {
      min: -2_147_483_648,
      max: 2_147_483_647,
      fallback: 0,
    }),
  };
}

export interface NormalizedMembershipRight {
  rightType: string;
  title: string;
  showTitle: string;
  image: string;
  explain: string;
  content?: string;
  number: number;
  sort: number;
  status: number;
}

export function normalizeMembershipRight(
  input: Record<string, unknown>,
): NormalizedMembershipRight {
  const normalized: NormalizedMembershipRight = {
    rightType: boundedString(pick(input, "right_type", "rightType"), "权益类型", 100, true),
    title: boundedString(pick(input, "title"), "权益内部名称", 200, true),
    showTitle: boundedString(pick(input, "show_title", "showTitle"), "权益展示名称", 255, true),
    image: boundedString(pick(input, "image"), "权益图片", 200),
    explain: boundedString(pick(input, "explain"), "权益说明", 1_024),
    number: integer(pick(input, "number"), "权益数值", { min: 0, max: 2_147_483_647, fallback: 1 }),
    sort: integer(pick(input, "sort"), "排序", {
      min: -2_147_483_648,
      max: 2_147_483_647,
      fallback: 0,
    }),
    status: integer(pick(input, "status"), "权益状态", { min: 0, max: 1, fallback: 1 }),
  };
  if (pick(input, "content") !== undefined) {
    normalized.content = boundedString(pick(input, "content"), "权益内容", 200_000);
  }
  return normalized;
}

function maskCardNumber(value: string): string {
  if (value.length <= 8) return `${value.slice(0, 2)}****${value.slice(-2)}`;
  return `${value.slice(0, 4)}********${value.slice(-4)}`;
}

function epochRange(query: Record<string, unknown>): [number, number] | null {
  const raw = pick(query, "add_time", "time");
  let start = pick(query, "start_time", "startTime");
  let end = pick(query, "end_time", "endTime");
  if (Array.isArray(raw)) [start, end] = raw;
  if (typeof raw === "string" && raw.includes(",")) [start, end] = raw.split(",", 2);
  if (start === undefined && end === undefined) return null;
  const parse = (value: unknown, endOfDay: boolean): number => {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric) && numeric > 0) return numeric;
    if (typeof value === "string") {
      const suffix = endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? "T23:59:59+08:00" : "T00:00:00+08:00";
      const millis = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? `${value.trim()}${suffix}` : value);
      if (Number.isFinite(millis) && millis > 0) return Math.floor(millis / 1_000);
    }
    throw new ValidateException("时间范围格式错误");
  };
  const from = parse(start, false);
  const to = parse(end, true);
  if (to < from) throw new ValidateException("结束时间不能早于开始时间");
  return [from, to];
}

export class AdminPaidMembershipService {
  constructor(private readonly container: Container) {}

  async batches(query: Record<string, unknown>) {
    const page = positivePage(query.page, 1);
    const limit = Math.min(100, positivePage(query.limit, 20));
    const conditions: SQL[] = [];
    const title = typeof query.title === "string" ? query.title.trim() : "";
    if (title) conditions.push(ilike(memberCardBatch.title, `%${title}%`));
    const where = conditions.length ? and(...conditions) : undefined;
    const [rows, totals] = await Promise.all([
      this.container.db
        .select()
        .from(memberCardBatch)
        .where(where)
        .orderBy(desc(memberCardBatch.sort), desc(memberCardBatch.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(memberCardBatch)
        .where(where),
    ]);
    const ids = rows.map((row) => row.id);
    const stats = ids.length
      ? await this.container.db
          .select({
            batchId: memberCard.cardBatchId,
            cardCount: sql<number>`COUNT(*)::int`,
            usedCount: sql<number>`COUNT(*) FILTER (WHERE ${memberCard.useTime} > 0)::int`,
          })
          .from(memberCard)
          .where(inArray(memberCard.cardBatchId, ids))
          .groupBy(memberCard.cardBatchId)
      : [];
    const statByBatch = new Map(stats.map((row) => [row.batchId, row]));
    return {
      list: rows.map((row) => {
        const stat = statByBatch.get(row.id);
        const actualCardCount = stat?.cardCount ?? 0;
        const actualUsedCount = stat?.usedCount ?? 0;
        return {
          id: row.id,
          title: row.title,
          total_num: row.totalNum,
          use_day: row.useDay,
          use_num: row.useNum,
          status: row.status,
          sort: row.sort,
          remark: row.remark,
          add_time: row.addTime,
          update_time: row.updateTime,
          actual_card_count: actualCardCount,
          actual_used_count: actualUsedCount,
          counter_drift: row.totalNum !== actualCardCount || row.useNum !== actualUsedCount,
        };
      }),
      count: totals[0]?.count ?? 0,
    };
  }

  async saveBatch(idValue: unknown, input: Record<string, unknown>) {
    const id = Number(idValue ?? 0);
    const editing = Number.isSafeInteger(id) && id > 0;
    const normalized = normalizeMembershipBatch(input, editing);
    const now = Math.floor(Date.now() / 1_000);
    if (editing) {
      return withTx(this.container, async (tx) => {
        const existing = await tx
          .select()
          .from(memberCardBatch)
          .where(eq(memberCardBatch.id, id))
          .limit(1)
          .for("update");
        if (!existing[0]) throw new NotFoundException("会员卡批次不存在");
        await tx
          .update(memberCardBatch)
          .set({
            title: normalized.title,
            useDay: normalized.useDay,
            status: normalized.status,
            sort: normalized.sort,
            remark: normalized.remark,
            updateTime: now,
          })
          .where(eq(memberCardBatch.id, id));
        if (existing[0].status !== normalized.status) {
          await tx
            .update(memberCard)
            .set({ status: normalized.status, updateTime: now })
            .where(eq(memberCard.cardBatchId, id));
        }
        return { id, issued_count: 0, cards: [] as IssuedCardSecret[] };
      });
    }

    return withTx(this.container, async (tx) => {
      const inserted = await tx
        .insert(memberCardBatch)
        .values({
          title: normalized.title,
          totalNum: normalized.totalNum,
          useDay: normalized.useDay,
          useNum: 0,
          status: normalized.status,
          sort: normalized.sort,
          remark: normalized.remark,
          addTime: now,
          updateTime: now,
        })
        .returning({ id: memberCardBatch.id });
      const batch = inserted[0];
      if (!batch) throw new Error("会员卡批次创建失败");
      const cards = buildIssuedCards(batch.id, normalized.totalNum);
      for (let offset = 0; offset < cards.length; offset += CARD_INSERT_CHUNK) {
        const chunk = cards.slice(offset, offset + CARD_INSERT_CHUNK);
        await tx.insert(memberCard).values(
          chunk.map((card) => ({
            cardBatchId: batch.id,
            cardNumber: card.card_number,
            cardPassword: card.card_password,
            useUid: 0,
            useTime: 0,
            status: normalized.status,
            addTime: now,
            updateTime: now,
          })),
        );
      }
      return { id: batch.id, issued_count: cards.length, cards };
    });
  }

  async setBatchValue(idValue: unknown, input: Record<string, unknown>) {
    const id = positiveId(idValue, "批次 ID");
    const field = boundedString(pick(input, "field"), "字段", 32, true);
    if (!new Set(["status", "sort", "title", "remark"]).has(field)) {
      throw new ValidateException("不允许修改该批次字段");
    }
    const now = Math.floor(Date.now() / 1_000);
    return withTx(this.container, async (tx) => {
      const rows = await tx
        .select({ id: memberCardBatch.id })
        .from(memberCardBatch)
        .where(eq(memberCardBatch.id, id))
        .limit(1)
        .for("update");
      if (!rows[0]) throw new NotFoundException("会员卡批次不存在");
      const value = pick(input, "value");
      const update: Partial<typeof memberCardBatch.$inferInsert> = { updateTime: now };
      if (field === "status") update.status = integer(value, "批次状态", { min: 0, max: 1 });
      if (field === "sort") update.sort = integer(value, "排序", { min: -2_147_483_648, max: 2_147_483_647 });
      if (field === "title") update.title = boundedString(value, "批次名称", 100, true);
      if (field === "remark") update.remark = boundedString(value, "备注", 512);
      await tx.update(memberCardBatch).set(update).where(eq(memberCardBatch.id, id));
      if (field === "status") {
        await tx
          .update(memberCard)
          .set({ status: update.status, updateTime: now })
          .where(eq(memberCard.cardBatchId, id));
      }
      return { id };
    });
  }

  async cards(batchIdValue: unknown, query: Record<string, unknown>) {
    const batchId = positiveId(batchIdValue, "批次 ID");
    const page = positivePage(query.page, 1);
    const limit = Math.min(100, positivePage(query.limit, 20));
    const conditions: SQL[] = [eq(memberCard.cardBatchId, batchId)];
    const cardNumber = typeof query.card_number === "string" ? query.card_number.trim() : "";
    if (cardNumber) conditions.push(ilike(memberCard.cardNumber, `%${cardNumber}%`));
    const statusValue = pick(query, "is_status", "status");
    if (statusValue !== undefined && statusValue !== "") {
      conditions.push(eq(memberCard.status, integer(statusValue, "卡片状态", { min: 0, max: 1 })));
    }
    const useValue = pick(query, "is_use", "isUse");
    if (useValue !== undefined && useValue !== "") {
      const used = integer(useValue, "使用状态", { min: 0, max: 1 });
      conditions.push(used ? gt(memberCard.useTime, 0) : eq(memberCard.useTime, 0));
    }
    const userKeyword = typeof query.phone === "string" ? query.phone.trim() : "";
    if (userKeyword) {
      conditions.push(
        or(
          ilike(userTable.phone, `%${userKeyword}%`),
          ilike(userTable.nickname, `%${userKeyword}%`),
          ilike(userTable.realName, `%${userKeyword}%`),
        )!,
      );
    }
    const where = and(...conditions);
    const base = this.container.db
      .select({
        id: memberCard.id,
        cardBatchId: memberCard.cardBatchId,
        cardNumber: memberCard.cardNumber,
        useUid: memberCard.useUid,
        useTime: memberCard.useTime,
        status: memberCard.status,
        addTime: memberCard.addTime,
        updateTime: memberCard.updateTime,
        nickname: userTable.nickname,
        realName: userTable.realName,
        phone: userTable.phone,
      })
      .from(memberCard)
      .leftJoin(userTable, eq(userTable.uid, memberCard.useUid))
      .where(where);
    const [rows, totals] = await Promise.all([
      base.orderBy(desc(memberCard.useTime), desc(memberCard.id)).limit(limit).offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(memberCard)
        .leftJoin(userTable, eq(userTable.uid, memberCard.useUid))
        .where(where),
    ]);
    return {
      list: rows.map((row) => ({
        id: row.id,
        card_batch_id: row.cardBatchId,
        card_number: row.cardNumber,
        password_configured: true,
        use_uid: row.useUid,
        use_time: row.useTime,
        status: row.status,
        add_time: row.addTime,
        update_time: row.updateTime,
        username: row.realName || row.nickname || "",
        phone: row.phone ?? "",
      })),
      count: totals[0]?.count ?? 0,
    };
  }

  async setCardStatus(input: Record<string, unknown>) {
    const cardId = positiveId(pick(input, "card_id", "cardId"), "会员卡 ID");
    const batchRaw = pick(input, "card_batch_id", "cardBatchId");
    const batchId = batchRaw === undefined || batchRaw === "" ? null : positiveId(batchRaw, "批次 ID");
    const status = integer(pick(input, "status"), "卡片状态", { min: 0, max: 1 });
    const now = Math.floor(Date.now() / 1_000);
    return withTx(this.container, async (tx) => {
      const rows = await tx
        .select({ id: memberCard.id, batchId: memberCard.cardBatchId })
        .from(memberCard)
        .where(batchId === null
          ? eq(memberCard.id, cardId)
          : and(eq(memberCard.id, cardId), eq(memberCard.cardBatchId, batchId)))
        .limit(2)
        .for("update");
      if (!rows.length) throw new NotFoundException("会员卡不存在");
      if (rows.length !== 1) throw new ValidateException("会员卡 ID 存在歧义，请同时提供批次 ID");
      const card = rows[0];
      await tx
        .update(memberCard)
        .set({ status, updateTime: now })
        .where(and(eq(memberCard.id, card.id), eq(memberCard.cardBatchId, card.batchId)));
      return { id: card.id, card_batch_id: card.batchId };
    });
  }

  async plans(query: Record<string, unknown> = {}) {
    const page = positivePage(query.page, 1);
    const limit = Math.min(100, positivePage(query.limit, 50));
    const includeDeleted = String(pick(query, "include_deleted", "includeDeleted") ?? "0") === "1";
    const where = includeDeleted ? undefined : eq(memberShip.isDel, 0);
    const [rows, totals] = await Promise.all([
      this.container.db
        .select()
        .from(memberShip)
        .where(where)
        .orderBy(desc(memberShip.sort), memberShip.id)
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` }).from(memberShip).where(where),
    ]);
    return {
      list: rows.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        vip_day: row.vipDay,
        price: row.price,
        pre_price: row.prePrice,
        is_label: row.isLabel,
        sort: row.sort,
        is_del: row.isDel,
        add_time: row.addTime,
      })),
      count: totals[0]?.count ?? 0,
    };
  }

  async savePlan(idValue: unknown, input: Record<string, unknown>) {
    const id = Number(idValue ?? 0);
    const editing = Number.isSafeInteger(id) && id > 0;
    const normalized = normalizeMembershipPlan(input);
    const now = Math.floor(Date.now() / 1_000);
    if (!editing) {
      const rows = await this.container.db
        .insert(memberShip)
        .values({ ...normalized, isDel: 0, addTime: now })
        .returning({ id: memberShip.id });
      return { id: rows[0]?.id ?? 0 };
    }
    return withTx(this.container, async (tx) => {
      const rows = await tx
        .select({ id: memberShip.id, type: memberShip.type })
        .from(memberShip)
        .where(eq(memberShip.id, id))
        .limit(1)
        .for("update");
      const plan = rows[0];
      if (!plan) throw new NotFoundException("会员套餐不存在");
      if (plan.type !== normalized.type) {
        throw new ValidateException("已有套餐不能修改类型；请停用后新建套餐");
      }
      await tx
        .update(memberShip)
        .set({
          title: normalized.title,
          vipDay: normalized.vipDay,
          price: normalized.price,
          prePrice: normalized.prePrice,
          isLabel: normalized.isLabel,
          sort: normalized.sort,
        })
        .where(eq(memberShip.id, id));
      return { id };
    });
  }

  async setPlanStatus(idValue: unknown, isDelValue: unknown) {
    const id = positiveId(idValue, "套餐 ID");
    const isDel = integer(isDelValue, "套餐状态", { min: 0, max: 1 });
    const rows = await this.container.db
      .update(memberShip)
      .set({ isDel })
      .where(eq(memberShip.id, id))
      .returning({ id: memberShip.id });
    if (!rows[0]) throw new NotFoundException("会员套餐不存在");
    return { id };
  }

  async rights() {
    const rows = await this.container.db
      .select()
      .from(memberRight)
      .orderBy(desc(memberRight.sort), memberRight.id);
    return {
      list: rows.map((row) => ({
        id: row.id,
        right_type: row.rightType,
        title: row.title,
        show_title: row.showTitle,
        image: row.image,
        explain: row.explain,
        content: row.content ?? "",
        number: row.number,
        sort: row.sort,
        status: row.status,
        add_time: row.addTime,
      })),
      count: rows.length,
    };
  }

  async saveRight(idValue: unknown, input: Record<string, unknown>) {
    const id = Number(idValue ?? 0);
    const editing = Number.isSafeInteger(id) && id > 0;
    const normalized = normalizeMembershipRight(input);
    const values: Partial<typeof memberRight.$inferInsert> = {
      rightType: normalized.rightType,
      title: normalized.title,
      showTitle: normalized.showTitle,
      image: normalized.image,
      explain: normalized.explain,
      number: normalized.number,
      sort: normalized.sort,
      status: normalized.status,
    };
    if (normalized.content !== undefined) values.content = normalized.content;
    if (!editing) {
      values.addTime = Math.floor(Date.now() / 1_000);
      const rows = await this.container.db
        .insert(memberRight)
        .values(values as typeof memberRight.$inferInsert)
        .returning({ id: memberRight.id });
      return { id: rows[0]?.id ?? 0 };
    }
    const rows = await this.container.db
      .update(memberRight)
      .set(values)
      .where(eq(memberRight.id, id))
      .returning({ id: memberRight.id });
    if (!rows[0]) throw new NotFoundException("会员权益不存在");
    return { id };
  }

  async saveRightContent(idValue: unknown, input: Record<string, unknown>) {
    const id = positiveId(idValue, "权益 ID");
    const content = boundedString(pick(input, "content"), "权益内容", 200_000);
    const rows = await this.container.db
      .update(memberRight)
      .set({ content })
      .where(eq(memberRight.id, id))
      .returning({ id: memberRight.id });
    if (!rows[0]) throw new NotFoundException("会员权益不存在");
    return { id };
  }

  async membershipAgreement() {
    const rows = await this.container.db
      .select()
      .from(agreement)
      .where(eq(agreement.type, 1))
      .orderBy(desc(agreement.id))
      .limit(1);
    return rows[0] ?? null;
  }

  async saveAgreement(input: Record<string, unknown>) {
    const now = Math.floor(Date.now() / 1_000);
    const title = boundedString(pick(input, "title"), "协议标题", 200, true);
    const content = boundedString(pick(input, "content"), "协议内容", 200_000, true);
    const status = integer(pick(input, "status"), "协议状态", { min: 0, max: 1, fallback: 1 });
    const sort = integer(pick(input, "sort"), "排序", {
      min: -2_147_483_648,
      max: 2_147_483_647,
      fallback: 0,
    });
    const rows = await this.container.db
      .insert(agreement)
      .values({ type: 1, title, content, status, sort, addTime: now })
      .onConflictDoUpdate({
        target: agreement.type,
        set: { title, content, status, sort },
      })
      .returning({ id: agreement.id });
    return { id: rows[0]?.id ?? 0 };
  }

  async records(query: Record<string, unknown>) {
    const page = positivePage(query.page, 1);
    const limit = Math.min(100, positivePage(query.limit, 20));
    const conditions: SQL[] = [inArray(otherOrder.type, [0, 1, 2, 4]), eq(otherOrder.paid, 1)];
    const memberType = typeof query.member_type === "string" ? query.member_type.trim() : "";
    if (memberType) conditions.push(eq(otherOrder.memberType, memberType));
    const payType = typeof query.pay_type === "string" ? query.pay_type.trim() : "";
    if (payType) conditions.push(eq(otherOrder.payType, payType));
    const keyword = typeof query.name === "string" ? query.name.trim() : "";
    if (keyword) {
      conditions.push(
        or(
          ilike(userTable.nickname, `%${keyword}%`),
          ilike(userTable.realName, `%${keyword}%`),
          ilike(userTable.phone, `%${keyword}%`),
          ilike(otherOrder.orderId, `%${keyword}%`),
        )!,
      );
    }
    const range = epochRange(query);
    if (range) conditions.push(sql`${otherOrder.addTime} BETWEEN ${range[0]} AND ${range[1]}`);
    const where = and(...conditions);
    const [rows, totals, plans] = await Promise.all([
      this.container.db
        .select({
          order: otherOrder,
          nickname: userTable.nickname,
          realName: userTable.realName,
          phone: userTable.phone,
        })
        .from(otherOrder)
        .leftJoin(userTable, eq(userTable.uid, otherOrder.uid))
        .where(where)
        .orderBy(desc(otherOrder.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(otherOrder)
        .leftJoin(userTable, eq(userTable.uid, otherOrder.uid))
        .where(where),
      this.container.db.select({ id: memberShip.id, title: memberShip.title, type: memberShip.type }).from(memberShip),
    ]);
    const planById = new Map(plans.map((plan) => [plan.id, plan]));
    const legacyType = new Map<number, string>([[0, "免费会员"], [1, "购买会员"], [2, "卡密激活"], [4, "赠送会员"]]);
    return {
      list: rows.map(({ order, nickname, realName, phone }) => {
        const plan = /^\d+$/.test(order.memberType) ? planById.get(Number(order.memberType)) : undefined;
        return {
          id: order.id,
          uid: order.uid,
          order_id: order.orderId,
          member_type: order.memberType,
          member_title: plan?.title ?? legacyType.get(order.type) ?? order.memberType,
          member_plan_type: plan?.type ?? order.memberType,
          pay_type: order.payType,
          pay_price: order.payPrice,
          member_price: order.memberPrice,
          paid: order.paid,
          pay_time: order.payTime,
          channel_type: order.channelType,
          is_free: order.isFree,
          is_permanent: order.isPermanent,
          overdue_time: order.overdueTime,
          vip_day: order.vipDay,
          add_time: order.addTime,
          code_masked: order.code ? maskCardNumber(order.code) : "",
          username: realName || nickname || "",
          phone: phone ?? "",
        };
      }),
      count: totals[0]?.count ?? 0,
    };
  }
}
