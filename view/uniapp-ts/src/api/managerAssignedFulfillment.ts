import { useAuthStore } from '@/stores/auth';
import { API_BASE, getFormType, RequestError } from '@/utils/request';
import { assignmentId, assignmentUuid } from '../../../common/fulfillmentAssignment';
import { captureAssignedInput, type AssignedInput } from '../../../common/managerAssignedFulfillment';

/** Separate fixed routes; old Manager operation paths and journals are unchanged. */
export function createAssignedRequests(current: () => boolean, deadline = 12000) {
  const auth = useAuthStore(), owner = { uid: auth.uid, token: auth.token, version: auth.sessionVersion };
  const cancellations = new Set<() => void>(); let disposed = false;
  function persisted() { try { return uni.getStorageSync('uni_token') === owner.token && Number(uni.getStorageSync('uni_uid')) === owner.uid; } catch { return false; } }
  const active = () => !disposed && current() && owner.uid > 0 && !!owner.token && persisted()
    && auth.uid === owner.uid && auth.token === owner.token && auth.sessionVersion === owner.version;
  function abort() { disposed = true; for (const cancel of [...cancellations]) cancel(); cancellations.clear(); }
  function request(path: string, data: object = {}, key?: string): Promise<unknown> {
    if (!active()) return Promise.reject(Error('账号或页面已变化，请重新登录后核对原请求'));
    return new Promise((resolve, reject) => {
      let done = false, task: UniApp.RequestTask | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: unknown, error?: Error) => { if (done) return; done = true; if (timer) clearTimeout(timer); cancellations.delete(cancel);
        if (error) reject(error); else resolve(value); };
      const cancel = () => { finish(undefined, Error('页面、门店或登录状态已变化')); task?.abort(); };
      cancellations.add(cancel); timer = setTimeout(() => { finish(undefined, Error('请求超时，原操作仍需查询')); task?.abort(); }, deadline);
      task = uni.request({ url: API_BASE + '/api' + path, method: key ? 'POST' : 'GET', data,
        timeout: deadline, header: { 'Form-type': getFormType(), 'Authori-zation': 'Bearer ' + owner.token,
          ...(key ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}) },
        success: response => { if (done) return; if (!active()) { cancel(); return; }
          const body = response.data as { status?: unknown; msg?: unknown; data?: unknown } | null;
          if (!body || body.status !== 200 || response.statusCode < 200 || response.statusCode >= 300) {
            if (body && [410000,410001,410002].includes(Number(body.status))) auth.clear();
            finish(undefined, new RequestError(typeof body?.msg === 'string' ? body.msg : '分配订单响应无效，请继续核对')); return;
          }
          finish(body.data);
        }, fail: error => { if (done) return; if (!active()) { cancel(); return; } finish(undefined, Error(error.errMsg || '网络连接失败，请查询原操作')); },
      });
    });
  }
  return { owner, active, abort,
    context: (store?: number) => request('/store/manager/context', store === undefined ? {} : { store_id: assignmentId(store) }),
    inbox: (store: number, after = 0) => request('/store/manager/assigned-order/inbox', { store_id: assignmentId(store), after: assignmentId(after, true) }),
    review: (order: number, store: number) => request('/store/manager/assigned-order/review/' + assignmentId(order), { store_id: assignmentId(store) }),
    commit: (key: string, input: AssignedInput) => request('/store/manager/assigned-order/commit', captureAssignedInput(input), assignmentUuid(key)),
    receipt: (key: string) => request('/store/manager/assigned-order/receipt/' + assignmentUuid(key)),
  };
}
export type AssignedRequests = ReturnType<typeof createAssignedRequests>;
