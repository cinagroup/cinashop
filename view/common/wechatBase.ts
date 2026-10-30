/** Complete fixed-PHP official-account base form: nine stored fields and one
 * derived callback URL. Secret replacement material is never a read DTO or a
 * browser journal value. The database callback authority is explicit opt-in. */
export const WECHAT_BASE_CALLBACK_AUTHORITY_KEY = 'wechat_base_callback_authority';
export const WECHAT_BASE_PUBLIC_KEYS = ['wechat_appid', 'wechat_encode', 'share_qrcode', 'spread_share_forever', 'wechat_qrcode', 'create_wechat_user'] as const;
export const WECHAT_BASE_SECRET_KEYS = ['wechat_appsecret', 'wechat_encodingaeskey', 'wechat_token'] as const;
export const WECHAT_BASE_KEYS = [...WECHAT_BASE_PUBLIC_KEYS, ...WECHAT_BASE_SECRET_KEYS] as const;
/** Both compatibility reads and generic batches must defer to this domain. */
export function isWechatBaseConfigKey(value: unknown): value is string {
  return typeof value === 'string' && ([...WECHAT_BASE_KEYS, WECHAT_BASE_CALLBACK_AUTHORITY_KEY] as readonly string[]).includes(value);
}
export type WechatBaseMode = 0 | 1 | 2;
export type WechatBaseSecretKey = typeof WECHAT_BASE_SECRET_KEYS[number];
export type WechatBasePublicKey = typeof WECHAT_BASE_PUBLIC_KEYS[number];
export type WechatBaseValues = { wechat_appid: string; wechat_encode: WechatBaseMode; share_qrcode: 0 | 1; spread_share_forever: 0 | 1; wechat_qrcode: string; create_wechat_user: 0 | 1 };
export type WechatBaseSecretIntent = { action: 'keep' } | { action: 'clear' } | { action: 'replace'; value: string };
export type WechatBaseSave = { request_id: string; revision: string; settings: WechatBaseValues; secrets: Record<WechatBaseSecretKey, WechatBaseSecretIntent>; database_callback: boolean; confirmed: true };
export type WechatBaseReceipt = { request_id: string; actor_id: number; state: 'committed' | 'not_applied'; revision: string; created_at: number; replayed: boolean; cache_status: 'cleared' | 'pending' | 'not_required' };
export type WechatBaseSnapshot = { settings: { [K in keyof WechatBaseValues]: WechatBaseValues[K] | null }; raw_public_values: Record<WechatBasePublicKey, string | null>;
  secrets: Record<WechatBaseSecretKey, { present: boolean; valid: boolean }>; revision: string; runtime_ready: boolean; api: string | null;
  callback: { database_enabled: boolean; authority: 'deployment' | 'database' | 'disabled'; ready: boolean; mode: WechatBaseMode | null; deployment_token_present: boolean; deployment_aes_present: boolean };
  asset_previews: { wechat_qrcode: string }; issues: Array<{ key: string; message: string }> };
export const wechatBaseRequestId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
export const wechatBaseRevision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('公众号配置须为对象'); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, fields: readonly string[]) { const keys = Object.keys(value); if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) throw Error('公众号配置字段不完整或包含未知字段'); }
function scalar(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value) || /[\ud800-\udfff]/u.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/gu, ''))) throw Error(label + '格式无效');
  return value;
}
export function validWechatBaseSecret(key: WechatBaseSecretKey, value: string): boolean {
  if (key === 'wechat_token') return /^[A-Za-z0-9]{3,32}$/u.test(value);
  if (key === 'wechat_encodingaeskey') return /^[A-Za-z0-9]{43}$/u.test(value);
  return !!value && value.length <= 256 && !/[\s\u0000-\u001f\u007f]/u.test(value) && !/[\ud800-\udfff]/u.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/gu, ''));
}
export function normalizeWechatBaseValues(value: unknown): WechatBaseValues {
  const input = record(value); exact(input, WECHAT_BASE_PUBLIC_KEYS);
  const wechat_appid = scalar(input.wechat_appid, '公众号AppID', 18);
  if (wechat_appid && !/^wx[A-Za-z0-9]{16}$/u.test(wechat_appid)) throw Error('公众号AppID须为wx开头的18位标识，或明确留空');
  if (![0, 1, 2].includes(input.wechat_encode as number)) throw Error('请选择明文、兼容或安全模式');
  for (const key of ['share_qrcode', 'spread_share_forever', 'create_wechat_user'] as const) if (input[key] !== 0 && input[key] !== 1) throw Error('请明确选择公众号分享与关注开关');
  const wechat_qrcode = scalar(input.wechat_qrcode, '关注二维码', 2048);
  if (wechat_qrcode !== wechat_qrcode.trim()) throw Error('关注二维码引用不能包含首尾空白');
  return { wechat_appid, wechat_encode: input.wechat_encode as WechatBaseMode, share_qrcode: input.share_qrcode as 0 | 1,
    spread_share_forever: input.spread_share_forever as 0 | 1, wechat_qrcode, create_wechat_user: input.create_wechat_user as 0 | 1 };
}
export function parseWechatBaseSave(value: unknown): WechatBaseSave {
  const input = record(value); exact(input, ['request_id', 'revision', 'settings', 'secrets', 'database_callback', 'confirmed']);
  if (!wechatBaseRequestId(input.request_id) || !wechatBaseRevision(input.revision) || input.confirmed !== true || typeof input.database_callback !== 'boolean') throw Error('请保留原配置版本与请求标识，并明确确认保存');
  const raw = record(input.secrets); exact(raw, WECHAT_BASE_SECRET_KEYS);
  const secrets = {} as Record<WechatBaseSecretKey, WechatBaseSecretIntent>;
  for (const key of WECHAT_BASE_SECRET_KEYS) {
    const intent = record(raw[key]);
    if (intent.action === 'keep' || intent.action === 'clear') { exact(intent, ['action']); secrets[key] = { action: intent.action }; }
    else if (intent.action === 'replace') {
      exact(intent, ['action', 'value']); const text = scalar(intent.value, '密钥替换值', 256);
      if (!validWechatBaseSecret(key, text)) throw Error(key === 'wechat_token' ? 'Token须为3至32位英文字母或数字' : key === 'wechat_encodingaeskey' ? 'EncodingAESKey须为43位英文字母或数字' : 'AppSecret替换值格式无效');
      secrets[key] = { action: 'replace', value: text };
    } else throw Error('密钥须明确选择保留、替换或清空');
  }
  return { request_id: input.request_id, revision: input.revision, settings: normalizeWechatBaseValues(input.settings), secrets, database_callback: input.database_callback, confirmed: true };
}
/** Credential-free journal: no replacement value, secret-derived hash, or draft
 * is persisted. Receipt lookup or durable sealing recovers an uncertain save. */
export function wechatBasePending(input: WechatBaseSave, actor: number) { return { version: 1 as const, actor_id: actor, request_id: input.request_id }; }
