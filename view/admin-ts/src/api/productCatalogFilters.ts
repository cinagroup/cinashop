import request, { getData } from '@/utils/request';

export interface CatalogFilterNode { value: number; label: string; pid: number; children?: CatalogFilterNode[] }
export interface CatalogFilterLabel { id: number; label_name: string; group_name: string }
export interface CatalogFilterSupplier { id: number; supplier_name: string }
const preview = import.meta.env.DEV && new URLSearchParams(window.location.search).get('preview') === '1';
const validId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
function nodes(value: unknown, name: string): CatalogFilterNode[] {
  if (!Array.isArray(value)) throw Error(`${name}候选响应格式错误`);
  const seen = new Set<number>();
  const walk = (rows: unknown[], pid: number, depth: number): CatalogFilterNode[] => {
    if (depth > 3) throw Error(`${name}候选层级超过三级`);
    return rows.map(row => {
      if (!row || typeof row !== 'object') throw Error(`${name}候选响应格式错误`);
      const item = row as Record<string, unknown>;
      if (!validId(item.value) || seen.has(item.value) || seen.size >= 1000 || item.pid !== pid || typeof item.label !== 'string' ||
        item.children !== undefined && !Array.isArray(item.children)) throw Error(`${name}候选响应格式错误`);
      seen.add(item.value);
      return { value: item.value, label: item.label, pid, ...(Array.isArray(item.children) && item.children.length ? { children: walk(item.children, item.value, depth + 1) } : {}) };
    });
  };
  return walk(value, 0, 1);
}
function options<T>(value: unknown, name: string, field: string, capacity: number): T[] {
  if (!Array.isArray(value) || value.length > capacity) throw Error(`${name}候选响应格式错误`);
  const seen = new Set<number>();
  return value.map(row => {
    if (!row || typeof row !== 'object' || !validId(row.id) || seen.has(row.id) || typeof row[field] !== 'string') throw Error(`${name}候选响应格式错误`);
    seen.add(row.id);
    return { id: row.id, [field]: row[field] } as T;
  });
}

export async function apiCatalogFilterCategories(signal?: AbortSignal): Promise<CatalogFilterNode[]> {
  if (preview) return [{ value: 11, label: '家居生活', pid: 0 }, { value: 12, label: '服饰配件', pid: 0 }];
  return nodes(await getData(request.get('/product/category/cascader_list/1', { signal })), '分类');
}
export async function apiCatalogFilterBrands(signal?: AbortSignal): Promise<CatalogFilterNode[]> {
  if (preview) return [{ value: 21, label: 'CINA SELECT', pid: 0 }, { value: 22, label: '清风制造', pid: 0 }];
  return nodes(await getData(request.get('/product/brand/cascader_list/2', { signal })), '品牌');
}
export async function apiCatalogFilterLabels(signal?: AbortSignal): Promise<CatalogFilterLabel[]> {
  if (preview) return [{ id: 31, label_name: '新品', group_name: '商品标签' }, { id: 32, label_name: '平台推荐', group_name: '商品标签' }];
  // The source catalogue popup uses the grouped tree. Its separate flat
  // all_label API also includes orphan labels that this flow cannot select.
  const groups = await getData<unknown>(request.get('/product/product_label', { signal }));
  if (!Array.isArray(groups) || groups.length > 2000) throw Error('标签候选响应格式错误');
  const seenGroups = new Set<number>(), seenLabels = new Set<number>(), result: CatalogFilterLabel[] = [];
  for (const group of groups) {
    if (!group || !validId(group.id) || seenGroups.has(group.id) || group.type !== 0 || group.relation_id !== 0 ||
      typeof group.label_name !== 'string' || !Array.isArray(group.children)) throw Error('标签候选响应格式错误');
    seenGroups.add(group.id);
    for (const label of group.children) {
      if (!label || !validId(label.id) || seenLabels.has(label.id) || seenLabels.size >= 2000 || label.type !== 0 || label.relation_id !== 0 ||
        label.label_cate !== group.id || typeof label.label_name !== 'string') throw Error('标签候选响应格式错误');
      seenLabels.add(label.id); result.push({ id: label.id, label_name: label.label_name, group_name: group.label_name });
    }
  }
  return result;
}
export async function apiCatalogFilterSuppliers(signal?: AbortSignal): Promise<CatalogFilterSupplier[]> {
  if (preview) return [{ id: 20, supplier_name: '预览供应商' }];
  return options(await getData(request.get('/supplier/list', { signal })), '供应商', 'supplier_name', 10000);
}
