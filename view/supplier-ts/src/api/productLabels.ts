import { apiRequest } from './http';
import type { SupplierProductLabelPayload } from '@/types/productLabels';
import { parseSupplierProductLabelCatalog, parseSupplierProductLabelForm, parseSupplierProductLabelReceipt, parseSupplierProductLabelTree } from '@/utils/productLabels';

export async function getSupplierProductLabelCatalog(signal?: AbortSignal) {
  return parseSupplierProductLabelCatalog(await apiRequest<unknown>({ url: '/product/label/catalog', method: 'GET', signal }));
}
export async function getSupplierProductLabelForm(signal?: AbortSignal) {
  return parseSupplierProductLabelForm(await apiRequest<unknown>({ url: '/product/label/form', method: 'GET', signal }));
}
export async function getSupplierProductLabelTree(signal?: AbortSignal) {
  return parseSupplierProductLabelTree(await apiRequest<unknown>({ url: '/product/product_label', method: 'GET', signal }));
}
export async function saveSupplierProductLabel(id: number, payload: SupplierProductLabelPayload, signal?: AbortSignal) {
  if (!Number.isSafeInteger(id) || id < 0 || id > 2_147_483_647) throw Error('商品标签ID错误');
  return parseSupplierProductLabelReceipt(await apiRequest<unknown>({ url: `/product/label/${id}`, method: 'POST', data: payload, signal }));
}
export async function deleteSupplierProductLabel(id: number, expectedRevision?: string, signal?: AbortSignal): Promise<null> {
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) throw Error('商品标签ID错误');
  const result = await apiRequest<unknown>({ url: `/product/label/${id}`, method: 'DELETE', ...(expectedRevision ? { data: { expected_revision: expectedRevision } } : {}), signal });
  if (result !== null) throw Error('删除结果未知，请重新读取商品标签核对'); return null;
}
