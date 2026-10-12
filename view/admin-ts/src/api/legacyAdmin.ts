/** Dedicated next-level staff workflow. Modern /system/authority contracts stay separate. */
import request from '@/utils/request';
import type { AxiosResponse } from 'axios';

export type LegacyStaffKind = 'legacy-admin-save' | 'legacy-admin-status' | 'legacy-admin-delete';
export type LegacyStaffAction = 'create' | 'update' | 'status' | 'delete';
export interface LegacyStaffFields { account: string; conf_pwd: string; pwd: string; real_name: string; phone: string; roles: number[]; status: 0 | 1 }
export interface LegacyStaffEnvelope { operation_id: string; operation: LegacyStaffKind; payload: Record<string, unknown> }
export interface LegacyStaffCommit extends LegacyStaffEnvelope { revision: string; expires_at: number; confirmed: true }
export interface LegacyStaffValues { account: string; real_name: string; phone: string; roles: number[]; status: 0 | 1; level: number; is_del: 0 | 1 }
export interface LegacyStaffPreview {
  operation_id: string; actor_id: number; operation: LegacyStaffKind; request_hash: string; revision: string; expires_at: number; requires_confirmation: true;
  summary: { target_id: number; target_name: string; action: LegacyStaffAction; before: LegacyStaffValues | null; after: LegacyStaffValues & { password_changed: boolean } };
}
export interface LegacyStaffPending {
  version: 1; operation_id: string; actor_id: number; operation: LegacyStaffKind; request_hash: string; target_id: number; action: LegacyStaffAction;
}
export interface LegacyStaffReceipt {
  operation_id: string; actor_id: number; operation: LegacyStaffKind; state: 'committed' | 'not_applied' | 'unknown'; request_hash: string | null;
  result: { id: number; created?: boolean; deleted?: boolean } | null;
}
export interface LegacyStaffForm { title: string; action: string; method: 'POST' | 'PUT'; fields: LegacyStaffFields; roleOptions: Array<{ value: number; label: string; disabled?: boolean }> }
export interface LegacyStaffRow {
  id: number; account: string; real_name: string; phone: string; roles: string; level: number; status: 0 | 1;
  last_ip: string; last_time: number; add_time: number; _add_time: string; _last_time: string;
}
export interface LegacyStaffQuery { name: string; status: '' | 0 | 1; page: number; limit: number }
export const staffUUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const kinds = new Set(['legacy-admin-save', 'legacy-admin-status', 'legacy-admin-delete']);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const staffId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && [...value].length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
function exact(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).length === keys.length && keys.every(key => own(value, key)); }
function roles(value: unknown, allowEmpty = false): value is number[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(staffId) && new Set(value).size === value.length && value.join(',').length <= 128;
}
function values(value: unknown, after = false): value is LegacyStaffValues & { password_changed?: boolean } {
  return object(value) && exact(value, ['account', 'real_name', 'phone', 'roles', 'status', 'level', 'is_del', ...(after ? ['password_changed'] : [])])
    && text(value.account, 32) && text(value.real_name, 16) && text(value.phone, 32)
    && roles(value.roles, true) && (value.status === 0 || value.status === 1) && (value.is_del === 0 || value.is_del === 1)
    && typeof value.level === 'number' && Number.isInteger(value.level) && value.level >= 0 && value.level <= 10
    && (!after || typeof value.password_changed === 'boolean');
}
export function parseStaffPending(value: unknown, actor: number): LegacyStaffPending {
  if (!object(value) || !exact(value, ['version', 'operation_id', 'actor_id', 'operation', 'request_hash', 'target_id', 'action']) || value.version !== 1
    || !staffId(actor) || value.actor_id !== actor || typeof value.operation_id !== 'string' || !staffUUID.test(value.operation_id)
    || typeof value.operation !== 'string' || !kinds.has(value.operation) || typeof value.request_hash !== 'string' || !hash.test(value.request_hash)
    || !(value.target_id === 0 || staffId(value.target_id))
    || (value.operation === 'legacy-admin-save' ? value.action !== (value.target_id === 0 ? 'create' : 'update')
      : !staffId(value.target_id) || value.action !== (value.operation === 'legacy-admin-status' ? 'status' : 'delete'))) throw Error('待确认记录无效，请保留记录并核对');
  return value as unknown as LegacyStaffPending;
}
export function validateStaffFields(value: unknown, create: boolean): LegacyStaffFields {
  if (!object(value) || !exact(value, ['account', 'conf_pwd', 'pwd', 'real_name', 'phone', 'roles', 'status'])
    || !text(value.account, 32) || !/^[a-zA-Z0-9_-]{4,32}$/.test(value.account) || !text(value.real_name, 16) || !value.real_name.trim() || !text(value.phone, 32) || !/^1[3-9]\d{9}$/.test(value.phone)
    || !roles(value.roles) || !(value.status === 0 || value.status === 1) || typeof value.pwd !== 'string' || typeof value.conf_pwd !== 'string'
    || !text(value.pwd, 72) || !text(value.conf_pwd, 72) || value.pwd !== value.conf_pwd || (create || value.pwd !== '') && ([...value.pwd].length < 12 || new TextEncoder().encode(value.pwd).length > 72)) {
    throw Error('请核对账号（4–32位字母、数字、_或-）、姓名、11位手机号、数字角色和两次密码；密码至少12字符且最多72个UTF-8字节');
  }
  return { account: value.account, conf_pwd: value.conf_pwd, pwd: value.pwd, real_name: value.real_name, phone: value.phone, roles: [...value.roles], status: value.status };
}
export function parseStaffForm(value: unknown, id: number): LegacyStaffForm {
  const path = `setting/admin${id ? `/${id}` : ''}`, method = id ? 'PUT' : 'POST';
  if (!(id === 0 || staffId(id)) || !object(value) || !text(value.title, 128) || value.action !== path || value.method !== method
    || !Array.isArray(value.rules) || value.rules.length !== 7) throw Error('管理员表单响应不完整');
  const required = ['account', 'pwd', 'conf_pwd', 'real_name', 'phone', 'roles', 'status'], map = new Map<string, Record<string, unknown>>();
  for (const rule of value.rules) {
    if (!object(rule) || typeof rule.field !== 'string' || !required.includes(rule.field) || map.has(rule.field) || !text(rule.title, 128)) throw Error('管理员表单字段无效');
    map.set(rule.field, rule);
  }
  const inputFields = required.slice(0, 5);
  if (inputFields.some(key => map.get(key)!.type !== 'input' || !text(map.get(key)!.value, key === 'account' ? 32 : key === 'real_name' ? 16 : key === 'phone' ? 32 : 0))) throw Error('管理员表单值无效');
  const role = map.get('roles')!, status = map.get('status')!;
  if (!Array.isArray(role.options)) throw Error('角色选项响应无效');
  const options = role.options;
  if (role.type !== 'select' || !object(role.props) || role.props.multiple !== true || !Array.isArray(role.value)
    || !role.value.every(staffId) || new Set(role.value).size !== role.value.length || role.value.join(',').length > 128
    || !Array.isArray(role.options) || role.options.length > 1000 || role.options.some(option => !object(option) || !staffId(option.value) || !text(option.label, 128) || own(option, 'disabled') && typeof option.disabled !== 'boolean')
    || new Set(role.options.map(option => option.value)).size !== role.options.length
    || role.value.some(id => !options.some(option => option.value === id))
    || status.type !== 'radio' || !(status.value === 0 || status.value === 1) || !Array.isArray(status.options) || status.options.length !== 2
    || status.options.some(option => !object(option) || !(option.value === 0 || option.value === 1) || !text(option.label, 128))
    || new Set(status.options.map(option => option.value)).size !== 2) throw Error('角色或状态选项响应无效');
  return { title: value.title, action: path, method, fields: { account: map.get('account')!.value as string, pwd: '', conf_pwd: '', real_name: map.get('real_name')!.value as string,
    phone: map.get('phone')!.value as string, roles: [...role.value] as number[], status: status.value }, roleOptions: role.options.map(option => ({ value: option.value as number, label: option.label as string,
      ...(own(option, 'disabled') ? { disabled: option.disabled as boolean } : {}) })) };
}
async function data(promise: Promise<AxiosResponse<unknown>>): Promise<unknown> {
  const response = await promise, body = response.data;
  if (response.status !== 200 || !object(body) || body.status !== 200 || typeof body.msg !== 'string' || !own(body, 'data')) throw Error('响应不可靠，请保留原操作并查询回执');
  return body.data;
}
export async function apiStaffList(query: LegacyStaffQuery, signal?: AbortSignal): Promise<{ list: LegacyStaffRow[]; count: number }> {
  if (!text(query.name, 64) || !Number.isInteger(query.page) || query.page < 1 || query.page > 500 || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100
    || (query.page - 1) * query.limit > 10000 || !['', 0, 1].includes(query.status)) throw Error('管理员列表查询无效');
  const value = await data(request.get('/setting/admin', { params: { name: query.name.trim(), page: query.page, limit: query.limit, ...(query.status === '' ? {} : { status: query.status }) }, signal }));
  if (!object(value) || !Array.isArray(value.list) || !Number.isSafeInteger(value.count) || Number(value.count) < value.list.length || value.list.length > query.limit
    || value.list.some(row => !object(row) || !staffId(row.id) || !text(row.account, 32) || !text(row.real_name, 16) || !text(row.phone, 32) || !text(row.roles, 16384)
      || typeof row.level !== 'number' || !Number.isInteger(row.level) || row.level < 1 || row.level > 10 || !(row.status === 0 || row.status === 1)
      || !text(row.last_ip, 45) || !Number.isSafeInteger(row.last_time) || Number(row.last_time) < 0 || !Number.isSafeInteger(row.add_time) || Number(row.add_time) < 0
      || !text(row._add_time, 64) || !text(row._last_time, 64)) || new Set(value.list.map(row => row.id)).size !== value.list.length) throw Error('管理员列表响应无效');
  return value as unknown as { list: LegacyStaffRow[]; count: number };
}
export async function apiStaffForm(id: number, signal?: AbortSignal): Promise<LegacyStaffForm> {
  if (!(id === 0 || staffId(id))) throw Error('管理员编号无效');
  return parseStaffForm(await data(request.get(id ? `/setting/admin/${id}/edit` : '/setting/admin/create', { signal })), id);
}
export function parseStaffPreview(value: unknown, envelope: LegacyStaffEnvelope, actor: number): LegacyStaffPreview {
  const id = envelope.payload.id, action = envelope.operation === 'legacy-admin-save' ? id === 0 ? 'create' : 'update' : envelope.operation === 'legacy-admin-status' ? 'status' : 'delete';
  if (!object(value) || !object(value.summary) || !values(value.summary.after, true)) throw Error('影响预览响应不完整，请重新预览');
  const after = value.summary.after;
  if (action === 'create' || action === 'update') {
    const { id: ignored, ...fields } = envelope.payload; void ignored;
    validateStaffFields(fields, action === 'create');
  }
  if (!staffId(actor) || !staffUUID.test(envelope.operation_id) || !(id === 0 || staffId(id)) || !kinds.has(envelope.operation)
    || !object(value) || value.operation_id !== envelope.operation_id || value.actor_id !== actor || value.operation !== envelope.operation
    || typeof value.request_hash !== 'string' || !hash.test(value.request_hash) || typeof value.revision !== 'string' || !hash.test(value.revision)
    || !Number.isSafeInteger(value.expires_at) || Number(value.expires_at) <= Math.floor(Date.now() / 1000) || Number(value.expires_at) > Math.floor(Date.now() / 1000) + 300
    || value.requires_confirmation !== true || !object(value.summary) || value.summary.target_id !== id || value.summary.action !== action || !text(value.summary.target_name, 128)
    || (action === 'create' ? value.summary.before !== null : !values(value.summary.before) || value.summary.before.is_del !== 0) || !values(value.summary.after, true)
    || (action === 'delete' ? value.summary.after.is_del !== 1 || value.summary.after.status !== 0 : value.summary.after.is_del !== 0 || value.summary.after.status !== envelope.payload.status)
    || (action === 'create' || action === 'update' ? ['account', 'real_name', 'phone'].some(key => after[key as 'account' | 'real_name' | 'phone'] !== envelope.payload[key])
      || JSON.stringify(value.summary.after.roles) !== JSON.stringify(envelope.payload.roles) || value.summary.after.password_changed !== (typeof envelope.payload.pwd === 'string' && envelope.payload.pwd !== '')
      : value.summary.after.password_changed !== false)) throw Error('影响预览响应不完整或不匹配，请重新预览');
  if (action === 'status' || action === 'delete') {
    const before = value.summary.before as LegacyStaffValues;
    if (['account', 'real_name', 'phone', 'level'].some(key => after[key as 'account' | 'real_name' | 'phone' | 'level'] !== before[key as 'account' | 'real_name' | 'phone' | 'level'])
      || JSON.stringify(after.roles) !== JSON.stringify(before.roles)) throw Error('启停或删除预览改写了其他账号字段');
  }
  if (action === 'update' && after.level !== (value.summary.before as LegacyStaffValues).level) throw Error('管理员编辑预览改变了目标层级');
  return value as unknown as LegacyStaffPreview;
}
export async function apiStaffPreview(envelope: LegacyStaffEnvelope, actor: number, signal?: AbortSignal) {
  return parseStaffPreview(await data(request.post('/setting/admin-authority/preview', envelope, { signal })), envelope, actor);
}
export function parseStaffReceipt(value: unknown, pending: LegacyStaffPending): LegacyStaffReceipt {
  parseStaffPending(pending, pending.actor_id);
  if (!object(value) || !exact(value, ['operation_id', 'actor_id', 'operation', 'state', 'request_hash', 'result']) || value.operation_id !== pending.operation_id
    || value.actor_id !== pending.actor_id || value.operation !== pending.operation || !['committed', 'not_applied', 'unknown'].includes(String(value.state))) throw Error('回执身份或操作不匹配');
  if (value.state === 'committed') {
    if (value.request_hash !== pending.request_hash || !object(value.result) || !staffId(value.result.id) || pending.target_id !== 0 && value.result.id !== pending.target_id
      || (pending.operation === 'legacy-admin-delete' ? !exact(value.result, ['id', 'deleted']) || value.result.deleted !== true
        : !exact(value.result, ['id', 'created']) || value.result.created !== (pending.action === 'create'))) throw Error('回执请求或结果不匹配');
  } else if (value.request_hash !== null || value.result !== null) throw Error('未执行回执格式错误');
  return value as unknown as LegacyStaffReceipt;
}
export async function apiStaffCommit(envelope: LegacyStaffCommit, pending: LegacyStaffPending, signal?: AbortSignal): Promise<LegacyStaffReceipt> {
  const p = envelope.payload, id = p.id;
  parseStaffPending(pending, pending.actor_id);
  if (envelope.operation_id !== pending.operation_id || envelope.operation !== pending.operation || id !== pending.target_id || !hash.test(envelope.revision)
    || !Number.isSafeInteger(envelope.expires_at) || envelope.confirmed !== true) throw Error('确认请求与原操作不匹配');
  const config = { signal, headers: { 'X-Admin-Operation-Id': envelope.operation_id, 'X-Admin-Revision': envelope.revision, 'X-Admin-Expires-At': String(envelope.expires_at), 'X-Admin-Confirmed': 'true' } };
  let response: Promise<AxiosResponse<unknown>>;
  if (envelope.operation === 'legacy-admin-save') {
    const { id: ignored, ...fields } = p; void ignored;
    const body = validateStaffFields(fields, id === 0);
    response = id === 0 ? request.post('/setting/admin', body, config) : request.put(`/setting/admin/${id}`, body, config);
  } else if (envelope.operation === 'legacy-admin-status') {
    if (!staffId(id) || !exact(p, ['id', 'status']) || !(p.status === 0 || p.status === 1)) throw Error('状态确认请求无效');
    response = request.put(`/setting/set_status/${id}/${p.status}`, undefined, config);
  } else {
    if (!staffId(id) || !exact(p, ['id'])) throw Error('删除确认请求无效');
    response = request.delete(`/setting/admin/${id}`, config);
  }
  const receipt = parseStaffReceipt(await data(response), pending);
  if (receipt.state !== 'committed') throw Error('提交未返回原执行回执，请查询结果');
  return receipt;
}
export async function apiStaffReceipt(pending: LegacyStaffPending, signal?: AbortSignal) {
  parseStaffPending(pending, pending.actor_id);
  return parseStaffReceipt(await data(request.get(`/setting/admin-authority/receipt/${pending.operation_id}`, { params: { operation: pending.operation }, signal })), pending);
}
export async function apiStaffResolve(pending: LegacyStaffPending, signal?: AbortSignal) {
  parseStaffPending(pending, pending.actor_id);
  return parseStaffReceipt(await data(request.post('/setting/admin-authority/resolve', { operation_id: pending.operation_id, operation: pending.operation }, { signal })), pending);
}
