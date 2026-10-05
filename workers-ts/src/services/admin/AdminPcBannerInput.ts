import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { parseLevelActivationJson } from './AdminLevelActivationInput';

export type PcBannerOperation = 'create' | 'update' | 'status' | 'delete';
export type PcBannerFieldType = 'input' | 'textarea' | 'radio' | 'checkbox' | 'select' | 'upload' | 'uploads';
export interface PcBannerField { key: string; label: string; type: PcBannerFieldType; choices: Array<{ value: string; label: string }>; placeholder: string }
export type PcBannerValues = Record<string, string | string[]>;
export type PcBannerCanonical =
  | { operation: 'create' | 'update'; id: number; revision: string; values: PcBannerValues; sort: number; status: 0 | 1 }
  | { operation: 'status'; id: number; revision: string; status: 0 | 1 }
  | { operation: 'delete'; id: number; revision: string };
export interface PcBannerReceipt { operation: PcBannerOperation; id: number; request_id: string; payload_hash: string }
export interface PcBannerQuery { page: number; limit: number; offset: number; status?: 0 | 1 }
export const PC_BANNER_DEFAULT_FIELDS: PcBannerField[] = [
  { key: 'title', label: '图片标题', type: 'input', choices: [], placeholder: '' },
  { key: 'image', label: '图片', type: 'upload', choices: [], placeholder: '' },
  { key: 'url', label: '跳转路径', type: 'input', choices: [], placeholder: '' },
];
export const PC_BANNER_DEFAULT_METADATA = JSON.stringify(PC_BANNER_DEFAULT_FIELDS.map(field =>
  ({ name: field.label, title: field.key, type: field.type, param: '' })));
const INT_MAX = 2_147_483_647;
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
const supportedTypes = new Set<PcBannerFieldType>(['input', 'textarea', 'radio', 'checkbox', 'select', 'upload', 'uploads']);
export class PcBannerStaleVersion extends ValidateException {
  constructor(public readonly operation: PcBannerOperation, public readonly request_id: string, public readonly payload_hash: string) {
    super('PC轮播配置已变化，请重新读取并确认'); this.name = 'PcBannerStaleVersion';
  }
}
export function pcBannerObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new ValidateException('PC轮播数据须为JSON对象');
  }
  return value as Record<string, unknown>;
}
function unicode(value: string) { return [...value].some(character => { const code = character.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; }); }
export function pcBannerText(value: unknown, maximum: number, label: string, multiline = false, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || [...value].length > maximum || unicode(value)
    || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u).test(value)) {
    throw new ValidateException(`${label}文本无效或超过${maximum}个字符`);
  }
  return value;
}
export function pcBannerId(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^[1-9]\d{0,9}$/.test(String(value))) throw new ValidateException('PC轮播ID无效');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > INT_MAX) throw new ValidateException('PC轮播ID无效');
  return result;
}
export function pcBannerRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw new ValidateException('请求标识须为UUID');
  return value;
}
function integer(value: unknown, minimum: number, maximum: number, label: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ValidateException(`${label}须为范围内的整数`);
  return value;
}
export function pcBannerKey(value: unknown): string {
  const key = pcBannerText(value, 100, '字段名称');
  if (key !== key.trim() || forbiddenKeys.has(key)) throw new ValidateException('PC轮播字段名称无效');
  return key;
}
/** Unknown PHP field types use the legacy input fallback; malformed definitions never become defaults. */
export function parsePcBannerFields(raw: string | null): { fields: PcBannerField[]; issues: string[]; valid: boolean } {
  try {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > 256 * 1024) throw new ValidateException('字段定义缺失或过大');
    const decoded = parseLevelActivationJson(raw);
    if (!Array.isArray(decoded) || !decoded.length || decoded.length > 100) throw new ValidateException('字段定义须包含1至100项');
    const issues: string[] = [], keys = new Set<string>();
    const fields = decoded.map(item => {
      const source = pcBannerObject(item), key = pcBannerKey(source.title);
      if (keys.has(key)) throw new ValidateException('字段名称重复'); keys.add(key);
      const label = pcBannerText(source.name, 256, '字段标签');
      const rawType = pcBannerText(source.type, 100, '字段类型');
      const type = supportedTypes.has(rawType as PcBannerFieldType) ? rawType as PcBannerFieldType : 'input';
      if (type !== rawType) issues.push(`字段${key}的未知类型按普通输入框处理`);
      if (['title', 'image', 'url'].includes(key) && ['checkbox', 'uploads'].includes(type)) throw new ValidateException(`核心字段${key}须为单一文本，不能使用列表类型`);
      const parameter = source.param === undefined ? '' : pcBannerText(source.param, 10000, '字段参数', true, true);
      const choices: Array<{ value: string; label: string }> = [];
      if (['radio', 'checkbox', 'select'].includes(type)) {
        for (const line of parameter.replace(/\r\n?/g, '\n').split('\n')) {
          if (!line.trim()) continue;
          const pieces = line.split('=>');
          if (pieces.length < 2) throw new ValidateException(`字段${key}的选项格式无效`);
          const value = pcBannerText(pieces[0], 256, '选项值'), choiceLabel = pcBannerText(pieces[1], 256, '选项标签');
          if (choices.some(choice => choice.value === value)) throw new ValidateException(`字段${key}的选项重复`);
          choices.push({ value, label: choiceLabel });
        }
        if (!choices.length || choices.length > 100) throw new ValidateException(`字段${key}须包含1至100个选项`);
      }
      return { key, label, type, choices, placeholder: type === 'textarea' ? parameter : '' } satisfies PcBannerField;
    });
    return { fields, issues, valid: true };
  } catch (error) {
    return { fields: [], issues: [`PC轮播字段元数据无效：${error instanceof Error ? error.message : '解析失败'}`], valid: false };
  }
}
function safeAddressLayers(text: string, protocols: readonly string[]) {
  const layers: string[] = [];
  let current = text;
  for (let depth = 0; depth <= 3; depth++) {
    if ((depth === 0 && /\s/u.test(current)) || /[\\\u0000-\u001f\u007f]/u.test(current)) throw new ValidateException('地址包含危险字符');
    if (/^\/(?!\/)/u.test(current)) {
      if (new URL(current, 'https://pc-banner.invalid').pathname.startsWith('//')) throw new ValidateException('站内路径归一化后不能为协议相对地址');
    } else {
      try {
        if (!/^https?:\/\//i.test(current)) throw new Error('Absolute HTTP address required');
        const url = new URL(current);
        if (!protocols.includes(url.protocol) || url.username || url.password) throw new Error('Unsupported address');
      } catch { throw new ValidateException('地址方案、用户信息或站内路径无效'); }
    }
    layers.push(current);
    if (!/%[a-f0-9]{2}/i.test(current)) break;
    if (depth === 3) throw new ValidateException('地址编码层数过深');
    try { current = decodeURIComponent(current); } catch { throw new ValidateException('地址编码无效'); }
  }
  return layers;
}
export function pcBannerLink(value: unknown): string {
  const text = pcBannerText(value, 2048, '跳转地址');
  safeAddressLayers(text, ['https:', 'http:']);
  return text;
}
export const pcBannerUrl = pcBannerLink;
export function pcBannerImage(value: unknown): string {
  const text = pcBannerText(value, 255, '图片地址');
  const layers = safeAddressLayers(text, ['https:']);
  if (!text.startsWith('/api/assets/') && layers.some(layer => /^\/(?!\/)/u.test(layer)
    && new URL(layer, 'https://pc-banner.invalid').pathname.startsWith('/api/assets/'))) throw new ValidateException('平台图片须使用未编码且未归一化变形的稳定地址');
  if (text.startsWith('/api/assets/')) {
    const match = /^\/api\/assets\/([1-9]\d{0,9})$/.exec(text);
    if (!match || Number(match[1]) > INT_MAX) throw new ValidateException('图片须使用素材的稳定地址，不能保存临时签名');
    return text;
  }
  if (/^\/(?!\/)/u.test(text)) return text;
  try {
    const url = new URL(text);
    if (url.protocol === 'https:' && !url.username && !url.password
      && ![...url.searchParams.keys()].some(key => /^(?:signature|expires|x-amz-signature|x-goog-signature)$/i.test(key))) return text;
  } catch { /* No network lookup. */ }
  throw new ValidateException('图片只支持稳定HTTPS或站内路径');
}
/** Validate complete metadata values; retain strings, textarea line endings and array order in the intent. */
export function pcBannerValuesForFields(values: PcBannerValues, fields: readonly PcBannerField[]): PcBannerValues {
  if (Object.keys(values).length !== fields.length || Object.keys(values).some(key => !fields.some(field => field.key === key))) throw new ValidateException('须完整提交全部PC轮播字段');
  for (const field of fields) {
    const value = values[field.key];
    if (field.type === 'checkbox' || field.type === 'uploads') {
      if (!Array.isArray(value) || !value.length || value.length > (field.type === 'uploads' ? 5 : 100)) throw new ValidateException(`${field.label}须为非空列表`);
      if (field.type === 'checkbox') {
        if (new Set(value).size !== value.length || value.some(item => !field.choices.some(choice => choice.value === item))) throw new ValidateException(`${field.label}选项无效或重复`);
      } else value.forEach(pcBannerImage);
    } else {
      if (typeof value !== 'string') throw new ValidateException(`${field.label}须为文本`);
      pcBannerText(value, field.type === 'textarea' ? 10000 : 4096, field.label, field.type === 'textarea');
      if (field.type === 'radio' || field.type === 'select') {
        if (!field.choices.some(choice => choice.value === value)) throw new ValidateException(`${field.label}选项无效`);
      } else if (field.type === 'upload') pcBannerImage(value);
      else if (field.key === 'url') pcBannerLink(value);
    }
    // The PC consumer assigns these three keys display semantics independently
    // of historical field types. Dynamic types cannot bypass those semantics.
    if (field.key === 'title') pcBannerText(value, 4096, '轮播标题');
    if (field.key === 'image') pcBannerImage(value);
    if (field.key === 'url') pcBannerLink(value);
  }
  return values;
}
/** Fixed outer key order; nested values use sorted keys and preserve array order. request_id is outside the hash. */
export function pcBannerCanonical(operation: PcBannerOperation, idValue: unknown, value: unknown): { request_id: string; canonical: PcBannerCanonical } {
  const raw = pcBannerObject(value), id = operation === 'create' ? 0 : pcBannerId(idValue);
  const keys = new Set(['request_id', 'revision', ...(operation === 'create' || operation === 'update' ? ['values', 'sort', 'status'] : operation === 'status' ? ['status'] : [])]);
  if (Object.keys(raw).some(key => !keys.has(key))) throw new ValidateException('PC轮播请求包含未知字段');
  const request_id = pcBannerRequestId(raw.request_id);
  if (typeof raw.revision !== 'string' || !/^[a-f0-9]{64}$/.test(raw.revision)) throw new ValidateException('PC轮播版本无效');
  const revision = raw.revision;
  if (operation === 'delete') return { request_id, canonical: { operation, id, revision } };
  const status = integer(raw.status, 0, 1, '显示状态') as 0 | 1;
  if (operation === 'status') return { request_id, canonical: { operation, id, revision, status } };
  const source = pcBannerObject(raw.values);
  if (!Object.keys(source).length || Object.keys(source).length > 100) throw new ValidateException('PC轮播字段须为1至100项');
  const values: PcBannerValues = Object.fromEntries(Object.keys(source).sort().map(key => {
    pcBannerKey(key); const item = source[key];
    if (Array.isArray(item)) {
      if (!item.length || item.length > 100) throw new ValidateException('PC轮播列表字段无效');
      return [key, item.map(element => pcBannerText(element, 10000, '字段值', true))];
    }
    return [key, pcBannerText(item, 10000, '字段值', true)];
  }));
  return { request_id, canonical: { operation, id, revision, values, sort: integer(raw.sort, 0, INT_MAX, '排序'), status } };
}
export async function pcBannerHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function parsePcBannerQuery(parameters: URLSearchParams): PcBannerQuery {
  for (const key of new Set(parameters.keys())) if (!['page', 'limit', 'status'].includes(key) || parameters.getAll(key).length !== 1) throw new ValidateException('PC轮播查询参数未知或重复');
  const positive = (key: string, fallback: number, maximum: number) => {
    const value = parameters.get(key); if (value === null) return fallback;
    if (!/^[1-9]\d*$/.test(value)) throw new ValidateException('PC轮播分页格式无效');
    return integer(Number(value), 1, maximum, '分页');
  };
  const page = positive('page', 1, 100001), limit = positive('limit', 20, 100), offset = (page - 1) * limit;
  if (offset > 100000) throw new ValidateException('PC轮播分页偏移超过100000');
  const status = parameters.get('status');
  if (status !== null && status !== '0' && status !== '1') throw new ValidateException('PC轮播状态筛选无效');
  return { page, limit, offset, ...(status === null ? {} : { status: Number(status) as 0 | 1 }) };
}
export async function readPcBannerBody(request: Request): Promise<Record<string, unknown>> {
  try { return pcBannerObject(parseLevelActivationJson(await readBoundedUtf8Text(request, 256 * 1024))); }
  catch (error) { if (error instanceof ValidateException) throw new ValidateException(error.message.replaceAll('会员激活配置', 'PC轮播配置')); throw error; }
}
