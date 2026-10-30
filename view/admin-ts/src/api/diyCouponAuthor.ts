/** Anonymous, read-only coupon author preview. No Admin request client, actor
 * credentials, claim controller, journal, fixture mode or navigation is loaded. */
export interface CouponPreview {
  id: number;
  /** Legacy public scope0general/1category/2product/3brand. */
  type: number;
  /** Legacy public discount1cash/2percentage; not the target DB column meaning. */
  coupon_type: number;
  coupon_title: string;
  coupon_price: string;
  use_min_price: string;
  is_use: boolean | 2;
  remain_count: number;
  receive_limit: number;
}

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const integer = (value: unknown, minimum = 0, maximum = 2147483647): value is number => Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
function checkedLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw Error('优惠券预览数量必须为1至10的整数');
}
function money(value: unknown): string {
  if (!(typeof value === 'number' || typeof value === 'string') || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/u.test(String(value))) throw Error('优惠券金额格式错误');
  const [whole, fraction = ''] = String(value).split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

/** Match checkedCommerceCoupons with the fixed guest owner0. Validate the full
 * list/count envelope first; duplicates and invalid rows are never filtered out. */
export function checkedDiyCouponPublicRows(raw: unknown, limit: number): CouponPreview[] {
  checkedLimit(limit);
  const data = record(raw);
  if (!data || !Array.isArray(data.count) || data.count.length !== 4 || Array.from(data.count).some(value => !integer(value))
    || !Array.isArray(data.list) || data.list.length > limit) throw Error('优惠券预览列表或数量格式错误');
  const ids = new Set<number>();
  return Array.from(data.list, value => {
    const row = record(value);
    if (!row || !integer(row.id, 1) || ids.has(row.id) || !integer(row.type, 0, 3) || !integer(row.coupon_type, 1, 2)
      || typeof row.coupon_title !== 'string' || row.coupon_title.length > 1024 || /[\u0000-\u001f\u007f]/u.test(row.coupon_title)
      || !integer(row.remain_count) || !integer(row.receive_limit) || ![true, false, 2].includes(row.is_use as boolean | number)) throw Error('优惠券预览包含格式错误或重复的记录');
    // Public uid0 can never own a claimed coupon, regardless of a forged used.uid.
    if (row.is_use === true) throw Error('游客优惠券预览不能采用已领取的账号资料');
    const coupon_price = money(row.coupon_price), use_min_price = money(row.use_min_price);
    ids.add(row.id);
    return { id: row.id, type: row.type, coupon_type: row.coupon_type, coupon_title: row.coupon_title,
      coupon_price, use_min_price, is_use: row.is_use as false | 2, remain_count: row.remain_count, receive_limit: row.receive_limit };
  });
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('优惠券预览读取已取消'); error.name = 'AbortError'; throw error;
}

/** The current public coupon bound is10; the fixed PHP app.js/LIMIT is absent.
 * The caller projects the raw author quantity before this strict I/O boundary. */
export async function apiDiyCouponPreview(limit: number, signal?: AbortSignal): Promise<CouponPreview[]> {
  checkedLimit(limit); abortIfNeeded(signal);
  const response = await fetch(`/api/v2/coupons?page=1&limit=${limit}`, {
    method: 'GET', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' }, signal,
  });
  abortIfNeeded(signal);
  const body = record(await response.json());
  abortIfNeeded(signal);
  if (!body || !Number.isSafeInteger(body.status) || typeof body.msg !== 'string' || !Object.hasOwn(body, 'data')) throw Error('优惠券预览响应格式错误');
  if (!response.ok || response.status < 200 || response.status >= 300 || body.status !== 200) throw Error(body.msg || `优惠券预览读取失败（${response.status}）`);
  return checkedDiyCouponPublicRows(body.data, limit);
}
