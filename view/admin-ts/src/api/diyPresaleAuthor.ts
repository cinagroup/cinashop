/** Anonymous presale-product author preview. No Admin request client,
 * credentials, product selection, cart/exchange controller or fixture mode. */
export interface PresalePreview {
  /** The presale product identity; normalized productId is this same id. */
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
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw Error('预售商品预览数量必须为1至10的整数');
}
function text(value: unknown, maximum = 1024): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw Error('预售商品文字格式错误');
  return value;
}
function money(value: unknown): string {
  if (!(typeof value === 'number' || typeof value === 'string') || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/u.test(String(value))) throw Error('预售商品金额格式错误');
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
/** Match checkedCommerceCards('presale'): validate the complete list/count envelope,
 * including duplicate/invalid tails, then return its exact normalized shape. */
export function checkedDiyPresalePublicRows(raw: unknown, limit: number): PresalePreview[] {
  checkedLimit(limit);
  const data = record(raw);
  if (!data || !integer(data.count) || !Array.isArray(data.list) || data.list.length > limit) throw Error('预售商品预览列表或数量格式错误');
  const ids = new Set<number>();
  return Array.from(data.list, value => {
    const row = record(value);
    if (!row || !integer(row.id, 1) || ids.has(row.id) || !integer(row.stock) || !integer(row.sales) || !integer(row.presale_pay_status, 0, 3)) throw Error('预售商品预览包含格式错误或重复的记录');
    const title = text(row.store_name), image = publicImage(text(row.image, 8192)), price = money(row.price), oldPrice = money(row.ot_price);
    ids.add(row.id);
    return { id: row.id, productId: row.id, title, image, price, oldPrice, people: 0, count: row.sales, stock: row.stock, percent: 0, integral: 0, status: row.presale_pay_status };
  });
}
function abortIfNeeded(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('预售商品预览读取已取消'); error.name = 'AbortError'; throw error;
}
/** The current TS public limit is10; fixed PHP config/app.js/LIMIT is absent.
 * The caller projects quantity before this strict closed GET boundary. */
export async function apiDiyPresalePreview(limit: number, signal?: AbortSignal): Promise<PresalePreview[]> {
  checkedLimit(limit); abortIfNeeded(signal);
  const response = await fetch(`/api/presale/list?page=1&limit=${limit}&time_type=0`, {
    method: 'GET', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' }, signal,
  });
  abortIfNeeded(signal);
  const body = record(await response.json());
  abortIfNeeded(signal);
  if (!body || !Number.isSafeInteger(body.status) || typeof body.msg !== 'string' || !Object.hasOwn(body, 'data')) throw Error('预售商品预览响应格式错误');
  if (!response.ok || response.status < 200 || response.status >= 300 || body.status !== 200) throw Error(body.msg || `预售商品预览读取失败（${response.status}）`);
  return checkedDiyPresalePublicRows(body.data, limit);
}
