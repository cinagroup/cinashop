import request, { AdminResponseError, getData } from '@/utils/request';
import { getAdminSession } from '@/utils/auth';
export type ProductModerationMode = 'verify' | 'remove';
export interface AdminProductModerationBody { is_verify: -2 | -1 | 1; refusal: string; is_show: 0 | 1 | 2; auto_on_time: string }
const max = 2_147_483_647, markerKey = 'admin_moderation_unconfirmed_v1';
type Marker = { owner: number; product: number; run: string };
const pending = new Set<string>();
const observed = new Map<string, string>();
const pendingKey = (current: number, product: number) => `${current}:${product}`;
async function withOutcomeLock<T>(current: number, product: number, action: () => Promise<T>): Promise<T> {
  // Keep the request fenced across tabs for the same product and owner.
  // Older browsers retain the per-tab pending guard and persistent marker.
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(`cinashop:product-moderation-outcome:${current}:${product}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) throw Error('其他页面的审核请求尚未结束，请稍后重新读取审核');
      return action();
    });
  }
  return action();
}
async function mutateMarkers<T>(action: () => T): Promise<T> {
  // Only synchronous localStorage operations hold this short global lock;
  // independent requests never hold it while awaiting the network.
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request('cinashop:product-moderation-markers', action);
  return action();
}
function id(value: number): void { if (!Number.isSafeInteger(value) || value < 1 || value > max) throw Error('商品ID格式错误'); }
function markers(): Marker[] {
  const value = localStorage.getItem(markerKey);
  if (!value) return [];
  let rows: unknown; try { rows = JSON.parse(value); } catch { throw Error('审核确认状态无效，请先核对审核记录'); }
  if (!Array.isArray(rows) || rows.length > 200 || rows.some(row => !row || !Number.isSafeInteger(row.owner) || row.owner < 1 || !Number.isSafeInteger(row.product) || row.product < 1 || typeof row.run !== 'string')) throw Error('审核确认状态无效，请先核对审核记录');
  return rows;
}
function owner(): number { const value = getAdminSession()?.userInfo.id; if (!value) throw Error('请重新登录'); return value; }
export function hasUnconfirmedModeration(product: number): boolean { return markers().some(row => row.owner === owner() && row.product === product); }
export function isModerationWritePending(product: number): boolean { return pending.has(pendingKey(owner(), product)); }
/** A fresh catalog read and explicit acknowledgement permit a new decision.
 * A lost response never permits automatic replay: it could invalidate new carts. */
export async function acknowledgeModerationRead(product: number): Promise<void> {
  id(product);
  const current = owner(), session = localStorage.getItem('admin_session'), token = localStorage.getItem('admin_token');
  if (pending.has(pendingKey(current, product))) throw Error('审核请求尚未结束，请等待结果后重新读取审核');
  await withOutcomeLock(current, product, () => mutateMarkers(() => {
    if (current !== owner() || session !== localStorage.getItem('admin_session') || token !== localStorage.getItem('admin_token')) throw Error('登录身份已变化，请重新读取审核');
    if (pending.has(pendingKey(current, product))) throw Error('审核请求尚未结束，请等待结果后重新读取审核');
    const marker = markers().find(row => row.owner === current && row.product === product);
    if (!marker || observed.get(pendingKey(current, product)) !== marker.run) throw Error('请先重新读取当前商品，再人工核对审核状态');
    localStorage.setItem(markerKey, JSON.stringify(markers().filter(row => row.owner !== current || row.product !== product)));
    observed.delete(pendingKey(current, product));
  }));
}
async function finish(marker: Marker): Promise<void> { await mutateMarkers(() => localStorage.setItem(markerKey, JSON.stringify(markers().filter(row => row.owner !== marker.owner || row.product !== marker.product || row.run !== marker.run)))); }


/** Called only after a validated current-owner catalog response. A read during
 * a pending write cannot reconcile that write, even if its response arrives later. */
export async function beginModerationRead(): Promise<(products: number[]) => void> {
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
export function canAcknowledgeModeration(product: number): boolean {
  const current = owner(), marker = markers().find(row => row.owner === current && row.product === product);
  return !!marker && !pending.has(pendingKey(current, product)) && observed.get(pendingKey(current, product)) === marker.run;
}
export async function apiAdminProductModerationForm(product: number, mode: ProductModerationMode, signal?: AbortSignal): Promise<void> {
  id(product);
  const value = await getData<{title: string; action: string; method: string; rules: unknown[]}>(request.get(`/product/product/${mode}/${product}`, { signal }));
  if (!value || value.title !== (mode === 'verify' ? '商品审核' : '强制下架') || value.action !== `product/product/set_verify/${product}` || value.method !== 'POST' || !Array.isArray(value.rules)) throw Error('审核表单响应无效');
}
export async function apiAdminProductGetVerify(product: number, signal?: AbortSignal): Promise<boolean> {
  id(product);
  const value = await getData<{verify: 0 | 1}>(request.get(`/product/product/get_verify/${product}`, { signal }));
  if (!value || ![0,1].includes(value.verify)) throw Error('售价核对响应无效');
  return value.verify === 1;
}

export async function apiAdminProductSetVerify(product: number, body: AdminProductModerationBody): Promise<void> {
  id(product);
  if (![-2,-1,1].includes(body.is_verify) || ![0,1,2].includes(body.is_show) || typeof body.refusal !== 'string' || [...body.refusal].length > 255 || /[\u0000\ud800-\udfff]/u.test(body.refusal) || body.is_verify !== 1 && !body.refusal.trim() || typeof body.auto_on_time !== 'string') throw Error('请填写有效的审核状态、原因与上架时间');
  const intent = { is_verify: body.is_verify, refusal: body.refusal, is_show: body.is_show, auto_on_time: body.auto_on_time };
  const current = owner(), key = pendingKey(current, product), session = localStorage.getItem('admin_session'), token = localStorage.getItem('admin_token');
  const preflightError = Error('登录身份已变化，请重新读取审核');
  const assertCurrent = () => { if (current !== getAdminSession()?.userInfo.id || session !== localStorage.getItem('admin_session') || token !== localStorage.getItem('admin_token')) throw preflightError; };
  if (pending.has(key)) throw Error('审核请求尚未结束，请等待结果后重新读取审核');
  return withOutcomeLock(current, product, async () => {
  assertCurrent();
  const marker: Marker = { owner: current, product, run: crypto.randomUUID() };
  pending.add(key); observed.delete(key);
  try {
  // Persist identifiers only. Reasons, dates and credentials stay in memory.
  await mutateMarkers(() => {
    assertCurrent();
    const rows = markers();
    if (rows.some(row => row.owner === current && row.product === product)) throw Error('上次审核调整结果尚未确认，请先读取并核对审核');
    if (rows.length >= 200) throw Error('未确认的审核调整过多，请先核对');
    localStorage.setItem(markerKey, JSON.stringify([...rows, marker]));
  });
  try {
    assertCurrent();
    const result = await getData<unknown>(request.post(`/product/product/set_verify/${product}`, intent, {
      headers: { 'Content-Type': 'application/json' },
      // Axios resolves its auth interceptor asynchronously. Recheck immediately
      // before serialization/dispatch so it cannot send an old owner's intent
      // with a replacement session's bearer.
      transformRequest: [(data: unknown) => { assertCurrent(); return JSON.stringify(data); }],
    }));
    if (!Array.isArray(result) || result.length) throw Error('审核写入响应无效，请核对当前商品');
    await finish(marker);
  } catch (error) {
    if (error === preflightError || error instanceof AdminResponseError && [400, 403, 404, 409, 422].includes(Number(error.status))) await finish(marker);
    throw error;
  }
  } finally { pending.delete(key); }
  });
}
