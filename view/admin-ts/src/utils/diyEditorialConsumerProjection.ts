// Read-only author preview. Consumer parity is tested independently.
import type { ThemePreset } from '../../../common/theme';
import { isDiyEnabled, safeDiyImageUrl, diyThemeColor, diyThemeVariables } from './diyStateProjection';
import { navigationLink } from './diyNavigationEditor';
function normalizeDiyLink(value: unknown) { if(typeof value!=='string')return '';try{return navigationLink(value);}catch{return '';} }
import { listChild, listNumber, listOrdinal, listRadius, listRecord, listText } from './diyListProjection';

export const DIY_EDITORIAL_NAMES = ['news', 'hotspot', 'follow', 'activeParty'] as const;
export interface DiyHotspotArea { index: number; left: number; top: number; width: number; height: number; link: string }
export function projectDiyHotspots(areas: DiyHotspotArea[], width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
  const canvasHeight = 750 * height / width;
  return areas.flatMap(area => {
    if (![area.left, area.top, area.width, area.height].every(Number.isFinite) || area.left < 0 || area.top < 0 || area.width <= 0 || area.height <= 0) return [];
    if (area.left >= 750 || area.top >= canvasHeight) return [];
    const w = Math.min(area.width, 750 - area.left), h = Math.min(area.height, canvasHeight - area.top);
    if (w <= 0 || h <= 0) return [];
    return [{ ...area, style: { left: `${area.left / 750 * 100}%`, top: `${area.top / canvasHeight * 100}%`, width: `${w / 750 * 100}%`, height: `${h / canvasHeight * 100}%` } }];
  });
}
export function normalizeDiyEditorial(value: unknown, preset: ThemePreset) {
  const block = listRecord(value), kind = DIY_EDITORIAL_NAMES.find(name => name === block.name) ?? null;
  const color = (key: string, fallback: string, index = 0) => diyThemeColor(block, key, index, fallback, preset);
  const gradient = (key: string, fallback = '#ffffff') => `linear-gradient(90deg, ${color(key, fallback)} 0%, ${color(key, fallback, 1)} 100%)`;
  const size = (key: string) => `${listNumber(listChild(block, key).val, 0, key === 'prConfig' ? 80 : 100) * 2}rpx`;
  const rawNews = listChild(block, 'listConfig').list, rawParty = listChild(block, 'menuConfig').list;
  const newsItems = (Array.isArray(rawNews) ? rawNews : []).flatMap(value => {
    const item = listRecord(value), children = Array.isArray(item.chiild) ? item.chiild : [];
    const title = listText(listRecord(children[0]).val, '', 100);
    return isDiyEnabled(item.show) && title ? [{ title, link: normalizeDiyLink(listRecord(children[1]).val) }] : [];
  });
  const partyItems = (Array.isArray(rawParty) ? rawParty : []).slice(0, 4).flatMap(value => {
    const item = listRecord(value), info = Array.isArray(item.info) ? item.info : [];
    const title = listText(listRecord(info[0]).value, '', 4), description = listText(listRecord(info[1]).value, '', 20), image = safeDiyImageUrl(item.img);
    return title || description || image ? [{ title, description, image, link: normalizeDiyLink(listRecord(info[2]).value) }] : [];
  });
  const rawAreas = listChild(block, 'picStyle').list;
  const hotspotAreas: DiyHotspotArea[] = (Array.isArray(rawAreas) ? rawAreas : []).flatMap((value, index) => {
    const item = listRecord(value), link = normalizeDiyLink(item.link);
    const coordinates = [item.starX, item.starY, item.areaWidth, item.areaHeight];
    if (!link || coordinates.some(value => !(typeof value === 'number' || typeof value === 'string' && value.trim() !== '') || !Number.isFinite(Number(value)) || Number(value) > 1_000_000)) return [];
    const [left, top, width, height] = coordinates.map(Number) as [number, number, number, number];
    if (left < 0 || top < 0 || left >= 750 || width <= 0 || height <= 0) return [];
    return [{ index, left, top, width, height, link }];
  });
  const moreValue = listChild(block, 'linkConfig').value;
  const titleImage = listOrdinal(listChild(block, 'titleConfig').tabVal, 1, 1) === 0 ? safeDiyImageUrl(listChild(block, 'imgConfig').url) : '';
  return {
    kind, enabled: !!kind && isDiyEnabled(block.isShow ?? true), identity: String(block.timestamp ?? ''),
    newsItems, newsListStyle: listOrdinal(listChild(block, 'styleConfig').tabVal, 0, 1) === 1,
    horizontalNews: listOrdinal(listChild(block, 'rollConfig').tabVal, 0, 1) === 1,
    titleImage, titleText: listOrdinal(listChild(block, 'titleConfig').tabVal, 1, 1) === 1 ? listText(listChild(block, 'titleTxtConfig').value, '商城头条', 20) : '',
    showMore: listOrdinal(listChild(block, 'buttonConfig').tabVal, 0, 1) === 0,
    moreText: listText(listChild(block, 'textConfig').value, '更多', 10), moreLink: normalizeDiyLink(moreValue === undefined || moreValue === '' ? '/pages/article/list' : moreValue),
    hotspotImage: safeDiyImageUrl(listChild(block, 'picStyle').url), hotspotAreas,
    partyTitle: listText(listChild(block, 'titleConfig').value, '', 10), partyBadge: listText(listChild(block, 'desConfig').value, '', 8), partyItems,
    followImage: safeDiyImageUrl(listChild(block, 'imgConfig').url), followCode: safeDiyImageUrl(listChild(block, 'codeConfig').url), followTitle: listText(listChild(block, 'titleConfig').value, '关注公众号', 40),
    outerStyle: { ...diyThemeVariables(block, preset), padding: `${size('topConfig')} ${size('prConfig')} ${size('bottomConfig')}`, marginTop: size('mbConfig'), background: color('bottomBgColor', 'transparent') },
    radiusStyle: { borderRadius: listRadius(block, 'fillet') },
    cardStyle: { borderRadius: listRadius(block, 'fillet'), background: gradient('moduleColor') },
    titleStyle: { color: color('titleColor', '#333333') },
    tickerTitleStyle: Number(listChild(block, 'toneConfig').tabVal) === 1
      ? { color: color('titleColor', '#ffffff'), background: gradient('titleBgColor', preset.theme) }
      : { color: '#ffffff', background: preset.theme },
    newsTextStyle: { color: color('newsColor', '#333333') }, buttonStyle: { color: color('bntColor', '#999999') },
    partyStyle: { background: color('boxColor', '#fff4f2') },
    partyTitleStyle: { color: color('themeColor', preset.theme) }, partyBadgeStyle: { background: gradient('bgColor', preset.theme) },
    followWrapStyle: { ...diyThemeVariables(block, preset), padding: `0 ${size('prConfig')}`, marginTop: size('mbConfig') },
    followCardStyle: { borderRadius: listRadius(block, 'fillet'), background: gradient('bgColor') },
    followButtonStyle: { color: color('themeColor', preset.theme), borderColor: color('themeColor', preset.theme) },
  };
}
export type DiyEditorialConfig = ReturnType<typeof normalizeDiyEditorial>;
