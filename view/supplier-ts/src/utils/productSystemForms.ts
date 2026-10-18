import { parseOrderSystemFormTemplate } from '../../../common/order-system-form';
import type { SupplierProductSystemFormOption, SupplierProductSystemFormPreview, SupplierProductSystemFormSelection } from '@/types/productSystemForms';
const int4 = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= -2147483648 && value <= 2147483647;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('留言模板资料无效，请重新读取');
  return value as Record<string, unknown>;
};
const keys = (value: Record<string, unknown>, names: string[]) => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || [...value].length > 255 || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value)) throw Error('留言模板名称无效');
  return value;
}
export function productSystemFormId(value: unknown): number {
  if (!int4(value) || value < 0) throw Error('请选择有效的留言模板');
  return value;
}
export function productSystemFormDetail(value: { system_form_id?: unknown; system_form_selection?: unknown } = {}): { id: number; selection: SupplierProductSystemFormSelection | null } {
  if (value.system_form_id === undefined && value.system_form_selection === undefined) return { id: 0, selection: null };
  const id = productSystemFormId(value.system_form_id), selection = record(value.system_form_selection);
  if (!keys(selection, ['system_form_id', 'available']) || !int4(selection.system_form_id) || typeof selection.available !== 'boolean'
    || id !== Math.max(0, selection.system_form_id) || selection.system_form_id < 0 && selection.available) throw Error('留言模板绑定资料无效，请重新读取');
  return { id, selection: { system_form_id: selection.system_form_id, available: selection.available } };
}
export function productSystemFormPayload(id: number, changed: boolean): { system_form_id?: number } {
  return changed ? { system_form_id: productSystemFormId(id) } : {};
}
export function parseSupplierProductSystemFormCatalog(value: unknown): SupplierProductSystemFormOption[] {
  if (!Array.isArray(value) || value.length > 500) throw Error('留言模板目录无效或过大');
  const ids = new Set<number>();
  return value.map(raw => {
    const row = record(raw), id = productSystemFormId(row.id);
    if (!keys(row, ['id', 'name']) || id === 0 || ids.has(id)) throw Error('留言模板目录包含无效或重复项目');
    ids.add(id); return { id, name: name(row.name) };
  });
}
const labels: Record<string, string> = { checkboxs: '多选框', citys: '城市', dates: '日期', dateranges: '日期范围', radios: '单选框', selects: '下拉框', texts: '文本框', times: '时间', timeranges: '时间范围', uploadPicture: '图片' };
export function parseSupplierProductSystemFormInfo(value: unknown, expectedId: number): SupplierProductSystemFormPreview {
  const root = record(value), info = record(root.info);
  if (!keys(root, ['info']) || !keys(info, ['id', 'version', 'name', 'cover_image', 'value', 'default_value', 'status', 'is_del', 'update_time', 'add_time'])
    || !expectedId || productSystemFormId(info.id) !== expectedId || info.status !== 1 || info.is_del !== 0) throw Error('留言模板已变化，请刷新后重新选择');
  const fields = parseOrderSystemFormTemplate(info.value).map((component, index) => {
    const title = component.titleConfig && typeof component.titleConfig === 'object' && !Array.isArray(component.titleConfig) ? (component.titleConfig as Record<string, unknown>).value : undefined;
    const flag = component.titleShow && typeof component.titleShow === 'object' && !Array.isArray(component.titleShow) ? (component.titleShow as Record<string, unknown>).val : undefined;
    return { title: typeof title === 'string' && title.trim() ? title.trim() : `第 ${index + 1} 项`, type: labels[String(component.name)]!, required: flag === true || flag === 1 || flag === '1' };
  });
  return { id: expectedId, name: name(info.name), fields };
}
