import axios from 'axios';
import request, { getData } from '@/utils/request';
import { isThemeStatus, type ThemeStatus } from '../../../common/theme';
export interface ThemeSnapshot { revision: string; status: ThemeStatus | null; configured: boolean; editable: boolean; issues: string[] }
export interface ThemeWrite { request_id: string; revision: string; status: ThemeStatus }
export interface ThemeReceipt { operation: 'update'; id: number; request_id: string; payload_hash: string }
export interface ThemePending { version: 1; actor: number; input: ThemeWrite; fingerprint: string }
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('主题数据格式错误'); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: string[]) { if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw Error('主题字段不完整或含额外字段'); }
export function parseThemeSnapshot(value: unknown): ThemeSnapshot {
  const row = object(value); exact(row, ['revision', 'status', 'configured', 'editable', 'issues']);
  if (!digest(row.revision) || row.status !== null && !isThemeStatus(row.status) || typeof row.configured !== 'boolean' || typeof row.editable !== 'boolean' || !Array.isArray(row.issues) || row.issues.length > 20 || row.issues.some(issue => typeof issue !== 'string' || [...issue].length > 256 || /[\u0000-\u001f\u007f]/u.test(issue)) || row.configured !== (row.status !== null)) throw Error('主题快照无效');
  return row as unknown as ThemeSnapshot;
}
export function normalizeThemeWrite(value: unknown): ThemeWrite { const row = object(value); exact(row, ['request_id', 'revision', 'status']); if (!uuid(row.request_id) || !digest(row.revision) || !isThemeStatus(row.status)) throw Error('请选择六种主题之一并读取有效版本'); return { request_id: row.request_id, revision: row.revision, status: row.status }; }
export function themeCanonical(value: ThemeWrite) { const input = normalizeThemeWrite(value); return { operation: 'update', revision: input.revision, status: input.status }; }
export async function themeFingerprint(value: ThemeWrite): Promise<string> { const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(themeCanonical(value)))); return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
export function parseThemeReceipt(value: unknown, requestId: string): ThemeReceipt { const row = object(value); if (row.operation !== 'update' || !positive(row.id) || row.request_id !== requestId || !uuid(row.request_id) || !digest(row.payload_hash)) throw Error('主题回执不完整或不属于原请求'); return row as unknown as ThemeReceipt; }
export function assertThemeReceipt(value: ThemeReceipt, pending: ThemePending) { if (value.operation !== 'update' || !positive(value.id) || value.request_id !== pending.input.request_id || value.payload_hash !== pending.fingerprint) throw Error('回执与原请求不一致，请继续核对'); }
export const themePendingKey = (actor: number) => { if (!positive(actor)) throw Error('管理员身份无效'); return `admin_theme_settings_pending:${actor}`; };
export const themeDraftKey = (actor: number) => { if (!positive(actor)) throw Error('管理员身份无效'); return `admin_theme_settings_rejected_draft:${actor}`; };
export async function parseThemePending(raw: string, actor: number): Promise<ThemePending> { if (raw.length > 8192) throw Error('原请求记录过大'); const row = object(JSON.parse(raw)); exact(row, ['version', 'actor', 'input', 'fingerprint']); const input = normalizeThemeWrite(row.input); if (row.version !== 1 || row.actor !== actor || !positive(actor) || !digest(row.fingerprint) || JSON.stringify(input) !== JSON.stringify(row.input) || await themeFingerprint(input) !== row.fingerprint) throw Error('原请求身份或内容无效'); return { version: 1, actor, input, fingerprint: row.fingerprint }; }
function proof(reason: unknown, pending: ThemePending, status: number, code: string): boolean { if (!axios.isAxiosError(reason) || reason.response?.status !== status) return false; const body = reason.response.data; return body?.status === status && body.data?.code === code && body.data.operation === 'update' && body.data.request_id === pending.input.request_id && body.data.payload_hash === pending.fingerprint; }
export const isThemeStale = (reason: unknown, pending: ThemePending) => proof(reason, pending, 409, 'THEME_SETTINGS_STALE_VERSION');
export const isThemeRejected = (reason: unknown, pending: ThemePending) => proof(reason, pending, 400, 'THEME_SETTINGS_REJECTED');
export const themeReceiptNotFound = (reason: unknown) => axios.isAxiosError(reason) && reason.response?.status === 404;
export function themeErrorMessage(reason: unknown): string { const body = axios.isAxiosError(reason) ? reason.response?.data?.msg : undefined, text = body ?? (reason instanceof Error ? reason.message : null); return typeof text === 'string' && text && [...text].length <= 512 && !/[\u0000-\u001f\u007f]/u.test(text) ? text : '请求失败，请重新核对'; }
export async function apiThemeSettings(signal?: AbortSignal): Promise<ThemeSnapshot> { return parseThemeSnapshot(await getData(request.get('/setting/theme-style', { signal }))); }
export async function apiSaveThemeSettings(value: ThemeWrite, signal?: AbortSignal): Promise<ThemeReceipt> { const input = normalizeThemeWrite(value); return parseThemeReceipt(await getData(request.post('/setting/theme-style', input, { signal })), input.request_id); }
export async function apiThemeReceipt(requestId: string, signal?: AbortSignal): Promise<ThemeReceipt> { if (!uuid(requestId)) throw Error('主题请求标识无效'); return parseThemeReceipt(await getData(request.get(`/setting/theme-style/request/${requestId}`, { signal })), requestId); }
