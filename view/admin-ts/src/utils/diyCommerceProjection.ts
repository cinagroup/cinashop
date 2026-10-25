// Display-only parity with installed Uni commerce configuration; never modifies raw JSON.
import type { ThemePreset } from '../../../common/theme';
import type { GoodsListParams } from './diyListProjection';
import { navigationRecord as asDiyRecord, navFlag as isDiyEnabled } from './diyNavigationEditor';
import { listSafeColor as safeDiyColor } from './diyListProjection';
import { presentationPreviewUrl as safeDiyImageUrl } from './diyPresentationEditor';
import { diyThemeColor, diyThemeVariables } from './diyCommerceTheme';

export const DIY_COMMERCE_NAMES = ['promotionList', 'seckill', 'combination', 'bargain', 'presale', 'pointsMall', 'coupon', 'liveBroadcast'] as const;
export type DiyCommerceKind = typeof DIY_COMMERCE_NAMES[number];
type Style = Record<string, string>;
const record = (value: unknown) => asDiyRecord(value) ?? {};
const child = (value: unknown, key: string) => record(record(value)[key]);
const number = (value: unknown, fallback: number, cap = 100) => {
  const n = typeof value === 'number' || typeof value === 'string' && value !== '' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.min(n, cap) : fallback;
};
const text = (value: unknown, fallback = '', cap = 100) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, cap) : fallback;
function radius(block: unknown, key: string, order: number[], fallback = 8) {
  const cfg = child(block, key), values = cfg.valList;
  return isDiyEnabled(cfg.type) && Array.isArray(values) && values.length === 4
    ? order.map(i => `${number(record(values[i]).val, fallback) * 2}rpx`).join(' ')
    : `${number(cfg.val, fallback) * 2}rpx`;
}
function ids(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 100) return [];
  const result = value.map(raw => { const row = asDiyRecord(raw); return row?.id ?? row?.value ?? raw; });
  if (result.some(id => !(typeof id === 'number' || typeof id === 'string') || !/^[1-9]\d{0,9}$/u.test(String(id)) || Number(id) > 2147483647)) return [];
  return [...new Set(result.map(Number))];
}
export interface PromotionTab { label: string; description: string; image: string; query: GoodsListParams | null; configuredLimit: number; limit: number }
function promotionTabs(block: Record<string, unknown>): PromotionTab[] {
  const raw = child(block, 'tabConfig').list;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(rawTab => {
    const tab = asDiyRecord(rawTab); if (!tab) return [];
    const labels = Array.isArray(tab.chiild) ? tab.chiild : [];
    const selection = Number(tab.tabVal ?? 0) || 3;
    const selected = selection === 1 ? ids(child(tab, 'goodsList').ids ?? child(tab, 'goodsList').list)
      : selection === 2 ? ids(child(tab, 'brandConfig').brandVal)
      : selection === 3 ? ids(child(tab, 'selectConfig').activeValue) : selection === 4 ? ids(child(tab, 'goodsLabel').activeValue) : [];
    const configuredLimit = Math.floor(number(child(tab, 'numConfig').val, 6, 10000)), limit = Math.min(configuredLimit, 100);
    const scope = selection === 1 ? { ids: selected.join(',') } : selection === 2 ? { brand_id: selected.join(',') }
      : selection === 3 ? { cate_id: selected.join(',') } : { store_label_id: selected.join(',') };
    return [{ label: text(record(labels[0]).val, '商品分组', 30), description: text(record(labels[1]).val, '', 60), image: safeDiyImageUrl(tab.image), configuredLimit, limit,
      query: selected.length && limit > 0 ? { ...scope, page: 1, limit, ...(Number(tab.goodsSort) === 1 ? { salesOrder: 'desc' as const } : {}), ...(Number(tab.goodsSort) === 2 ? { priceOrder: 'desc' as const } : {}) } : null }];
  });
}
const titles: Partial<Record<DiyCommerceKind, string>> = { seckill: '限时秒杀', combination: '拼团精选', bargain: '全民砍价', presale: '预售专区', pointsMall: '积分商城', liveBroadcast: '直播间' };
export function normalizeDiyCommerce(value: unknown, preset: ThemePreset) {
  const block = record(value), kind = DIY_COMMERCE_NAMES.find(name => name === block.name) ?? null;
  const ordinal = (key: string, fallback: number, max: number) => Math.floor(number(child(block, key).tabVal, fallback, max));
  const style = ordinal('styleConfig', 0, kind === 'coupon' || kind === 'promotionList' ? 4 : kind === 'liveBroadcast' ? 3 : 1);
  const layout = ordinal('goodStyleConfig', kind === 'pointsMall' ? 0 : 1, kind === 'pointsMall' ? 2 : 3);
  const size = (key: string, fallback = 0, scale = 2) => `${number(child(block, key).val, fallback) * scale}rpx`;
  const color = (key: string, fallback: string, index = 0, tone = 'toneConfig') => diyThemeColor(tone === 'toneConfig' ? block : { ...block, toneConfig: block[tone] }, key, index, fallback, preset);
  const authoredColor = (key: string, fallback: string) => { const colors = child(block, key).color; return safeDiyColor(Array.isArray(colors) ? record(colors[0]).item : undefined, fallback); };
  const gradient = (key: string, fallback = '#ffffff', reverse = false, angle = 90, tone = 'toneConfig') => `linear-gradient(${angle}deg, ${color(key, fallback, reverse ? 1 : 0, tone)} 0%, ${color(key, fallback, reverse ? 0 : 1, tone)} 100%)`;
  const selected = child(block, 'checkboxInfo').type;
  const checks = Array.isArray(selected) ? [...new Set(selected.filter((n): n is number => Number.isInteger(n) && Number(n) >= 0 && Number(n) <= 5))] : [0, 1, 2, 3];
  const configuredLimit = Math.floor(number(child(block, 'numberConfig').val, kind === 'liveBroadcast' ? 10 : 6, 10000));
  const limit = Math.min(configuredLimit, kind === 'liveBroadcast' ? 50 : 10);
  const panelRadius = radius(block, 'fillet', [0, 1, 3, 2]);
  const titleFont = ordinal('titleText', 0, 2);
  const priceKey = ({ seckill: 'seckillPriceColor', combination: 'pinkPriceColor', bargain: 'bargainPriceColor', presale: 'presalePriceColor' } as Record<string, string>)[kind ?? ''] ?? 'goodsPriceColor';
  const actionKey = ({ seckill: 'seckillConfig', combination: 'pinkConfig', bargain: 'bargainConfig', presale: 'presaleConfig', promotionList: 'cartConfig' } as Record<string, string>)[kind ?? ''];
  // PHP pointsMall spacing uses rpx directly; its image/panel corners still use 2rpx.
  const scale = kind === 'pointsMall' ? 1 : 2;
  const tabs = kind === 'promotionList' ? promotionTabs(block) : [];
  return {
    kind, enabled: !!kind && isDiyEnabled(block.isShow ?? true), identity: String(block.timestamp ?? ''), style, layout, limit, configuredLimit, tabs, checks,
    limitNotice: configuredLimit > limit && kind === 'liveBroadcast' ? '直播预览最多显示50项' : '',
    title: text(child(block, 'titleTxtConfig').value, kind ? titles[kind] ?? '' : ''), titleMode: ordinal('titleConfig', 1, 1) ? 'text' : 'image',
    titleImage: safeDiyImageUrl(child(block, style ? 'imgConfig' : kind === 'pointsMall' ? 'imgConfig2' : 'imgColorConfig').url),
    more: text(child(block, 'rightBntConfig').value, '更多'), tip: text(child(block, 'tipTxtConfig').value),
    showAction: !!actionKey && ordinal(actionKey, 0, 1) === 0, cartMode: ordinal('bntConfig', 0, 1) === 1,
    cartStyle: ordinal('bntStyleConfig', 0, 2), stickyTabs: ordinal('slideConfig', 1, 1) === 0,
    wrapperStyle: { ...diyThemeVariables(block, preset), padding: `${size('topConfig', 0, scale)} ${size('prConfig', 0, scale)} ${size('bottomConfig', 0, scale)}`, marginTop: size('mbConfig', 0, scale), background: color('bottomBgColor', 'transparent') } as Style,
    panelStyle: { borderRadius: panelRadius, background: kind === 'coupon' && style !== 1 ? color('moduleColor2', '#ffffff') : gradient(kind === 'pointsMall' && !style ? 'moduleColor2' : 'moduleColor', '#ffffff', false, kind === 'pointsMall' ? 270 : 90) } as Style,
    headerStyle: { backgroundImage: style && safeDiyImageUrl(child(block, 'imgBgConfig').url) ? `url("${safeDiyImageUrl(child(block, 'imgBgConfig').url).replace(/["()]/gu, c => encodeURIComponent(c))}")` : gradient('headerBgColor') } as Style,
    titleStyle: { color: color('titleColor', '#333333'), fontSize: size('titleNumber', 16), fontWeight: titleFont === 0 ? 'bold' : 'normal', fontStyle: titleFont === 2 ? 'italic' : 'normal' } as Style,
    moreStyle: { color: color(style ? 'headerBntColor' : 'headerBntColor2', '#999999'), fontSize: size('bntNumber', 12) } as Style,
    tipStyle: { color: color(style ? 'tipsColor' : 'tipsColor2', '#999999') } as Style,
    dividerStyle: { color: color('dividerColor', '#cccccc') } as Style,
    imageStyle: { borderRadius: kind === 'promotionList' ? '16rpx' : radius(block, 'filletImg', ['combination', 'bargain', 'liveBroadcast'].includes(kind ?? '') ? [0, 1, 2, 3] : [0, 1, 3, 2]) } as Style,
    nameStyle: { color: kind === 'promotionList' ? '#333333' : color('goodsNameColor', '#333333'), fontWeight: ordinal('goodsName', 1, 1) ? 'normal' : '500' } as Style,
    priceStyle: { color: color(priceKey, preset.priceColor) } as Style,
    oldPriceStyle: { color: authoredColor('goodsPriceColor', '#999999') } as Style,
    buttonStyle: { color: '#ffffff', background: gradient(kind === 'promotionList' ? 'bntBgColor' : 'goodsBntColor', preset.theme, ['seckill', 'combination', 'bargain'].includes(kind ?? ''), 90, kind === 'promotionList' ? 'toneCartConfig' : 'toneConfig') } as Style,
    progressStyle: { background: gradient('progressColor', preset.theme) } as Style,
    labelStyle: { color: color('labelColor', preset.theme), borderColor: color('labelColor', preset.theme) } as Style,
    joinStyle: { color: color('joinNumColor', preset.theme) } as Style,
    bargainSuccessStyle: { color: color('joinNumColor2', preset.theme), background: gradient('joinBgColor') } as Style,
    countdownStyle: { background: color(style ? 'numberBgColor' : 'numberBgColor2', '#333333'), color: color(style ? 'numberColor' : 'numberColor2', '#ffffff') } as Style,
    pointsPriceStyle: { color: color(layout ? 'goodsUnitPriceColor' : 'goodsPriceColor', preset.priceColor), ...(layout ? {} : { background: gradient('priceBgColor', preset.theme) }) } as Style,
    pointsNumberStyle: { color: color(ordinal('toneConfig', 0, 1) ? 'goodsPriceColor2' : 'goodsPriceColor', preset.priceColor) } as Style,
    couponStyle: { marginRight: size('spacingConfig', 10), background: color('couponBgColor', preset.theme) } as Style,
    couponMoneyStyle: { color: color('couponMoneyColor', preset.priceColor) } as Style,
    couponButtonStyle: { background: gradient('bntBgColor', preset.theme, false, 180), color: '#ffffff' } as Style,
    liveCardStyle: style === 2 ? { marginLeft: size('liveConfig'), marginRight: size('liveConfig') } as Style : { marginTop: size('liveConfig') } as Style,
    liveStatusStyles: { 101: { background: color('playBg', preset.theme) }, 102: { background: color('notBg', '#333333') }, 103: { background: color('endBg', '#666666') } } as Record<number, Style>,
    promotionActiveStyle: { color: style === 1 ? '#282828' : style === 0 || style === 2 ? ordinal('toneConfig', 0, 1) ? authoredColor('textColor2', preset.theme) : preset.theme : '#ffffff', ...(style >= 3 ? { background: ordinal('toneConfig', 0, 1) ? gradient('decorateColor', preset.theme) : `linear-gradient(90deg, ${preset.gradient} 0%, ${preset.theme} 100%)` } : {}) } as Style,
    promotionDecorationStyle: { background: ordinal('toneConfig', 0, 1) ? style === 2 ? authoredColor('decorateColor2', preset.theme) : gradient('decorateColor', preset.theme) : `linear-gradient(90deg, ${preset.gradient} 0%, ${preset.theme} 100%)` } as Style,
  };
}
export type DiyCommerceConfig = ReturnType<typeof normalizeDiyCommerce>;
