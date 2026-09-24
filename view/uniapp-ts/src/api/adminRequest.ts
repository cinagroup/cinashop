import { baseRequest, RequestError } from '@/utils/request';
import { useAdminSession } from '@/stores/adminSession';

/** Never use the shopper token, and never let an old Admin response affect a
 * newer session. Route authorization is still enforced by the server. */
export async function adminRequest(method: 'GET' | 'POST' | 'DELETE', path: string,
  data: Record<string, unknown>, permission: string): Promise<unknown> {
  const session = useAdminSession();
  if (!session.ensureFresh()) throw new RequestError('管理员登录已过期，请重新登录', 410001);
  if (!session.permissions.includes(permission)) throw new RequestError('当前管理员没有此操作权限', 400011);
  const owner = { version: session.version, token: session.token };
  const current = () => owner.version === session.version && owner.token === session.token;
  try {
    const result = await baseRequest<unknown>(path, method, data, { noAuth: true, headers: { Authorization: `Bearer ${owner.token}` } });
    if (!current()) throw new RequestError('管理员身份已变化，请重新加载');
    return result;
  } catch (error) {
    if (!current()) throw new RequestError('管理员身份已变化，请重新加载');
    if (error instanceof RequestError && (error.httpStatus === 401 || [410000, 410001, 410002].includes(error.status ?? 0))) session.clear();
    throw error;
  }
}
