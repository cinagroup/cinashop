/** Public immutable facts of the ordinary merchandise payment notice. No
 * account, payer, credential or mutable product lookup is notification authority. */
export interface PaidNoticeBusiness {
  format: 1;
  paymentEventId: number;
  paymentOrderId: number;
  paymentOrderNo: string;
  paymentAdmissionNonce: string;
  orderId: number;
  orderNo: string;
  userId: number;
  payPrice: string;
  totalNum: number;
  phone: string;
  storeName: string;
  sendName: string;
  payTime: number;
  occurredAt: number;
}
export interface PaidNoticeAdmission { format: 1; nonce: string }
export interface OrderPaidSourcePayload { orderId: number; orderNo: string; payNoticeAdmission?: PaidNoticeAdmission }
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const integer = (v: unknown, zero = false): v is number => Number.isSafeInteger(v) && Number(v) >= (zero ? 0 : 1) && Number(v) <= 2147483647;
function object(v: unknown, keys: string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(v)) || Reflect.ownKeys(v).length !== keys.length) throw Error('付款通知字段无效');
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (!d?.enumerable || !('value' in d)) throw Error('付款通知字段无效');
    out[key] = d.value;
  }
  return out;
}
function text(v: unknown, max: number, required = false): v is string {
  if (typeof v !== 'string' || v.length > 2 * max || required && !v) return false;
  let n = 0; for (const c of v) { const p = c.codePointAt(0)!; if (++n > max || p >= 0xd800 && p <= 0xdfff) return false; }
  return true;
}
export function capturePaidNoticeAdmission(value: unknown): PaidNoticeAdmission {
  const r = object(value, ['format', 'nonce']);
  if (r.format !== 1 || !uuid(r.nonce)) throw Error('付款通知准入无效');
  return { format: 1, nonce: r.nonce };
}
/** Both historical two-field and explicitly admitted three-field payments stay
 * closed. Callers retain the original complete payload in their source hash. */
export function captureOrderPaidSourcePayload(value: unknown): OrderPaidSourcePayload {
  const admitted = Boolean(value && typeof value === 'object' && Object.hasOwn(value, 'payNoticeAdmission'));
  const r = object(value, admitted ? ['orderId','orderNo','payNoticeAdmission'] : ['orderId','orderNo']);
  if (!integer(r.orderId) || !text(r.orderNo, 50, true)) throw Error('支付事件来源无效');
  return { orderId: r.orderId, orderNo: r.orderNo, ...(admitted ? { payNoticeAdmission: capturePaidNoticeAdmission(r.payNoticeAdmission) } : {}) };
}
export function isOrderPaidSourcePayload(value: unknown): value is OrderPaidSourcePayload {
  try { captureOrderPaidSourcePayload(value); return true; } catch { return false; }
}
export function capturePaidNoticeBusiness(value: unknown): PaidNoticeBusiness {
  const r = object(value, ['format', 'paymentEventId', 'paymentOrderId', 'paymentOrderNo', 'paymentAdmissionNonce',
    'orderId', 'orderNo', 'userId', 'payPrice', 'totalNum', 'phone', 'storeName', 'sendName', 'payTime', 'occurredAt']);
  if (r.format !== 1 || !integer(r.paymentEventId) || !integer(r.paymentOrderId) || !integer(r.orderId)
    || !integer(r.userId, true) || !integer(r.totalNum) || !integer(r.payTime) || !integer(r.occurredAt)
    || !text(r.paymentOrderNo, 50, true) || !text(r.orderNo, 50, true) || !uuid(r.paymentAdmissionNonce)
    || typeof r.payPrice !== 'string' || !/^(?:0|[1-9]\d{0,9})\.\d{2}$/u.test(r.payPrice)
    || !text(r.phone, 32) || r.phone.trim() !== r.phone || !text(r.storeName, 20) || !text(r.sendName, 32)) throw Error('付款通知事实无效');
  return r as unknown as PaidNoticeBusiness;
}
export function paidNoticeEventKey(orderId: number): string {
  if (!integer(orderId)) throw Error('付款通知订单无效');
  return `order.pay.success.notice:${orderId}`;
}
export function paidNoticeMinute(seconds: number): string {
  if (!integer(seconds)) throw Error('付款通知时间无效');
  return new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ');
}
export function paidNoticeDate(seconds: number): string {
  if (!integer(seconds)) throw Error('付款通知时间无效');
  return new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 19).replace('T', ' ');
}
export function paidNoticeBusinessFromPayload(value: unknown): PaidNoticeBusiness {
  if (!value || typeof value !== 'object') throw Error('付款通知字段无效');
  const keys = ['format', 'paymentEventId', 'paymentOrderId', 'paymentOrderNo', 'paymentAdmissionNonce',
    'orderId', 'orderNo', 'userId', 'payPrice', 'totalNum', 'phone', 'storeName', 'sendName', 'payTime', 'occurredAt'];
  const raw = object(value, Object.hasOwn(value, 'routineSubscriptionRequest') ? [...keys, 'routineSubscriptionRequest'] : keys);
  return capturePaidNoticeBusiness(Object.fromEntries(keys.map(key => [key, raw[key]])));
}
