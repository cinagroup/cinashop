/** The five Mini Program settings owned by this author. The fixed PHP page's
 * phone-login and shipping switches already have separate authors. Text is
 * optional, untrimmed JSON text in varchar(5000); radios are numeric 0 or 1.
 */
export const WECHAT_ROUTINE_TEXT_KEYS = ['routine_appId', 'routine_name'] as const;
export const WECHAT_ROUTINE_RADIO_KEYS = ['routine_contact_type', 'store_user_avatar'] as const;
export const WECHAT_ROUTINE_KEYS = ['routine_appId', 'routine_appsecret', 'routine_name', 'routine_contact_type', 'store_user_avatar'] as const;
export type WechatRoutineKey = typeof WECHAT_ROUTINE_KEYS[number];
export type WechatRoutinePublicKey = Exclude<WechatRoutineKey, 'routine_appsecret'>;
export type WechatRoutineRadioValue = 0 | 1;
export const isWechatRoutineConfigKey = (value: unknown): value is WechatRoutineKey =>
  typeof value === 'string' && (WECHAT_ROUTINE_KEYS as readonly string[]).includes(value);

export type WechatRoutineTextIntent = { action: 'keep' } | { action: 'replace'; value: string };
export type WechatRoutineSecretIntent = WechatRoutineTextIntent | { action: 'clear' };
export type WechatRoutineRadioIntent = { action: 'keep' } | { action: 'replace'; value: WechatRoutineRadioValue };
export type WechatRoutineFields = {
  routine_appId: WechatRoutineTextIntent;
  routine_appsecret: WechatRoutineSecretIntent;
  routine_name: WechatRoutineTextIntent;
  routine_contact_type: WechatRoutineRadioIntent;
  store_user_avatar: WechatRoutineRadioIntent;
};
export type WechatRoutineSave = {
  request_id: string; revision: string; fields: WechatRoutineFields; confirmed: true;
};
export type WechatRoutineReceipt = {
  request_id: string; actor_id: number; state: 'committed' | 'not_applied';
  revision: string; created_at: number; replayed: boolean;
  cache_status: 'cleared' | 'pending' | 'not_required';
};
export type WechatRoutineSnapshot = {
  settings: {
    routine_appId: string | null; routine_name: string | null;
    routine_contact_type: WechatRoutineRadioValue | null;
    store_user_avatar: WechatRoutineRadioValue | null;
  };
  fields: Record<WechatRoutineKey, { present: boolean; parseable: boolean }>;
  secrets: { routine_appsecret: { present: boolean } };
  revision: string;
  /** Exact installed author/authority storage and actual Admin role only.
   * It does not authorize AppID adoption/switching or establish consumers. */
  storage_ready: boolean;
  /** Determined by the service's actual storage/consumer readiness checks.
   * Neither this DTO nor configuration presence proves provider readiness. */
  runtime_ready: boolean;
  credentials_complete: boolean;
  issues: Array<{ key: WechatRoutineKey; message: string }>;
};

export const wechatRoutineRequestId = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
export const wechatRoutineRevision = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{64}$/u.test(value);

/** Count the serialized JSON's Unicode codepoints, including escaping and
 * quotes. Preserve whitespace, NUL and supplementary characters as text. */
export function wechatRoutineStoredValue(value: unknown): string {
  if (typeof value !== 'string') throw Error('小程序配置替换值须为字符串');
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw Error('小程序配置包含无效Unicode');
    } else if (code >= 0xdc00 && code <= 0xdfff) throw Error('小程序配置包含无效Unicode');
  }
  const raw = JSON.stringify(value);
  if ([...raw].length > 5000) throw Error('小程序配置序列化后超过5000字符容量');
  return raw;
}

export function wechatRoutineStoredRadioValue(value: unknown): string {
  if (value !== 0 && value !== 1) throw Error('小程序配置开关须明确选择数字0或1');
  return JSON.stringify(value);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('小程序配置须为JSON对象');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')
    || Object.values(descriptors).some(row => !row.enumerable || 'get' in row || 'set' in row)) throw Error('小程序配置须为JSON数据');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: readonly string[]) {
  if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !fields.includes(key))) throw Error('小程序配置字段不完整或包含未知字段');
}
function textIntent(value: unknown, secret: boolean): WechatRoutineSecretIntent {
  const row = object(value);
  if (row.action === 'keep' || secret && row.action === 'clear') {
    exact(row, ['action']); return { action: row.action as 'keep' | 'clear' };
  }
  if (row.action !== 'replace') throw Error('小程序配置须明确保留或替换；密钥可明确清空');
  exact(row, ['action', 'value']); wechatRoutineStoredValue(row.value);
  if (secret && row.value === '') throw Error('清空AppSecret须明确选择清空');
  return { action: 'replace', value: row.value as string };
}
function radioIntent(value: unknown): WechatRoutineRadioIntent {
  const row = object(value);
  if (row.action === 'keep') { exact(row, ['action']); return { action: 'keep' }; }
  if (row.action !== 'replace') throw Error('小程序配置开关须明确保留或替换');
  exact(row, ['action', 'value']); wechatRoutineStoredRadioValue(row.value);
  return { action: 'replace', value: row.value as WechatRoutineRadioValue };
}
export function parseWechatRoutineSave(value: unknown): WechatRoutineSave {
  const row = object(value); exact(row, ['request_id', 'revision', 'fields', 'confirmed']);
  if (!wechatRoutineRequestId(row.request_id) || !wechatRoutineRevision(row.revision) || row.confirmed !== true)
    throw Error('请保留小程序配置版本与请求标识，并明确确认保存');
  const fields = object(row.fields); exact(fields, WECHAT_ROUTINE_KEYS);
  return { request_id: row.request_id, revision: row.revision, confirmed: true, fields: {
    routine_appId: textIntent(fields.routine_appId, false) as WechatRoutineTextIntent,
    routine_appsecret: textIntent(fields.routine_appsecret, true),
    routine_name: textIntent(fields.routine_name, false) as WechatRoutineTextIntent,
    routine_contact_type: radioIntent(fields.routine_contact_type),
    store_user_avatar: radioIntent(fields.store_user_avatar),
  } };
}

/** Malformed/oversized imported values cannot be projected, but a keep intent
 * never parses or rewrites them. A valid plain legacy string is not trimmed. */
export function parseWechatRoutineStoredText(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || [...raw].length > 5000) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch {
    if (/^[\s]*[\[{"]/u.test(raw)) return null;
    value = raw;
  }
  try { wechatRoutineStoredValue(value); } catch { return null; }
  return value as string;
}

/** PHP radio submissions store JSON numbers. Also project legacy JSON string
 * 0/1 without rewriting it; only an explicit replacement canonicalizes raw. */
export function parseWechatRoutineStoredRadio(raw: string | null | undefined): WechatRoutineRadioValue | null {
  if (typeof raw !== 'string' || [...raw].length > 5000) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (value === 0 || value === '0') return 0;
  if (value === 1 || value === '1') return 1;
  return null;
}

/** No configuration, revision, credential or provider token is journaled. */
export function wechatRoutinePending(input: WechatRoutineSave, actor: number) {
  return { version: 1 as const, domain: 'wechat_routine' as const, actor_id: actor, request_id: input.request_id };
}
