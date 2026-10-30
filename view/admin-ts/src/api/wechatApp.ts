import request, { getData } from '@/utils/request';
import { WECHAT_APP_KEYS, isWechatAppConfigKey, parseWechatAppSave, wechatAppRequestId, wechatAppRevision,
  wechatAppStoredValue, type WechatAppSave, type WechatAppSnapshot, type WechatAppReceipt } from '../../../common/wechatApp';

const base = '/wechat/app';
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string')
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(row => !('value' in row) || !row.enumerable))
    throw Error('原生App配置响应须为JSON对象');
  return value as Record<string, unknown>;
}
function only(row: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key)))
    throw Error('原生App配置响应字段不完整或包含未知字段');
}
function actorId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 2147483647)
    throw Error('原生App配置回执所有者无效');
  return value;
}

/** Accept only the public AppID and explicit field states. Optional text uses
 * the shared serialized-capacity rule, including empty strings and escaped NUL;
 * it does not assert that a provider accepts the configured identifier. */
export function checkedWechatAppSnapshot(value: unknown): WechatAppSnapshot {
  const row = object(value);
  only(row, ['settings', 'fields', 'secrets', 'revision', 'runtime_ready', 'credentials_complete', 'issues']);
  if (!wechatAppRevision(row.revision) || typeof row.runtime_ready !== 'boolean' || typeof row.credentials_complete !== 'boolean')
    throw Error('原生App配置版本或就绪状态无效');
  const settings = object(row.settings), fields = object(row.fields), secrets = object(row.secrets);
  only(settings, ['wechat_app_appid']); only(fields, WECHAT_APP_KEYS); only(secrets, ['wechat_app_appsecret']);
  const states = {} as WechatAppSnapshot['fields'];
  for (const key of WECHAT_APP_KEYS) {
    const field = object(fields[key]); only(field, ['present', 'parseable']);
    const present = field.present, parseable = field.parseable;
    if (typeof present !== 'boolean' || typeof parseable !== 'boolean' || !present && parseable)
      throw Error('原生App配置字段状态无效');
    states[key] = { present, parseable };
  }
  const appId = settings.wechat_app_appid;
  if (appId !== null) wechatAppStoredValue(appId);
  if ((appId !== null) !== states.wechat_app_appid.parseable) throw Error('原生AppID与字段状态不一致');
  const secret = object(secrets.wechat_app_appsecret); only(secret, ['present']);
  if (typeof secret.present !== 'boolean' || secret.present && !states.wechat_app_appsecret.parseable)
    throw Error('原生App密钥状态无效');
  if (row.credentials_complete !== Boolean(appId && secret.present)) throw Error('原生App凭据完整状态不一致');
  if (!Array.isArray(row.issues) || row.issues.length > WECHAT_APP_KEYS.length) throw Error('原生App历史配置问题列表无效');
  const seen = new Set<string>();
  const issues = row.issues.map(value => {
    const issue = object(value); only(issue, ['key', 'message']);
    if (!isWechatAppConfigKey(issue.key) || seen.has(issue.key) || typeof issue.message !== 'string' || issue.message.length > 1000)
      throw Error('原生App历史配置问题格式无效');
    seen.add(issue.key); return { key: issue.key, message: issue.message };
  });
  return { settings: { wechat_app_appid: appId as string | null }, fields: states,
    secrets: { wechat_app_appsecret: { present: secret.present } }, revision: row.revision,
    runtime_ready: row.runtime_ready, credentials_complete: row.credentials_complete, issues };
}

export function checkedWechatAppReceipt(value: unknown, id: string, actor: number): WechatAppReceipt {
  const row = object(value); only(row, ['request_id', 'actor_id', 'state', 'revision', 'created_at', 'replayed', 'cache_status']);
  if (!wechatAppRequestId(id) || row.request_id !== id || actorId(row.actor_id) !== actorId(actor)
    || !wechatAppRevision(row.revision) || row.state !== 'committed' && row.state !== 'not_applied'
    || typeof row.replayed !== 'boolean' || !['cleared', 'pending', 'not_required'].includes(row.cache_status as string)
    || (row.state === 'not_applied') !== (row.cache_status === 'not_required')
    || typeof row.created_at !== 'number' || !Number.isSafeInteger(row.created_at) || row.created_at <= 0)
    throw Error('原生App配置回执身份或终态无效');
  return { request_id: id, actor_id: actor, state: row.state as WechatAppReceipt['state'], revision: row.revision,
    created_at: row.created_at, replayed: row.replayed, cache_status: row.cache_status as WechatAppReceipt['cache_status'] };
}
function operationId(id: string) { if (!wechatAppRequestId(id)) throw Error('原生App请求标识无效'); return id; }
export const apiWechatApp = (signal?: AbortSignal) => getData<unknown>(request.get(base, { signal })).then(checkedWechatAppSnapshot);
export const apiSaveWechatApp = (input: WechatAppSave, signal?: AbortSignal) => getData<unknown>(request.post(base, parseWechatAppSave(input), { signal }));
export const apiWechatAppReceipt = (id: string, signal?: AbortSignal) => getData<unknown>(request.get(`${base}/operations/${operationId(id)}`, { signal }));
export const apiResolveWechatApp = (id: string, signal?: AbortSignal) => getData<unknown>(request.post(`${base}/operations/${operationId(id)}/resolve`, { confirmed: true }, { signal }));
