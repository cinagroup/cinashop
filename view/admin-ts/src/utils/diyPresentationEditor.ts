import { canonicalizeDiyPresentationHtml } from '../../../common/diyPresentationHtml';

export const PRESENTATION_NAMES = ['titles', 'blankPage', 'guide', 'richText', 'videos'] as const;
export type PresentationName = typeof PRESENTATION_NAMES[number];
export type PresentationRecord = Record<string, unknown>;
export const presentationRecord = (value: unknown): PresentationRecord | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as PresentationRecord : null;
export const presentationKind = (value: unknown): PresentationName | null => PRESENTATION_NAMES.includes(value as PresentationName) ? value as PresentationName : null;
export function canonicalPresentationReference(value: string): string {
  const match = /^\/api\/assets\/([1-9]\d*)(?:[?#][\s\S]*)?$/u.exec(value.trim());
  return match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) <= 2147483647 ? `/api/assets/${match[1]}` : value;
}
export function canonicalPresentationBlock(block: PresentationRecord): PresentationRecord {
  const copy = structuredClone(block), kind = presentationKind(copy.name);
  if (kind === 'videos') for (const key of ['videoConfig', 'imgConfig']) { const field = presentationRecord(copy[key]); if (field && typeof field.url === 'string') field.url = canonicalPresentationReference(field.url); }
  if (kind === 'richText') { const field = presentationRecord(copy.richText); if (field && typeof field.val === 'string') field.val = canonicalizeDiyPresentationHtml(field.val); }
  return copy;
}
export function canonicalPresentationValue(raw: string): string {
  const value: unknown = JSON.parse(raw);
  if (value === null) throw Error('装修 value 不能为 null');
  if (Array.isArray(value)) for (let index = 0; index < value.length; index++) { const block = presentationRecord(value[index]); if (block && presentationKind(block.name)) value[index] = canonicalPresentationBlock(block); }
  return JSON.stringify(value);
}
export function presentationDocument(raw: string): unknown[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw Error('内容编辑器需要组件 JSON 数组，请在下方修复原 JSON。');
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 2_000_000) throw Error('压缩后的装修 value 超过 2 MB，不能完整编辑；不会截断。');
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]; let nodes = 0;
  while (pending.length) { const item = pending.pop()!; if (++nodes > 100_000 || item.depth > 64) throw Error('装修 value 超过 100000 节点或 64 层完整编辑容量'); if (item.value && typeof item.value === 'object') for (const [key, child] of Object.entries(item.value)) { if (['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('装修 value 含不安全字段，请在 JSON 中修复'); pending.push({ value: child, depth: item.depth + 1 }); } }
  return value;
}
export const presentationLabel: Record<PresentationName, string> = { titles: '文本标题', blankPage: '辅助空白', guide: '辅助线', richText: '富文本', videos: '视频' };
export function newPresentationBlock(kind: PresentationName, timestamp: number): PresentationRecord {
  const colour = (item: string) => ({ color: [{ item }] }), length = (val = 0) => ({ val });
  const block: PresentationRecord = { name: kind, cname: presentationLabel[kind], timestamp, isHide: false, setUp: { tabVal: 0 } };
  if (kind !== 'guide') block.fillet = { type: 0, val: 0, valList: [0, 0, 0, 0].map(val => ({ val })) };
  block.topConfig = length(kind === 'guide' ? 6 : 0); block.bottomConfig = length(kind === 'guide' ? 6 : 0);
  if (kind !== 'guide') block.bottomBgColor = colour(kind === 'titles' ? '#fff' : kind === 'videos' ? '#F5F5F5' : '#E93323');
  if (kind === 'titles') Object.assign(block, { titleConfig: { value: '标题' }, titleConfigRight: { value: '更多' }, linkConfig: { value: '' }, buttonConfig: { tabVal: 0 }, textPosition: { tabVal: 0 }, textStyle: { tabVal: 0 }, fontSize: length(16), buttonText: length(12), themeColor: colour('#333333'), buttonColor: colour('#999999'), titleColor: { color: [{ item: '#fff' }, { item: '#fff' }] }, prConfig: length(), mbConfig: length() });
  if (kind === 'blankPage') Object.assign(block, { heightConfig: length(10), bgColor: colour('#f5f5f5'), lrEdge: length() });
  if (kind === 'guide') Object.assign(block, { lineStyle: { tabVal: 1 }, lineColor: colour('#f5f5f5'), lineBgColor: colour('#E93323'), lrEdge: length(), mbConfig: length() });
  if (kind === 'richText') Object.assign(block, { richText: { val: '' }, bgColor: colour('#fff'), lrConfig: length(), udConfig: length() });
  if (kind === 'videos') Object.assign(block, { videoConfig: { url: '', video: 1 }, imgConfig: { url: '' }, scaleConfig: { tabVal: 0 }, prConfig: length(), mbConfig: length() });
  return block;
}
/** Read imported author numbers with the same exact grammar as the Uni normalizer.
 * This is a projection only; typed setters still require their existing numbers. */
export function presentationLength(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' || typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER / 2 ? n : fallback;
}
/** Mirrors the actual Uni runtime's direct valList0,1,2,3 CSS order. */
export function presentationRadius(block: PresentationRecord): string {
  const field = presentationRecord(block.fillet), separate = field?.type === 1 || field?.type === '1';
  const px = (value: unknown) => presentationLength(value);
  return separate ? Array.from({ length: 4 }, (_, index) => `${px(presentationRecord(Array.isArray(field?.valList) ? field.valList[index] : null)?.val)}px`).join(' ') : `${px(field?.val)}px`;
}
export function presentationPreviewUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f\x5c]/u.test(value) || !/^(?:https:\/\/|\/(?!\/))/iu.test(value)) return '';
  if (value.startsWith('/api/assets/')) {
    const match = /^\/api\/assets\/[1-9]\d*\?([^#]*)$/u.exec(value); if (!match) return '';
    const query = new URLSearchParams(match[1]); const expires = query.getAll('expires'), signature = query.getAll('signature');
    if (expires.length !== 1 || signature.length !== 1 || !/^[1-9]\d{0,10}$/u.test(expires[0]!) || Number(expires[0]) * 1000 <= Date.now() || !/^[A-Za-z0-9_-]{16,256}$/u.test(signature[0]!)) return '';
  }
  return value;
}

/** A preview is a capability for this same stored reference, never a substitute asset. */
export function presentationPreviewForReference(reference: string, preview: unknown): string {
  const value = presentationPreviewUrl(preview);
  return value && canonicalPresentationReference(value) === canonicalPresentationReference(reference) ? value : '';
}
