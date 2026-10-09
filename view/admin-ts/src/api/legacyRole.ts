/** The original role list/status/hard-delete contracts have their own confirmed-operation protocol. */
import request from '@/utils/request';
import type { AxiosResponse } from 'axios';

export type LegacyRoleKind = 'legacy-role-status' | 'legacy-role-delete';
export type LegacyRoleAction = 'status' | 'delete';
export interface LegacyRoleRow { id: number; type: 0 | 1; relation_id: 0; role_name: string; rules: string; level: number; status: 0 | 1 }
export interface LegacyRoleQuery { role_name: string; status: '' | 0 | 1; page: number; limit: number }
export interface LegacyRoleEnvelope { operation_id: string; operation: LegacyRoleKind; payload: Record<string, unknown> }
export interface LegacyRoleCommit extends LegacyRoleEnvelope { revision: string; expires_at: number; confirmed: true }
export interface LegacyRoleReference { id: number; account: string; real_name: string; roles: number[]; level: number; status: 0 | 1; is_del: 0 | 1; effective_permission_change: boolean }
export interface LegacyRolePreview {
  operation_id: string; actor_id: number; operation: LegacyRoleKind; request_hash: string; revision: string; expires_at: number; requires_confirmation: true;
  summary: { target_id: number; target_name: string; action: LegacyRoleAction; before: LegacyRoleRow; after: LegacyRoleRow | null;
    impact: { reference_count: number; active_reference_count: number; references: LegacyRoleReference[] } };
}
export interface LegacyRolePending { version: 1; operation_id: string; actor_id: number; operation: LegacyRoleKind; request_hash: string; target_id: number; action: LegacyRoleAction }
export interface LegacyRoleReceipt { operation_id: string; actor_id: number; operation: LegacyRoleKind; state: 'committed' | 'not_applied' | 'unknown'; request_hash: string | null;
  result: { id: number; created?: false; deleted?: true } | null }
export const roleUUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/, kinds = new Set(['legacy-role-status', 'legacy-role-delete']);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const roleId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && [...value].length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const bit = (value: unknown) => value === 0 || value === 1;
function exact(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).length === keys.length && keys.every(key => own(value, key)); }
function role(value: unknown): value is LegacyRoleRow {
  return object(value) && exact(value, ['id', 'type', 'relation_id', 'role_name', 'rules', 'level', 'status']) && roleId(value.id)
    && bit(value.type) && value.relation_id === 0 && text(value.role_name, 50) && text(value.rules, 16384)
    && typeof value.level === 'number' && Number.isInteger(value.level) && value.level >= 0 && value.level <= 10 && bit(value.status);
}
function reference(value: unknown): value is LegacyRoleReference {
  return object(value) && exact(value, ['id', 'account', 'real_name', 'roles', 'level', 'status', 'is_del', 'effective_permission_change'])
    && roleId(value.id) && text(value.account, 32) && text(value.real_name, 16) && Array.isArray(value.roles) && value.roles.every(roleId)
    && new Set(value.roles).size === value.roles.length && value.roles.join(',').length <= 128 && typeof value.level === 'number'
    && Number.isInteger(value.level) && value.level >= 0 && value.level <= 10 && bit(value.status) && bit(value.is_del)
    && typeof value.effective_permission_change === 'boolean';
}
export function parseRolePending(value: unknown, actor: number): LegacyRolePending {
  if (!object(value) || !exact(value, ['version', 'operation_id', 'actor_id', 'operation', 'request_hash', 'target_id', 'action']) || value.version !== 1
    || !roleId(actor) || value.actor_id !== actor || typeof value.operation_id !== 'string' || !roleUUID.test(value.operation_id)
    || typeof value.operation !== 'string' || !kinds.has(value.operation) || typeof value.request_hash !== 'string' || !hash.test(value.request_hash)
    || !roleId(value.target_id) || value.action !== (value.operation === 'legacy-role-status' ? 'status' : 'delete')) throw Error('角色待确认记录无效，请保留记录并核对');
  return value as unknown as LegacyRolePending;
}
function validateEnvelope(value: LegacyRoleEnvelope) {
  if (!roleUUID.test(value.operation_id) || !kinds.has(value.operation) || !object(value.payload) || !roleId(value.payload.id)
    || (value.operation === 'legacy-role-status' ? !exact(value.payload, ['id', 'status']) || !bit(value.payload.status) : !exact(value.payload, ['id']))) throw Error('角色操作请求无效');
}
async function data(promise: Promise<AxiosResponse<unknown>>): Promise<unknown> {
  const response = await promise, body = response.data;
  if (response.status !== 200 || !object(body) || body.status !== 200 || typeof body.msg !== 'string' || !own(body, 'data')) throw Error('响应不可靠，请保留原操作并查询回执');
  return body.data;
}
export async function apiRoleList(query: LegacyRoleQuery, signal?: AbortSignal): Promise<{ list: LegacyRoleRow[]; count: number }> {
  if (!text(query.role_name, 64) || !Number.isInteger(query.page) || query.page < 1 || query.page > 500 || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100
    || (query.page - 1) * query.limit > 10000 || !['', 0, 1].includes(query.status)) throw Error('角色列表查询无效');
  const value = await data(request.get('/setting/role', { params: { role_name: query.role_name.trim(), page: query.page, limit: query.limit,
    ...(query.status === '' ? {} : { status: query.status }) }, signal }));
  if (!object(value) || !exact(value, ['list', 'count']) || !Array.isArray(value.list) || !Number.isSafeInteger(value.count) || Number(value.count) < value.list.length
    || value.list.length > query.limit || !value.list.every(role) || new Set(value.list.map(row => row.id)).size !== value.list.length) throw Error('角色列表响应无效');
  return value as unknown as { list: LegacyRoleRow[]; count: number };
}
export function parseRolePreview(value: unknown, envelope: LegacyRoleEnvelope, actor: number): LegacyRolePreview {
  validateEnvelope(envelope);
  if (!object(value) || !exact(value, ['operation_id', 'actor_id', 'operation', 'request_hash', 'revision', 'expires_at', 'requires_confirmation', 'summary'])
    || !roleId(actor) || value.operation_id !== envelope.operation_id || value.actor_id !== actor || value.operation !== envelope.operation
    || typeof value.request_hash !== 'string' || !hash.test(value.request_hash) || typeof value.revision !== 'string' || !hash.test(value.revision)
    || !Number.isSafeInteger(value.expires_at) || Number(value.expires_at) <= Math.floor(Date.now() / 1000) || Number(value.expires_at) > Math.floor(Date.now() / 1000) + 300
    || value.requires_confirmation !== true || !object(value.summary) || !exact(value.summary, ['target_id', 'target_name', 'action', 'before', 'after', 'impact'])
    || value.summary.target_id !== envelope.payload.id || !text(value.summary.target_name, 50) || value.summary.action !== (envelope.operation === 'legacy-role-status' ? 'status' : 'delete')
    || !role(value.summary.before) || value.summary.before.id !== envelope.payload.id || value.summary.target_name !== value.summary.before.role_name
    || !object(value.summary.impact) || !exact(value.summary.impact, ['reference_count', 'active_reference_count', 'references'])
    || !Array.isArray(value.summary.impact.references) || value.summary.impact.references.length > 1000 || !value.summary.impact.references.every(reference)) throw Error('角色影响预览响应不完整或不匹配，请重新预览');
  const summary = value.summary, impact = summary.impact as Record<string, unknown>, refs = impact.references as LegacyRoleReference[];
  if (impact.reference_count !== refs.length || impact.active_reference_count !== refs.filter(item => item.status === 1 && item.is_del === 0).length
    || refs.some((item, index) => !item.roles.includes(Number(envelope.payload.id)) || index > 0 && refs[index - 1].id >= item.id
      || (item.status === 0 || item.is_del === 1) && item.effective_permission_change)) throw Error('引用账号预览不完整或数量不匹配');
  const before = summary.before as LegacyRoleRow, after = summary.after;
  if (envelope.operation === 'legacy-role-delete') {
    if (after !== null) throw Error('角色删除预览没有声明物理删除');
  } else if (!role(after) || after.status !== envelope.payload.status
    || ['id', 'type', 'relation_id', 'role_name', 'rules', 'level'].some(key => after[key as keyof LegacyRoleRow] !== before[key as keyof LegacyRoleRow])) throw Error('角色启停预览改变了其他角色字段');
  return value as unknown as LegacyRolePreview;
}
export async function apiRolePreview(envelope: LegacyRoleEnvelope, actor: number, signal?: AbortSignal) {
  return parseRolePreview(await data(request.post('/setting/role-authority/preview', envelope, { signal })), envelope, actor);
}
export function parseRoleReceipt(value: unknown, pending: LegacyRolePending): LegacyRoleReceipt {
  parseRolePending(pending, pending.actor_id);
  if (!object(value) || !exact(value, ['operation_id', 'actor_id', 'operation', 'state', 'request_hash', 'result']) || value.operation_id !== pending.operation_id
    || value.actor_id !== pending.actor_id || value.operation !== pending.operation || !['committed', 'not_applied', 'unknown'].includes(String(value.state))) throw Error('角色回执身份或操作不匹配');
  if (value.state === 'committed') {
    if (value.request_hash !== pending.request_hash || !object(value.result) || value.result.id !== pending.target_id
      || (pending.operation === 'legacy-role-delete' ? !exact(value.result, ['id', 'deleted']) || value.result.deleted !== true
        : !exact(value.result, ['id', 'created']) || value.result.created !== false)) throw Error('角色回执请求或结果不匹配');
  } else if (value.request_hash !== null || value.result !== null) throw Error('未执行角色回执格式错误');
  return value as unknown as LegacyRoleReceipt;
}
export async function apiRoleCommit(envelope: LegacyRoleCommit, pending: LegacyRolePending, signal?: AbortSignal): Promise<LegacyRoleReceipt> {
  validateEnvelope(envelope); parseRolePending(pending, pending.actor_id);
  if (envelope.operation_id !== pending.operation_id || envelope.operation !== pending.operation || envelope.payload.id !== pending.target_id
    || !hash.test(envelope.revision) || !Number.isSafeInteger(envelope.expires_at) || envelope.confirmed !== true) throw Error('确认请求与原角色操作不匹配');
  const config = { signal, headers: { 'X-Admin-Operation-Id': envelope.operation_id, 'X-Admin-Revision': envelope.revision,
    'X-Admin-Expires-At': String(envelope.expires_at), 'X-Admin-Confirmed': 'true' } };
  const response = envelope.operation === 'legacy-role-status'
    ? request.put(`/setting/role/set_status/${envelope.payload.id}/${envelope.payload.status}`, undefined, config)
    : request.delete(`/setting/role/${envelope.payload.id}`, config);
  const receipt = parseRoleReceipt(await data(response), pending);
  if (receipt.state !== 'committed') throw Error('提交未返回原执行回执，请查询结果');
  return receipt;
}
export async function apiRoleReceipt(pending: LegacyRolePending, signal?: AbortSignal) {
  parseRolePending(pending, pending.actor_id);
  return parseRoleReceipt(await data(request.get(`/setting/role-authority/receipt/${pending.operation_id}`, { params: { operation: pending.operation }, signal })), pending);
}
export async function apiRoleResolve(pending: LegacyRolePending, signal?: AbortSignal) {
  parseRolePending(pending, pending.actor_id);
  return parseRoleReceipt(await data(request.post('/setting/role-authority/resolve', { operation_id: pending.operation_id, operation: pending.operation }, { signal })), pending);
}
