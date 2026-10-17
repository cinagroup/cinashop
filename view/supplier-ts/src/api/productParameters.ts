import { apiRequest } from './http';
import { previewMode } from './supplier';
import { parseSupplierProductParameterCatalog } from '@/utils/productParameters';
export async function getSupplierProductParameterCatalog(supplierId: number, signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('参数模板读取已取消', 'AbortError');
  if (previewMode) return [{ id: 1, name: '商品参数示例', specs: [{ id: 1, temp_id: 1, name: '材质', value: '请填写', sort: 0 }] }];
  return parseSupplierProductParameterCatalog(await apiRequest<unknown>({ method: 'GET', url: '/product/all_specs', signal }), supplierId);
}
