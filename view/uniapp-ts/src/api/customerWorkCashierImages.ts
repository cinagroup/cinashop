import { useAuthStore } from '@/stores/auth';
import { API_BASE, getFormType, RequestError } from '@/utils/request';
import { customerWorkCanonicalJson, cashierUuid } from '@/utils/customerWorkCashier';
import { isCustomerCashierImageMetadata } from '@/utils/customerWorkCashierImages';
import type { CustomerCashierImageMetadata } from '@/types/customerWorkCashierImages';

export const CUSTOMER_CASHIER_IMAGES_BASE = '/mobile/work/cashier/second-card';
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
export function customerCashierImageEndpoint(path: string, method: 'GET' | 'POST'): boolean {
  const base = CUSTOMER_CASHIER_IMAGES_BASE;
  return method === 'GET' ? new RegExp(`^${base}/(?:form-sessions|form-images)/${uuid}$`, 'u').test(path)
    : path === `${base}/form-sessions` || new RegExp(`^${base}/form-sessions/${uuid}/(?:cancel|previews)$`, 'u').test(path);
}

/** Independent shopper JWT domain. No Admin token or generic material upload. */
export function createCustomerCashierImageRequests(current: () => boolean, deadlineMs = 45_000) {
  const auth = useAuthStore(), owner = Object.freeze({ uid: auth.uid, token: auth.token, version: auth.sessionVersion });
  const cancellations = new Set<() => void>();
  let disposed = false;
  const active = () => !disposed && current() && auth.uid === owner.uid && auth.token === owner.token && auth.sessionVersion === owner.version;
  function abort() { disposed = true; for (const cancel of [...cancellations]) cancel(); cancellations.clear(); }
  function response<T>(statusCode: number, body: unknown): T {
    if (!body || typeof body !== 'object') throw new RequestError('原图片结果未确认，请查询原编号');
    const envelope = body as { status?: unknown; msg?: unknown; data?: T };
    if (statusCode < 200 || statusCode >= 300 || envelope.status !== 200) {
      const failure = new RequestError(typeof envelope.msg === 'string' ? envelope.msg : '原图片结果未确认，请查询原编号',
        typeof envelope.status === 'number' ? envelope.status : undefined, undefined, statusCode);
      if ([410000,410001,410002].includes(Number(envelope.status))) auth.clear();
      throw failure;
    }
    return envelope.data as T;
  }
  function execute<T>(start: (success: (status: number, body: unknown) => void, failure: (message: string) => void) => { abort(): void }): Promise<T> {
    if (!active() || !owner.token || owner.uid < 1) return Promise.reject(new RequestError('请登录原经营账号后核对图片结果'));
    return new Promise((resolve, reject) => {
      let done = false, task: { abort(): void } | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      function finish(value: T | undefined, failure?: unknown) {
        if (done) return; done = true; if (timer) clearTimeout(timer); cancellations.delete(cancel);
        if (failure) reject(failure); else resolve(value as T);
      }
      const cancel = () => { finish(undefined, new RequestError('页面或账号已变化，请保留原图片编号核对')); task?.abort(); };
      cancellations.add(cancel);
      timer = setTimeout(() => { finish(undefined, new RequestError('图片请求超时，请查询原编号')); task?.abort(); }, deadlineMs);
      try {
        task = start((status, body) => { if (done) return; if (!active()) { cancel(); return; }
          try { finish(response<T>(status, body)); } catch (failure) { finish(undefined, failure); } },
        message => { if (done) return; if (!active()) { cancel(); return; } finish(undefined, new RequestError(message || '原图片结果未确认，请查询原编号')); });
      } catch (failure) { finish(undefined, failure); }
    });
  }
  function request<T = unknown>(path: string, method: 'GET' | 'POST' = 'GET', value: Record<string, unknown> = {}, key?: string): Promise<T> {
    const write = method === 'POST' && !path.endsWith('/previews');
    if (!customerCashierImageEndpoint(path, method) || (write ? !cashierUuid(key) : key !== undefined)) return Promise.reject(new RequestError('收银图片地址或原编号无效，尚未提交'));
    let data: Record<string, unknown>;
    try { const json = customerWorkCanonicalJson(value); if (json.length > 65_536) throw Error('原图片请求过大'); data = JSON.parse(json); }
    catch (failure) { return Promise.reject(failure); }
    return execute<T>((success, failure) => uni.request({ url: `${API_BASE}/api${path}`, method, data, timeout: deadlineMs,
      header: { 'Form-type': getFormType(), 'Authori-zation': `Bearer ${owner.token}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...(write ? { 'Idempotency-Key': key! } : {}) },
      success: r => success(r.statusCode, r.data), fail: r => failure(r.errMsg),
    }));
  }
  function upload<T = unknown>(path: string, filePath: string, metadata: CustomerCashierImageMetadata, key: string): Promise<T> {
    if (!isCustomerCashierImageMetadata(metadata)) return Promise.reject(new RequestError('原图片内容或文件摘要无效，尚未提交'));
    const expected = `${CUSTOMER_CASHIER_IMAGES_BASE}/form-sessions/${metadata.session_key}/images`;
    if (path !== expected || !cashierUuid(metadata.session_key) || !cashierUuid(key) || !filePath || filePath.length > 4096) return Promise.reject(new RequestError('原图片上传范围或编号无效，尚未提交'));
    return execute<T>((success, failure) => uni.uploadFile({ url: `${API_BASE}/api${path}`, filePath, name: 'file',
      formData: { metadata: customerWorkCanonicalJson(metadata) }, timeout: deadlineMs,
      header: { 'Form-type': getFormType(), 'Authori-zation': `Bearer ${owner.token}`, 'Idempotency-Key': key },
      success: r => { try { if (r.data.length > 32_768) throw Error('图片回执过大'); success(r.statusCode, JSON.parse(r.data)); }
        catch (e) { failure(e instanceof Error ? e.message : '原图片回执无效'); } }, fail: r => failure(r.errMsg),
    }));
  }
  return { owner, active, abort, request, upload };
}
export type CustomerCashierImageRequests = ReturnType<typeof createCustomerCashierImageRequests>;
