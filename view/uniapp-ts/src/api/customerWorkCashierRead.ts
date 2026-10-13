import { useAuthStore } from '@/stores/auth';
import { API_BASE, getFormType, RequestError } from '@/utils/request';

export function customerCashierReadEndpoint(path: string): boolean {
  if (path === '/mobile/work/cashier/second-card/records') return true;
  const match = path.match(/^\/mobile\/work\/cashier\/second-card\/records\/([1-9]\d{0,9})$/u);
  return !!match && Number(match[1]) <= 2_147_483_647;
}

/** This reader always uses the current shopper session and never dispatches a payment. */
export function createCustomerCashierReadRequests(current: () => boolean, deadlineMs = 12_000) {
  const auth = useAuthStore();
  const owner = Object.freeze({ uid: auth.uid, token: auth.token, version: auth.sessionVersion });
  const cancellations = new Set<() => void>();
  let disposed = false;
  const active = () => !disposed && current() && auth.uid === owner.uid
    && auth.token === owner.token && auth.sessionVersion === owner.version;
  function abort() { disposed = true; for (const cancel of [...cancellations]) cancel(); cancellations.clear(); }
  function request<T = unknown>(path: string, data: Record<string, string | number> = {}): Promise<T> {
    if (!active() || !owner.token || owner.uid < 1) return Promise.reject(new RequestError('请登录后核对本人次卡收银记录'));
    if (!customerCashierReadEndpoint(path)) return Promise.reject(new RequestError('次卡收银查询地址无效'));
    const query = { ...data };
    return new Promise((resolve, reject) => {
      let done = false, task: UniApp.RequestTask | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      function finish(value: T | undefined, failure?: Error) {
        if (done) return; done = true; if (timer) clearTimeout(timer); cancellations.delete(cancel);
        if (failure) reject(failure); else resolve(value as T);
      }
      const cancel = () => { finish(undefined, new RequestError('页面或账号已变化，请重新读取收银记录')); task?.abort(); };
      cancellations.add(cancel);
      timer = setTimeout(() => { finish(undefined, new RequestError('收银记录读取超时，请重试本页')); task?.abort(); }, deadlineMs);
      task = uni.request({ url: `${API_BASE}/api${path}`, method: 'GET', data: query, timeout: deadlineMs,
        header: { 'Form-type': getFormType(), 'Authori-zation': `Bearer ${owner.token}` },
        success: response => {
          if (done) return; if (!active()) { cancel(); return; }
          const body = response.data as { status?: unknown; msg?: unknown; data?: T } | null;
          if (!body || typeof body.status !== 'number' || response.statusCode < 200 || response.statusCode >= 300 || body.status !== 200) {
            const failure = new RequestError(typeof body?.msg === 'string' ? body.msg : '收银记录响应无效，请重新读取',
              typeof body?.status === 'number' ? body.status : undefined, undefined, response.statusCode);
            if (body && [410000, 410001, 410002].includes(Number(body.status))) auth.clear();
            finish(undefined, failure); return;
          }
          finish(body.data);
        },
        fail: failure => { if (done) return; if (!active()) { cancel(); return; }
          finish(undefined, new RequestError(failure.errMsg || '收银记录读取失败，请重试本页')); },
      });
    });
  }
  return { owner, active, abort, request };
}
export type CustomerCashierReadRequests = ReturnType<typeof createCustomerCashierReadRequests>;
