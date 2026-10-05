import request, { getData } from '@/utils/request';
import axios from 'axios';

export interface SignDayRow {
  id: number; gid: number; day: string | null; sign_num: number | null;
  sort: number; status: number; add_time: number; revision: string; issues: string[];
}
export interface SignDayList {
  group_present: boolean; list: SignDayRow[]; count: number; revision: string;
  theme: 1 | 2 | 3 | 4 | 5 | 6 | null; theme_issue: string | null;
}
export interface SignDayFields { day: string; sign_num: number; sort: number; status: 0 | 1 }
export interface SignDayWrite extends SignDayFields { revision: string; request_id: string }
export interface SignDayStatus { revision: string; request_id: string; status: 0 | 1 }
export interface SignDayDelete { revision: string; request_id: string }
export type SignDayOperation =
  | { operation: 'create'; id: 0; body: SignDayWrite }
  | { operation: 'update'; id: number; body: SignDayWrite }
  | { operation: 'status'; id: number; body: SignDayStatus }
  | { operation: 'delete'; id: number; body: SignDayDelete };
export interface SignDayReceipt { operation: SignDayOperation['operation']; id: number; request_id: string; payload_hash: string }
export interface SignDayPending { version: 1; actor: number; input: SignDayOperation; fingerprint: string }

const endpoint = '/marketing/sign-day-config';
const integer = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= 2_147_483_647;
const signedInteger = (value: unknown): value is number => integer(value, -2_147_483_648);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const flag = (value: unknown): value is 0 | 1 => value === 0 || value === 1;
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('签到天数组响应格式错误'); return value as Record<string, unknown>; }
function onlyKeys(value: Record<string, unknown>, keys: string[]) { if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw Error('签到天数组请求字段不完整或包含额外字段'); }

export function parseSignDayRow(value: unknown): SignDayRow {
  const row = object(value);
  if (!integer(row.id, 1) || !integer(row.gid, 1) || !(row.day === null || typeof row.day === 'string')
    || !(row.sign_num === null || signedInteger(row.sign_num)) || !signedInteger(row.sort) || !signedInteger(row.status)
    || !signedInteger(row.add_time) || !digest(row.revision)
    || !Array.isArray(row.issues) || row.issues.some(issue => typeof issue !== 'string')) throw Error('签到天数组记录不完整，请重新读取');
  return row as unknown as SignDayRow;
}
export function parseSignDayList(value: unknown): SignDayList {
  const page = object(value);
  if (typeof page.group_present !== 'boolean' || !digest(page.revision) || !integer(page.count) || !Array.isArray(page.list)
    || page.count !== page.list.length || !(page.theme === null || integer(page.theme, 1) && page.theme <= 6)
    || !(page.theme_issue === null || typeof page.theme_issue === 'string')) throw Error('签到天数组列表不完整，请重新读取');
  const list = page.list.map(parseSignDayRow);
  if (new Set(list.map(row => row.id)).size !== list.length || new Set(list.map(row => row.gid)).size > 1
    || !page.group_present && list.length) throw Error('签到天数组身份重复或分组不一致');
  return { ...page, list } as unknown as SignDayList;
}
export function normalizeSignDayOperation(value: SignDayOperation): SignDayOperation {
  const input = object(value), body = object(input.body);
  onlyKeys(input, ['operation', 'id', 'body']);
  if (!['create', 'update', 'status', 'delete'].includes(String(input.operation)) || !(input.operation === 'create' ? input.id === 0 : integer(input.id, 1))) throw Error('签到天数组操作身份无效');
  const keys = input.operation === 'create' || input.operation === 'update' ? ['revision', 'day', 'sign_num', 'sort', 'status', 'request_id']
    : input.operation === 'status' ? ['revision', 'status', 'request_id'] : ['revision', 'request_id'];
  onlyKeys(body, keys);
  if (!digest(body.revision) || !uuid(body.request_id)) throw Error('签到天数组版本或请求ID无效');
  if (input.operation !== 'delete' && !flag(body.status)) throw Error('显示状态须为显示或隐藏');
  if (input.operation === 'create' || input.operation === 'update') {
    if (typeof body.day !== 'string' || !body.day.trim() || [...body.day].length > 64 || /[\u0000-\u001f\u007f]/u.test(body.day)) throw Error('天数文案须为1–64字自由文字，不能包含控制字符');
    if (!integer(body.sign_num, 1) || !integer(body.sort)) throw Error('签到数值须为正整数，排序须为非负整数，最大2147483647');
    return { operation: input.operation, id: input.id as number, body: { revision: body.revision, day: body.day, sign_num: body.sign_num, sort: body.sort, status: body.status as 0 | 1, request_id: body.request_id } } as SignDayOperation;
  }
  if (input.operation === 'status') return { operation: 'status', id: input.id as number, body: { revision: body.revision, status: body.status as 0 | 1, request_id: body.request_id } };
  return { operation: 'delete', id: input.id as number, body: { revision: body.revision, request_id: body.request_id } };
}
/** Key order matches the backend receipt digest; UUID is deliberately excluded. */
export function signDayCanonical(value: SignDayOperation): Record<string, unknown> {
  const input = normalizeSignDayOperation(value), body = input.body;
  if (input.operation === 'create' || input.operation === 'update') return { operation: input.operation, id: input.id, revision: body.revision,
    day: input.body.day, sign_num: input.body.sign_num, sort: input.body.sort, status: input.body.status };
  if (input.operation === 'status') return { operation: input.operation, id: input.id, revision: body.revision, status: input.body.status };
  return { operation: input.operation, id: input.id, revision: body.revision };
}
export async function signDayFingerprint(input: SignDayOperation): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(signDayCanonical(input))));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function parseSignDayReceipt(value: unknown, requestId: string): SignDayReceipt {
  const row = object(value);
  if (!['create', 'update', 'status', 'delete'].includes(String(row.operation)) || !integer(row.id, 1)
    || row.request_id !== requestId || !uuid(row.request_id) || !digest(row.payload_hash)) throw Error('签到天数组回执不完整或请求ID不一致');
  return row as unknown as SignDayReceipt;
}
export function assertSignDayReceipt(receipt: SignDayReceipt, pending: SignDayPending): void {
  if (receipt.request_id !== pending.input.body.request_id || receipt.operation !== pending.input.operation || receipt.payload_hash !== pending.fingerprint
    || pending.input.operation !== 'create' && receipt.id !== pending.input.id) throw Error('提交回执与原请求不一致，请继续核对，不能发起新的写入');
}
export function signDayPendingKey(actor: number): string { if (!integer(actor, 1)) throw Error('管理员身份无效'); return `admin_sign_day_config_pending:${actor}`; }
/** Only an actual receipt HTTP 404 authorizes an explicit retry of the original write. */
export function signDayReceiptNotFound(reason: unknown): boolean { return axios.isAxiosError(reason) && reason.response?.status === 404; }
export async function parseSignDayPending(raw: string, actor: number): Promise<SignDayPending> {
  if (raw.length > 8192) throw Error('未完成请求记录过大');
  const saved = object(JSON.parse(raw));
  onlyKeys(saved, ['version', 'actor', 'input', 'fingerprint']);
  if (saved.version !== 1 || saved.actor !== actor || !integer(actor, 1) || !digest(saved.fingerprint)) throw Error('未完成请求身份或格式无效');
  const input = normalizeSignDayOperation(saved.input as SignDayOperation);
  if (await signDayFingerprint(input) !== saved.fingerprint) throw Error('未完成请求内容与摘要不一致');
  return { version: 1, actor, input, fingerprint: saved.fingerprint };
}
export async function apiSignDayList(signal?: AbortSignal): Promise<SignDayList> { return parseSignDayList(await getData(request.get(endpoint, { signal }))); }
export async function apiSignDayDetail(id: number, signal?: AbortSignal): Promise<SignDayRow> {
  if (!integer(id, 1)) throw Error('签到天数组ID无效');
  const response = object(await getData(request.get(`${endpoint}/${id}`, { signal }))), row = parseSignDayRow(response.info);
  if (row.id !== id) throw Error('签到天数组详情与请求身份不一致');
  return row;
}
export async function apiSignDayMutate(value: SignDayOperation, signal?: AbortSignal): Promise<SignDayReceipt> {
  const input = normalizeSignDayOperation(value);
  const response = input.operation === 'create' ? request.post(endpoint, input.body, { signal })
    : input.operation === 'update' ? request.put(`${endpoint}/${input.id}`, input.body, { signal })
    : input.operation === 'status' ? request.patch(`${endpoint}/${input.id}/status`, input.body, { signal })
    : request.delete(`${endpoint}/${input.id}`, { data: input.body, signal });
  return parseSignDayReceipt(await getData(response), input.body.request_id);
}
export async function apiSignDayReceipt(requestId: string, signal?: AbortSignal): Promise<SignDayReceipt> {
  if (!uuid(requestId)) throw Error('签到天数组请求ID无效');
  return parseSignDayReceipt(await getData(request.get(`${endpoint}/receipts/${requestId}`, { signal })), requestId);
}
