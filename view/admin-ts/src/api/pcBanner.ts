import axios from 'axios';
import request, { getData } from '@/utils/request';

export interface PcBannerField { key: string; label: string; type: string; choices: Array<{ value: string; label: string }>; placeholder: string }
export interface PcBannerGroup { id: number; name: string; info: string; fields: PcBannerField[]; issues: string[] }
export type PcBannerValues = Record<string, string | string[] | null>;
export interface PcBannerRow {
  id: number; gid: number; values: PcBannerValues; sort: number; status: number; issues: string[];
  revision: string; image_preview: string; image_previews: Record<string, string[]>; editable: boolean;
}
export interface PcBannerList {
  group_present: boolean; group: PcBannerGroup | null; default_fields: PcBannerField[];
  list: PcBannerRow[]; count: number; page: number; limit: number; revision: string;
}
export interface PcBannerQuery { page: number; limit: number; status?: 0 | 1 }
export type PcBannerOperation = 'create' | 'update' | 'status' | 'delete';
export interface PcBannerWrite { request_id: string; revision: string; values?: PcBannerValues; sort?: number; status?: 0 | 1 }
export interface PcBannerIntent { operation: PcBannerOperation; id: number; input: PcBannerWrite }
export interface PcBannerReceipt { operation: PcBannerOperation; id: number; request_id: string; payload_hash: string }
export interface PcBannerPending extends PcBannerIntent { version: 1; actor: number; fingerprint: string }

const endpoint = '/setting/pc-banners';
const integer = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= 2_147_483_647;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const flag = (value: unknown): value is 0 | 1 => value === 0 || value === 1;
const operation = (value: unknown): value is PcBannerOperation => ['create', 'update', 'status', 'delete'].includes(value as string);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('轮播数据格式错误');
  return value as Record<string, unknown>;
}
function keys(row: Record<string, unknown>, expected: string[]) {
  if (Object.keys(row).length !== expected.length || Object.keys(row).some(key => !expected.includes(key))) throw Error('轮播请求字段不完整或包含额外字段');
}
function text(value: unknown, max: number, multiline = false, nonempty = false): value is string {
  return typeof value === 'string' && [...value].length <= max && (!nonempty || value.trim().length > 0)
    && ![...value].some(character => { const code = character.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; })
    && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u).test(value);
}
function fieldKey(value: unknown): value is string {
  return text(value, 100, false, true) && value === value.trim() && !['__proto__', 'prototype', 'constructor'].includes(value);
}
function strings(value: unknown, max = 100): value is string[] { return Array.isArray(value) && value.length <= max && value.every(item => text(item, 4096)); }
export function pcBannerFieldType(field: PcBannerField): string {
  return ['input', 'textarea', 'radio', 'checkbox', 'select', 'upload', 'uploads'].includes(field.type) ? field.type : 'input';
}
/** Persist stable references; signed preview URLs are never written back to the row. */
function safeAddressLayers(value: string, protocols: readonly string[]): string[] | null {
  const layers: string[] = []; let decoded = value;
  for (let depth = 0; depth <= 3; depth++) {
    if (depth === 0 && /\s/u.test(decoded) || /[\u0000-\u001f\u007f\\]/u.test(decoded)) return null;
    if (/^\/(?!\/)/u.test(decoded)) { try { if (!/^\/(?!\/)/u.test(new URL(decoded, 'https://asset.invalid').pathname)) return null; } catch { return null; } }
    else { try { const parsed = new URL(decoded); if (!/^https?:\/\//iu.test(decoded) || !protocols.includes(parsed.protocol) || parsed.username || parsed.password) return null; } catch { return null; } }
    layers.push(decoded); if (!/%[a-f0-9]{2}/iu.test(decoded)) return layers;
    if (depth === 3) return null;
    try { decoded = decodeURIComponent(decoded); } catch { return null; }
  }
  return layers;
}
export function pcBannerLinkIsSafe(value: unknown): value is string { return text(value, 2048, false, true) && !!safeAddressLayers(value, ['http:', 'https:']); }
export function pcBannerAssetReference(value: unknown): value is string {
  if (!text(value, 255, false, true)) return false;
  const layers = safeAddressLayers(value, ['https:']); if (!layers) return false;
  if (!value.startsWith('/api/assets/') && layers.some(layer => /^\/(?!\/)/u.test(layer) && new URL(layer, 'https://asset.invalid').pathname.startsWith('/api/assets/'))) return false;
  if (value.startsWith('/api/assets/')) { const match = /^\/api\/assets\/([1-9]\d{0,9})$/u.exec(value); return !!match && Number(match[1]) <= 2_147_483_647; }
  if (/^\/(?!\/)/u.test(value)) return true;
  try {
    const parsed = new URL(value);
    return ![...parsed.searchParams.keys()].some(key => /^(?:signature|expires|x-amz-signature|x-goog-signature)$/iu.test(key));
  } catch { return false; }
}
export function pcBannerPreview(value: unknown): string {
  if (!text(value, 8192, false, true) || !safeAddressLayers(value, ['https:'])) return '';
  try { const parsed = new URL(value, 'https://asset.invalid'); return parsed.protocol === 'https:' && !parsed.username && !parsed.password && (value.startsWith('/') || /^https:\/\//iu.test(value)) ? value : ''; } catch { return ''; }
}
export function parsePcBannerFields(value: unknown): PcBannerField[] {
  if (!Array.isArray(value) || value.length > 100 || value.some(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
    const field = item as Record<string, unknown>;
    return !fieldKey(field.key) || !text(field.label, 256, false, true) || !text(field.type, 100, false, true) || !text(field.placeholder, 10000, true)
      || ['title', 'image', 'url'].includes(field.key as string) && ['checkbox', 'uploads'].includes(field.type as string)
      || !Array.isArray(field.choices) || field.choices.length > 100 || field.choices.some(choice => !choice || typeof choice !== 'object' || !text(choice.value, 256, false, true) || !text(choice.label, 256, false, true))
      || new Set(field.choices.map(choice => choice.value)).size !== field.choices.length;
  }) || new Set(value.map(field => field.key)).size !== value.length) throw Error('轮播表单元数据不完整');
  return value as PcBannerField[];
}
function parseGroup(value: unknown): PcBannerGroup {
  const row = object(value);
  if (!integer(row.id, 1) || !text(row.name, 4096) || !text(row.info, 10000, true) || !strings(row.issues)) throw Error('轮播组信息不完整');
  parsePcBannerFields(row.fields); return row as unknown as PcBannerGroup;
}
function parseValues(value: unknown): PcBannerValues {
  const row = object(value);
  if (Object.keys(row).length > 100 || Object.entries(row).some(([key, item]) => !fieldKey(key)
    || !(item === null || text(item, 10000, true) || Array.isArray(item) && item.length <= 100 && item.every(entry => text(entry, 10000, true))))) throw Error('轮播字段值不完整');
  return row as PcBannerValues;
}
function parseRow(value: unknown): PcBannerRow {
  const row = object(value), previews = object(row.image_previews);
  if (!integer(row.id, 1) || !integer(row.gid, 1) || !integer(row.sort, -2_147_483_648) || !integer(row.status, -2_147_483_648)
    || !digest(row.revision) || !strings(row.issues) || !text(row.image_preview, 8192) || typeof row.editable !== 'boolean'
    || Object.keys(previews).length > 100 || Object.entries(previews).some(([key, item]) => !fieldKey(key) || !Array.isArray(item) || item.length > 5 || item.some(entry => !text(entry, 8192)))) throw Error('轮播行信息不完整');
  parseValues(row.values); return row as unknown as PcBannerRow;
}
export function normalizePcBannerQuery(value: PcBannerQuery): PcBannerQuery {
  const row = object(value);
  if (Object.keys(row).some(key => !['page', 'limit', 'status'].includes(key)) || !integer(row.page, 1) || !integer(row.limit, 1) || row.limit > 100
    || (row.page - 1) * row.limit > 100000 || row.status !== undefined && !flag(row.status)) throw Error('轮播分页或显示筛选无效');
  return row.status === undefined ? { page: row.page, limit: row.limit } : { page: row.page, limit: row.limit, status: row.status };
}
export function parsePcBannerList(value: unknown, expected?: PcBannerQuery): PcBannerList {
  const row = object(value);
  if (typeof row.group_present !== 'boolean' || (row.group_present ? row.group === null : row.group !== null) || !digest(row.revision)
    || !integer(row.count) || !Array.isArray(row.list) || !integer(row.page, 1) || !integer(row.limit, 1) || row.limit > 100 || row.list.length > row.limit
    || row.list.length > row.count || (row.page - 1) * row.limit > 100000 || expected && (row.page !== expected.page || row.limit !== expected.limit)) throw Error('轮播列表响应不完整或分页不一致');
  parsePcBannerFields(row.default_fields); if (row.group !== null) parseGroup(row.group);
  row.list.forEach(parseRow);
  if (new Set(row.list.map(item => item.id)).size !== row.list.length || row.group !== null && row.list.some(item => item.gid !== (row.group as PcBannerGroup).id)) throw Error('轮播行归属不一致');
  return row as unknown as PcBannerList;
}
export function parsePcBannerDetail(value: unknown, id: number): { info: PcBannerRow; group: PcBannerGroup } {
  const row = object(value), info = parseRow(row.info), group = parseGroup(row.group);
  if (info.id !== id || info.gid !== group.id) throw Error('轮播详情与所选记录不一致');
  return { info, group };
}
export function validatePcBannerValues(values: PcBannerValues, fields: PcBannerField[]): PcBannerValues {
  parsePcBannerFields(fields); const raw = parseValues(values);
  if (!fields.length || Object.keys(raw).length !== fields.length || fields.some(field => !Object.hasOwn(raw, field.key))) throw Error('请完整填写轮播组的全部字段');
  const result: PcBannerValues = {};
  for (const field of fields) {
    const item = raw[field.key], type = pcBannerFieldType(field), label = field.label || field.key;
    if (type === 'checkbox' || type === 'uploads') {
      const max = type === 'uploads' ? 5 : 100;
      if (!Array.isArray(item) || !item.length || item.length > max || type === 'checkbox' && new Set(item).size !== item.length) throw Error(`${label}须选择1至${max}项${type === 'checkbox' ? '且不能重复' : ''}`);
      if (type === 'uploads' ? item.some(value => !pcBannerAssetReference(value)) : item.some(value => !field.choices.some(choice => choice.value === value))) throw Error(`${label}包含无效选项或不稳定图片地址`);
      result[field.key] = [...item];
    } else {
      const max = type === 'textarea' ? 10000 : type === 'upload' ? 255 : field.key === 'url' ? 2048 : 4096;
      if (!text(item, max, type === 'textarea', true)) throw Error(`${label}须填写且不超过${max}字，不能包含无效控制字符`);
      if (['radio', 'select'].includes(type) && !field.choices.some(choice => choice.value === item)) throw Error(`${label}请选择有效选项`);
      if (type === 'upload' && !pcBannerAssetReference(item)) throw Error(`${label}请选择稳定图片地址，不能保存签名预览链接`);
      if (!['radio', 'select', 'upload'].includes(type) && field.key === 'url' && !pcBannerLinkIsSafe(item)) throw Error(`${label}须为安全HTTP/HTTPS或站内路径`);
      if (field.key === 'title' && !text(item, 4096, false, true)) throw Error('图片标题须为单行文本且不超过4096字');
      if (field.key === 'image' && !pcBannerAssetReference(item)) throw Error('核心图片字段须为单张稳定图片地址');
      if (field.key === 'url' && !pcBannerLinkIsSafe(item)) throw Error('核心跳转字段须为安全HTTP/HTTPS或站内路径');
      result[field.key] = item;
    }
  }
  return result;
}
export function normalizePcBannerIntent(value: PcBannerIntent, fields?: PcBannerField[]): PcBannerIntent {
  const row = object(value); keys(row, ['operation', 'id', 'input']);
  if (!operation(row.operation) || !integer(row.id, row.operation === 'create' ? 0 : 1) || row.operation === 'create' && row.id !== 0) throw Error('轮播操作或ID无效');
  const input = object(row.input), full = ['create', 'update'].includes(row.operation);
  keys(input, full ? ['request_id', 'revision', 'values', 'sort', 'status'] : row.operation === 'status' ? ['request_id', 'revision', 'status'] : ['request_id', 'revision']);
  if (!uuid(input.request_id) || !digest(input.revision) || row.operation !== 'delete' && !flag(input.status) || full && !integer(input.sort)) throw Error('轮播版本、请求ID、排序或状态无效');
  const normalized: PcBannerWrite = { request_id: input.request_id, revision: input.revision };
  if (full) {
    const raw = parseValues(input.values), values = fields ? validatePcBannerValues(raw, fields) : raw;
    if (!Object.keys(values).length || Object.values(values).some(item => item === null || typeof item === 'string' && !item.trim() || Array.isArray(item) && (!item.length || item.some(entry => !entry.trim())))) throw Error('轮播字段不能为空');
    normalized.values = Object.fromEntries(Object.keys(values).sort().map(key => [key, Array.isArray(values[key]) ? [...values[key]] : values[key]]));
    normalized.sort = input.sort as number;
  }
  if (row.operation !== 'delete') normalized.status = input.status as 0 | 1;
  if (new TextEncoder().encode(JSON.stringify(normalized)).length > 256 * 1024) throw Error('轮播请求超过256 KiB');
  return { operation: row.operation, id: row.id, input: normalized };
}
export function pcBannerCanonical(value: PcBannerIntent): Record<string, unknown> {
  const { operation, id, input } = normalizePcBannerIntent(value);
  return operation === 'delete' ? { operation, id, revision: input.revision } : operation === 'status' ? { operation, id, revision: input.revision, status: input.status }
    : { operation, id, revision: input.revision, values: input.values, sort: input.sort, status: input.status };
}
export async function pcBannerFingerprint(value: PcBannerIntent): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(pcBannerCanonical(value))));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function parsePcBannerReceipt(value: unknown, requestId: string): PcBannerReceipt {
  const row = object(value);
  if (!operation(row.operation) || !integer(row.id, 1) || row.request_id !== requestId || !uuid(row.request_id) || !digest(row.payload_hash)) throw Error('轮播提交回执不完整');
  return row as unknown as PcBannerReceipt;
}
export function assertPcBannerReceipt(receipt: PcBannerReceipt, pending: PcBannerPending): void {
  if (receipt.operation !== pending.operation || pending.operation !== 'create' && receipt.id !== pending.id || receipt.request_id !== pending.input.request_id || receipt.payload_hash !== pending.fingerprint) throw Error('回执与原轮播请求不一致，请继续核对');
}
export function pcBannerPendingKey(actor: number): string { if (!integer(actor, 1)) throw Error('管理员身份无效'); return `admin_pc_home_banner_pending:${actor}`; }
export async function parsePcBannerPending(raw: string, actor: number): Promise<PcBannerPending> {
  if (new TextEncoder().encode(raw).length > 270 * 1024) throw Error('原轮播请求记录过大');
  const saved = object(JSON.parse(raw)); keys(saved, ['version', 'actor', 'operation', 'id', 'input', 'fingerprint']);
  if (saved.version !== 1 || saved.actor !== actor || !integer(actor, 1) || !digest(saved.fingerprint)) throw Error('原轮播请求身份或格式无效');
  const intent = normalizePcBannerIntent({ operation: saved.operation, id: saved.id, input: saved.input } as PcBannerIntent);
  if (await pcBannerFingerprint(intent) !== saved.fingerprint || JSON.stringify(intent.input) !== JSON.stringify(saved.input)) throw Error('原轮播请求内容与摘要不一致');
  return { version: 1, actor, ...intent, fingerprint: saved.fingerprint };
}
export const pcBannerReceiptNotFound = (reason: unknown): boolean => axios.isAxiosError(reason) && reason.response?.status === 404;
export function isPcBannerStale(reason: unknown, pending: PcBannerPending): boolean {
  if (!axios.isAxiosError(reason) || reason.response?.status !== 409) return false;
  const body = reason.response.data;
  return !!body && typeof body === 'object' && body.status === 409 && !!body.data && typeof body.data === 'object'
    && body.data.code === 'PC_BANNER_STALE_VERSION' && body.data.operation === pending.operation
    && body.data.request_id === pending.input.request_id && body.data.payload_hash === pending.fingerprint;
}
export async function apiPcBannerList(query: PcBannerQuery, signal?: AbortSignal): Promise<PcBannerList> {
  const params = normalizePcBannerQuery(query); return parsePcBannerList(await getData(request.get(endpoint, { params, signal })), params);
}
export async function apiPcBannerDetail(id: number, signal?: AbortSignal): Promise<{ info: PcBannerRow; group: PcBannerGroup }> {
  if (!integer(id, 1)) throw Error('轮播ID无效'); return parsePcBannerDetail(await getData(request.get(`${endpoint}/${id}`, { signal })), id);
}
export async function apiPcBannerWrite(value: PcBannerIntent, signal?: AbortSignal): Promise<PcBannerReceipt> {
  const intent = normalizePcBannerIntent(value), config = { signal };
  const call = intent.operation === 'create' ? request.post(endpoint, intent.input, config) : intent.operation === 'update' ? request.put(`${endpoint}/${intent.id}`, intent.input, config)
    : intent.operation === 'status' ? request.patch(`${endpoint}/${intent.id}/status`, intent.input, config) : request.delete(`${endpoint}/${intent.id}`, { ...config, data: intent.input });
  return parsePcBannerReceipt(await getData(call), intent.input.request_id);
}
export async function apiPcBannerReceipt(requestId: string, signal?: AbortSignal): Promise<PcBannerReceipt> {
  if (!uuid(requestId)) throw Error('轮播请求ID无效'); return parsePcBannerReceipt(await getData(request.get(`${endpoint}/request/${requestId}`, { signal })), requestId);
}
