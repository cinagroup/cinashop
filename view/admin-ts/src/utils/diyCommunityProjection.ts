import { safeDiyColor, safeDiyImageUrl } from './diyStateProjection';
import { communityRecord as asDiyRecord, communityPreviewBlock } from './diyCommunityEditor';
import { navFlag as isDiyEnabled } from './diyNavigationEditor';

type Style = Record<string, string>;
const record = (value: unknown): Record<string, unknown> => asDiyRecord(value) ?? {};
const nested = (value: unknown, key: string) => record(record(value)[key]);
const number = (value: unknown, fallback: number, maximum: number) => {
  const parsed = typeof value === 'number' || typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(maximum, parsed) : fallback;
};
const size = (block: unknown, key: string, fallback: number, maximum = 100) => `${number(nested(block, key).val, fallback, maximum) * 2}rpx`;
const text = (value: unknown, fallback: string, maximum = 100) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, maximum) : fallback;
function color(block: unknown, key: string, index: number, fallback: string) {
  const values = nested(block, key).color;
  return safeDiyColor(Array.isArray(values) ? record(values[index]).item : undefined, fallback);
}
function radius(block: unknown, key: string, fallback: number): string {
  const value = nested(block, key), corners = value.valList;
  if ((value.type === 1 || value.type === true || value.type === '1') && Array.isArray(corners) && corners.length === 4)
    return (key === 'filletImg' ? [0, 1, 2, 3] : [0, 1, 3, 2]).map(index => `${number(record(corners[index]).val, fallback, 100) * 2}rpx`).join(' ');
  return `${number(value.val, fallback, 100) * 2}rpx`;
}
/** Only fields actually consumed by the PHP community widget enter this projection.
 * selectConfig intentionally does not become a topic filter or navigation authority. */
export function normalizeDiyCommunityPreview(raw: unknown, previews: Record<string, string> = {}) {
  const original = asDiyRecord(raw) ?? {}, block = communityPreviewBlock(original, previews);
  const reference = nested(original, 'imgConfig').url, imageField = asDiyRecord(block.imgConfig);
  // Managed IDs require their exact current capability. Imported public HTTP
  // and data images retain the public consumer's existing sanitizer behavior.
  if (imageField && typeof reference === 'string' && !/^\/api\/assets\//u.test(reference.trim())) imageField.url = reference;
  const source = record(block), rawLimit = nested(block, 'numberConfig').val;
  const parsedLimit = typeof rawLimit === 'number' || typeof rawLimit === 'string' && rawLimit.trim() !== '' ? Number(rawLimit) : NaN;
  const limit = Number.isFinite(parsedLimit) && parsedLimit >= 1 ? Math.min(100, Math.floor(parsedLimit)) : 3;
  const layout = Number(nested(block, 'styleConfig').tabVal) === 1 ? 'columns' : 'horizontal';
  const titleMode = Number(nested(block, 'titleConfig').tabVal ?? 1) === 0 ? 'image' : 'text';
  const titleType = Number(nested(block, 'titleText').tabVal), imageRadius = radius(block, 'filletImg', 8);
  const wrapperStyle: Style = { padding: `${size(block,'topConfig',0)} ${size(block,'prConfig',0)} ${size(block,'bottomConfig',0)}`,
    marginTop: size(block,'mbConfig',0), background: color(block,'bottomBgColor',0,'transparent') };
  const headerStyle: Style = { background: `linear-gradient(90deg, ${color(block,'headerBgColor',0,'#ffffff')} 0%, ${color(block,'headerBgColor',1,'#ffffff')} 100%)` };
  const titleStyle: Style = { color: color(block,'titleColor',0,'#222222'), fontSize: size(block,'titleNumber',16,40),
    fontWeight: titleType === 0 ? 'bold' : 'normal', fontStyle: titleType === 2 ? 'italic' : 'normal' };
  const buttonStyle: Style = { color: color(block,'headerBntColor',0,'#999999'), fontSize: size(block,'bntNumber',12,32) };
  const listStyle: Style = layout === 'columns' ? { background: '#ffffff', columnGap: '20rpx' }
    : { background: `linear-gradient(90deg, ${color(block,'moduleColor',0,'#ffffff')} 0%, ${color(block,'moduleColor',1,'#ffffff')} 100%)`, gap: size(block,'videoSpace2',10), paddingRight: size(block,'videoSpace2',10) };
  const key = source.timestamp;
  return { enabled: source.name === 'community' && !isDiyEnabled(source.isHide),
    key: typeof key === 'string' || typeof key === 'number' ? text(String(key),'',80) : '', limit, layout, titleMode,
    title: text(nested(block,'titleTxtConfig').value,'种草社区'), titleImage: safeDiyImageUrl(nested(block,'imgConfig').url),
    more: text(nested(block,'rightBntConfig').value,'好物分享'), wrapperStyle, headerStyle, titleStyle, buttonStyle, listStyle,
    panelStyle: { borderRadius: radius(block,'fillet',8) } as Style,
    imageStyle: { borderRadius: layout === 'columns' ? '16rpx 16rpx 0 0' : imageRadius } as Style };
}
