import { asDiyRecord, safeDiyColor, safeDiyImageUrl } from './diy';
import { resolveRegisteredPageRoute } from '@/config/navigation';

/** Two published icons per item; reject overflow atomically, never truncate imported menus. */
export const DIY_FOOTER_MENU_LIMIT = 10_000;
export interface DiyFooterItem { name: string; link: string; route: string | null; selectedImage: string; image: string }
export interface DiyFooterConfig {
  custom: boolean; floating: boolean; style: number; themed: boolean;
  color: string; activeColor: string; background: string; side: number; bottom: number;
  topPadding: number; bottomPadding: number; radius: string; items: DiyFooterItem[];
}
const record = (value: unknown) => asDiyRecord(value) ?? {};
const option = (block: Record<string, unknown>, key: string, fallback: number, values: number[]) => {
  const raw = record(block[key]).tabVal;
  if (raw === undefined) return fallback;
  const value = typeof raw === 'number' || typeof raw === 'string' && /^(?:0|[1-9]\d*)$/u.test(raw) ? Number(raw) : NaN;
  if (!values.includes(value)) throw new Error('底部导航配置无效');
  return value;
};
const length = (value: unknown, fallback = 0) => {
  const raw = record(value).val;
  if (raw === undefined) return fallback;
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0 || number > 1000) throw new Error('底部导航间距无效');
  return number * 2;
};
const color = (value: unknown, fallback: string) => {
  const colors = record(value).color;
  return safeDiyColor(Array.isArray(colors) ? record(colors[0]).item : undefined) || fallback;
};
export function normalizeDiyFooter(value: unknown): DiyFooterConfig {
  const block = record(value), list = block.menuList;
  if (!Array.isArray(list) || list.length > DIY_FOOTER_MENU_LIMIT) throw new Error('底部导航菜单无效');
  const floating = option(block, 'navConfig', 0, [0, 1]) === 1, fillet = record(block.fillet);
  let radius = `${length(block.fillet)}rpx`;
  if (fillet.type === 1 || fillet.type === '1') {
    if (!Array.isArray(fillet.valList) || fillet.valList.length < 4) throw new Error('底部导航圆角无效');
    radius = [0, 1, 3, 2].map(index => `${length((fillet.valList as unknown[])[index])}rpx`).join(' ');
  }
  return {
    custom: option(block, 'effectConfig', 1, [0, 1]) === 1, floating,
    style: option(block, 'navStyleConfig', 0, [0, 1, 2]), themed: option(block, 'toneConfig', 0, [0, 1]) === 0,
    color: color(block.txtColor, '#333333'), activeColor: color(block.activeTxtColor, '#e93323'),
    background: color(block[floating ? 'bgColor2' : 'bgColor'], '#ffffff'),
    side: floating ? length(block.prConfig, 20) : 0, bottom: floating ? length(block.mbConfig, 50) : 0,
    topPadding: length(block.topConfig), bottomPadding: length(block.bottomConfig), radius,
    items: list.map(raw => {
      const item = asDiyRecord(raw);
      if (!item || typeof item.name !== 'string' || typeof item.link !== 'string') throw new Error('底部导航菜单无效');
      const images = Array.isArray(item.imgList) ? item.imgList : [];
      return { name: item.name, link: item.link, route: resolveRegisteredPageRoute(item.link.split('?')[0] ?? '', item.link.includes('?') ? item.link.slice(item.link.indexOf('?') + 1) : ''), selectedImage: safeDiyImageUrl(images[0]), image: safeDiyImageUrl(images[1]) };
    }),
  };
}
