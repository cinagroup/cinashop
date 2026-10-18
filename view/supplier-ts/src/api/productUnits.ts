import { apiRequest } from './http';
import { previewMode } from './supplier';
import { parseSupplierProductUnits } from '@/utils/productUnits';

export async function getSupplierProductUnits(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('单位读取已取消', 'AbortError');
  if (previewMode) return parseSupplierProductUnits([{ id: 1, name: '件' }, { id: 2, name: '箱' }]);
  return parseSupplierProductUnits(await apiRequest<unknown>({ method: 'GET', url: '/product/get_all_unit', signal }));
}
