import request, { AdminResponseError, getData } from '@/utils/request';
import { getAdminSession } from '@/utils/auth';
const max = 2_147_483_647, markerKey = 'admin_recycle_unconfirmed_v1';
type Marker = { owner: number; product: number; run: string };
const pending = new Set<string>();
const observed = new Map<string, string>();
const pendingKey = (current: number, product: number) => `${current}:${product}`;
async function withOutcomeLock<T>(current: number, product: number, action: () => Promise<T>): Promise<T> {
  // Keep the request fenced across tabs for the same product and owner.
  // Older browsers retain the per-tab pending guard and persistent marker.
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(`cinashop:product-recycle-outcome:${current}:${product}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) throw Error('其他页面的回收请求尚未结束，请稍后重新读取商品');
      return action();
    });
  }
  return action();
}
async function mutateMarkers<T>(action: () => T): Promise<T> {
  // Only synchronous localStorage operations hold this short global lock;
  // independent requests never hold it while awaiting the network.
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request('cinashop:product-recycle-markers', action);
  return action();
}
function id(value: number): void { if (!Number.isSafeInteger(value) || value < 1 || value > max) throw Error('商品ID格式错误'); }
function markers(): Marker[] {
  const value = localStorage.getItem(markerKey);
  if (!value) return [];
  let rows: unknown; try { rows = JSON.parse(value); } catch { throw Error('回收确认状态无效，请先核对商品记录'); }
  if (!Array.isArray(rows) || rows.length > 200 || rows.some(row => !row || !Number.isSafeInteger(row.owner) || row.owner < 1 || !Number.isSafeInteger(row.product) || row.product < 1 || typeof row.run !== 'string')) throw Error('回收确认状态无效，请先核对商品记录');
  return rows;
}
function owner(): number { const value = getAdminSession()?.userInfo.id; if (!value) throw Error('请重新登录'); return value; }
export function hasUnconfirmedRecycle(product: number): boolean { return markers().some(row => row.owner === owner() && row.product === product); }
export function isRecycleWritePending(product: number): boolean { return pending.has(pendingKey(owner(), product)); }
/** A fresh catalog read and explicit acknowledgement permit a new decision.
 * A lost toggle response never permits automatic replay: it could restore the product or invalidate new carts. */
export async function acknowledgeRecycleRead(product: number): Promise<void> {
  id(product);
  const current = owner(), session = localStorage.getItem('admin_session'), token = localStorage.getItem('admin_token');
  if (pending.has(pendingKey(current, product))) throw Error('回收请求尚未结束，请等待结果后重新读取商品');
  await withOutcomeLock(current, product, () => mutateMarkers(() => {
    if (current !== owner() || session !== localStorage.getItem('admin_session') || token !== localStorage.getItem('admin_token')) throw Error('登录身份已变化，请重新读取商品');
    if (pending.has(pendingKey(current, product))) throw Error('回收请求尚未结束，请等待结果后重新读取商品');
    const marker = markers().find(row => row.owner === current && row.product === product);
    if (!marker || observed.get(pendingKey(current, product)) !== marker.run) throw Error('请先重新读取当前商品，再人工核对商品状态');
    localStorage.setItem(markerKey, JSON.stringify(markers().filter(row => row.owner !== current || row.product !== product)));
    observed.delete(pendingKey(current, product));
  }));
}
async function finish(marker: Marker): Promise<void> { await mutateMarkers(() => localStorage.setItem(markerKey, JSON.stringify(markers().filter(row => row.owner !== marker.owner || row.product !== marker.product || row.run !== marker.run)))); }


/** Called only after a validated current-owner catalog response. A read during
 * a pending write cannot reconcile that write, even if its response arrives later. */
export async function beginRecycleRead(): Promise<(products: number[]) => void> {
  const session = localStorage.getItem('admin_session'), token = localStorage.getItem('admin_token'), current = getAdminSession()?.userInfo.id;
  let candidates: Marker[];
  try { candidates = markers().filter(row => row.owner === current && !pending.has(pendingKey(row.owner, row.product))); }
  catch { return () => {}; }
  const settled: Marker[] = [];
  for (const marker of candidates) {
    // Another tab owns a separate pending Set. Probe its actual request lock
    // BEFORE issuing the catalog GET, so a read begun during that write never
    // becomes recovery evidence after the writer eventually times out.
    const available = await withOutcomeLock(marker.owner, marker.product, async () => true).catch(() => false);
    if (available) settled.push(marker);
  }
  return products => {
    if (!current || session !== localStorage.getItem('admin_session') || token !== localStorage.getItem('admin_token')) return;
    let live: Marker[]; try { live = markers(); } catch { return; }
    for (const marker of settled) if (products.includes(marker.product) && !pending.has(pendingKey(current, marker.product)) && live.some(row => row.owner === current && row.product === marker.product && row.run === marker.run)) observed.set(pendingKey(current, marker.product), marker.run);
  };
}
export function canAcknowledgeRecycle(product: number): boolean {
  const current = owner(), marker = markers().find(row => row.owner === current && row.product === product);
  return !!marker && !pending.has(pendingKey(current, product)) && observed.get(pendingKey(current, product)) === marker.run;
}
export async function apiAdminProductRecycle(product: number, expectedIsDel: 0 | 1): Promise<void> {
  id(product);
  if (expectedIsDel !== 0 && expectedIsDel !== 1) throw Error('商品回收站状态无效');
  const current = owner(), key = pendingKey(current, product), session = localStorage.getItem('admin_session'), token = localStorage.getItem('admin_token');
  const preflightError = Error('登录身份已变化，请重新读取商品');
  const assertCurrent = () => { if (current !== getAdminSession()?.userInfo.id || session !== localStorage.getItem('admin_session') || token !== localStorage.getItem('admin_token')) throw preflightError; };
  if (pending.has(key)) throw Error('回收请求尚未结束，请等待结果后重新读取商品');
  return withOutcomeLock(current, product, async () => {
    assertCurrent();
    const marker: Marker = { owner: current, product, run: crypto.randomUUID() };
    pending.add(key); observed.delete(key);
    try {
      await mutateMarkers(() => {
        assertCurrent(); const rows = markers();
        if (rows.some(row => row.owner === current && row.product === product)) throw Error('上次回收操作结果尚未确认，请先读取并核对商品');
        if (rows.length >= 200) throw Error('未确认的回收操作过多，请先核对');
        localStorage.setItem(markerKey, JSON.stringify([...rows, marker]));
      });
      try {
        assertCurrent();
        const result = await getData<unknown>(request.delete(`/product/product/${product}`, {
          params: { expected_is_del: expectedIsDel },
          transformRequest: [(data: unknown) => { assertCurrent(); return data; }],
        }));
        if (!Array.isArray(result) || result.length) throw Error('回收写入响应无效，请核对当前商品');
        await finish(marker);
      } catch (error) {
        if (error === preflightError || error instanceof AdminResponseError && [400,403,404,409,422].includes(Number(error.status))) await finish(marker);
        throw error;
      }
    } finally { pending.delete(key); }
  });
}
