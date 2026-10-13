import { ValidateException } from '@/utils/errors';

export const MAX_SUPPLIER_BATCH_PRODUCTS = 100;
export interface SupplierProductBatchFilter {
  store_name?: string; cate_id?: number[]; brand_id?: number[]; store_label_id?: number[];
  status?: number; is_show?: number; is_verify?: number; pid?: number;
  time?: [number, number]; sales?: 'normal' | 'asc' | 'desc';
}
export interface SupplierProductBatchSelection { all: 0 | 1; ids: number[]; where: SupplierProductBatchFilter }
export type SupplierProductBatchChange =
  | { type: 1; cateIds: number[] }
  | { type: 3; deliveryTypes: number[] }
  | { type: 7; formId: number }
  | { type: 8; freight: 1 | 2 | 3; postage: string; templateId: number };
export interface SupplierProductBatchInput extends SupplierProductBatchSelection {
  change: SupplierProductBatchChange; expectedRevision?: string;
}
export function batchRecord(value: unknown, label = '批处理数据'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException(`${label}格式错误`);
  return value as Record<string, unknown>;
}
export function batchInteger(value: unknown, label: string, fallback = 0, maximum = 2_147_483_647): number {
  if (value === undefined || value === null || value === '') return fallback;
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) throw new ValidateException(`${label}错误`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > maximum) throw new ValidateException(`${label}错误`);
  return result;
}
export function batchIds(value: unknown, label: string, maximum: number, allowEmpty = false): number[] {
  if (allowEmpty && (value === undefined || value === '' || value === null)) return [];
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : typeof value === 'number' ? [value] : null;
  if (!raw || raw.length > maximum || (!allowEmpty && !raw.length)) throw new ValidateException(`${label}数量错误`);
  const result = [...new Set(raw.map(item => batchInteger(item, label)))].sort((a, b) => a - b);
  if (result.some(id => id <= 0)) throw new ValidateException(`${label}错误`);
  return result;
}
function boundedText(value: unknown, label: string, maximum: number): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new ValidateException(`${label}错误`);
  return value.trim();
}
function state(value: unknown, label: string, allowed: readonly number[]): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!['string', 'number'].includes(typeof value) || !/^-?\d+$/.test(String(value)) || !allowed.includes(Number(value))) throw new ValidateException(`${label}错误`);
  return Number(value);
}
function range(value: unknown): [number, number] | undefined {
  if (value === undefined || value === '') return undefined;
  const text = boundedText(value, '商品日期', 100), parts = text.split(/\s+(?:-|~|至)\s+|,/).map(item => item.trim()).filter(Boolean);
  if (!parts.length || parts.length > 2) throw new ValidateException('商品日期错误');
  const epoch = (part: string, end: boolean) => {
    if (/^\d{10}$/.test(part)) return Number(part);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(part)) throw new ValidateException('商品日期错误');
    const stamp = Date.parse(`${part}T${end ? '23:59:59' : '00:00:00'}+08:00`);
    if (!Number.isFinite(stamp) || new Date(stamp + 8 * 3600000).toISOString().slice(0, 10) !== part) throw new ValidateException('商品日期错误');
    return stamp / 1000;
  };
  const start = epoch(parts[0], false), end = epoch(parts[1] ?? parts[0], true);
  if (start < 0 || end > 2_147_483_647 || start > end) throw new ValidateException('商品日期错误');
  return [start, end];
}
export function parseSupplierBatchFilter(value: unknown): SupplierProductBatchFilter {
  if (value === undefined || value === '') return {};
  const input = batchRecord(value, '筛选条件');
  const keys = new Set(['store_name', 'cate_id', 'brand_id', 'store_label_id', 'type', 'status', 'is_show', 'is_verify', 'show_type', 'pid', 'data', 'time', 'sales', 'page', 'limit', 'relation_id', 'supplier_id']);
  if (Object.keys(input).some(key => !keys.has(key))) throw new ValidateException('筛选条件包含不支持的字段');
  const result: SupplierProductBatchFilter = {};
  const name = boundedText(input.store_name, '商品关键词', 128); if (name) result.store_name = name;
  for (const key of ['cate_id', 'brand_id', 'store_label_id'] as const) {
    const values = batchIds(input[key] === 0 || input[key] === '0' ? [] : input[key], '商品筛选目录', 50, true); if (values.length) result[key] = values;
  }
  result.status = state(input.type ?? input.status, '商品分组', [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7]);
  result.is_show = state(input.is_show, '上下架状态', [0, 1]);
  result.is_verify = state(input.is_verify, '审核状态', [-2, -1, 0, 1]);
  if (input.show_type !== undefined && input.show_type !== '') throw new ValidateException('当前商品数据不支持展示终端筛选');
  if (input.pid !== undefined && input.pid !== '') result.pid = input.pid === -1 || input.pid === '-1' ? -1 : batchInteger(input.pid, '关联商品');
  result.time = range(input.data ?? input.time);
  if (input.sales !== undefined && input.sales !== '') {
    if (!['normal', 'asc', 'desc'].includes(String(input.sales))) throw new ValidateException('销量排序错误');
    result.sales = input.sales as 'normal' | 'asc' | 'desc';
  }
  return result;
}
export function parseSupplierBatchSelection(value: unknown): SupplierProductBatchSelection {
  const input = batchRecord(value);
  const all = batchInteger(input.all, '全选标记', 0, 1) as 0 | 1;
  return { all, ids: batchIds(input.ids, '商品', MAX_SUPPLIER_BATCH_PRODUCTS, all === 1), where: all ? parseSupplierBatchFilter(input.where) : {} };
}
function postage(value: unknown): string {
  const text = String(value ?? 0);
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(text)) throw new ValidateException('固定运费须为有效两位小数金额');
  const [whole, cents = ''] = text.split('.'); return `${whole}.${cents.padEnd(2, '0')}`;
}
export function parseSupplierProductBatchInput(value: unknown): SupplierProductBatchInput {
  const input = batchRecord(value), selection = parseSupplierBatchSelection(input);
  const type = batchInteger(input.type, '批处理类型', 1);
  if (![1, 3, 7, 8].includes(type)) throw new ValidateException('当前支持分类、物流、自定义留言和运费批处理');
  const data = batchRecord(input.data), expected = input.expected_revision;
  if (expected !== undefined && (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected))) throw new ValidateException('批处理确认版本错误');
  let change: SupplierProductBatchChange;
  if (type === 1) change = { type, cateIds: batchIds(data.cate_id, '分类', 20) };
  else if (type === 3) {
    const deliveryTypes = batchIds(data.delivery_type, '物流方式', 3);
    if (deliveryTypes.some(value => value > 3)) throw new ValidateException('物流方式错误');
    change = { type, deliveryTypes };
  } else if (type === 7) change = { type, formId: batchInteger(data.system_form_id, '自定义表单') };
  else {
    const freight = batchInteger(data.freight, '运费类型', 0, 3) as 1 | 2 | 3;
    if (!freight) throw new ValidateException('请选择运费类型');
    const amount = postage(data.postage), template = batchInteger(data.temp_id, '运费模板');
    if (freight === 2 && amount === '0.00') throw new ValidateException('固定运费必须大于0');
    if (freight === 3 && template === 0) throw new ValidateException('请选择运费模板');
    change = { type: 8, freight, postage: freight === 2 ? amount : '0.00', templateId: freight === 3 ? template : 0 };
  }
  return { ...selection, change, expectedRevision: expected as string | undefined };
}
