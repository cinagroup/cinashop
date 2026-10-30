/** Isolated anonymous bargain-author reads. No Admin request client,
 * credentials, subscription SDK, product selection or purchase controller. */
export interface BargainProductPreview {
  /** Activity identity and its distinct underlying base-product identity. */
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
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw Error('砍价商品预览数量必须为1至10的整数');
}
function text(value: unknown, maximum = 1024): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw Error('砍价预览文字格式错误');
  return value;
}
function money(value: unknown): string {
  if (!(typeof value === 'number' || typeof value === 'string') || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/u.test(String(value))) throw Error('砍价商品金额格式错误');
  const [whole, fraction = ''] = String(value).split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}
/** Match the installed public safeDiyImageUrl H5 projection. These business
 * images/avatars remain transient data and never become authored media slots. */
function publicImage(value: string): string {
  const url = value.trim();
  if (!url || url.length > 4096 || /[\u0000-\u001f\u007f]/u.test(url)) return '';
  if (/^https:\/\//iu.test(url)) return url;
  if (/^http:\/\//iu.test(url)) return `https://${url.slice(7)}`;
  if (/^\/(?!\/)/u.test(url)) return url;
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/iu.test(url) && url.length <= 262144) return url;
  return '';
}
/** Exact normalized checkedCommerceCards('bargain') shape; validate every
 * direct-array row, never clip/filter/deduplicate an invalid response tail. */
export function checkedDiyBargainPublicRows(raw: unknown, limit: number): BargainProductPreview[] {
  checkedLimit(limit);
  if (!Array.isArray(raw) || raw.length > limit) throw Error('砍价商品预览列表格式错误');
  const ids = new Set<number>();
  return Array.from(raw, value => {
    const row = record(value);
    if (!row || !integer(row.id, 1) || ids.has(row.id) || !integer(row.product_id, 1) || !integer(row.people) || !integer(row.sales) || !integer(row.stock)) throw Error('砍价商品预览包含格式错误或重复的记录');
    const title = text(row.title), image = publicImage(text(row.image, 8192)), price = money(row.price), oldPrice = money(row.ot_price);
    ids.add(row.id);
    return { id: row.id, productId: row.product_id, title, image, price, oldPrice, people: row.people, count: row.sales, stock: row.stock, percent: 0, integral: 0, status: 0 };
  });
}
function abortIfNeeded(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('砍价预览读取已取消'); error.name = 'AbortError'; throw error;
}
async function publicData(path: string, signal?: AbortSignal): Promise<unknown> {
  abortIfNeeded(signal);
  const response = await fetch(path, { method: 'GET', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' }, signal });
  abortIfNeeded(signal);
  const body = record(await response.json());
  abortIfNeeded(signal);
  if (!body || !Number.isSafeInteger(body.status) || typeof body.msg !== 'string' || !Object.hasOwn(body, 'data')) throw Error('砍价预览响应格式错误');
  if (!response.ok || response.status < 200 || response.status >= 300 || body.status !== 200) throw Error(body.msg || `砍价预览读取失败（${response.status}）`);
  return body.data;
}
/** Existing anonymous list only; zero effective quantity is an Editor noop.
 * Validate every returned row before exposing transient preview data. */
export async function apiDiyBargainPreview(limit: number, signal?: AbortSignal): Promise<BargainProductPreview[]> {
 checkedLimit(limit);abortIfNeeded(signal);
 const products=checkedDiyBargainPublicRows(await publicData(`/api/bargain/list?page=1&limit=${limit}`,signal),limit);
 abortIfNeeded(signal);return products;
}
