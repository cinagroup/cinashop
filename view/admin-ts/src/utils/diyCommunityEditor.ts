import { DIY_COMMUNITY_DEFAULTS } from './diyCommunityDefaults';
import { NAVIGATION_BODY_NAMES, navigationDocument, navigationRecord, navRead, navSet, navTimestamp } from './diyNavigationEditor';
import { canonicalPresentationReference, presentationPreviewForReference, presentationPreviewUrl } from './diyPresentationEditor';

export const COMMUNITY_NAMES = ['community'] as const;
export type CommunityKind = typeof COMMUNITY_NAMES[number];
export type CommunityRecord = Record<string, unknown>;
export const communityLabels: Record<CommunityKind, string> = { community: '种草社区' };
export const communityKind = (value: unknown): CommunityKind | null => value === 'community' ? 'community' : null;
export const communityRecord = navigationRecord;
export const communityDocument = navigationDocument;
export const communityRead = navRead;

export function communityEntries(value: unknown[]) {
  return value.flatMap((row, index) => communityKind(communityRecord(row)?.name) ? [{ index, kind: 'community' as const }] : [])
    .sort((a, b) => navTimestamp(value[a.index]) - navTimestamp(value[b.index]) || a.index - b.index);
}

/** Defaults belong only to explicitly created components; imports are never merged. */
export function newCommunityBlock(timestamp: number): CommunityRecord {
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > Number.MAX_SAFE_INTEGER) throw Error('组件排序值无效');
  const block: CommunityRecord = structuredClone(DIY_COMMUNITY_DEFAULTS);
  block.timestamp = timestamp;
  return block;
}

export function addCommunityBlock(value: unknown[]): { value: unknown[]; selected: number } {
  const copy = structuredClone(value);
  const times = copy.filter(row => NAVIGATION_BODY_NAMES.includes(communityRecord(row)?.name as typeof NAVIGATION_BODY_NAMES[number]))
    .map(row => Number(communityRecord(row)?.timestamp)).filter(Number.isFinite);
  const maximum = Math.max(0, ...times), timestamp = maximum + Math.max(1, Math.abs(maximum) * Number.EPSILON * 2);
  if (!Number.isFinite(timestamp) || timestamp <= maximum || timestamp > Number.MAX_SAFE_INTEGER) throw Error('排序空间不足，请先在装修 JSON 中明确调整');
  const footer = copy.findIndex(row => String(communityRecord(row)?.name).toLowerCase() === 'pagefoot');
  const selected = footer < 0 ? copy.length : footer;
  copy.splice(selected, 0, newCommunityBlock(timestamp));
  communityDocument(JSON.stringify(copy));
  return { value: copy, selected };
}

/** Move through the complete rendered body order, preserving raw timestamps. */
export function moveCommunityBlock(value: unknown[], selected: number, direction: number): { value: unknown[]; selected: number } {
  if (!communityKind(communityRecord(value[selected])?.name) || ![-1, 1].includes(direction)) throw Error('未选择社区组件或移动方向无效');
  const indices = value.map((_, index) => index)
    .filter(index => NAVIGATION_BODY_NAMES.includes(communityRecord(value[index])?.name as typeof NAVIGATION_BODY_NAMES[number]))
    .sort((a, b) => navTimestamp(value[a]) - navTimestamp(value[b]) || a - b);
  const target = indices[indices.indexOf(selected) + direction];
  if (target === undefined || ['homeComb', 'headerSerch', 'tabNav', 'pageFoot'].includes(String(communityRecord(value[target])?.name))) throw Error('不能越过头部或底部导航');
  const aTime = navTimestamp(value[selected]), bTime = navTimestamp(value[target]);
  if (aTime === bTime || aTime === Number.MAX_SAFE_INTEGER || bTime === Number.MAX_SAFE_INTEGER) throw Error('相同或异常排序值需要先在装修 JSON 中明确修复');
  const copy = structuredClone(value), a = communityRecord(copy[selected])!, b = communityRecord(copy[target])!;
  const hadA = Object.hasOwn(a, 'timestamp'), hadB = Object.hasOwn(b, 'timestamp'), rawA = a.timestamp, rawB = b.timestamp;
  if (hadB) a.timestamp = rawB; else delete a.timestamp;
  if (hadA) b.timestamp = rawA; else delete b.timestamp;
  [copy[selected], copy[target]] = [copy[target], copy[selected]];
  return { value: copy, selected: target };
}

export function removeCommunityBlock(value: unknown[], selected: number): { value: unknown[]; selected: number } {
  if (!communityKind(communityRecord(value[selected])?.name)) throw Error('未选择社区组件');
  const copy = structuredClone(value);
  copy.splice(selected, 1);
  return { value: copy, selected: communityEntries(copy)[0]?.index ?? -1 };
}

/** Display projection only. Reading an imported number never rewrites its spelling. */
export function communityNumber(value: unknown, fallback = 0, maximum = Number.MAX_VALUE): number {
  const parsed = typeof value === 'number' || typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(maximum, parsed) : fallback;
}

/** Validate a JSON metadata value before a mutation; never drop unsupported values. */
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
    const proto = Object.getPrototypeOf(item);
    if (proto !== Object.prototype && proto !== null && !(Array.isArray(item) && proto === Array.prototype)) throw Error('元数据必须为普通 JSON 对象');
    if (Object.getOwnPropertySymbols(item).length || Object.getOwnPropertyNames(item).length !== Object.keys(item).length + (Array.isArray(item) ? 1 : 0)) throw Error('元数据含不支持的字段');
    if (Array.isArray(item) && (Object.keys(item).length !== item.length || Object.keys(item).some(key => !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= item.length))) throw Error('元数据列表不能含空缺或额外字段');
    for (const key of Object.keys(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('元数据含不安全字段');
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!Object.hasOwn(descriptor, 'value')) throw Error('元数据不能含动态字段');
      pending.push({ value: descriptor.value, depth: next.depth + 1 });
    }
  }
  return structuredClone(value);
}

/** Explicit leaf editing is atomic even when an imported parent has a bad shape. */
export function communitySet(block: CommunityRecord, path: Array<string | number>, value: unknown): boolean {
  if (!communityKind(block.name)) throw Error('未选择社区组件');
  const next = metadataCopy(value), candidate = structuredClone(block);
  navSet(candidate, path, next);
  if (Object.is(navRead(block, path), value)) return false;
  communityDocument(JSON.stringify([candidate]));
  navSet(block, path, next);
  return true;
}

/** Typed number events retain numerically equal imported strings, including exponents. */
export function setCommunityNumber(block: CommunityRecord, path: Array<string | number>, value: unknown, minimum = 0, maximum = Number.MAX_VALUE): boolean {
  if (!communityKind(block.name)) throw Error('未选择社区组件');
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0 || maximum < minimum || value < minimum || value > maximum) throw Error('请输入范围内的有效数字');
  const raw = navRead(block, path), current = typeof raw === 'number' || typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(current) && current === value ? false : communitySet(block, path, value);
}

export interface CommunityTopicMetadataPatch { activeValue?: string | number; list?: unknown[] }

/** Topic choices are stored metadata only. They never grant a filter or destination.
 * Both fields are validated together and selectConfig is replaced only after success. */
export function setCommunityTopicMetadata(block: CommunityRecord, patch: CommunityTopicMetadataPatch): boolean {
  if (!communityKind(block.name)) throw Error('未选择社区组件');
  const changes = communityRecord(patch);
  if (!changes || Object.keys(changes).some(key => !['activeValue', 'list'].includes(key))) throw Error('话题元数据字段无效');
  const copied = communityRecord(metadataCopy(changes))!;
  if (!Object.keys(copied).length) return false;
  if (Object.hasOwn(copied, 'activeValue') && !(typeof copied.activeValue === 'string' || typeof copied.activeValue === 'number' && Number.isFinite(copied.activeValue))) throw Error('话题值必须为原始字符串或数字');
  if (Object.hasOwn(copied, 'list') && !Array.isArray(copied.list)) throw Error('话题列表必须为 JSON 数组');
  const current = block.selectConfig;
  if (current !== undefined && !communityRecord(current)) throw Error('话题元数据结构异常，请在装修 JSON 中明确修复');
  const next = { ...structuredClone(communityRecord(current) ?? {}), ...copied };
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  communityDocument(JSON.stringify([{ ...block, selectConfig: next }]));
  block.selectConfig = next;
  return true;
}

export function canonicalCommunityImage(raw: string): string {
  const value = canonicalPresentationReference(raw.trim());
  if (value.length > 4096 || value && (!/^(?:https:\/\/|\/(?!\/))/iu.test(value) || /[\u0000-\u0020\u007f\\]/u.test(value))) throw Error('请选择有效的 HTTPS 或站内图片');
  return value;
}

/** The header title image is the sole author media slot; all other data stays exact. */
export function canonicalCommunityBlock(raw: CommunityRecord): CommunityRecord {
  const block = structuredClone(raw), field = communityRecord(block.imgConfig);
  if (communityKind(block.name) && field && typeof field.url === 'string') field.url = canonicalPresentationReference(field.url);
  return block;
}

export function canonicalCommunityValue(raw: string): string {
  const value: unknown = JSON.parse(raw);
  if (value === null) throw Error('装修 value 不能为 null');
  if (Array.isArray(value)) for (let index = 0; index < value.length; index++) {
    const block = communityRecord(value[index]);
    if (block && communityKind(block.name)) value[index] = canonicalCommunityBlock(block);
  }
  return JSON.stringify(value);
}

/** Managed image reads require a current capability for the exact stored identity. */
export function communityPreviewBlock(raw: CommunityRecord, previews: Record<string, string>): CommunityRecord {
  const block = structuredClone(raw), field = communityRecord(block.imgConfig);
  if (communityKind(block.name) && field && typeof field.url === 'string') {
    const reference = field.url;
    field.url = presentationPreviewForReference(reference, previews[canonicalPresentationReference(reference)]) || presentationPreviewUrl(reference);
  }
  return block;
}
