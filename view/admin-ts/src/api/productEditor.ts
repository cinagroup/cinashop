import request, { getData } from '@/utils/request';
import { parseProductReceipt, type EditorDimension, type PendingProductSave, type ProductEditorDetail, type ProductSavePayload } from '@/pages/product/productEditorModel';

export async function apiFullProductDetail(id: number, signal?: AbortSignal): Promise<ProductEditorDetail> {
  if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw Error('商品ID无效');
  const value = await getData<ProductEditorDetail>(request.get(`/product/editor/detail/${id}`, { signal }));
  if (value?.editor?.contract_version !== 1 || typeof value.editor.erp_open !== 'boolean') throw Error('完整商品编辑契约或ERP状态未能确认');
  return value;
}
export async function apiFullProductSave(pending: PendingProductSave, product: ProductSavePayload, signal?: AbortSignal) {
  return parseProductReceipt(await getData(request.post(`/product/editor/save/${pending.requested_id}`, { operation_id: pending.operation_id, product }, { signal })), pending);
}
export async function apiProductSaveOperation(pending: PendingProductSave, resolve = false, signal?: AbortSignal) {
  const path = `/product/editor/operations/${pending.operation_id}`;
  return parseProductReceipt(await getData(resolve ? request.post(`${path}/resolve`, { requested_id: pending.requested_id }, { signal }) : request.get(path, { signal })), pending);
}
export async function apiGenerateEditorSkus(id: number, productType: number, dimensions: EditorDimension[], signal?: AbortSignal) {
  const value = await getData<{ info: { attr: EditorDimension[]; value: unknown[]; product_type: number } }>(request.post(`/product/generate_attr/${id}/1`, { attrs: dimensions, product_type: productType }, { signal }));
  if (!value?.info || !Array.isArray(value.info.attr) || !Array.isArray(value.info.value) || value.info.product_type !== productType) throw Error('规格生成响应无效');
  return value.info;
}
