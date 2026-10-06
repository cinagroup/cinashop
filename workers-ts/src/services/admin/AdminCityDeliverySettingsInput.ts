import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { parseLevelActivationJson } from './AdminLevelActivationInput';
import { pcBannerRequestId } from './AdminPcBannerInput';
import { CITY_DELIVERY_CREDENTIAL_BYTE_LIMITS, CITY_DELIVERY_CREDENTIAL_KEYS, CITY_DELIVERY_FLAG_KEYS,
  type CityDeliveryConfirmInput, type CityDeliveryCredentialActions, type CityDeliveryCredentialInput, type CityDeliveryFlags, type CityDeliveryPrepareInput } from '../../../../view/common/cityDeliverySettings';
export const citySettingsRequestId = pcBannerRequestId;
export function cityCredential(value: unknown, key: keyof typeof CITY_DELIVERY_CREDENTIAL_BYTE_LIMITS): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value) || /[\ud800-\udfff]/u.test(value)) throw new ValidateException('配送凭据格式错误');
  const normalized = value.trim();
  if (!normalized || new TextEncoder().encode(normalized).byteLength > CITY_DELIVERY_CREDENTIAL_BYTE_LIMITS[key]) throw new ValidateException('配送凭据为空或超过长度限制');
  return normalized;
}
function record(input: unknown, expected: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidateException('配送请求须为JSON对象');
  const row = input as Record<string, unknown>;
  if (Object.keys(row).length !== expected.length || Object.keys(row).some(key => !expected.includes(key))) throw new ValidateException('配送请求字段不完整或包含未知字段');
  return row;
}
export function cityPrepareInput(input: unknown): CityDeliveryPrepareInput {
  const raw = record(input, ['request_id', 'client_nonce', 'revision', 'flags', 'credentials']);
  const request_id = citySettingsRequestId(raw.request_id), client_nonce = citySettingsRequestId(raw.client_nonce);
  if (typeof raw.revision !== 'string' || !/^[a-f0-9]{64}$/.test(raw.revision)) throw new ValidateException('配送配置版本无效');
  const flagInput = record(raw.flags, CITY_DELIVERY_FLAG_KEYS), flags = {} as CityDeliveryFlags;
  for (const key of CITY_DELIVERY_FLAG_KEYS) {
    if (flagInput[key] !== 0 && flagInput[key] !== 1) throw new ValidateException('配送开关须为0或1');
    flags[key] = flagInput[key] as 0 | 1;
  }
  const credentialInput = record(raw.credentials, CITY_DELIVERY_CREDENTIAL_KEYS), credentials = {} as CityDeliveryPrepareInput['credentials'];
  for (const key of CITY_DELIVERY_CREDENTIAL_KEYS) {
    const entry = credentialInput[key];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new ValidateException('配送凭据动作无效');
    const action = (entry as Record<string, unknown>).action;
    const value = record(entry, action === 'replace' ? ['action', 'value'] : ['action']);
    if (action === 'replace') credentials[key] = { action, value: cityCredential(value.value, key) };
    else if (action === 'keep' || action === 'clear') credentials[key] = { action };
    else throw new ValidateException('配送凭据动作无效');
  }
  return { request_id, client_nonce, revision: raw.revision, flags, credentials };
}
export function cityConfirmInput(input: unknown): CityDeliveryConfirmInput {
  const raw = record(input, ['request_id', 'client_nonce', 'payload_hash']);
  if (typeof raw.payload_hash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.payload_hash)) throw new ValidateException('配送意图摘要无效');
  return { request_id: citySettingsRequestId(raw.request_id), client_nonce: citySettingsRequestId(raw.client_nonce), payload_hash: raw.payload_hash };
}
export function cityCanonical(input: CityDeliveryPrepareInput) {
  const flags = {} as CityDeliveryFlags, credentials = {} as Record<typeof CITY_DELIVERY_CREDENTIAL_KEYS[number], CityDeliveryCredentialInput>;
  for (const key of CITY_DELIVERY_FLAG_KEYS) flags[key] = input.flags[key];
  for (const key of CITY_DELIVERY_CREDENTIAL_KEYS) credentials[key] = input.credentials[key];
  return { operation: 'update' as const, revision: input.revision, flags, credentials };
}
export function cityActions(input: CityDeliveryPrepareInput): CityDeliveryCredentialActions {
  return Object.fromEntries(CITY_DELIVERY_CREDENTIAL_KEYS.map(key => [key, input.credentials[key].action])) as CityDeliveryCredentialActions;
}
export class CityDeliverySettingsStaleVersion extends ValidateException {
  readonly operation = 'update';
  constructor(public readonly request_id: string, public readonly client_nonce: string, public readonly payload_hash: string) { super('配送配置已变化，请重新读取并确认'); this.name = 'CityDeliverySettingsStaleVersion'; }
}
export class CityDeliverySettingsRejected extends ValidateException {
  readonly operation = 'update';
  constructor(message: string, public readonly request_id: string, public readonly client_nonce: string, public readonly payload_hash: string) { super(message); this.name = 'CityDeliverySettingsRejected'; }
}
export async function readCitySettingsBody(request: Request): Promise<unknown> { return parseLevelActivationJson(await readBoundedUtf8Text(request, 16384)); }
