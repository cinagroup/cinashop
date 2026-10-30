import { useAuthStore } from '@/stores/auth';
import { API_BASE, getFormType, RequestError } from '@/utils/request';
import { customerWorkCanonicalJson } from '../../../common/customerWorkIntent';

const base = '/mobile/work/cashier/second-card';
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const uuidPattern = new RegExp(`^${uuid}$`, 'u');
function numericPath(path: string, expression: RegExp): boolean {
  const match = path.match(expression);
  return !!match && Number(match[1]) <= 2_147_483_647;
}
export function customerCashierEndpoint(path: string, method: 'GET' | 'POST'): boolean {
  if (method === 'GET') return path === `${base}/capabilities` || path === `${base}/catalog` || path === `${base}/records` || path === '/mobile/work/users'
    || numericPath(path, /^\/mobile\/work\/cashier\/second-card\/(?:catalog|records)\/([1-9]\d{0,9})$/u)
    || numericPath(path, /^\/mobile\/work\/users\/([1-9]\d{0,9})$/u)
    || new RegExp(`^${base}/(?:creations|payments)/${uuid}$`, 'u').test(path);
  return [`${base}/drafts`, `${base}/quote`, `${base}/orders`].includes(path)
    || new RegExp(`^${base}/(?:creations|payments)/${uuid}/abandon$`, 'u').test(path)
    || numericPath(path, /^\/mobile\/work\/cashier\/second-card\/orders\/([1-9]\d{0,9})\/cash$/u);
}

/** Independent UserJWT cashier requests. An interrupted write keeps its original UUID for recovery. */
export function createCustomerCashierRequests(current: () => boolean, deadlineMs = 12_000) {
  const auth = useAuthStore(), owner = Object.freeze({ uid: auth.uid, token: auth.token, version: auth.sessionVersion });
  const cancellations = new Set<() => void>();
  let disposed = false;
  const active = () => !disposed && current() && auth.uid === owner.uid && auth.token === owner.token && auth.sessionVersion === owner.version;
  function abort() { disposed = true; for (const cancel of [...cancellations]) cancel(); cancellations.clear(); }
  function request<T = unknown>(path: string, method: 'GET' | 'POST' = 'GET', data: Record<string, unknown> = {}, key?: string): Promise<T> {
    if (!active() || !owner.token || owner.uid < 1) return Promise.reject(new RequestError('请登录原经营账号后核对收银结果'));
    const write = method === 'POST' && path !== `${base}/quote`;
    const abandonment = path.match(new RegExp(`^${base}/(?:creations|payments)/(${uuid})/abandon$`, 'u'));
    if (!customerCashierEndpoint(path, method) || (write ? !key || !uuidPattern.test(key) : key !== undefined)) {
      return Promise.reject(new RequestError('次卡收银地址或原请求编号无效，尚未提交'));
    }
    if (abandonment && key !== abandonment[1]) return Promise.reject(new RequestError('放弃请求必须使用完整原收银编号，尚未提交'));
    try { data = JSON.parse(customerWorkCanonicalJson(data)); }
    catch { return Promise.reject(new RequestError('收银原内容不是有效 JSON，尚未提交')); }
    if (path === `${base}/capabilities` && Object.keys(data).length) return Promise.reject(new RequestError('次卡能力请求不接受查询参数'));
    return new Promise((resolve, reject) => {
      let done = false, task: UniApp.RequestTask | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      function finish(value: T | undefined, failure?: Error) {
        if (done) return; done = true; if (timer) clearTimeout(timer); cancellations.delete(cancel);
        if (failure) reject(failure); else resolve(value as T);
      }
      const cancel = () => { finish(undefined, new RequestError('页面或账号已变化，请保留原收银编号核对')); task?.abort(); };
      cancellations.add(cancel);
      timer = setTimeout(() => { finish(undefined, new RequestError('收银请求超时，请查询原编号结果')); task?.abort(); }, deadlineMs);
      task = uni.request({ url: `${API_BASE}/api${path}`, method, data, timeout: deadlineMs,
        header: { 'Form-type': getFormType(), 'Authori-zation': `Bearer ${owner.token}`,
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...(write ? { 'Idempotency-Key': key! } : {}) },
        success: response => {
          if (done) return; if (!active()) { cancel(); return; }
          const body = response.data as { status?: unknown; msg?: unknown; data?: T } | null;
          if (!body || typeof body.status !== 'number' || response.statusCode < 200 || response.statusCode >= 300 || body.status !== 200) {
            const failure = new RequestError(typeof body?.msg === 'string' ? body.msg : '收银响应未确认，请核对原编号结果',
              typeof body?.status === 'number' ? body.status : undefined, undefined, response.statusCode);
            if (body && [410000, 410001, 410002].includes(Number(body.status))) auth.clear();
            finish(undefined, failure); return;
          }
          finish(body.data);
        },
        fail: failure => { if (done) return; if (!active()) { cancel(); return; }
          finish(undefined, new RequestError(failure.errMsg || '收银结果未确认，请继续查询原编号')); },
      });
    });
  }
  return { owner, active, abort, request };
}
export type CustomerCashierRequests = ReturnType<typeof createCustomerCashierRequests>;
