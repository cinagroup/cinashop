import { apiRequest } from './http';
import { previewMode } from './supplier';
import { parseSupplierProductEnsureCatalog } from '@/utils/productEnsures';
export async function getSupplierProductEnsureCatalog(supplierId: number, signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('服务保障读取已取消', 'AbortError');
  if (previewMode) return [{ id: 1, name: '正品保障' }, { id: 2, name: '售后服务' }];
  return parseSupplierProductEnsureCatalog(await apiRequest<unknown>({ method: 'GET', url: '/product/all_ensure', signal }), supplierId);
}
