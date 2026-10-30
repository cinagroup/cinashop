import { resolveRegisteredPageRoute } from '../../../uniapp-ts/src/config/navigation';
import { navigationRecord, navRead, navFlag } from './diyNavigationEditor';
import { listChild, listNumber, listOrdinal, listRadius, listRecord, listText } from './diyListProjection';
import { safeDiyImageUrl, diyThemeColor, diyThemeVariables, statePreviewTheme } from './diyStateProjection';
import { canonicalPresentationReference, presentationPreviewForReference, presentationPreviewUrl } from './diyPresentationEditor';
import { canonicalEditorialBlock, editorialKind, editorialItems, type EditorialRecord } from './diyEditorialEditor';
import { fabLinkSafe } from '@/api/fabSettings';

const link = (value: unknown) => {
  const row = navigationRecord(value), raw = typeof value === 'string' ? value.trim() : ['url', 'value', 'title', 'link'].map(key => row?.[key]).find((v): v is string => typeof v === 'string' && !!v.trim())?.trim() ?? '';
  if (!fabLinkSafe(raw)) return '';
  if (/^https?:\/\//iu.test(raw) || raw.includes('@APPID=')) return raw;
  if (!raw.startsWith('/pages/')) return '';
  const [path, query = ''] = raw.split('?', 2);
  return /^\/pages\/[a-z0-9_/-]+$/iu.test(path) ? resolveRegisteredPageRoute(path, query) : '';
};
export const editorialPixels = (style: Record<string, string>) => Object.fromEntries(Object.entries(style).map(([key, value]) => [key, value.replace(/([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)rpx/giu, (_, n: string) => `${Number(n) / 2}px`)]));

/** Published activeParty has precisely four author-only metadata removals. */
export function publishedEditorialIdentity(value: EditorialRecord) {
  const block = canonicalEditorialBlock(value);
  if (block.name === 'activeParty') for (const key of ['titleConfig', 'desConfig']) { const field = navigationRecord(block[key]); if (field) { delete field.place; delete field.max; } }
  return JSON.stringify(block);
}
export function editorialMediaReferences(block: unknown): string[] {
  const kind = editorialKind(navigationRecord(block)?.name);
  const refs = kind === 'news' ? [navRead(block, ['imgConfig', 'url'])] : kind === 'hotspot' ? [navRead(block, ['picStyle', 'url'])] : kind === 'activeParty' ? editorialItems(block).map(item => navRead(item, ['img'])) : [];
  return refs.filter((value): value is string => typeof value === 'string' && value !== '');
}
/** An image is rendered only with a matching preview capability or safe public URL. */
export function editorialMediaPreview(raw: unknown, previews: Record<string, string>) {
  if (typeof raw !== 'string') return '';
  if (/^\/api\/assets\//u.test(raw.trim())) return presentationPreviewForReference(raw, previews[canonicalPresentationReference(raw)]) || presentationPreviewUrl(raw);
  return safeDiyImageUrl(raw);
}
export function normalizeDiyEditorialPreview(value: unknown, previews: Record<string, string> = {}) {
  const block = listRecord(value), kind = editorialKind(block.name), preset = statePreviewTheme;
  const color = (key: string, fallback: string, index = 0) => diyThemeColor(block, key, index, fallback, preset);
  const gradient = (key: string, fallback = '#ffffff') => `linear-gradient(90deg, ${color(key, fallback)} 0%, ${color(key, fallback, 1)} 100%)`;
  const size = (key: string) => `${listNumber(listChild(block, key).val, 0, key === 'prConfig' ? 80 : 100) * 2}rpx`;
  const image = (raw: unknown) => safeDiyImageUrl(editorialMediaPreview(raw, previews));
  const newsItems = editorialItems(block).slice(0, 10).flatMap((raw, index) => {
    const item = listRecord(raw), children = Array.isArray(item.chiild) ? item.chiild : [], title = listText(listRecord(children[0]).val, '', 100);
    return navFlag(item.show) && title ? [{ index, title, link: link(listRecord(children[1]).val) }] : [];
  });
  const partyItems = editorialItems(block).slice(0, 4).flatMap((raw, index) => {
    const item = listRecord(raw), info = Array.isArray(item.info) ? item.info : [], title = listText(listRecord(info[0]).value, '', 4), description = listText(listRecord(info[1]).value, '', 20), src = image(item.img);
    return title || description || src ? [{ index, title, description, image: src, link: link(listRecord(info[2]).value) }] : [];
  });
  const hotspotAreas = editorialItems(block).slice(0, 30).flatMap((raw, index) => {
    const item = listRecord(raw), target = link(item.link), coordinates = [item.starX, item.starY, item.areaWidth, item.areaHeight];
    if (!target || coordinates.some(value => !(typeof value === 'number' || typeof value === 'string' && value.trim() !== '') || !Number.isFinite(Number(value)) || Number(value) > 1_000_000)) return [];
    const [left, top, width, height] = coordinates.map(Number) as [number, number, number, number];
    return left < 0 || top < 0 || left >= 750 || width <= 0 || height <= 0 ? [] : [{ index, left, top, width, height, link: target }];
  });
  return {
    kind, enabled: !!kind && !navFlag(block.isHide) && navFlag(block.isShow ?? true), newsItems, partyItems,
    newsListStyle: listOrdinal(listChild(block, 'styleConfig').tabVal, 0, 1) === 1,
    horizontalNews: listOrdinal(listChild(block, 'rollConfig').tabVal, 0, 1) === 1,
    titleImage: listOrdinal(listChild(block, 'titleConfig').tabVal, 1, 1) === 0 ? image(listChild(block, 'imgConfig').url) : '',
    titleText: listOrdinal(listChild(block, 'titleConfig').tabVal, 1, 1) === 1 ? listText(listChild(block, 'titleTxtConfig').value, '商城头条', 20) : '',
    showMore: listOrdinal(listChild(block, 'buttonConfig').tabVal, 0, 1) === 0,
    moreText: listText(listChild(block, 'textConfig').value, '更多', 10),
    partyTitle: listText(listChild(block, 'titleConfig').value, '', 10), partyBadge: listText(listChild(block, 'desConfig').value, '', 8),
    hotspotImage: image(listChild(block, 'picStyle').url), hotspotAreas,
    outerStyle: { ...diyThemeVariables(block, preset), padding: `${size('topConfig')} ${size('prConfig')} ${size('bottomConfig')}`, marginTop: size('mbConfig'), background: color('bottomBgColor', 'transparent') },
    cardStyle: { borderRadius: listRadius(block, 'fillet'), background: gradient('moduleColor') },
    radiusStyle: { borderRadius: listRadius(block, 'fillet') },
    titleStyle: { color: color('titleColor', '#333333') },
    tickerTitleStyle: { color: Number(listChild(block, 'toneConfig').tabVal) === 1 ? color('titleColor', '#ffffff') : '#ffffff', background: Number(listChild(block, 'toneConfig').tabVal) === 1 ? gradient('titleBgColor', preset.theme) : preset.theme },
    newsTextStyle: { color: color('newsColor', '#333333') }, buttonStyle: { color: color('bntColor', '#999999') },
    partyStyle: { background: color('boxColor', '#fff4f2') }, partyTitleStyle: { color: color('themeColor', preset.theme) }, partyBadgeStyle: { background: gradient('bgColor', preset.theme) },
  };
}
