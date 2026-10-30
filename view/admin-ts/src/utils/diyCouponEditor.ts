import { DIY_COUPON_DEFAULTS } from './diyCouponDefaults';
import { NAVIGATION_BODY_NAMES, navigationDocument, navigationRecord, navRead, navSet, navTimestamp, navFlag, navText } from './diyNavigationEditor';

export const COUPON_NAMES = ['coupon'] as const;
export type CouponKind = typeof COUPON_NAMES[number];
export type CouponRecord = Record<string, unknown>;
export const couponLabels: Record<CouponKind, string> = { coupon: '优惠券' };
export const couponKind = (value: unknown): CouponKind | null => value === 'coupon' ? 'coupon' : null;
export const couponRecord = navigationRecord;
export const couponDocument = navigationDocument;
export const couponRead = navRead;
export const couponFlag = navFlag;
export const couponText = navText;

export function couponEntries(value: unknown[]) {
  return value.flatMap((row, index) => couponKind(couponRecord(row)?.name) ? [{ index, kind: 'coupon' as const }] : [])
    .sort((a, b) => navTimestamp(value[a.index]) - navTimestamp(value[b.index]) || a.index - b.index);
}

/** Defaults belong exclusively to explicit creation, never imports. */
export function newCouponBlock(timestamp: number): CouponRecord {
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > Number.MAX_SAFE_INTEGER) throw Error('组件排序值无效');
  const block: CouponRecord = structuredClone(DIY_COUPON_DEFAULTS);
  block.timestamp = timestamp;
  return block;
}

export function addCouponBlock(value: unknown[]): { value: unknown[]; selected: number } {
  const copy = structuredClone(value);
  const times = copy.filter(row => NAVIGATION_BODY_NAMES.includes(couponRecord(row)?.name as typeof NAVIGATION_BODY_NAMES[number]))
    .map(row => Number(couponRecord(row)?.timestamp)).filter(Number.isFinite);
  const maximum = Math.max(0, ...times), timestamp = maximum + Math.max(1, Math.abs(maximum) * Number.EPSILON * 2);
  if (!Number.isFinite(timestamp) || timestamp <= maximum || timestamp > Number.MAX_SAFE_INTEGER) throw Error('排序空间不足，请先在装修 JSON 中明确调整');
  const footer = copy.findIndex(row => String(couponRecord(row)?.name).toLowerCase() === 'pagefoot');
  const selected = footer < 0 ? copy.length : footer;
  copy.splice(selected, 0, newCouponBlock(timestamp));
  couponDocument(JSON.stringify(copy));
  return { value: copy, selected };
}

export function moveCouponBlock(value: unknown[], selected: number, direction: number): { value: unknown[]; selected: number } {
  if (!couponKind(couponRecord(value[selected])?.name) || ![-1, 1].includes(direction)) throw Error('未选择优惠券或移动方向无效');
  const indices = value.map((_, index) => index)
    .filter(index => NAVIGATION_BODY_NAMES.includes(couponRecord(value[index])?.name as typeof NAVIGATION_BODY_NAMES[number]))
    .sort((a, b) => navTimestamp(value[a]) - navTimestamp(value[b]) || a - b);
  const target = indices[indices.indexOf(selected) + direction];
  if (target === undefined || ['homeComb', 'headerSerch', 'tabNav', 'pageFoot'].includes(String(couponRecord(value[target])?.name))) throw Error('不能越过头部或底部导航');
  const aTime = navTimestamp(value[selected]), bTime = navTimestamp(value[target]);
  if (aTime === bTime || aTime === Number.MAX_SAFE_INTEGER || bTime === Number.MAX_SAFE_INTEGER) throw Error('相同或异常排序值需要先在装修 JSON 中明确修复');
  const copy = structuredClone(value), a = couponRecord(copy[selected])!, b = couponRecord(copy[target])!;
  const hadA = Object.hasOwn(a, 'timestamp'), hadB = Object.hasOwn(b, 'timestamp'), rawA = a.timestamp, rawB = b.timestamp;
  if (hadB) a.timestamp = rawB; else delete a.timestamp;
  if (hadA) b.timestamp = rawA; else delete b.timestamp;
  [copy[selected], copy[target]] = [copy[target], copy[selected]];
  return { value: copy, selected: target };
}

export function removeCouponBlock(value: unknown[], selected: number): { value: unknown[]; selected: number } {
  if (!couponKind(couponRecord(value[selected])?.name)) throw Error('未选择优惠券');
  const copy = structuredClone(value);
  copy.splice(selected, 1);
  return { value: copy, selected: couponEntries(copy)[0]?.index ?? -1 };
}

/** Pure display conversion; numerically equal typed events retain the raw spelling. */
export function couponNumber(value: unknown, fallback = 0, maximum = Number.MAX_VALUE): number {
  const parsed = typeof value === 'number' || typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(maximum, parsed) : fallback;
}

function metadataCopy(value: unknown): unknown {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }], seen = new Set<object>();
  let nodes = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++nodes > 100_000 || next.depth > 64) throw Error('元数据超过 100000 节点或 64 层完整编辑容量');
    const item = next.value;
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) continue;
    if (!item || typeof item !== 'object' || seen.has(item)) throw Error('元数据必须为完整的 JSON 值');
    seen.add(item);
    const proto = Object.getPrototypeOf(item), array = Array.isArray(item);
    if (proto !== Object.prototype && proto !== null && !(array && proto === Array.prototype)) throw Error('元数据必须为普通 JSON 对象');
    if (Object.getOwnPropertySymbols(item).length || Object.getOwnPropertyNames(item).length !== Object.keys(item).length + (array ? 1 : 0)) throw Error('元数据含不支持的字段');
    if (array && (Object.keys(item).length !== item.length || Object.keys(item).some(key => !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= item.length))) throw Error('元数据列表不能含空缺或额外字段');
    for (const key of Object.keys(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('元数据含不安全字段');
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!Object.hasOwn(descriptor, 'value')) throw Error('元数据不能含动态字段');
      pending.push({ value: descriptor.value, depth: next.depth + 1 });
    }
  }
  return structuredClone(value);
}

/** Whole-candidate validation precedes the one top-level commit. */
export function couponSet(block: CouponRecord, path: Array<string | number>, value: unknown): boolean {
  if (!couponKind(block.name)) throw Error('未选择优惠券');
  const next = metadataCopy(value), candidate = metadataCopy(block) as CouponRecord;
  navSet(candidate, path, next);
  couponDocument(JSON.stringify([candidate]));
  if (JSON.stringify(candidate) === JSON.stringify(block)) return false;
  // Set only after both the value and all imported parent structures pass.
  navSet(block, path, next);
  return true;
}

export function setCouponNumber(block: CouponRecord, path: Array<string | number>, value: unknown, minimum = 0, maximum = Number.MAX_VALUE): boolean {
  if (!couponKind(block.name)) throw Error('未选择优惠券');
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0 || maximum < minimum || value < minimum || value > maximum) throw Error('请输入范围内的有效数字');
  const raw = navRead(block, path), current = typeof raw === 'number' || typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(current) && current === value ? false : couponSet(block, path, value);
}

/** A new quantity is an integer1..100. A same-value event keeps any imported
 * zero/tiny/scientific/oversized spelling unchanged, even outside that new-input range. */
export function setCouponCount(block: CouponRecord, value: unknown): boolean {
  if (!couponKind(block.name)) throw Error('未选择优惠券');
  if (typeof value !== 'number' || !Number.isFinite(value)) throw Error('请输入1至100的整数');
  const raw = navRead(block, ['numberConfig', 'val']);
  const current = typeof raw === 'number' || typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (Number.isFinite(current) && current === value) return false;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw Error('请输入1至100的整数');
  return couponSet(block, ['numberConfig', 'val'], value);
}

/** Current TS public quantity only, not an asserted numeric PHP LIMIT.
 * Pass the raw numberConfig.val; the fixed PHP ref omits config/app.js. */
export function couponPublicLimit(raw: unknown): number {
  return Math.min(10, Math.floor(couponNumber(raw, 6, 10000)));
}
