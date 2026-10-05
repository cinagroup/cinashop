import { and, desc, eq, getTableColumns, ilike, ne, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeActivity, storeSeckill, storeSeckillTime, systemLog } from '@/models/schema';
import { seckillDayStart, seckillSlotMinutes } from '@/services/activity/SeckillScheduleService';
import { publicSeckillTimePictures, renderSeckillTimePictures, seckillTimePicture } from '@/services/activity/SeckillTimeAssetPolicy';
import { acquireSeckillTimeReferenceLock } from '@/migrations/seckillTimeReferenceLock';
import { NotFoundException, ValidateException } from '@/utils/errors';

const maximum = 2_147_483_647;
// Match the purchase parser's ECMAScript trim set, including tab/NBSP.
const TRIM = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
export const SECKILL_TIME_LOCK_NAMESPACE = 731_643;
export const SECKILL_TIME_LOCK_KEY = 1;
const MAX_VISIBLE_SLOTS = 1000; // Existing public getAll() consumer's limit.
const columns = { ...getTableColumns(storeSeckillTime), version: sql<string>`xmin::text` };
type SlotRow = typeof storeSeckillTime.$inferSelect & { version: string };
type Input = { title: string; startTime: string; endTime: string; pic: string; describe: string; status: number };
export type SeckillTimeOperation = 'create' | 'update' | 'status' | 'delete';

function idValue(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^[1-9]\d{0,9}$/.test(String(value))) throw new ValidateException('秒杀时段ID错误');
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id > maximum) throw new ValidateException('秒杀时段ID错误');
  return id;
}
function flag(value: unknown) {
  if (value !== 0 && value !== 1) throw new ValidateException('时段状态必须是0或1');
  return value;
}
function text(value: unknown, label: string, maximum = 255, required = true): string {
  if (typeof value !== 'string' || value.length > maximum * 2 || /[\u0000-\u001f\u007f]/.test(value)) throw new ValidateException(`${label}格式错误`);
  const result = value.trim();
  if ((required && !result) || [...result].length > maximum) throw new ValidateException(`${label}须为${required ? '1' : '0'}至${maximum}个字符`);
  return result;
}
function time(value: unknown, end = false, legacy = false): string {
  if (typeof value !== 'string' || !(legacy ? /^\d{2}:?\d{2}$/ : /^\d{2}:\d{2}$/).test(value)) throw new ValidateException('时段时间须为HH:mm');
  const minutes = seckillSlotMinutes(value, end);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
function parseInput(raw: Record<string, unknown>, legacy = false): Input {
  const startTime = time(raw.start_time, false, legacy), endTime = time(raw.end_time, true, legacy);
  if (seckillSlotMinutes(startTime) >= seckillSlotMinutes(endTime, true)) throw new ValidateException('结束时间必须大于开始时间，跨午夜请拆为两个时段');
  return { title: text(raw.title, '标题'), startTime, endTime, pic: seckillTimePicture(raw.pic), describe: text(raw.describe, '描述'), status: flag(raw.status) };
}
function rowInput(row: SlotRow) { return { title: row.title, start_time: row.startTime, end_time: row.endTime, pic: row.pic, describe: row.describe, status: row.status }; }
async function hash(value: unknown) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function safeTime(value: string, end = false) {
  try { return time(value, end, true); } catch { return value; }
}
function damagedTime(row: SlotRow) {
  try { return seckillSlotMinutes(row.startTime) >= seckillSlotMinutes(row.endTime, true); } catch { return true; }
}
async function project(row: SlotRow, allowedPic: string) {
  let valid = true, pic = '';
  try { parseInput(rowInput(row), true); } catch { valid = false; }
  pic = allowedPic;
  if (!pic) valid = false;
  return { id: row.id, title: row.title ?? '', start_time: safeTime(row.startTime), end_time: safeTime(row.endTime, true),
    pic, describe: row.describe, status: row.status === 1 ? 1 : 0, valid, revision: await hash(row) };
}
async function deadlines(db: DbClient) {
  await db.execute(sql`SELECT set_config('statement_timeout',
    LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms',true),
    set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`);
}
function parseQuery(query: URLSearchParams) {
  const allowed = new Set(['page', 'limit', 'status', 'title']);
  for (const key of query.keys()) if (!allowed.has(key) || query.getAll(key).length !== 1) throw new ValidateException('不支持或重复的秒杀时段查询参数');
  const page = query.has('page') ? idValue(query.get('page')) : 1;
  const limit = query.has('limit') ? idValue(query.get('limit')) : 20;
  const offset = (page - 1) * limit;
  if (limit > 100 || offset > 10_000) throw new ValidateException('秒杀时段分页超出范围');
  const status = query.get('status') || 'all';
  if (!['all', '0', '1'].includes(status)) throw new ValidateException('秒杀时段状态错误');
  return { page, limit, offset, status, title: text(query.get('title') ?? '', '查询标题', 100, false) };
}
// CASE prevents malformed legacy strings from reaching an integer cast.
function numericTime(column: SQLWrapper, end = false): SQL<number | null> {
  const pattern = end ? '^(([01][0-9]|2[0-3]):?[0-5][0-9]|24:?00)$' : '^([01][0-9]|2[0-3]):?[0-5][0-9]$';
  return sql`CASE WHEN ${column} ~ ${pattern} THEN replace(${column},':','')::integer ELSE NULL END`;
}

/** A dedicated daily Shanghai slot catalogue. It never edits parent/child
 * schedules, stock, prices, orders, assets, or permission grants. */
export class AdminSeckillTimeService {
  constructor(private readonly container: Container, private readonly appKey?: string) {}

  private async previews<T extends { pic: string }>(rows: T[]) {
    const signed = rows.length ? await renderSeckillTimePictures(this.appKey, rows.map(row => row.pic)) : [];
    return rows.map((row, index) => ({ ...row, pic_preview: signed[index] ?? '' }));
  }

  async list(parameters: URLSearchParams) {
    const query = parseQuery(parameters);
    const predicate = and(query.status === 'all' ? undefined : eq(storeSeckillTime.status, Number(query.status)),
      query.title ? ilike(storeSeckillTime.title, `%${query.title.replace(/[\\%_]/g, '\\$&')}%`) : undefined);
    const result = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await deadlines(tx);
      const rows = await tx.select(columns).from(storeSeckillTime).where(predicate)
        .orderBy(sql`${numericTime(storeSeckillTime.startTime)} ASC NULLS LAST`, desc(storeSeckillTime.id)).limit(query.limit).offset(query.offset);
      const [total] = await tx.select({ count: sql<number>`count(*)::integer` }).from(storeSeckillTime).where(predicate);
      const pictures = await publicSeckillTimePictures(tx, rows.map(row => row.pic));
      return { list: await Promise.all(rows.map((row, index) => project(row, pictures[index]))), count: total.count, page: query.page, limit: query.limit };
    });
    return { ...result, list: await this.previews(result.list) };
  }

  async detail(value: unknown) {
    const id = idValue(value);
    const row = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await deadlines(tx);
      const [row] = await tx.select(columns).from(storeSeckillTime).where(eq(storeSeckillTime.id, id)).limit(1);
      if (!row) throw new NotFoundException('秒杀时段不存在');
      return project(row, (await publicSeckillTimePictures(tx, [row.pic]))[0]);
    });
    return (await this.previews([row]))[0];
  }

  async mutate(operation: SeckillTimeOperation, value: unknown, raw: Record<string, unknown>, actor: { id: number }) {
    idValue(actor?.id);
    const id = operation === 'create' ? 0 : idValue(value);
    const allowed = new Set(['request_id', ...(operation === 'create' ? [] : ['revision']),
      ...(operation === 'delete' ? [] : operation === 'status' ? ['status'] : ['title', 'start_time', 'end_time', 'pic', 'describe', 'status'])]);
    if (Object.keys(raw).some(key => !allowed.has(key))) throw new ValidateException('不支持的秒杀时段写入字段');
    if (typeof raw.request_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(raw.request_id)) throw new ValidateException('请求标识必须是UUID');
    if (operation !== 'create' && (typeof raw.revision !== 'string' || !/^[a-f0-9]{64}$/.test(raw.revision))) throw new ValidateException('时段版本无效，请刷新后重新确认');
    const input = operation === 'create' || operation === 'update' ? parseInput(raw) : null;
    const status = operation === 'status' ? flag(raw.status) : input?.status;
    const fingerprint = await hash({ operation, id, revision: raw.revision ?? null, input, status: status ?? null });
    const replayPath = `/activity/seckill-times/request/${raw.request_id}`;
    return withTx(this.container, async tx => {
      const [isolation] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation`);
      if (isolation?.isolation !== 'read committed') throw new ValidateException('时段写入需要READ COMMITTED事务，请重新发起操作');
      await deadlines(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SECKILL_TIME_LOCK_NAMESPACE},${SECKILL_TIME_LOCK_KEY})`);
      const journal = await tx.select({ action: systemLog.action }).from(systemLog)
        .where(and(eq(systemLog.adminId, actor.id), eq(systemLog.type, 'seckill_time'), eq(systemLog.path, replayPath))).orderBy(desc(systemLog.id)).limit(2);
      if (journal.length) {
        const match = /^([a-z]+);id=([1-9]\d{0,9});payload=([a-f0-9]{64})$/.exec(journal[0].action);
        if (journal.length !== 1 || !match || match[1] !== operation || match[3] !== fingerprint) throw new ValidateException('请求标识已用于其他秒杀时段操作');
        return { id: idValue(match[2]) };
      }
      // Buying holds parent SHARE -> child UPDATE -> sorted slot SHARE. An
      // EXCLUSIVE relation fence conflicts with its ROW SHARE locks, while
      // ordinary browsing SELECT remains available. Lock parent then child
      // BEFORE any slot row: a buyer can finish without a slot->parent cycle.
      // This also closes reference phantom races from legacy child writers.
      // Editing/status never wait on parent/child after taking a slot lock,
      // so their ordinary slot UPDATE lock preserves the purchase decision.
      if (operation === 'delete') await acquireSeckillTimeReferenceLock(tx);
      const row = id ? (await tx.select(columns).from(storeSeckillTime).where(eq(storeSeckillTime.id, id)).limit(1).for('update'))[0] : undefined;
      if (id && !row) throw new NotFoundException('秒杀时段不存在');
      if (row && await hash(row) !== raw.revision) throw new ValidateException('时段已更新，请刷新后重新确认');
      if (status === 1 && (!row || row.status !== 1)) {
        const [visible] = await tx.select({ count: sql<number>`count(*)::integer` }).from(storeSeckillTime).where(eq(storeSeckillTime.status, 1));
        if (visible.count >= MAX_VISIBLE_SLOTS) throw new ValidateException('最多显示1000个秒杀时段，请先隐藏其他时段');
      }
      const candidate = input ?? (operation === 'status' && status === 1 && row ? parseInput({ ...rowInput(row), status: 1 }, true) : null);
      if (candidate) {
        if (!(await publicSeckillTimePictures(tx, [candidate.pic], true))[0]) throw new ValidateException('图片不属于平台图片素材，请重新选择');
        const start = numericTime(storeSeckillTime.startTime), end = numericTime(storeSeckillTime.endTime, true);
        const from = Number(candidate.startTime.replace(':', '')), to = Number(candidate.endTime.replace(':', ''));
        const [invalid] = await tx.select({ id: storeSeckillTime.id }).from(storeSeckillTime)
          .where(and(ne(storeSeckillTime.id, id), sql`${start} IS NULL OR ${end} IS NULL OR ${start} >= ${end}`)).limit(1);
        // Several damaged referenced rows cannot be deleted safely. Explicit
        // hidden repair can restore one range at a time, never turn it on or
        // excuse a new/previously valid range. Known hidden ranges still count.
        const repairingHidden = operation === 'update' && row && damagedTime(row) && candidate.status === 0;
        if (invalid && !repairingHidden) throw new ValidateException(`时段${invalid.id}时间损坏，请先修复或删除后再设置时间`);
        const [overlap] = await tx.select({ id: storeSeckillTime.id }).from(storeSeckillTime)
          .where(and(ne(storeSeckillTime.id, id), sql`${start} < ${to} AND ${end} > ${from}`)).limit(1);
        if (overlap) throw new ValidateException('秒杀时间段不可重叠（含隐藏时段）');
      }
      if (operation === 'delete' && row) await assertUnoccupied(tx, row);
      let resultId = id;
      if (input) {
        if (operation === 'create') {
          const [created] = await tx.insert(storeSeckillTime).values({ ...input, addTime: Math.floor(Date.now() / 1000) }).returning({ id: storeSeckillTime.id });
          resultId = created.id;
        } else await tx.update(storeSeckillTime).set(input).where(eq(storeSeckillTime.id, id));
      } else if (operation === 'status') await tx.update(storeSeckillTime).set({ status: status! }).where(eq(storeSeckillTime.id, id));
      else await tx.delete(storeSeckillTime).where(eq(storeSeckillTime.id, id));
      await tx.insert(systemLog).values({ adminId: actor.id, type: 'seckill_time', path: replayPath,
        method: operation === 'create' ? 'POST' : operation === 'delete' ? 'DELETE' : 'PUT',
        action: `${operation};id=${resultId};payload=${fingerprint}`, addTime: Math.floor(Date.now() / 1000) });
      return { id: resultId };
    });
  }
}

async function assertUnoccupied(tx: DbClient, row: SlotRow) {
  const now = new Date(), today = Math.floor(seckillDayStart(now) / 1000);
  // Literal tokens preserve exact identity (1 is not 11), including legacy
  // whitespace, without casting untrusted reference text to integers.
  const referenced = (column: typeof storeActivity.timeId | typeof storeSeckill.timeId) => sql`EXISTS
    (SELECT 1 FROM unnest(string_to_array(coalesce(${column},''),',')) AS referenced(token) WHERE btrim(token,${TRIM}) = ${String(row.id)})`;
  let oldPair: SQL = sql`false`;
  try {
    const from = Number(time(row.startTime, false, true).replace(':', '')), to = Number(time(row.endTime, true, true).replace(':', ''));
    oldPair = sql`${storeActivity.startTime} = ${from} AND ${storeActivity.endTime} = ${to}`;
  } catch { /* A corrupt slot has no trustworthy time pair; ID references still protect it. */ }
  const [parent] = await tx.select({ id: storeActivity.id }).from(storeActivity).where(and(eq(storeActivity.type, 1), eq(storeActivity.isDel, 0),
    sql`(${storeActivity.endDay} >= ${today} OR ${storeActivity.endDay} <= 0 OR ${storeActivity.startDay} <= 0
      OR ${storeActivity.endDay} < ${storeActivity.startDay}
      OR (${storeActivity.endDay}::bigint + 28800) % 86400 <> 0 OR (${storeActivity.startDay}::bigint + 28800) % 86400 <> 0)`,
    sql`(${referenced(storeActivity.timeId)} OR (${oldPair}))`)).limit(1);
  if (parent) throw new ValidateException('已有未结束秒杀父活动占用此时段，不可删除（含隐藏或未开始活动）');
  // Child-only legacy activities and inconsistent parent/child assignments
  // must not become dangling references. Hidden/disabled items can resume.
  const [child] = await tx.select({ id: storeSeckill.id }).from(storeSeckill).where(and(eq(storeSeckill.isDel, 0), referenced(storeSeckill.timeId),
    sql`(${storeSeckill.stopTime} IS NULL OR NOT isfinite(${storeSeckill.stopTime})
      OR ${storeSeckill.stopTime} + interval '0.001 second' > ${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'
      OR ${storeSeckill.stopTime} = to_timestamp(${today}) AT TIME ZONE 'UTC')`)).limit(1);
  if (child) throw new ValidateException('已有未结束秒杀商品占用此时段，不可删除（含隐藏或停用商品）');
}
