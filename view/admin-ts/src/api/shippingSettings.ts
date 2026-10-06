import request, { getData } from '@/utils/request';
import axios from 'axios';

export type ShippingFlag = 0 | 1;
export interface ShippingPickupInput {
  name: string; phone: string; address_ids: number[]; detailed_address: string;
  day_time: [string, string]; latitude: string; longitude: string;
}
export interface ShippingSettingsWrite {
  request_id: string; revision: string; whole_free_shipping: ShippingFlag; store_free_postage: string;
  offline_postage: ShippingFlag; store_self_mention: ShippingFlag; pickup: ShippingPickupInput | null;
}
export interface ShippingSettingsSnapshot {
  settings: { whole_free_shipping: ShippingFlag | null; store_free_postage: string | null;
    offline_postage: ShippingFlag | null; store_self_mention: ShippingFlag | null };
  raw_values: Record<'whole_free_shipping' | 'store_free_postage' | 'offline_postage' | 'store_self_mention', string | null>;
  missing_keys: string[]; issues: Array<{ key: string; message: string }>;
  pickup: (Omit<ShippingPickupInput, 'day_time'> & { id: number; address_labels: string[];
    day_time: [string, string] | []; is_show: number; is_store: number }) | null;
  revision: string;
}
export interface ShippingSettingsCity { value: number; id: number; label: string; pid: number; level: number; has_children: boolean }
export interface ShippingSettingsReceipt { operation: 'save'; request_id: string; payload_hash: string }
export interface ShippingSettingsPending { version: 1; actor: number; input: ShippingSettingsWrite; fingerprint: string }

const endpoint = '/config/shipping';
const configKeys = ['whole_free_shipping', 'store_free_postage', 'offline_postage', 'store_self_mention'];
const integer = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= 2_147_483_647;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const flag = (value: unknown): value is ShippingFlag => value === 0 || value === 1;
const time = (value: unknown): value is string => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('发货设置格式错误');
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw Error('发货设置字段不完整或包含额外字段');
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw Error(`${label}须填写且不超过${max}字，不能包含控制字符`);
  return value.trim();
}
/** Work in decimal text so a currency amount cannot lose a cent through floating point. */
export function normalizeShippingMoney(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/u.test(value)) throw Error('包邮金额须为0至99999999.99，最多两位小数');
  const [whole, fractional = ''] = value.split('.');
  return `${whole}.${fractional.padEnd(2, '0')}`;
}
export function normalizeShippingCoordinate(value: unknown, latitude: boolean): string {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/u.test(value)) throw Error(`${latitude ? '纬度' : '经度'}须为数字，最多六位小数`);
  const parsed = Number(value), bound = latitude ? 90 : 180;
  if (!Number.isFinite(parsed) || Math.abs(parsed) > bound) throw Error(`${latitude ? '纬度' : '经度'}须在-${bound}至${bound}之间`);
  if (parsed === 0) return '0';
  return value.includes('.') ? value.replace(/0+$/u, '').replace(/\.$/u, '') : value;
}
export function normalizeShippingSettingsWrite(value: ShippingSettingsWrite): ShippingSettingsWrite {
  const input = object(value);
  onlyKeys(input, ['request_id', 'revision', ...configKeys, 'pickup']);
  if (!uuid(input.request_id) || !digest(input.revision)) throw Error('发货设置版本或请求ID无效，请重新读取');
  if (!flag(input.whole_free_shipping) || !flag(input.offline_postage) || !flag(input.store_self_mention)) throw Error('请明确选择包邮和到店自提开关');
  const store_free_postage = normalizeShippingMoney(input.store_free_postage);
  let pickup: ShippingPickupInput | null = null;
  if (input.store_self_mention === 0) {
    if (input.pickup !== null) throw Error('关闭自提时不得提交提货点修改');
  } else {
    const row = object(input.pickup);
    onlyKeys(row, ['name', 'phone', 'address_ids', 'detailed_address', 'day_time', 'latitude', 'longitude']);
    const name = text(row.name, '提货点名称', 100), detailed_address = text(row.detailed_address, '详细地址', 255);
    if (typeof row.phone !== 'string' || /[\u0000-\u001f\u007f]/u.test(row.phone) || !/^1[3-9]\d{9}$/u.test(row.phone.trim())) throw Error('提货点手机号须为11位中国大陆手机号');
    if (!Array.isArray(row.address_ids) || ![3, 4].includes(row.address_ids.length) || !row.address_ids.every(id => integer(id, 1)) || new Set(row.address_ids).size !== row.address_ids.length) throw Error('请选择完整省市区，街道可选');
    if (!Array.isArray(row.day_time) || row.day_time.length !== 2 || !row.day_time.every(time)) throw Error('请选择正确营业起止时间');
    pickup = { name, phone: row.phone.trim(), address_ids: [...row.address_ids] as number[], detailed_address,
      day_time: [row.day_time[0] as string, row.day_time[1] as string],
      latitude: normalizeShippingCoordinate(row.latitude, true), longitude: normalizeShippingCoordinate(row.longitude, false) };
  }
  return { request_id: input.request_id, revision: input.revision, whole_free_shipping: input.whole_free_shipping,
    store_free_postage, offline_postage: input.offline_postage, store_self_mention: input.store_self_mention, pickup };
}
/** Fixed key order matches the backend receipt hash; the UUID is intentionally excluded. */
export function shippingSettingsCanonical(value: ShippingSettingsWrite): Record<string, unknown> {
  const input = normalizeShippingSettingsWrite(value);
  return { operation: 'save', revision: input.revision, whole_free_shipping: input.whole_free_shipping,
    store_free_postage: input.store_free_postage, offline_postage: input.offline_postage,
    store_self_mention: input.store_self_mention, pickup: input.pickup };
}
export async function shippingSettingsFingerprint(input: ShippingSettingsWrite): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(shippingSettingsCanonical(input))));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function parseShippingSettingsSnapshot(value: unknown): ShippingSettingsSnapshot {
  const row = object(value), settings = object(row.settings), raw = object(row.raw_values);
  onlyKeys(settings, configKeys); onlyKeys(raw, configKeys);
  if (!digest(row.revision) || !Array.isArray(row.missing_keys) || row.missing_keys.some(key => typeof key !== 'string' || !configKeys.includes(key))
    || new Set(row.missing_keys).size !== row.missing_keys.length || !Array.isArray(row.issues)
    || row.issues.some(issue => !issue || typeof issue !== 'object' || typeof issue.key !== 'string' || typeof issue.message !== 'string')
    || configKeys.some(key => !(raw[key] === null || typeof raw[key] === 'string'))
    || ['whole_free_shipping', 'offline_postage', 'store_self_mention'].some(key => !(settings[key] === null || flag(settings[key])))
    || !(settings.store_free_postage === null || typeof settings.store_free_postage === 'string' && normalizeShippingMoney(settings.store_free_postage) === settings.store_free_postage)) throw Error('发货设置响应不完整，请重新读取');
  if (row.pickup !== null) {
    const pickup = object(row.pickup);
    if (!integer(pickup.id, 1) || ['name', 'phone', 'detailed_address', 'latitude', 'longitude'].some(key => typeof pickup[key] !== 'string')
      || !Array.isArray(pickup.address_ids) || pickup.address_ids.length > 4 || !pickup.address_ids.every(id => integer(id))
      || !Array.isArray(pickup.address_labels) || pickup.address_labels.length !== pickup.address_ids.length || pickup.address_labels.some(label => typeof label !== 'string')
      || !Array.isArray(pickup.day_time) || ![0, 2].includes(pickup.day_time.length) || pickup.day_time.some(item => typeof item !== 'string')
      || !integer(pickup.is_show, -2_147_483_648) || !integer(pickup.is_store, -2_147_483_648)) throw Error('历史提货点响应不完整，请重新读取');
  }
  return row as unknown as ShippingSettingsSnapshot;
}
export function parseShippingSettingsCities(value: unknown, pid: number): ShippingSettingsCity[] {
  if (!Array.isArray(value) || value.length > 1000 || value.some(row => !row || typeof row !== 'object'
    || !integer(row.id, 1) || row.value !== row.id || row.pid !== pid || typeof row.label !== 'string' || !row.label
    || !integer(row.level, 1) || row.level > 4 || typeof row.has_children !== 'boolean')
    || new Set(value.map(row => row.id)).size !== value.length) throw Error('行政区列表不完整或所属地区不一致');
  return value as ShippingSettingsCity[];
}
export function parseShippingSettingsReceipt(value: unknown, requestId: string): ShippingSettingsReceipt {
  const row = object(value);
  if (row.operation !== 'save' || row.request_id !== requestId || !uuid(row.request_id) || !digest(row.payload_hash)) throw Error('发货设置回执不完整或请求ID不一致');
  return row as unknown as ShippingSettingsReceipt;
}
export function assertShippingSettingsReceipt(receipt: ShippingSettingsReceipt, pending: ShippingSettingsPending): void {
  if (receipt.operation !== 'save' || receipt.request_id !== pending.input.request_id || receipt.payload_hash !== pending.fingerprint) throw Error('提交回执与原请求不一致，请继续核对，不能发起新的写入');
}
export function shippingSettingsPendingKey(actor: number): string {
  if (!integer(actor, 1)) throw Error('管理员身份无效');
  return `admin_shipping_settings_pending:${actor}`;
}
export async function parseShippingSettingsPending(raw: string, actor: number): Promise<ShippingSettingsPending> {
  if (raw.length > 8192) throw Error('未完成请求记录过大');
  const saved = object(JSON.parse(raw)); onlyKeys(saved, ['version', 'actor', 'input', 'fingerprint']);
  if (saved.version !== 1 || saved.actor !== actor || !integer(actor, 1) || !digest(saved.fingerprint)) throw Error('未完成请求身份或格式无效');
  const input = normalizeShippingSettingsWrite(saved.input as ShippingSettingsWrite);
  if (await shippingSettingsFingerprint(input) !== saved.fingerprint || JSON.stringify(input) !== JSON.stringify(saved.input)) throw Error('未完成请求内容与摘要不一致');
  return { version: 1, actor, input, fingerprint: saved.fingerprint };
}
/** A business envelope with body 404 does not prove the write never happened. */
export function shippingSettingsReceiptNotFound(reason: unknown): boolean { return axios.isAxiosError(reason) && reason.response?.status === 404; }
/** Only the pre-write CAS rollback proof for this exact pending intent is a certain rejection. */
export function isShippingSettingsStale(reason: unknown, pending: ShippingSettingsPending): boolean {
  if (!axios.isAxiosError(reason) || reason.response?.status !== 409) return false;
  const envelope: unknown = reason.response.data;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return false;
  const body = envelope as Record<string, unknown>, proof = body.data;
  if (body.status !== 409 || !proof || typeof proof !== 'object' || Array.isArray(proof)) return false;
  const data = proof as Record<string, unknown>;
  return data.code === 'SHIPPING_SETTINGS_STALE_VERSION' && data.request_id === pending.input.request_id && data.payload_hash === pending.fingerprint;
}
export async function apiShippingSettings(signal?: AbortSignal): Promise<ShippingSettingsSnapshot> {
  return parseShippingSettingsSnapshot(await getData(request.get(endpoint, { signal })));
}
export async function apiSaveShippingSettings(input: ShippingSettingsWrite, signal?: AbortSignal): Promise<ShippingSettingsReceipt> {
  const normalized = normalizeShippingSettingsWrite(input);
  return parseShippingSettingsReceipt(await getData(request.post(endpoint, normalized, { signal })), normalized.request_id);
}
export async function apiShippingSettingsReceipt(requestId: string, signal?: AbortSignal): Promise<ShippingSettingsReceipt> {
  if (!uuid(requestId)) throw Error('发货设置请求ID无效');
  return parseShippingSettingsReceipt(await getData(request.get(`${endpoint}/receipts/${requestId}`, { signal })), requestId);
}
export async function apiShippingSettingsCities(pid: number, signal?: AbortSignal): Promise<ShippingSettingsCity[]> {
  if (!integer(pid)) throw Error('行政区ID无效');
  return parseShippingSettingsCities(await getData(request.get(`${endpoint}/cities`, { params: { pid }, signal })), pid);
}
