import { asDiyRecord, isDiyEnabled, normalizeDiyLink, safeDiyImageUrl } from './diy';
import { listChild, listNumber, listOrdinal, listRadius, listRecord, listText } from './diyListConfig';
import { diyThemeColor } from './diyTheme';
import type { ThemePreset } from '../../../common/theme';

export interface DiyCarouselTab { index: number; title: string; kind: 'micro' | 'category'; id: number; valid: boolean }
export function diyCarouselTabs(value: unknown): DiyCarouselTab[] {
  const raw = listChild(value, 'tabListConfig').list;
  return [{ index: 0, title: '首页', kind: 'micro' as const, id: 0, valid: true }, ...(Array.isArray(raw) ? raw : []).map((item, i) => {
    const type=listChild(item,'dataType').tabVal,typeValid=type===undefined||type===0||type===1||type==='0'||type==='1';
    const kind = type===1||type==='1' ? 'category' as const : 'micro' as const;
    const idValue = listChild(item, kind === 'micro' ? 'microPage' : 'classPage').id;
    const id = (typeof idValue === 'number' || typeof idValue === 'string') && /^[1-9]\d{0,9}$/u.test(String(idValue)) ? Number(idValue) : NaN;
    return { index: i + 1, title: listText(listChild(item, 'text').val, '', 4), kind, id, valid: typeValid && Number.isSafeInteger(id) && id > 0 && id <= 2147483647 };
  })];
}
/** Each persisted family has a different link location. A field caption is
 * never treated as a destination and an invalid chosen slot cannot fall back. */
export function diyCarouselLink(kind: string, value: unknown): string {
  const item = listRecord(value), info = Array.isArray(item.info) ? item.info : [];
  const slot = listRecord(info[kind === 'swiperBg' ? 0 : 1]);
  if (kind === 'swipers') {
    const title=slot.title;
    return normalizeDiyLink(title===undefined||title===null||typeof title==='string'&&(!title.trim()||title.trim()==='链接')?slot.value:title);
  }
  return normalizeDiyLink(slot.value);
}
export function normalizeDiyCarousel(value: unknown, preset: ThemePreset) {
  const block = listRecord(value), kind = ['swipers', 'swiperBg', 'homeComb'].includes(String(block.name)) ? String(block.name) as 'swipers' | 'swiperBg' | 'homeComb' : null;
  const raw = listChild(block, 'swiperConfig').list;
  const items = (Array.isArray(raw) ? raw : []).flatMap((item, index) => {
    const row = asDiyRecord(item), image = safeDiyImageUrl(row?.img);
    return row && image ? [{ index, image, link: diyCarouselLink(kind ?? '', row) }] : [];
  });
  const home = kind === 'homeComb', legacy = kind === 'swipers';
  const style = listOrdinal(listChild(block, 'styleConfig').tabVal, home ? 0 : 1, 2);
  const custom = listOrdinal(listChild(block, 'toneConfig').tabVal, 0, 1) === 1;
  const color = (key: string, fallback: string, index = 0) => diyThemeColor(block, key, index, fallback, preset);
  const n = (key: string, fallback = 0, max = 100) => listNumber(listChild(block, key).val, fallback, max);
  const tabs = diyCarouselTabs(block);
  const words = listChild(block, 'hotWords').list;
  return {
    kind, enabled: !!kind && !isDiyEnabled(block.isHide) && isDiyEnabled(block.isShow ?? true), identity: String(block.timestamp ?? ''), items,
    style, stacked: legacy && listOrdinal(listChild(block, 'tabConfig').tabVal, 1, 1) === 0,
    interval: legacy ? 2500 : 3000, duration: 500,
    inactiveScale: kind==='swiperBg'?'.9':'.93',
    slideStyle: { padding: kind==='swiperBg' && style===2?`0 ${n('imgConfig',10)*2}rpx`:'0',boxSizing:'border-box' as const },
    previousMargin: `${legacy ? n('itemEdge') : home ? style ? 50 : 10 : style === 2 ? 55 : 0}rpx`,
    indicator: legacy ? listOrdinal(listChild(block, 'docConfig').type, 0, 1) === 1 ? 3 : 0 : listOrdinal(listChild(block, 'docConfig').tabVal, 0, 3),
    dotPosition: listOrdinal(listChild(block, 'docPosition').tabVal, 1, 2),
    dotColor: legacy?'#ffffff':home || custom ? color('dotColor', preset.theme) : 'var(--view-theme, #e93323)',
    dotBackground: legacy?'rgba(0,0,0,.4)':home || custom ? color('dotBgColor', '#dddddd') : '#dddddd',
    dotShape: legacy?listOrdinal(listChild(block,'docConfig').type,0,1)===1?{width:'20rpx',height:'5rpx',borderRadius:'3rpx'}:{width:'10rpx',height:'10rpx',borderRadius:'5rpx'}:{},
    wrapperStyle: legacy ? { marginTop: `${n('mbConfig')}rpx`, padding: `0 ${n('lrConfig')}rpx` }
      : home ? { paddingBottom: '30rpx' } : { marginTop: `${n('mbConfig') * 2}rpx`, padding: `${n('topConfig', 10) * 2}rpx ${n('prConfig', 10) * 2}rpx ${n('bottomConfig', 10) * 2}rpx` },
    horizontalPadding: legacy ? n('lrConfig') : home ? 10 : n('prConfig', 10) * 2,
    backgroundStyle: { background: color('bgColor', 'transparent'), height: !home && style === 1 ? '50%' : '100%' },
    imageStyle: { borderRadius: legacy ? isDiyEnabled(listChild(block, 'imgConfig').type) ? '0' : '10rpx' : listRadius(block, 'filletImg', home ? [0, 1, 2, 3] : [0, 1, 3, 2]) },
    tabs, showTabs: home && listOrdinal(listChild(block, 'classConfig').tabVal, 0, 1) === 0,
    logo: home ? safeDiyImageUrl(listChild(block, 'logoConfig').url) : '',
    hotWords: (Array.isArray(words) ? words : []).map(item => listText(listRecord(item).val, '', 100)).filter(Boolean),
    hotInterval: n('numConfig', 2.5, 3600) * 1000 || 2500,
    placeholder: listText(listChild(block, 'inputConfig').value, '请输入搜索词', 10),
    stickySearch: home && listOrdinal(listChild(block, 'searchConfig').tabVal, 0, 1) === 1,
    tabStyle: { marginRight: `${n('contentConfig', 20)}px` },
    categoryStyle: { background: `linear-gradient(90deg, ${color('classColor', preset.theme)} 0%, ${color('classColor', preset.theme, 1)} 100%)` },
  };
}
export type DiyCarouselConfig = ReturnType<typeof normalizeDiyCarousel>;
