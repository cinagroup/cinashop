import { customerWorkRecord, customerWorkImage } from './customerWork';
import { cashierId, cashierHash, cashierUuid } from './customerWorkCashier';
import { ordinaryCashierMoney } from './customerWorkOrdinaryCashier';
import { isCustomerCashierSystemForm } from './customerWorkCashierCatalog';
import type { OrdinaryCatalogList, OrdinaryCatalogSelection, OrdinaryBuyerList, OrdinaryAddressList,
  OrdinaryCouponPage, OrdinaryQuoteData, OrdinaryPricing, OrdinaryPromotionGifts, OrdinaryCouponRead } from '@/types/customerWorkOrdinaryCashierRead';
const exact = (v: Record<string, unknown>, names: readonly string[]) => Object.keys(v).sort().join('|') === [...names].sort().join('|');
const text = (v: unknown, max: number, empty = true): v is string => typeof v === 'string' && v.length <= max
  && (empty || v.length > 0) && !/[\u0000-\u001f\u007f]/u.test(v);
function readiness(v: unknown): boolean { return customerWorkRecord(v) && exact(v, ['writes', 'reason']) && typeof v.writes === 'boolean' && text(v.reason, 1000); }
function product(v: unknown): boolean {
  return customerWorkRecord(v) && cashierId(v.id) && text(v.store_name, 512, false) && customerWorkImage(v.image)
    && v.product_type === 0 && cashierId(v.system_form_id, true);
}
function page(v: Record<string, unknown>): boolean {
  return cashierId(v.page) && v.page <= 1_000_000 && cashierId(v.limit) && v.limit <= 50 && typeof v.has_more === 'boolean'
    && Array.isArray(v.list) && v.list.length <= v.limit && (!v.has_more || v.list.length > 0);
}
export function isOrdinaryCatalogList(v: unknown): v is OrdinaryCatalogList {
  return customerWorkRecord(v) && exact(v, ['list', 'page', 'limit', 'has_more', 'readiness']) && page(v) && readiness(v.readiness)
    && Array.isArray(v.list) && v.list.every(row => customerWorkRecord(row) && exact(row, ['id', 'store_name', 'image', 'product_type', 'system_form_id', 'sku_count'])
      && product(row) && cashierId(row.sku_count)) && new Set(v.list.map(row => row.id)).size === v.list.length;
}
export function isOrdinaryCatalogSelection(v: unknown): v is OrdinaryCatalogSelection {
  if (!customerWorkRecord(v) || !exact(v, ['product', 'skus', 'system_form', 'readiness']) || !customerWorkRecord(v.product)
    || !exact(v.product, ['id', 'store_name', 'image', 'product_type', 'system_form_id']) || !product(v.product) || !readiness(v.readiness)
    || !Array.isArray(v.skus) || !v.skus.length || v.skus.length > 500
    || !(v.system_form === null ? v.product.system_form_id === 0 : isCustomerCashierSystemForm(v.system_form) && v.system_form.id === v.product.system_form_id)) return false;
  return v.skus.every(row => customerWorkRecord(row) && exact(row, ['sku_unique', 'sku', 'image', 'price', 'stock']) && text(row.sku_unique, 16, false)
    && text(row.sku, 512) && customerWorkImage(row.image) && ordinaryCashierMoney(row.price) && cashierId(row.stock) && row.stock <= 32767)
    && new Set(v.skus.map(row => row.sku_unique)).size === v.skus.length;
}
export function isOrdinaryBuyerList(v: unknown): v is OrdinaryBuyerList {
  return customerWorkRecord(v) && exact(v, ['list', 'page', 'limit', 'has_more']) && page(v) && Array.isArray(v.list)
    && v.list.every(row => customerWorkRecord(row) && exact(row, ['uid', 'nickname', 'phone', 'integral', 'now_money'])
      && cashierId(row.uid) && text(row.nickname, 255) && text(row.phone, 20) && cashierId(row.integral, true) && ordinaryCashierMoney(row.now_money))
    && new Set(v.list.map(row => row.uid)).size === v.list.length;
}
export function isOrdinaryAddressList(v: unknown): v is OrdinaryAddressList {
  return customerWorkRecord(v) && exact(v, ['buyer_uid', 'list']) && cashierId(v.buyer_uid) && Array.isArray(v.list) && v.list.length <= 200
    && v.list.every(row => customerWorkRecord(row) && exact(row, ['id', 'real_name', 'phone', 'province', 'city', 'district', 'street', 'detail', 'city_id', 'is_default'])
      && cashierId(row.id) && text(row.real_name, 32, false) && text(row.phone, 20, false) && text(row.province, 64, false)
      && text(row.city, 64, false) && text(row.district, 64, false) && text(row.street, 100) && text(row.detail, 256, false)
      && cashierId(row.city_id) && typeof row.is_default === 'boolean') && new Set(v.list.map(row => row.id)).size === v.list.length;
}
export function isOrdinaryCouponPage(v: unknown): v is OrdinaryCouponPage {
  return customerWorkRecord(v) && exact(v, ['list', 'next_cursor']) && (v.next_cursor === null || cashierId(v.next_cursor))
    && Array.isArray(v.list) && v.list.length <= 100 && v.list.every(row => customerWorkRecord(row)
      && exact(row, ['id', 'cid', 'title', 'discount_type', 'scope_type', 'coupon_price', 'use_min_price', 'start_time', 'end_time',
        'availability', 'availability_message', 'rule', 'rule_truncated', 'estimated_discount', 'eligible_subtotal'])
      && cashierId(row.id) && cashierId(row.cid) && text(row.title, 512) && (row.discount_type === 1 || row.discount_type === 2)
      && typeof row.scope_type === 'number' && [0, 1, 2, 3].includes(row.scope_type)
      && ordinaryCashierMoney(row.coupon_price) && ordinaryCashierMoney(row.use_min_price)
      && (row.start_time === null || text(row.start_time, 64)) && (row.end_time === null || text(row.end_time, 64))
      && text(row.availability, 100, false) && text(row.availability_message, 1000) && text(row.rule, 8000)
      && typeof row.rule_truncated === 'boolean' && ordinaryCashierMoney(row.estimated_discount) && ordinaryCashierMoney(row.eligible_subtotal))
    && new Set(v.list.map(row => row.id)).size === v.list.length;
}
export function isOrdinaryPricing(v: unknown): v is OrdinaryPricing {
  const moneyKeys = ['amount', 'total', 'raw_total', 'postage', 'raw_postage', 'coupon_discount', 'integral_discount', 'first_order_discount', 'membership_discount', 'promotion_discount'];
  return customerWorkRecord(v) && exact(v, ['currency', ...moneyKeys, 'quantity', 'used_integral', 'remaining_integral', 'integral_policy',
    'gives_integral', 'product_gives_integral', 'promotion_gives_integral']) && v.currency === 'CNY' && moneyKeys.every(key => ordinaryCashierMoney(v[key]))
    && cashierId(v.quantity) && ['used_integral', 'remaining_integral', 'gives_integral', 'product_gives_integral', 'promotion_gives_integral'].every(key => cashierId(v[key], true))
    && Number(v.gives_integral) === Number(v.product_gives_integral) + Number(v.promotion_gives_integral)
    && customerWorkRecord(v.integral_policy) && exact(v.integral_policy, ['enabled', 'ratio']) && typeof v.integral_policy.enabled === 'boolean'
    && typeof v.integral_policy.ratio === 'number' && Number.isFinite(v.integral_policy.ratio) && v.integral_policy.ratio >= 0;
}
export function isOrdinaryPromotionGifts(v: unknown): v is OrdinaryPromotionGifts {
  return customerWorkRecord(v) && exact(v, ['integral', 'coupons', 'products', 'promotions']) && cashierId(v.integral, true)
    && Array.isArray(v.products) && v.products.length <= 200 && v.products.every(row => customerWorkRecord(row)
      && exact(row, ['cart_id', 'product_id', 'sku_unique', 'quantity', 'promotion_id']) && text(row.cart_id, 64, false)
      && cashierId(row.product_id) && text(row.sku_unique, 16, false) && cashierId(row.quantity) && row.quantity <= 32767 && cashierId(row.promotion_id))
    && new Set(v.products.map(row => row.cart_id)).size === v.products.length
    && Array.isArray(v.coupons) && v.coupons.length <= 200 && v.coupons.every(row => customerWorkRecord(row)
      && exact(row, ['issue_id', 'title', 'price', 'min_price']) && cashierId(row.issue_id) && text(row.title, 512)
      && ordinaryCashierMoney(row.price) && ordinaryCashierMoney(row.min_price))
    && Array.isArray(v.promotions) && v.promotions.length <= 200 && v.promotions.every(row => customerWorkRecord(row)
      && exact(row, ['id', 'tier_id', 'name', 'threshold', 'threshold_type', 'repetitions']) && cashierId(row.id) && cashierId(row.tier_id)
      && text(row.name, 512) && ordinaryCashierMoney(row.threshold) && (row.threshold_type === 1 || row.threshold_type === 2)
      && cashierId(row.repetitions));
}
export function isOrdinaryQuoteData(v: unknown): v is OrdinaryQuoteData {
  return customerWorkRecord(v) && exact(v, ['request_key', 'request_hash', 'draft_key', 'draft_hash', 'quote_token', 'quote_fingerprint', 'expires_at',
    'pricing', 'items', 'system_form', 'coupons', 'promotion_gifts']) && cashierUuid(v.request_key) && cashierHash(v.request_hash)
    && cashierUuid(v.draft_key) && cashierHash(v.draft_hash) && cashierHash(v.quote_fingerprint) && typeof v.quote_token === 'string'
    && /^[a-f0-9]{32}$/u.test(v.quote_token) && cashierId(v.expires_at) && isOrdinaryPricing(v.pricing)
    && isOrdinaryCouponPage(v.coupons) && isOrdinaryPromotionGifts(v.promotion_gifts) && v.pricing.promotion_gives_integral === v.promotion_gifts.integral
    && (v.system_form === null || isCustomerCashierSystemForm(v.system_form)) && Array.isArray(v.items) && v.items.length > 0 && v.items.length <= 200
    && v.items.every(row => customerWorkRecord(row) && exact(row, ['cart_id', 'raw_unit_price', 'unit_price', 'total_price', 'discount', 'price_type'])
      && cashierId(row.cart_id) && ['raw_unit_price', 'unit_price', 'total_price', 'discount'].every(key => ordinaryCashierMoney(row[key])) && text(row.price_type, 64, false))
    && new Set(v.items.map(row => row.cart_id)).size === v.items.length;
}
export function isOrdinaryCouponRead(v: unknown): v is OrdinaryCouponRead {
  return customerWorkRecord(v) && exact(v, ['request_key', 'quote_token', 'coupons']) && cashierUuid(v.request_key)
    && typeof v.quote_token === 'string' && /^[a-f0-9]{32}$/u.test(v.quote_token) && isOrdinaryCouponPage(v.coupons);
}
