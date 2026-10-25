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
export function newCommunityBlock(kind: CommunityKind, timestamp: number): CommunityRecord {
  if (!communityKind(kind) || !Number.isSafeInteger(timestamp)) throw Error('社区组件类型或排序值无效');
  return { ...structuredClone(DIY_COMMUNITY_DEFAULTS[kind]), timestamp };
}
export function addCommunityBlock(value: unknown[], kind: CommunityKind, source?: CommunityRecord) {
  if (!communityKind(kind) || source !== undefined && communityKind(source.name) !== kind) throw Error('社区组件类型无效');
  const copy = structuredClone(value);
  const maximum = Math.max(0, ...copy.filter(row => NAVIGATION_BODY_NAMES.includes(record(row)?.name as typeof NAVIGATION_BODY_NAMES[number])).map(navTimestamp));
  const timestamp = maximum + Math.max(1, Math.abs(maximum) * Number.EPSILON * 2);
  if (!Number.isSafeInteger(timestamp) || timestamp <= maximum) throw Error('排序空间不足，请先明确调整排序');
  const footer = copy.findIndex(row => String(record(row)?.name).toLowerCase() === 'pagefoot');
  const selected = footer < 0 ? copy.length : footer;
  copy.splice(selected, 0, source ? { ...structuredClone(source), timestamp } : newCommunityBlock(kind, timestamp));
  return { value: copy, selected };
}
export function moveCommunityBlock(value: unknown[], selected: number, direction: -1 | 1) {
  if (!Number.isSafeInteger(selected) || !communityKind(record(value[selected])?.name) || ![-1, 1].includes(direction)) throw Error('未选择社区组件或移动方向无效');
  const indices = value.map((_, index) => index).filter(index => NAVIGATION_BODY_NAMES.includes(record(value[index])?.name as typeof NAVIGATION_BODY_NAMES[number]))
    .sort((a, b) => navTimestamp(value[a]) - navTimestamp(value[b]) || a - b);
  const target = indices[indices.indexOf(selected) + direction];
  if (target === undefined || ['homeComb', 'headerSerch', 'tabNav', 'pageFoot'].includes(String(record(value[target])?.name))) throw Error('不能越过头部或底部导航');
  const a = navTimestamp(value[selected]), b = navTimestamp(value[target]);
  if (a === b || [a, b].includes(Number.MAX_SAFE_INTEGER)) throw Error('相同或异常排序值需要先明确调整');
  const copy = structuredClone(value);
  record(copy[selected])!.timestamp = b; record(copy[target])!.timestamp = a;
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
  if (value === null) throw Error('装修value不能为null');
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
