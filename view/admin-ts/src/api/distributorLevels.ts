import axios from 'axios';
import request, { getData } from '@/utils/request';

export type DistributorKind = 'level' | 'task';
export type DistributorAction = 'create' | 'update' | 'status' | 'delete';
export type DistributorOperation = `${DistributorKind}:${DistributorAction}`;
export interface DistributorConfig { one_ratio: string | null; two_ratio: string | null; enabled: boolean | null }
export interface DistributorParent { id: number; name: string; grade: number; status: number; revision: string }
export interface DistributorLevelValues { name: string; grade: number; image: string; color: string; one_brokerage: number; two_brokerage: number; status: 0 | 1 }
export interface DistributorTaskValues { level_id: number; name: string; type: number; number: number; desc: string; sort: number; status: 0 | 1 }
export interface DistributorLevel extends Omit<DistributorLevelValues, 'status'> { id: number; status: number; is_del: number; add_time: number; task_count: number; one_brokerage_ratio: string | null; two_brokerage_ratio: string | null; revision: string; image_preview: string; issues: string[] }
export interface DistributorTask extends Omit<DistributorTaskValues, 'status'> { id: number; status: number; is_del: number; add_time: number; is_must: number; type_name: string; completed: boolean; revision: string; issues: string[] }
export interface DistributorTaskType { type: number; name: string; unit: string; image: string }
export interface DistributorQuery { page: number; limit: number; keyword?: string; status?: 0 | 1; level_id?: number }
export interface DistributorLevelsSnapshot { list: DistributorLevel[]; count: number; page: number; limit: number; revision: string; config: DistributorConfig; issues: string[] }
export interface DistributorTasksSnapshot { list: DistributorTask[]; count: number; page: number; limit: number; revision: string; parent: DistributorParent; task_types: DistributorTaskType[]; issues: string[] }
export interface DistributorParentsSnapshot { list: DistributorParent[]; count: number; page: number; limit: number; revision: string; issues: string[] }
export type DistributorSnapshot = DistributorLevelsSnapshot | DistributorTasksSnapshot;
export interface DistributorWrite { request_id: string; revision: string; values?: DistributorLevelValues | DistributorTaskValues; status?: 0 | 1 }
export interface DistributorIntent { operation: DistributorOperation; id: number; input: DistributorWrite }
export interface DistributorPending extends DistributorIntent { version: 1; actor: number; fingerprint: string }
export interface DistributorReceipt { operation: DistributorOperation; id: number; request_id: string; payload_hash: string }

const int = (value: unknown, min = 0, max = 2147483647): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const flag = (value: unknown): value is 0 | 1 => value === 0 || value === 1;
const operation = (value: unknown): value is DistributorOperation => typeof value === 'string' && /^(?:level|task):(?:create|update|status|delete)$/u.test(value);
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('分销等级数据格式错误'); return value as Record<string, unknown>; }
function keys(value: Record<string, unknown>, expected: string[]) { if (Object.keys(value).length !== expected.length || Object.keys(value).some(key => !expected.includes(key))) throw Error('请求字段不完整或包含额外字段'); }
function rawText(value: unknown, max: number): value is string { return typeof value === 'string' && [...value].length <= max && ![...value].some(char => { const code = char.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; }); }
function text(value: unknown, max: number, multiline = false): value is string { return rawText(value, max) && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u).test(value); }
function trimmed(value: unknown, label: string, max: number, multiline = false, required = true): string {
  if (!text(value, max, multiline)) throw Error(`${label}格式无效或过长`);
  const result = value.trim(); if (!text(result, max, multiline) || required && !result) throw Error(`${label}${required ? '不能为空且' : ''}不能超过${max}字`); return result;
}
const issues = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 1000000 && value.every(item => rawText(item, 1000));
const decimal = (value: unknown): value is string | null => value === null || typeof value === 'string' && /^\d+(?:\.\d{1,2})?$/u.test(value) && value.length <= 32;
export const distributorEndpoint = (kind: DistributorKind) => kind === 'level' ? '/agent/levels' : '/agent/level-tasks';
export const distributorKind = (value: DistributorOperation): DistributorKind => value.startsWith('level:') ? 'level' : 'task';
export const distributorAction = (value: DistributorOperation): DistributorAction => value.split(':')[1] as DistributorAction;
export function distributorRatio(base: string | null, uplift: number): string | null {
  if (typeof base !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(base) || base.length > 32 || !int(uplift, 0, 1000)) return null;
  const [whole, fraction = ''] = base.split('.'), hundredths = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  const result = hundredths * BigInt(100 + uplift) / 100n;
  return `${result / 100n}.${String(result % 100n).padStart(2, '0')}`;
}
export function distributorTime(seconds: number): string {
  if (!int(seconds, 0)) return '时间无效'; if (!seconds) return '未记录';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(seconds * 1000));
  const value = (type: string) => parts.find(item => item.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`;
}

function imageLayers(value: string): string[] | null {
  const layers: string[] = []; let layer = value;
  for (let depth = 0; depth <= 3; depth++) {
    if (depth === 0 && /\s/u.test(layer) || /[\u0000-\u001f\u007f\\]/u.test(layer)) return null;
    try {
      if (/^\/(?!\/)/u.test(layer)) { if (!/^\/(?!\/)/u.test(new URL(layer, 'https://asset.invalid').pathname)) return null; }
      else { const parsed = new URL(layer); if (!/^https:\/\//iu.test(layer) || parsed.protocol !== 'https:' || parsed.username || parsed.password) return null; }
    } catch { return null; }
    layers.push(layer); if (!/%[a-f0-9]{2}/iu.test(layer)) return layers;
    if (depth === 3) return null; try { layer = decodeURIComponent(layer); } catch { return null; }
  }
  return layers;
}
export function distributorImageReference(value: unknown): value is string {
  if (!text(value, 255) || !value) return false; const layers = imageLayers(value); if (!layers) return false;
  if (value.startsWith('/api/assets/')) { const match = /^\/api\/assets\/([1-9]\d{0,9})$/u.exec(value); return !!match && Number(match[1]) <= 2147483647; }
  if (layers.some(layer => /^\/(?!\/)/u.test(layer) && new URL(layer, 'https://asset.invalid').pathname.startsWith('/api/assets/'))) return false;
  return !layers.some(layer => !/^\/(?!\/)/u.test(layer) && [...new URL(layer).searchParams.keys()].some(key => /^(?:sig|signature|expires|token|x-amz-signature|x-goog-signature)$/iu.test(key)));
}
export function distributorImagePreview(value: unknown): string { return text(value, 8192) && imageLayers(value) ? value : ''; }
export function distributorColor(value: unknown): string {
  if (!text(value, 32)) return ''; const color = value.trim();
  if (/^#(?:[a-f0-9]{3}|[a-f0-9]{4}|[a-f0-9]{6}|[a-f0-9]{8})$/iu.test(color)) return color;
  const match = /^(rgb|rgba)\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0(?:\.\d{1,3})?|1(?:\.0{1,3})?)\s*)?\)$/iu.exec(color);
  return match && [match[2], match[3], match[4]].every(channel => Number(channel) <= 255) && (match[1].toLowerCase() === 'rgba') === (match[5] !== undefined) ? color : '';
}
export function normalizeDistributorValues(kind: DistributorKind, value: unknown): DistributorLevelValues | DistributorTaskValues {
  const row = object(value);
  keys(row, kind === 'level' ? ['name', 'grade', 'image', 'color', 'one_brokerage', 'two_brokerage', 'status'] : ['level_id', 'name', 'type', 'number', 'desc', 'sort', 'status']);
  const name = trimmed(row.name, kind === 'level' ? '等级名称' : '任务名称', 50);
  if (!flag(row.status)) throw Error('显示状态无效');
  if (kind === 'level') {
    const color = distributorColor(row.color);
    if (!int(row.grade, 1, 32767)) throw Error('等级须为1至32767的整数');
    const image = trimmed(row.image, '等级背景图', 255);
    if (!distributorImageReference(image)) throw Error('请选择稳定背景图片，不能保存签名预览地址');
    if (!color) throw Error('字体颜色须为安全十六进制或rgb/rgba颜色');
    if (!int(row.one_brokerage, 0, 1000) || !int(row.two_brokerage, 0, 1000) || row.two_brokerage > row.one_brokerage) throw Error('上浮须为0至1000的整数，二级不能大于一级');
    return { name, grade: row.grade, image, color, one_brokerage: row.one_brokerage, two_brokerage: row.two_brokerage, status: row.status };
  }
  if (!int(row.level_id, 1) || !int(row.type, 1, 5) || !int(row.number, 1) || !int(row.sort, 0, 32767)) throw Error('等级、任务类型、正整数要求或排序无效');
  return { level_id: row.level_id, name, type: row.type, number: row.number, desc: trimmed(row.desc, '任务描述', 255, true, false), sort: row.sort, status: row.status };
}
export function normalizeDistributorQuery(kind: DistributorKind | 'parents', value: DistributorQuery): DistributorQuery {
  const row = object(value);
  if (Object.keys(row).some(key => !['page', 'limit', 'status', 'keyword', ...(kind === 'task' ? ['level_id'] : [])].includes(key)) || !int(row.page, 1) || !int(row.limit, 1, 100)
    || (row.page - 1) * row.limit > 100000 || row.status !== undefined && !flag(row.status) || kind === 'task' && !int(row.level_id, 1)) throw Error('分页、父等级或显示状态无效');
  const keyword = row.keyword === undefined ? '' : trimmed(row.keyword, '查询词', 50, false, false);
  return { page: row.page, limit: row.limit, ...(keyword ? { keyword } : {}), ...(row.status === undefined ? {} : { status: row.status }), ...(kind === 'task' ? { level_id: row.level_id as number } : {}) };
}
function parent(value: unknown): DistributorParent { const row = object(value); if (!int(row.id, 1) || !rawText(row.name, 50) || !int(row.grade, -2147483648) || !int(row.status, -2147483648) || !digest(row.revision)) throw Error('父等级信息不完整'); return row as unknown as DistributorParent; }
function config(value: unknown): DistributorConfig { const row = object(value); if (!decimal(row.one_ratio) || !decimal(row.two_ratio) || row.enabled !== null && typeof row.enabled !== 'boolean') throw Error('基础佣金配置不完整'); return row as unknown as DistributorConfig; }
function parseRow(kind: DistributorKind, value: unknown): DistributorLevel | DistributorTask {
  const row = object(value);
  if (!int(row.id, 1) || !rawText(row.name, 50) || !int(row.status, -2147483648) || !int(row.is_del, -2147483648) || !int(row.add_time, -2147483648) || !digest(row.revision) || !issues(row.issues)) throw Error('分销记录信息不完整');
  if (kind === 'level') {
    if (!int(row.grade, -2147483648) || !rawText(row.image, 255) || !rawText(row.color, 32) || !int(row.one_brokerage, -2147483648) || !int(row.two_brokerage, -2147483648) || !int(row.task_count) || !decimal(row.one_brokerage_ratio) || !decimal(row.two_brokerage_ratio) || !rawText(row.image_preview, 8192)) throw Error('分销等级信息不完整');
  } else if (!int(row.level_id, 1) || !int(row.type, -2147483648) || !int(row.number, -2147483648) || !rawText(row.desc, 255) || !int(row.is_must, -2147483648) || !int(row.sort, -2147483648) || !rawText(row.type_name, 100) || typeof row.completed !== 'boolean') throw Error('分销等级任务信息不完整');
  return row as unknown as DistributorLevel | DistributorTask;
}
function taskTypes(value: unknown): DistributorTaskType[] { if (!Array.isArray(value) || value.length !== 5 || value.some(row => !row || !int(row.type, 1, 5) || !text(row.name, 100) || !text(row.unit, 10) || !text(row.image, 8192)) || new Set(value.map(row => row.type)).size !== 5) throw Error('任务类型目录不完整'); return value as DistributorTaskType[]; }
function listBase(value: unknown, expected?: DistributorQuery): Record<string, unknown> {
  const row = object(value);
  if (!int(row.count) || !int(row.page, 1) || !int(row.limit, 1, 100) || !digest(row.revision) || !issues(row.issues) || !Array.isArray(row.list) || row.list.length > row.limit || row.list.length > row.count || (row.page - 1) * row.limit > 100000 || expected && (expected.page !== row.page || expected.limit !== row.limit)) throw Error('分销列表分页或响应不完整');
  return row;
}
export function parseDistributorList(kind: DistributorKind, value: unknown, expected?: DistributorQuery): DistributorSnapshot {
  const row = listBase(value, expected), list = (row.list as unknown[]).map(item => parseRow(kind, item));
  if (new Set(list.map(item => item.id)).size !== list.length || list.some(item => item.revision !== row.revision)) throw Error('分销列表记录重复或版本不一致');
  if (kind === 'level') config(row.config);
  else { const selected = parent(row.parent); taskTypes(row.task_types); if (selected.revision !== row.revision || expected && selected.id !== expected.level_id || list.some(item => (item as DistributorTask).level_id !== selected.id)) throw Error('任务与所选父等级不一致'); }
  return row as unknown as DistributorSnapshot;
}
export function parseDistributorParents(value: unknown, expected?: DistributorQuery): DistributorParentsSnapshot { const row = listBase(value, expected), list = (row.list as unknown[]).map(parent); if (new Set(list.map(item => item.id)).size !== list.length || list.some(item => item.revision !== row.revision)) throw Error('父等级选项重复或版本不一致'); return row as unknown as DistributorParentsSnapshot; }
export function parseDistributorDetail(kind: DistributorKind, value: unknown, id: number): { info: DistributorLevel | DistributorTask; config?: DistributorConfig; parent?: DistributorParent; task_types?: DistributorTaskType[]; issues: string[] } {
  const row = object(value), info = parseRow(kind, row.info); if (info.id !== id || !issues(row.issues)) throw Error('详情与所选分销记录不一致');
  if (kind === 'level') return { info, config: config(row.config), issues: row.issues };
  const selected = parent(row.parent); if (selected.id !== (info as DistributorTask).level_id || selected.revision !== info.revision) throw Error('任务详情父等级不一致'); return { info, parent: selected, task_types: taskTypes(row.task_types), issues: row.issues };
}
export function normalizeDistributorIntent(value: DistributorIntent): DistributorIntent {
  const row = object(value); keys(row, ['operation', 'id', 'input']);
  if (!operation(row.operation)) throw Error('分销操作无效'); const action = distributorAction(row.operation), kind = distributorKind(row.operation);
  if (!int(row.id, action === 'create' ? 0 : 1) || action === 'create' && row.id !== 0) throw Error('分销记录ID无效');
  const raw = object(row.input), full = action === 'create' || action === 'update'; keys(raw, full ? ['request_id', 'revision', 'values'] : action === 'status' ? ['request_id', 'revision', 'status'] : ['request_id', 'revision']);
  if (!uuid(raw.request_id) || !digest(raw.revision)) throw Error('请求标识或版本无效');
  const input: DistributorWrite = { request_id: raw.request_id, revision: raw.revision };
  if (full) input.values = normalizeDistributorValues(kind, raw.values);
  if (action === 'status') { if (!flag(raw.status)) throw Error('显示状态无效'); input.status = raw.status; }
  return { operation: row.operation, id: row.id, input };
}
export function distributorCanonical(value: DistributorIntent): Record<string, unknown> { const { operation, id, input } = normalizeDistributorIntent(value), action = distributorAction(operation); return action === 'delete' ? { operation, id, revision: input.revision } : action === 'status' ? { operation, id, revision: input.revision, status: input.status } : { operation, id, revision: input.revision, values: input.values }; }
export async function distributorFingerprint(value: DistributorIntent): Promise<string> { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(distributorCanonical(value)))); return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
export function parseDistributorReceipt(value: unknown, requestId: string): DistributorReceipt { const row = object(value); if (!operation(row.operation) || !int(row.id, 1) || row.request_id !== requestId || !uuid(row.request_id) || !digest(row.payload_hash)) throw Error('分销提交回执不完整'); return row as unknown as DistributorReceipt; }
export function assertDistributorReceipt(receipt: DistributorReceipt, pending: DistributorPending) { if (receipt.operation !== pending.operation || distributorAction(pending.operation) !== 'create' && receipt.id !== pending.id || receipt.request_id !== pending.input.request_id || receipt.payload_hash !== pending.fingerprint) throw Error('回执与原分销请求不一致，请继续核对'); }
export function distributorPendingKey(actor: number): string { if (!int(actor, 1)) throw Error('管理员身份无效'); return `admin_distributor_catalog_pending:${actor}`; }
export async function parseDistributorPending(raw: string, actor: number): Promise<DistributorPending> { if (new TextEncoder().encode(raw).length > 16384) throw Error('原请求记录过大'); const row = object(JSON.parse(raw)); keys(row, ['version', 'actor', 'operation', 'id', 'input', 'fingerprint']); if (row.version !== 1 || row.actor !== actor || !int(actor, 1) || !digest(row.fingerprint)) throw Error('原分销请求身份或格式无效'); const intent = normalizeDistributorIntent({ operation: row.operation, id: row.id, input: row.input } as DistributorIntent); if (await distributorFingerprint(intent) !== row.fingerprint || JSON.stringify(intent.input) !== JSON.stringify(row.input)) throw Error('原分销请求内容与摘要不一致'); return { version: 1, actor, ...intent, fingerprint: row.fingerprint }; }
export const distributorReceiptNotFound = (reason: unknown): boolean => axios.isAxiosError(reason) && reason.response?.status === 404;
export function isDistributorStale(reason: unknown, pending: DistributorPending): boolean { if (!axios.isAxiosError(reason) || reason.response?.status !== 409) return false; const body = reason.response.data; return body?.status === 409 && body?.data?.code === 'DISTRIBUTOR_LEVEL_STALE_VERSION' && body.data.operation === pending.operation && body.data.request_id === pending.input.request_id && body.data.payload_hash === pending.fingerprint; }
export function isDistributorRejected(reason: unknown, pending: DistributorPending): boolean { if (!axios.isAxiosError(reason) || reason.response?.status !== 400) return false; const body = reason.response.data; return body?.status === 400 && body?.data?.code === 'DISTRIBUTOR_LEVEL_REJECTED' && body.data.operation === pending.operation && body.data.request_id === pending.input.request_id && body.data.payload_hash === pending.fingerprint; }
export function distributorErrorMessage(reason: unknown): string { const value = axios.isAxiosError(reason) ? reason.response?.data?.msg ?? reason.message : reason instanceof Error ? reason.message : ''; return text(value, 1000) && value ? value : '请求失败，请重新读取并核对'; }
export function distributorOrphanIds(value: readonly string[]): number[] { return [...new Set(value.flatMap(issue => { const match = /^orphan_task:([1-9]\d{0,9})$/u.exec(issue); return match && Number(match[1]) <= 2147483647 ? [Number(match[1])] : []; }))].sort((a, b) => a - b); }
export function distributorRejectedDraftKey(actor: number): string { if (!int(actor, 1)) throw Error('管理员身份无效'); return `admin_distributor_catalog_rejected:${actor}`; }
export async function apiDistributorList(kind: DistributorKind, query: DistributorQuery, signal?: AbortSignal): Promise<DistributorSnapshot> { const params = normalizeDistributorQuery(kind, query), endpoint = kind === 'level' ? '/agent/levels' : '/agent/level-tasks'; return parseDistributorList(kind, await getData(request.get(endpoint, { params, signal })), params); }
export async function apiDistributorParents(query: DistributorQuery, signal?: AbortSignal): Promise<DistributorParentsSnapshot> { const params = normalizeDistributorQuery('parents', query); return parseDistributorParents(await getData(request.get('/agent/level-tasks/parents', { params, signal })), params); }
export async function apiDistributorDetail(kind: DistributorKind, id: number, signal?: AbortSignal) { if (!int(id, 1)) throw Error('分销记录ID无效'); const endpoint = kind === 'level' ? '/agent/levels' : '/agent/level-tasks'; return parseDistributorDetail(kind, await getData(request.get(`${endpoint}/${id}`, { signal })), id); }
export async function apiDistributorWrite(value: DistributorIntent, signal?: AbortSignal): Promise<DistributorReceipt> { const intent = normalizeDistributorIntent(value), endpoint = distributorKind(intent.operation) === 'level' ? '/agent/levels' : '/agent/level-tasks', action = distributorAction(intent.operation), options = { signal }; const call = action === 'create' ? request.post(endpoint, intent.input, options) : action === 'update' ? request.put(`${endpoint}/${intent.id}`, intent.input, options) : action === 'status' ? request.patch(`${endpoint}/${intent.id}/status`, intent.input, options) : request.delete(`${endpoint}/${intent.id}`, { ...options, data: intent.input }); return parseDistributorReceipt(await getData(call), intent.input.request_id); }
export async function apiDistributorReceipt(kind: DistributorKind, requestId: string, signal?: AbortSignal): Promise<DistributorReceipt> { if (!uuid(requestId)) throw Error('请求标识无效'); const endpoint = kind === 'level' ? '/agent/levels' : '/agent/level-tasks'; return parseDistributorReceipt(await getData(request.get(`${endpoint}/request/${requestId}`, { signal })), requestId); }
