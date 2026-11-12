import { apiRequest } from './http';
import { previewMode } from './supplier';
import { productCouponCatalog } from '@/utils/productCoupons';
export async function getSupplierProductCouponCatalog(page: number, keyword: string, signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('赠券读取已取消', 'AbortError');
  if (previewMode) return productCouponCatalog({ version: 1, list: [{ id: 1, title: '预览赠送券', status: 1, coupon_price: '5.00', discount_type: 1, use_min_price: '20.00' }], count: 1, page: 1, limit: 20 });
  return productCouponCatalog(await apiRequest<unknown>({ method: 'GET', url: '/product/coupon/catalog', params: { page, limit: 20, keyword }, signal }));
}
