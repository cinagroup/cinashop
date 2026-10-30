import { DIY_SECKILL_DEFAULTS } from './diySeckillDefaults';
import { canonicalPresentationReference, presentationPreviewForReference } from './diyPresentationEditor';
import { NAVIGATION_BODY_NAMES, navigationDocument, navigationRecord, navRead, navSet, navTimestamp, navFlag, navText } from './diyNavigationEditor';

export const SECKILL_NAMES = ['seckill'] as const;
export type SeckillKind = typeof SECKILL_NAMES[number];
export type SeckillRecord = Record<string, unknown>;
export const seckillLabels: Record<SeckillKind, string> = { seckill: '秒杀' };
export const seckillKind = (value: unknown): SeckillKind | null => value === 'seckill' ? 'seckill' : null;
export const seckillRecord = navigationRecord;
export const seckillDocument = navigationDocument;
export const seckillRead = navRead;
export const seckillFlag = navFlag;
export const seckillText = navText;

export function seckillEntries(value: unknown[]) {
  return value.flatMap((row, index) => seckillKind(seckillRecord(row)?.name) ? [{ index, kind: 'seckill' as const }] : [])
    .sort((a, b) => navTimestamp(value[a.index]) - navTimestamp(value[b.index]) || a.index - b.index);
}

/** Defaults belong exclusively to explicit creation, never imports. */
export function newSeckillBlock(timestamp: number): SeckillRecord {
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > Number.MAX_SAFE_INTEGER) throw Error('组件排序值无效');
  const block: SeckillRecord = structuredClone(DIY_SECKILL_DEFAULTS);
  block.timestamp = timestamp;
  return block;
}

export function addSeckillBlock(value: unknown[]): { value: unknown[]; selected: number } {
  const copy = structuredClone(value);
  const times = copy.filter(row => NAVIGATION_BODY_NAMES.includes(seckillRecord(row)?.name as typeof NAVIGATION_BODY_NAMES[number]))
    .map(row => Number(seckillRecord(row)?.timestamp)).filter(Number.isFinite);
  const maximum = Math.max(0, ...times), timestamp = maximum + Math.max(1, Math.abs(maximum) * Number.EPSILON * 2);
  if (!Number.isFinite(timestamp) || timestamp <= maximum || timestamp > Number.MAX_SAFE_INTEGER) throw Error('排序空间不足，请先在装修 JSON 中明确调整');
  const footer = copy.findIndex(row => String(seckillRecord(row)?.name).toLowerCase() === 'pagefoot');
  const selected = footer < 0 ? copy.length : footer;
  copy.splice(selected, 0, newSeckillBlock(timestamp));
  seckillDocument(JSON.stringify(copy));
  return { value: copy, selected };
}

export function moveSeckillBlock(value: unknown[], selected: number, direction: number): { value: unknown[]; selected: number } {
  if (!seckillKind(seckillRecord(value[selected])?.name) || ![-1, 1].includes(direction)) throw Error('未选择秒杀或移动方向无效');
  const indices = value.map((_, index) => index)
    .filter(index => NAVIGATION_BODY_NAMES.includes(seckillRecord(value[index])?.name as typeof NAVIGATION_BODY_NAMES[number]))
    .sort((a, b) => navTimestamp(value[a]) - navTimestamp(value[b]) || a - b);
  const target = indices[indices.indexOf(selected) + direction];
  if (target === undefined || ['homeComb', 'headerSerch', 'tabNav', 'pageFoot'].includes(String(seckillRecord(value[target])?.name))) throw Error('不能越过头部或底部导航');
  const aTime = navTimestamp(value[selected]), bTime = navTimestamp(value[target]);
  if (aTime === bTime || aTime === Number.MAX_SAFE_INTEGER || bTime === Number.MAX_SAFE_INTEGER) throw Error('相同或异常排序值需要先在装修 JSON 中明确修复');
  const copy = structuredClone(value), a = seckillRecord(copy[selected])!, b = seckillRecord(copy[target])!;
  const hadA = Object.hasOwn(a, 'timestamp'), hadB = Object.hasOwn(b, 'timestamp'), rawA = a.timestamp, rawB = b.timestamp;
  if (hadB) a.timestamp = rawB; else delete a.timestamp;
  if (hadA) b.timestamp = rawA; else delete b.timestamp;
  [copy[selected], copy[target]] = [copy[target], copy[selected]];
  return { value: copy, selected: target };
}

export function removeSeckillBlock(value: unknown[], selected: number): { value: unknown[]; selected: number } {
  if (!seckillKind(seckillRecord(value[selected])?.name)) throw Error('未选择秒杀');
  const copy = structuredClone(value);
  copy.splice(selected, 1);
  return { value: copy, selected: seckillEntries(copy)[0]?.index ?? -1 };
}

/** Pure display conversion; numerically equal typed events retain the raw spelling. */
export function seckillNumber(value: unknown, fallback = 0, maximum = Number.MAX_VALUE): number {
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
export function seckillSet(block: SeckillRecord, path: Array<string | number>, value: unknown): boolean {
  if (!seckillKind(block.name)) throw Error('未选择秒杀');
  const next = metadataCopy(value), candidate = metadataCopy(block) as SeckillRecord;
  navSet(candidate, path, next);
  seckillDocument(JSON.stringify([candidate]));
  if (JSON.stringify(candidate) === JSON.stringify(block)) return false;
  // Set only after both the value and all imported parent structures pass.
  navSet(block, path, next);
  return true;
}

export function setSeckillNumber(block: SeckillRecord, path: Array<string | number>, value: unknown, minimum = 0, maximum = Number.MAX_VALUE): boolean {
  if (!seckillKind(block.name)) throw Error('未选择秒杀');
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0 || maximum < minimum || value < minimum || value > maximum) throw Error('请输入范围内的有效数字');
  const raw = navRead(block, path), current = typeof raw === 'number' || typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(current) && current === value ? false : seckillSet(block, path, value);
}

/** A new quantity is an integer1..100. A same-value event keeps any imported
 * zero/tiny/scientific/oversized spelling unchanged, even outside that new-input range. */
export function setSeckillCount(block: SeckillRecord, value: unknown): boolean {
  if (!seckillKind(block.name)) throw Error('未选择秒杀');
  if (typeof value !== 'number' || !Number.isFinite(value)) throw Error('请输入1至100的整数');
  const raw = navRead(block, ['numberConfig', 'val']);
  const current = typeof raw === 'number' || typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (Number.isFinite(current) && current === value) return false;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw Error('请输入1至100的整数');
  return seckillSet(block, ['numberConfig', 'val'], value);
}

/** Current TS public quantity only, not an asserted numeric PHP LIMIT.
 * Pass the raw numberConfig.val; the fixed PHP ref omits config/app.js. */
export function seckillPublicLimit(raw: unknown): number {
  return Math.min(10, Math.floor(seckillNumber(raw, 6, 10000)));
}

/** Only these exact top-level authored raster slots belong to seckill.
 * Product feed images, unknown metadata never do. */
export const SECKILL_IMAGE_SLOTS = ['imgBgConfig', 'imgConfig', 'imgColorConfig'] as const;
export type SeckillImageSlot = typeof SECKILL_IMAGE_SLOTS[number];
function checkedSeckillSlot(slot: SeckillImageSlot): SeckillImageSlot {
  if (!SECKILL_IMAGE_SLOTS.includes(slot)) throw Error('未选择有效的秒杀图片槽');
  return slot;
}
export function canonicalSeckillImage(raw: string): string {
  if (typeof raw !== 'string') throw Error('请选择有效的 HTTPS 或站内图片');
  const value = canonicalPresentationReference(raw.trim());
  if (value.length > 4096 || value && (!/^(?:https:\/\/|\/(?!\/))/iu.test(value) || /[\u0000-\u0020\u007f\\]/u.test(value))) throw Error('请选择有效的 HTTPS 或站内图片');
  return value;
}
export function setSeckillImage(block: SeckillRecord, slot: SeckillImageSlot, raw: string): boolean {
  checkedSeckillSlot(slot);
  return seckillSet(block, [slot, 'url'], canonicalSeckillImage(raw));
}
/** Canonical save changes only the three exact authored .url slots, including
 * hidden/dormant fields; no recursive decoding or business-image authority. */
export function canonicalSeckillBlock(raw: SeckillRecord): SeckillRecord {
  const block = structuredClone(raw);
  if (seckillKind(block.name)) for (const slot of SECKILL_IMAGE_SLOTS) {
    const field = seckillRecord(block[slot]);
    if (field && typeof field.url === 'string') field.url = canonicalPresentationReference(field.url);
  }
  return block;
}
export function canonicalSeckillValue(raw: string): string {
  const value: unknown = JSON.parse(raw);
  if (value === null) throw Error('装修 value 不能为 null');
  if (Array.isArray(value)) for (let index = 0; index < value.length; index++) {
    const block = seckillRecord(value[index]);
    if (block && seckillKind(block.name)) value[index] = canonicalSeckillBlock(block);
  }
  return JSON.stringify(value);
}
/** Ephemeral capabilities bind the exact complete authored block, slot and
 * stable reference. They never belong in saved JSON or move across contexts. */
export interface SeckillImageScope { block: string; slot: SeckillImageSlot; reference: string }
export interface SeckillImageCapability extends SeckillImageScope { preview: string }
export function seckillImageScope(block: SeckillRecord, slot: SeckillImageSlot): SeckillImageScope {
  if (!seckillKind(block.name)) throw Error('未选择秒杀');
  checkedSeckillSlot(slot);
  const field = seckillRecord(block[slot]);
  return { block: JSON.stringify(block), slot, reference: typeof field?.url === 'string' ? canonicalPresentationReference(field.url) : '' };
}
/** Non-managed imported images follow the actual public URL projection;
 * explicit new selections retain their narrower HTTPS/site image grammar. */
function seckillPublicImagePreview(value: string): string {
  const url = value.trim();
  if (!url || url.length > 4096 || /[\u0000-\u001f\u007f]/u.test(url)) return '';
  if (/^https:\/\//iu.test(url)) return url;
  if (/^http:\/\//iu.test(url)) return `https://${url.slice(7)}`;
  if (/^\/(?!\/)/u.test(url)) return url;
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/iu.test(url) && url.length <= 262144) return url;
  return '';
}
export function seckillPreviewBlock(raw: SeckillRecord, capabilities: readonly SeckillImageCapability[] = []): SeckillRecord {
  const block = structuredClone(raw);
  if (seckillKind(block.name)) for (const slot of SECKILL_IMAGE_SLOTS) {
    const field = seckillRecord(block[slot]); if (!field || typeof field.url !== 'string') continue;
    const scope = seckillImageScope(raw, slot);
    const capability = capabilities.find(item => item.block === scope.block && item.slot === scope.slot && item.reference === scope.reference);
    const managed = /^\/api\/assets\//u.test(field.url.trim());
    field.url = presentationPreviewForReference(scope.reference, capability?.preview) || (managed ? '' : seckillPublicImagePreview(field.url));
  }
  return block;
}

/** Original numeric author/public identities0/1/2/3; never coerce imported
 * strings/objects/unknown entries into choices or rewrite duplicate/order metadata. */
export const SECKILL_CHECKBOX_VALUES = [0, 1, 2, 3] as const;
export type SeckillCheck = typeof SECKILL_CHECKBOX_VALUES[number];
const knownSeckillCheck = (value: unknown): value is SeckillCheck => typeof value === 'number' && SECKILL_CHECKBOX_VALUES.includes(value as SeckillCheck);
export function seckillChecks(block: unknown): SeckillCheck[] {
  const raw = navRead(block, ['checkboxInfo', 'type']);
  return Array.isArray(raw) ? [...new Set(raw.filter(knownSeckillCheck))] : [];
}
/** Change only the four typed author choices. Existing unknown material,
 * duplicates of still-selected values and original order survive unchanged.
 * A same-set event is a complete noop, including its original raw metadata. */
export function setSeckillChecks(block: SeckillRecord, values: unknown): boolean {
  if (!seckillKind(block.name)) throw Error('未选择秒杀');
  const input = metadataCopy(values);
  if (!Array.isArray(input) || input.length > 4 || input.some(value => !knownSeckillCheck(value)) || new Set(input).size !== input.length) throw Error('展示信息只能明确选择原始0、1、2、3项');
  const raw = navRead(block, ['checkboxInfo', 'type']);
  if (raw !== undefined && !Array.isArray(raw)) throw Error('导入的展示信息不是完整列表，请先明确修复JSON');
  const requested = input as SeckillCheck[], present = seckillChecks(block);
  if (requested.length === present.length && requested.every(value => present.includes(value))) return false;
  const next: unknown[] = Array.isArray(raw) ? raw.filter(value => !knownSeckillCheck(value) || requested.includes(value)) : [];
  for (const value of requested) if (!present.includes(value)) next.push(value);
  return seckillSet(block, ['checkboxInfo', 'type'], next);
}
