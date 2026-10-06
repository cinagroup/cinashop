import type { ThemePreset } from '../../../common/theme';
import { asDiyRecord, safeDiyColor } from '@/utils/diy';
/** Only authored brand roles follow toneConfig. Layout/background/content colours remain authored. */
const roles: Record<string, keyof ThemePreset> = { themeColor: 'theme', priceColor: 'priceColor', goodsPriceColor: 'priceColor', goodsPriceColor2: 'priceColor', goodsUnitPriceColor: 'priceColor', pinkPriceColor: 'priceColor', bargainPriceColor: 'priceColor', seckillPriceColor: 'priceColor', presalePriceColor: 'priceColor', vipPriceColor: 'priceColor', integralColor: 'priceColor', couponMoneyColor: 'priceColor', couponBgColor: 'theme', couponPriceColor: 'priceColor', integralBgColor: 'theme', integralTxtColor: 'priceColor', classColor: 'theme', labelColor: 'theme', labelBgColor: 'theme', labelTxtColor: 'theme', joinNumColor: 'theme', joinBgColor: 'theme', bntColor: 'bntColor', bntBgColor: 'theme', goodsBntColor: 'theme', btnColor: 'theme', buttonColor: 'theme', checkedColor: 'theme', selectColor: 'theme', activeColor: 'theme', titleBgColor: 'theme', priceBgColor: 'theme', progressColor: 'theme' };
export function diyCustomTone(block: Record<string, unknown>): boolean { return Number(asDiyRecord(block.toneConfig)?.tabVal) === 1; }
export function diyThemeColor(block: Record<string, unknown>, key: string, index: number, fallback: string, preset: ThemePreset): string {
  const role = block.name === 'news' && key === 'bntColor' ? undefined : roles[key];
  // Old follow uses its authored themeColor even when no tone selector is present.
  const authoredFollow = block.name === 'follow' && !asDiyRecord(block.toneConfig);
  if (role && !diyCustomTone(block) && !authoredFollow) return index > 0 && /(?:BgColor|BntColor)$/u.test(key) ? preset.gradient : preset[role] as string;
  const colors = asDiyRecord(block[key])?.color, value = Array.isArray(colors) ? asDiyRecord(colors[index])?.item : undefined;
  return safeDiyColor(value, role ? index > 0 && /(?:BgColor|BntColor)$/u.test(key) ? preset.gradient : preset[role] as string : fallback);
}
export function diyThemeVariables(block: Record<string, unknown>, preset: ThemePreset): Record<string, string> {
  const priceKey = ({ combination: 'pinkPriceColor', bargain: 'bargainPriceColor', seckill: 'seckillPriceColor', presale: 'presalePriceColor', coupon: 'couponMoneyColor', newVip: 'integralTxtColor' } as Record<string, string>)[String(block.name)] ?? 'goodsPriceColor';
  const buttonKey = ['combination', 'bargain', 'seckill', 'presale'].includes(String(block.name)) ? 'goodsBntColor' : 'bntBgColor';
  const mainKey = ({ ranking: 'classColor', signIn: 'labelBgColor', newVip: 'integralBgColor', pageFoot: 'activeColor' } as Record<string, string>)[String(block.name)] ?? 'themeColor';
  const main = diyThemeColor(block, mainKey, 0, preset.theme, preset), price = diyThemeColor(block, priceKey, 0, preset.priceColor, preset), button = diyThemeColor(block, buttonKey, 0, preset.theme, preset), gradient = diyThemeColor(block, buttonKey, 1, preset.gradient, preset);
  return { '--diy-theme': main, '--diy-price': price, '--diy-button': button, '--diy-gradient': gradient, '--view-theme': main, '--view-priceColor': price, '--view-gradient': gradient };
}
