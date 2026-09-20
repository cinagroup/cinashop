import axios from 'axios';
import { clearAuth, getToken } from './auth';
import { createAdminSessionScope } from './adminSessionScope';
import { AdminResponseError } from './request';

// Never let a queued request adopt a later account through the global interceptor.
export const orderRequest = axios.create({ baseURL: '/adminapi', timeout: 30000 });
export async function sendOrderRequest<T = unknown>(url: string, method: 'get' | 'post', data?: unknown, params?: unknown, signal?: AbortSignal): Promise<T> {
  const token = getToken(), scope = createAdminSessionScope();
  const abort = () => scope.dispose();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    if (!scope.isCurrent()) throw Error('登录状态已变化，请重新打开页面');
    const response = await orderRequest.request<unknown>({ url, method, data, params, signal: scope.signal, headers: { 'Authori-zation': 'Bearer ' + token } });
    if (!scope.isCurrent()) throw Error('登录状态已变化，请重新打开页面');
    const body = response.data;
    if (!body || typeof body !== 'object' || !('status' in body) || body.status !== 200 || !('data' in body)) {
      const status = body && typeof body === 'object' && 'status' in body && typeof body.status === 'number' ? body.status : undefined;
      if (status && [410000, 410001, 410002].includes(status)) { clearAuth(); window.dispatchEvent(new Event('admin-auth-expired')); }
      throw new AdminResponseError(body && typeof body === 'object' && 'msg' in body && typeof body.msg === 'string' ? body.msg : '订单响应无效', status);
    }
    return body.data as T;
  } catch (error) {
    if (scope.isCurrent() && axios.isAxiosError(error) && error.response?.status === 401) { clearAuth(); window.dispatchEvent(new Event('admin-auth-expired')); }
    throw error;
  } finally { signal?.removeEventListener('abort', abort); scope.dispose(); }
}
