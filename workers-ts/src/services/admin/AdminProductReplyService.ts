import { and, asc, desc, eq, gte, ilike, inArray, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { storeProduct, storeProductReply, storeProductReplyComment, systemAdmin, systemLog, systemUserLevel, user } from '@/models/schema';
import { ApiErrorCode, AuthException, HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { legacyPhpJsonDecodeWire } from '@/utils/legacy-php-json';
import { lockReviewProducts, verifyReviewProductSnapshot } from '@/services/product/ProductReviewRatingService';
import { renderProductReplyMedia } from '@/services/product/ProductReplyMediaPolicy';
import { acquireAdminAuthorityWriteBarrier, assertAdminAuthoritySession, loadAdminAuthorityLiveActor,
  parseAdminAuthorityRoleIds, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { loadAdminLegacyRoleReferenceHistory } from './AdminLegacyRoleDeletionProof';
import { AdminPermissionService, hasAdminPermission } from './AdminPermissionService';

export type AdminProductReplyActor = AdminAuthorityActor;
type ReplyRow = typeof storeProductReply.$inferSelect;
type CommentRow = typeof storeProductReplyComment.$inferSelect;
const MAX_ID = 2_147_483_647;
const MAX_THREAD = 2000;
const invalidText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u;

export function replyId(value: unknown, allowZero = false): number {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id < (allowZero ? 0 : 1) || id > MAX_ID) throw new ValidateException('商品评价或回复ID错误');
  return id;
}
export function productReplyId(value: unknown): number { return replyId(value); }

function queryInput(query: URLSearchParams, allowed: string[]): Record<string, string> {
  const input: Record<string, string> = {};
  for (const [key, value] of query) {
    if (!allowed.includes(key) || Object.hasOwn(input, key)) throw new ValidateException('商品评价查询参数错误或重复');
    input[key] = value;
  }
  return input;
}
function noQuery(query: URLSearchParams): void { queryInput(query, []); }
function pagination(input: Record<string, string>, defaultLimit: number) {
  const page = input.page === undefined ? 1 : replyId(input.page);
  const limit = input.limit === undefined ? defaultLimit : replyId(input.limit);
  if (page > 1_000_000 || limit > 100 || (page - 1) * limit > MAX_ID) throw new ValidateException('商品评价分页超出范围');
  return { page, limit };
}
function filter(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if ([...value].length > 128 || invalidText.test(value) || /[\t\n\r]/u.test(value)) throw new ValidateException('商品评价筛选文本错误');
  return value;
}
function bodyContent(value: unknown, phpTruthy = false): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('商品回复正文必须是对象');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'content') || typeof body.content !== 'string') throw new ValidateException('商品回复仅接受content字段');
  const content = body.content;
  if (!content.trim() || (phpTruthy && content === '0')) throw new ValidateException('缺少回复内容');
  if ([...content].length > 1000 || invalidText.test(content)) throw new ValidateException('商品回复最多1000个字符且不能包含非法字符');
  return content;
}
function deletionInput(value: unknown, legacy: boolean): void {
  if (value === undefined) return;
  if (legacy && value === '') return;
  if (legacy && value && typeof value === 'object' && !Array.isArray(value)) {
    const body = value as Record<string, unknown>;
    if (Object.keys(body).length === 1 && Object.hasOwn(body, 'ids') && body.ids === '') return;
  }
  throw new ValidateException(legacy ? '商品评价删除仅接受空正文或旧弹窗空ids' : '商品评价删除不接受正文');
}

const shanghaiFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
type CalendarParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };
function shanghaiParts(value: number): CalendarParts {
  const parts = Object.fromEntries(shanghaiFormatter.formatToParts(new Date(value * 1000)).map(part => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}
function shanghai(value: number): string {
  const parts = shanghaiParts(value), pad = (part: number) => String(part).padStart(2, '0');
  return `${String(parts.year).padStart(4, '0')}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}
function calendarUtc(parts: CalendarParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}
function calendarEpoch(parts: CalendarParts): number {
  const target = calendarUtc(parts);
  let candidate = target;
  // Resolve the IANA offset at the candidate instant rather than assuming
  // UTC+8; Asia/Shanghai observed UTC+9 during historical summer time.
  for (let index = 0; index < 6; index++) {
    const correction = target - calendarUtc(shanghaiParts(candidate / 1000));
    if (correction === 0) return candidate / 1000;
    candidate += correction;
  }
  if (calendarUtc(shanghaiParts(candidate / 1000)) !== target) throw new ValidateException('商品评价时间在上海时区不存在');
  return candidate / 1000;
}
function relativeCalendarEpoch(parts: CalendarParts): number {
  try { return calendarEpoch(parts); } catch (error) {
    if (!(error instanceof ValidateException)) throw error;
    const target = calendarUtc(parts);
    const offset = (instant: number) => calendarUtc(shanghaiParts(instant / 1000)) - instant;
    const before = offset(target - 86400000), after = offset(target + 86400000), gap = after - before;
    const forward = target - before, backward = target - after;
    // PHP timelib normalizes a relative-day target inside a forward clock
    // jump using the preceding offset. Prove the gap on both sides and its
    // exact size rather than choosing a nonconverging iteration's last value.
    if (gap <= 0 || gap > 86400000 || offset(forward) !== after || offset(backward) !== before
      || calendarUtc(shanghaiParts(forward / 1000)) !== target + gap
      || calendarUtc(shanghaiParts(backward / 1000)) !== target - gap) throw error;
    return forward / 1000;
  }
}
function relativeTime(value: number): string | null {
  const elapsed = Math.floor(Date.now() / 1000) - value;
  for (const [seconds, unit] of [[31536000, '年'], [2592000, '个月'], [604800, '星期'], [86400, '天'], [3600, '小时'], [60, '分钟'], [1, '秒']] as const) {
    const count = Math.floor(elapsed / seconds);
    if (count) return `${count}${unit}前`;
  }
  return null;
}
function decodePics(value: string | null): unknown {
  if (value === null || value === '') return null;
  if (value.length > 32768) throw new ServiceUnavailableException('历史评价图片数据过大，请核对数据');
  try { return JSON.parse(value) as unknown; } catch { return null; }
}
function commentDto(row: CommentRow) {
  return { id: row.id, type: row.type, relation_id: row.relationId, uid: row.uid, praise: row.praise,
    content: row.content, pid: row.pid, reply_id: row.replyId, create_time: shanghai(row.addTime), update_time: shanghai(row.updateTime) };
}
function legacyReplyDto(row: ReplyRow) {
  return { id: row.id, uid: row.uid, oid: row.oid, type: row.type, relation_id: row.relationId, unique: row.unique,
    product_id: row.productId, sku_unique: row.skuUnique, sku: row.sku, reply_type: row.replyType, reply_score: row.replyScore,
    product_score: row.productScore, service_score: row.serviceScore, delivery_score: row.deliveryScore,
    comment: row.comment, pics: legacyPhpJsonDecodeWire(row.pics), add_time: shanghai(row.addTime), praise: row.praise,
    views_num: row.viewsNum, merchant_reply_content: row.merchantReplyContent, merchant_reply_time: row.merchantReplyTime,
    is_del: row.isDel, is_reply: row.isReply, nickname: row.nickname, avatar: row.avatar,
    // TS moderation retains its established visibility control. PHP did not
    // have this extra field; the original customer/source fields remain intact.
    status: row.status };
}
type LegacyReplyItem = ReturnType<typeof legacyReplyDto> & { store_name: string | null; image: string | null;
  account: string; create_time: string; time: string | null; score: string; replyComment: ReturnType<typeof commentDto> | null };
type LegacyReplyList = { list: LegacyReplyItem[]; count: number };
type ModernReplyItem = Omit<ReplyRow, 'pics'> & { pics: unknown[] };
function validOwner(type: number, relationId: number): boolean {
  return (type === 0 && relationId === 0) || ([1, 2].includes(type) && Number.isSafeInteger(relationId) && relationId > 0 && relationId <= MAX_ID);
}
function assertReply(row: ReplyRow): void {
  if (!validOwner(row.type, row.relationId) || ![0, 1].includes(row.isDel) || ![0, 1].includes(row.status)) throw new ServiceUnavailableException('历史商品评价归属或状态异常，请核对数据');
}
function assertComment(row: CommentRow, parent: ReplyRow): void {
  // Customer comments in PHP and the existing public TS writer use the default
  // 0/0 tuple, including comments on a Supplier review.
  const defaultOwner = row.type === 0 && row.relationId === 0;
  const sameOwner = row.type === parent.type && row.relationId === parent.relationId;
  if (row.replyId !== parent.id || !validOwner(row.type, row.relationId) || (!defaultOwner && !sameOwner)
    || !Number.isSafeInteger(row.uid) || row.uid < 0 || row.uid > MAX_ID || ![0, 1].includes(row.isDel)) {
    throw new ServiceUnavailableException('历史商品回复归属或父链异常，请核对数据');
  }
}
function platformRoot(rows: CommentRow[], parent: ReplyRow): CommentRow | undefined {
  const roots = rows.filter(row => row.uid === 0 && row.pid === 0 && row.isDel === 0);
  roots.forEach(row => assertComment(row, parent));
  const platform = roots.filter(row => row.type === 0 && row.relationId === 0);
  if (platform.length > 1) throw new ServiceUnavailableException('商品评价存在重复管理员根回复，请先修复数据');
  return platform[0];
}
function sameRow<T extends object>(actual: T | undefined, expected: T): boolean {
  return !!actual && Object.keys(actual).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => (actual as Record<string, unknown>)[key] === value);
}
function sameRows<T extends { id: number }>(actual: T[], expected: T[]): boolean {
  return actual.length === expected.length && actual.every((row, index) => sameRow(row, expected[index]));
}
function operationError(error: unknown): never {
  let cause: unknown = error;
  for (let depth = 0; depth < 6 && cause && typeof cause === 'object'; depth++) {
    const code = 'code' in cause ? String(cause.code) : '';
    if (['55P03', '40P01', '40001'].includes(code)) throw Object.assign(new HttpApiException('商品评价或管理员权限正在更新，请刷新后重试', 409, 409), { cause: error });
    if (['42501', '57014'].includes(code)) throw Object.assign(new ServiceUnavailableException('商品评价运行权限配置未就绪或操作超时'), { cause: error });
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}

function dateEpoch(value: string): number {
  const match = value.match(/^(\d{4})[/-](\d{2})[/-](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) throw new ValidateException('商品评价时间范围错误');
  const parts = match.slice(1).map(part => part === undefined ? 0 : Number(part));
  const [year, month, day, hour, minute, second] = parts;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) throw new ValidateException('商品评价时间范围错误');
  const epoch = calendarEpoch({ year, month, day, hour, minute, second });
  if (epoch < -2_147_483_648 || epoch > MAX_ID) throw new ValidateException('商品评价时间范围超出范围');
  return epoch;
}
function timeBounds(value: string | undefined): { start?: number; end?: number; endExclusive?: boolean } {
  if (value === undefined || value === '' || value === '0') return {};
  if (value.length > 100 || invalidText.test(value)) throw new ValidateException('商品评价时间范围错误');
  const named = ['today', 'yesterday', 'week', 'last week', 'month', 'last month', 'year', 'last year', 'quarter', 'lately7', 'lately30'];
  if (named.includes(value)) {
    const now = Math.floor(Date.now() / 1000), local = shanghaiParts(now);
    const year = local.year, month = local.month - 1, day = local.day;
    const parts = (y: number, m: number, d: number, h = 0, minute = 0, second = 0): CalendarParts => {
      const normalized = new Date(Date.UTC(y, m, d, h, minute, second));
      return { year: normalized.getUTCFullYear(), month: normalized.getUTCMonth() + 1, day: normalized.getUTCDate(),
        hour: normalized.getUTCHours(), minute: normalized.getUTCMinutes(), second: normalized.getUTCSeconds() };
    };
    const boundary = (y: number, m: number, d: number) => calendarEpoch(parts(y, m, d));
    const weekDay = (new Date(Date.UTC(year, month, day)).getUTCDay() + 6) % 7;
    // Evaluate only the requested name. An unrelated relative-day DST gap or
    // year boundary must not make a concrete date range fail.
    const ranges: Record<string, () => { start: number; end: number }> = {
      today: () => ({ start: boundary(year, month, day), end: boundary(year, month, day + 1) - 1 }),
      yesterday: () => ({ start: boundary(year, month, day - 1), end: boundary(year, month, day) - 1 }),
      week: () => ({ start: boundary(year, month, day - weekDay), end: boundary(year, month, day - weekDay + 7) - 1 }),
      'last week': () => ({ start: boundary(year, month, day - weekDay - 7), end: boundary(year, month, day - weekDay) - 1 }),
      month: () => ({ start: boundary(year, month, 1), end: boundary(year, month + 1, 1) - 1 }),
      'last month': () => ({ start: boundary(year, month - 1, 1), end: boundary(year, month, 1) - 1 }),
      year: () => ({ start: boundary(year, 0, 1), end: boundary(year + 1, 0, 1) - 1 }),
      'last year': () => ({ start: boundary(year - 1, 0, 1), end: boundary(year, 0, 1) - 1 }),
      quarter: () => ({ start: boundary(year, Math.floor(month / 3) * 3, 1), end: boundary(year, Math.floor(month / 3) * 3 + 3, 0) }),
      lately7: () => ({ start: relativeCalendarEpoch(parts(year, month, day - 7, local.hour, local.minute, local.second)), end: now }),
      lately30: () => ({ start: relativeCalendarEpoch(parts(year, month, day - 30, local.hour, local.minute, local.second)), end: now }),
    };
    return ranges[value]();
  }
  // The actual old DatePicker joins yyyy/MM/dd with a bare hyphen. Match both
  // complete date parts before splitting, so ISO dates' own hyphens survive.
  const datePart = '(?:\\d{4}[/-]\\d{2}[/-]\\d{2}(?:[ T]\\d{2}:\\d{2}(?::\\d{2})?)?)';
  const range = value.trim().match(new RegExp(`^(${datePart})?\\s*-\\s*(${datePart})?$`));
  const parts = range ? [range[1] ?? '', range[2] ?? ''] : value.trim().split(/\s+~\s+|\s+至\s+|,/);
  if (parts.length > 2 || !parts.some(part => part.trim())) throw new ValidateException('商品评价时间范围错误');
  const parsedStart = parts[0].trim() ? dateEpoch(parts[0].trim()) : undefined;
  const parsedEnd = parts.length === 1 ? parsedStart : parts[1].trim() ? dateEpoch(parts[1].trim()) : undefined;
  // ModelTrait tests the parsed timestamps for PHP truthiness: Unix epoch
  // zero is an absent endpoint even when a nonempty date supplied it.
  const start = parsedStart === 0 ? undefined : parsedStart;
  let end = parsedEnd === 0 ? undefined : parsedEnd;
  if (start === undefined && end === undefined) return {};
  if (start !== undefined && end !== undefined && start > end) throw new ValidateException('商品评价时间范围错误');
  const endParts = end === undefined ? undefined : shanghaiParts(end);
  if (end !== undefined && (start === undefined || end === start || endParts?.hour === 0 && endParts.minute === 0 && endParts.second === 0)) end += 86400;
  if (end !== undefined && end > MAX_ID || start !== undefined && end !== undefined && start > end) throw new ValidateException('商品评价时间范围错误');
  // PHP's open upper range uses whereTime('<', end + one day), whereas a
  // complete range uses inclusive whereBetween with the same day adjustment.
  return { start, end, endExclusive: start === undefined && end !== undefined };
}
function anonymity(value: string): string {
  const chars = [...value.trim()];
  if (!chars.length) return '用户';
  return chars.length === 1 ? `${chars[0]}***` : `${chars[0]}***${chars.at(-1)}`;
}
function configValue(raw: string | undefined, fallback: unknown): unknown {
  if (raw === undefined) return fallback;
  // PHP SystemConfigServices decodes the persisted JSON value. TS also has
  // existing unquoted text configuration; retain that representation locally
  // without changing the shared raw-value DAO for other consumers.
  try { return JSON.parse(raw) as unknown; } catch { return raw; }
}
function configText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new ServiceUnavailableException('历史站点名称或头像配置格式异常，请核对数据');
  return value;
}
function configEnabled(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === '' || value === '0') return false;
  if (Array.isArray(value)) return value.length > 0;
  // PHP's json_decode(..., true) represents a JSON object as an associative
  // array, so an empty decoded object has the same falsey value as [].
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** Central Admin moderation intentionally covers all valid review owners. The
 * customer's immutable evidence stays on the parent; platform replies are
 * separate 0/0 comment rows and never overwrite merchant response snapshots. */
export class AdminProductReplyService {
  constructor(private readonly container: Container, private readonly appKey?: string) {}

  private async readActor(tx: DbClient, actor: AdminProductReplyActor): Promise<void> {
    const [live] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
    if (!live || live.adminType !== 1 || live.relationId !== 0 || live.status !== 1 || live.isDel !== 0
      || !Number.isInteger(live.level) || live.level < 0 || live.level > 9) throw new AuthException('管理员身份已变化', ApiErrorCode.ERR_BANNED);
    const encoder = new TextEncoder();
    if (!timingSafeEqual(encoder.encode(md5(live.pwd)), encoder.encode(actor.authVersion))) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
    await loadAdminLegacyRoleReferenceHistory(tx, parseAdminAuthorityRoleIds(live.roles), live.level);
    const { keys } = await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(live.roles);
    if (live.level !== 0 && !hasAdminPermission(keys, 'reply.view')) throw new AuthException('商品评价查看权限已变化', ApiErrorCode.ERR_AUTH);
    assertAdminAuthoritySession(actor);
  }
  private async transaction<T>(actor: AdminProductReplyActor, write: boolean, work: (tx: DbClient) => Promise<T>): Promise<T> {
    assertAdminAuthoritySession(actor);
    try {
      return await withTx(this.container, async tx => {
        let initial: typeof systemAdmin.$inferSelect | undefined;
        if (write) {
          await acquireAdminAuthorityWriteBarrier(tx);
          await loadAdminAuthorityLiveActor(tx, actor, 'reply.manage');
          [initial] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
        } else {
          await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
          await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
          await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
          await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
          await this.readActor(tx, actor);
        }
        const result = await work(tx);
        if (write) {
          await loadAdminAuthorityLiveActor(tx, actor, 'reply.manage');
          const [fresh] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
          if (!initial || !sameRow(fresh, initial)) throw new AuthException('管理员身份已变化', ApiErrorCode.ERR_AUTH);
        }
        const [clock] = await tx.execute(sql`SELECT extract(epoch from clock_timestamp()) >= ${actor.expiresAt} AS expired`) as unknown as Array<{ expired: boolean }>;
        if (clock?.expired !== false) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
        assertAdminAuthoritySession(actor);
        return result;
      });
    } catch (error) { return operationError(error); }
  }
  private async parent(tx: DbClient, id: number, write = false, allowDeleted = false): Promise<ReplyRow> {
    const query = tx.select().from(storeProductReply).where(and(eq(storeProductReply.id, id), allowDeleted ? undefined : eq(storeProductReply.isDel, 0))).limit(1);
    const [row] = await (write ? query.for('update') : query);
    if (!row) throw new NotFoundException('评论不存在或已删除');
    assertReply(row); return row;
  }
  private async thread(tx: DbClient, id: number, write = false): Promise<CommentRow[]> {
    const query = tx.select().from(storeProductReplyComment).where(eq(storeProductReplyComment.replyId, id)).orderBy(asc(storeProductReplyComment.id)).limit(MAX_THREAD + 1);
    const rows = await (write ? query.for('update') : query);
    if (rows.length > MAX_THREAD) throw new ServiceUnavailableException('商品回复线程超过2000项，请先整理数据');
    return rows;
  }
  private async verify(tx: DbClient, parent: ReplyRow, thread: CommentRow[]): Promise<void> {
    const [fresh] = await tx.select().from(storeProductReply).where(eq(storeProductReply.id, parent.id)).limit(1);
    if (!sameRow(fresh, parent) || !sameRows(await this.thread(tx, parent.id), thread)) throw new Error('商品评价完整业务回执核验失败');
  }
  private async audit(tx: DbClient, actor: AdminProductReplyActor, parentId: number, operation: string, method: string, commentId?: number): Promise<void> {
    const expected = { storeId: 0, merchantId: 0, adminName: '', ip: '', adminId: actor.id,
      path: `product/reply/${parentId}`, page: '商品评价管理', method, type: 'product_reply_moderation',
      action: JSON.stringify({ operation, id: parentId, ...(commentId === undefined ? {} : { commentId }) }), addTime: Math.floor(Date.now() / 1000) };
    const rows = await tx.insert(systemLog).values(expected).returning();
    const row = rows[0];
    const matches = (value: typeof row | undefined) => value && Number.isSafeInteger(value.id) && value.id > 0
      && Object.keys(value).length === Object.keys(expected).length + 1
      && Object.entries(expected).every(([key, expectedValue]) => value[key as keyof typeof value] === expectedValue);
    if (rows.length !== 1 || !matches(row)) throw new Error('商品评价审计回执不完整');
    const [fresh] = await tx.select().from(systemLog).where(eq(systemLog.id, row.id)).limit(1);
    if (!matches(fresh)) throw new Error('商品评价审计回读不一致');
  }
  private async savePlatformComment(tx: DbClient, parent: ReplyRow, thread: CommentRow[], pid: number, content: string): Promise<{ row: CommentRow; thread: CommentRow[] }> {
    const candidates = thread.filter(row => row.pid === pid && row.uid === 0 && row.isDel === 0);
    candidates.forEach(row => assertComment(row, parent));
    const existing = candidates.filter(row => row.type === 0 && row.relationId === 0);
    if (existing.length > 1) throw new ServiceUnavailableException('商品评价存在重复管理员回复，请先修复数据');
    const now = Math.floor(Date.now() / 1000);
    let receipt: CommentRow;
    if (existing[0]) {
      const before = existing[0], expected = { ...before, content, updateTime: now };
      const rows = await tx.update(storeProductReplyComment).set({ content, updateTime: now }).where(and(
        eq(storeProductReplyComment.id, before.id), eq(storeProductReplyComment.replyId, parent.id),
        eq(storeProductReplyComment.type, 0), eq(storeProductReplyComment.relationId, 0), eq(storeProductReplyComment.uid, 0),
        eq(storeProductReplyComment.pid, pid), eq(storeProductReplyComment.isDel, 0),
      )).returning();
      if (rows.length !== 1 || !sameRow(rows[0], expected)) throw new Error('商品回复更新回执不完整');
      receipt = expected;
    } else {
      const expected = { type: 0, relationId: 0, replyId: parent.id, pid, uid: 0, nickname: '', avatar: '', content,
        praise: 0, isDel: 0, addTime: now, updateTime: 0 };
      const rows = await tx.insert(storeProductReplyComment).values(expected).returning();
      const row = rows[0];
      if (rows.length !== 1 || !row || !Number.isSafeInteger(row.id) || row.id <= 0 || !sameRow(row, { id: row.id, ...expected })) throw new Error('商品回复新增回执不完整');
      receipt = row;
    }
    const [fresh] = await tx.select().from(storeProductReplyComment).where(eq(storeProductReplyComment.id, receipt.id)).limit(1);
    if (!sameRow(fresh, receipt)) throw new Error('商品回复写入回读不一致');
    const expectedThread = [...thread.filter(row => row.id !== receipt.id), receipt].sort((a, b) => a.id - b.id);
    if (!sameRows(await this.thread(tx, parent.id), expectedThread)) throw new Error('商品回复完整线程回读不一致');
    return { row: receipt, thread: expectedThread };
  }

  async list(query: URLSearchParams, actor: AdminProductReplyActor, legacy?: true): Promise<LegacyReplyList>;
  async list(query: URLSearchParams, actor: AdminProductReplyActor, legacy: false): Promise<ModernReplyItem[]>;
  async list(query: URLSearchParams, actor: AdminProductReplyActor, legacy: boolean): Promise<LegacyReplyList | ModernReplyItem[]>;
  async list(query: URLSearchParams, actor: AdminProductReplyActor, legacy = true): Promise<LegacyReplyList | ModernReplyItem[]> {
    const input = queryInput(query, ['is_reply', 'store_name', 'account', 'data', 'product_id', 'page', 'limit']);
    const { page, limit } = pagination(input, legacy ? 15 : 10);
    const keyword = filter(input.store_name), account = filter(input.account), bounds = timeBounds(input.data);
    let isReply: number | undefined;
    if (input.is_reply !== undefined && input.is_reply !== '') {
      if (!['0', '1'].includes(input.is_reply)) throw new ValidateException('商品评价回复状态错误');
      isReply = Number(input.is_reply);
    }
    const productId = input.product_id === undefined || input.product_id === '' ? 0 : replyId(input.product_id, true);
    return this.transaction(actor, false, async tx => {
      const filters: SQL[] = [eq(storeProductReply.isDel, 0)];
      if (isReply !== undefined) filters.push(eq(storeProductReply.isReply, isReply));
      if (productId) filters.push(eq(storeProductReply.productId, productId));
      if (keyword && keyword !== '0') filters.push(or(ilike(storeProduct.storeName, `%${keyword}%`), ilike(storeProduct.keyword, `%${keyword}%`),
        ilike(sql`${storeProductReply.id}::text`, `%${keyword}%`), ilike(sql`${storeProductReply.productId}::text`, `%${keyword}%`))!);
      if (account && account !== '0') filters.push(ilike(storeProductReply.nickname, `%${account}%`));
      if (bounds.start !== undefined) filters.push(gte(storeProductReply.addTime, bounds.start));
      if (bounds.end !== undefined) filters.push(bounds.endExclusive ? lt(storeProductReply.addTime, bounds.end) : lte(storeProductReply.addTime, bounds.end));
      const where = and(...filters);
      const [rows, counts] = await Promise.all([
        tx.select({ reply: storeProductReply, storeName: storeProduct.storeName, image: storeProduct.image }).from(storeProductReply)
          .leftJoin(storeProduct, eq(storeProduct.id, storeProductReply.productId)).where(where)
          .orderBy(desc(storeProductReply.addTime), asc(storeProductReply.isReply), desc(storeProductReply.id)).limit(limit).offset((page - 1) * limit),
        tx.select({ count: sql<number>`count(*)::integer` }).from(storeProductReply).leftJoin(storeProduct, eq(storeProduct.id, storeProductReply.productId)).where(where),
      ]);
      rows.forEach(item => assertReply(item.reply));
      if (!legacy) {
        const items = rows.map(({ reply }) => { const pics = decodePics(reply.pics); return { ...reply, pics: Array.isArray(pics) ? pics : [] }; });
        const media = await renderProductReplyMedia(tx, items, this.appKey);
        return items.map((item, index) => ({ ...item, avatar: media[index].avatar, pics: media[index].pics as unknown[] }));
      }
      const rootRows = rows.length ? await tx.select().from(storeProductReplyComment).where(and(inArray(storeProductReplyComment.replyId, rows.map(item => item.reply.id)),
        eq(storeProductReplyComment.uid, 0), eq(storeProductReplyComment.pid, 0), eq(storeProductReplyComment.isDel, 0))).orderBy(asc(storeProductReplyComment.id)).limit(MAX_THREAD + 1) : [];
      if (rootRows.length > MAX_THREAD) throw new ServiceUnavailableException('商品评价根回复超过2000项，请先整理数据');
      const list = rows.map(({ reply, storeName, image }) => {
        const root = platformRoot(rootRows.filter(row => row.replyId === reply.id), reply);
        return { ...legacyReplyDto(reply), store_name: storeName, image, account: reply.nickname, create_time: shanghai(reply.addTime),
          time: relativeTime(reply.addTime), score: String(Math.floor((reply.productScore + reply.serviceScore + reply.deliveryScore) / 3)), replyComment: root ? commentDto(root) : null };
      });
      const media = await renderProductReplyMedia(tx, list.map((item, index) => ({ ...rows[index].reply, avatar: item.avatar, pics: item.pics })), this.appKey);
      return { list: list.map((item, index) => ({ ...item, avatar: media[index].avatar, pics: media[index].pics })), count: counts[0]?.count ?? 0 };
    });
  }
  async getReply(id: number, query: URLSearchParams, actor: AdminProductReplyActor) {
    id = replyId(id); noQuery(query);
    return this.transaction(actor, false, async tx => {
      const parent = await this.parent(tx, id), root = platformRoot(await this.thread(tx, id), parent);
      return root ? commentDto(root) : { content: '' };
    });
  }
  async setReply(id: number, value: unknown, actor: AdminProductReplyActor) {
    id = replyId(id); const content = bodyContent(value);
    return this.transaction(actor, true, async tx => {
      let parent = await this.parent(tx, id, true);
      const thread = await this.thread(tx, id, true);
      platformRoot(thread, parent);
      const saved = await this.savePlatformComment(tx, parent, thread, 0, content);
      if (parent.type === 0) {
        const expected = { ...parent, isReply: 1 };
        const rows = await tx.update(storeProductReply).set({ isReply: 1 }).where(and(eq(storeProductReply.id, id),
          eq(storeProductReply.type, parent.type), eq(storeProductReply.relationId, parent.relationId), eq(storeProductReply.isDel, 0))).returning();
        if (rows.length !== 1 || !sameRow(rows[0], expected)) throw new Error('商品评价回复状态更新回执不完整');
        parent = expected;
      }
      await this.verify(tx, parent, saved.thread);
      await this.audit(tx, actor, id, 'set_reply', 'PUT', saved.row.id);
      await this.verify(tx, parent, saved.thread);
      return null;
    });
  }
  async remove(id: number, query: URLSearchParams, value: unknown, actor: AdminProductReplyActor, legacy = true) {
    id = replyId(id); noQuery(query); deletionInput(value, legacy);
    return this.transaction(actor, true, async tx => {
      const located = await this.parent(tx, id, false, true);
      const products = await lockReviewProducts(tx, [located.productId]);
      const parent = await this.parent(tx, id, true, true);
      if (parent.productId !== located.productId) throw new ServiceUnavailableException('评价商品归属已变化，请刷新后重试');
      const thread = await this.thread(tx, id, true), expected = { ...parent, isDel: 1 };
      const rows = await tx.update(storeProductReply).set({ isDel: 1 }).where(and(eq(storeProductReply.id, id), eq(storeProductReply.type, parent.type),
        eq(storeProductReply.relationId, parent.relationId), eq(storeProductReply.isDel, parent.isDel))).returning();
      if (rows.length !== 1 || !sameRow(rows[0], expected)) throw new Error('商品评价软删除回执不完整');
      await this.verify(tx, expected, thread);
      await this.audit(tx, actor, id, 'delete_reply', 'DELETE');
      await this.verify(tx, expected, thread);
      // PHP deletion changes membership but emits no product.reply event.
      // Serialize with creators without inventing a deletion rating refresh.
      const product = products.get(parent.productId);
      if (product) await verifyReviewProductSnapshot(tx, product);
      return null;
    });
  }
  async status(id: number, value: unknown, actor: AdminProductReplyActor) {
    id = replyId(id);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('商品评价状态正文必须是对象');
    const body = value as Record<string, unknown>;
    if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'status') || body.status !== 0 && body.status !== 1) throw new ValidateException('商品评价状态必须为0或1');
    const status = body.status;
    return this.transaction(actor, true, async tx => {
      const parent = await this.parent(tx, id, true), thread = await this.thread(tx, id, true), expected = { ...parent, status };
      const rows = await tx.update(storeProductReply).set({ status }).where(and(eq(storeProductReply.id, id), eq(storeProductReply.type, parent.type),
        eq(storeProductReply.relationId, parent.relationId), eq(storeProductReply.isDel, 0))).returning();
      if (rows.length !== 1 || !sameRow(rows[0], expected)) throw new Error('商品评价状态更新回执不完整');
      await this.verify(tx, expected, thread);
      await this.audit(tx, actor, id, 'status', 'POST');
      await this.verify(tx, expected, thread);
      return null;
    });
  }

  async comments(id: number, query: URLSearchParams, actor: AdminProductReplyActor) {
    id = replyId(id);
    const input = queryInput(query, ['time', 'page', 'limit']), { page, limit } = pagination(input, 15), bounds = timeBounds(input.time);
    return this.transaction(actor, false, async tx => {
      const parent = await this.parent(tx, id);
      const where = and(eq(storeProductReplyComment.replyId, id), eq(storeProductReplyComment.pid, 0), ne(storeProductReplyComment.uid, 0),
        eq(storeProductReplyComment.isDel, 0), bounds.start === undefined ? undefined : gte(storeProductReplyComment.addTime, bounds.start),
        bounds.end === undefined ? undefined : bounds.endExclusive ? lt(storeProductReplyComment.addTime, bounds.end) : lte(storeProductReplyComment.addTime, bounds.end));
      const [roots, counts] = await Promise.all([
        tx.select().from(storeProductReplyComment).where(where).orderBy(desc(storeProductReplyComment.praise), desc(storeProductReplyComment.addTime), desc(storeProductReplyComment.id)).limit(limit).offset((page - 1) * limit),
        tx.select({ count: sql<number>`count(*)::integer` }).from(storeProductReplyComment).where(where),
      ]);
      roots.forEach(row => assertComment(row, parent));
      const children = roots.length ? await tx.select().from(storeProductReplyComment).where(and(inArray(storeProductReplyComment.pid, roots.map(row => row.id)),
        eq(storeProductReplyComment.isDel, 0))).orderBy(asc(storeProductReplyComment.id)).limit(MAX_THREAD + 1) : [];
      if (children.length > MAX_THREAD) throw new ServiceUnavailableException('商品评论直属回复超过2000项，请先整理数据');
      children.forEach(row => assertComment(row, parent));
      if (roots.some(root => children.filter(row => row.pid === root.id).length > 1)) throw new ServiceUnavailableException('商品评论存在重复直属回复，请先修复数据');
      const uids = [...new Set([...roots, ...children].map(row => row.uid).filter(id => id > 0))];
      const [users, config] = await Promise.all([
        uids.length ? tx.select({ uid: user.uid, nickname: user.nickname, avatar: user.avatar, isMoneyLevel: user.isMoneyLevel, level: user.level, overdueTime: user.overdueTime }).from(user).where(inArray(user.uid, uids)) : [],
        createContainerFromDb(tx).systemConfigDao.getValues(['site_name', 'site_logo_square', 'member_func_status', 'member_card_status']),
      ]);
      const levels = users.length ? await tx.select({ id: systemUserLevel.id, grade: systemUserLevel.grade }).from(systemUserLevel).where(and(
        inArray(systemUserLevel.id, [...new Set(users.map(row => row.level))]), eq(systemUserLevel.isShow, 1), eq(systemUserLevel.isDel, 0))) : [];
      const userMap = new Map(users.map(row => [row.uid, row])), levelMap = new Map(levels.map(row => [row.id, row.grade]));
      const now = Math.floor(Date.now() / 1000);
      const siteName = configValue(config.site_name, ''), siteLogo = configValue(config.site_logo_square, '');
      const levelsEnabled = configEnabled(configValue(config.member_func_status, 0));
      const paidEnabled = configEnabled(configValue(config.member_card_status, 0));
      type UserDto = { uid?: number; avatar?: string; nickname?: string; is_money_level?: number };
      const userDto = (row: CommentRow): UserDto | null => {
        const current = userMap.get(row.uid);
        return current ? { uid: current.uid, avatar: current.avatar, nickname: current.nickname, is_money_level: current.isMoneyLevel }
          : row.uid === 0 ? { avatar: configText(siteLogo), nickname: configText(siteName) } : null;
      };
      const rootUserDto = (row: CommentRow) => {
        const current = userMap.get(row.uid), base = userDto(row) ?? {};
        if (base.nickname !== undefined) base.nickname = anonymity(base.nickname);
        return { ...base, level_name: current && levelsEnabled ? levelMap.get(current.level) ?? '' : '',
          vip_status: current ? paidEnabled && current.isMoneyLevel > 0 && current.overdueTime > now ? 1 : 0 : '' };
      };
      return { list: roots.map(root => {
        const child = children.find(row => row.pid === root.id);
        return { ...commentDto(root), user: rootUserDto(root), productRelation: null, is_praise: false,
          children: child ? { ...commentDto(child), user: userDto(child), productRelation: null, is_praise: false } : null };
      }), count: counts[0]?.count ?? 0 };
    });
  }
  async saveComment(parentId: number, id: number, value: unknown, actor: AdminProductReplyActor) {
    parentId = replyId(parentId); id = replyId(id); const content = bodyContent(value, true);
    return this.transaction(actor, true, async tx => {
      const parent = await this.parent(tx, parentId, true), thread = await this.thread(tx, parentId, true);
      const root = thread.find(row => row.id === id && row.pid === 0 && row.uid > 0 && row.isDel === 0);
      if (!root) throw new NotFoundException('用户根评论不存在或不属于当前评价');
      assertComment(root, parent);
      const children = await tx.select().from(storeProductReplyComment).where(eq(storeProductReplyComment.pid, id)).orderBy(asc(storeProductReplyComment.id)).limit(MAX_THREAD + 1);
      if (children.length > MAX_THREAD) throw new ServiceUnavailableException('商品评论直属回复超过2000项，请先整理数据');
      children.forEach(row => assertComment(row, parent));
      const active = children.filter(row => row.isDel === 0);
      if (active.length > 1 || active.some(row => row.uid !== 0 || row.type !== 0 || row.relationId !== 0)) {
        throw new ServiceUnavailableException('商品评论已有其他直属回复，不能生成歧义管理员孩子，请先核对数据');
      }
      const saved = await this.savePlatformComment(tx, parent, thread, id, content);
      await this.verify(tx, parent, saved.thread);
      await this.audit(tx, actor, parentId, 'save_comment', 'POST', saved.row.id);
      await this.verify(tx, parent, saved.thread);
      return null;
    });
  }
  async removeComment(id: number, query: URLSearchParams, value: unknown, actor: AdminProductReplyActor) {
    id = replyId(id); noQuery(query); deletionInput(value, true);
    return this.transaction(actor, true, async tx => {
      // Read only to discover the parent, then acquire the parent row before
      // locking any comment. Recheck membership after those locks are held.
      const [locator] = await tx.select({ replyId: storeProductReplyComment.replyId }).from(storeProductReplyComment).where(eq(storeProductReplyComment.id, id)).limit(1);
      if (!locator) throw new NotFoundException('商品回复不存在');
      const parent = await this.parent(tx, replyId(locator.replyId), true, true), thread = await this.thread(tx, parent.id, true);
      const target = thread.find(row => row.id === id);
      if (!target) throw new NotFoundException('商品回复已变化，请刷新后重试');
      assertComment(target, parent);
      // Deletion does not create a link: PHP removes any exact comment and its
      // direct children. Deep or orphaned historical targets remain cleanable.
      const children = await tx.select().from(storeProductReplyComment).where(eq(storeProductReplyComment.pid, id)).orderBy(asc(storeProductReplyComment.id)).limit(MAX_THREAD + 1);
      if (children.length > MAX_THREAD) throw new ServiceUnavailableException('商品评论直属回复超过2000项，请先整理数据');
      children.forEach(row => assertComment(row, parent));
      const deleting = thread.filter(row => row.id === id || row.pid === id), ids = deleting.map(row => row.id);
      const rows = await tx.delete(storeProductReplyComment).where(and(inArray(storeProductReplyComment.id, ids), eq(storeProductReplyComment.replyId, parent.id))).returning();
      rows.sort((a, b) => a.id - b.id);
      if (!sameRows(rows, deleting)) throw new Error('商品评论删除回执不完整');
      const remaining = thread.filter(row => !ids.includes(row.id));
      await this.verify(tx, parent, remaining);
      const [residual] = await tx.select({ id: storeProductReplyComment.id }).from(storeProductReplyComment).where(or(inArray(storeProductReplyComment.id, ids), eq(storeProductReplyComment.pid, id))).limit(1);
      if (residual) throw new Error('商品评论删除回读仍有目标或直属孩子');
      await this.audit(tx, actor, parent.id, 'delete_comment', 'DELETE', id);
      await this.verify(tx, parent, remaining);
      const [afterAudit] = await tx.select({ id: storeProductReplyComment.id }).from(storeProductReplyComment).where(or(inArray(storeProductReplyComment.id, ids), eq(storeProductReplyComment.pid, id))).limit(1);
      if (afterAudit) throw new Error('商品评论审计后删除核验失败');
      return null;
    });
  }
}
