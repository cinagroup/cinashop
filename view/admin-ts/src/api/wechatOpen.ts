import request, { getData } from '@/utils/request';
import { parseWechatOpenSave, wechatOpenRequestId, wechatOpenRevision, validWechatOpenAppId,
  type WechatOpenSave, type WechatOpenSnapshot, type WechatOpenReceipt } from '../../../common/wechatOpen';
const base = '/wechat/open';
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('开放平台响应须为对象'); return value as Record<string, unknown>; }
function only(row: Record<string, unknown>, keys: readonly string[]) { if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key))) throw Error('开放平台响应字段不完整或包含未知字段'); }
function integer(value: unknown, minimum = 0) { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > 2147483647) throw Error('开放平台响应数字无效'); return value; }
function text(value: unknown, max: number) { if (typeof value !== 'string' || value.length > max) throw Error('开放平台响应文本无效'); return value; }
export function checkedWechatOpenSnapshot(value: unknown): WechatOpenSnapshot {
  const row = object(value); only(row, ['settings','raw_public_values','secrets','revision','runtime_ready','credentials','issues']);
  if (!wechatOpenRevision(row.revision) || typeof row.runtime_ready !== 'boolean') throw Error('开放平台配置版本无效');
  const settings = object(row.settings), raw = object(row.raw_public_values), secrets = object(row.secrets), credentials = object(row.credentials);
  only(settings, ['wechat_open_app_id']); only(raw, ['wechat_open_app_id']); only(secrets, ['wechat_open_app_secret']);
  if (settings.wechat_open_app_id !== null && settings.wechat_open_app_id !== '' && !validWechatOpenAppId(settings.wechat_open_app_id)) throw Error('开放平台AppID投影无效');
  if (raw.wechat_open_app_id !== null) text(raw.wechat_open_app_id, 1024 * 1024);
  const secret = object(secrets.wechat_open_app_secret); only(secret, ['present','valid']);
  if (typeof secret.present !== 'boolean' || typeof secret.valid !== 'boolean') throw Error('开放平台密钥状态无效');
  only(credentials, ['database_enabled','authority','ready','deployment_secret_present']);
  if (!['database_enabled','ready','deployment_secret_present'].every(key => typeof credentials[key] === 'boolean') || !['deployment','database','disabled'].includes(credentials.authority as string)) throw Error('开放平台凭据来源无效');
  if (credentials.deployment_secret_present ? credentials.authority !== 'deployment' : credentials.authority !== (credentials.database_enabled ? 'database' : 'disabled')) throw Error('开放平台凭据来源不一致');
  if (credentials.authority === 'disabled' && credentials.ready) throw Error('未启用的凭据不能就绪');
  if (!Array.isArray(row.issues) || row.issues.length > 100) throw Error('开放平台历史问题列表无效');
  for (const value of row.issues) { const issue = object(value); only(issue, ['key','message']); text(issue.key, 100); text(issue.message, 1000); }
  return row as unknown as WechatOpenSnapshot;
}
export function checkedWechatOpenReceipt(value: unknown, id: string, actor: number): WechatOpenReceipt {
  const row = object(value); only(row, ['request_id', 'actor_id', 'state', 'revision', 'created_at', 'replayed', 'cache_status']);
  if (!wechatOpenRequestId(id) || row.request_id !== id || integer(row.actor_id, 1) !== actor || !wechatOpenRevision(row.revision)
    || row.state !== 'committed' && row.state !== 'not_applied' || typeof row.replayed !== 'boolean'
    || !['cleared', 'pending', 'not_required'].includes(row.cache_status as string)
    || row.state === 'not_applied' && row.cache_status !== 'not_required') throw Error('开放平台配置回执身份或终态无效');
  if (typeof row.created_at !== 'number' || !Number.isSafeInteger(row.created_at) || row.created_at <= 0) throw Error('开放平台配置回执时间无效'); return row as unknown as WechatOpenReceipt;
}
export const apiWechatOpen = (signal?: AbortSignal) => getData<unknown>(request.get(base, { signal })).then(checkedWechatOpenSnapshot);
export const apiSaveWechatOpen = (input: WechatOpenSave, signal?: AbortSignal) => getData<unknown>(request.post(base, parseWechatOpenSave(input), { signal }));
function operationId(id: string) { if (!wechatOpenRequestId(id)) throw Error('开放平台请求标识无效'); return id; }
export const apiWechatOpenReceipt = (id: string, signal?: AbortSignal) => getData<unknown>(request.get(`${base}/operations/${operationId(id)}`, { signal }));
export const apiResolveWechatOpen = (id: string, signal?: AbortSignal) => getData<unknown>(request.post(`${base}/operations/${operationId(id)}/resolve`, { confirmed: true }, { signal }));
