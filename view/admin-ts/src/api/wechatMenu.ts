import request, { getData } from '@/utils/request';
import { normalizeWechatMenu, type WechatMenuButton } from '../../../common/wechatMenu';
export type MenuReceipt = { operation_id: string; actor_id: number; resolver_id: number; app_id: string;
  state: 'unknown' | 'accepted' | 'accepted_unstored' | 'rejected' | 'not_dispatched' | 'observed_match';
  provider_code: number | null; created_at: number; local_saved: boolean };
export interface MenuSnapshot { menus: WechatMenuButton[] | null; raw: string | null; present: boolean; expired: boolean;
  issues: string[]; revision: string; app_id: string; configured: boolean; runtime_ready: boolean; pending: MenuReceipt | null }
export interface MenuPublish { operation_id: string; revision: string; button: WechatMenuButton[]; replace_history: boolean; confirmed: true }
export interface MenuObservation { receipt: MenuReceipt; observed: boolean; provider_code?: number | null; remote_button?: unknown[]; matches?: boolean; observation?: string }
const SHA = /^[a-f0-9]{64}$/u;
export const menuOperationId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
function object(value: unknown) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('菜单响应须为对象'); return value as Record<string, unknown>; }
function receipt(value: unknown, id?: string): MenuReceipt {
  const row = object(value);
  if (!menuOperationId(row.operation_id) || id !== undefined && row.operation_id !== id
    || typeof row.actor_id !== 'number' || !Number.isSafeInteger(row.actor_id) || row.actor_id <= 0
    || typeof row.resolver_id !== 'number' || !Number.isSafeInteger(row.resolver_id) || row.resolver_id <= 0
    || typeof row.app_id !== 'string' || typeof row.created_at !== 'number' || !Number.isSafeInteger(row.created_at) || row.created_at <= 0
    || !['unknown', 'accepted', 'accepted_unstored', 'rejected', 'not_dispatched', 'observed_match'].includes(row.state as string)
    || !(row.provider_code === null || typeof row.provider_code === 'number' && Number.isSafeInteger(row.provider_code))
    || row.local_saved !== ['accepted', 'observed_match'].includes(row.state as string)) throw Error('菜单发布回执身份或状态无效');
  return row as unknown as MenuReceipt;
}
export async function apiWechatMenu(signal?: AbortSignal): Promise<MenuSnapshot> {
  const row = object(await getData(request.get('/wechat/menu', { signal })));
  if (typeof row.revision !== 'string' || !SHA.test(row.revision) || typeof row.app_id !== 'string'
    || !(row.raw === null || typeof row.raw === 'string') || !['present', 'expired', 'configured', 'runtime_ready'].every(k => typeof row[k] === 'boolean')
    || !Array.isArray(row.issues) || row.issues.some(v => typeof v !== 'string') || row.menus === null && !row.issues.length) throw Error('菜单历史响应不完整');
  if (row.menus !== null) row.menus = normalizeWechatMenu(row.menus, true);
  if (row.pending !== null) row.pending = receipt(row.pending);
  return row as unknown as MenuSnapshot;
}
export async function apiPublishWechatMenu(input: MenuPublish, signal?: AbortSignal) {
  if (!menuOperationId(input.operation_id) || !SHA.test(input.revision) || input.confirmed !== true || typeof input.replace_history !== 'boolean') throw Error('菜单发布参数无效');
  normalizeWechatMenu(input.button);
  return receipt(await getData(request.post('/wechat/menu', input, { signal })), input.operation_id);
}
export async function apiWechatMenuReceipt(id: string, signal?: AbortSignal) {
  if (!menuOperationId(id)) throw Error('菜单发布标识无效');
  return receipt(await getData(request.get(`/wechat/menu/operations/${id}`, { signal })), id);
}
export async function apiObserveWechatMenu(id: string, signal?: AbortSignal): Promise<MenuObservation> {
  if (!menuOperationId(id)) throw Error('菜单发布标识无效');
  const row = object(await getData(request.post(`/wechat/menu/operations/${id}/observe`, {}, { signal })));
  row.receipt = receipt(row.receipt, id);
  if (typeof row.observed !== 'boolean' || row.observed && (!Array.isArray(row.remote_button) || typeof row.matches !== 'boolean'
    || typeof row.observation !== 'string' || !SHA.test(row.observation))) throw Error('线上菜单核对结果不完整');
  return row as unknown as MenuObservation;
}
export async function apiConfirmWechatMenuObservation(id: string, observation: string, signal?: AbortSignal) {
  if (!menuOperationId(id) || !SHA.test(observation)) throw Error('线上菜单观察标识无效');
  return receipt(await getData(request.post(`/wechat/menu/operations/${id}/confirm-observation`, { observation, confirmed: true }, { signal })), id);
}
export async function apiResolveMissingWechatMenu(input: MenuPublish, signal?: AbortSignal) {
  if (!menuOperationId(input.operation_id) || !SHA.test(input.revision) || input.confirmed !== true || typeof input.replace_history !== 'boolean') throw Error('原菜单发布参数无效，请保留原记录');
  normalizeWechatMenu(input.button);
  return receipt(await getData(request.post(`/wechat/menu/operations/${input.operation_id}/resolve-missing`, input, { signal })), input.operation_id);
}
export function wechatMenuOutcome(receipt: MenuReceipt): string {
  return ({ accepted: '微信已接受发布，本地菜单已保存', accepted_unstored: '微信已接受发布；本地配置或菜单已变化，未覆盖本地内容，请人工核对',
    rejected: '微信明确拒绝发布，请检查账号权限和菜单内容', not_dispatched: '本次未发出发布，请重新读取当前内容后处理',
    observed_match: '已人工核对线上菜单匹配，并保存本地菜单', unknown: '发布结果待核对，请保留操作标识，不要新建发布重试' })[receipt.state];
}
