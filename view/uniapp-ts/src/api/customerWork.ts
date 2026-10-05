import { useAuthStore } from '@/stores/auth';
import { API_BASE, getFormType, RequestError } from '@/utils/request';

/** The phone-order role uses the shopper identity, with its own server grant. */
export function createCustomerWorkRequests(current: () => boolean, deadlineMs = 12_000) {
  const auth = useAuthStore();
  const owner = { uid: auth.uid, token: auth.token, version: auth.sessionVersion };
  const cancellations = new Set<() => void>();
  let disposed = false;
  const active = () => !disposed && current() && auth.uid === owner.uid
    && auth.token === owner.token && auth.sessionVersion === owner.version;
  function abort() { disposed = true; for (const cancel of [...cancellations]) cancel(); cancellations.clear(); }
  function request<T = unknown>(path: string, data: Record<string, unknown> = {}): Promise<T> {
    if (!active() || !owner.token || owner.uid < 1) return Promise.reject(new RequestError('请登录后打开手机经营工作台'));
    if (!/^\/mobile\/work\/(?:context|overview|statistics|trend|statistics\/orders|orders(?:\/[A-Za-z0-9_-]{1,50}(?:\/logistics)?)?|refunds(?:\/[A-Za-z0-9_-]{1,50})?)$/u.test(path)) {
      return Promise.reject(new RequestError('经营请求地址无效'));
    }
    return new Promise((resolve, reject) => {
      let done = false, task: UniApp.RequestTask | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      function finish(value: T | undefined, error?: Error) {
        if (done) return; done = true; if (timer) clearTimeout(timer); cancellations.delete(cancel);
        if (error) reject(error); else resolve(value as T);
      }
      const cancel = () => { finish(undefined, new RequestError('页面或登录状态已变化')); task?.abort(); };
      cancellations.add(cancel);
      timer = setTimeout(() => { finish(undefined, new RequestError('读取超时，请重新加载当前经营数据')); task?.abort(); }, deadlineMs);
      task = uni.request({ url: `${API_BASE}/api${path}`, method: 'GET', data, timeout: deadlineMs,
        header: { 'Form-type': getFormType(), 'Authori-zation': `Bearer ${owner.token}` },
        success: response => {
          if (done) return; if (!active()) { cancel(); return; }
          const body = response.data as { status?: unknown; msg?: unknown; data?: T } | null;
          if (!body || typeof body.status !== 'number' || response.statusCode < 200 || response.statusCode >= 300 || body.status !== 200) {
            const error = new RequestError(typeof body?.msg === 'string' ? body.msg : '经营响应无效，请重新读取',
              typeof body?.status === 'number' ? body.status : undefined, undefined, response.statusCode);
            if (body && [410000, 410001, 410002].includes(Number(body.status))) auth.clear();
            finish(undefined, error); return;
          }
          finish(body.data);
        },
        fail: failure => { if (done) return; if (!active()) { cancel(); return; }
          finish(undefined, new RequestError(failure.errMsg || '经营数据读取失败，请重试')); },
      });
    });
  }
  return { owner, active, abort, request };
}
export type CustomerWorkRequests = ReturnType<typeof createCustomerWorkRequests>;
