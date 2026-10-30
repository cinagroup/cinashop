/** PHP promotionList is a tab strip plus a delegated two-column goodList.
 * This module only projects display/read configuration. It never edits imports,
 * issues requests, grants product media authority or creates purchase state. */
type Row = Record<string, unknown>;
type Style = Record<string, string>;
export interface PromotionTheme { theme: string; gradient: string }
export const promotionRecord = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const child = (value: unknown, key: string) => promotionRecord(promotionRecord(value)[key]);
const flag = (value: unknown) => value === true || value === 1 || typeof value === 'string' && ['true', '1'].includes(value.trim().toLowerCase());
const number = (value: unknown, fallback: number, max = 100) => {
  const n = typeof value === 'number' || typeof value === 'string' && value !== '' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback;
};
const text = (value: unknown, fallback: string, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, max) : fallback;
/** Match the existing bounded Commerce read surface, retaining raw author data. */
export function promotionPublicIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const ids = value.map(raw => { const row = promotionRecord(raw); return row.id ?? row.value ?? raw; });
  if (ids.some(id => !(typeof id === 'number' || typeof id === 'string') || !/^[1-9]\d{0,9}$/u.test(String(id)) || Number(id) > 2147483647)) return null;
  return [...new Set(ids.map(Number))];
}
export function promotionProductBlock(raw: unknown, index: number): Row | null {
  const block = promotionRecord(raw), list = child(block, 'tabConfig').list;
  if (block.name !== 'promotionList' || !Array.isArray(list) || !Number.isInteger(index) || index < 0 || index >= Math.min(list.length, 12) || !list[index] || typeof list[index] !== 'object' || Array.isArray(list[index])) return null;
  const tab = promotionRecord(list[index]), rawSource = tab.tabVal;
  const parsed = typeof rawSource === 'number' || typeof rawSource === 'string' && rawSource.trim() !== '' ? Number(rawSource) : rawSource === undefined ? 0 : NaN;
  const selection = Number.isInteger(parsed) && parsed >= 0 && parsed <= 4 ? parsed === 0 ? 3 : parsed : -1;
  const source = selection === 1 ? child(tab, 'goodsList').ids ?? child(tab, 'goodsList').list
    : selection === 2 ? child(tab, 'brandConfig').brandVal : selection === 3 ? child(tab, 'selectConfig').activeValue : selection === 4 ? child(tab, 'goodsLabel').activeValue : null;
  const ids = promotionPublicIds(source), selected = ids ?? ['invalid-import'];
  return {
    name: 'goodList', timestamp: `${String(block.timestamp ?? '')}:${index}`,
    isShow: !flag(block.isHide) && flag(block.isShow ?? true), styleConfig: { tabVal: 1 },
    goodsList: { ids: selection === 1 ? selected : [] }, brandList: { brandVal: selection === 2 ? selected : [] },
    classList: { classVal: selection === 3 ? selected : [] }, goodsLabel: { activeValue: selection === 4 ? selected : [] },
    typeConfig: { activeValue: selection }, goodsSort: { tabVal: tab.goodsSort },
    numberConfig: { val: Math.floor(number(child(tab, 'numConfig').val, 6, 10000)) },
    bntStyleConfig: block.bntStyleConfig, cartConfig: block.cartConfig, bntConfig: block.bntConfig,
    toneCartConfig: block.toneCartConfig, bntBgColor: block.bntBgColor,
    filletImg: { type: 0, val: 8 }, checkboxInfo: { type: [0, 1, 2, 3, 4, 5] }, toneConfig: { tabVal: 0 },
    goodsName: { tabVal: 1 }, goodsNameColor: { color: [{ item: '#333333' }] },
    goodsPriceColor: { color: [{ item: 'var(--view-theme)' }] },
    topConfig: { val: 0 }, bottomConfig: { val: 0 }, mbConfig: { val: 0 }, prConfig: block.prConfig,
    bottomBgColor: { color: [{ item: '' }] }, fillet: { type: 0, val: 0 },
  };
}
export function promotionPresentation(raw: unknown, preset: PromotionTheme, safeImage: (value: unknown) => string, safeColor: (value: unknown, fallback: string) => string) {
  const block = promotionRecord(raw), rawStyle = Math.floor(number(child(block, 'styleConfig').tabVal, 0, 4));
  const custom = Number(child(block, 'toneConfig').tabVal) === 1;
  const color = (key: string, fallback: string, index = 0) => { const colors = child(block, key).color; return safeColor(Array.isArray(colors) ? promotionRecord(colors[index]).item : undefined, fallback); };
  const gradient = custom ? `linear-gradient(90deg, ${color('decorateColor', preset.theme)} 0%, ${color('decorateColor', preset.gradient, 1)} 100%)`
    : `linear-gradient(90deg, ${preset.gradient} 0%, ${preset.theme} 100%)`;
  const activeColor = rawStyle === 1 ? '#282828' : rawStyle >= 3 ? '#ffffff' : custom ? color('textColor2', preset.theme) : preset.theme;
  const items = child(block, 'tabConfig').list;
  const tabs = Array.isArray(items) ? items.slice(0, 12).flatMap((rawTab, index) => {
    if (!rawTab || typeof rawTab !== 'object' || Array.isArray(rawTab)) return [];
    const tab = promotionRecord(rawTab), labels = Array.isArray(tab.chiild) ? tab.chiild : [];
    return [{ index, label: text(promotionRecord(labels[0]).val, '商品分组', 30), description: text(promotionRecord(labels[1]).val, '', 60), image: safeImage(tab.image) }];
  }) : [];
  const size = (key: string) => `${number(child(block, key).val, 0) * 2}rpx`;
  return {
    enabled: block.name === 'promotionList' && !flag(block.isHide) && flag(block.isShow ?? true),
    key: String(block.timestamp ?? ''), style: rawStyle, sticky: Number(child(block, 'slideConfig').tabVal ?? 1) === 0, tabs,
    overflow: Array.isArray(items) && items.length > 12,
    wrapperStyle: { padding: `${size('topConfig')} ${size('prConfig')} ${size('bottomConfig')}`, marginTop: size('mbConfig'), background: color('bottomBgColor', 'transparent') } as Style,
    activeTextStyle: { color: activeColor, ...(rawStyle >= 3 ? { background: gradient } : {}) } as Style,
    decorationStyle: { background: gradient } as Style,
    lineStyle: rawStyle === 2 ? { borderBottomColor: activeColor } as Style : { background: gradient } as Style,
    imageBorderStyle: { borderColor: preset.theme, background: '#ffffff' } as Style,
  };
}
export function promotionTabPresentation(view: ReturnType<typeof promotionPresentation>, index: number, selected: number) {
  const style = view.style, active = index === selected, position = view.tabs.findIndex(tab => tab.index === index);
  const edge = style === 0 ? 36 : style === 3 ? 20 : 24, gap = style === 0 ? 66 : style === 1 || style === 2 ? 56 : 16;
  return {
    itemStyle: { position: 'relative', display: 'inline-block', verticalAlign: 'top', textAlign: 'center', border: '0', background: 'transparent', lineHeight: 'normal',
      padding: style === 0 ? '20rpx 0 14rpx' : style === 1 || style === 2 ? '18rpx 0' : style === 3 ? '16rpx 0' : '20rpx 0',
      margin: `0 ${position === view.tabs.length - 1 ? edge : gap}rpx 0 ${position === 0 ? edge : 0}rpx` } as Style,
    textStyle: { display: 'block', position: 'relative', zIndex: '1', fontSize: `${style === 0 ? 30 : style === 1 || style === 2 ? active ? 32 : 28 : style === 3 ? active ? 26 : 28 : 24}rpx`,
      lineHeight: `${style === 0 ? 42 : style === 1 || style === 2 ? 44 : style === 3 ? 48 : 40}rpx`,
      fontWeight: active && style < 3 ? '500' : 'normal', color: style === 4 ? '#333333' : '#282828',
      ...(style >= 3 ? { height: `${style === 3 ? 48 : 40}rpx`, padding: style === 3 ? '0 20rpx' : '0 12rpx', borderRadius: `${style === 3 ? 24 : 20}rpx`, ...(style === 4 ? { marginTop: '8rpx' } : {}) } : {}),
      ...(active ? view.activeTextStyle : {}) } as Style,
    descriptionStyle: { display: 'inline-block', height: '38rpx', lineHeight: '38rpx', padding: '0 12rpx', borderRadius: '19rpx', marginTop: '6rpx', fontSize: active ? '22rpx' : '24rpx', color: active ? '#ffffff' : '#999999', ...(active ? view.decorationStyle : {}) } as Style,
    lineStyle: style === 2 ? { position: 'absolute', bottom: '8rpx', left: '50%', width: '64rpx', height: '64rpx', border: '4rpx solid transparent', borderRadius: '50%', transform: 'translateX(-50%)', ...(active ? view.lineStyle : {}) } as Style
      : { position: 'absolute', bottom: '22rpx', left: '0', width: '100%', height: '8rpx', borderRadius: '4rpx', ...(active ? view.lineStyle : {}) } as Style,
    imageWrapStyle: { display: 'flex', justifyContent: 'center', alignItems: 'center', boxSizing: 'content-box', width: '104rpx', height: '104rpx', border: '3rpx solid transparent', borderRadius: '50%', margin: '0 auto', ...(active ? view.imageBorderStyle : {}) } as Style,
    imageStyle: { display: 'block', width: '92rpx', height: '92rpx', border: '1rpx solid #eeeeee', borderRadius: '50%' } as Style,
  };
}
