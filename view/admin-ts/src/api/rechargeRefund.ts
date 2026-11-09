import { clearAuth, getAdminSession, getToken } from '@/utils/auth';
import { createAdminSessionScope } from '@/utils/adminSessionScope';
import { applyRechargeRefundAbandonment, applyRechargeRefundView, parseRechargeRefundQuote, parseRechargeRefundView,
  rechargeRefundVersion, verifyRechargeRefundIntent, type RechargeRefundIntent } from '@/utils/rechargeRefund';

export type RechargeRefundAction = 'lookup' | 'execute' | 'query' | 'cancel' | 'abandon';
export class RechargeRefundApiError extends Error {
  constructor(message: string, readonly status: number | null) { super(message); this.name = 'RechargeRefundApiError'; }
}
async function boundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (response.redirected || response.status >= 300 && response.status < 400 || !response.body
    || length !== null && (!/^\d+$/u.test(length) || Number(length) > 65536)) { await response.body?.cancel(); throw Error('充值退款响应无效'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0, done = false;
  try {
    while (true) { const next = await reader.read(); if (next.done) { done = true; break; } bytes += next.value.byteLength;
      if (bytes > 65536) throw Error('充值退款响应过大'); chunks.push(next.value); }
    const output = new Uint8Array(bytes); let start = 0; for (const c of chunks) { output.set(c, start); start += c.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output)); }
    catch { throw Error('充值退款响应格式错误，请保留原申请'); }
  } finally { if (!done) await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function send(actorId: number, rechargeId: number, endpoint: string, body: unknown, key: string, signal?: AbortSignal) {
  const token = getToken(), scope = createAdminSessionScope(), abort = () => scope.dispose();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const owns = () => scope.isCurrent() && getAdminSession()?.userInfo.id === actorId;
  let timedOut = false; const timer = setTimeout(() => { timedOut = true; scope.dispose(); }, 30000);
  try {
    if (!owns() || !Number.isSafeInteger(rechargeId) || rechargeId < 1 || rechargeId > 2147483647) throw Error('登录身份已变化，请重新打开退款申请');
    const response = await fetch('/adminapi/finance/recharge-refunds/' + endpoint, { method: 'POST', cache: 'no-store', credentials: 'same-origin', redirect: 'manual',
      signal: scope.signal, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Authori-zation': 'Bearer ' + token,
        'Idempotency-Key': key, 'X-Recharge-Refund-Scope': 'v1:admin:' + actorId }, body: JSON.stringify(body) });
    if (!owns()) throw Error('登录身份已变化，原申请已保留');
    if (response.status === 401) { await response.body?.cancel(); clearAuth(); window.dispatchEvent(new Event('admin-auth-expired')); throw new RechargeRefundApiError('登录已失效，原申请已保留', 401); }
    const value = await boundedJson(response); if (!owns()) throw Error('登录身份已变化，原申请已保留');
    const r = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    if (!response.ok || !r || r.status !== 200 || !Object.hasOwn(r, 'data')) {
      if (response.status === 401 || r && [410000, 410001, 410002].includes(Number(r.status))) { clearAuth(); window.dispatchEvent(new Event('admin-auth-expired')); }
      throw new RechargeRefundApiError(r && typeof r.msg === 'string' ? r.msg : '充值退款暂未得到有效回执，请保留原申请',
        r && typeof r.status === 'number' ? r.status : response.status);
    }
    return r.data;
  } catch (error) { if (timedOut) throw Error('请求超时，请保留原申请并读取状态'); throw error; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); scope.dispose(); }
}
export async function apiRechargeRefundQuote(actorId: number, rechargeId: number, signal?: AbortSignal) {
  return parseRechargeRefundQuote(await send(actorId, rechargeId, 'quote/' + rechargeId, { version: rechargeRefundVersion }, crypto.randomUUID(), signal), rechargeId);
}
export async function apiRechargeRefundAction(raw: RechargeRefundIntent, mode: RechargeRefundAction, signal?: AbortSignal): Promise<RechargeRefundIntent> {
  if (!['lookup', 'execute', 'query', 'cancel', 'abandon'].includes(mode)) throw Error('充值退款操作方式无效');
  // Verify a synchronous copy before any await. The transport separately owns a
  // sticky session from before this crypto operation through the response.
  const scope = createAdminSessionScope(); const abort = () => scope.dispose();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  try {
    const i = await verifyRechargeRefundIntent(raw, raw.actorId, raw.rechargeId);
    if (!scope.isCurrent() || getAdminSession()?.userInfo.id !== i.actorId) throw Error('登录身份已变化，请保留原申请');
    if ((mode === 'execute' || mode === 'abandon') && !i.body) throw Error('原方案已缺失，只能读取状态或撤销未派发申请');
    const endpoint = mode === 'lookup' ? 'execution' : mode === 'query' ? 'query' : mode + '/' + i.rechargeId;
    const value = await send(i.actorId, i.rechargeId, endpoint, mode === 'execute' || mode === 'abandon' ? i.body : { version: rechargeRefundVersion }, i.key, scope.signal);
    if (!scope.isCurrent()) throw Error('登录身份已变化，原申请已保留');
    return mode === 'abandon' ? applyRechargeRefundAbandonment(i, value) : applyRechargeRefundView(i, parseRechargeRefundView(value, i));
  } finally { signal?.removeEventListener('abort', abort); scope.dispose(); }
}
