import type { SupplierProductBrandNode, SupplierProductBrandSelection } from '@/types/productBrands';
const maximum = 2_147_483_647;
const id = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('商品品牌资料无效，请重新读取');
  return value as Record<string, unknown>;
}
export function productBrandPath(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 16 || !value.every(id) || new Set(value).size !== value.length || value.join(',').length > 64)
    throw Error('请选择完整的商品品牌路径');
  return [...value];
}
export function parseSupplierProductBrandCatalog(value: unknown): SupplierProductBrandNode[] {
  const seen = new Set<number>();
  function children(input: unknown, parent: number, depth: number): SupplierProductBrandNode[] {
    if (!Array.isArray(input) || depth > 16) throw Error('商品品牌目录无效，请重新读取');
    return input.map(raw => {
      const row = record(raw);
      if (Object.keys(row).some(key => !['value', 'label', 'pid', 'children'].includes(key)) || !id(row.value)
        || seen.has(row.value) || row.pid !== parent || typeof row.label !== 'string' || !row.label.trim() || row.label.length > 256)
        throw Error('商品品牌目录无效，请重新读取');
      seen.add(row.value); if (seen.size > 1_000) throw Error('商品品牌目录过大，请联系管理员整理');
      return { value: row.value, label: row.label, pid: parent,
        ...(row.children === undefined ? {} : { children: children(row.children, row.value, depth + 1) }) };
    });
  }
  return children(value, 0, 1);
}
export function productBrandAvailable(tree: SupplierProductBrandNode[], raw: unknown): boolean {
  let path: number[]; try { path = productBrandPath(raw); } catch { return false; }
  let nodes = tree;
  for (const value of path) { const node = nodes.find(item => item.value === value); if (!node) return false; nodes = node.children ?? []; }
  return true;
}
export function productBrandDetail(value: { brand_id?: unknown; brand_selection?: unknown } = {}): { path: number[]; selection: SupplierProductBrandSelection | null } {
  if (value.brand_id === undefined && value.brand_selection === undefined) return { path: [], selection: null };
  const path = productBrandPath(value.brand_id), row = record(value.brand_selection);
  if (Object.keys(row).length !== 4 || !Object.hasOwn(row, 'brand_id') || !Object.hasOwn(row, 'brand_com') || !Object.hasOwn(row, 'consistent') || !Object.hasOwn(row, 'available')
    || typeof row.brand_id !== 'number' || !Number.isSafeInteger(row.brand_id) || row.brand_id < -2_147_483_648 || row.brand_id > maximum
    || typeof row.brand_com !== 'string' || [...row.brand_com].length > 64 || typeof row.consistent !== 'boolean' || typeof row.available !== 'boolean'
    || row.available && !row.consistent || row.consistent && (row.brand_com !== path.join(',') || row.brand_id !== (path.at(-1) ?? 0)))
    throw Error('商品品牌绑定资料不完整，请重新读取');
  return { path, selection: { brand_id: row.brand_id, brand_com: row.brand_com, consistent: row.consistent, available: row.available } };
}
export function productBrandPayload(path: number[], changed: boolean): { brand_id?: number[] } {
  return changed ? { brand_id: productBrandPath(path) } : {};
}
