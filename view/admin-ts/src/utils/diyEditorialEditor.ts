import { DIY_EDITORIAL_DEFAULTS } from './diyEditorialDefaults';
import { NAVIGATION_BODY_NAMES, navigationDocument, navigationLink, navigationRecord, navRead, navSet, navTimestamp } from './diyNavigationEditor';
import { canonicalPresentationReference, presentationPreviewForReference, presentationPreviewUrl } from './diyPresentationEditor';

export const EDITORIAL_NAMES = ['news', 'hotspot', 'activeParty'] as const;
export type EditorialKind = typeof EDITORIAL_NAMES[number];
export type EditorialRecord = Record<string, unknown>;
export const editorialLabels: Record<EditorialKind, string> = { news: '新闻公告', hotspot: '图片热区', activeParty: '促销活动' };
export const editorialKind = (value: unknown): EditorialKind | null => EDITORIAL_NAMES.includes(value as EditorialKind) ? value as EditorialKind : null;
export const editorialRecord = navigationRecord;
export const editorialDocument = navigationDocument;
export const editorialRead = navRead;
export const editorialSet = navSet;

export function editorialEntries(value: unknown[]) {
  return value.flatMap((row, index) => {
    const kind = editorialKind(editorialRecord(row)?.name);
    return kind ? [{ index, kind }] : [];
  }).sort((a, b) => navTimestamp(value[a.index]) - navTimestamp(value[b.index]) || a.index - b.index);
}

/** Only explicit new components acquire PHP defaults; no imported field is filled. */
export function newEditorialBlock(kind: EditorialKind, timestamp: number): EditorialRecord {
  if (!editorialKind(kind)) throw Error('组件类型无效');
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > Number.MAX_SAFE_INTEGER) throw Error('组件排序值无效');
  const block: EditorialRecord = structuredClone(DIY_EDITORIAL_DEFAULTS[kind]);
  block.timestamp = timestamp;
  return block;
}

export function addEditorialBlock(value: unknown[], kind: EditorialKind): { value: unknown[]; selected: number } {
  if (!editorialKind(kind)) throw Error('组件类型无效');
  const copy = structuredClone(value);
  const times = copy.filter(row => NAVIGATION_BODY_NAMES.includes(editorialRecord(row)?.name as typeof NAVIGATION_BODY_NAMES[number]))
    .map(row => Number(editorialRecord(row)?.timestamp)).filter(Number.isFinite);
  const maximum = Math.max(0, ...times), timestamp = maximum + Math.max(1, Math.abs(maximum) * Number.EPSILON * 2);
  if (!Number.isFinite(timestamp) || timestamp <= maximum || timestamp > Number.MAX_SAFE_INTEGER) throw Error('排序空间不足，请先在装修 JSON 中明确调整');
  const footer = copy.findIndex(row => String(editorialRecord(row)?.name).toLowerCase() === 'pagefoot');
  const selected = footer < 0 ? copy.length : footer;
  copy.splice(selected, 0, newEditorialBlock(kind, timestamp));
  editorialDocument(JSON.stringify(copy));
  return { value: copy, selected };
}

/** Movement uses all ordinary rendered body components and their actual timestamps. */
export function moveEditorialBlock(value: unknown[], selected: number, direction: number): { value: unknown[]; selected: number } {
  if (!editorialKind(editorialRecord(value[selected])?.name) || ![-1, 1].includes(direction)) throw Error('未选择公告、热区或促销组件，或移动方向无效');
  const indices = value.map((_, index) => index)
    .filter(index => NAVIGATION_BODY_NAMES.includes(editorialRecord(value[index])?.name as typeof NAVIGATION_BODY_NAMES[number]))
    .sort((a, b) => navTimestamp(value[a]) - navTimestamp(value[b]) || a - b);
  const target = indices[indices.indexOf(selected) + direction];
  if (target === undefined || ['homeComb', 'headerSerch', 'tabNav', 'pageFoot'].includes(String(editorialRecord(value[target])?.name))) throw Error('不能越过头部或底部导航');
  const aTime = navTimestamp(value[selected]), bTime = navTimestamp(value[target]);
  if (aTime === bTime || aTime === Number.MAX_SAFE_INTEGER || bTime === Number.MAX_SAFE_INTEGER) throw Error('相同或异常排序值需要先在装修 JSON 中明确修复');
  const copy = structuredClone(value), a = editorialRecord(copy[selected])!, b = editorialRecord(copy[target])!;
  const hadA = Object.hasOwn(a, 'timestamp'), hadB = Object.hasOwn(b, 'timestamp'), rawA = a.timestamp, rawB = b.timestamp;
  if (hadB) a.timestamp = rawB; else delete a.timestamp;
  if (hadA) b.timestamp = rawA; else delete b.timestamp;
  [copy[selected], copy[target]] = [copy[target], copy[selected]];
  return { value: copy, selected: target };
}

export function removeEditorialBlock(value: unknown[], selected: number): { value: unknown[]; selected: number } {
  if (!editorialKind(editorialRecord(value[selected])?.name)) throw Error('未选择公告、热区或促销组件');
  const copy = structuredClone(value);
  copy.splice(selected, 1);
  return { value: copy, selected: editorialEntries(copy)[0]?.index ?? -1 };
}

export function itemListPath(kind: EditorialKind): string[] {
  if (!editorialKind(kind)) throw Error('组件类型无效');
  return kind === 'news' ? ['listConfig', 'list'] : kind === 'activeParty' ? ['menuConfig', 'list'] : ['picStyle', 'list'];
}

/** Lists include every imported item, including hidden, malformed and overflow rows. */
export function editorialItems(block: unknown): unknown[] {
  const kind = editorialKind(editorialRecord(block)?.name);
  const value = kind ? navRead(block, itemListPath(kind)) : undefined;
  return Array.isArray(value) ? value : [];
}

function editableItems(block: EditorialRecord): { kind: EditorialKind; path: string[]; items: unknown[] } {
  const kind = editorialKind(block.name);
  if (!kind) throw Error('组件类型无效');
  const path = itemListPath(kind), value = navRead(block, path);
  if (value !== undefined && !Array.isArray(value)) throw Error('条目列表结构异常，请在装修 JSON 中明确修复');
  return { kind, path, items: Array.isArray(value) ? value : [] };
}

export interface HotspotGeometry { left: number; top: number; width: number; height: number }

/** Coordinates are always in a 750-wide canvas, with height from the loaded image. */
export function validHotspotGeometry(rectangle: HotspotGeometry, imageWidth: number, imageHeight: number): boolean {
  if (![imageWidth, imageHeight].every(Number.isFinite) || imageWidth <= 0 || imageHeight <= 0) return false;
  const height = 750 * imageHeight / imageWidth;
  if (!Number.isFinite(height) || height <= 0) return false;
  const { left, top, width, height: boxHeight } = rectangle;
  return [left, top, width, boxHeight].every(value => Number.isFinite(value) && value <= 1_000_000) && left >= 0 && top >= 0 && width > 0 && boxHeight > 0 && left + width <= 750 && top + boxHeight <= height;
}

export function newEditorialItem(kind: EditorialKind, index = 0, imageWidth?: number, imageHeight?: number): EditorialRecord {
  if (!editorialKind(kind) || !Number.isInteger(index) || index < 0) throw Error('条目类型或索引无效');
  if (kind === 'hotspot') {
    const geometry = { left: 0, top: 0, width: 100, height: Math.min(100, 750 * Number(imageHeight) / Number(imageWidth)) };
    if (!validHotspotGeometry(geometry, Number(imageWidth), Number(imageHeight))) throw Error('请等待热区图片实际加载后再添加区域');
    // PHP hotpotModal/index.vue:262–271; keep its complete explicit region shape.
    return { number: index + 1, starX: geometry.left, starY: geometry.top, areaWidth: geometry.width, areaHeight: geometry.height, nowImgWidth: 750, link: '' };
  }
  const first = editorialItems(DIY_EDITORIAL_DEFAULTS[kind])[0];
  const item = structuredClone(editorialRecord(first)!);
  if (kind === 'activeParty') {
    item.img = '';
    for (const entry of Array.isArray(item.info) ? item.info : []) {
      const field = editorialRecord(entry);
      if (field) field.value = '';
    }
  }
  return item;
}

/** Limits apply only to ordinary adds; imports and explicit item edits never clip. */
export function addEditorialItem(block: EditorialRecord, imageWidth?: number, imageHeight?: number): number {
  const { kind, path, items } = editableItems(block), limit = kind === 'news' ? 10 : kind === 'activeParty' ? 4 : 30;
  if (items.length >= limit) throw Error(`普通新增最多 ${limit} 项；现有导入条目会完整保留`);
  const item = newEditorialItem(kind, items.length, imageWidth, imageHeight), copy = structuredClone(items);
  copy.push(item);
  navSet(block, path, copy);
  return copy.length - 1;
}

export function removeEditorialItem(block: EditorialRecord, index: number): number {
  const { path, items } = editableItems(block);
  if (!Number.isInteger(index) || index < 0 || index >= items.length) throw Error('条目索引无效');
  const copy = structuredClone(items);
  copy.splice(index, 1);
  navSet(block, path, copy);
  return Math.min(index, copy.length - 1);
}

export function moveEditorialItem(block: EditorialRecord, index: number, direction: number): number {
  const { path, items } = editableItems(block), target = index + direction;
  if (!Number.isInteger(index) || ![-1, 1].includes(direction) || index < 0 || index >= items.length || target < 0 || target >= items.length) throw Error('条目索引或移动方向无效');
  const copy = structuredClone(items);
  [copy[index], copy[target]] = [copy[target], copy[index]];
  navSet(block, path, copy);
  return target;
}

export function setEditorialLink(block: EditorialRecord, index: number, url: string) {
  const kind = editorialKind(block.name);
  if (!kind || !Number.isInteger(index)) throw Error('链接目标索引无效');
  const value = navigationLink(url);
  if (kind === 'news' && index === -1) { navSet(block, ['linkConfig', 'value'], value); return; }
  if (index < 0 || index >= editorialItems(block).length || !editorialRecord(editorialItems(block)[index])) throw Error('链接目标条目损坏');
  const path: Array<string | number> = [...itemListPath(kind), index];
  navSet(block, kind === 'news' ? [...path, 'chiild', 1, 'val'] : kind === 'activeParty' ? [...path, 'info', 2, 'value'] : [...path, 'link'], value);
}

export function setHotspotGeometry(block: EditorialRecord, index: number, rectangle: HotspotGeometry, imageWidth: number, imageHeight: number) {
  if (block.name !== 'hotspot' || !Number.isInteger(index) || index < 0 || index >= editorialItems(block).length || !editorialRecord(editorialItems(block)[index])) throw Error('热区索引无效');
  if (!validHotspotGeometry(rectangle, imageWidth, imageHeight)) throw Error('矩形必须位于图片的 750 设计宽度及实际比例边界内');
  const { left, top, width, height } = rectangle;
  const item = editorialRecord(editorialItems(block)[index])!;
  item.starX = left; item.starY = top; item.areaWidth = width; item.areaHeight = height;
}

export function canonicalEditorialImage(raw: string): string {
  const value = canonicalPresentationReference(raw.trim());
  if (value.length > 4096 || value && (!/^(?:https:\/\/|\/(?!\/))/iu.test(value) || /[\u0000-\u0020\u007f\\]/u.test(value))) throw Error('请选择有效的 HTTPS 或站内图片');
  return value;
}

/** A renewed capability for the same asset never removes authored regions. */
export function setHotspotImage(block: EditorialRecord, raw: string) {
  if (block.name !== 'hotspot') throw Error('未选择图片热区组件');
  const value = canonicalEditorialImage(raw), current = navRead(block, ['picStyle', 'url']);
  const same = typeof current === 'string' && canonicalPresentationReference(current) === value;
  const picStyle = block.picStyle;
  if (picStyle !== undefined && !editorialRecord(picStyle)) throw Error('热区图片结构异常，请在装修 JSON 中明确修复');
  navSet(block, ['picStyle', 'url'], value);
  if (!same) navSet(block, ['picStyle', 'list'], []);
}

function mapEditorialMedia(raw: EditorialRecord, map: (value: string) => string): EditorialRecord {
  const block = structuredClone(raw), kind = editorialKind(block.name);
  const slot = (field: unknown, key: string) => {
    const row = editorialRecord(field);
    if (row && typeof row[key] === 'string') row[key] = map(row[key]);
  };
  if (kind === 'news') slot(block.imgConfig, 'url');
  if (kind === 'hotspot') slot(block.picStyle, 'url');
  if (kind === 'activeParty') for (const row of editorialItems(block)) slot(row, 'img');
  return block;
}

/** Only declared media slots acquire asset identities; metadata and links stay exact. */
export function canonicalEditorialBlock(raw: EditorialRecord): EditorialRecord {
  return mapEditorialMedia(raw, canonicalPresentationReference);
}

export function canonicalEditorialValue(raw: string): string {
  const value: unknown = JSON.parse(raw);
  if (value === null) throw Error('装修 value 不能为 null');
  if (Array.isArray(value)) for (let index = 0; index < value.length; index++) {
    const block = editorialRecord(value[index]);
    if (block && editorialKind(block.name)) value[index] = canonicalEditorialBlock(block);
  }
  return JSON.stringify(value);
}

export function editorialPreviewBlock(raw: EditorialRecord, previews: Record<string, string>): EditorialRecord {
  return mapEditorialMedia(raw, reference => presentationPreviewForReference(reference, previews[canonicalPresentationReference(reference)]) || presentationPreviewUrl(reference));
}
