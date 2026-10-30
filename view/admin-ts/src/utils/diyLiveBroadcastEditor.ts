import { DIY_LIVE_BROADCAST_DEFAULTS } from './diyLiveBroadcastDefaults';
import { NAVIGATION_BODY_NAMES, navigationDocument, navigationRecord, navRead, navSet, navTimestamp, navFlag, navText } from './diyNavigationEditor';

export const LIVE_BROADCAST_NAMES = ['liveBroadcast'] as const;
export type LiveBroadcastKind = typeof LIVE_BROADCAST_NAMES[number];
export type LiveBroadcastRecord = Record<string, unknown>;
export const liveBroadcastLabels: Record<LiveBroadcastKind, string> = { liveBroadcast: '小程序直播' };
export const liveBroadcastKind = (value: unknown): LiveBroadcastKind | null => value === 'liveBroadcast' ? 'liveBroadcast' : null;
export const liveBroadcastRecord = navigationRecord;
export const liveBroadcastDocument = navigationDocument;
export const liveBroadcastRead = navRead;
export const liveBroadcastFlag = navFlag;
export const liveBroadcastText = navText;

export function liveBroadcastEntries(value: unknown[]) {
  return value.flatMap((row, index) => liveBroadcastKind(liveBroadcastRecord(row)?.name) ? [{ index, kind: 'liveBroadcast' as const }] : [])
    .sort((a, b) => navTimestamp(value[a.index]) - navTimestamp(value[b.index]) || a.index - b.index);
}

/** Defaults belong exclusively to explicit creation, never imports. */
export function newLiveBroadcastBlock(timestamp: number): LiveBroadcastRecord {
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > Number.MAX_SAFE_INTEGER) throw Error('组件排序值无效');
  const block: LiveBroadcastRecord = structuredClone(DIY_LIVE_BROADCAST_DEFAULTS);
  block.timestamp = timestamp;
  return block;
}

export function addLiveBroadcastBlock(value: unknown[]): { value: unknown[]; selected: number } {
  const copy = structuredClone(value);
  const times = copy.filter(row => NAVIGATION_BODY_NAMES.includes(liveBroadcastRecord(row)?.name as typeof NAVIGATION_BODY_NAMES[number]))
    .map(row => Number(liveBroadcastRecord(row)?.timestamp)).filter(Number.isFinite);
  const maximum = Math.max(0, ...times), timestamp = maximum + Math.max(1, Math.abs(maximum) * Number.EPSILON * 2);
  if (!Number.isFinite(timestamp) || timestamp <= maximum || timestamp > Number.MAX_SAFE_INTEGER) throw Error('排序空间不足，请先在装修 JSON 中明确调整');
  const footer = copy.findIndex(row => String(liveBroadcastRecord(row)?.name).toLowerCase() === 'pagefoot');
  const selected = footer < 0 ? copy.length : footer;
  copy.splice(selected, 0, newLiveBroadcastBlock(timestamp));
  liveBroadcastDocument(JSON.stringify(copy));
  return { value: copy, selected };
}

export function moveLiveBroadcastBlock(value: unknown[], selected: number, direction: number): { value: unknown[]; selected: number } {
  if (!liveBroadcastKind(liveBroadcastRecord(value[selected])?.name) || ![-1, 1].includes(direction)) throw Error('未选择小程序直播或移动方向无效');
  const indices = value.map((_, index) => index)
    .filter(index => NAVIGATION_BODY_NAMES.includes(liveBroadcastRecord(value[index])?.name as typeof NAVIGATION_BODY_NAMES[number]))
    .sort((a, b) => navTimestamp(value[a]) - navTimestamp(value[b]) || a - b);
  const target = indices[indices.indexOf(selected) + direction];
  if (target === undefined || ['homeComb', 'headerSerch', 'tabNav', 'pageFoot'].includes(String(liveBroadcastRecord(value[target])?.name))) throw Error('不能越过头部或底部导航');
  const aTime = navTimestamp(value[selected]), bTime = navTimestamp(value[target]);
  if (aTime === bTime || aTime === Number.MAX_SAFE_INTEGER || bTime === Number.MAX_SAFE_INTEGER) throw Error('相同或异常排序值需要先在装修 JSON 中明确修复');
  const copy = structuredClone(value), a = liveBroadcastRecord(copy[selected])!, b = liveBroadcastRecord(copy[target])!;
  const hadA = Object.hasOwn(a, 'timestamp'), hadB = Object.hasOwn(b, 'timestamp'), rawA = a.timestamp, rawB = b.timestamp;
  if (hadB) a.timestamp = rawB; else delete a.timestamp;
  if (hadA) b.timestamp = rawA; else delete b.timestamp;
  [copy[selected], copy[target]] = [copy[target], copy[selected]];
  return { value: copy, selected: target };
}

export function removeLiveBroadcastBlock(value: unknown[], selected: number): { value: unknown[]; selected: number } {
  if (!liveBroadcastKind(liveBroadcastRecord(value[selected])?.name)) throw Error('未选择小程序直播');
  const copy = structuredClone(value);
  copy.splice(selected, 1);
  return { value: copy, selected: liveBroadcastEntries(copy)[0]?.index ?? -1 };
}

/** Pure display conversion; numerically equal typed events retain the raw spelling. */
export function liveBroadcastNumber(value: unknown, fallback = 0, maximum = Number.MAX_VALUE): number {
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
export function liveBroadcastSet(block: LiveBroadcastRecord, path: Array<string | number>, value: unknown): boolean {
  if (!liveBroadcastKind(block.name)) throw Error('未选择小程序直播');
  const next = metadataCopy(value), candidate = metadataCopy(block) as LiveBroadcastRecord;
  navSet(candidate, path, next);
  liveBroadcastDocument(JSON.stringify([candidate]));
  if (JSON.stringify(candidate) === JSON.stringify(block)) return false;
  // Set only after both the value and all imported parent structures pass.
  navSet(block, path, next);
  return true;
}

export function setLiveBroadcastNumber(block: LiveBroadcastRecord, path: Array<string | number>, value: unknown, minimum = 0, maximum = Number.MAX_VALUE): boolean {
  if (!liveBroadcastKind(block.name)) throw Error('未选择小程序直播');
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0 || maximum < minimum || value < minimum || value > maximum) throw Error('请输入范围内的有效数字');
  const raw = navRead(block, path), current = typeof raw === 'number' || typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(current) && current === value ? false : liveBroadcastSet(block, path, value);
}

/** A new quantity is an integer1..100. A same-value event keeps any imported
 * zero/tiny/scientific/oversized spelling unchanged, even outside that new-input range. */
export function setLiveBroadcastCount(block: LiveBroadcastRecord, value: unknown): boolean {
  if (!liveBroadcastKind(block.name)) throw Error('未选择小程序直播');
  if (typeof value !== 'number' || !Number.isFinite(value)) throw Error('请输入1至100的整数');
  const raw = navRead(block, ['numberConfig', 'val']);
  const current = typeof raw === 'number' || typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (Number.isFinite(current) && current === value) return false;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw Error('请输入1至100的整数');
  return liveBroadcastSet(block, ['numberConfig', 'val'], value);
}

/** Retain the existing live public read cap50 and missing/invalid fallback10.
 * PHP positive limit directly reaches LIMIT; this is not an asserted PHP maximum.
 * Existing public Number semantics treat a nonempty whitespace string as zero. */
export function liveBroadcastPublicLimit(raw: unknown): number {
  const value = typeof raw === 'number' || typeof raw === 'string' && raw !== '' ? Number(raw) : NaN;
  return Math.min(50, Math.floor(Number.isFinite(value) && value >= 0 ? Math.min(value, 10000) : 10));
}

/** Only two original typed public choices. No string-ID coercion. */
export const LIVE_BROADCAST_CHECKBOX_VALUES = [0, 1] as const;
export type LiveBroadcastCheck = typeof LIVE_BROADCAST_CHECKBOX_VALUES[number];
const knownLiveBroadcastCheck = (value: unknown): value is LiveBroadcastCheck => typeof value === 'number' && LIVE_BROADCAST_CHECKBOX_VALUES.includes(value as LiveBroadcastCheck);
export function liveBroadcastChecks(block: unknown): LiveBroadcastCheck[] {
  const raw = navRead(block, ['checkboxInfo', 'type']);
  return Array.isArray(raw) ? [...new Set(raw.filter(knownLiveBroadcastCheck))] : [];
}
/** Preserve unknown material, duplicate still-selected values and original order.
 * Same known-set events leave the complete stored list unchanged. */
export function setLiveBroadcastChecks(block: LiveBroadcastRecord, values: unknown): boolean {
  if (!liveBroadcastKind(block.name)) throw Error('未选择小程序直播');
  const input = metadataCopy(values);
  if (!Array.isArray(input) || input.length > 2 || input.some(value => !knownLiveBroadcastCheck(value)) || new Set(input).size !== input.length) throw Error('展示信息只能明确选择原始0、1项');
  const raw = navRead(block, ['checkboxInfo', 'type']);
  if (raw !== undefined && !Array.isArray(raw)) throw Error('导入的展示信息不是完整列表，请先明确修复JSON');
  const requested = input as LiveBroadcastCheck[], present = liveBroadcastChecks(block);
  if (requested.length === present.length && requested.every(value => present.includes(value))) return false;
  const next = Array.isArray(raw) ? raw.filter(value => !knownLiveBroadcastCheck(value) || requested.includes(value)) : [];
  for (const value of requested) if (!present.includes(value)) next.push(value);
  return liveBroadcastSet(block, ['checkboxInfo', 'type'], next);
}

/** Typed explicit selections only; numerically equal imported spellings survive. */
export function setLiveBroadcastEnum(block: LiveBroadcastRecord, key: 'setUp' | 'styleConfig', value: unknown): boolean {
  const maximum = key === 'styleConfig' ? 3 : key === 'setUp' ? 1 : -1;
  if (maximum < 0 || typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > maximum) throw Error('请选择有效的直播选项');
  return setLiveBroadcastNumber(block, [key, 'tabVal'], value, 0, maximum);
}

/** Deliberately no gallery, image-slot, canonical-image, signing or preview
 * capability API. Catalog covers/avatars/goods images are business read data. */
