import { asc, eq, inArray } from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import { storeActivity, storeSeckill, storeSeckillTime } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

const DAY = 86_400_000;
const SHANGHAI_OFFSET = 8 * 3_600_000;
const MAX_SLOTS = 64;
type Child = Pick<typeof storeSeckill.$inferSelect, "id" | "activityId" | "productId" | "status" | "isShow" | "isDel" | "timeId" | "startTime" | "stopTime">;
type Parent = Pick<typeof storeActivity.$inferSelect, "id" | "type" | "status" | "isDel" | "startDay" | "endDay" | "timeId">;
type Slot = Pick<typeof storeSeckillTime.$inferSelect, "id" | "status" | "startTime" | "endTime">;
export interface SeckillScheduleSnapshot { child: Child; parent: Parent | null; slots: Slot[] }
export interface SeckillScheduleState {
  state: "active" | "future" | "ended" | "waiting" | "unavailable" | "invalid";
  message: string;
  startsAt: number | null;
  endsAt: number | null;
  activeSlotIds: number[];
}

export function seckillSlotIds(value: string | null): number[] {
  if (!value || value.length > 1_024) throw new ValidateException("秒杀时段配置无效");
  const values = value.split(",");
  if (values.length > MAX_SLOTS) throw new ValidateException("秒杀时段超过64项");
  const ids = values.map(part => {
    const raw = part.trim();
    if (!/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2_147_483_647) throw new ValidateException("秒杀时段配置无效");
    return Number(raw);
  });
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** PHP stores HHmm; the TS editor/schema also accepts HH:mm. End=24:00 denotes next midnight. */
export function seckillSlotMinutes(value: string, end = false): number {
  const match = /^(\d{2}):?(\d{2})$/.exec(value);
  if (!match) throw new ValidateException("秒杀时段时间格式无效");
  const hours = Number(match[1]), minutes = Number(match[2]);
  if (minutes > 59 || hours > 23 && !(end && hours === 24 && minutes === 0)) throw new ValidateException("秒杀时段时间格式无效");
  return hours * 60 + minutes;
}

function midnight(ms: number): boolean { return (ms + SHANGHAI_OFFSET) % DAY === 0; }
/** Legacy section_time is date-only/inclusive; non-midnight TS values remain precise instants. */
export function seckillDateEnd(value: Date | null): number {
  if (value === null) return Infinity;
  const ms = value.getTime();
  if (!Number.isFinite(ms)) throw new ValidateException("秒杀日期配置无效");
  return ms + (midnight(ms) ? DAY : 1);
}

export function evaluateSeckillSchedule(snapshot: SeckillScheduleSnapshot, now: Date): SeckillScheduleState {
  const result = (state: SeckillScheduleState["state"], message: string, startsAt: number | null = null, endsAt: number | null = null,
    activeSlotIds: number[] = []): SeckillScheduleState => ({ state, message, startsAt, endsAt, activeSlotIds });
  try {
    const clock = now.getTime(), { child, parent } = snapshot;
    if (!Number.isFinite(clock)) throw new ValidateException("秒杀查询时间无效");
    if (child.status !== 1 || child.isShow !== 1 || child.isDel !== 0) return result("unavailable", "秒杀商品已下架");
    let start = child.startTime?.getTime() ?? -Infinity, end = seckillDateEnd(child.stopTime);
    if (Number.isNaN(start) || start >= end) throw new ValidateException("秒杀日期配置无效");
    let ids = seckillSlotIds(child.timeId);
    if (child.activityId !== 0) {
      if (!parent || parent.id !== child.activityId || parent.type !== 1 || parent.status !== 1 || parent.isDel !== 0) {
        return result("unavailable", "秒杀父活动不存在或已停用");
      }
      if (!Number.isSafeInteger(parent.startDay) || !Number.isSafeInteger(parent.endDay) || parent.startDay <= 0 || parent.endDay < parent.startDay ||
        !midnight(parent.startDay * 1_000) || !midnight(parent.endDay * 1_000)) throw new ValidateException("秒杀父活动日期配置无效");
      start = Math.max(start, parent.startDay * 1_000); end = Math.min(end, parent.endDay * 1_000 + DAY);
      const parentIds = new Set(seckillSlotIds(parent.timeId));
      ids = ids.filter(id => parentIds.has(id));
      if (!ids.length || start >= end) throw new ValidateException("秒杀父子排期配置不一致");
    }
    const permitted = new Set(ids), seen = new Set<number>();
    const slots = snapshot.slots.filter(slot => permitted.has(slot.id) && slot.status === 1).map(slot => {
      if (seen.has(slot.id)) throw new ValidateException("秒杀时段标识重复");
      seen.add(slot.id);
      const from = seckillSlotMinutes(slot.startTime), to = seckillSlotMinutes(slot.endTime, true);
      if (from >= to) throw new ValidateException("跨午夜秒杀请拆为两个时段");
      return { id: slot.id, from, to };
    });
    if (!slots.length) return result("unavailable", "秒杀没有有效的启用时段");
    if (clock < start) return result("future", "秒杀尚未开始");
    if (clock >= end) return result("ended", "秒杀已结束");
    const dayStart = Math.floor((clock + SHANGHAI_OFFSET) / DAY) * DAY - SHANGHAI_OFFSET;
    const windows = slots.map(slot => ({ id: slot.id, start: Math.max(start, dayStart + slot.from * 60_000),
      end: Math.min(end, dayStart + slot.to * 60_000) })).filter(window => window.start < window.end);
    const active = windows.filter(window => clock >= window.start && clock < window.end);
    if (active.length) return result("active", "秒杀进行中", Math.min(...active.map(window => window.start)),
      Math.max(...active.map(window => window.end)), active.map(window => window.id).sort((a, b) => a - b));
    const future = windows.filter(window => window.start > clock).sort((a, b) => a.start - b.start);
    return future[0] ? result("future", "本场秒杀尚未开始", future[0].start, future[0].end)
      : result("waiting", "当前不在秒杀时段");
  } catch (error) {
    if (error instanceof ValidateException) return result("invalid", error.message);
    throw error;
  }
}

export function assertSeckillSchedule(snapshot: SeckillScheduleSnapshot, now = new Date()) {
  const state = evaluateSeckillSchedule(snapshot, now);
  if (state.state !== "active") throw new ValidateException(state.message);
  return state;
}

const childFields = { id: storeSeckill.id, activityId: storeSeckill.activityId, productId: storeSeckill.productId,
  status: storeSeckill.status, isShow: storeSeckill.isShow, isDel: storeSeckill.isDel,
  timeId: storeSeckill.timeId, startTime: storeSeckill.startTime, stopTime: storeSeckill.stopTime };
const parentFields = { id: storeActivity.id, type: storeActivity.type, status: storeActivity.status, isDel: storeActivity.isDel,
  startDay: storeActivity.startDay, endDay: storeActivity.endDay, timeId: storeActivity.timeId };
const slotFields = { id: storeSeckillTime.id, status: storeSeckillTime.status, startTime: storeSeckillTime.startTime, endTime: storeSeckillTime.endTime };

/** locked=true is ONLY for the caller's existing transaction. Parent -> child -> sorted time slots.
 * Reparenting between discovery and locks fails, rather than locking a second parent out of order.
 */
export async function loadSeckillSchedule(db: Pick<DbClient, "select">, id: number, locked = false): Promise<SeckillScheduleSnapshot> {
  if (!Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647) throw new ValidateException("秒杀商品ID无效");
  const [initial] = await db.select(childFields).from(storeSeckill).where(eq(storeSeckill.id, id)).limit(1);
  if (!initial) throw new ValidateException("秒杀商品不存在");
  let parent: Parent | null = null;
  if (initial.activityId !== 0) {
    const query = db.select(parentFields).from(storeActivity).where(eq(storeActivity.id, initial.activityId)).limit(1);
    parent = (await (locked ? query.for("share") : query))[0] ?? null;
  }
  const child = locked ? (await db.select(childFields).from(storeSeckill).where(eq(storeSeckill.id, id)).limit(1).for("update"))[0] : initial;
  if (!child || child.activityId !== initial.activityId) throw new ValidateException("秒杀排期已变化，请重试");
  let ids: number[];
  try {
    ids = seckillSlotIds(child.timeId);
    if (parent) { const parentIds = new Set(seckillSlotIds(parent.timeId)); ids = ids.filter(id => parentIds.has(id)); }
  } catch (error) {
    if (error instanceof ValidateException) return { child, parent, slots: [] };
    throw error;
  }
  if (!ids.length) return { child, parent, slots: [] };
  const query = db.select(slotFields).from(storeSeckillTime).where(inArray(storeSeckillTime.id, ids)).orderBy(asc(storeSeckillTime.id)).limit(MAX_SLOTS);
  return { child, parent, slots: await (locked ? query.for("share") : query) };
}
