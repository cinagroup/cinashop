import { ValidateException } from '@/utils/errors';
import { normalizeProductWordColor } from '@/services/product/ProductWordsService';
import { seckillTimePicture } from '@/services/activity/SeckillTimeAssetPolicy';

const MAX_ID = 2147483647;
export interface ProductLabelInput { labelCate: number; labelName: string; styleType: number; color: string;
  bgColor: string; borderColor: string; icon: string; isShow: number; status: number; sort: number }
export interface ProductLabelQuery { page: number; limit: number; offset: number; category?: number; pattern?: string }
export function labelId(value: unknown, zero = false): number {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^(?:0|[1-9]\d{0,9})$/.test(String(value))) throw new ValidateException('标签或分组ID错误');
  const id = Number(value);
  if (id > MAX_ID || !zero && id === 0) throw new ValidateException('标签或分组ID错误');
  return id;
}
export function labelFlag(value: unknown): number {
  if (value === 0 || value === '0') return 0;
  if (value === 1 || value === '1') return 1;
  throw new ValidateException('标签状态只能为0或1');
}
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('标签提交格式错误');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !allowed.includes(key))) throw new ValidateException('标签提交包含未知字段');
  return row;
}
function name(value: unknown, max: number): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new ValidateException('名称格式错误');
  const text = value.trim();
  if (!text || [...text].length > max) throw new ValidateException(`名称必须为1至${max}个字符`);
  return text;
}
function sort(value: unknown): number { return value === undefined || value === '' ? 0 : labelId(value, true); }
export function parseLabelCategoryInput(body: unknown): { name: string; sort: number } {
  const row = object(body, ['name','sort']); return { name: name(row.name, 30), sort: sort(row.sort) };
}
export function normalizeLabelIcon(value: unknown): string {
  if (value === undefined || value === '') return '';
  const icon = seckillTimePicture(value);
  if (/^\/(?:adminapi|supplierapi|kefuapi)(?:\/|$)/i.test(icon)) throw new ValidateException('图标不能使用私有后台预览地址');
  if (icon.startsWith('/api/assets/')) return icon;
  if (icon.startsWith('/')) {
    if (/[?#]/.test(icon) || /^\/(?:api|outapi)\//i.test(icon)) throw new ValidateException('图标必须是长期公共图片路径');
    return icon;
  }
  const url = new URL(icon);
  if (url.search || url.hash || /^\/(?:adminapi|supplierapi|kefuapi|api\/assets)(?:\/|$)/i.test(url.pathname)) {
    throw new ValidateException('图标不能使用过期签名或私有预览地址');
  }
  return icon;
}
export function parseProductLabelInput(body: unknown): ProductLabelInput {
  const row = object(body, ['label_cate','label_name','style_type','color','bg_color','border_color','icon','is_show','status','sort']);
  const styleType = row.style_type === undefined ? 1 : labelId(row.style_type);
  if (![1,2].includes(styleType)) throw new ValidateException('标签样式只能为文字或图片');
  const icon = normalizeLabelIcon(row.icon);
  if (styleType === 2 && !icon) throw new ValidateException('请选择图片标签图标');
  return { labelCate: labelId(row.label_cate), labelName: name(row.label_name, 20), styleType,
    color: normalizeProductWordColor(row.color, '字体颜色'), bgColor: normalizeProductWordColor(row.bg_color, '背景颜色'),
    borderColor: normalizeProductWordColor(row.border_color, '边框颜色'), icon,
    isShow: row.is_show === undefined ? 1 : labelFlag(row.is_show), status: row.status === undefined ? 1 : labelFlag(row.status), sort: sort(row.sort) };
}
export function parseProductLabelQuery(query: URLSearchParams, categories = false): ProductLabelQuery {
  const allowed = categories ? ['page','limit','name'] : ['page','limit','label_cate'];
  for (const key of query.keys()) if (!allowed.includes(key) || query.getAll(key).length !== 1) throw new ValidateException('标签查询参数未知或重复');
  const page = query.has('page') ? labelId(query.get('page')) : 1, limit = query.has('limit') ? labelId(query.get('limit')) : 20;
  const offset = (page - 1) * limit;
  if (limit > 100 || offset > 10000) throw new ValidateException('标签分页超出读取上限');
  const raw = query.get('name') ?? '';
  if (raw.length > 64 || /[\u0000-\u001f\u007f]/u.test(raw)) throw new ValidateException('分组查询名称错误');
  const keyword = raw.trim(), category = query.get('label_cate') ?? '';
  return { page, limit, offset, category: category && category !== '0' ? labelId(category) : undefined,
    pattern: keyword ? `%${keyword.replace(/[\\%_]/g, '\\$&')}%` : undefined };
}
export function parseLabelBatch(body: unknown): { all: boolean; ids: number[]; category?: number } {
  const row = object(body, ['ids','all','where']);
  const all = row.all === undefined ? false : labelFlag(row.all) === 1;
  const rawIds = row.ids === undefined || row.ids === '' ? [] : typeof row.ids === 'string' ? row.ids.split(',') : row.ids;
  if (!Array.isArray(rawIds) || rawIds.length > 50 || !all && !rawIds.length) throw new ValidateException('请选择1至50个标签');
  const ids = [...new Set(rawIds.map(value => labelId(value)))].sort((a,b) => a-b);
  let category: number | undefined;
  if (row.where !== undefined && row.where !== '' && row.where !== 0) {
    const filter = typeof row.where === 'object' ? object(row.where, ['label_cate']) : { label_cate: row.where };
    if (filter.label_cate !== undefined && filter.label_cate !== '' && filter.label_cate !== 0 && filter.label_cate !== '0') category = labelId(filter.label_cate);
  }
  if (all && ids.length) throw new ValidateException('全部删除与明确标签ID不能同时提交');
  return { all, ids, category };
}
