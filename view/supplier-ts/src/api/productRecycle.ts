import { apiRequest } from './http';
import { previewMode, previewProductRows } from './supplier';
import type { PageResult, ProductRow } from '@/types';

export type RecycleProduct = ProductRow & { is_del: 0 | 1 };
export interface ProductRecycleReceipt { id: number; operation: 'recycle' | 'restore' | 'delete'; is_del?: 0 | 1 }
export interface ProductHeader { type: number; name: string; count: number }
export async function readSupplierProducts(params: Record<string, string | number>, signal?: AbortSignal): Promise<PageResult<RecycleProduct>> {
  if (previewMode) {
    signal?.throwIfAborted();
    const list = previewProductRows().map(row => ({ ...row, is_del: row.is_del ?? 0 } as RecycleProduct))
      .filter(row => (params.is_del === 'all' ? Boolean(params.id) : row.is_del === Number(params.is_del ?? 0)) && (!params.id || row.id === Number(params.id))
        && (!params.store_name || row.store_name.includes(String(params.store_name))));
    const page = Number(params.page ?? 1), limit = Number(params.limit ?? 20);
    return { list: structuredClone(list.slice((page - 1) * limit, page * limit)), count: list.length, page, limit };
  }
  return apiRequest({ method: 'GET', url: '/product/product/list', params, signal });
}
export async function readSupplierProductHeader(keyword: string, signal?: AbortSignal): Promise<{ list: ProductHeader[] }> {
  if (previewMode) {
    signal?.throwIfAborted();
    const rows = previewProductRows().filter(row => !keyword || row.store_name.includes(keyword));
    return { list: [{ type: 6, name: '回收站', count: rows.filter(row => row.is_del === 1).length }] };
  }
  return apiRequest({ method: 'GET', url: '/product/type_header', params: { store_name: keyword }, signal });
}
export async function changeSupplierRecycledProduct(id: number, operation: 'restore' | 'delete', signal?: AbortSignal): Promise<ProductRecycleReceipt> {
  if (previewMode) {
    signal?.throwIfAborted();
    const rows = previewProductRows(), index = rows.findIndex(row => row.id === id && row.is_del === 1);
    if (index < 0) throw Error('示例回收商品已变化，请刷新');
    if (operation === 'restore') rows[index].is_del = 0; else rows.splice(index, 1);
    return { id, operation, ...(operation === 'restore' ? { is_del: 0 as const } : {}) };
  }
  return apiRequest({ method: 'DELETE', url: operation === 'delete' ? `/product/product/thorough/${id}` : `/product/product/${id}`,
    data: { expected_is_del: 1 }, signal });
}
