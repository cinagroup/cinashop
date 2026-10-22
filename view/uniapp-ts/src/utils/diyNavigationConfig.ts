import { isDiyEnabled, normalizeDiyLink, safeDiyColor, safeDiyImageUrl } from './diy';
import { diyCarouselTabs } from './diyCarouselConfig';
import { listChild, listNumber, listRadius, listRecord, listText } from './diyListConfig';
import type { ThemePreset } from '../../../common/theme';

export interface DiyNavigationItem {
  index: number; image: string; label: string; link: string; visible: boolean;
  rectangle?: { x: number; y: number; width: number; height: number };
}
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const visible = (value: unknown) => value === 1 || value === '1' || value === true;
function listOrdinal(value: unknown, fallback: number, max: number) { const n=typeof value==='number'||typeof value==='string'&&/^(?:0|[1-9]\d*)$/u.test(value)?Number(value):NaN;return Number.isInteger(n)&&n>=0&&n<=max?n:fallback; }
/** Read the persisted public slots, never the editor's preview menu or captions. */
export function normalizeDiyNavigation(value: unknown, preset: ThemePreset) {
  const block = listRecord(value), kind = ['headerSerch', 'tabNav', 'menus', 'pictureCube'].includes(String(block.name)) ? String(block.name) : null;
  const n = (key: string, fallback = 0, max = 100) => listNumber(listChild(block, key).val, fallback, max);
  const color = (key: string, fallback: string, index = 0) => safeDiyColor(listRecord(list(listChild(block, key).color)[index]).item, fallback);
  const gradient = (key: string, fallback: string) => `linear-gradient(90deg, ${color(key, fallback)} 0%, ${color(key, fallback, 1)} 100%)`;
  const custom = listOrdinal(listChild(block, 'toneConfig').tabVal, 0, 1) === 1;
  const style = listOrdinal(listChild(block, 'styleConfig').tabVal, 0, kind === 'pictureCube' ? 11 : 2);
  const columns = listOrdinal(listChild(block, 'number').tabVal, 0, 2) + 3;
  const rows = listOrdinal(listChild(block, 'rowsNum').tabVal, 0, 3) + 1;
  const items: DiyNavigationItem[] = kind === 'menus' ? list(listChild(block, 'menuConfig').list).flatMap((raw, index) => {
    const item = listRecord(raw), info = list(item.info);
    return [{ index, image: safeDiyImageUrl(item.img), label: listText(listRecord(info[0]).value, '', 200), link: normalizeDiyLink(listRecord(info[1]).value), visible: visible(item.show) }];
  }) : kind === 'pictureCube' ? list(listChild(block, 'picStyle')[style === 11 ? 'docPicList' : 'picList']).flatMap((raw, index) => {
    const item = listRecord(raw), doc = listRecord(item.doc), fields = [doc.startX, doc.startY, doc.w, doc.h];
    // The Admin draws on a 375 by 375 logical canvas. Bad rectangles cannot
    // become off-canvas click targets. Fractional 93.75-unit cells stay exact.
    const valid = fields.every(v => (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isFinite(Number(v)));
    const [x, y, width, height] = fields.map(Number) as [number, number, number, number];
    if (style === 11 && (!valid || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 375 || y + height > 375)) return [];
    return [{ index, image: safeDiyImageUrl(item[style === 11 ? 'img' : 'image']), label: '', link: normalizeDiyLink(item.link), visible: true, ...(style === 11 ? { rectangle: { x, y, width, height } } : {}) }];
  }) : [];
  const pageSize = columns * rows, pages: DiyNavigationItem[][] = [];
  for (let index = 0; index < items.length; index += pageSize) pages.push(items.slice(index, index + pageSize));
  const primary = custom ? color('decorateColor', preset.theme) : preset.theme;
  const secondary = custom ? color('decorateColor', preset.gradient, 1) : preset.gradient;
  const selectedText = style === 0 ? custom ? color('textColor', '#333333') : '#333333'
    : style === 1 ? custom ? color('textColor2', preset.theme) : preset.theme : custom ? color('textColor3', '#ffffff') : '#ffffff';
  return {
    kind, identity: String(block.timestamp ?? ''), enabled: !!kind && !isDiyEnabled(block.isHide) && isDiyEnabled(block.isShow ?? true), style, items, pages, columns, rows,
    // Style 11 has the same picList outer admission as the PHP consumer.
    hasCube: kind === 'pictureCube' && list(listChild(block, 'picStyle').picList).length > 0,
    paged: listOrdinal(listChild(block, 'showConfig').tabVal, 0, 1) === 1,
    menuStyle: listOrdinal(listChild(block, 'menuStyleConfig').tabVal, 0, 2),
    wrapperStyle: { boxSizing: 'border-box' as const, padding: kind === 'pictureCube' ? `0 ${n('prConfig') * 2}rpx` : `${n('topConfig') * 2}rpx ${n('prConfig') * 2}rpx ${n('bottomConfig') * 2}rpx`, marginTop: kind === 'headerSerch' ? '0' : `${n('mbConfig') * 2}rpx`, background: color('bottomBgColor', 'transparent') },
    panelStyle: { borderRadius: listRadius(block, 'fillet', kind === 'headerSerch' || kind === 'tabNav' ? [0, 1, 2, 3] : [0, 1, 3, 2]), background: gradient(kind === 'menus' ? 'bgColor' : 'moduleColor', '#ffffff') },
    imageStyle: { borderRadius: listRadius(block, 'filletImg') },
    imageGap: `${n('imgConfig') * 2}rpx`, horizontalPadding: n('prConfig') * 2,
    pointerColor: color('pointerColor', preset.theme), pointerBackground: color('pointerBgColor', '#dddddd'),
    tabs: diyCarouselTabs(block, 6), sticky: listOrdinal(listChild(block, 'stickyConfig').tabVal, 0, 1) === 0,
    selectedStyle: { color: selectedText, ...(style === 2 ? { background: `linear-gradient(90deg, ${primary} 0%, ${secondary} 100%)` } : {}) },
    decorationStyle: style === 0 ? { background: `linear-gradient(90deg, ${primary} 0%, ${secondary} 100%)` }
      : { borderBottomColor: custom ? color('decorateColor2', preset.theme) : preset.theme },
    logo: kind === 'headerSerch' ? safeDiyImageUrl(listChild(block, 'logoConfig').url) : '',
    title: listText(listChild(block, 'titleConfig').value, '', 200), titleLink: normalizeDiyLink(listChild(block, 'linkConfig').value),
    placeholder: listText(listChild(block, 'tipConfig').value, '搜索商品', 200),
    hotWords: list(listChild(block, 'hotWords').list).map(raw => listText(listRecord(raw).val, '', 200)).filter(Boolean),
    // The actual PHP header uses 3000/1000, unlike homeComb's numConfig.
    hotInterval: 3000, hotDuration: 1000,
    searchVariant: listOrdinal(listChild(block, 'styleSearchConfig').tabVal, 0, 2),
    searchStyle: { background: color('searchBoxColor', '#f5f5f5'), color: color('tipColor', '#cccccc') },
    hotStyle: { color: color('hotWordsColor', '#888888') },
    searchButtonStyle: { background: color('searchBgColor', preset.theme), color: color('searchTxtColor', '#ffffff') },
    searchTextStyle: { color: color('searchColor', preset.theme) },
    headerLogicalHeight: n('topConfig') * 2 + n('bottomConfig') * 2 + 96,
    tabLogicalHeight: (n('topConfig') + n('bottomConfig') + n('mbConfig')) * 2 + 80,
  };
}
export type DiyNavigationConfig = ReturnType<typeof normalizeDiyNavigation>;

/** Fixed cube mosaics use fractions of their real containing block. Natural
 * layouts (0,1,2,10) and the Admin's logical custom canvas (11) are separate. */
export function diyCubeRectangles(style: number, count: number): number[][] {
  if (style === 3) return [[0,0,.5,.5],[.5,0,.5,.5],[0,.5,1,.5]];
  if (style === 4) return [[0,0,1,.5],[0,.5,.5,.5],[.5,.5,.5,.5]];
  if (style === 5) return [[0,0,.5,1],[.5,0,.5,.5],[.5,.5,.5,.5]];
  if (style === 6) return [[0,0,.5,.5],[0,.5,.5,.5],[.5,0,.5,1]];
  if (style === 7) return Array.from({length:count}, (_,i) => [(i % 2) / 2, Math.floor(i / 2) / Math.ceil(count / 2), .5, 1 / Math.ceil(count / 2)]);
  if (style === 8) return [[0,0,.5,.5],[.5,0,.5,.5],[0,.5,1/3,.5],[1/3,.5,1/3,.5],[2/3,.5,1/3,.5]];
  if (style === 9) return [[0,0,.5,1],[.5,0,.5,.5],[.5,.5,.25,.5],[.75,.5,.25,.5]];
  return [];
}
