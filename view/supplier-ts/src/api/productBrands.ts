import { apiRequest } from './http';
import { previewMode } from './supplier';
import { parseSupplierProductBrandCatalog } from '@/utils/productBrands';
export async function getSupplierProductBrandCatalog(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('品牌读取已取消', 'AbortError');
  if (previewMode) return parseSupplierProductBrandCatalog([{ value: 1, label: '示例品牌', pid: 0,
    children: [{ value: 2, label: '示例系列', pid: 1 }] }]);
  return parseSupplierProductBrandCatalog(await apiRequest<unknown>({ method: 'GET', url: '/product/brand/cascader_list/2', signal }));
}
