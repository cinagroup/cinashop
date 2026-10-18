import { apiRequest } from './http';
import { previewMode } from './supplier';
import { parseSupplierProductSystemFormCatalog, parseSupplierProductSystemFormInfo, productSystemFormId } from '@/utils/productSystemForms';
const sample = { id: 1, version: 1, name: '配送留言', cover_image: '', default_value: '', status: 1, is_del: 0, update_time: 0, add_time: 0,
  value: [{ id: 'note', name: 'texts', titleConfig: { value: '配送备注' }, titleShow: { val: true } }] };
export async function getSupplierProductSystemFormCatalog(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('留言模板读取已取消', 'AbortError');
  return parseSupplierProductSystemFormCatalog(previewMode ? [{ id: 1, name: sample.name }]
    : await apiRequest<unknown>({ method: 'GET', url: '/form/all_system_form', signal }));
}
export async function getSupplierProductSystemFormPreview(id: number, signal?: AbortSignal) {
  if (!productSystemFormId(id)) throw Error('请选择留言模板');
  if (signal?.aborted) throw new DOMException('留言模板读取已取消', 'AbortError');
  return parseSupplierProductSystemFormInfo(previewMode ? { info: sample }
    : await apiRequest<unknown>({ method: 'GET', url: `/form/info/${id}`, signal }), id);
}
