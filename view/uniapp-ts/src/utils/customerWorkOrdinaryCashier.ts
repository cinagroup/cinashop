import { customerWorkCanonicalJson, customerWorkSha256 } from '../../../common/customerWorkIntent';
import { customerWorkRecord } from './customerWork';
import { cashierHash, cashierId, cashierUuid } from './customerWorkCashier';
import type { OrdinaryCashierDraftInput, OrdinaryCashierIntent, OrdinaryCashierQuantityInput,
  OrdinaryCashierRemoveInput, OrdinaryCashierAddRowsInput, OrdinaryCashierPaymentInput,
  OrdinaryCashierRead } from '@/api/customerWorkOrdinaryCashier';

export type OrdinaryCashierKind = 'draft' | 'append' | 'quantity' | 'remove' | 'creation' | 'payment';
export type OrdinaryCashierBody = OrdinaryCashierDraftInput | OrdinaryCashierAddRowsInput | OrdinaryCashierQuantityInput
  | OrdinaryCashierRemoveInput | OrdinaryCashierIntent | OrdinaryCashierPaymentInput;
export interface OrdinaryDraftRow { cart_id: number; product_id: number; sku_unique: string; quantity: number; removed: boolean; consumed: boolean }
export interface OrdinaryDraftSnapshot {
  version: 'customer-cashier-ordinary-v1'; actor_uid: number; draft_key: string; draft_hash: string;
  scope_key: string; buyer_uid: number; tourist_key: string; rows: OrdinaryDraftRow[];
}
export interface OrdinaryPaymentSource {
  order_id: number; order_no: string; buyer_uid: number; creator_uid: number; amount: string;
  origin_hash: string; creation_key: string;
}
export interface OrdinaryCreationQuote {
  request_key: string; request_hash: string; draft_key: string; draft_hash: string; quote_token: string;
  quote_fingerprint: string; expires_at: number; amount: string; quantity: number;
  read: OrdinaryCashierRead<Record<string, unknown>>;
}
export interface OrdinaryCashierPending {
  version: 'customer-cashier-ordinary-pending-v1'; actor_uid: number; service_id: number;
  request_key: string; request_hash: string; created_at: number; kind: OrdinaryCashierKind;
  body: OrdinaryCashierBody; draft: OrdinaryDraftSnapshot | null; source: OrdinaryPaymentSource | null; quote: OrdinaryCreationQuote | null;
}
export interface OrdinaryCashierReceipt {
  version: 'customer-cashier-ordinary-receipt-v1'; actor_uid: number; request_key: string; request_hash: string;
  scope_key: string; kind: OrdinaryCashierKind | 'abandon'; intent: OrdinaryCashierBody; evidence: Record<string, unknown>;
}
export const ORDINARY_CASHIER_PENDING_STORAGE = 'customer_cashier_ordinary_pending_v1';
export const ordinaryCashierDigest = (value: unknown) => customerWorkSha256(customerWorkCanonicalJson(value));
const version = 'customer-cashier-ordinary-v1';
const exact = (r: Record<string, unknown>, names: readonly string[]) => Object.keys(r).sort().join('|') === [...names].sort().join('|');
const text = (v: unknown, max: number, empty = false): v is string => typeof v === 'string'
  && v.length <= max && (empty || v.length > 0) && v.trim() === v && !/[\u0000-\u001f\u007f]/u.test(v);
export const ordinaryCashierMoney = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d{0,9})\.\d{2}$/u.test(v);
const orderNo = (v: unknown): v is string => text(v, 32) && /^[A-Za-z0-9_-]+$/u.test(v);
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
function boundedJson(v: unknown): boolean {
  try { return new TextEncoder().encode(customerWorkCanonicalJson(v)).length <= 65536; } catch { return false; }
}
function buyer(r: Record<string, unknown>): boolean {
  return cashierId(r.buyer_uid, true) && text(r.tourist_key, 50, true)
    && (r.buyer_uid === 0 ? /^[A-Za-z0-9_-]{1,50}$/u.test(r.tourist_key) : r.tourist_key === '');
}
function rows(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0 && v.length <= 200 && v.every(row => customerWorkRecord(row)
    && exact(row, ['product_id', 'sku_unique', 'quantity']) && cashierId(row.product_id)
    && text(row.sku_unique, 16) && cashierId(row.quantity) && row.quantity <= 32767)
    && new Set(v.map(row => `${row.product_id}:${row.sku_unique}`)).size === v.length;
}
function draftIdentity(r: Record<string, unknown>): boolean {
  return r.version === version && cashierHash(r.scope_key) && cashierUuid(r.draft_key) && cashierHash(r.draft_hash);
}
export function isOrdinaryCashierBody(kind: OrdinaryCashierKind, v: unknown): v is OrdinaryCashierBody {
  if (!customerWorkRecord(v) || !boundedJson(v)) return false;
  if (kind === 'payment') return exact(v, ['version', 'scope_key', 'order_id', 'order_no', 'expected_amount'])
    && v.version === 'customer-cashier-ordinary-payment-v1' && cashierHash(v.scope_key)
    && cashierId(v.order_id) && orderNo(v.order_no) && ordinaryCashierMoney(v.expected_amount);
  if (kind === 'draft') return exact(v, ['version', 'scope_key', 'buyer_uid', 'tourist_key', 'rows'])
    && v.version === version && cashierHash(v.scope_key) && buyer(v) && rows(v.rows);
  if (!draftIdentity(v)) return false;
  if (kind === 'append') return exact(v, ['version', 'scope_key', 'draft_key', 'draft_hash', 'rows']) && rows(v.rows);
  if (kind === 'quantity') return exact(v, ['version', 'scope_key', 'draft_key', 'draft_hash', 'cart_id', 'quantity'])
    && cashierId(v.cart_id) && cashierId(v.quantity) && v.quantity <= 32767;
  if (kind === 'remove') return exact(v, ['version', 'scope_key', 'draft_key', 'draft_hash', 'cart_ids'])
    && Array.isArray(v.cart_ids) && v.cart_ids.length > 0 && v.cart_ids.length <= 200
    && v.cart_ids.every(id => cashierId(id)) && new Set(v.cart_ids).size === v.cart_ids.length;
  if (kind !== 'creation' || !exact(v, ['version', 'scope_key', 'draft_key', 'draft_hash', 'buyer_uid', 'tourist_key', 'coupon_id',
    'use_integral', 'shipping_type', 'store_id', 'address_id', 'manual_address', 'real_name', 'user_phone', 'mark', 'custom_form'])
    || !buyer(v) || !cashierId(v.coupon_id, true) || typeof v.use_integral !== 'boolean'
    || (v.shipping_type !== 1 && v.shipping_type !== 2) || !cashierId(v.store_id, true) || !cashierId(v.address_id, true)) return false;
  if (v.buyer_uid === 0 && (v.coupon_id !== 0 || v.use_integral || v.address_id !== 0)) return false;
  if (v.shipping_type === 2 && (v.address_id !== 0 || v.manual_address !== null)) return false;
  if (v.shipping_type === 1 && (v.store_id !== 0 || (v.address_id === 0 && v.manual_address === null))) return false;
  if (v.manual_address !== null) {
    const a = v.manual_address;
    if (!customerWorkRecord(a) || v.address_id !== 0 || !exact(a, ['realName', 'phone', 'province', 'city', 'district', 'street', 'detail', 'cityId'])
      || !text(a.realName, 32) || !text(a.phone, 16) || !text(a.province, 64) || !text(a.city, 64) || !text(a.district, 64)
      || !text(a.street, 100, true) || !text(a.detail, 256) || !cashierId(a.cityId)) return false;
  }
  return text(v.real_name, 32, v.buyer_uid === 0 || v.shipping_type === 1)
    && text(v.user_phone, 18, v.buyer_uid === 0 || v.shipping_type === 1) && text(v.mark, 512, true) && boundedJson(v.custom_form);
}
export function isOrdinaryDraftSnapshot(v: unknown): v is OrdinaryDraftSnapshot {
  if (!customerWorkRecord(v) || !exact(v, ['version', 'actor_uid', 'draft_key', 'draft_hash', 'scope_key', 'buyer_uid', 'tourist_key', 'rows'])
    || !draftIdentity(v) || !cashierId(v.actor_uid) || !buyer(v) || !Array.isArray(v.rows) || !v.rows.length || v.rows.length > 200) return false;
  return v.rows.every(row => customerWorkRecord(row) && exact(row, ['cart_id', 'product_id', 'sku_unique', 'quantity', 'removed', 'consumed'])
    && cashierId(row.cart_id) && cashierId(row.product_id) && text(row.sku_unique, 16) && cashierId(row.quantity) && row.quantity <= 32767
    && typeof row.removed === 'boolean' && typeof row.consumed === 'boolean')
    && new Set(v.rows.map(row => row.cart_id)).size === v.rows.length
    && new Set(v.rows.map(row => `${row.product_id}:${row.sku_unique}`)).size === v.rows.length;
}
function paymentSource(v: unknown): v is OrdinaryPaymentSource {
  return customerWorkRecord(v) && exact(v, ['order_id', 'order_no', 'buyer_uid', 'creator_uid', 'amount', 'origin_hash', 'creation_key'])
    && cashierId(v.order_id) && orderNo(v.order_no) && cashierId(v.buyer_uid, true) && cashierId(v.creator_uid)
    && ordinaryCashierMoney(v.amount) && cashierHash(v.origin_hash) && cashierUuid(v.creation_key);
}
function quoteData(v: unknown): v is Record<string, unknown> {
  return customerWorkRecord(v) && exact(v, ['request_key', 'request_hash', 'draft_key', 'draft_hash', 'quote_token', 'quote_fingerprint',
    'expires_at', 'pricing', 'items', 'system_form', 'coupons', 'promotion_gifts']) && cashierUuid(v.request_key) && cashierHash(v.request_hash)
    && cashierUuid(v.draft_key) && cashierHash(v.draft_hash) && cashierHash(v.quote_fingerprint) && typeof v.quote_token === 'string'
    && /^[a-f0-9]{32}$/u.test(v.quote_token) && cashierId(v.expires_at) && customerWorkRecord(v.pricing)
    && v.pricing.currency === 'CNY' && ordinaryCashierMoney(v.pricing.amount) && cashierId(v.pricing.quantity)
    && Array.isArray(v.items) && v.items.length > 0 && v.items.length <= 200
    && v.items.every(item => customerWorkRecord(item) && exact(item, ['cart_id', 'raw_unit_price', 'unit_price', 'total_price', 'discount', 'price_type'])
      && cashierId(item.cart_id) && ['raw_unit_price', 'unit_price', 'total_price', 'discount'].every(key => ordinaryCashierMoney(item[key])) && text(item.price_type, 64))
    && new Set(v.items.map(item => item.cart_id)).size === v.items.length
    && customerWorkRecord(v.promotion_gifts) && exact(v.promotion_gifts, ['integral', 'coupons', 'products', 'promotions'])
    && cashierId(v.promotion_gifts.integral, true) && Array.isArray(v.promotion_gifts.products) && v.promotion_gifts.products.length <= 200
    && v.promotion_gifts.products.every(item => customerWorkRecord(item) && exact(item, ['cart_id', 'product_id', 'sku_unique', 'quantity', 'promotion_id'])
      && text(item.cart_id, 64) && cashierId(item.product_id) && text(item.sku_unique, 16) && cashierId(item.quantity) && item.quantity <= 32767 && cashierId(item.promotion_id))
    && Array.isArray(v.promotion_gifts.coupons) && v.promotion_gifts.coupons.length <= 200
    && Array.isArray(v.promotion_gifts.promotions) && v.promotion_gifts.promotions.length <= 200;
}
function isCreationQuote(v: unknown): v is OrdinaryCreationQuote {
  if (!customerWorkRecord(v) || !exact(v, ['request_key', 'request_hash', 'draft_key', 'draft_hash', 'quote_token', 'quote_fingerprint', 'expires_at', 'amount', 'quantity', 'read'])
    || !customerWorkRecord(v.read) || !customerWorkRecord(v.read.principal) || !cashierId(v.read.principal.service_id)
    || !cashierHash(v.read.scope_key) || !cashierId(v.read.actor_uid)) return false;
  try {
    const read = parseOrdinaryCashierRead(v.read, v.read.actor_uid, { scope_key: v.read.scope_key, principal: { service_id: v.read.principal.service_id } }, quoteData);
    const q = read.data, p = q.pricing as Record<string, unknown>;
    return ['request_key', 'request_hash', 'draft_key', 'draft_hash', 'quote_token', 'quote_fingerprint', 'expires_at'].every(key => v[key] === q[key])
      && v.amount === p.amount && v.quantity === p.quantity && new TextEncoder().encode(customerWorkCanonicalJson(v)).length <= 262144;
  } catch { return false; }
}
export function makeOrdinaryCreationQuote(value: unknown, actorUid: number, serviceId: number, key: string,
  intent: OrdinaryCashierIntent, draft: OrdinaryDraftSnapshot): OrdinaryCreationQuote {
  assert(isOrdinaryCashierBody('creation', intent) && isOrdinaryDraftSnapshot(draft), '原下单内容或完整购物行无效');
  const read = parseOrdinaryCashierRead(value, actorUid, { scope_key: intent.scope_key, principal: { service_id: serviceId } }, quoteData);
  const q = read.data, p = q.pricing as Record<string, unknown>, gifts = q.promotion_gifts as { products: Array<{ quantity: number }>; coupons: unknown[]; integral: number };
  const active = draft.rows.filter(row => !row.removed && !row.consumed), items = q.items as Array<{ cart_id: number }>;
  assert(q.request_key === key && q.request_hash === ordinaryCashierDigest(intent) && key !== draft.draft_key && q.draft_key === draft.draft_key
    && q.draft_hash === draft.draft_hash && draft.draft_key === intent.draft_key && draft.draft_hash === intent.draft_hash
    && draft.actor_uid === actorUid && draft.scope_key === intent.scope_key && draft.buyer_uid === intent.buyer_uid && draft.tourist_key === intent.tourist_key
    && !draft.rows.some(row => row.consumed) && active.length === items.length && active.every(row => items.some(item => item.cart_id === row.cart_id))
    && p.quantity === active.reduce((sum, row) => sum + row.quantity, 0) + gifts.products.reduce((sum, row) => sum + row.quantity, 0), '实际报价与原购买人、全部规格或赠品数量不匹配');
  assert(intent.buyer_uid > 0 || (gifts.products.length === 0 && gifts.coupons.length === 0 && gifts.integral === 0 && p.gives_integral === 0
    && p.used_integral === 0 && p.coupon_discount === '0.00' && p.integral_discount === '0.00'), '游客报价不能包含会员积分、优惠券或赠品');
  const quote: OrdinaryCreationQuote = { request_key: key, request_hash: String(q.request_hash), draft_key: String(q.draft_key), draft_hash: String(q.draft_hash),
    quote_token: String(q.quote_token), quote_fingerprint: String(q.quote_fingerprint), expires_at: Number(q.expires_at), amount: String(p.amount), quantity: Number(p.quantity), read };
  assert(isCreationQuote(quote), '完整原报价无法保存');
  return JSON.parse(customerWorkCanonicalJson(quote));
}
export function isOrdinaryCashierPending(v: unknown): v is OrdinaryCashierPending {
  if (!customerWorkRecord(v) || !exact(v, ['version', 'actor_uid', 'service_id', 'request_key', 'request_hash', 'created_at', 'kind', 'body', 'draft', 'source', 'quote'])
    || v.version !== 'customer-cashier-ordinary-pending-v1' || !cashierId(v.actor_uid) || !cashierId(v.service_id)
    || !cashierUuid(v.request_key) || !cashierHash(v.request_hash) || !cashierId(v.created_at)
    || !['draft', 'append', 'quantity', 'remove', 'creation', 'payment'].includes(String(v.kind))) return false;
  const kind = v.kind as OrdinaryCashierKind;
  if (!isOrdinaryCashierBody(kind, v.body) || ordinaryCashierDigest(v.body) !== v.request_hash) return false;
  if (kind === 'draft') return v.draft === null && v.source === null && v.quote === null;
  if (kind === 'payment') {
    const body = v.body as OrdinaryCashierPaymentInput;
    return v.draft === null && v.quote === null && paymentSource(v.source) && v.source.creation_key !== v.request_key
      && v.source.order_id === body.order_id && v.source.order_no === body.order_no && v.source.amount === body.expected_amount;
  }
  const body = v.body as OrdinaryCashierIntent | OrdinaryCashierAddRowsInput | OrdinaryCashierQuantityInput | OrdinaryCashierRemoveInput;
  if (v.source !== null || !isOrdinaryDraftSnapshot(v.draft) || v.draft.actor_uid !== v.actor_uid || v.draft.scope_key !== body.scope_key
    || v.draft.draft_key !== body.draft_key || v.draft.draft_hash !== body.draft_hash || body.draft_key === v.request_key
    || v.draft.rows.some(row => row.consumed)) return false;
  if (kind === 'creation') {
    if (!isCreationQuote(v.quote) || v.quote.read.actor_uid !== v.actor_uid || v.quote.read.principal.service_id !== v.service_id
      || v.quote.read.scope_key !== body.scope_key || v.quote.request_key !== v.request_key || v.quote.request_hash !== v.request_hash
      || v.quote.draft_key !== body.draft_key || v.quote.draft_hash !== body.draft_hash || v.created_at >= v.quote.expires_at) return false;
    try { makeOrdinaryCreationQuote(v.quote.read, v.actor_uid, v.service_id, v.request_key, body as OrdinaryCashierIntent, v.draft); return true; } catch { return false; }
  }
  if (v.quote !== null) return false;
  const before = v.draft;
  if (kind === 'quantity' || kind === 'remove') {
    const ids = kind === 'quantity' ? [(body as OrdinaryCashierQuantityInput).cart_id] : (body as OrdinaryCashierRemoveInput).cart_ids;
    return ids.every(id => before.rows.some(row => row.cart_id === id && !row.removed));
  }
  const incoming = (body as OrdinaryCashierAddRowsInput).rows;
  return before.rows.length + incoming.filter(row => !before.rows.some(existing => existing.product_id === row.product_id && existing.sku_unique === row.sku_unique)).length <= 200
    && incoming.every(row => row.quantity + (before.rows.find(existing => existing.product_id === row.product_id && existing.sku_unique === row.sku_unique && !existing.removed)?.quantity ?? 0) <= 32767);
}
export function makeOrdinaryCashierPending(actorUid: number, serviceId: number, key: string, kind: OrdinaryCashierKind,
  body: OrdinaryCashierBody, draft: OrdinaryDraftSnapshot | null = null, source: OrdinaryPaymentSource | null = null,
  quote: OrdinaryCreationQuote | null = null, createdAt = Math.floor(Date.now() / 1000)): OrdinaryCashierPending {
  const value = JSON.parse(customerWorkCanonicalJson({ version: 'customer-cashier-ordinary-pending-v1', actor_uid: actorUid,
    service_id: serviceId, request_key: key, request_hash: ordinaryCashierDigest(body), created_at: createdAt, kind, body, draft, source, quote }));
  assert(isOrdinaryCashierPending(value), '原普通收银内容或来源无效，尚未提交');
  return value;
}
export function ordinaryCashierPending(): OrdinaryCashierPending[] {
  const value: unknown = uni.getStorageSync(ORDINARY_CASHIER_PENDING_STORAGE);
  if (value === undefined || value === null || value === '') return [];
  assert(Array.isArray(value) && value.length <= 100 && value.every(isOrdinaryCashierPending)
    && new Set(value.map(row => `${row.actor_uid}:${row.request_key}`)).size === value.length, '本机普通收银记录损坏，请保留原记录核对');
  return JSON.parse(customerWorkCanonicalJson(value));
}
export function retainOrdinaryCashierPending(intent: OrdinaryCashierPending) {
  assert(isOrdinaryCashierPending(intent), '完整原收银内容无效，尚未提交');
  const saved = ordinaryCashierPending(), prior = saved.find(row => row.actor_uid === intent.actor_uid && row.request_key === intent.request_key);
  if (prior) { assert(customerWorkCanonicalJson(prior) === customerWorkCanonicalJson(intent), '同一原编号不能替换内容或来源'); return; }
  assert(saved.length < 100, '原普通收银待核对记录过多，请先核对');
  const next = JSON.parse(customerWorkCanonicalJson([...saved, intent]));
  uni.setStorageSync(ORDINARY_CASHIER_PENDING_STORAGE, next);
  assert(customerWorkCanonicalJson(ordinaryCashierPending()) === customerWorkCanonicalJson(next), '原收银内容保存未确认，尚未提交');
}
function verifyDraftEvidence(value: unknown, pending: OrdinaryCashierPending): OrdinaryDraftSnapshot {
  assert(isOrdinaryDraftSnapshot(value), '原完整购物行回执无效');
  assert(value.actor_uid === pending.actor_uid && value.scope_key === pending.body.scope_key, '购物行回执不属于原经营账号');
  if (pending.kind === 'draft') {
    const input = pending.body as OrdinaryCashierDraftInput;
    assert(value.draft_key === pending.request_key && value.buyer_uid === input.buyer_uid && value.tourist_key === input.tourist_key
      && value.rows.length === input.rows.length && value.rows.every(row => !row.removed && !row.consumed && input.rows.some(original =>
        original.product_id === row.product_id && original.sku_unique === row.sku_unique && original.quantity === row.quantity)), '原草稿选品、数量或购买人不匹配');
  } else {
    const before = pending.draft!;
    assert(value.draft_key === before.draft_key && value.buyer_uid === before.buyer_uid && value.tourist_key === before.tourist_key, '草稿原购买人或编号被替换');
    const incoming = pending.kind === 'append' ? (pending.body as OrdinaryCashierAddRowsInput).rows : [];
    const added = incoming.filter(row => !before.rows.some(old => old.product_id === row.product_id && old.sku_unique === row.sku_unique));
    assert(value.rows.length === before.rows.length + added.length, '原购物行不完整');
    for (const old of before.rows) {
      const actual = value.rows.find(row => row.cart_id === old.cart_id);
      const append = incoming.find(row => row.product_id === old.product_id && row.sku_unique === old.sku_unique);
      const quantity = pending.kind === 'quantity' && (pending.body as OrdinaryCashierQuantityInput).cart_id === old.cart_id
        ? (pending.body as OrdinaryCashierQuantityInput).quantity : append ? (old.removed ? 0 : old.quantity) + append.quantity : old.quantity;
      const removed = pending.kind === 'remove' && (pending.body as OrdinaryCashierRemoveInput).cart_ids.includes(old.cart_id) ? true : append ? false : old.removed;
      assert(actual && actual.product_id === old.product_id && actual.sku_unique === old.sku_unique && actual.quantity === quantity
        && actual.removed === removed && actual.consumed === old.consumed, '原购物行变更不匹配或其他规格被改动');
    }
    for (const row of added) assert(value.rows.some(actual => !before.rows.some(old => old.cart_id === actual.cart_id)
      && actual.product_id === row.product_id && actual.sku_unique === row.sku_unique && actual.quantity === row.quantity && !actual.removed && !actual.consumed), '追加规格回执不匹配');
  }
  return value;
}
export function parseOrdinaryCashierReceipt(value: unknown, pending: OrdinaryCashierPending): OrdinaryCashierReceipt {
  assert(isOrdinaryCashierPending(pending), '原普通收银内容无效');
  assert(customerWorkRecord(value) && exact(value, ['version', 'actor_uid', 'request_key', 'request_hash', 'scope_key', 'kind', 'intent', 'evidence'])
    && value.version === 'customer-cashier-ordinary-receipt-v1' && value.actor_uid === pending.actor_uid && value.request_key === pending.request_key
    && (value.kind === pending.kind || value.kind === 'abandon') && value.request_hash === pending.request_hash && value.scope_key === pending.body.scope_key
    && customerWorkCanonicalJson(value.intent) === customerWorkCanonicalJson(pending.body) && customerWorkRecord(value.evidence), '原收银回执身份、编号或完整内容不匹配');
  const evidence = value.evidence;
  if (value.kind === 'abandon') {
    assert(exact(evidence, ['outcome', 'original_kind']) && evidence.outcome === 'operation-abandoned'
      && evidence.original_kind === pending.kind, '原永久放弃回执不匹配');
  } else if (['draft', 'append', 'quantity', 'remove'].includes(pending.kind)) {
    const outcomes = { draft: 'draft-created', append: 'rows-appended', quantity: 'quantity-changed', remove: 'rows-removed' };
    assert(exact(evidence, ['outcome', 'draft']) && evidence.outcome === outcomes[pending.kind as keyof typeof outcomes], '原购物操作结果不匹配');
    verifyDraftEvidence(evidence.draft, pending);
  } else if (pending.kind === 'creation') {
    const body = pending.body as OrdinaryCashierIntent, order = evidence.order;
    assert(exact(evidence, ['outcome', 'order', 'origin_hash', 'quote_fingerprint']) && evidence.outcome === 'order-created'
      && cashierHash(evidence.origin_hash) && cashierHash(evidence.quote_fingerprint) && customerWorkRecord(order)
      && exact(order, ['order_id', 'order_no', 'buyer_uid', 'creator_uid', 'pay_price', 'paid', 'pay_type', 'shipping_type', 'store_id', 'total_num'])
      && cashierId(order.order_id) && orderNo(order.order_no) && order.buyer_uid === body.buyer_uid && order.creator_uid === pending.actor_uid
      && ordinaryCashierMoney(order.pay_price) && order.pay_price === pending.quote!.amount && evidence.quote_fingerprint === pending.quote!.quote_fingerprint
      && order.paid === 0 && order.pay_type === '' && order.shipping_type === body.shipping_type
      && order.store_id === body.store_id && cashierId(order.total_num)
      && order.total_num === pending.quote!.quantity, '实际创建订单、购买人或配送内容不匹配');
  } else {
    const body = pending.body as OrdinaryCashierPaymentInput, source = pending.source!, payment = evidence.payment;
    assert(exact(evidence, ['outcome', 'payment']) && evidence.outcome === (body.expected_amount === '0.00' ? 'zero-paid' : 'cash-paid')
      && customerWorkRecord(payment) && exact(payment, ['order_id', 'order_no', 'buyer_uid', 'creator_uid', 'payer_uid', 'paid', 'pay_type', 'pay_time', 'amount', 'origin_hash', 'status_id', 'outbox'])
      && payment.order_id === body.order_id && payment.order_no === body.order_no && payment.buyer_uid === source.buyer_uid
      && payment.creator_uid === source.creator_uid && payment.payer_uid === pending.actor_uid && payment.paid === 1 && payment.pay_type === 'cash'
      && cashierId(payment.pay_time) && payment.amount === body.expected_amount && payment.origin_hash === source.origin_hash
      && cashierId(payment.status_id) && customerWorkRecord(payment.outbox) && exact(payment.outbox, ['id', 'event_key', 'event_type', 'payload_hash'])
      && cashierId(payment.outbox.id) && payment.outbox.event_key === `order.paid:${body.order_id}` && payment.outbox.event_type === 'order.paid'
      && cashierHash(payment.outbox.payload_hash), '真实付款、原订单来源或入账事件不匹配');
  }
  return JSON.parse(customerWorkCanonicalJson(value));
}
export function parseOrdinaryCashierOperation(value: unknown, pending: OrdinaryCashierPending): OrdinaryCashierReceipt | null {
  assert(customerWorkRecord(value) && exact(value, ['version', 'actor_uid', 'request_key', 'receipt'])
    && value.version === 'customer-cashier-ordinary-receipt-v1' && value.actor_uid === pending.actor_uid && value.request_key === pending.request_key,
  '查询结果不是原经营账号的原请求');
  return value.receipt === null ? null : parseOrdinaryCashierReceipt(value.receipt, pending);
}
export function parseOrdinaryCashierResult(value: unknown, pending: OrdinaryCashierPending): OrdinaryCashierReceipt {
  assert(customerWorkRecord(value) && exact(value, ['version', 'actor_uid', 'request_key', 'request_hash', 'kind', 'replayed', 'receipt'])
    && value.version === 'customer-cashier-ordinary-result-v1' && value.actor_uid === pending.actor_uid && value.request_key === pending.request_key
    && value.request_hash === pending.request_hash && (value.kind === pending.kind || value.kind === 'abandon')
    && typeof value.replayed === 'boolean', '普通收银提交结果尚未核对');
  return parseOrdinaryCashierReceipt(value.receipt, pending);
}
/** A missing GET receipt is still UNKNOWN; only a verified non-null receipt
 * permits closing the durable original request. */
export function releaseOrdinaryCashierPending(pending: OrdinaryCashierPending, receipt: unknown) {
  parseOrdinaryCashierReceipt(receipt, pending);
  const saved = ordinaryCashierPending(), original = saved.find(row => row.actor_uid === pending.actor_uid && row.request_key === pending.request_key);
  assert(original && customerWorkCanonicalJson(original) === customerWorkCanonicalJson(pending), '本机原内容已变化，请继续核对');
  const next = saved.filter(row => row !== original);
  uni.setStorageSync(ORDINARY_CASHIER_PENDING_STORAGE, next);
  assert(customerWorkCanonicalJson(ordinaryCashierPending()) === customerWorkCanonicalJson(next), '关闭原收银记录未确认');
}
export function parseOrdinaryCashierRead<T>(value: unknown, actorUid: number,
  authority: { scope_key: string; principal: { service_id: number } }, guard: (data: unknown) => data is T): OrdinaryCashierRead<T> {
  assert(customerWorkRecord(value) && exact(value, ['version', 'actor_uid', 'principal', 'scope_key', 'consistency_key', 'data'])
    && value.version === 'customer-cashier-ordinary-read-v1' && value.actor_uid === actorUid && cashierId(actorUid)
    && customerWorkRecord(value.principal) && exact(value.principal, ['kind', 'service_id', 'scope'])
    && value.principal.kind === 'customer-order-manager' && value.principal.scope === 'global'
    && cashierId(value.principal.service_id) && value.principal.service_id === authority.principal.service_id
    && cashierHash(value.scope_key) && value.scope_key === authority.scope_key && cashierHash(value.consistency_key)
    && guard(value.data) && value.consistency_key === ordinaryCashierDigest({ scope_key: value.scope_key, data: value.data }),
  '普通收银读取内容与原经营身份或响应摘要不匹配');
  return JSON.parse(customerWorkCanonicalJson(value));
}
