import { DIY_POINTS_DEFAULTS } from './diyPointsDefaults';
import { canonicalPresentationReference, presentationPreviewForReference } from './diyPresentationEditor';
import { NAVIGATION_BODY_NAMES, navigationDocument, navigationRecord, navRead, navSet, navTimestamp, navFlag, navText } from './diyNavigationEditor';

export const POINTS_NAMES = ['pointsMall'] as const;
export type PointsKind = typeof POINTS_NAMES[number];
export type PointsRecord = Record<string, unknown>;
export const pointsLabels: Record<PointsKind, string> = { pointsMall: '积分商城' };
export const pointsKind = (value: unknown): PointsKind | null => value === 'pointsMall' ? 'pointsMall' : null;
export const pointsRecord = navigationRecord;
export const pointsDocument = navigationDocument;
export const pointsRead = navRead;
export const pointsFlag = navFlag;
export const pointsText = navText;

export function pointsEntries(value: unknown[]) {
  return value.flatMap((row, index) => pointsKind(pointsRecord(row)?.name) ? [{ index, kind: 'pointsMall' as const }] : [])
    .sort((a, b) => navTimestamp(value[a.index]) - navTimestamp(value[b.index]) || a.index - b.index);
}

/** Defaults belong exclusively to explicit creation, never imports. */
export function newPointsBlock(timestamp: number): PointsRecord {
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > Number.MAX_SAFE_INTEGER) throw Error('组件排序值无效');
  const block: PointsRecord = structuredClone(DIY_POINTS_DEFAULTS);
  block.timestamp = timestamp;
  return block;
}

export function addPointsBlock(value: unknown[]): { value: unknown[]; selected: number } {
  const copy = structuredClone(value);
  const times = copy.filter(row => NAVIGATION_BODY_NAMES.includes(pointsRecord(row)?.name as typeof NAVIGATION_BODY_NAMES[number]))
    .map(row => Number(pointsRecord(row)?.timestamp)).filter(Number.isFinite);
  const maximum = Math.max(0, ...times), timestamp = maximum + Math.max(1, Math.abs(maximum) * Number.EPSILON * 2);
  if (!Number.isFinite(timestamp) || timestamp <= maximum || timestamp > Number.MAX_SAFE_INTEGER) throw Error('排序空间不足，请先在装修 JSON 中明确调整');
  const footer = copy.findIndex(row => String(pointsRecord(row)?.name).toLowerCase() === 'pagefoot');
  const selected = footer < 0 ? copy.length : footer;
  copy.splice(selected, 0, newPointsBlock(timestamp));
  pointsDocument(JSON.stringify(copy));
  return { value: copy, selected };
}

export function movePointsBlock(value: unknown[], selected: number, direction: number): { value: unknown[]; selected: number } {
  if (!pointsKind(pointsRecord(value[selected])?.name) || ![-1, 1].includes(direction)) throw Error('未选择积分商城或移动方向无效');
  const indices = value.map((_, index) => index)
    .filter(index => NAVIGATION_BODY_NAMES.includes(pointsRecord(value[index])?.name as typeof NAVIGATION_BODY_NAMES[number]))
    .sort((a, b) => navTimestamp(value[a]) - navTimestamp(value[b]) || a - b);
  const target = indices[indices.indexOf(selected) + direction];
  if (target === undefined || ['homeComb', 'headerSerch', 'tabNav', 'pageFoot'].includes(String(pointsRecord(value[target])?.name))) throw Error('不能越过头部或底部导航');
  const aTime = navTimestamp(value[selected]), bTime = navTimestamp(value[target]);
  if (aTime === bTime || aTime === Number.MAX_SAFE_INTEGER || bTime === Number.MAX_SAFE_INTEGER) throw Error('相同或异常排序值需要先在装修 JSON 中明确修复');
  const copy = structuredClone(value), a = pointsRecord(copy[selected])!, b = pointsRecord(copy[target])!;
  const hadA = Object.hasOwn(a, 'timestamp'), hadB = Object.hasOwn(b, 'timestamp'), rawA = a.timestamp, rawB = b.timestamp;
  if (hadB) a.timestamp = rawB; else delete a.timestamp;
  if (hadA) b.timestamp = rawA; else delete b.timestamp;
  [copy[selected], copy[target]] = [copy[target], copy[selected]];
  return { value: copy, selected: target };
}

export function removePointsBlock(value: unknown[], selected: number): { value: unknown[]; selected: number } {
  if (!pointsKind(pointsRecord(value[selected])?.name)) throw Error('未选择积分商城');
  const copy = structuredClone(value);
  copy.splice(selected, 1);
  return { value: copy, selected: pointsEntries(copy)[0]?.index ?? -1 };
}

/** Pure display conversion; numerically equal typed events retain the raw spelling. */
export function pointsNumber(value: unknown, fallback = 0, maximum = Number.MAX_VALUE): number {
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
export function pointsSet(block: PointsRecord, path: Array<string | number>, value: unknown): boolean {
  if (!pointsKind(block.name)) throw Error('未选择积分商城');
  const next = metadataCopy(value), candidate = metadataCopy(block) as PointsRecord;
  navSet(candidate, path, next);
  pointsDocument(JSON.stringify([candidate]));
  if (JSON.stringify(candidate) === JSON.stringify(block)) return false;
  // Set only after both the value and all imported parent structures pass.
  navSet(block, path, next);
  return true;
}

export function setPointsNumber(block: PointsRecord, path: Array<string | number>, value: unknown, minimum = 0, maximum = Number.MAX_VALUE): boolean {
  if (!pointsKind(block.name)) throw Error('未选择积分商城');
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0 || maximum < minimum || value < minimum || value > maximum) throw Error('请输入范围内的有效数字');
  const raw = navRead(block, path), current = typeof raw === 'number' || typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(current) && current === value ? false : pointsSet(block, path, value);
}

/** A new quantity is an integer1..100. A same-value event keeps any imported
 * zero/tiny/scientific/oversized spelling unchanged, even outside that new-input range. */
export function setPointsCount(block: PointsRecord, value: unknown): boolean {
  if (!pointsKind(block.name)) throw Error('未选择积分商城');
  if (typeof value !== 'number' || !Number.isFinite(value)) throw Error('请输入1至100的整数');
  const raw = navRead(block, ['numberConfig', 'val']);
  const current = typeof raw === 'number' || typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (Number.isFinite(current) && current === value) return false;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw Error('请输入1至100的整数');
  return pointsSet(block, ['numberConfig', 'val'], value);
}

/** Current TS public quantity only, not an asserted numeric PHP LIMIT.
 * Pass the raw numberConfig.val; the fixed PHP ref omits config/app.js. */
export function pointsPublicLimit(raw: unknown): number {
  return Math.min(10, Math.floor(pointsNumber(raw, 6, 10000)));
}

/** Only these exact top-level authored raster slots belong to pointsMall.
 * Product feed images, the bundled decorative icon and unknown metadata never do. */
export const POINTS_IMAGE_SLOTS = ['imgBgConfig', 'imgConfig', 'imgConfig2'] as const;
export type PointsImageSlot = typeof POINTS_IMAGE_SLOTS[number];
function checkedPointsSlot(slot: PointsImageSlot): PointsImageSlot {
  if (!POINTS_IMAGE_SLOTS.includes(slot)) throw Error('未选择有效的积分商城图片槽');
  return slot;
}
export function canonicalPointsImage(raw: string): string {
  if (typeof raw !== 'string') throw Error('请选择有效的 HTTPS 或站内图片');
  const value = canonicalPresentationReference(raw.trim());
  if (value.length > 4096 || value && (!/^(?:https:\/\/|\/(?!\/))/iu.test(value) || /[\u0000-\u0020\u007f\\]/u.test(value))) throw Error('请选择有效的 HTTPS 或站内图片');
  return value;
}
export function setPointsImage(block: PointsRecord, slot: PointsImageSlot, raw: string): boolean {
  checkedPointsSlot(slot);
  return pointsSet(block, [slot, 'url'], canonicalPointsImage(raw));
}
/** Canonical save changes only the three exact authored .url slots, including
 * hidden/dormant fields; no recursive decoding or business-image authority. */
export function canonicalPointsBlock(raw: PointsRecord): PointsRecord {
  const block = structuredClone(raw);
  if (pointsKind(block.name)) for (const slot of POINTS_IMAGE_SLOTS) {
    const field = pointsRecord(block[slot]);
    if (field && typeof field.url === 'string') field.url = canonicalPresentationReference(field.url);
  }
  return block;
}
export function canonicalPointsValue(raw: string): string {
  const value: unknown = JSON.parse(raw);
  if (value === null) throw Error('装修 value 不能为 null');
  if (Array.isArray(value)) for (let index = 0; index < value.length; index++) {
    const block = pointsRecord(value[index]);
    if (block && pointsKind(block.name)) value[index] = canonicalPointsBlock(block);
  }
  return JSON.stringify(value);
}
/** Ephemeral capabilities bind the exact complete authored block, slot and
 * stable reference. They never belong in saved JSON or move across contexts. */
export interface PointsImageScope { block: string; slot: PointsImageSlot; reference: string }
export interface PointsImageCapability extends PointsImageScope { preview: string }
export function pointsImageScope(block: PointsRecord, slot: PointsImageSlot): PointsImageScope {
  if (!pointsKind(block.name)) throw Error('未选择积分商城');
  checkedPointsSlot(slot);
  const field = pointsRecord(block[slot]);
  return { block: JSON.stringify(block), slot, reference: typeof field?.url === 'string' ? canonicalPresentationReference(field.url) : '' };
}
/** Non-managed imported images follow the actual public URL projection;
 * explicit new selections retain their narrower HTTPS/site image grammar. */
function pointsPublicImagePreview(value: string): string {
  const url = value.trim();
  if (!url || url.length > 4096 || /[\u0000-\u001f\u007f]/u.test(url)) return '';
  if (/^https:\/\//iu.test(url)) return url;
  if (/^http:\/\//iu.test(url)) return `https://${url.slice(7)}`;
  if (/^\/(?!\/)/u.test(url)) return url;
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/iu.test(url) && url.length <= 262144) return url;
  return '';
}
export function pointsPreviewBlock(raw: PointsRecord, capabilities: readonly PointsImageCapability[] = []): PointsRecord {
  const block = structuredClone(raw);
  if (pointsKind(block.name)) for (const slot of POINTS_IMAGE_SLOTS) {
    const field = pointsRecord(block[slot]); if (!field || typeof field.url !== 'string') continue;
    const scope = pointsImageScope(raw, slot);
    const capability = capabilities.find(item => item.block === scope.block && item.slot === scope.slot && item.reference === scope.reference);
    const managed = /^\/api\/assets\//u.test(field.url.trim());
    field.url = presentationPreviewForReference(scope.reference, capability?.preview) || (managed ? '' : pointsPublicImagePreview(field.url));
  }
  return block;
}
