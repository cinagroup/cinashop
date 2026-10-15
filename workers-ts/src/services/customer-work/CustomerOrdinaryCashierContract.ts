import { ValidateException } from '@/utils/errors';
import { normalizeOutRequestKey } from '@/services/out/OutIdempotency';
import { freezeCustomerJson } from './CustomerWorkOperationRequest';
import type { ManualDeliveryAddress } from '@/services/order/OrderDeliveryAddress';

export const CUSTOMER_ORDINARY_CASHIER_VERSION = 'customer-cashier-ordinary-v1' as const;
export const CUSTOMER_ORDINARY_CASHIER_PAYMENT_VERSION = 'customer-cashier-ordinary-payment-v1' as const;
export const CUSTOMER_ORDINARY_CASHIER_MAX_ROWS = 200;
export interface OrdinaryCashierRow { product_id: number; sku_unique: string; quantity: number }
export interface OrdinaryCashierBuyer { buyer_uid: number; tourist_key: string }
export interface OrdinaryCashierDraft extends OrdinaryCashierBuyer {
  version: typeof CUSTOMER_ORDINARY_CASHIER_VERSION; scope_key: string; rows: readonly OrdinaryCashierRow[];
}
export interface OrdinaryCashierIntent extends OrdinaryCashierBuyer {
  version: typeof CUSTOMER_ORDINARY_CASHIER_VERSION; scope_key: string; draft_key: string; draft_hash: string;
  coupon_id: number; use_integral: boolean; shipping_type: 1 | 2; store_id: number; address_id: number;
  manual_address: ManualDeliveryAddress | null; real_name: string; user_phone: string; mark: string; custom_form: unknown;
}
export interface OrdinaryCashierRowChange {
  version: typeof CUSTOMER_ORDINARY_CASHIER_VERSION; scope_key: string; draft_key: string; draft_hash: string;
  cart_id: number; quantity: number;
}
export interface OrdinaryCashierRemove {
  version: typeof CUSTOMER_ORDINARY_CASHIER_VERSION; scope_key: string; draft_key: string; draft_hash: string; cart_ids: readonly number[];
}
export interface OrdinaryCashierAddRows {
  version: typeof CUSTOMER_ORDINARY_CASHIER_VERSION; scope_key: string; draft_key: string; draft_hash: string; rows: readonly OrdinaryCashierRow[];
}
export interface OrdinaryCashierPayment {
  version: typeof CUSTOMER_ORDINARY_CASHIER_PAYMENT_VERSION; scope_key: string; order_id: number; order_no: string; expected_amount: string;
}

export function ordinaryCashierObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw new ValidateException('普通收银字段不完整');
  return value as Record<string, unknown>;
}
export function ordinaryCashierInteger(value: unknown, zero = false, maximum = 2_147_483_647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > maximum)
    throw new ValidateException('普通收银身份或数量无效');
  return value;
}
export function ordinaryCashierText(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value)
    || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) throw new ValidateException('普通收银文字或标识无效');
  return value;
}
export function ordinaryCashierHash(value: unknown): string {
  const result = ordinaryCashierText(value, 64);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new ValidateException('普通收银摘要无效');
  return result;
}
export function ordinaryCashierBuyer(value: Record<string, unknown>): OrdinaryCashierBuyer {
  const buyer_uid = ordinaryCashierInteger(value.buyer_uid, true), tourist_key = ordinaryCashierText(value.tourist_key, 50, true);
  if ((buyer_uid === 0 && !/^[A-Za-z0-9_-]{1,50}$/.test(tourist_key)) || (buyer_uid > 0 && tourist_key !== ''))
    throw new ValidateException('游客与会员购买身份不能混用');
  return Object.freeze({ buyer_uid, tourist_key });
}
function version(value: Record<string, unknown>): typeof CUSTOMER_ORDINARY_CASHIER_VERSION {
  if (value.version !== CUSTOMER_ORDINARY_CASHIER_VERSION) throw new ValidateException('普通收银合同版本无效');
  return CUSTOMER_ORDINARY_CASHIER_VERSION;
}
function parseRows(value: unknown): readonly OrdinaryCashierRow[] {
  if (!Array.isArray(value) || !value.length || value.length > CUSTOMER_ORDINARY_CASHIER_MAX_ROWS)
    throw new ValidateException('普通收银购物行必须为 1 至 200 项');
  const rows = value.map(value => {
    const row = ordinaryCashierObject(value, ['product_id', 'sku_unique', 'quantity']);
    return Object.freeze({ product_id: ordinaryCashierInteger(row.product_id), sku_unique: ordinaryCashierText(row.sku_unique, 16),
      quantity: ordinaryCashierInteger(row.quantity, false, 32767) });
  });
  if (new Set(rows.map(row => `${row.product_id}:${row.sku_unique}`)).size !== rows.length)
    throw new ValidateException('同一商品规格请合并为一个购物行');
  return Object.freeze(rows);
}
export function parseOrdinaryCashierDraft(value: unknown): OrdinaryCashierDraft {
  const r = ordinaryCashierObject(value, ['version', 'scope_key', 'buyer_uid', 'tourist_key', 'rows']);
  return Object.freeze({ version: version(r), scope_key: ordinaryCashierHash(r.scope_key), ...ordinaryCashierBuyer(r), rows: parseRows(r.rows) });
}
function draftIdentity(r: Record<string, unknown>) {
  return { version: version(r), scope_key: ordinaryCashierHash(r.scope_key), draft_key: normalizeOutRequestKey(r.draft_key),
    draft_hash: ordinaryCashierHash(r.draft_hash) };
}
export function parseOrdinaryCashierRowChange(value: unknown): OrdinaryCashierRowChange {
  const r = ordinaryCashierObject(value, ['version', 'scope_key', 'draft_key', 'draft_hash', 'cart_id', 'quantity']);
  return Object.freeze({ ...draftIdentity(r), cart_id: ordinaryCashierInteger(r.cart_id), quantity: ordinaryCashierInteger(r.quantity, false, 32767) });
}
export function parseOrdinaryCashierRemove(value: unknown): OrdinaryCashierRemove {
  const r = ordinaryCashierObject(value, ['version', 'scope_key', 'draft_key', 'draft_hash', 'cart_ids']);
  if (!Array.isArray(r.cart_ids) || !r.cart_ids.length || r.cart_ids.length > CUSTOMER_ORDINARY_CASHIER_MAX_ROWS)
    throw new ValidateException('请选择完整的待删除购物行');
  const cart_ids = r.cart_ids.map(id => ordinaryCashierInteger(id));
  if (new Set(cart_ids).size !== cart_ids.length) throw new ValidateException('删除购物行不能重复');
  return Object.freeze({ ...draftIdentity(r), cart_ids: Object.freeze(cart_ids) });
}
export function parseOrdinaryCashierAddRows(value: unknown): OrdinaryCashierAddRows {
  const r = ordinaryCashierObject(value, ['version','scope_key','draft_key','draft_hash','rows']);
  return Object.freeze({ ...draftIdentity(r), rows: parseRows(r.rows) });
}
export function parseOrdinaryCashierIntent(value: unknown): OrdinaryCashierIntent {
  const r = ordinaryCashierObject(value, ['version', 'scope_key', 'draft_key', 'draft_hash', 'buyer_uid', 'tourist_key', 'coupon_id',
    'use_integral', 'shipping_type', 'store_id', 'address_id', 'manual_address', 'real_name', 'user_phone', 'mark', 'custom_form']);
  const buyer = ordinaryCashierBuyer(r), shipping_type = ordinaryCashierInteger(r.shipping_type), store_id = ordinaryCashierInteger(r.store_id, true),
    address_id = ordinaryCashierInteger(r.address_id, true), coupon_id = ordinaryCashierInteger(r.coupon_id, true);
  if (![1, 2].includes(shipping_type) || typeof r.use_integral !== 'boolean') throw new ValidateException('普通收银配送或积分选择无效');
  if (buyer.buyer_uid === 0 && (coupon_id !== 0 || r.use_integral || address_id !== 0))
    throw new ValidateException('游客不能使用会员优惠券、积分或地址簿');
  if (shipping_type === 2 && (address_id !== 0 || r.manual_address !== null)) throw new ValidateException('自提不能同时提交快递地址');
  if (shipping_type === 1 && store_id !== 0) throw new ValidateException('快递不能同时指定自提门店');
  let manual_address: ManualDeliveryAddress | null = null;
  if (r.manual_address !== null) {
    const a = ordinaryCashierObject(r.manual_address, ['realName', 'phone', 'province', 'city', 'district', 'street', 'detail', 'cityId']);
    if (address_id !== 0) throw new ValidateException('会员地址簿与人工收货地址不能混用');
    manual_address = Object.freeze({ realName: ordinaryCashierText(a.realName, 32), phone: ordinaryCashierText(a.phone, 16),
      province: ordinaryCashierText(a.province, 64), city: ordinaryCashierText(a.city, 64), district: ordinaryCashierText(a.district, 64),
      street: ordinaryCashierText(a.street, 100, true), detail: ordinaryCashierText(a.detail, 256), cityId: ordinaryCashierInteger(a.cityId) });
  }
  if (shipping_type === 1 && address_id === 0 && manual_address === null) throw new ValidateException('普通实体商品快递需要完整收货地址');
  return Object.freeze({ ...draftIdentity(r), ...buyer, coupon_id, use_integral: r.use_integral, shipping_type: shipping_type as 1 | 2,
    store_id, address_id, manual_address, real_name: ordinaryCashierText(r.real_name, 32, buyer.buyer_uid === 0 || shipping_type === 1),
    user_phone: ordinaryCashierText(r.user_phone, 18, buyer.buyer_uid === 0 || shipping_type === 1), mark: ordinaryCashierText(r.mark, 512, true),
    custom_form: freezeCustomerJson(r.custom_form, 65536) });
}
export function parseOrdinaryCashierPayment(value: unknown): OrdinaryCashierPayment {
  const r = ordinaryCashierObject(value, ['version', 'scope_key', 'order_id', 'order_no', 'expected_amount']);
  if (r.version !== CUSTOMER_ORDINARY_CASHIER_PAYMENT_VERSION) throw new ValidateException('普通收银付款版本无效');
  const order_no = ordinaryCashierText(r.order_no, 32), expected_amount = ordinaryCashierText(r.expected_amount, 13);
  if (!/^[A-Za-z0-9_-]+$/.test(order_no) || !/^(0|[1-9]\d{0,9})\.\d{2}$/.test(expected_amount))
    throw new ValidateException('付款订单号或金额格式无效');
  return Object.freeze({ version: CUSTOMER_ORDINARY_CASHIER_PAYMENT_VERSION, scope_key: ordinaryCashierHash(r.scope_key),
    order_id: ordinaryCashierInteger(r.order_id), order_no, expected_amount });
}
