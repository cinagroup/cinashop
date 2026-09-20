import { API_BASE, getFormType, http, RequestError } from '@/utils/request';
import { useAuthStore } from '@/stores/auth';
import type { ReturnBody } from '../../../common/refundReturn';

export const apiReturnCarriers = (): Promise<unknown> => http.get('logistics', { status: 1 });
export const apiReturnExpress = (body: ReturnBody): Promise<unknown> => http.post('order/refund/express', { ...body });

/** Capture the account before native I/O; stale upload callbacks cannot alter a replacement session. */
export function apiReturnImage(filePath: string): Promise<unknown> {
  const auth = useAuthStore(), uid = auth.uid, token = auth.token, version = auth.sessionVersion;
  if (!uid || !token) return Promise.reject(Error('请先登录'));
  const current = () => uid === auth.uid && token === auth.token && version === auth.sessionVersion;
  return new Promise((resolve, reject) => uni.uploadFile({ url: `${API_BASE}/api/upload/image`, filePath, name: 'file', formData: { pid: '0' },
    header: { 'Authori-zation': `Bearer ${token}`, 'Form-type': getFormType() }, timeout: 30000,
    success(result) {
      if (!current()) { reject(Error('登录状态已变化，请重新操作')); return; }
      try {
        if (typeof result.data !== 'string' || result.data.length > 16384) throw Error('上传回执无效');
        const value: unknown = JSON.parse(result.data);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('上传回执无效');
        const body = value as Record<string, unknown>;
        if (result.statusCode >= 200 && result.statusCode < 300 && body.status === 200) resolve(body.data);
        else reject(new RequestError(typeof body.msg === 'string' ? body.msg : '凭证上传失败', typeof body.status === 'number' ? body.status : undefined));
      } catch (error) { reject(error); }
    }, fail() { reject(Error('凭证上传未完成，请重试')); },
  }));
}
