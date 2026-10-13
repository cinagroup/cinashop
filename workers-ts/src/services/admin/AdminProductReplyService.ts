import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeProduct, storeProductReply, storeProductReplyComment } from '@/models/schema';
import { parseSupplierProductReplyQuery } from '@/services/supplier/SupplierProductReplyService';
import { NotFoundException, ValidateException } from '@/utils/errors';

const DAY = 86_400, OFFSET = 8 * 3_600, MAX_EPOCH = 2_147_483_647;
type Reply = typeof storeProductReply.$inferSelect;
type Comment = typeof storeProductReplyComment.$inferSelect;

function legacyTime(epoch: number): string {
  return new Date((epoch + OFFSET) * 1_000).toISOString().slice(0, 19).replace('T', ' ');
}

function relativeTime(epoch: number, now: number): string | null {
  // Exact readable app/common.php time_tran ordering and floor behavior.
  for (const [seconds, label] of [[31536000, '年'], [2592000, '个月'], [604800, '星期'],
    [86400, '天'], [3600, '小时'], [60, '分钟'], [1, '秒']] as const) {
    const count = Math.floor((now - epoch) / seconds);
    if (count !== 0) return `${count}${label}前`;
  }
  return null;
}

function customTime(raw: string): number {
  const match = /^(\d{4})[/-](\d{2})[/-](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw.trim());
  if (!match) throw new ValidateException('评价时间范围无效');
  const [year, month, day, hour, minute, second] = match.slice(1).map(part => Number(part ?? 0));
  const shifted = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const epoch = shifted.getTime() / 1_000 - OFFSET;
  if (shifted.getUTCFullYear() !== year || shifted.getUTCMonth() !== month - 1 || shifted.getUTCDate() !== day
    || shifted.getUTCHours() !== hour || shifted.getUTCMinutes() !== minute || shifted.getUTCSeconds() !== second
    || epoch < 0 || epoch > MAX_EPOCH) throw new ValidateException('评价时间范围无效');
  return epoch;
}

function dates(raw: string | undefined, now: number): { startTime?: number; endTime?: number } {
  if (!raw) return {};
  if (raw.length > 100) throw new ValidateException('评价时间范围无效');
  if (raw === 'lately7' || raw === 'lately30') return { startTime: now - (raw === 'lately7' ? 7 : 30) * DAY, endTime: now };
  const shifted = new Date((now + OFFSET) * 1_000);
  const year = shifted.getUTCFullYear(), month = shifted.getUTCMonth(), day = shifted.getUTCDate();
  const midnight = (y: number, m: number, d: number) => Date.UTC(y, m, d) / 1_000 - OFFSET;
  const today = midnight(year, month, day);
  const monday = today - (shifted.getUTCDay() + 6) % 7 * DAY;
  const ranges: Record<string, [number, number]> = {
    today: [today, today + DAY - 1], yesterday: [today - DAY, today - 1],
    week: [monday, monday + 7 * DAY - 1], 'last week': [monday - 7 * DAY, monday - 1],
    month: [midnight(year, month, 1), midnight(year, month + 1, 1) - 1],
    'last month': [midnight(year, month - 1, 1), midnight(year, month, 1) - 1],
    year: [midnight(year, 0, 1), midnight(year + 1, 0, 1) - 1],
    'last year': [midnight(year - 1, 0, 1), midnight(year, 0, 1) - 1],
    quarter: [midnight(year, Math.floor(month / 3) * 3, 1), midnight(year, Math.floor(month / 3) * 3 + 3, 0)],
  };
  if (Object.hasOwn(ranges, raw)) return { startTime: ranges[raw][0], endTime: ranges[raw][1] };
  const open = /^(\d{4}[/-]\d{2}[/-]\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)?\s*-\s*(\d{4}[/-]\d{2}[/-]\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)?$/.exec(raw);
  if (open && (!open[1] || !open[2])) {
    const endTime = open[2] ? customTime(open[2]) + DAY - 1 : undefined;
    if (endTime !== undefined && endTime > MAX_EPOCH) throw new ValidateException('评价时间范围无效');
    return { startTime: open[1] ? customTime(open[1]) : undefined, endTime };
  }
  // The old DatePicker sends yyyy/MM/dd-yyyy/MM/dd. PHP includes the next
  // midnight when the end value is midnight or equals the start value.
  const custom = /^(\d{4}[/-]\d{2}[/-]\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)\s*-\s*(\d{4}[/-]\d{2}[/-]\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)$/.exec(raw);
  if (!custom) throw new ValidateException('评价时间范围无效');
  const startTime = customTime(custom[1]), end = customTime(custom[2]);
  const endTime = end === startTime || (end + OFFSET) % DAY === 0 ? end + DAY : end;
  if (end < startTime || endTime > MAX_EPOCH) throw new ValidateException('评价时间范围无效');
  return { startTime, endTime };
}

export function parseAdminProductReplyQuery(raw: Record<string, string | undefined>, now = Math.floor(Date.now() / 1_000)) {
  return { ...parseSupplierProductReplyQuery({ ...raw, data: undefined }), ...dates(raw.data, now) };
}

function commentWhere(replyId?: number): SQL {
  return and(replyId === undefined ? undefined : eq(storeProductReplyComment.replyId, replyId),
    eq(storeProductReplyComment.uid, 0), eq(storeProductReplyComment.pid, 0),
    eq(storeProductReplyComment.type, 0), eq(storeProductReplyComment.relationId, 0), eq(storeProductReplyComment.isDel, 0))!;
}

function commentJson(row: Comment) {
  return { ...Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), value])),
    create_time: legacyTime(row.addTime), update_time: legacyTime(row.updateTime) };
}

function pictures(raw: string | null): unknown[] {
  if (!raw || raw.length > 65_536) return [];
  try { const value: unknown = JSON.parse(raw); return Array.isArray(value) ? value : []; } catch { return []; }
}

async function lockReply(tx: DbClient, id: number): Promise<Reply> {
  const [reply] = await tx.select().from(storeProductReply)
    .where(and(eq(storeProductReply.id, id), eq(storeProductReply.isDel, 0))).limit(1).for('update');
  if (!reply) throw new NotFoundException('评论不存在或已删除');
  return reply;
}

function replyContent(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidateException('请输入回复内容');
  const content = raw.replace(/\0/g, '').trim();
  if (!content) throw new ValidateException('请输入回复内容');
  if ([...content].length > 1_000) throw new ValidateException('回复内容不能超过1000个字符');
  return content;
}

/** The authenticated platform Admin's PHP list is global: owner type/relation
 * zero did not narrow its DAO. Replies created here remain platform-owned. */
export class AdminProductReplyService {
  constructor(private readonly container: Container) {}

  async list(raw: Record<string, string | undefined>) {
    const now = Math.floor(Date.now() / 1_000), query = parseAdminProductReplyQuery(raw, now);
    const conditions: SQL[] = [eq(storeProductReply.isDel, 0)];
    if (query.isReply !== undefined) conditions.push(eq(storeProductReply.isReply, query.isReply));
    if (query.productId !== undefined) conditions.push(eq(storeProductReply.productId, query.productId));
    if (query.productKeyword) {
      const pattern = `%${query.productKeyword}%`;
      conditions.push(or(ilike(storeProduct.storeName, pattern), ilike(storeProduct.keyword, pattern),
        ilike(sql`${storeProductReply.id}::text`, pattern), ilike(sql`${storeProductReply.productId}::text`, pattern))!);
    }
    if (query.account) conditions.push(ilike(storeProductReply.nickname, `%${query.account}%`));
    if (query.startTime !== undefined) conditions.push(gte(storeProductReply.addTime, query.startTime));
    if (query.endTime !== undefined) conditions.push(lte(storeProductReply.addTime, query.endTime));
    const where = and(...conditions);
    const [rows, totals] = await Promise.all([
      this.container.db.select({ reply: storeProductReply, storeName: storeProduct.storeName, image: storeProduct.image })
        .from(storeProductReply).leftJoin(storeProduct, eq(storeProduct.id, storeProductReply.productId)).where(where)
        .orderBy(desc(storeProductReply.addTime), asc(storeProductReply.isReply), desc(storeProductReply.id))
        .limit(query.limit).offset((query.page - 1) * query.limit),
      this.container.db.select({ value: sql<number>`COUNT(*)::int` }).from(storeProductReply)
        .leftJoin(storeProduct, eq(storeProduct.id, storeProductReply.productId)).where(where),
    ]);
    const ids = rows.map(row => row.reply.id);
    const comments = ids.length ? await this.container.db.select().from(storeProductReplyComment)
      .where(and(inArray(storeProductReplyComment.replyId, ids), eq(storeProductReplyComment.uid, 0),
        eq(storeProductReplyComment.pid, 0), eq(storeProductReplyComment.isDel, 0)))
      .orderBy(desc(storeProductReplyComment.updateTime), desc(storeProductReplyComment.id)) : [];
    const byReply = new Map<number, Comment>();
    for (const comment of comments) if (!byReply.has(comment.replyId)) byReply.set(comment.replyId, comment);
    return { list: rows.map(({ reply, storeName, image }) => {
      const projected = Object.fromEntries(Object.entries(reply).map(([key, value]) => [key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), value]));
      const comment = byReply.get(reply.id), time = legacyTime(reply.addTime);
      return { ...projected, store_name: storeName ?? '', image: image ?? '', account: reply.nickname,
        pics: pictures(reply.pics), add_time: time, create_time: time, time: relativeTime(reply.addTime, now),
        score: String(Math.trunc((reply.productScore + reply.serviceScore + reply.deliveryScore) / 3)),
        replyComment: comment ? commentJson(comment) : null };
    }), count: Number(totals[0]?.value ?? 0), page: query.page, limit: query.limit };
  }

  async getReply(id: number) {
    const [reply] = await this.container.db.select({ id: storeProductReply.id }).from(storeProductReply)
      .where(and(eq(storeProductReply.id, id), eq(storeProductReply.isDel, 0))).limit(1);
    if (!reply) throw new NotFoundException('评论不存在或已删除');
    const [comment] = await this.container.db.select().from(storeProductReplyComment).where(commentWhere(id))
      .orderBy(desc(storeProductReplyComment.updateTime), desc(storeProductReplyComment.id)).limit(1);
    return comment ? commentJson(comment) : { content: '' };
  }

  async setReply(id: number, rawContent: unknown) {
    const content = replyContent(rawContent);
    return withTx(this.container, async tx => {
      const reply = await lockReply(tx, id), now = Math.floor(Date.now() / 1_000);
      const existing = await tx.select({ id: storeProductReplyComment.id }).from(storeProductReplyComment)
        .where(commentWhere(id)).orderBy(desc(storeProductReplyComment.id));
      let commentId: number;
      if (existing.length) {
        await tx.update(storeProductReplyComment).set({ content, updateTime: now }).where(commentWhere(id));
        commentId = existing[0].id;
      } else {
        const [inserted] = await tx.insert(storeProductReplyComment).values({ replyId: id, uid: 0, pid: 0,
          type: 0, relationId: 0, content, addTime: now, updateTime: now }).returning({ id: storeProductReplyComment.id });
        if (!inserted) throw new Error('Reply insert not confirmed');
        commentId = inserted.id;
      }
      // PHP only changes the reply state when the replying end equals its owner.
      if (reply.type === 0) await tx.update(storeProductReply).set({ isReply: 1 })
        .where(and(eq(storeProductReply.id, id), eq(storeProductReply.isDel, 0)));
      return { id, comment_id: commentId, is_reply: reply.type === 0 ? 1 : reply.isReply };
    });
  }

  async remove(id: number) {
    return withTx(this.container, async tx => {
      await lockReply(tx, id);
      await tx.update(storeProductReply).set({ isDel: 1 }).where(and(eq(storeProductReply.id, id), eq(storeProductReply.isDel, 0)));
    });
  }
}
