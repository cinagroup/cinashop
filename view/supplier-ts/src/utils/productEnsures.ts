import type { SupplierProductEnsureOption, SupplierProductEnsureSelection } from '@/types/productEnsures';
const maximum = 2_147_483_647;
const id = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum;
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= -2_147_483_648 && value <= maximum;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('商品保障资料无效，请重新读取');
  return value as Record<string, unknown>;
}
export function productEnsureIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 200 || !value.every(id) || new Set(value).size !== value.length) throw Error('请选择有效的服务保障，最多200项');
  return [...value];
}
export function parseSupplierProductEnsureCatalog(value: unknown, supplierId: number): SupplierProductEnsureOption[] {
  if (!id(supplierId) || !Array.isArray(value) || value.length > 2_000) throw Error('服务保障目录无效或过大，请重新读取');
  const seen = new Set<number>(), keys = ['id', 'type', 'relation_id', 'name', 'image', 'desc', 'sort', 'status', 'add_time'];
  return value.map(raw => {
    const row = record(raw);
    if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)) || !id(row.id) || seen.has(row.id)
      || !(row.type === 0 && row.relation_id === 0 || row.type === 2 && row.relation_id === supplierId) || row.status !== 1
      || typeof row.name !== 'string' || !row.name.trim() || [...row.name].length > 255
      || !['image', 'desc'].every(key => typeof row[key] === 'string' && [...row[key] as string].length <= 255)
      || !integer(row.sort) || !integer(row.add_time)) throw Error('服务保障目录包含无效或越界项目，请重新读取');
    seen.add(row.id); return { id: row.id, name: row.name };
  });
}
export function productEnsureAvailable(options: SupplierProductEnsureOption[], raw: unknown, retained: number[] = []): boolean {
  let ids: number[]; try { ids = productEnsureIds(raw); retained = productEnsureIds(retained); } catch { return false; }
  const allowed = new Set([...options.map(row => row.id), ...retained]);
  return ids.every(value => allowed.has(value));
}
export function productEnsureDetail(value: { ensure_id?: unknown; ensure_selection?: unknown } = {}): { ids: number[]; selection: SupplierProductEnsureSelection | null } {
  if (value.ensure_id === undefined && value.ensure_selection === undefined) return { ids: [], selection: null };
  const ids = productEnsureIds(value.ensure_id), row = record(value.ensure_selection), retained = productEnsureIds(row.retained_ids);
  if (Object.keys(row).length !== 5 || !['ensure_id', 'consistent', 'available', 'retained_ids', 'truncated'].every(key => Object.hasOwn(row, key))
    || !(row.ensure_id === null || typeof row.ensure_id === 'string' && [...row.ensure_id].length <= 4_096)
    || typeof row.consistent !== 'boolean' || typeof row.available !== 'boolean' || typeof row.truncated !== 'boolean'
    || row.available && (!row.consistent || retained.length > 0) || row.truncated && (row.consistent || row.available || ids.length > 0)
    || retained.some(id => !ids.includes(id)) || !row.consistent && retained.length > 0
    || row.consistent && (row.ensure_id ?? '') !== ids.join(',')) throw Error('商品保障绑定资料不完整，请重新读取');
  return { ids, selection: { ensure_id: row.ensure_id as string | null, consistent: row.consistent, available: row.available, retained_ids: retained, truncated: row.truncated } };
}
export function productEnsurePayload(ids: number[], changed: boolean): { ensure_id?: number[] } { return changed ? { ensure_id: productEnsureIds(ids) } : {}; }
