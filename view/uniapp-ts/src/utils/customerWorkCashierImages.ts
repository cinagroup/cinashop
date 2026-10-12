import { API_BASE } from '@/utils/request';
import { customerWorkRecord } from './customerWork';
import { cashierHash, cashierId, cashierUuid, cashierIntentHash, customerWorkCanonicalJson } from './customerWorkCashier';
import { customerCashierOrderNo } from './customerWorkCashierRead';
import { isCustomerCashierSystemForm } from './customerWorkCashierCatalog';
import type { SystemFormComponent } from '@/types/systemForm';
import type { CustomerCashierFormContext, CustomerCashierImageMetadata, CustomerCashierSessionIntent,
  CustomerCashierImageIntent, CustomerCashierImageStageIntent, CustomerCashierSessionReceipt,
  CustomerCashierImageReceipt, CustomerCashierFormPreviews, CustomerCashierFormSession } from '@/types/customerWorkCashierImages';

export const CUSTOMER_CASHIER_IMAGE_STORAGE = 'customer_cashier_image_pending_v1';
export const MAX_CASHIER_IMAGE_BYTES = 10 * 1024 * 1024;
const digest = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(v);
const timestamp = (v: unknown): v is string => typeof v === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(v) && Number.isFinite(Date.parse(v));
const text = (v: unknown, max: number, empty = false): v is string => typeof v === 'string' && v.length <= max
  && (empty || v.length > 0) && v.trim() === v && !/[\u0000-\u001f\u007f]/u.test(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).sort().join('|') === [...keys].sort().join('|');
function assert(v: unknown, message: string): asserts v { if (!v) throw Error(message); }
export function customerCashierImageId(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const match = /^\/api\/assets\/([1-9]\d{0,9})$/u.exec(v);
  return match && cashierId(Number(match[1])) ? Number(match[1]) : null;
}
export function customerCashierImageFieldId(component: SystemFormComponent, index: number): string {
  assert(component.name === 'uploadPicture' && Number.isSafeInteger(index) && index >= 0 && index < 100, '图片表单字段无效');
  const id = typeof component.id === 'number' || typeof component.id === 'string' ? `id:${JSON.stringify(component.id)}` : `index:${index}`;
  assert(text(id, 255), '图片表单字段编号过长或无效');
  return id;
}
export function isCustomerCashierFormContext(v: unknown): v is CustomerCashierFormContext {
  return customerWorkRecord(v) && exact(v, ['version','scope_key','buyer_uid','tourist_key','product_id','sku_unique','quantity'])
    && v.version === 'customer-cashier-form-session-v1' && cashierHash(v.scope_key) && cashierId(v.buyer_uid, true)
    && text(v.tourist_key, 50, true) && (v.buyer_uid === 0 ? /^[A-Za-z0-9_-]{1,50}$/u.test(v.tourist_key) : v.tourist_key === '')
    && cashierId(v.product_id) && text(v.sku_unique, 16) && cashierId(v.quantity) && v.quantity <= 32767;
}
export function isCustomerCashierImageMetadata(v: unknown): v is CustomerCashierImageMetadata {
  return customerWorkRecord(v) && exact(v, ['version','scope_key','session_key','field_id','sha256','size'])
    && v.version === 'customer-cashier-form-image-v1' && cashierHash(v.scope_key) && cashierUuid(v.session_key)
    && text(v.field_id, 255) && cashierHash(v.sha256) && cashierId(v.size) && v.size <= MAX_CASHIER_IMAGE_BYTES;
}
export function isCustomerCashierImageStage(v: unknown): v is CustomerCashierImageStageIntent {
  if (!customerWorkRecord(v) || !exact(v, ['version','kind','actor_uid','service_id','request_key','request_hash','created_at','body'])
    || v.version !== 'customer-cashier-image-pending-v1' || !cashierId(v.actor_uid) || !cashierId(v.service_id)
    || !cashierUuid(v.request_key) || !cashierHash(v.request_hash) || !cashierId(v.created_at)) return false;
  return (v.kind === 'session' ? isCustomerCashierFormContext(v.body) : v.kind === 'image' && isCustomerCashierImageMetadata(v.body))
    && cashierIntentHash(v.body) === v.request_hash;
}
export function customerCashierImagePending(): CustomerCashierImageStageIntent[] {
  const value: unknown = uni.getStorageSync(CUSTOMER_CASHIER_IMAGE_STORAGE);
  if (value === '' || value === undefined || value === null) return [];
  assert(Array.isArray(value) && value.length <= 100 && value.every(isCustomerCashierImageStage)
    && new Set(value.map(v => v.request_key)).size === value.length, '本机原图片请求损坏，请保留原编号核对');
  return JSON.parse(customerWorkCanonicalJson(value));
}
export function retainCustomerCashierImageStage(intent: CustomerCashierImageStageIntent): void {
  assert(isCustomerCashierImageStage(intent), '原图片请求内容无效，尚未提交');
  const rows = customerCashierImagePending(), existing = rows.find(v => v.request_key === intent.request_key);
  if (existing) { assert(customerWorkCanonicalJson(existing) === customerWorkCanonicalJson(intent), '原图片编号不能绑定其他内容'); return; }
  assert(rows.length < 100, '本机原图片请求已满，请先核对或取消原准备');
  rows.push(JSON.parse(customerWorkCanonicalJson(intent))); uni.setStorageSync(CUSTOMER_CASHIER_IMAGE_STORAGE, rows);
  assert(customerWorkCanonicalJson(customerCashierImagePending()) === customerWorkCanonicalJson(rows), '原图片内容无法持久保存，尚未提交');
}
/** Coordinator calls this only after a cancelled/consumed session is verified. */
export function releaseCustomerCashierImageStages(keys: string[]): void {
  assert(keys.every(cashierUuid), '原图片编号无效');
  const rows = customerCashierImagePending().filter(v => !keys.includes(v.request_key));
  uni.setStorageSync(CUSTOMER_CASHIER_IMAGE_STORAGE, rows);
  assert(customerWorkCanonicalJson(customerCashierImagePending()) === customerWorkCanonicalJson(rows), '本机原图片请求关闭失败');
}
export function parseCustomerCashierSessionReceipt(v: unknown, intent: CustomerCashierSessionIntent): CustomerCashierSessionReceipt {
  assert(customerWorkRecord(v) && exact(v, ['version','actor_uid','request_key','receipt'])
    && v.version === 'customer-cashier-form-session-v1' && v.actor_uid === intent.actor_uid && v.request_key === intent.request_key, '原图片准备回执不匹配');
  if (v.receipt === null) return v as unknown as CustomerCashierSessionReceipt;
  const r = v.receipt;
  assert(customerWorkRecord(r) && exact(r, ['actor_uid','service_id','scope_key','request_key','request_hash','intent','system_form','scope_digest','state','created_at','cancelled_at','frozen_request_hash','order_id','order_no'])
    && r.actor_uid === intent.actor_uid && r.service_id === intent.service_id && r.scope_key === intent.body.scope_key
    && r.request_key === intent.request_key && r.request_hash === intent.request_hash
    && customerWorkCanonicalJson(r.intent) === customerWorkCanonicalJson(intent.body)
    && isCustomerCashierSystemForm(r.system_form) && digest(r.scope_digest) && timestamp(r.created_at), '图片准备归属或原内容无法核对');
  assert(['active','cancelled','frozen','consumed'].includes(String(r.state)), '图片准备状态无效');
  assert(r.state === 'cancelled' ? timestamp(r.cancelled_at) : r.cancelled_at === null, '原取消结果无效');
  assert(['frozen','consumed'].includes(String(r.state)) ? cashierHash(r.frozen_request_hash) : r.frozen_request_hash === null, '原创建冻结证据无效');
  assert(r.state === 'consumed' ? cashierId(r.order_id) && customerCashierOrderNo(r.order_no) : r.order_id === null && r.order_no === null, '原图片消费订单无效');
  return JSON.parse(customerWorkCanonicalJson(v));
}
export function parseCustomerCashierImageReceipt(v: unknown, intent: CustomerCashierImageIntent, session?: CustomerCashierFormSession): CustomerCashierImageReceipt {
  assert(customerWorkRecord(v) && exact(v, ['version','actor_uid','request_key','receipt'])
    && v.version === 'customer-cashier-form-image-v1' && v.actor_uid === intent.actor_uid && v.request_key === intent.request_key, '原图片上传回执不匹配');
  if (v.receipt === null) return v as unknown as CustomerCashierImageReceipt;
  const r = v.receipt;
  assert(customerWorkRecord(r) && exact(r, ['actor_uid','service_id','session_key','request_key','request_hash','intent','field_id','sha256','size','mime','scope_digest','state','attachment_id','reference','created_at','stored_at'])
    && r.actor_uid === intent.actor_uid && r.service_id === intent.service_id && r.session_key === intent.body.session_key
    && r.request_key === intent.request_key && r.request_hash === intent.request_hash
    && customerWorkCanonicalJson(r.intent) === customerWorkCanonicalJson(intent.body)
    && r.field_id === intent.body.field_id && r.sha256 === intent.body.sha256 && r.size === intent.body.size
    && ['image/jpeg','image/png','image/webp','image/gif'].includes(String(r.mime)) && digest(r.scope_digest) && timestamp(r.created_at), '图片回执内容或归属无法核对');
  if (session) assert(session.request_key === r.session_key && session.scope_digest === r.scope_digest, '图片属于另一份收银准备');
  assert(r.state === 'stored' ? cashierId(r.attachment_id) && customerCashierImageId(r.reference) === r.attachment_id && timestamp(r.stored_at)
    : r.state === 'reserved' && r.attachment_id === null && r.reference === null && r.stored_at === null, '图片原保存事实无效');
  return JSON.parse(customerWorkCanonicalJson(v));
}
export function parseCustomerCashierPreviews(v: unknown, actor: number, session: string, references: string[]): Record<string, string> {
  assert(references.length > 0 && references.length <= 900 && references.every(v => customerCashierImageId(v)) && new Set(references).size === references.length, '原图片引用列表无效');
  assert(customerWorkRecord(v) && exact(v, ['version','actor_uid','session_key','previews'])
    && v.version === 'customer-cashier-form-preview-v1' && v.actor_uid === actor && v.session_key === session
    && Array.isArray(v.previews) && v.previews.length === references.length, '原图片预览范围无法核对');
  return Object.fromEntries(v.previews.map((item, index) => {
    assert(customerWorkRecord(item) && exact(item, ['reference','url']) && item.reference === references[index] && typeof item.url === 'string', '原图片预览引用不匹配');
    const match = /^\/api\/assets\/([1-9]\d{0,9})\?expires=(\d{1,12})&signature=([A-Za-z0-9_-]{43})$/u.exec(item.url);
    assert(match && Number(match[1]) === customerCashierImageId(item.reference) && Number.isSafeInteger(Number(match[2]))
      && Number(match[2]) * 1000 > Date.now(), '原图片预览链接无效或已过期');
    return [item.reference, `${API_BASE}${item.url}`];
  }));
}
