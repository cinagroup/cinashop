import type { OrderWriteoffNoticeOutboxPayload } from '@/models/schema/order_outbox';
import { WRITEOFF_NOTICE_EVENT } from '@/migrations/writeoffNotice';

export const WRITEOFF_NOTICE_MARK = 'reminder_verification_status';
export const MAX_WRITEOFF_NOTICE_RECORDS = 500;
const MAX_TITLE = MAX_WRITEOFF_NOTICE_RECORDS * 11 - 1;
const integer = (n: unknown, zero = false): n is number => typeof n === 'number'
  && Number.isSafeInteger(n) && n >= (zero ? 0 : 1) && n <= 2147483647;
function string(value: unknown, max: number, empty = true): value is string {
  return typeof value === 'string' && (empty || value.length > 0) && value.length <= max * 2
    && Array.from(value).length <= max && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}
function object(raw: unknown, keys: string[]) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw Error('核销通知字段无效');
  const ds = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(raw).length !== keys.length || keys.some(k => !ds[k]?.enumerable || !('value' in ds[k]))) throw Error('核销通知字段无效');
  return Object.fromEntries(keys.map(k => [k, ds[k].value]));
}
export function captureWriteoffRecordIds(raw: unknown): number[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || !raw.length || raw.length > MAX_WRITEOFF_NOTICE_RECORDS
    || Reflect.ownKeys(raw).length !== raw.length + 1) throw Error('核销通知批次记录无效');
  const values = Array.from({ length: raw.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(raw, String(i));
    if (!d?.enumerable || !('value' in d) || !integer(d.value)) throw Error('核销通知批次记录无效');
    return d.value as number;
  });
  if (values.some((v, i) => i > 0 && v <= values[i - 1])) throw Error('核销通知批次记录必须唯一且有序');
  return values;
}
export function writeoffNoticeEventKey(firstRecordId: number): string {
  if (!integer(firstRecordId)) throw Error('核销通知批次标识无效');
  return `${WRITEOFF_NOTICE_EVENT}:${firstRecordId}`;
}
export function captureWriteoffNoticePayload(raw: unknown): OrderWriteoffNoticeOutboxPayload {
  const r = object(raw, ['format', 'orderId', 'orderNo', 'userId', 'occurredAt', 'recordIds', 'recordsDigest', 'selection', 'phone', 'storeName']);
  const recordIds = captureWriteoffRecordIds(r.recordIds);
  if (r.format !== 1 || !integer(r.orderId) || !integer(r.userId, true) || !integer(r.occurredAt)
    || !string(r.orderNo, 32, false) || !string(r.phone, 32) || r.phone !== r.phone.trim()
    || !string(r.storeName, MAX_TITLE) || r.selection !== 'explicit' && r.selection !== 'all'
    || r.selection === 'all' && r.storeName !== '' || typeof r.recordsDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(r.recordsDigest))
    throw Error('核销通知来源无效');
  return { format: 1, orderId: r.orderId, orderNo: r.orderNo, userId: r.userId, occurredAt: r.occurredAt,
    recordIds, recordsDigest: r.recordsDigest, selection: r.selection as 'explicit' | 'all', phone: r.phone, storeName: r.storeName };
}
export function writeoffNoticeValues(payload: OrderWriteoffNoticeOutboxPayload): Record<string, string> {
  return { store_name: payload.storeName,
    write_time: new Date((payload.occurredAt + 8 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ') };
}
/** Only this existing SQL-authored event may carry the larger bounded batch
 * title. All other SMS/WeChat parameter contracts retain their original cap. */
export function assertWriteoffSmsPayload(raw: unknown): void {
  const payload = object(raw, ['kind', 'params']), params = object(payload.params, ['store_name', 'write_time']);
  if (payload.kind !== 'sms' || !string(params.store_name, MAX_TITLE) || !string(params.write_time, 16, false)
    || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u.test(params.write_time)) throw Error('核销短信变量无效');
}
