import axios from 'axios';
import { clearAuth, getToken, getAdminSession } from '@/utils/auth';
import { createAdminSessionScope } from '@/utils/adminSessionScope';
import { AdminResponseError } from '@/utils/request';
import { parseAdminRefund, parseAdminRefundDetail, type AdminRefundDetail } from '@/utils/refundDetail';
import { operationBody, operationVersion, parseRefundOperation, verifyRefundOperation, parseOperationResult, type RefundOperation, type OperationMode } from '@/utils/refundOperation';
export type { AdminRefund, AdminRefundDetail } from '@/utils/refundDetail';
export const previewMode = import.meta.env.DEV && new URLSearchParams(window.location.search).get('preview') === '1';

// Capture credentials synchronously, not from the global late-dispatch interceptor.
export const refundRequest = axios.create({ baseURL: '/adminapi', timeout: 30000 });
async function send(url: string, method: 'get' | 'post', data?: unknown, params?: unknown, signal?: AbortSignal, operation?: RefundOperation): Promise<unknown> {
  const token = getToken(), scope = createAdminSessionScope();
  const abort = () => scope.dispose();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    if (!scope.isCurrent()) throw Error('登录状态已变化，请重新打开页面');
    if (operation) {
      if (getAdminSession()?.userInfo.id !== operation.actorId) throw Error('原操作不属于当前管理员，请重新登录原账号');
      await verifyRefundOperation(operation, operation.actorId, operation.refundId);
      if (!scope.isCurrent()) throw Error('登录状态已变化，请重新打开页面');
    }
    const response = await refundRequest.request({ url, method, data, params, signal: scope.signal, headers: {
      'Authori-zation': 'Bearer ' + token,
      ...(operation ? { 'Idempotency-Key': operation.nonce, 'X-Refund-Operation-Scope': 'v1:admin:' + operation.actorId } : {}),
    } });
    if (!scope.isCurrent()) throw Error('登录状态已变化，请重新打开页面');
    const body = response.data;
    if (!body || typeof body !== 'object' || body.status !== 200) {
      if ([410000, 410001, 410002].includes(body?.status)) {
        clearAuth(); window.dispatchEvent(new Event('admin-auth-expired'));
      }
      throw new AdminResponseError(typeof body?.msg === 'string' ? body.msg : '退款响应无效', body?.status);
    }
    return body.data;
  } catch (error) {
    if (scope.isCurrent() && axios.isAxiosError(error) && error.response?.status === 401) {
      clearAuth(); window.dispatchEvent(new Event('admin-auth-expired'));
    }
    throw error;
  } finally { signal?.removeEventListener('abort', abort); scope.dispose(); }
}
/** Every recovery call retains the exact persisted actor, original decision and
 * key. No fallback to legacy mutation routes, no automatic retry/new nonce. */
export async function apiAdminRefundOperation(input: RefundOperation, mode: OperationMode, signal?: AbortSignal) {
  if (previewMode) throw Error('预览仅可查看；真实回执流程请连接隔离测试接口');
  const intent = parseRefundOperation(input, input.actorId, input.refundId);
  if (!['execute','receipt','abandon'].includes(mode)) throw Error('操作方式无效');
  const value = await send('/refund/operations/' + mode + (mode === 'receipt' ? '' : '/' + intent.refundId), 'post',
    mode === 'receipt' ? { version: operationVersion } : operationBody(intent), undefined, signal, intent);
  return parseOperationResult(value, intent, mode);
}
const previewRows: AdminRefundDetail[] = [802, 801].map((id, i) => ({ id, storeOrderId: id, orderId: 'PREVIEW-R' + id, originalOrderId: 'PREVIEW-O' + id,
  uid: 10018, storeId: 0, supplierId: 0, applyType: i ? 1 : 2, applyPrice: '5.00', refundType: i ? 0 : 5,
  refundNum: 1, refundPrice: '5.00', refundedPrice: '0.00', refundReason: '本地演示', isCancel: 0, isDel: 0,
  addTime: 1700000000, refundedTime: 0, payType: 'yue', providerStatus: null, refundExplain: '', refuseReason: '',
  refundExpress: i ? '' : 'PREVIEW-ONLY', refundExpressName: '演示快递', refundPhone: '', refundGoodsExplain: '非真实退货',
  returnImages: [], returnImagesError: '', returnContact: { source: 'platform', name: '演示收件人', phone: '', address: '仅供本地预览' } }));
export interface RefundListQuery { before?: string; keyword?: string; status?: string; limit: number }
export async function apiAdminRefundList(query: RefundListQuery, signal?: AbortSignal) {
  const value = previewMode ? { list: previewRows.filter(row => (!query.before || row.id < Number(query.before)) && (!query.status || row.refundType === Number(query.status))), limit: query.limit, nextCursor: null }
    : await send('/refund/list', 'get', undefined, { ...query, view: 'admin' }, signal);
  if (!value || typeof value !== 'object' || !('list' in value) || !Array.isArray(value.list)
    || !('limit' in value) || value.limit !== query.limit || value.list.length > query.limit || !('nextCursor' in value)) throw Error('退款列表响应不完整');
  const list = value.list.map(parseAdminRefund), nextCursor = value.nextCursor;
  if (list.some((row, i) => (i > 0 && row.id >= list[i - 1].id) || (query.before && row.id >= Number(query.before)))
    || (nextCursor !== null && (typeof nextCursor !== 'string' || list.length !== query.limit || nextCursor !== String(list.at(-1)?.id)))) throw Error('退款分页响应无效');
  return { list, nextCursor: nextCursor as string | null };
}
export async function apiAdminRefundDetail(id: number, signal?: AbortSignal) {
  return parseAdminRefundDetail(previewMode ? previewRows.find(row => row.id === id) : await send('/refund/detail/' + id, 'get', undefined, undefined, signal), id);
}
