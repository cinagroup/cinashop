import { DIY_FOLLOW_DEFAULTS } from './diyFollowDefaults';
import { NAVIGATION_BODY_NAMES, navigationDocument, navigationRecord, navRead, navSet, navTimestamp } from './diyNavigationEditor';
import { canonicalPresentationReference, presentationPreviewForReference, presentationPreviewUrl } from './diyPresentationEditor';

export type FollowRecord = Record<string, unknown>;
export const followDocument = navigationDocument;
export const followRecord = navigationRecord;
export const followRead = navRead;
export const followSet = navSet;

export function followEntries(value: unknown[]) {
  return value.flatMap((row, index) => followRecord(row)?.name === 'follow' ? [{ index, kind: 'follow' as const }] : [])
    .sort((a, b) => navTimestamp(value[a.index]) - navTimestamp(value[b.index]) || a.index - b.index);
}

/** New blocks get all PHP metadata. Imported blocks are never merged. */
export function newFollowBlock(timestamp: number): FollowRecord {
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > Number.MAX_SAFE_INTEGER) throw Error('组件排序值无效');
  const block: FollowRecord = structuredClone(DIY_FOLLOW_DEFAULTS);
  block.timestamp = timestamp;
  return block;
}

export function addFollowBlock(value: unknown[]): { value: unknown[]; selected: number } {
  const copy = structuredClone(value);
  const times = copy.filter(row => NAVIGATION_BODY_NAMES.includes(followRecord(row)?.name as typeof NAVIGATION_BODY_NAMES[number]))
    .map(row => Number(followRecord(row)?.timestamp)).filter(Number.isFinite);
  const maximum = Math.max(0, ...times);
  const timestamp = maximum + Math.max(1, Math.abs(maximum) * Number.EPSILON * 2);
  if (!Number.isFinite(timestamp) || timestamp <= maximum || timestamp > Number.MAX_SAFE_INTEGER) throw Error('排序空间不足，请先在装修 JSON 中明确调整');
  // A footer has its own host and must remain an independent neighbour.
  const footer = copy.findIndex(row => String(followRecord(row)?.name).toLowerCase() === 'pagefoot');
  const selected = footer < 0 ? copy.length : footer;
  copy.splice(selected, 0, newFollowBlock(timestamp));
  followDocument(JSON.stringify(copy));
  return { value: copy, selected };
}

/** Follow can move through all ordinary body families in actual timestamp order. */
export function moveFollowBlock(value: unknown[], selected: number, direction: number): { value: unknown[]; selected: number } {
  if (followRecord(value[selected])?.name !== 'follow' || ![-1, 1].includes(direction)) throw Error('未选择公众号关注组件或移动方向无效');
  const indices = value.map((_, index) => index)
    .filter(index => NAVIGATION_BODY_NAMES.includes(followRecord(value[index])?.name as typeof NAVIGATION_BODY_NAMES[number]))
    .sort((a, b) => navTimestamp(value[a]) - navTimestamp(value[b]) || a - b);
  const target = indices[indices.indexOf(selected) + direction];
  if (target === undefined || ['homeComb', 'headerSerch', 'tabNav', 'pageFoot'].includes(String(followRecord(value[target])?.name))) throw Error('不能越过头部或底部导航');
  const aTime = navTimestamp(value[selected]), bTime = navTimestamp(value[target]);
  if (aTime === bTime || aTime === Number.MAX_SAFE_INTEGER || bTime === Number.MAX_SAFE_INTEGER) throw Error('相同或异常排序值需要先在装修 JSON 中明确修复');
  const copy = structuredClone(value), a = followRecord(copy[selected])!, b = followRecord(copy[target])!;
  // Swap original values as well as positions: imported string spellings survive.
  const hadA = Object.hasOwn(a, 'timestamp'), hadB = Object.hasOwn(b, 'timestamp');
  const rawA = a.timestamp, rawB = b.timestamp;
  if (hadB) a.timestamp = rawB; else delete a.timestamp;
  if (hadA) b.timestamp = rawA; else delete b.timestamp;
  [copy[selected], copy[target]] = [copy[target], copy[selected]];
  return { value: copy, selected: target };
}

export function removeFollowBlock(value: unknown[], selected: number): { value: unknown[]; selected: number } {
  if (followRecord(value[selected])?.name !== 'follow') throw Error('未选择公众号关注组件');
  const copy = structuredClone(value);
  copy.splice(selected, 1);
  return { value: copy, selected: followEntries(copy)[0]?.index ?? -1 };
}

/** Only two explicit follow media slots can acquire canonical attachment identity. */
export function canonicalFollowBlock(raw: FollowRecord): FollowRecord {
  const block = structuredClone(raw);
  if (block.name === 'follow') for (const key of ['imgConfig', 'codeConfig']) {
    const field = followRecord(block[key]);
    if (field && typeof field.url === 'string') field.url = canonicalPresentationReference(field.url);
  }
  return block;
}

export function canonicalFollowValue(raw: string): string {
  const value: unknown = JSON.parse(raw);
  if (value === null) throw Error('装修 value 不能为 null');
  if (Array.isArray(value)) for (let index = 0; index < value.length; index++) {
    const row = followRecord(value[index]);
    if (row?.name === 'follow') value[index] = canonicalFollowBlock(row);
  }
  return JSON.stringify(value);
}

export function canonicalFollowImage(raw: string): string {
  const value = canonicalPresentationReference(raw.trim());
  if (value.length > 4096 || value && (!/^(?:https:\/\/|\/(?!\/))/iu.test(value) || /[\u0000-\u0020\u007f\\]/u.test(value))) throw Error('请选择有效的 HTTPS 或站内图片');
  return value;
}

/** Signed URLs are read capabilities tied to the exact stored asset, never saved. */
export function followPreviewBlock(raw: FollowRecord, previews: Record<string, string>): FollowRecord {
  const block = structuredClone(raw);
  if (block.name === 'follow') for (const key of ['imgConfig', 'codeConfig']) {
    const field = followRecord(block[key]);
    if (field && typeof field.url === 'string') {
      const reference = field.url;
      field.url = presentationPreviewForReference(reference, previews[canonicalPresentationReference(reference)]) || presentationPreviewUrl(reference);
    }
  }
  return block;
}
