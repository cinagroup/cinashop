/** Native mobile application credentials. The website Open account is separate.
 * Fixed PHP stores both fields as optional text in varchar(5000) JSON values;
 * form width100 is presentation, not a text-length or credential-format rule.
 */
export const WECHAT_APP_KEYS = ['wechat_app_appid', 'wechat_app_appsecret'] as const;
export type WechatAppKey = typeof WECHAT_APP_KEYS[number];
export const isWechatAppConfigKey = (value: unknown): value is WechatAppKey =>
  typeof value === 'string' && (WECHAT_APP_KEYS as readonly string[]).includes(value);

export type WechatAppTextIntent = { action: 'keep' } | { action: 'replace'; value: string };
export type WechatAppSecretIntent = WechatAppTextIntent | { action: 'clear' };
export type WechatAppSave = {
  request_id: string;
  revision: string;
  fields: { wechat_app_appid: WechatAppTextIntent; wechat_app_appsecret: WechatAppSecretIntent };
  confirmed: true;
};
export type WechatAppReceipt = {
  request_id: string; actor_id: number; state: 'committed' | 'not_applied';
  revision: string; created_at: number; replayed: boolean;
  cache_status: 'cleared' | 'pending' | 'not_required';
};
export type WechatAppSnapshot = {
  settings: { wechat_app_appid: string | null };
  fields: Record<WechatAppKey, { present: boolean; parseable: boolean }>;
  secrets: { wechat_app_appsecret: { present: boolean } };
  revision: string;
  runtime_ready: boolean;
  /** Presence of the configured pair; never a claim of provider or SDK readiness. */
  credentials_complete: boolean;
  issues: Array<{ key: WechatAppKey; message: string }>;
};

export const wechatAppRequestId = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
export const wechatAppRevision = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{64}$/u.test(value);

/** PostgreSQL counts Unicode characters in the serialized value, not UTF-16
 * units, bytes, or the original field. JSON escapes (including NUL) are text.
 */
export function wechatAppStoredValue(value: unknown): string {
  if (typeof value !== 'string') throw Error('原生App配置替换值须为字符串');
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw Error('原生App配置包含无效Unicode');
    } else if (code >= 0xdc00 && code <= 0xdfff) throw Error('原生App配置包含无效Unicode');
  }
  const raw = JSON.stringify(value);
  if ([...raw].length > 5000) throw Error('原生App配置序列化后超过5000字符容量');
  return raw;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('原生App配置须为JSON对象');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')
    || Object.values(descriptors).some(row => !row.enumerable || 'get' in row || 'set' in row)) throw Error('原生App配置须为JSON数据');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: readonly string[]) {
  if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !fields.includes(key))) throw Error('原生App配置字段不完整或包含未知字段');
}
function intent(value: unknown, secret: boolean): WechatAppSecretIntent {
  const row = object(value);
  if (row.action === 'keep' || secret && row.action === 'clear') {
    exact(row, ['action']); return { action: row.action as 'keep' | 'clear' };
  }
  if (row.action !== 'replace') throw Error('原生App配置须明确保留或替换；密钥可明确清空');
  exact(row, ['action', 'value']); wechatAppStoredValue(row.value);
  if (secret && row.value === '') throw Error('清空AppSecret须明确选择清空');
  return { action: 'replace', value: row.value as string };
}
export function parseWechatAppSave(value: unknown): WechatAppSave {
  const row = object(value); exact(row, ['request_id', 'revision', 'fields', 'confirmed']);
  if (!wechatAppRequestId(row.request_id) || !wechatAppRevision(row.revision) || row.confirmed !== true)
    throw Error('请保留原生App配置版本与请求标识，并明确确认保存');
  const fields = object(row.fields); exact(fields, WECHAT_APP_KEYS);
  return { request_id: row.request_id, revision: row.revision, confirmed: true, fields: {
    wechat_app_appid: intent(fields.wechat_app_appid, false) as WechatAppTextIntent,
    wechat_app_appsecret: intent(fields.wechat_app_appsecret, true),
  } };
}

/** Only bounded legacy text/JSON strings are projected. Objects and malformed
 * imported rows remain server-side and can still be kept without rewriting.
 */
export function parseWechatAppStoredText(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || [...raw].length > 5000) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch {
    if (/^[\s]*[\[{"]/u.test(raw)) return null;
    value = raw;
  }
  try { wechatAppStoredValue(value); } catch { return null; }
  return value as string;
}

/** No draft, revision, credential, preview ticket or provider token is journaled. */
export function wechatAppPending(input: WechatAppSave, actor: number) {
  return { version: 1 as const, domain: 'wechat_app' as const, actor_id: actor, request_id: input.request_id };
}
