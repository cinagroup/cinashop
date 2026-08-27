import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  max,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  qrcode,
  user,
  userLabel,
  wechatMedia,
  wechatQrcode,
  wechatQrcodeCate,
  wechatQrcodeRecord,
} from "@/models/schema";
import { normalizeReplyInput } from "@/services/wechat/WechatContentService";
import { OfficialAccountQrcodeService } from "@/services/wechat/OfficialAccountQrcodeService";
import { NotFoundException, ValidateException } from "@/utils/errors";

const CATEGORY_LOCK = 47_201;
const CHANNEL_LOCK = 47_202;
const CHANNEL_REPLY_TYPES = new Set(["text", "image", "news", "voice", "url"]);

function pick(input: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (input[key] !== undefined) return input[key];
  return undefined;
}

function textValue(value: unknown, label: string, maxLength: number, required = false): string {
  const valueText = typeof value === "string" ? value.trim() : "";
  if (required && !valueText) throw new ValidateException(`请填写${label}`);
  if (valueText.length > maxLength) throw new ValidateException(`${label}不能超过${maxLength}个字符`);
  return valueText;
}

function integerValue(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; fallback?: number } = {},
): number {
  if ((value === undefined || value === "") && options.fallback !== undefined) return options.fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)
    || parsed < (options.min ?? 0)
    || parsed > (options.max ?? 2_147_483_647)) {
    throw new ValidateException(`${label}格式错误`);
  }
  return parsed;
}

function pageValue(value: unknown, fallback: number, maxValue = 10_000): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maxValue) : fallback;
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

function parseIds(value: unknown): number[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [...new Set(source
    .map((item) => Number(typeof item === "object" && item ? (item as { id?: unknown }).id : item))
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
}

function normalizeChannelReply(type: string, contentValue: unknown) {
  const content = objectValue(contentValue, "回复内容");
  if (type === "url") {
    const value = textValue(pick(content, "content", "url"), "链接", 2_000, true);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ValidateException("链接必须是完整的 HTTP 或 HTTPS 地址");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new ValidateException("链接必须是 HTTP 或 HTTPS 地址");
    }
    return { content: { content: url.toString() }, data: { content: url.toString() } };
  }
  const rawData = type === "news" ? objectValue(pick(content, "list"), "图文内容") : content;
  const normalized = normalizeReplyInput({
    key: "__channel__",
    type,
    status: 1,
    data: rawData,
  });
  return {
    content: type === "news" ? { list: normalized.data } : normalized.data,
    data: normalized.data,
  };
}

export interface NormalizedChannelInput {
  uid: number;
  name: string;
  cateId: number;
  labelIds: number[];
  type: string;
  content: Record<string, unknown>;
  data: Record<string, unknown>;
  continueTime: number;
  status: number | null;
}

export function normalizeChannelInput(input: Record<string, unknown>): NormalizedChannelInput {
  const uid = integerValue(pick(input, "uid"), "推广员 UID", { min: 1 });
  const name = textValue(pick(input, "name"), "渠道码名称", 255, true);
  const cateId = integerValue(pick(input, "cate_id", "cateId"), "渠道码分类", { min: 1 });
  const labelIds = parseIds(pick(input, "label_id", "labelIds"));
  if (!labelIds.length) throw new ValidateException("请选择至少一个用户标签");
  if (labelIds.length > 20) throw new ValidateException("每个渠道码最多关联20个用户标签");
  if (labelIds.join(",").length > 32) throw new ValidateException("用户标签 ID 超过旧库字段长度限制");
  const type = textValue(pick(input, "type"), "回复类型", 32, true);
  if (!CHANNEL_REPLY_TYPES.has(type)) throw new ValidateException("回复类型错误");
  const reply = normalizeChannelReply(type, pick(input, "content"));
  const continueTime = integerValue(pick(input, "time", "continue_time", "continueTime"), "有效期", {
    min: 0,
    max: 10_000,
    fallback: 0,
  });
  const rawStatus = pick(input, "status");
  const status = rawStatus === undefined || rawStatus === ""
    ? null
    : integerValue(rawStatus, "状态", { min: 0, max: 1 });
  return { uid, name, cateId, labelIds, type, ...reply, continueTime, status };
}

function parseDateRange(value: string | undefined): { start: number; end: number; days: number } {
  const now = new Date();
  const fallbackEnd = Math.floor(now.getTime() / 1000);
  const fallbackStart = fallbackEnd - 6 * 86_400;
  if (!value?.trim()) return { start: fallbackStart, end: fallbackEnd, days: 7 };
  const match = value.trim().match(
    /^(\d{4}-\d{2}-\d{2})\s*(?:-|~|,|至)\s*(\d{4}-\d{2}-\d{2})$/,
  );
  if (!match) throw new ValidateException("统计时间格式应为 YYYY-MM-DD - YYYY-MM-DD");
  const start = Date.parse(`${match[1]}T00:00:00+08:00`) / 1000;
  const endStart = Date.parse(`${match[2]}T00:00:00+08:00`) / 1000;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endStart) || endStart < start) {
    throw new ValidateException("统计时间范围无效");
  }
  const days = Math.floor((endStart - start) / 86_400) + 1;
  if (days > 366) throw new ValidateException("统计时间范围不能超过366天");
  return { start, end: endStart + 86_400, days };
}

export class WechatQrcodeAdminService {
  private readonly officialQrcode: OfficialAccountQrcodeService;

  constructor(
    private readonly container: Container,
    env: Env,
  ) {
    this.officialQrcode = new OfficialAccountQrcodeService(container, env);
  }

  async categoryList() {
    const rows = await this.container.db
      .select()
      .from(wechatQrcodeCate)
      .where(eq(wechatQrcodeCate.isDel, 0))
      .orderBy(asc(wechatQrcodeCate.id));
    return {
      data: rows.map((row) => ({ ...row, cate_name: row.cateName, add_time: row.addTime })),
      count: rows.length,
    };
  }

  async categoryDetail(idValue: unknown) {
    const id = integerValue(idValue, "分类 ID", { min: 0, fallback: 0 });
    if (!id) return { id: 0, cate_name: "" };
    const rows = await this.container.db
      .select()
      .from(wechatQrcodeCate)
      .where(and(eq(wechatQrcodeCate.id, id), eq(wechatQrcodeCate.isDel, 0)))
      .limit(1);
    if (!rows[0]) throw new NotFoundException("渠道码分类不存在");
    return { id: rows[0].id, cate_name: rows[0].cateName };
  }

  async saveCategory(input: Record<string, unknown>) {
    const id = integerValue(pick(input, "id"), "分类 ID", { min: 0, fallback: 0 });
    const cateName = textValue(pick(input, "cate_name", "cateName"), "分组名称", 30, true);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${CATEGORY_LOCK})`);
      const duplicate = await tx
        .select({ id: wechatQrcodeCate.id })
        .from(wechatQrcodeCate)
        .where(and(
          eq(wechatQrcodeCate.cateName, cateName),
          eq(wechatQrcodeCate.isDel, 0),
          id ? sql`${wechatQrcodeCate.id} <> ${id}` : sql`true`,
        ))
        .limit(1);
      if (duplicate[0]) throw new ValidateException("分组名称已存在");
      const values = { cateName, addTime: Math.floor(Date.now() / 1000), isDel: 0 };
      if (id) {
        const updated = await tx
          .update(wechatQrcodeCate)
          .set(values)
          .where(and(eq(wechatQrcodeCate.id, id), eq(wechatQrcodeCate.isDel, 0)))
          .returning({ id: wechatQrcodeCate.id });
        if (!updated[0]) throw new NotFoundException("渠道码分类不存在");
        return { id };
      }
      const inserted = await tx
        .insert(wechatQrcodeCate)
        .values(values)
        .returning({ id: wechatQrcodeCate.id });
      return { id: inserted[0].id };
    });
  }

  async deleteCategory(idValue: unknown): Promise<void> {
    const id = integerValue(idValue, "分类 ID", { min: 1 });
    await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${CATEGORY_LOCK})`);
      const category = await tx
        .select({ id: wechatQrcodeCate.id })
        .from(wechatQrcodeCate)
        .where(and(eq(wechatQrcodeCate.id, id), eq(wechatQrcodeCate.isDel, 0)))
        .for("update")
        .limit(1);
      if (!category[0]) throw new NotFoundException("渠道码分类不存在");
      const used = await tx
        .select({ id: wechatQrcode.id })
        .from(wechatQrcode)
        .where(and(eq(wechatQrcode.cateId, id), eq(wechatQrcode.isDel, 0)))
        .limit(1);
      if (used[0]) throw new ValidateException("该分组下有渠道码，暂不能删除");
      await tx.update(wechatQrcodeCate).set({ isDel: 1 }).where(eq(wechatQrcodeCate.id, id));
    });
  }

  async channelList(query: Record<string, string | undefined>) {
    const page = pageValue(query.page, 1);
    const limit = pageValue(query.limit, 20, 100);
    const conditions: SQL[] = [eq(wechatQrcode.isDel, 0)];
    const name = query.name?.trim();
    if (name) {
      if (name.length > 255) throw new ValidateException("渠道码名称不能超过255个字符");
      conditions.push(ilike(wechatQrcode.name, `%${name}%`));
    }
    if (query.cate_id || query.cateId) {
      conditions.push(eq(
        wechatQrcode.cateId,
        integerValue(query.cate_id ?? query.cateId, "分类 ID", { min: 1 }),
      ));
    }
    if (query.status !== undefined && query.status !== "") {
      conditions.push(eq(wechatQrcode.status, integerValue(query.status, "状态", { min: 0, max: 1 })));
    }
    const where = and(...conditions);
    const [rows, totals] = await Promise.all([
      this.container.db
        .select()
        .from(wechatQrcode)
        .where(where)
        .orderBy(desc(wechatQrcode.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db.select({ count: count() }).from(wechatQrcode).where(where),
    ]);
    const channelIds = rows.map((row) => row.id);
    const userIds = [...new Set(rows.map((row) => row.uid).filter((uid) => uid > 0))];
    const categoryIds = [...new Set(rows.map((row) => row.cateId).filter((id) => id > 0))];
    const labelIds = [...new Set(rows.flatMap((row) => parseIds(row.labelId)))];
    const [users, categories, labels, yesterday, provisions] = await Promise.all([
      userIds.length
        ? this.container.db
            .select({ uid: user.uid, nickname: user.nickname, avatar: user.avatar })
            .from(user)
            .where(inArray(user.uid, userIds))
        : [],
      categoryIds.length
        ? this.container.db
            .select({ id: wechatQrcodeCate.id, name: wechatQrcodeCate.cateName })
            .from(wechatQrcodeCate)
            .where(inArray(wechatQrcodeCate.id, categoryIds))
        : [],
      labelIds.length
        ? this.container.db
            .select({ id: userLabel.id, name: userLabel.name })
            .from(userLabel)
            .where(inArray(userLabel.id, labelIds))
        : [],
      channelIds.length
        ? this.container.db
            .select({ qid: wechatQrcodeRecord.qid, count: sql<number>`COUNT(DISTINCT ${wechatQrcodeRecord.uid})` })
            .from(wechatQrcodeRecord)
            .where(and(
              inArray(wechatQrcodeRecord.qid, channelIds),
              eq(wechatQrcodeRecord.isFollow, 1),
              sql`${wechatQrcodeRecord.addTime} >= EXTRACT(EPOCH FROM ((((now() AT TIME ZONE 'Asia/Shanghai')::date - 1)::timestamp) AT TIME ZONE 'Asia/Shanghai'))`,
              sql`${wechatQrcodeRecord.addTime} < EXTRACT(EPOCH FROM ((((now() AT TIME ZONE 'Asia/Shanghai')::date)::timestamp) AT TIME ZONE 'Asia/Shanghai'))`,
            ))
            .groupBy(wechatQrcodeRecord.qid)
        : [],
      channelIds.length
        ? this.container.db
            .select({ thirdId: qrcode.thirdId, ticket: qrcode.ticket, url: qrcode.url, status: qrcode.status })
            .from(qrcode)
            .where(and(eq(qrcode.thirdType, "wechatqrcode"), inArray(qrcode.thirdId, channelIds)))
        : [],
    ]);
    const userMap = new Map(users.map((row) => [row.uid, row]));
    const categoryMap = new Map(categories.map((row) => [row.id, row.name]));
    const labelMap = new Map(labels.map((row) => [row.id, row.name]));
    const yesterdayMap = new Map(yesterday.map((row) => [row.qid, Number(row.count)]));
    const provisionMap = new Map(provisions.map((row) => [row.thirdId, row]));
    const now = Math.floor(Date.now() / 1000);
    return {
      list: rows.map((row) => {
        const rowLabelIds = parseIds(row.labelId);
        const relatedUser = userMap.get(row.uid);
        const provision = provisionMap.get(row.id);
        return {
          id: row.id,
          uid: row.uid,
          name: row.name,
          image: row.image || provision?.url || "",
          cate_id: row.cateId,
          cateName: categoryMap.get(row.cateId) ?? "",
          label_id: row.labelId,
          labelIds: rowLabelIds,
          label_name: rowLabelIds.map((id) => labelMap.get(id)).filter(Boolean),
          type: row.type,
          follow: row.follow,
          scan: row.scan,
          y_follow: yesterdayMap.get(row.id) ?? 0,
          add_time: row.addTime,
          continue_time: row.continueTime,
          end_time: row.endTime,
          stop: row.endTime ? (row.endTime > now ? 1 : -1) : 0,
          status: row.status,
          nickname: relatedUser?.nickname ?? "",
          avatar: relatedUser?.avatar ?? "",
          provisioning: provision?.ticket && provision.url && provision.status === 1 ? "ready" : "pending",
        };
      }),
      count: totals[0]?.count ?? 0,
    };
  }

  async channelDetail(idValue: unknown) {
    const id = integerValue(idValue, "渠道码 ID", { min: 1 });
    const rows = await this.container.db
      .select()
      .from(wechatQrcode)
      .where(and(eq(wechatQrcode.id, id), eq(wechatQrcode.isDel, 0)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException("渠道码不存在");
    const labelIds = parseIds(row.labelId);
    const [labels, users, provision] = await Promise.all([
      labelIds.length
        ? this.container.db
            .select({ id: userLabel.id, name: userLabel.name })
            .from(userLabel)
            .where(inArray(userLabel.id, labelIds))
        : [],
      this.container.db
        .select({ uid: user.uid, nickname: user.nickname, avatar: user.avatar })
        .from(user)
        .where(eq(user.uid, row.uid))
        .limit(1),
      this.officialQrcode.status("wechatqrcode", id),
    ]);
    return {
      id: row.id,
      uid: row.uid,
      name: row.name,
      image: row.image || provision.url,
      cate_id: row.cateId,
      label_id: labels.map((label) => ({ ...label, label_name: label.name })),
      labelIds,
      type: row.type,
      content: parseJsonObject(row.content),
      data: parseJsonObject(row.data),
      time: row.continueTime,
      continue_time: row.continueTime,
      end_time: row.endTime,
      status: row.status,
      avatar: users[0]?.avatar ?? "",
      nickname: users[0]?.nickname ?? "",
      provisioning: provision.status,
    };
  }

  async saveChannel(idValue: unknown, input: Record<string, unknown>) {
    const id = integerValue(idValue, "渠道码 ID", { min: 0, fallback: 0 });
    const normalized = normalizeChannelInput(input);
    const result = await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${CHANNEL_LOCK})`);
      const category = await tx
        .select({ id: wechatQrcodeCate.id })
        .from(wechatQrcodeCate)
        .where(and(eq(wechatQrcodeCate.id, normalized.cateId), eq(wechatQrcodeCate.isDel, 0)))
        .limit(1);
      if (!category[0]) throw new ValidateException("渠道码分类不存在或已删除");
      const promoter = await tx
        .select({ uid: user.uid })
        .from(user)
        .where(and(eq(user.uid, normalized.uid), eq(user.isDel, 0), eq(user.status, 1)))
        .limit(1);
      if (!promoter[0]) throw new ValidateException("推广员用户不存在或已停用");
      const labels = await tx
        .select({ id: userLabel.id })
        .from(userLabel)
        .where(and(
          inArray(userLabel.id, normalized.labelIds),
          eq(userLabel.type, 0),
          eq(userLabel.relationId, 0),
          eq(userLabel.status, 1),
        ));
      if (labels.length !== normalized.labelIds.length) {
        throw new ValidateException("用户标签不存在、已停用或不属于平台作用域");
      }
      if (normalized.type === "image" || normalized.type === "voice") {
        const mediaId = String(normalized.data.media_id ?? "");
        const media = await tx
          .select({ id: wechatMedia.id })
          .from(wechatMedia)
          .where(and(eq(wechatMedia.type, normalized.type), eq(wechatMedia.mediaId, mediaId)))
          .limit(1);
        if (!media[0]) throw new ValidateException("微信素材不存在或类型不匹配");
      }
      const now = Math.floor(Date.now() / 1000);
      const values = {
        uid: normalized.uid,
        name: normalized.name,
        cateId: normalized.cateId,
        labelId: normalized.labelIds.join(","),
        type: normalized.type,
        content: JSON.stringify(normalized.content),
        data: JSON.stringify(normalized.data),
        addTime: now,
        continueTime: normalized.continueTime,
        endTime: normalized.continueTime ? now + normalized.continueTime * 86_400 : 0,
        isDel: 0,
      };
      if (id) {
        const existing = await tx
          .select({ id: wechatQrcode.id, image: wechatQrcode.image, status: wechatQrcode.status })
          .from(wechatQrcode)
          .where(and(eq(wechatQrcode.id, id), eq(wechatQrcode.isDel, 0)))
          .for("update")
          .limit(1);
        if (!existing[0]) throw new NotFoundException("渠道码不存在");
        await tx
          .update(wechatQrcode)
          .set({ ...values, status: normalized.status ?? existing[0].status })
          .where(eq(wechatQrcode.id, id));
        return { id, image: existing[0].image };
      }
      const inserted = await tx
        .insert(wechatQrcode)
        .values({ ...values, image: "", status: normalized.status ?? 1, follow: 0, scan: 0 })
        .returning({ id: wechatQrcode.id });
      return { id: inserted[0].id, image: "" };
    });
    const provision = result.image
      ? await this.officialQrcode.status("wechatqrcode", result.id)
      : await this.officialQrcode.requestPermanent("wechatqrcode", result.id);
    return { id: result.id, provisioning: provision.status, queued: "queued" in provision ? provision.queued : false };
  }

  async deleteChannel(idValue: unknown): Promise<void> {
    const id = integerValue(idValue, "渠道码 ID", { min: 1 });
    const rows = await this.container.db
      .update(wechatQrcode)
      .set({ isDel: 1, status: 0 })
      .where(and(eq(wechatQrcode.id, id), eq(wechatQrcode.isDel, 0)))
      .returning({ id: wechatQrcode.id });
    if (!rows[0]) throw new NotFoundException("渠道码不存在");
  }

  async setChannelStatus(idValue: unknown, statusValue: unknown): Promise<void> {
    const id = integerValue(idValue, "渠道码 ID", { min: 1 });
    const status = integerValue(statusValue, "状态", { min: 0, max: 1 });
    const rows = await this.container.db
      .update(wechatQrcode)
      .set({ status })
      .where(and(eq(wechatQrcode.id, id), eq(wechatQrcode.isDel, 0)))
      .returning({ id: wechatQrcode.id });
    if (!rows[0]) throw new NotFoundException("渠道码不存在");
  }

  async provisionChannel(idValue: unknown) {
    const id = integerValue(idValue, "渠道码 ID", { min: 1 });
    const rows = await this.container.db
      .select({ id: wechatQrcode.id })
      .from(wechatQrcode)
      .where(and(eq(wechatQrcode.id, id), eq(wechatQrcode.isDel, 0)))
      .limit(1);
    if (!rows[0]) throw new NotFoundException("渠道码不存在");
    return this.officialQrcode.requestPermanent("wechatqrcode", id);
  }

  async userList(qidValue: unknown, query: Record<string, string | undefined>) {
    const qid = integerValue(qidValue, "渠道码 ID", { min: 1 });
    const page = pageValue(query.page, 1);
    const limit = pageValue(query.limit, 20, 100);
    const channel = await this.container.db
      .select({ id: wechatQrcode.id })
      .from(wechatQrcode)
      .where(eq(wechatQrcode.id, qid))
      .limit(1);
    if (!channel[0]) throw new NotFoundException("渠道码不存在");
    const [rows, totals] = await Promise.all([
      this.container.db
        .select({
          uid: wechatQrcodeRecord.uid,
          isFollow: max(wechatQrcodeRecord.isFollow),
          lastScanTime: max(wechatQrcodeRecord.addTime),
          nickname: user.nickname,
          avatar: user.avatar,
          userType: user.userType,
        })
        .from(wechatQrcodeRecord)
        .leftJoin(user, eq(user.uid, wechatQrcodeRecord.uid))
        .where(eq(wechatQrcodeRecord.qid, qid))
        .groupBy(wechatQrcodeRecord.uid, user.nickname, user.avatar, user.userType)
        .orderBy(desc(max(wechatQrcodeRecord.addTime)))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(DISTINCT ${wechatQrcodeRecord.uid})` })
        .from(wechatQrcodeRecord)
        .where(eq(wechatQrcodeRecord.qid, qid)),
    ]);
    return { list: rows, count: Number(totals[0]?.count ?? 0) };
  }

  async statistics(qidValue: unknown, query: Record<string, string | undefined>) {
    const qid = integerValue(qidValue, "渠道码 ID", { min: 1 });
    const channel = await this.container.db
      .select({ id: wechatQrcode.id })
      .from(wechatQrcode)
      .where(eq(wechatQrcode.id, qid))
      .limit(1);
    if (!channel[0]) throw new NotFoundException("渠道码不存在");
    const range = parseDateRange(query.time);
    const yesterdayStart = sql<number>`EXTRACT(EPOCH FROM ((((now() AT TIME ZONE 'Asia/Shanghai')::date - 1)::timestamp) AT TIME ZONE 'Asia/Shanghai'))`;
    const yesterdayEnd = sql<number>`EXTRACT(EPOCH FROM ((((now() AT TIME ZONE 'Asia/Shanghai')::date)::timestamp) AT TIME ZONE 'Asia/Shanghai'))`;
    const bucket = range.days === 1
      ? sql<string>`to_char(to_timestamp(${wechatQrcodeRecord.addTime}) AT TIME ZONE 'Asia/Shanghai', 'HH24')`
      : range.days <= 92
        ? sql<string>`to_char(to_timestamp(${wechatQrcodeRecord.addTime}) AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')`
        : sql<string>`to_char(to_timestamp(${wechatQrcodeRecord.addTime}) AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM')`;
    const [allScan, allFollow, yesterdayScan, yesterdayFollow, trend] = await Promise.all([
      this.container.db.select({ count: count() }).from(wechatQrcodeRecord).where(eq(wechatQrcodeRecord.qid, qid)),
      this.container.db.select({ count: count() }).from(wechatQrcodeRecord).where(and(eq(wechatQrcodeRecord.qid, qid), eq(wechatQrcodeRecord.isFollow, 1))),
      this.container.db.select({ count: count() }).from(wechatQrcodeRecord).where(and(eq(wechatQrcodeRecord.qid, qid), sql`${wechatQrcodeRecord.addTime} >= ${yesterdayStart}`, sql`${wechatQrcodeRecord.addTime} < ${yesterdayEnd}`)),
      this.container.db.select({ count: count() }).from(wechatQrcodeRecord).where(and(eq(wechatQrcodeRecord.qid, qid), eq(wechatQrcodeRecord.isFollow, 1), sql`${wechatQrcodeRecord.addTime} >= ${yesterdayStart}`, sql`${wechatQrcodeRecord.addTime} < ${yesterdayEnd}`)),
      this.container.db
        .select({
          bucket,
          scan: count(),
          follow: sql<number>`COUNT(*) FILTER (WHERE ${wechatQrcodeRecord.isFollow} = 1)`,
        })
        .from(wechatQrcodeRecord)
        .where(and(
          eq(wechatQrcodeRecord.qid, qid),
          sql`${wechatQrcodeRecord.addTime} >= ${range.start}`,
          sql`${wechatQrcodeRecord.addTime} < ${range.end}`,
        ))
        .groupBy(bucket)
        .orderBy(asc(bucket)),
    ]);
    return {
      all_follow: allFollow[0]?.count ?? 0,
      all_scan: allScan[0]?.count ?? 0,
      y_follow: yesterdayFollow[0]?.count ?? 0,
      y_scan: yesterdayScan[0]?.count ?? 0,
      trend: {
        xAxis: trend.map((item) => item.bucket),
        series: [
          { name: "新增关注", type: "line", data: trend.map((item) => Number(item.follow)) },
          { name: "新增参与", type: "line", data: trend.map((item) => Number(item.scan)) },
        ],
      },
    };
  }
}
