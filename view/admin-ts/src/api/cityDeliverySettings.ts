import axios from 'axios';
import request, { getData } from '@/utils/request';
import { CITY_DELIVERY_FLAG_KEYS, CITY_DELIVERY_CREDENTIAL_KEYS, CITY_DELIVERY_CREDENTIAL_BYTE_LIMITS,
  type CityDeliveryFlags, type CityDeliveryFlagKey, type CityDeliveryCredentialKey, type CityDeliveryCredentialActions,
  type CityDeliveryCredentialAction, type CityDeliveryPrepareInput, type CityDeliveryConfirmInput,
  type CityDeliverySettingsSnapshot, type CityDeliveryPreparedIntent, type CityDeliverySettingsReceipt } from '../../../common/cityDeliverySettings';
export { CITY_DELIVERY_FLAG_KEYS, CITY_DELIVERY_CREDENTIAL_KEYS, CITY_DELIVERY_CREDENTIAL_BYTE_LIMITS };
export type { CityDeliveryFlags, CityDeliveryFlagKey, CityDeliveryCredentialKey, CityDeliveryCredentialActions, CityDeliveryCredentialAction, CityDeliveryPrepareInput, CityDeliveryConfirmInput, CityDeliverySettingsSnapshot, CityDeliveryPreparedIntent, CityDeliverySettingsReceipt };
export const CITY_DELIVERY_LABELS: Record<CityDeliveryCredentialKey, string> = { dada_app_key: '达达 AppKey', dada_app_sercret: '达达 AppSecret', dada_source_id: '达达商户 ID', uupt_appkey: 'UU AppKey', uupt_app_id: 'UU APPID', uupt_open_id: 'UU OpenId' };
export const CITY_DELIVERY_FLAG_LABELS: Record<CityDeliveryFlagKey, string> = { city_delivery_status: '同城配送', self_delivery_status: '自主配送', dada_delivery_status: '达达配送', uu_delivery_status: 'UU 配送' };
export interface CityDeliveryJournal {
  version: 1; actor: number; phase: 'preparing' | 'prepared' | 'confirm-unknown';
  request_id: string; client_nonce: string; revision: string; flags: CityDeliveryFlags; actions: CityDeliveryCredentialActions; payload_hash: string | null;
}
export class CityDeliveryInputError extends Error {}
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CityDeliveryInputError('配送数据格式无效'); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: readonly string[]) { if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new CityDeliveryInputError('配送字段不完整或包含额外字段'); }
function issues(value: unknown): string[] { if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== 'string' || [...item].length > 256 || /[\u0000-\u001f\u007f]/u.test(item))) throw new CityDeliveryInputError('配送诊断格式无效'); return value as string[]; }
function flags(value: unknown, nullable = false): CityDeliveryFlags { const row = object(value); exact(row, CITY_DELIVERY_FLAG_KEYS); for (const key of CITY_DELIVERY_FLAG_KEYS) if (row[key] !== 0 && row[key] !== 1 && !(nullable && row[key] === null)) throw new CityDeliveryInputError(`请明确选择${CITY_DELIVERY_FLAG_LABELS[key]}开启或关闭`); return Object.fromEntries(CITY_DELIVERY_FLAG_KEYS.map(key => [key, row[key]])) as CityDeliveryFlags; }
function actions(value: unknown): CityDeliveryCredentialActions { const row = object(value); exact(row, CITY_DELIVERY_CREDENTIAL_KEYS); for (const key of CITY_DELIVERY_CREDENTIAL_KEYS) if (typeof row[key] !== 'string' || !['keep', 'replace', 'clear'].includes(row[key])) throw new CityDeliveryInputError('请选择每项凭据的处理方式'); return Object.fromEntries(CITY_DELIVERY_CREDENTIAL_KEYS.map(key => [key, row[key]])) as CityDeliveryCredentialActions; }
export function normalizeCityDeliveryPrepare(value: unknown): CityDeliveryPrepareInput {
  const row = object(value); exact(row, ['request_id', 'client_nonce', 'revision', 'flags', 'credentials']);
  if (!uuid(row.request_id) || !uuid(row.client_nonce) || !digest(row.revision)) throw new CityDeliveryInputError('请先读取有效版本');
  const values = object(row.credentials); exact(values, CITY_DELIVERY_CREDENTIAL_KEYS);
  const credentials = Object.fromEntries(CITY_DELIVERY_CREDENTIAL_KEYS.map(key => {
    const field = object(values[key]);
    if (field.action === 'keep' || field.action === 'clear') { exact(field, ['action']); return [key, { action: field.action }]; }
    if (field.action !== 'replace') throw new CityDeliveryInputError(`请选择${CITY_DELIVERY_LABELS[key]}的处理方式`);
    exact(field, ['action', 'value']); if (typeof field.value !== 'string' || /[\u0000-\u001f\u007f]/u.test(field.value)) throw new CityDeliveryInputError(`${CITY_DELIVERY_LABELS[key]}不能包含控制字符`);
    const text = field.value.trim(); if (!text || new TextEncoder().encode(text).length > CITY_DELIVERY_CREDENTIAL_BYTE_LIMITS[key]) throw new CityDeliveryInputError(`${CITY_DELIVERY_LABELS[key]}新值不能为空，且不能超过 ${CITY_DELIVERY_CREDENTIAL_BYTE_LIMITS[key]} 个 UTF-8 字节`);
    return [key, { action: 'replace', value: text }];
  })) as CityDeliveryPrepareInput['credentials'];
  return { request_id: row.request_id, client_nonce: row.client_nonce, revision: row.revision, flags: flags(row.flags), credentials };
}
export function parseCityDeliverySnapshot(value: unknown): CityDeliverySettingsSnapshot {
  const row = object(value); exact(row, ['revision', 'editable', 'flags', 'credentials', 'readiness', 'issues']);
  if (!digest(row.revision) || typeof row.editable !== 'boolean') throw new CityDeliveryInputError('配送快照无效');
  flags(row.flags, true); const credentials = object(row.credentials); exact(credentials, CITY_DELIVERY_CREDENTIAL_KEYS);
  for (const key of CITY_DELIVERY_CREDENTIAL_KEYS) { const field = object(credentials[key]); exact(field, ['configured', 'source', 'issues']); if (typeof field.configured !== 'boolean' || typeof field.source !== 'string' || !['encrypted', 'env', 'cleared', 'none', 'invalid'].includes(field.source)) throw new CityDeliveryInputError('凭据状态无效'); issues(field.issues); }
  const readiness = object(row.readiness), keys = ['cipher_ready', 'dada_client_id', 'dada_callback_token', 'uu_callback_token', 'uu_timestamp_unit']; exact(readiness, keys); if (keys.some(key => typeof readiness[key] !== 'boolean')) throw new CityDeliveryInputError('部署就绪状态无效'); issues(row.issues);
  return row as unknown as CityDeliverySettingsSnapshot;
}
const receiptKeys = ['version', 'operation', 'request_id', 'client_nonce', 'revision', 'payload_hash', 'flags', 'actions'];
function receiptFields(row: Record<string, unknown>): CityDeliverySettingsReceipt { if (row.version !== 1 || row.operation !== 'update' || !uuid(row.request_id) || !uuid(row.client_nonce) || !digest(row.revision) || !digest(row.payload_hash)) throw new CityDeliveryInputError('配送回执身份无效'); flags(row.flags); actions(row.actions); return row as unknown as CityDeliverySettingsReceipt; }
export function parseCityDeliveryReceipt(value: unknown): CityDeliverySettingsReceipt { const row = object(value); exact(row, receiptKeys); return receiptFields(row); }
export function parseCityDeliveryIntent(value: unknown): CityDeliveryPreparedIntent { const row = object(value); exact(row, [...receiptKeys, 'intent_id', 'expires_at', 'state', 'receipt']); receiptFields(row);
  if (row.intent_id !== row.request_id || !positive(row.expires_at) || !['prepared', 'expired', 'applied'].includes(String(row.state))) throw new CityDeliveryInputError('准备状态无效');
  if (row.state === 'applied') { const receipt = parseCityDeliveryReceipt(row.receipt); for (const key of receiptKeys) if (JSON.stringify(receipt[key as keyof CityDeliverySettingsReceipt]) !== JSON.stringify(row[key])) throw new CityDeliveryInputError('准备状态与回执不一致'); }
  else if (row.receipt !== null) throw new CityDeliveryInputError('准备状态与回执不一致'); return row as unknown as CityDeliveryPreparedIntent;
}
export function cityDeliveryActions(input: CityDeliveryPrepareInput): CityDeliveryCredentialActions { return Object.fromEntries(CITY_DELIVERY_CREDENTIAL_KEYS.map(key => [key, input.credentials[key].action])) as CityDeliveryCredentialActions; }
export function cityDeliveryJournal(input: CityDeliveryPrepareInput, actor: number): CityDeliveryJournal { if (!positive(actor)) throw new CityDeliveryInputError('管理员身份无效'); return { version: 1, actor, phase: 'preparing', request_id: input.request_id, client_nonce: input.client_nonce, revision: input.revision, flags: { ...input.flags }, actions: cityDeliveryActions(input), payload_hash: null }; }
export function assertCityDeliveryResponse(value: CityDeliverySettingsReceipt, pending: CityDeliveryJournal) { if (value.operation !== 'update' || value.request_id !== pending.request_id || value.client_nonce !== pending.client_nonce || value.revision !== pending.revision || pending.payload_hash !== null && value.payload_hash !== pending.payload_hash || CITY_DELIVERY_FLAG_KEYS.some(key => value.flags[key] !== pending.flags[key]) || CITY_DELIVERY_CREDENTIAL_KEYS.some(key => value.actions[key] !== pending.actions[key])) throw new CityDeliveryInputError('服务器结果不属于原准备，请继续核对'); }
export const cityDeliveryPendingKey = (actor: number) => { if (!positive(actor)) throw new CityDeliveryInputError('管理员身份无效'); return `admin_city_delivery_pending:${actor}`; };
export function parseCityDeliveryJournal(raw: string, actor: number): CityDeliveryJournal { if (raw.length > 16384) throw new CityDeliveryInputError('原准备记录过大'); const row = object(JSON.parse(raw)); exact(row, ['version', 'actor', 'phase', 'request_id', 'client_nonce', 'revision', 'flags', 'actions', 'payload_hash']);
  if (row.version !== 1 || !positive(actor) || row.actor !== actor || !uuid(row.request_id) || !uuid(row.client_nonce) || !digest(row.revision) || !['preparing', 'prepared', 'confirm-unknown'].includes(String(row.phase)) || row.phase === 'preparing' && row.payload_hash !== null || row.phase !== 'preparing' && !digest(row.payload_hash)) throw new CityDeliveryInputError('原准备身份无效'); flags(row.flags); actions(row.actions); return row as unknown as CityDeliveryJournal;
}
export function cityDeliveryConfirmInput(pending: CityDeliveryJournal): CityDeliveryConfirmInput { if (!digest(pending.payload_hash)) throw new CityDeliveryInputError('请先读取服务器准备状态'); return { request_id: pending.request_id, client_nonce: pending.client_nonce, payload_hash: pending.payload_hash }; }
export function isCityDeliveryRollback(reason: unknown, pending: CityDeliveryJournal): boolean { if (!pending.payload_hash || !axios.isAxiosError(reason)) return false; const status = reason.response?.status, body = reason.response?.data; return (status === 400 || status === 409) && body?.status === status && body.data?.code === (status === 400 ? 'CITY_DELIVERY_SETTINGS_REJECTED' : 'CITY_DELIVERY_SETTINGS_STALE_VERSION') && body.data.operation === 'update' && body.data.request_id === pending.request_id && body.data.client_nonce === pending.client_nonce && body.data.payload_hash === pending.payload_hash; }
export function cityDeliveryNotFound(reason: unknown): boolean { return axios.isAxiosError(reason) && reason.response?.status === 404; }
export function cityDeliveryErrorMessage(reason: unknown): string { if (reason instanceof CityDeliveryInputError) return reason.message; return axios.isAxiosError(reason) && Number.isInteger(reason.response?.status) ? `请求未获得可靠结果（HTTP ${reason.response?.status}），请核对原准备或回执` : '请求未获得可靠结果，请核对原准备或回执'; }
export async function apiCityDeliverySettings(signal?: AbortSignal): Promise<CityDeliverySettingsSnapshot> { return parseCityDeliverySnapshot(await getData(request.get('/config/city-delivery', { signal }))); }
export async function apiPrepareCityDelivery(input: CityDeliveryPrepareInput, signal?: AbortSignal): Promise<CityDeliveryPreparedIntent> { return parseCityDeliveryIntent(await getData(request.post('/config/city-delivery/intent', normalizeCityDeliveryPrepare(input), { signal }))); }
export async function apiCityDeliveryIntent(requestId: string, signal?: AbortSignal): Promise<CityDeliveryPreparedIntent> { if (!uuid(requestId)) throw new CityDeliveryInputError('原准备标识无效'); return parseCityDeliveryIntent(await getData(request.get(`/config/city-delivery/intent/${requestId}`, { signal }))); }
export async function apiConfirmCityDelivery(input: CityDeliveryConfirmInput, signal?: AbortSignal): Promise<CityDeliverySettingsReceipt> { if (!uuid(input.request_id) || !uuid(input.client_nonce) || !digest(input.payload_hash) || Object.keys(input).length !== 3) throw new CityDeliveryInputError('原准备证明无效'); return parseCityDeliveryReceipt(await getData(request.post('/config/city-delivery/confirm', input, { signal }))); }
export async function apiCityDeliveryReceipt(requestId: string, signal?: AbortSignal): Promise<CityDeliverySettingsReceipt> { if (!uuid(requestId)) throw new CityDeliveryInputError('原准备标识无效'); return parseCityDeliveryReceipt(await getData(request.get(`/config/city-delivery/request/${requestId}`, { signal }))); }
