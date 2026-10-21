import type { ThemePreset } from '../../../common/theme';
import type { DiyNewcomerData, DiyProduct, DiyProductRanks, DiySignData, DiyUserInfo } from '@/api/diy';
import { asDiyRecord, isDiyEnabled, safeDiyColor, safeDiyImageUrl } from '@/utils/diy';
import { diyThemeColor, diyThemeVariables } from '@/utils/diyTheme';

export const DIY_STATE_WIDGET_NAMES = ['userInfor', 'newVip', 'signIn', 'ranking'] as const;
export type DiyStateKind = typeof DIY_STATE_WIDGET_NAMES[number];
type Style = Record<string, string>;
const record = (value: unknown): Record<string, unknown> => asDiyRecord(value) ?? {};
const nested = (source: unknown, key: string) => record(record(source)[key]);
const bounded = (value: unknown, fallback: number, cap = 100): number => {
  const n = typeof value === 'number' || typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.min(n, cap) : fallback;
};
const text = (value: unknown, fallback = '', cap = 100) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, cap) : fallback;
function radius(source: unknown, key: string, fallback: number, order: number[], pixels = false) {
  const config = nested(source, key), list = config.valList;
  return isDiyEnabled(config.type) && Array.isArray(list) && list.length === 4
    ? order.map(i => `${bounded(record(list[i]).val, fallback) * (pixels ? 1 : 2)}${pixels ? 'px' : 'rpx'}`).join(' ')
    : `${bounded(config.val, fallback) * (pixels ? 1 : 2)}${pixels ? 'px' : 'rpx'}`;
}
export function normalizeDiyStateWidget(value: unknown, preset: ThemePreset) {
  const block = record(value), name = block.name;
  const kind = DIY_STATE_WIDGET_NAMES.find(item => item === name) ?? null;
  const style = Number(nested(block, 'styleConfig').tabVal ?? (kind === 'userInfor' ? 1 : 0)) === 1 ? 1 : 0;
  const size = (key: string, fallback = 0) => `${bounded(nested(block, key).val, fallback) * 2}rpx`;
  const colour = (key: string, fallback: string, index = 0, tone = 'toneConfig') => diyThemeColor(
    tone === 'toneConfig' ? block : { ...block, toneConfig: block[tone] }, key, index, fallback, preset);
  const gradient = (key: string, fallback = '#ffffff', tone = 'toneConfig', angle = 90) => `linear-gradient(${angle}deg, ${colour(key, fallback, 0, tone)} 0%, ${colour(key, fallback, 1, tone)} 100%)`;
  const selected = nested(block, 'checkboxInfo').type;
  const checks = Array.isArray(selected) ? [...new Set(selected.filter((n): n is number => Number.isInteger(n) && Number(n) >= 0 && Number(n) <= (kind === 'userInfor' ? 5 : 2)))]
    : kind === 'userInfor' ? [3, 1, 2] : [0, 1, 2];
  const titleType = Number(nested(block, 'titleText').tabVal);
  const wrapperStyle: Style = { ...diyThemeVariables(block, preset), padding: `${size('topConfig')} ${size('prConfig')} ${size('bottomConfig')}`,
    marginTop: size('mbConfig'), background: colour('bottomBgColor', 'transparent') };
  const panelStyle: Style = { borderRadius: radius(block, 'fillet', 8, kind === 'userInfor' || kind === 'signIn' ? [0, 1, 2, 3] : [0, 1, 3, 2]),
    background: gradient(kind === 'signIn' && style === 0 ? 'moduleColor2' : 'moduleColor', '#ffffff', 'toneConfig', kind === 'signIn' ? 270 : 90) };
  const couponTone = 'toneCouponConfig';
  return { kind, enabled: kind !== null && !isDiyEnabled(block.isHide), key: text(String(block.timestamp ?? ''), '', 80), style, checks,
    titleMode: Number(nested(block, 'titleConfig').tabVal ?? 1) === 0 ? 'image' : 'text',
    title: text(nested(block, 'titleTxtConfig').value, kind === 'ranking' ? '排行榜' : '新人专享福利'),
    titleImage: safeDiyImageUrl(nested(block, 'imgConfig').url), more: text(nested(block, 'rightBntConfig').value, '更多'),
    avatar: safeDiyImageUrl(nested(block, 'logoConfig').url), wrapperStyle, panelStyle,
    titleStyle: { color: colour('titleColor', '#333333'), fontSize: size('titleNumber', 16), fontWeight: titleType === 0 ? 'bold' : 'normal', fontStyle: titleType === 2 ? 'italic' : 'normal' } as Style,
    moreStyle: { color: kind === 'ranking' && style === 0 ? '#999999' : colour('headerBntColor', '#999999'), fontSize: size('bntNumber', 12) } as Style,
    progressTrackStyle: { background: colour('progressBgColor', '#eeeeee') } as Style,
    progressFillStyle: { background: gradient('progressColor', preset.theme) } as Style,
    badgeStyle: { color: preset.theme, backgroundColor: '#f5f5f5' } as Style,
    buttonStyle: { background: gradient(kind === 'newVip' && style === 1 ? 'bntColor' : 'bntBgColor', preset.theme), color: colour('bntTxtColor', '#ffffff') } as Style,
    rewardStyle: { color: colour('labelTxtColor', preset.theme), background: colour('labelBgColor', '#fceae9') } as Style,
    bonusStyle: { background: colour('integralBgColor', preset.theme), color: colour(style === 1 ? 'integralTxtColor' : 'tipsColor', preset.priceColor) } as Style,
    couponListStyle: { background: gradient('couponBgColor', '#ffffff', couponTone) } as Style,
    couponStyle: { marginRight: size(style === 1 ? 'spacingConfig2' : 'spacingConfig', 10), background: colour(style === 1 ? 'couponBgColor2' : 'couponBgColor', '#ffffff', 0, couponTone) } as Style,
    couponMoneyStyle: { color: colour('couponMoneyColor', preset.priceColor, 0, couponTone) } as Style,
    couponTypeStyle: { color: colour('couponTypeColor', '#666666', 0, couponTone) } as Style,
    couponInfoStyle: { background: `linear-gradient(90deg, ${colour('bntBgColor', preset.theme, 1, couponTone)} 0%, ${colour('bntBgColor', preset.theme, 0, couponTone)} 100%)` } as Style,
    couponStationStyle: { background: gradient('vipBgColor', '#ffffff', couponTone) } as Style,
    couponButtonStyle: { color: colour('bntTxtColor', '#ffffff', 0, couponTone), background: gradient('bntBgColor', preset.theme, couponTone) } as Style,
    priceStyle: { color: colour(kind === 'newVip' ? 'priceColor' : 'goodsPriceColor', preset.priceColor, 0, kind === 'newVip' ? 'toneGoodsConfig' : 'toneConfig') } as Style,
    rankCardStyle: { background: gradient('listBgColor'), borderRadius: radius(block, 'filletBg', 8, [0, 1, 3, 2], true) } as Style,
    rankLabelStyle: { color: colour('classColor', preset.theme) } as Style,
    rankImageStyle: { borderRadius: radius(block, 'filletImg', 8, [0, 1, 3, 2]) } as Style,
  };
}

const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= 2147483647;
const money = (value: unknown) => (typeof value === 'string' || typeof value === 'number') && /^(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/u.test(String(value));
const validText = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096;
function products(value: unknown, limit: number): DiyProduct[] {
  if (!Array.isArray(value) || value.length > limit) throw Error('DIY商品列表格式错误');
  const ids = new Set<number>();
  return value.map(raw => {
    const row = record(raw);
    if (!integer(row.id, 1) || ids.has(row.id) || !validText(row.store_name) || !validText(row.image) || !money(row.price)
      || row.ot_price !== undefined && !money(row.ot_price)) throw Error('DIY商品格式错误');
    ids.add(row.id); return { ...row, id: row.id, store_name: row.store_name, image: safeDiyImageUrl(row.image), price: row.price as string | number };
  });
}
export type DiyMemberState = Omit<DiyUserInfo, 'exp'> & { exp: number };
export interface DiyStateData { user: DiyMemberState | null; newcomer: DiyNewcomerData | null; sign: DiySignData | null; ranks: DiyProductRanks | null }
export const emptyDiyStateData = (): DiyStateData => ({ user: null, newcomer: null, sign: null, ranks: null });
/** Validate the entire receipt before adopting any fields or authored navigation. */
export function checkedDiyStateData(kind: DiyStateKind, value: unknown, owner: number): DiyStateData {
  const data = emptyDiyStateData(), row = record(value);
  if (kind === 'userInfor') {
    if (Array.isArray(value) && value.length === 0) return data;
    if (!integer(row.uid, 1) || row.uid !== owner || !['nickname', 'phone', 'avatar', 'vip_name', 'bar_code'].every(key => validText(row[key]))
      || !['level', 'integral', 'next_exp', 'coupon_num', 'collectCount', 'visit_num', 'is_money_level'].every(key => integer(row[key])) || !money(row.now_money) || !money(row.exp)) throw Error('会员信息不属于当前账号或格式错误');
    // PostgreSQL numeric exp is a decimal string; normalize only after checking it.
    data.user = { ...row, exp: Number(row.exp), avatar: safeDiyImageUrl(row.avatar) } as unknown as DiyMemberState;
  } else if (kind === 'ranking') {
    data.ranks = { sales: products(row.sales, 3), star: products(row.star, 3), collect: products(row.collect, 3) };
  } else if (kind === 'newVip') {
    const points = row.newcomer_integral;
    if (!(integer(points) || Array.isArray(points) && points.length === 0) || !Array.isArray(row.newcomer_coupon) || row.newcomer_coupon.length > 10) throw Error('新人权益格式错误');
    const coupons = row.newcomer_coupon.map(raw => {
      const coupon = record(raw);
      if (!integer(coupon.id, 1) || !money(coupon.coupon_price) || !money(coupon.use_min_price) || coupon.coupon_type !== undefined && !integer(coupon.coupon_type)
        || coupon.coupon_title !== undefined && !validText(coupon.coupon_title)
        || owner > 0 && coupon.uid !== owner || owner === 0 && coupon.uid !== undefined
        || coupon._type_msg !== undefined && !validText(coupon._type_msg)
        || coupon._msg !== undefined && !validText(coupon._msg)
        || coupon.status !== undefined && !(owner === 0 ? integer(coupon.status) : validText(coupon.status))) throw Error('新人优惠券格式错误');
      return { ...coupon, id: coupon.id };
    });
    data.newcomer = { newcomer_products: products(row.newcomer_products, 10), newcomer_integral: Array.isArray(points) ? [] : points as number, newcomer_coupon: coupons };
  } else {
    const days = row.signList, rewards = row.nextContinuousSignRewardList;
    if (!Array.isArray(days) || days.length !== 1 || !Array.isArray(days[0]) || days[0].length !== 7
      || !Array.isArray(rewards) || rewards.length > 1 || typeof row.checkSign !== 'boolean'
      || ![true, false, 0, 1].includes(row.signStatus as boolean | number) || !integer(row.sign_give_point)) throw Error('签到预览格式错误');
    for (const day of days[0]) if (!validText(day?.day) || typeof day.is_sign !== 'boolean' || typeof day.sign_day !== 'boolean' || !integer(day.type, 1) || day.type > 2 || !integer(day.point)) throw Error('签到周列表格式错误');
    for (const reward of rewards) if (!integer(reward?.days, 1) || !integer(reward.point) || reward.exp !== undefined && !integer(reward.exp)) throw Error('连续签到奖励格式错误');
    data.sign = structuredClone(row) as unknown as DiySignData;
  }
  return data;
}
export function diyMemberProgress(user: DiyMemberState | null): number { return user && user.next_exp > 0 ? Math.min(100, Math.max(0, user.exp / user.next_exp * 100)) : 0; }
export function diyCouponLabel(coupon: Record<string, unknown>): string {
  return Number(coupon.coupon_type) === 2 ? `${Number(coupon.coupon_price) / 10}折`
    : Number(coupon.coupon_type) === 1 ? `¥${String(coupon.coupon_price)}` : `优惠额 ${String(coupon.coupon_price)}`;
}
export function diyCouponStatus(coupon: Record<string, unknown>): string {
  return typeof coupon._msg === 'string' ? coupon._msg : typeof coupon._type_msg === 'string' ? coupon._type_msg : typeof coupon.status === 'string' ? coupon.status : '';
}
export function diyCouponScope(coupon: Record<string, unknown>): string {
  const scope = Number(coupon.applicable_type ?? coupon.type);
  return ['通用券', '品类券', '商品券', '品牌券'][scope] ?? '优惠券';
}
