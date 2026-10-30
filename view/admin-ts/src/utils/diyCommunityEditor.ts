import { DIY_COMMUNITY_DEFAULTS } from './diyCommunityDefaults';
import { communityControlKeys } from './diyCommunityControls';
import { navigationDocument, navigationRecord as record, navRead as read, navSet, navTimestamp, NAVIGATION_BODY_NAMES } from './diyNavigationEditor';
import { editorialImageIdentity, editorialPreviewUrl } from './diyEditorialEditor';

export const COMMUNITY_NAMES = ['community'] as const;
export type CommunityKind = typeof COMMUNITY_NAMES[number];
export type CommunityRecord = Record<string, unknown>;
export type CommunityPath = Array<string | number>;
export const communityLabels: Record<CommunityKind, string> = { community: '种草社区' };
export const communityKind = (value: unknown): CommunityKind | null => value === 'community' ? value : null;
export const communityDocument = navigationDocument, communityRecord = record, communityRead = read;
export const communityImageIdentity = editorialImageIdentity, communityPreviewUrl = editorialPreviewUrl;
export function communityEntries(value: unknown[]) {
  return value.flatMap((raw, index) => communityKind(record(raw)?.name) ? [{ index, kind: 'community' as const }] : [])
    .sort((a, b) => navTimestamp(value[a.index]) - navTimestamp(value[b.index]) || a.index - b.index);
}
export function newCommunityBlock(kindOrTimestamp: CommunityKind | number, timestamp = 0): CommunityRecord {
  const kind = typeof kindOrTimestamp === 'number' ? 'community' : kindOrTimestamp;
  if (typeof kindOrTimestamp === 'number') timestamp = kindOrTimestamp;
  if (!communityKind(kind) || !Number.isFinite(timestamp) || Math.abs(timestamp) > Number.MAX_SAFE_INTEGER) throw Error('社区组件类型或排序值无效');
  return { ...structuredClone(DIY_COMMUNITY_DEFAULTS[kind]), timestamp };
}
export function addCommunityBlock(value: unknown[], kind: CommunityKind = 'community', source?: CommunityRecord) {
  if (!communityKind(kind) || source !== undefined && communityKind(source.name) !== kind) throw Error('社区组件类型无效');
  const copy = structuredClone(value);
  const maximum = Math.max(0, ...copy.filter(row => NAVIGATION_BODY_NAMES.includes(record(row)?.name as typeof NAVIGATION_BODY_NAMES[number])).map(navTimestamp));
  const timestamp = maximum + Math.max(1, Math.abs(maximum) * Number.EPSILON * 2);
  if (!Number.isFinite(timestamp) || timestamp > Number.MAX_SAFE_INTEGER || timestamp <= maximum) throw Error('排序空间不足，请先明确调整排序');
  const footer = copy.findIndex(row => String(record(row)?.name).toLowerCase() === 'pagefoot');
  const selected = footer < 0 ? copy.length : footer;
  copy.splice(selected, 0, source ? { ...structuredClone(source), timestamp } : newCommunityBlock(kind, timestamp));
  return { value: copy, selected };
}
export function moveCommunityBlock(value: unknown[], selected: number, direction: number): { value: unknown[]; selected: number } {
  if (!communityKind(record(value[selected])?.name) || ![-1, 1].includes(direction)) throw Error('未选择社区组件或移动方向无效');
  const indices = value.map((_, index) => index)
    .filter(index => NAVIGATION_BODY_NAMES.includes(record(value[index])?.name as typeof NAVIGATION_BODY_NAMES[number]))
    .sort((a, b) => navTimestamp(value[a]) - navTimestamp(value[b]) || a - b);
  const target = indices[indices.indexOf(selected) + direction];
  if (target === undefined || ['homeComb', 'headerSerch', 'tabNav', 'pageFoot'].includes(String(record(value[target])?.name))) throw Error('不能越过头部或底部导航');
  const aTime = navTimestamp(value[selected]), bTime = navTimestamp(value[target]);
  if (aTime === bTime || aTime === Number.MAX_SAFE_INTEGER || bTime === Number.MAX_SAFE_INTEGER) throw Error('相同或异常排序值需要先在装修 JSON 中明确修复');
  const copy = structuredClone(value), a = record(copy[selected])!, b = record(copy[target])!;
  const hadA = Object.hasOwn(a, 'timestamp'), hadB = Object.hasOwn(b, 'timestamp'), rawA = a.timestamp, rawB = b.timestamp;
  if (hadB) a.timestamp = rawB; else delete a.timestamp;
  if (hadA) b.timestamp = rawA; else delete b.timestamp;
  [copy[selected], copy[target]] = [copy[target], copy[selected]];
  return { value: copy, selected: target };
}


/** Only this authored header image is media, never API rows or topic metadata. */
export function communityMediaPaths(block: CommunityRecord): CommunityPath[] {
  return communityKind(block.name) ? [['imgConfig', 'url']] : [];
}
export function canonicalCommunityBlock(raw: CommunityRecord, _published = false): CommunityRecord {
  const block = structuredClone(raw);
  for (const path of communityMediaPaths(block)) {
    const value = read(block, path);
    if (typeof value === 'string') navSet(block, path, communityImageIdentity(value));
  }
  return block;
}
export function canonicalCommunityValue(raw: string): string {
  const value: unknown = JSON.parse(raw);
  if (value === null) throw Error('装修 value 不能为 null');
  if (Array.isArray(value)) for (let index = 0; index < value.length; index++) {
    const block = record(value[index]); if (block && communityKind(block.name)) value[index] = canonicalCommunityBlock(block);
  }
  return JSON.stringify(value);
}
export interface CommunityField {
  key: string; label: string; type: 'heading' | 'enum' | 'text' | 'number' | 'color' | 'radius' | 'image' | 'topic';
  defaultValue: unknown; options: Array<{ value: number; label: string }>; minimum: number; maximum: number;
}
export function communityFields(block: CommunityRecord): CommunityField[] {
  if (!communityKind(block.name)) return [];
  return communityControlKeys(block).filter(key => key !== 'setUp').flatMap(key => {
    const raw = DIY_COMMUNITY_DEFAULTS.community[key], config = record(raw);
    let type: CommunityField['type'] | null = null;
    if (typeof raw === 'string') type = 'heading';
    else if (key === 'selectConfig') type = 'topic';
    else if (config && Array.isArray(config.color)) type = 'color';
    else if (config && Object.hasOwn(config, 'url')) type = 'image';
    else if (config && Object.hasOwn(config, 'valList')) type = 'radius';
    else if (config && Object.hasOwn(config, 'value')) type = 'text';
    else if (config && Object.hasOwn(config, 'val')) type = 'number';
    else if (config && Object.hasOwn(config, 'tabVal')) type = 'enum';
    if (!type) return [];
    const options = Array.isArray(config?.tabList) ? config.tabList.map((item, index) => ({ value: index, label: String(record(item)?.name ?? index) })) : [];
    return [{ key, label: String(config?.title ?? config?.name ?? (typeof raw === 'string' ? raw : key)), type, defaultValue: raw, options,
      minimum: Number(config?.min ?? 0), maximum: type === 'text' ? Number(config?.max ?? 100) : 100 }];
  });
}
function samePath(a: CommunityPath, b: CommunityPath) { return JSON.stringify(a) === JSON.stringify(b); }
function numeric(value: unknown): number | null {
  const n = typeof value === 'number' || typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}
function flag(value: unknown): boolean | null {
  if (value === true || value === 1 || typeof value === 'string' && ['1', 'true'].includes(value.trim().toLowerCase())) return true;
  if (value === false || value === 0 || typeof value === 'string' && ['0', 'false'].includes(value.trim().toLowerCase())) return false;
  return null;
}
/** Leaf-only edits for the visible PHP panel. Imported values are never merged or capped. */
export function communityFieldPatch(block: CommunityRecord, path: CommunityPath, value: unknown): boolean {
  if (!communityKind(block.name) || !path.length || path.some(key => typeof key === 'number' ? !Number.isInteger(key) || key < 0 || key > 100000 : ['__proto__', 'prototype', 'constructor'].includes(key))) throw Error('社区字段路径无效');
  const old = read(block, path);
  if (old === value) return false;
  if (samePath(path, ['isHide'])) {
    if (typeof value !== 'boolean') throw Error('显示状态无效');
    if (flag(old) === value) return false;
  } else if (samePath(path, ['setUp', 'tabVal'])) {
    if (value !== 0 && value !== 1) throw Error('设置面板无效');
    if (numeric(old) === value) return false;
  } else {
    const field = communityFields(block).find(item => item.key === path[0]);
    if (!field) throw Error('该字段当前未启用');
    const second = path[1]; let valid = false;
    if (field.type === 'enum' && path.length === 2 && second === 'tabVal') {
      valid = field.options.some(option => option.value === value);
      if (valid && (numeric(old) ?? (typeof old === 'boolean' ? Number(old) : null)) === value) return false;
    }
    if (field.type === 'text' && path.length === 2 && second === 'value') valid = typeof value === 'string'
      && !/[\u0000-\u001f\u007f]/u.test(value) && [...value].length <= Math.max(field.maximum, typeof old === 'string' ? [...old].length : 0);
    if (field.type === 'number' && path.length === 2 && second === 'val') {
      if (typeof value === 'number' && numeric(old) === value) return false;
      valid = typeof value === 'number' && Number.isFinite(value) && value >= field.minimum && value <= field.maximum && (field.key !== 'numberConfig' || Number.isInteger(value));
    }
    if (field.type === 'radius') {
      if (path.length === 2 && second === 'type') { valid = value === 0 || value === 1; if (valid && flag(old) === Boolean(value)) return false; }
      else if (path.length === 2 && second === 'val' || path.length === 4 && second === 'valList' && typeof path[2] === 'number' && path[2] >= 0 && path[2] < 4 && path[3] === 'val') {
        if (typeof value === 'number' && numeric(old) === value) return false;
        valid = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
      }
    }
    if (field.type === 'color' && path.length === 4 && second === 'color' && typeof path[2] === 'number' && Array.isArray(record(field.defaultValue)?.color)
      && path[2] >= 0 && path[2] < (record(field.defaultValue)!.color as unknown[]).length && path[3] === 'item') valid = typeof value === 'string'
      && /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s+-]+\)|transparent|black|white)$/iu.test(value);
    if (field.type === 'topic' && samePath(path, ['selectConfig', 'activeValue'])) valid = typeof value === 'string'
      && (value === '' || /^[1-9]\d{0,9}$/u.test(value) && Number(value) <= 2147483647);
    // Image adoption belongs to the parent's owner-checked gallery session.
    if (!valid) throw Error('社区字段值无效');
  }
  navSet(block, path, value); return true;
}

export function removeCommunityBlock(value: unknown[], selected: number): { value: unknown[]; selected: number } {
  if (!communityKind(record(value[selected])?.name)) throw Error('未选择社区组件');
  const copy = structuredClone(value);
  copy.splice(selected, 1);
  return { value: copy, selected: communityEntries(copy)[0]?.index ?? -1 };
}

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
  if (Object.is(read(block, path), value)) return false;
  communityDocument(JSON.stringify([candidate]));
  navSet(block, path, next);
  return true;
}

/** Typed number events retain numerically equal imported strings, including exponents. */
export function setCommunityNumber(block: CommunityRecord, path: Array<string | number>, value: unknown, minimum = 0, maximum = Number.MAX_VALUE): boolean {
  if (!communityKind(block.name)) throw Error('未选择社区组件');
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0 || maximum < minimum || value < minimum || value > maximum) throw Error('请输入范围内的有效数字');
  const raw = read(block, path), current = typeof raw === 'number' || typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(current) && current === value ? false : communitySet(block, path, value);
}

export interface CommunityTopicMetadataPatch { activeValue?: string | number; list?: unknown[] }

/** Topic choices are stored metadata only. They never grant a filter or destination.
 * Both fields are validated together and selectConfig is replaced only after success. */
export function setCommunityTopicMetadata(block: CommunityRecord, patch: CommunityTopicMetadataPatch): boolean {
  if (!communityKind(block.name)) throw Error('未选择社区组件');
  const changes = record(patch);
  if (!changes || Object.keys(changes).some(key => !['activeValue', 'list'].includes(key))) throw Error('话题元数据字段无效');
  const copied = record(metadataCopy(changes))!;
  if (!Object.keys(copied).length) return false;
  if (Object.hasOwn(copied, 'activeValue') && !(typeof copied.activeValue === 'string' || typeof copied.activeValue === 'number' && Number.isFinite(copied.activeValue))) throw Error('话题值必须为原始字符串或数字');
  if (Object.hasOwn(copied, 'list') && !Array.isArray(copied.list)) throw Error('话题列表必须为 JSON 数组');
  const current = block.selectConfig;
  if (current !== undefined && !record(current)) throw Error('话题元数据结构异常，请在装修 JSON 中明确修复');
  const next = { ...structuredClone(record(current) ?? {}), ...copied };
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  communityDocument(JSON.stringify([{ ...block, selectConfig: next }]));
  block.selectConfig = next;
  return true;
}

export function canonicalCommunityImage(raw: string): string {
  const value = communityImageIdentity(raw.trim());
  if (value.length > 4096 || value && (!/^(?:https:\/\/|\/(?!\/))/iu.test(value) || /[\u0000-\u0020\u007f\\]/u.test(value))) throw Error('请选择有效的 HTTPS 或站内图片');
  return value;
}

/** Exact, expiring media capabilities are projected separately from authored IDs. */
export function communityPreviewBlock(raw: CommunityRecord, previews: Record<string, string>): CommunityRecord {
  const block = structuredClone(raw);
  for (const path of communityMediaPaths(block)) {
    const reference = read(block, path), stable = communityImageIdentity(reference);
    navSet(block, path, communityPreviewUrl(reference, previews[stable]));
  }
  return block;
}
