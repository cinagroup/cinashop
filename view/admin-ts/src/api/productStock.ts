import request, { AdminResponseError, getData } from '@/utils/request';
import { getAdminSession } from '@/utils/auth';

export interface AdminProductStockRow {
  id: number; product_id: number; unique: string; suk: string; stock: number; sum_stock: number;
  image: string; bar_code: string; code: string; type: number; is_retired: number;
  [key: string]: unknown;
}
export interface AdminProductStockAdjustment { unique: string; pm: 0 | 1; stock: number }
export interface AdminProductStockResult { stock: string | 0 }
const max = 2_147_483_647, markerKey = 'admin_stock_unconfirmed_v1';
type Marker = { owner: number; product: number; run: string };
const pending = new Set<string>();
const pendingKey = (current: number, product: number) => `${current}:${product}`;
async function withOutcomeLock<T>(current: number, product: number, action: () => Promise<T>): Promise<T> {
  // Keep the request fenced across tabs for the same inventory and owner.
  // Older browsers retain the per-tab pending guard and persistent marker.
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(`cinashop:product-stock-outcome:${current}:${product}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) throw Error('其他页面的库存请求尚未结束，请稍后重新读取库存');
      return action();
    });
  }
  return action();
}
async function mutateMarkers<T>(action: () => T): Promise<T> {
  // Only synchronous localStorage operations hold this short global lock;
  // independent requests never hold it while awaiting the network.
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request('cinashop:product-stock-markers', action);
  return action();
}
function id(value: number): void { if (!Number.isSafeInteger(value) || value < 1 || value > max) throw Error('商品ID格式错误'); }
function markers(): Marker[] {
  const value = localStorage.getItem(markerKey);
  if (!value) return [];
  let rows: unknown; try { rows = JSON.parse(value); } catch { throw Error('库存确认状态无效，请先核对库存记录'); }
  if (!Array.isArray(rows) || rows.length > 200 || rows.some(row => !row || !Number.isSafeInteger(row.owner) || row.owner < 1 || !Number.isSafeInteger(row.product) || row.product < 1 || typeof row.run !== 'string')) throw Error('库存确认状态无效，请先核对库存记录');
  return rows;
}
function owner(): number { const value = getAdminSession()?.userInfo.id; if (!value) throw Error('请重新登录'); return value; }
export function hasUnconfirmedStock(product: number): boolean { return markers().some(row => row.owner === owner() && row.product === product); }
export function isStockWritePending(product: number): boolean { return pending.has(pendingKey(owner(), product)); }
/** Manual reconciliation acknowledges the current inventory; it does not prove
 * that a previous relative adjustment committed. Never automatically retry it. */
export async function acknowledgeStockRead(product: number): Promise<void> {
  id(product);
  const current = owner(), session = localStorage.getItem('admin_session'), token = localStorage.getItem('admin_token');
  if (pending.has(pendingKey(current, product))) throw Error('库存请求尚未结束，请等待结果后重新读取库存');
  await withOutcomeLock(current, product, () => mutateMarkers(() => {
    if (current !== owner() || session !== localStorage.getItem('admin_session') || token !== localStorage.getItem('admin_token')) throw Error('登录身份已变化，请重新读取库存');
    if (pending.has(pendingKey(current, product))) throw Error('库存请求尚未结束，请等待结果后重新读取库存');
    localStorage.setItem(markerKey, JSON.stringify(markers().filter(row => row.owner !== current || row.product !== product)));
  }));
}
async function finish(marker: Marker): Promise<void> { await mutateMarkers(() => localStorage.setItem(markerKey, JSON.stringify(markers().filter(row => row.owner !== marker.owner || row.product !== marker.product || row.run !== marker.run)))); }

export async function apiAdminProductStockAttrs(product: number, signal?: AbortSignal): Promise<AdminProductStockRow[]> {
  id(product);
  const result = await getData<AdminProductStockRow[]>(request.get(`/product/product/attrs/${product}`, { signal }));
  if (!Array.isArray(result) || result.length > 10_000 || new Set(result.map(row => row?.id)).size !== result.length) throw Error('库存规格响应无效');
  for (const row of result) {
    if (!row || !Number.isSafeInteger(row.id) || row.id < 1 || row.product_id !== product || row.type !== 0 || typeof row.unique !== 'string' || [...row.unique].length > 8 || typeof row.suk !== 'string' || typeof row.image !== 'string' || typeof row.bar_code !== 'string' || typeof row.code !== 'string' || ![0, 1].includes(row.is_retired ?? 0) || !Number.isInteger(row.stock) || row.stock < -max - 1 || row.stock > max || !Number.isInteger(row.sum_stock) || row.sum_stock < -max - 1 || row.sum_stock > max) throw Error('库存规格响应无效');
    row.is_retired ??= 0;
  }
  return result;
}

export async function apiAdminProductSaveStocks(product: number, attrs: AdminProductStockAdjustment[]): Promise<AdminProductStockResult> {
  id(product);
  if (!Array.isArray(attrs) || !attrs.length || attrs.length > 10_000 || attrs.some(row => typeof row.unique !== 'string' || [...row.unique].length > 8 || ![0, 1].includes(row.pm) || !Number.isInteger(row.stock) || row.stock < 0 || row.stock > max)) throw Error('请填写有效的入出库数量');
  const current = owner(), key = pendingKey(current, product), session = localStorage.getItem('admin_session'), token = localStorage.getItem('admin_token');
  const preflightError = Error('登录身份已变化，请重新读取库存');
  const assertCurrent = () => { if (current !== getAdminSession()?.userInfo.id || session !== localStorage.getItem('admin_session') || token !== localStorage.getItem('admin_token')) throw preflightError; };
  if (pending.has(key)) throw Error('库存请求尚未结束，请等待结果后重新读取库存');
  return withOutcomeLock(current, product, async () => {
  assertCurrent();
  const marker: Marker = { owner: current, product, run: crypto.randomUUID() };
  pending.add(key);
  try {
  // Only identifiers are persisted; quantities, aliases, credentials and
  // inventory data never enter the recovery marker.
  await mutateMarkers(() => {
    assertCurrent();
    const rows = markers();
    if (rows.some(row => row.owner === current && row.product === product)) throw Error('上次库存调整结果尚未确认，请先读取并核对库存');
    if (rows.length >= 200) throw Error('未确认的库存调整过多，请先核对');
    localStorage.setItem(markerKey, JSON.stringify([...rows, marker]));
  });
  try {
    assertCurrent();
    const result = await getData<AdminProductStockResult>(request.put(`/product/product/saveStocks/${product}`, { attrs }, {
      headers: { 'Content-Type': 'application/json' },
      // Axios resolves its auth interceptor asynchronously. Recheck immediately
      // before serialization/dispatch so it cannot send an old owner's intent
      // with a replacement session's bearer.
      transformRequest: [(data: unknown) => { assertCurrent(); return JSON.stringify(data); }],
    }));
    if (!result || !(result.stock === 0 || typeof result.stock === 'string' && /^[1-9]\d*$/.test(result.stock) && Number.isSafeInteger(Number(result.stock)) && Number(result.stock) <= max)) throw Error('库存写入响应无效，请核对实际库存');
    await finish(marker); return result;
  } catch (error) {
    if (error === preflightError || error instanceof AdminResponseError && [400, 403, 404, 409, 422].includes(Number(error.status))) await finish(marker);
    throw error;
  }
  } finally { pending.delete(key); }
  });
}

/** Existing Admin capability read; this adds no inventory or configuration grant. */
export async function apiAdminStockErpEnabled(signal?: AbortSignal): Promise<boolean> {
  const result = await getData<{ open_erp: boolean }>(request.get('/api/admin/erp/config', { baseURL: '', signal }));
  if (!result || typeof result.open_erp !== 'boolean') throw Error('库存开关响应无效');
  return result.open_erp;
}
