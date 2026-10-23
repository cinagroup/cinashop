import { canonicalPresentationReference, presentationPreviewForReference } from './diyPresentationEditor';

export interface DiyPageSettings {
  is_show: number;
  is_bg_color: number;
  is_bg_pic: number;
  color_picker: string;
  bg_pic: string;
  bg_tab_val: number;
}
export const pageSettingKeys = ['is_show', 'is_bg_color', 'is_bg_pic', 'color_picker', 'bg_pic', 'bg_tab_val'] as const;
export function newDiyPageSettings(): DiyPageSettings {
  return {is_show: 0, is_bg_color: 0, is_bg_pic: 0, color_picker: '#f5f5f5', bg_pic: '', bg_tab_val: 0};
}
export function readDiyPageSettings(row: Partial<DiyPageSettings>): DiyPageSettings {
  const defaults = newDiyPageSettings();
  return Object.fromEntries(pageSettingKeys.map(key => [key, row[key] ?? defaults[key]])) as unknown as DiyPageSettings;
}
function decimal(value: string, maximum: number, percentage = false): boolean {
  const number = percentage ? value.replace(/%$/u, '') : value;
  return /^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(number) && Number.isFinite(Number(number)) && Number(number) <= maximum;
}
export function pageSettingsColor(value: unknown): string {
  if (typeof value !== 'string' || value.length > 50) return '';
  const color = value.trim();
  if (/^(?:#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})|transparent|black|white)$/iu.test(color)) return color;
  const match = /^(rgb|rgba|hsl|hsla)\(([\d.,%\s+-]+)\)$/iu.exec(color);
  if (!match) return '';
  const kind = match[1]!.toLowerCase(), parts = match[2]!.split(',').map(part => part.trim()), alpha = kind.endsWith('a');
  if (parts.length !== (alpha ? 4 : 3)) return '';
  const channels = kind.startsWith('rgb') ? parts.slice(0, 3).every(part => part.endsWith('%') === parts[0]!.endsWith('%') && decimal(part, part.endsWith('%') ? 100 : 255, part.endsWith('%')))
    : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(parts[0]!) && Number.isFinite(Number(parts[0])) && Math.abs(Number(parts[0])) <= Number.MAX_SAFE_INTEGER && parts.slice(1, 3).every(part => part.endsWith('%') && decimal(part, 100, true));
  return channels && (!alpha || decimal(parts[3]!, parts[3]!.endsWith('%') ? 100 : 1, parts[3]!.endsWith('%'))) ? color : '';
}
export function pageSettingsReference(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) throw Error('背景图地址过长或格式错误');
  if (/[\u0000-\u0020\u007f\\"'<>`]/u.test(value)) throw Error('背景图地址格式错误');
  const result = canonicalPresentationReference(value);
  if ([...result].length > 256) throw Error('背景图需要 256 字符以内的稳定地址');
  if (result.startsWith('/api/assets/')) {
    const match = /^\/api\/assets\/([1-9]\d*)$/u.exec(result);
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) > 2147483647) throw Error('平台图片标识无效');
  } else if (result && !/^\/(?!\/)/u.test(result)) {
    try { const url = new URL(result); if (url.protocol !== 'https:' || url.username || url.password) throw Error(); }
    catch { throw Error('背景图需要 HTTPS 或站内图片地址'); }
  }
  return result;
}
/** Only explicitly edited metadata is sent; omitted columns preserve imports. */
export function pageSettingsPatch(original: DiyPageSettings | null, current: DiyPageSettings): Partial<DiyPageSettings> {
  const patch: Partial<DiyPageSettings> = {};
  for (const key of pageSettingKeys) {
    if (original && original[key] === current[key]) continue;
    const value = current[key];
    if (key === 'bg_pic') patch.bg_pic = pageSettingsReference(value);
    else if (key === 'color_picker') {
      if (typeof value !== 'string' || value !== '' && !pageSettingsColor(value)) throw Error('背景色格式错误');
      patch.color_picker = value;
    } else {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > (key === 'bg_tab_val' ? 2 : 1)) throw Error('页面状态或背景模式错误');
      patch[key] = value;
    }
  }
  return patch;
}
export function pageSettingsFingerprint(value: DiyPageSettings): string {
  return JSON.stringify(pageSettingKeys.map(key => key === 'bg_pic' ? canonicalPresentationReference(value.bg_pic) : value[key]));
}
export function pageSettingsPreviewStyle(value: DiyPageSettings, signed: string): Record<string, string> {
  if (value.is_show !== 1) return {};
  const style: Record<string, string> = {};
  const color = pageSettingsColor(value.color_picker);
  if (value.is_bg_color === 1 && color) style.backgroundColor = color;
  const image = presentationPreviewForReference(value.bg_pic, signed);
  if (value.is_bg_pic === 1 && image) Object.assign(style, {backgroundImage: `url("${image.replaceAll('"', '%22')}")`, backgroundSize: value.bg_tab_val === 2 ? '100% 100%' : '100%', backgroundRepeat: value.bg_tab_val === 1 ? 'repeat' : 'no-repeat'});
  return style;
}
