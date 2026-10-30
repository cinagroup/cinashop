import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';

export interface NativeAppAuthComplete { code: string; state: string; verifier: string }
export interface NativeAppAuthPhone { key: string; verifier: string; phone: string; captcha: string }
export const NATIVE_APP_AUTH_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export const NATIVE_APP_AUTH_VERIFIER = /^[a-f0-9]{64}$/u;

/** Exact JSON-own DTOs. No coercion, aliases, accessors or client identity. */
export function nativeAppAuthObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ValidateException('原生App授权请求必须是JSON对象');
  const own = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))
    || keys.some(key => !Object.hasOwn(value, key))
    || Object.values(descriptors).some(property => !property.enumerable || !Object.hasOwn(property, 'value')))
    throw new ValidateException('原生App授权请求字段未知、缺失或无效');
  return value as Record<string, unknown>;
}
export function nativeAppProviderCode(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512 || value.trim() !== value
    || /[\s\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)) throw new ValidateException('原生App授权code无效');
  return value;
}
export function parseNativeAppAuthState(value: unknown): Record<string, never> {
  nativeAppAuthObject(value, []); return {};
}
export function parseNativeAppAuthComplete(value: unknown): NativeAppAuthComplete {
  const row = nativeAppAuthObject(value, ['code', 'state', 'verifier']);
  if (typeof row.state !== 'string' || !NATIVE_APP_AUTH_UUID.test(row.state)
    || typeof row.verifier !== 'string' || !NATIVE_APP_AUTH_VERIFIER.test(row.verifier)) throw new ValidateException('原生App授权状态无效或已过期');
  return { code: nativeAppProviderCode(row.code), state: row.state, verifier: row.verifier };
}
export function parseNativeAppAuthPhone(value: unknown): NativeAppAuthPhone {
  const row = nativeAppAuthObject(value, ['key', 'verifier', 'phone', 'captcha']);
  if (typeof row.key !== 'string' || !NATIVE_APP_AUTH_UUID.test(row.key)
    || typeof row.verifier !== 'string' || !NATIVE_APP_AUTH_VERIFIER.test(row.verifier)
    || typeof row.phone !== 'string' || !/^1\d{10}$/u.test(row.phone)
    || typeof row.captcha !== 'string' || !/^\d{6}$/u.test(row.captcha)) throw new ValidateException('原生App手机号续绑凭据无效');
  return { key: row.key, verifier: row.verifier, phone: row.phone, captcha: row.captcha };
}
export async function readNativeAppAuthBody(request: Request): Promise<unknown> {
  if (request.method !== 'POST' || new URL(request.url).search)
    throw new ValidateException('原生App授权只接受无查询参数的POST');
  if ((request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json')
    throw new ValidateException('原生App授权请求须为JSON');
  const text = await readBoundedUtf8Text(request, 8 * 1024);
  try { return parseLevelActivationJson(text); }
  catch { throw new ValidateException('原生App授权JSON无效、字段重复或层级过深'); }
}
