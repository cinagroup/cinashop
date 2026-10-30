/** Anonymous integral-activity author preview. No Admin request client,
 * credentials, product selection, cart/exchange controller or fixture mode. */
export interface PointsPreview {
  /** Integral activity identity; never substitute the base productId. */
  id: number;
  productId: number;
  title: string;
  image: string;
  price: string;
  oldPrice: string;
  people: number;
  count: number;
  stock: number;
  percent: number;
  integral: number;
  status: number;
}
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const integer = (value: unknown, minimum = 0, maximum = 2147483647): value is number => Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
function checkedLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw Error('积分商品预览数量必须为1至10的整数');
}
function text(value: unknown, maximum = 1024): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw Error('积分商品文字格式错误');
  return value;
}
function money(value: unknown): string {
  if (!(typeof value === 'number' || typeof value === 'string') || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/u.test(String(value))) throw Error('积分商品金额格式错误');
  const [whole, fraction = ''] = String(value).split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}
/** Same URL projection as the installed Uni safeDiyImageUrl on H5. Business
 * images arrive from their own public API and never become authored slots. */
function publicImage(value: string): string {
  const url = value.trim();
  if (!url || url.length > 4096 || /[\u0000-\u001f\u007f]/u.test(url)) return '';
  if (/^https:\/\//iu.test(url)) return url;
  if (/^http:\/\//iu.test(url)) return `https://${url.slice(7)}`;
  if (/^\/(?!\/)/u.test(url)) return url;
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/iu.test(url) && url.length <= 262144) return url;
  return '';
}
/** Match checkedCommerceCards('pointsMall'): validate every direct-array row,
 * including duplicate/invalid tails, then return its exact normalized shape. */
export function checkedDiyPointsPublicRows(raw: unknown, limit: number): PointsPreview[] {
  checkedLimit(limit);
  if (!Array.isArray(raw) || raw.length > limit) throw Error('积分商品预览列表格式错误');
  const ids = new Set<number>();
  return Array.from(raw, value => {
    const row = record(value);
    if (!row || !integer(row.id, 1) || ids.has(row.id) || !integer(row.product_id, 1) || !integer(row.stock) || !integer(row.integral)) throw Error('积分商品预览包含格式错误或重复的记录');
    const title = text(row.title), image = publicImage(text(row.image, 8192)), price = money(row.price);
    ids.add(row.id);
    return { id: row.id, productId: row.product_id, title, image, price, oldPrice: '0.00', people: 0, count: 0, stock: row.stock, percent: 0, integral: row.integral, status: 0 };
  });
}
function abortIfNeeded(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('积分商品预览读取已取消'); error.name = 'AbortError'; throw error;
}
/** The current TS public limit is10; fixed PHP config/app.js/LIMIT is absent.
 * The caller projects quantity before this strict closed GET boundary. */
export async function apiDiyPointsPreview(limit: number, signal?: AbortSignal): Promise<PointsPreview[]> {
  checkedLimit(limit); abortIfNeeded(signal);
  const response = await fetch(`/api/store_integral/list?page=1&limit=${limit}`, {
    method: 'GET', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' }, signal,
  });
  abortIfNeeded(signal);
  const body = record(await response.json());
  abortIfNeeded(signal);
  if (!body || !Number.isSafeInteger(body.status) || typeof body.msg !== 'string' || !Object.hasOwn(body, 'data')) throw Error('积分商品预览响应格式错误');
  if (!response.ok || response.status < 200 || response.status >= 300 || body.status !== 200) throw Error(body.msg || `积分商品预览读取失败（${response.status}）`);
  return checkedDiyPointsPublicRows(body.data, limit);
}
