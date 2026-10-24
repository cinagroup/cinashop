// Current public list projection, kept separate from the editor's raw document.
// Runtime parity tests load the actual installed Uni implementation independently.
import { themePreset, type ThemePreset } from '../../../common/theme';
import { navigationRecord as asDiyRecord } from './diyNavigationEditor';
export interface GoodsListParams { page?: number; limit?: number; ids?: string; brand_id?: string; cate_id?: string; store_label_id?: string; salesOrder?: 'desc'; priceOrder?: 'desc' }
export const listPreviewTheme = themePreset(3);
function isDiyEnabled(v: unknown) { return v === true || v === 1 || typeof v === 'string' && ['1', 'true'].includes(v.trim().toLowerCase()); }
export function listSafeColor(v: unknown, fallback = '') {
  if (typeof v !== 'string') return fallback; const color = v.trim();
  return /^#[0-9a-f]{3,8}$/iu.test(color) || /^(?:rgb|hsl)a?\([0-9.,%\s+-]+\)$/iu.test(color) ? color : /^(?:transparent|black|white)$/iu.test(color) ? color.toLowerCase() : fallback;
}
const safeDiyColor = listSafeColor;
function diyThemeColor(block: Record<string, unknown>, key: string, index: number, fallback: string, preset: ThemePreset): string {
  const roles: Record<string, keyof ThemePreset> = { goodsPriceColor: 'priceColor', bntBgColor: 'theme', themeColor: 'theme' };
  const role = roles[key], gradient = index > 0 && /(?:BgColor|BntColor)$/u.test(key);
  if (role && Number(asDiyRecord(block.toneConfig)?.tabVal) !== 1) return gradient ? preset.gradient : preset[role] as string;
  const colors = asDiyRecord(block[key])?.color, value = Array.isArray(colors) ? asDiyRecord(colors[index])?.item : undefined;
  return safeDiyColor(value, role ? gradient ? preset.gradient : preset[role] as string : fallback);
}
function diyThemeVariables(block: Record<string, unknown>, preset: ThemePreset): Record<string, string> {
  const main = diyThemeColor(block, 'themeColor', 0, preset.theme, preset), price = diyThemeColor(block, 'goodsPriceColor', 0, preset.priceColor, preset), button = diyThemeColor(block, 'bntBgColor', 0, preset.theme, preset), gradient = diyThemeColor(block, 'bntBgColor', 1, preset.gradient, preset);
  return { '--diy-theme': main, '--diy-price': price, '--diy-button': button, '--diy-gradient': gradient, '--view-theme': main, '--view-priceColor': price, '--view-gradient': gradient };
}
export const listRecord = (value: unknown) => asDiyRecord(value) ?? {};
export const listChild = (value: unknown, key: string) => listRecord(listRecord(value)[key]);
export function listNumber(value: unknown, fallback: number, max = 100) {
  const n = typeof value === 'number' || typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback;
}
export function listOrdinal(value: unknown, fallback: number, max: number) {
  const n = Number(value); return Number.isInteger(n) && n >= 0 && n <= max ? n : fallback;
}
export function listText(value: unknown, fallback = '', max = 100) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, max) : fallback;
}
export function listRadius(block: unknown, key: string, order = [0, 1, 3, 2]) {
  const cfg = listChild(block, key), values = cfg.valList;
  return isDiyEnabled(cfg.type) && Array.isArray(values) && values.length === 4
    ? order.map(i => `${listNumber(listRecord(values[i]).val, 0, 80) * 2}rpx`).join(' ')
    : `${listNumber(cfg.val, 0, 80) * 2}rpx`;
}
function selectedIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  if (value.some(id => !(typeof id === 'number' || typeof id === 'string') || !/^[1-9]\d{0,9}$/u.test(String(id)) || Number(id) > 2147483647)) return null;
  return [...new Set(value.map(Number))];
}
export function normalizeDiyList(value: unknown, preset: ThemePreset) {
  const block = listRecord(value), kind = block.name === 'goodList' || block.name === 'articleList' ? block.name : null;
  const goods = kind === 'goodList', style = listOrdinal(listChild(block, 'styleConfig').tabVal, 0, goods ? 5 : 2);
  const rawLimit = listChild(block, goods ? 'numberConfig' : 'numConfig').val ?? (goods ? 8 : 6);
  const parsedLimit = typeof rawLimit === 'number' || typeof rawLimit === 'string' && /^(?:0|[1-9]\d{0,4})$/u.test(rawLimit) ? Number(rawLimit) : NaN;
  const configuredLimit = Number.isSafeInteger(parsedLimit) && parsedLimit >= 0 && parsedLimit <= 10000 ? parsedLimit : 0;
  const limit = Math.min(configuredLimit, 100), scope = Number(listChild(block, 'typeConfig').activeValue);
  const sort = listOrdinal(listChild(block, 'goodsSort').tabVal, 0, 2);
  let error = parsedLimit !== configuredLimit ? '列表数量配置无效' : '', query: GoodsListParams | null = null;
  const cidValue = listChild(block, 'selectConfig').activeValue ?? 0;
  const cid = typeof cidValue === 'number' || typeof cidValue === 'string' && /^(?:0|[1-9]\d{0,9})$/u.test(cidValue) ? Number(cidValue) : NaN;
  if (goods) {
    const selected = scope === 1 ? selectedIds(listChild(block, 'goodsList').ids)
      : scope === 2 ? selectedIds(listChild(block, 'brandList').brandVal)
      : scope === 3 ? selectedIds(listChild(block, 'classList').classVal)
      : scope === 4 ? selectedIds(listChild(block, 'goodsLabel').activeValue) : null;
    if (!selected) error = '商品范围配置无效';
    else if (selected.length && limit > 0) query = {
      page: 1, limit,
      ...(scope === 1 ? { ids: selected.join(',') } : scope === 2 ? { brand_id: selected.join(',') }
        : scope === 3 ? { cate_id: selected.join(',') } : { store_label_id: selected.join(',') }),
      // PHP's fixed-ID branch does not apply a selected sort.
      ...(scope !== 1 && sort === 1 ? { salesOrder: 'desc' as const } : {}),
      ...(scope !== 1 && sort === 2 ? { priceOrder: 'desc' as const } : {}),
    };
  } else if (!Number.isSafeInteger(cid) || cid < 0 || cid > 2147483647) error = '文章分类配置无效';
  const rawChecks = listChild(block, goods ? 'checkboxInfo' : 'checkboxList').type;
  const checks = Array.isArray(rawChecks) ? [...new Set(rawChecks.filter((n): n is number => Number.isInteger(n) && Number(n) >= 0 && Number(n) <= (goods ? 5 : 2)))] : goods ? [0, 1, 2, 3, 4, 5] : [0, 1, 2];
  const rich = style === 0 || style === 1 || style === 4;
  const color = (key: string, fallback: string, index = 0) => diyThemeColor(block, key, index, fallback, preset);
  const authored = (key: string, fallback: string) => { const values = listChild(block, key).color; return safeDiyColor(Array.isArray(values) ? listRecord(values[0]).item : undefined, fallback); };
  const gradient = (key: string, fallback: string) => `linear-gradient(90deg, ${color(key, fallback)} 0%, ${color(key, fallback, 1)} 100%)`;
  const size = (key: string) => `${listNumber(listChild(block, key).val, 0, key === 'prConfig' ? 80 : 100) * 2}rpx`;
  let imageRadius = listRadius(block, 'filletImg', goods ? [0, 1, 2, 3] : [0, 1, 3, 2]);
  if (goods && style === 1) {
    const cfg = listChild(block, 'filletImg'), corners = cfg.valList;
    imageRadius = isDiyEnabled(cfg.type) && Array.isArray(corners) && corners.length === 4
      ? `${listNumber(listRecord(corners[0]).val, 0, 80) * 2}rpx ${listNumber(listRecord(corners[1]).val, 0, 80) * 2}rpx 0 0`
      : `${listNumber(cfg.val, 0, 80) * 2}rpx ${listNumber(cfg.val, 0, 80) * 2}rpx 0 0`;
  }
  const cartToneBlock = { ...block, toneConfig: block.toneCartConfig };
  const actionStyle = listOrdinal(listChild(block, 'bntStyleConfig').tabVal, 0, 2);
  const actionColor = (index: number) => diyThemeColor(actionStyle === 0 && (style === 0 || style === 4) ? block : cartToneBlock, 'bntBgColor', index, preset.theme, preset);
  return {
    kind, enabled: !!kind && isDiyEnabled(block.isShow ?? true), identity: String(block.timestamp ?? ''), style, limit, configuredLimit, cid, query, error, checks,
    limitNotice: configuredLimit > limit ? '列表预览最多显示100项' : '',
    showName: checks.includes(0), showLabels: goods && rich && checks.includes(1), showPrice: goods && checks.includes(2),
    showSales: goods && rich && checks.includes(3), showRating: goods && (style === 0 || style === 4) && checks.includes(4),
    showOffer: goods && rich && checks.includes(5), showBrand: goods && style === 1 && checks.includes(0), showFrame: goods && style !== 4,
    showAction: goods && style !== 3 && listOrdinal(listChild(block, 'cartConfig').tabVal, 0, 1) === 0,
    cartMode: listOrdinal(listChild(block, 'bntConfig').tabVal, 0, 1) === 1, actionStyle,
    wrapperStyle: { ...diyThemeVariables(block, preset), padding: `${size('topConfig')} ${size('prConfig')} ${size('bottomConfig')}`, marginTop: size('mbConfig'), background: authored('bottomBgColor', 'transparent'), borderRadius: listRadius(block, 'fillet') },
    panelStyle: { borderRadius: listRadius(block, 'fillet'), background: gradient(goods ? 'moduleColor' : 'bgColor', '#ffffff') },
    imageStyle: { borderRadius: imageRadius },
    nameStyle: { color: authored(goods ? 'goodsNameColor' : 'nameColor', '#333333'), fontWeight: listOrdinal(listChild(block, goods ? 'goodsName' : 'nameConfig').tabVal, 0, 1) ? 'normal' : goods ? '500' : 'bold' },
    priceStyle: { color: color('goodsPriceColor', preset.priceColor) },
    salesStyle: { color: Number(listChild(block, 'toneConfig').tabVal) === 1 ? authored('soldNumColor', '#999999') : '#999999' },
    ratingStyle: { color: Number(listChild(block, 'toneConfig').tabVal) === 1 ? authored('scoreColor', '#999999') : '#999999' },
    buttonStyle: { color: '#ffffff', background: `linear-gradient(90deg, ${actionColor(0)} 0%, ${actionColor(1)} 100%)` },
    timeStyle: { color: authored('timeColor', '#999999') }, statisticStyle: { color: authored('statisticColor', '#999999') },
    browseStyle: { color: authored('browseColor', '#999999') }, likeStyle: { color: authored('likeColor', '#999999') },
  };
}
export type DiyListConfig = ReturnType<typeof normalizeDiyList>;
