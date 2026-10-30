import request, { getData } from '@/utils/request';
import { WECHAT_BASE_PUBLIC_KEYS, WECHAT_BASE_SECRET_KEYS, parseWechatBaseSave, wechatBaseRequestId, wechatBaseRevision,
  type WechatBaseSave, type WechatBaseSnapshot, type WechatBaseReceipt } from '../../../common/wechatBase';

const base = '/wechat/base';
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('公众号配置响应须为对象'); return value as Record<string, unknown>; }
function only(row: Record<string, unknown>, keys: readonly string[]) { if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key))) throw Error('公众号配置响应字段不完整或包含未知字段'); }
function integer(value: unknown, minimum = 0) { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > 2147483647) throw Error('公众号配置响应数字无效'); return value; }
function text(value: unknown, max: number) { if (typeof value !== 'string' || value.length > max) throw Error('公众号配置响应文本无效'); return value; }
export function wechatBasePreview(value: unknown): string {
  const raw = text(value, 4096); if (!raw) return '';
  const signed = /^\/api\/assets\/([1-9]\d{0,9})\?expires=\d{10}&signature=[A-Za-z0-9_-]{43}$/u.exec(raw);
  if (signed && Number(signed[1]) <= 2147483647) return raw;
  try { const url = new URL(raw); if (url.protocol === 'https:' && !url.username && !url.password && !/[\u0000-\u0020\u007f]/u.test(raw)) return raw; } catch { /* Reject invalid display URLs. */ }
  throw Error('公众号图片预览地址无效');
}
export function checkedWechatBaseSnapshot(value: unknown): WechatBaseSnapshot {
  const row = object(value); only(row, ['settings', 'raw_public_values', 'secrets', 'revision', 'runtime_ready', 'api', 'callback', 'asset_previews', 'issues']);
  if (!wechatBaseRevision(row.revision) || typeof row.runtime_ready !== 'boolean' || !(row.api === null || typeof row.api === 'string' && row.api.length <= 2048)) throw Error('公众号配置版本无效');
  const settings = object(row.settings), raw = object(row.raw_public_values), secrets = object(row.secrets), callback = object(row.callback), previews = object(row.asset_previews);
  only(settings, WECHAT_BASE_PUBLIC_KEYS); only(raw, WECHAT_BASE_PUBLIC_KEYS); only(secrets, WECHAT_BASE_SECRET_KEYS); only(previews, ['wechat_qrcode']);
  for (const key of WECHAT_BASE_PUBLIC_KEYS) {
    if (raw[key] !== null) text(raw[key], 5000);
    const v = settings[key]; if (v === null) continue;
    if (key === 'wechat_appid' || key === 'wechat_qrcode') text(v, 5000);
    else if (key === 'wechat_encode' ? v !== 0 && v !== 1 && v !== 2 : v !== 0 && v !== 1) throw Error('公众号历史设置投影无效');
  }
  for (const key of WECHAT_BASE_SECRET_KEYS) { const state = object(secrets[key]); only(state, ['present', 'valid']); if (typeof state.present !== 'boolean' || typeof state.valid !== 'boolean') throw Error('公众号密钥状态无效'); }
  only(callback, ['database_enabled', 'authority', 'ready', 'mode', 'deployment_token_present', 'deployment_aes_present']);
  if (!['database_enabled', 'ready', 'deployment_token_present', 'deployment_aes_present'].every(key => typeof callback[key] === 'boolean')
    || !['deployment', 'database', 'disabled'].includes(callback.authority as string) || callback.mode !== null && callback.mode !== 0 && callback.mode !== 1 && callback.mode !== 2) throw Error('公众号回调权威无效');
  wechatBasePreview(previews.wechat_qrcode);
  if (!Array.isArray(row.issues) || row.issues.length > 100) throw Error('公众号历史问题列表无效');
  for (const item of row.issues) { const issue = object(item); only(issue, ['key', 'message']); text(issue.key, 100); text(issue.message, 1000); }
  return row as unknown as WechatBaseSnapshot;
}
export function checkedWechatBaseReceipt(value: unknown, id: string, actor: number): WechatBaseReceipt {
  const row = object(value); only(row, ['request_id', 'actor_id', 'state', 'revision', 'created_at', 'replayed', 'cache_status']);
  if (!wechatBaseRequestId(id) || row.request_id !== id || integer(row.actor_id, 1) !== actor || !wechatBaseRevision(row.revision)
    || row.state !== 'committed' && row.state !== 'not_applied' || typeof row.replayed !== 'boolean'
    || !['cleared', 'pending', 'not_required'].includes(row.cache_status as string)
    || row.state === 'not_applied' && row.cache_status !== 'not_required') throw Error('公众号配置回执身份或终态无效');
  if (typeof row.created_at !== 'number' || !Number.isSafeInteger(row.created_at) || row.created_at <= 0) throw Error('公众号配置回执时间无效'); return row as unknown as WechatBaseReceipt;
}
export interface WechatBaseCategory { id: number; pid: number; name: string }
export interface WechatBaseImage { att_id: number; pid: number; real_name: string; reference: string; preview: string }
export function checkedWechatBaseCategories(value: unknown): WechatBaseCategory[] {
  const row = object(value); only(row, ['list']); if (!Array.isArray(row.list) || row.list.length > 5000) throw Error('图库分类不完整');
  const seen = new Set<number>(); return row.list.map(value => { const item = object(value); only(item, ['id', 'pid', 'name']); const id = integer(item.id, 1); if (seen.has(id)) throw Error('图库分类重复'); seen.add(id); return { id, pid: integer(item.pid), name: text(item.name, 255) }; });
}
export function checkedWechatBaseImages(value: unknown, query: { page: number; limit: number; pid: number }) {
  const row = object(value); only(row, ['list', 'count', 'page', 'limit']); const count = integer(row.count);
  if (count > 5000 || row.page !== query.page || row.limit !== query.limit || !Array.isArray(row.list) || row.list.length !== Math.max(0, Math.min(query.limit, count - (query.page - 1) * query.limit))) throw Error('图库分页目录不完整');
  const ids = new Set<number>(); const list = row.list.map(value => { const item = object(value); only(item, ['att_id', 'pid', 'real_name', 'reference', 'preview']); const id = integer(item.att_id, 1), pid = integer(item.pid);
    if (ids.has(id) || pid !== query.pid || item.reference !== `/api/assets/${id}`) throw Error('图库稳定引用身份无效'); ids.add(id);
    const preview = wechatBasePreview(item.preview); if (!preview.startsWith(item.reference + '?') || !preview) throw Error('图库签名预览与稳定引用不一致');
    return { att_id: id, pid, real_name: text(item.real_name, 255), reference: item.reference as string, preview };
  }); return { list, count };
}
export const apiWechatBase = (signal?: AbortSignal) => getData<unknown>(request.get(base, { signal })).then(checkedWechatBaseSnapshot);
export const apiSaveWechatBase = (input: WechatBaseSave, signal?: AbortSignal) => getData<unknown>(request.post(base, parseWechatBaseSave(input), { signal }));
function operationId(id: string) { if (!wechatBaseRequestId(id)) throw Error('公众号配置请求标识无效'); return id; }
export const apiWechatBaseReceipt = (id: string, signal?: AbortSignal) => getData<unknown>(request.get(`${base}/operations/${operationId(id)}`, { signal }));
export const apiResolveWechatBase = (id: string, signal?: AbortSignal) => getData<unknown>(request.post(`${base}/operations/${operationId(id)}/resolve`, { confirmed: true }, { signal }));
export const apiWechatBaseAttachmentCategories = (signal?: AbortSignal) => getData<unknown>(request.get(`${base}/attachment-categories`, { signal }));
export const apiWechatBaseAttachmentOptions = (params: { page: number; limit: number; pid: number; name: string }, signal?: AbortSignal) => getData<unknown>(request.get(`${base}/attachment-options`, { params, signal }));
