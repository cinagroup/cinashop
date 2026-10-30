/** Fixed PHP wxopen form. Credentials never enter read DTOs or browser journals. */
export const WECHAT_OPEN_AUTHORITY_KEY = 'wechat_open_credentials_authority';
export const WECHAT_OPEN_KEYS = ['wechat_open_app_id', 'wechat_open_app_secret'] as const;
export const isWechatOpenConfigKey = (value: unknown): value is string => typeof value === 'string'
  && ([...WECHAT_OPEN_KEYS, WECHAT_OPEN_AUTHORITY_KEY] as readonly string[]).includes(value);
export type WechatOpenSecretIntent = { action: 'keep' } | { action: 'clear' } | { action: 'replace'; value: string };
export type WechatOpenSave = { request_id: string; revision: string; settings: { wechat_open_app_id: string };
  secrets: { wechat_open_app_secret: WechatOpenSecretIntent }; database_credentials: boolean; confirmed: true };
export type WechatOpenReceipt = { request_id: string; actor_id: number; state: 'committed' | 'not_applied'; revision: string;
  created_at: number; replayed: boolean; cache_status: 'cleared' | 'pending' | 'not_required' };
export type WechatOpenSnapshot = { settings: { wechat_open_app_id: string | null }; raw_public_values: { wechat_open_app_id: string | null };
  secrets: { wechat_open_app_secret: { present: boolean; valid: boolean } }; revision: string; runtime_ready: boolean;
  credentials: { database_enabled: boolean; authority: 'deployment' | 'database' | 'disabled'; ready: boolean; deployment_secret_present: boolean };
  issues: Array<{ key: string; message: string }> };
export const wechatOpenRequestId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
export const wechatOpenRevision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export const validWechatOpenAppId = (value: unknown): value is string => typeof value === 'string' && /^wx[A-Za-z0-9]{16}$/u.test(value);
export const validWechatOpenSecret = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 256
  && !/[\s\u0000-\u001f\u007f]/u.test(value) && !/[\ud800-\udfff]/u.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/gu, ''));
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('开放平台配置须为对象'); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, fields: readonly string[]) { if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) throw Error('开放平台配置字段不完整或包含未知字段'); }
export function parseWechatOpenSave(value: unknown): WechatOpenSave {
  const input = object(value); exact(input, ['request_id', 'revision', 'settings', 'secrets', 'database_credentials', 'confirmed']);
  if (!wechatOpenRequestId(input.request_id) || !wechatOpenRevision(input.revision) || input.confirmed !== true || typeof input.database_credentials !== 'boolean') throw Error('请保留原配置版本与请求标识，并明确确认保存');
  const settings = object(input.settings); exact(settings, ['wechat_open_app_id']);
  const appId = settings.wechat_open_app_id;
  if (appId !== '' && !validWechatOpenAppId(appId)) throw Error('网站应用AppID须为wx开头的18位标识，或明确留空');
  const secrets = object(input.secrets); exact(secrets, ['wechat_open_app_secret']);
  const raw = object(secrets.wechat_open_app_secret); let intent: WechatOpenSecretIntent;
  if (raw.action === 'keep' || raw.action === 'clear') { exact(raw, ['action']); intent = { action: raw.action }; }
  else if (raw.action === 'replace') { exact(raw, ['action', 'value']); if (!validWechatOpenSecret(raw.value)) throw Error('网站应用AppSecret替换值格式无效'); intent = { action: 'replace', value: raw.value }; }
  else throw Error('密钥须明确选择保留、替换或清空');
  if (input.database_credentials && (!validWechatOpenAppId(appId) || intent.action === 'clear')) throw Error('启用数据库凭据须有有效AppID并保留或替换AppSecret；清空密钥前请停用数据库凭据');
  return { request_id: input.request_id, revision: input.revision, settings: { wechat_open_app_id: appId as string },
    secrets: { wechat_open_app_secret: intent }, database_credentials: input.database_credentials, confirmed: true };
}
export function wechatOpenPending(input: WechatOpenSave, actor: number) { return { version: 1 as const, actor_id: actor, request_id: input.request_id }; }
