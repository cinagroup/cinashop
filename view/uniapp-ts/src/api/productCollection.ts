import { http } from '@/utils/request';
import { useAuthStore } from '@/stores/auth';

export const PRODUCT_COLLECT_LIMIT = 100;
/** Canonical atomic, idempotent product collection. IDs are products, never cart rows. */
export async function apiCollectProducts(productIds: number[]): Promise<number> {
  const auth = useAuthStore();
  if (!auth.isLoggedIn || auth.uid <= 0) throw Error('请先登录后收藏商品');
  if (!Array.isArray(productIds) || !productIds.length || productIds.length > PRODUCT_COLLECT_LIMIT
    || new Set(productIds).size !== productIds.length
    || productIds.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647)) throw Error('请选择 1 至 100 件商品');
  const data = await http.post<unknown>('/collect/add', { id: productIds, category: 'product' });
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('收藏结果无效');
  const count = (data as Record<string, unknown>).count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > productIds.length) throw Error('收藏结果无效');
  return count;
}
