import { customerWorkRecord } from './customerWork';
import { API_BASE } from './request';
import { isCustomerCashierSystemForm } from './customerWorkCashierCatalog';
import { prepareOrderSystemFormSubmission } from '../../../common/order-system-form';
import { customerWorkCanonicalJson } from '../../../common/customerWorkIntent';
import type { CustomerCashierRecord, CustomerCashierRecordList, CustomerCashierRecordDetail, CustomerCashierReadEnvelope, CustomerCashierRecordForm } from '@/types/customerWorkCashierRead';
const id = (value: unknown, minimum = 1): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= 2_147_483_647;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const money = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,9})\.\d{2}$/u.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
export const customerCashierOrderNo = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/u.test(value);
export const customerCashierCursor = (value: unknown): value is string => typeof value === 'string' && value.length <= 2048 && /^[A-Za-z0-9_-]+$/u.test(value);
const assetId = (value: unknown): number | null => {
  const match = typeof value === 'string' ? /^\/api\/assets\/([1-9]\d{0,9})$/u.exec(value) : null;
  return match && id(Number(match[1])) ? Number(match[1]) : null;
};
export function customerCashierFormReferences(form: CustomerCashierRecordForm): string[] {
  return [...new Set(form.components.flatMap(component => component.name === 'uploadPicture' && Array.isArray(component.value) ? component.value as string[] : []))];
}
export function isCustomerCashierRecordForm(value: unknown, creationKey: string): value is CustomerCashierRecordForm {
  if (!customerWorkRecord(value) || Object.keys(value).sort().join('|') !== 'components|previews|session_key|system_form_id'
    || value.session_key !== creationKey || !uuid(value.session_key) || !id(value.system_form_id) || !Array.isArray(value.components)
    || !isCustomerCashierSystemForm({ id: value.system_form_id, name: '', value: value.components }) || !Array.isArray(value.previews)) return false;
  try {
    const components = value.components;
    if (value.components.some(component => !customerWorkRecord(component) || component.value === undefined
      || 'assistedImageScope' in component || 'cashierImageScope' in component
      || component.name === 'uploadPicture' && (!Array.isArray(component.value) || !component.value.every(reference => assetId(reference))))) return false;
    const prepared = prepareOrderSystemFormSubmission(value.components, value.components, value.system_form_id);
    const normalized = JSON.parse(prepared.snapshotJson) as { id?: unknown; name: string; value: unknown }[];
    if (normalized.some((component, index) => customerWorkCanonicalJson(component.value) !== customerWorkCanonicalJson(components[index]?.value))) return false;
    const references = customerCashierFormReferences(value as unknown as CustomerCashierRecordForm);
    return value.previews.length === references.length && value.previews.every((preview, index) => {
      if (!customerWorkRecord(preview) || Object.keys(preview).sort().join('|') !== 'reference|url' || preview.reference !== references[index] || typeof preview.url !== 'string') return false;
      const match = /^\/api\/assets\/([1-9]\d{0,9})\?expires=(\d{1,12})&signature=([A-Za-z0-9_-]{43})$/u.exec(preview.url);
      return !!match && Number(match[1]) === assetId(preview.reference) && Number.isSafeInteger(Number(match[2])) && Number(match[2]) * 1000 > Date.now();
    });
  } catch { return false; }
}
export function customerCashierFormPreviewMap(form: CustomerCashierRecordForm): Record<string, string> {
  return Object.fromEntries(form.previews.map(preview => [preview.reference, `${API_BASE}${preview.url}`]));
}
/** Signed URLs expire; the immutable component answers and session identity must not change during renewal. */
export function customerCashierFormIdentity(form: CustomerCashierRecordForm): string {
  return customerWorkCanonicalJson({ session_key: form.session_key, system_form_id: form.system_form_id, components: form.components });
}
export function isCustomerCashierRecord(value: unknown): value is CustomerCashierRecord {
  return customerWorkRecord(value) && id(value.id) && customerCashierOrderNo(value.order_no)
    && id(value.buyer_uid, 0) && id(value.creator_uid) && text(value.real_name, 32) && text(value.user_phone, 20)
    && money(value.amount) && id(value.quantity) && [0, 1].includes(value.paid as number) && text(value.pay_type, 32)
    && id(value.pay_time, 0) && id(value.created_at, 0) && id(value.status, -2) && Number(value.status) <= 5
    && id(value.refund_status, 0) && typeof value.root_retired === 'boolean' && hash(value.origin_hash);
}
export function isCustomerCashierRecordList(value: unknown): value is CustomerCashierRecordList {
  if (!customerWorkRecord(value) || value.scope !== 'own-second-card-creations' || !id(value.limit) || value.limit > 50
    || !Array.isArray(value.list) || value.list.length > value.limit || !value.list.every(isCustomerCashierRecord)
    || typeof value.has_more !== 'boolean' || (value.has_more ? !customerCashierCursor(value.next_cursor) || value.list.length !== value.limit : value.next_cursor !== null)) return false;
  return new Set(value.list.map(row => row.id)).size === value.list.length
    && new Set(value.list.map(row => row.order_no)).size === value.list.length;
}
export function isCustomerCashierRecordDetail(value: unknown): value is CustomerCashierRecordDetail {
  if (!customerWorkRecord(value) || value.scope !== 'own-second-card-creations' || !isCustomerCashierRecord(value.record)
    || !customerWorkRecord(value.creation) || !uuid(value.creation.request_key) || !hash(value.creation.request_hash)
    || value.creation.origin_hash !== value.record.origin_hash || !id(value.creation.service_id)
    || typeof value.creation.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value.creation.created_at)
    || !Number.isFinite(Date.parse(value.creation.created_at)) || !Array.isArray(value.items) || value.items.length !== 1) return false;
  const item = value.items[0];
  if (!customerWorkRecord(item) || !id(item.product_id) || !text(item.sku_unique, 16) || !item.sku_unique || item.sku_unique.trim() !== item.sku_unique
    || !id(item.quantity) || item.quantity !== value.record.quantity || !id(item.write_times)
    || !text(item.name, 512) || !text(item.sku, 512)) return false;
  if (value.form !== undefined && value.form !== null && !isCustomerCashierRecordForm(value.form, value.creation.request_key)) return false;
  if (value.payment === null) return value.record.paid !== 1 || value.record.pay_type !== 'cash';
  const payment = value.payment;
  return customerWorkRecord(payment) && uuid(payment.request_key) && money(payment.amount)
    && ['zero', 'cash'].includes(payment.payment_kind as string) && (payment.payment_kind === 'zero') === (payment.amount === '0.00')
    && id(payment.paid_at, 0) && id(payment.outbox_id) && payment.origin_hash === value.record.origin_hash
    && value.record.paid === 1 && value.record.pay_type === 'cash' && payment.amount === value.record.amount && payment.paid_at === value.record.pay_time;
}
export function parseCustomerCashierReadEnvelope<T>(value: unknown, actorUid: number, guard: (data: unknown) => data is T,
  authority: { scope_key: string; principal: { service_id: number } }): CustomerCashierReadEnvelope<T> {
  if (!customerWorkRecord(value) || value.version !== 'customer-work-cashier-read-v1' || value.actor_uid !== actorUid
    || !customerWorkRecord(value.principal) || value.principal.kind !== 'customer-order-manager' || !id(value.principal.service_id)
    || value.principal.scope !== 'global' || !hash(value.scope_key) || !hash(value.consistency_key) || !guard(value.data)
    || value.scope_key !== authority.scope_key || value.principal.service_id !== authority.principal.service_id) throw Error('次卡收银记录或当前经营身份已变化，请重新读取');
  const data = value.data as unknown as CustomerCashierRecordList | CustomerCashierRecordDetail;
  const records = 'list' in data ? data.list : [data.record];
  if (records.some(row => row.creator_uid !== actorUid)) throw Error('次卡收银记录不属于当前创建人');
  return value as unknown as CustomerCashierReadEnvelope<T>;
}
export function customerCashierPaymentText(row: CustomerCashierRecord): string {
  return row.paid === 0 ? '未付款' : `已付款 · ${row.pay_type === 'cash' ? '现金' : row.pay_type || '历史渠道未知'}`;
}
