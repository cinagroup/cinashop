import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { parseLevelActivationJson } from './AdminLevelActivationInput';
import { pcBannerImage, pcBannerLink, pcBannerObject, pcBannerRequestId, pcBannerText } from './AdminPcBannerInput';
import { LEGACY_ROUTE_RULES, resolveRegisteredPageRoute } from '@/services/content/FabRouteRegistry';

export const FAB_TEMPLATE_NAME = 'suspended_window';
export const FAB_MAX_VALUE_BYTES = 1024 * 1024;
export const FAB_MAX_HISTORY_BUTTONS = 100;
export interface FabButton { source_id: string | null; img: string; url: string }
export interface FabValues {
  is_show: 0 | 1; index: 1 | 2 | 3 | 4; shifting: number;
  main_ago_image: string; main_after_image: string; button: FabButton[];
}
export interface FabReceipt { operation: 'update'; id: number; request_id: string; payload_hash: string }
export interface FabCanonical { operation: 'update'; revision: string; values: FabValues }
export class FabSettingsStaleVersion extends ValidateException {
  constructor(public readonly request_id: string, public readonly payload_hash: string) {
    super('悬浮按钮配置已变化，请重新读取并确认'); this.name = 'FabSettingsStaleVersion';
  }
  readonly operation = 'update';
}
export class FabSettingsRejected extends ValidateException {
  constructor(message: string, public readonly request_id: string, public readonly payload_hash: string) {
    super(message); this.name = 'FabSettingsRejected';
  }
  readonly operation = 'update';
}
export const fabObject = pcBannerObject;
export const fabRequestId = pcBannerRequestId;
function keys(value: Record<string, unknown>, expected: readonly string[]) {
  if (Object.keys(value).length !== expected.length || Object.keys(value).some(key => !expected.includes(key))) {
    throw new ValidateException('须完整提交悬浮按钮字段，不能包含未知字段');
  }
}
function integer(value: unknown, min: number, max: number, label: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new ValidateException(`${label}须为${min}至${max}整数`);
  return value === 0 ? 0 : value;
}
function text(value: unknown, max: number, label: string) { return pcBannerText(value, max, label, false, true).trim(); }
/** Transport normalization is independent of current DB state. Domain checks
 * run only after the journal and CAS, so their rejection can prove no DML. */
export function fabCanonical(input: unknown): { request_id: string; canonical: FabCanonical } {
  const raw = fabObject(input); keys(raw, ['request_id', 'revision', 'values']);
  const request_id = fabRequestId(raw.request_id);
  if (typeof raw.revision !== 'string' || !/^[a-f0-9]{64}$/.test(raw.revision)) throw new ValidateException('悬浮按钮配置版本无效');
  const source = fabObject(raw.values);
  keys(source, ['is_show', 'index', 'shifting', 'main_ago_image', 'main_after_image', 'button']);
  if (!Array.isArray(source.button) || source.button.length > 5) throw new ValidateException('子按钮须为最多五项的列表');
  const values: FabValues = {
    is_show: integer(source.is_show, 0, 1, '显示开关') as 0 | 1,
    index: integer(source.index, 1, 4, '样式') as FabValues['index'],
    shifting: integer(source.shifting, 0, 100, '上下偏移'),
    main_ago_image: text(source.main_ago_image, 255, '展开前图片'),
    main_after_image: text(source.main_after_image, 255, '展开后图片'),
    button: source.button.map(item => {
      const row = fabObject(item); keys(row, ['source_id', 'img', 'url']);
      if (row.source_id !== null && (typeof row.source_id !== 'string' || !/^[a-f0-9]{64}$/.test(row.source_id))) throw new ValidateException('子按钮来源无效');
      return { source_id: row.source_id as string | null, img: text(row.img, 255, '子按钮图片'), url: text(row.url, 2048, '子按钮链接') };
    }),
  };
  return { request_id, canonical: { operation: 'update', revision: raw.revision, values } };
}
export async function fabHash(value: unknown): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function fabDefaults(): FabValues {
  return { is_show: 1, index: 1, shifting: 1, main_ago_image: '', main_after_image: '',
    button: Array.from({ length: 4 }, () => ({ source_id: null, img: '', url: '' })) };
}
export const fabImage = pcBannerImage;
export interface FabLink { value: string; target: string; kind: 'page' | 'external' | 'mini_program'; partial: boolean }
/** A separate FAB policy keeps the existing generic DIY consumers unchanged. */
export function fabLink(value: unknown): FabLink {
  const link = text(value, 2048, '子按钮链接');
  if (!link) throw new ValidateException('子按钮链接不能为空');
  const pieces = link.split('@APPID=');
  if (pieces.length > 1) {
    if (pieces.length !== 2 || !/^wx[a-f0-9]{16}$/i.test(pieces[1])) throw new ValidateException('外部小程序标识无效');
    const path = pieces[0];
    // This belongs to another mini program: never require or prepend the
    // local /pages registry. Preserve the original path passed to its SDK.
    pcBannerLink(path.startsWith('/') ? path : `/${path}`);
    let layer = path;
    for (let depth = 0; depth <= 3; depth++) {
      const page = layer.split('?', 1)[0];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(layer) || /[\\\u0000-\u001f\u007f]/u.test(layer) || layer.includes('#')
        || !/^\/?[a-z0-9_.%/-]+$/i.test(page) || page.split('/').some(part => part === '.' || part === '..')) throw new ValidateException('外部小程序页面无效');
      if (!/%[a-f0-9]{2}/i.test(layer)) break;
      if (depth === 3) throw new ValidateException('外部小程序页面编码层数过深');
      try { layer = decodeURIComponent(layer); } catch { throw new ValidateException('外部小程序页面编码无效'); }
    }
    return { value: link, target: path, kind: 'mini_program', partial: false };
  }
  pcBannerLink(link);
  if (/^https?:\/\//i.test(link)) return { value: link, target: link, kind: 'external', partial: false };
  const separator = link.indexOf('?'), path = separator < 0 ? link : link.slice(0, separator), query = separator < 0 ? '' : link.slice(separator + 1);
  if (!/^\/pages\/[a-z0-9_/-]+$/i.test(path) || link.includes('#')) throw new ValidateException('站内链接须为已登记页面');
  const target = resolveRegisteredPageRoute(path, query);
  if (!target) throw new ValidateException('此历史页面尚无可执行落点，请选择当前页面');
  return { value: link, target, kind: 'page', partial: LEGACY_ROUTE_RULES[path]?.coverage === 'partial_replacement' };
}
export function validateFabValues(values: FabValues) {
  if (values.index >= 3 && values.button.length < 3) throw new ValidateException('样式三、四需要三个至五个子按钮');
  if (values.index === 3) { fabImage(values.main_ago_image); fabImage(values.main_after_image); }
  else if (values.index === 4) {
    if (values.main_ago_image || values.main_after_image) throw new ValidateException('样式四不使用主按钮图片，请明确清空两张主图');
  } else {
    fabImage(values.main_ago_image);
    if (values.main_after_image) throw new ValidateException('样式一、二不使用展开后图片，请明确清空');
  }
  for (const row of values.button) { fabImage(row.img); fabLink(row.url); }
}
export async function readFabBody(request: Request): Promise<unknown> {
  // Five 2048-codepoint links may each contain four-byte Unicode characters.
  // Opaque historical extensions are merged on the server, never transported.
  return parseLevelActivationJson(await readBoundedUtf8Text(request, 64 * 1024));
}
