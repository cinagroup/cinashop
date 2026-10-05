import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { parseLevelActivationJson } from './AdminLevelActivationInput';

export const SHIPPING_SETTINGS_KEYS = ['whole_free_shipping', 'store_free_postage', 'offline_postage', 'store_self_mention'] as const;
export type ShippingSettingsKey = (typeof SHIPPING_SETTINGS_KEYS)[number];
export interface ShippingPickupInput {
  name: string; phone: string; address_ids: number[]; detailed_address: string;
  day_time: [string, string]; latitude: string; longitude: string;
}
export interface ShippingSettingsCanonical {
  operation: 'save'; revision: string; whole_free_shipping: 0 | 1; store_free_postage: string;
  offline_postage: 0 | 1; store_self_mention: 0 | 1; pickup: ShippingPickupInput | null;
}
export interface ShippingSettingsReceipt { operation: 'save'; request_id: string; payload_hash: string }
/** Only a pre-business-DML CAS mismatch may signal this definite rejection.
 * The controller receives it after the transaction driver's awaited rollback. */
export class ShippingSettingsStaleVersion extends ValidateException {
  constructor(public readonly request_id: string, public readonly payload_hash: string) {
    super('配送设置或默认提货点已变化，请重新读取并确认');
    this.name = 'ShippingSettingsStaleVersion';
  }
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const INT_MAX = 2_147_483_647;

export function shippingRequestId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ValidateException('请求标识必须是UUID');
  return value;
}
export function shippingId(value: unknown, zero = false): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || !(zero ? /^(?:0|[1-9]\d{0,9})$/ : /^[1-9]\d{0,9}$/).test(String(value))) {
    throw new ValidateException('配送设置ID无效');
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > INT_MAX) throw new ValidateException('配送设置ID无效');
  return result;
}
function object(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException(`${label}须为JSON对象`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !fields.includes(key))) throw new ValidateException(`不支持的${label}字段`);
  return record;
}
function flag(value: unknown, label: string): 0 | 1 {
  if (value !== 0 && value !== 1) throw new ValidateException(`${label}须为整数0或1`);
  return value;
}
function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ValidateException(`${label}须为1至${maximum}个非控制字符`);
  }
  return value.trim();
}
/** Decimal text is never rounded through floating point, including receipt intent. */
export function shippingMoney(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(value)) {
    throw new ValidateException('满额包邮金额须为0至99999999.99且最多两位小数');
  }
  const [whole, decimal = ''] = value.split('.');
  return `${whole}.${decimal.padEnd(2, '0')}`;
}
export function shippingCoordinate(value: unknown, maximum: 90 | 180): string {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/.test(value) || Math.abs(Number(value)) > maximum) {
    throw new ValidateException(`${maximum === 90 ? '纬度' : '经度'}格式或范围无效`);
  }
  let result = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  if (result === '-0') result = '0';
  return result;
}
export function shippingPickup(value: unknown): ShippingPickupInput {
  const row = object(value, ['name', 'phone', 'address_ids', 'detailed_address', 'day_time', 'latitude', 'longitude'], '提货点');
  const phone = text(row.phone, 11, '提货点手机号');
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new ValidateException('请输入正确的提货点手机号');
  if (!Array.isArray(row.address_ids) || row.address_ids.length < 3 || row.address_ids.length > 4 || row.address_ids.some(id => typeof id !== 'number')) {
    throw new ValidateException('提货点地址须包含省市区及可选街道ID');
  }
  const address_ids = row.address_ids.map(id => shippingId(id));
  if (new Set(address_ids).size !== address_ids.length) throw new ValidateException('提货点地址ID不能重复');
  if (!Array.isArray(row.day_time) || row.day_time.length !== 2 || row.day_time.some(time => typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) {
    throw new ValidateException('营业时间须为两个24小时制HH:mm时间');
  }
  return { name: text(row.name, 100, '提货点名称'), phone, address_ids,
    detailed_address: text(row.detailed_address, 255, '提货点详细地址'), day_time: row.day_time as [string, string],
    latitude: shippingCoordinate(row.latitude, 90), longitude: shippingCoordinate(row.longitude, 180) };
}
/** This exact key order is shared with the browser SHA-256 wire contract. */
export function shippingSettingsCanonical(value: unknown): { request_id: string; canonical: ShippingSettingsCanonical } {
  const raw = object(value, ['request_id', 'revision', ...SHIPPING_SETTINGS_KEYS, 'pickup'], '配送设置');
  const request_id = shippingRequestId(raw.request_id);
  if (typeof raw.revision !== 'string' || !HASH.test(raw.revision)) throw new ValidateException('配送设置版本无效，请刷新后重试');
  const store_self_mention = flag(raw.store_self_mention, '到店自提');
  if (store_self_mention === 0 && raw.pickup !== null) throw new ValidateException('关闭到店自提时提货点须为null');
  return { request_id, canonical: { operation: 'save', revision: raw.revision,
    whole_free_shipping: flag(raw.whole_free_shipping, '全场包邮'), store_free_postage: shippingMoney(raw.store_free_postage),
    offline_postage: flag(raw.offline_postage, '线下支付包邮'), store_self_mention,
    pickup: store_self_mention === 1 ? shippingPickup(raw.pickup) : null } };
}
export async function shippingSettingsHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function readShippingSettingsBody(request: Request): Promise<Record<string, unknown>> {
  const source = await readBoundedUtf8Text(request, 8192);
  let result: unknown;
  try { result = parseLevelActivationJson(source); }
  catch (error) {
    if (error instanceof ValidateException) throw new ValidateException(error.message.replaceAll('会员激活配置', '配送设置'));
    throw error;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ValidateException('配送设置须为JSON对象');
  return result as Record<string, unknown>;
}
