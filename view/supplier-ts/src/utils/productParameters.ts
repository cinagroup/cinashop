import type { SupplierProductParameterDraft, SupplierProductParameterRow, SupplierProductParameterSelection, SupplierProductParameterTemplate } from '@/types/productParameters';
const int4 = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= -2_147_483_648 && value <= 2_147_483_647;
const identity = (value: unknown): value is number => int4(value) && value >= 0;
const positive = (value: unknown): value is number => identity(value) && value > 0;
const rawLimit = 1_048_576;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('商品参数资料无效，请重新读取');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]) { return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)); }
function legacyInteger(value: unknown, signed = false): number {
  if (typeof value === 'string' && (signed ? /^(?:0|-?[1-9]\d*)$/ : /^(?:0|[1-9]\d*)$/).test(value)) value = Number(value);
  if (!(signed ? int4(value) : identity(value))) throw Error('商品参数编号或排序无效');
  return value as number;
}
function rows(value: unknown, complete: boolean, legacy = false): SupplierProductParameterRow[] {
  if (!Array.isArray(value) || value.length > 100) throw Error('商品参数必须完整填写，最多100项');
  return value.map(raw => {
    const row = record(raw);
    if (!legacy && !keys(row, ['id', 'temp_id', 'name', 'value', 'sort'])) throw Error('商品参数字段无效');
    const id = legacy ? legacyInteger(row.id === undefined ? 0 : row.id) : row.id, tempId = legacy ? legacyInteger(row.temp_id === undefined ? 0 : row.temp_id) : row.temp_id;
    const sort = legacy ? legacyInteger(row.sort === undefined ? 0 : row.sort, true) : row.sort;
    if (!identity(id) || !identity(tempId) || !int4(sort) || typeof row.name !== 'string' || typeof row.value !== 'string') throw Error('商品参数编号、文字或排序无效');
    if (complete && [row.name, row.value].some(text => !text.trim() || text === '0' || [...text].length > 255 || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(text))) throw Error('参数名称和值须为1至255字的单行文字，且不能单独填写0');
    return { id, temp_id: tempId, name: row.name, value: row.value, sort };
  });
}
export function productParameterDraft(value: unknown, complete = false): SupplierProductParameterDraft {
  const row = record(value);
  if (!keys(row, ['specs_id', 'specs']) || !identity(row.specs_id)) throw Error('请选择有效的参数模板或自定义参数');
  return { specs_id: row.specs_id, specs: rows(row.specs, complete) };
}
export function parseSupplierProductParameterCatalog(value: unknown, supplierId: number): SupplierProductParameterTemplate[] {
  if (!positive(supplierId) || !Array.isArray(value) || value.length > 2_000) throw Error('参数模板目录无效或过大，请重新读取');
  const parents = new Set<number>(), children = new Set<number>(); let total = 0;
  return value.map(raw => {
    const item = record(raw);
    if (!keys(item, ['id', 'name', 'specs']) || !positive(item.id) || parents.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || [...item.name].length > 255 || !Array.isArray(item.specs)) throw Error('参数模板目录包含无效项目');
    parents.add(item.id); total += item.specs.length;
    if (total > 2_000) throw Error('参数模板目录超过2000项，请缩小范围');
    let owner: string | undefined;
    const specs = item.specs.map(rawChild => {
      const child = record(rawChild), scope = `${child.type}:${child.relation_id}`;
      if (!keys(child, ['id', 'type', 'relation_id', 'temp_id', 'name', 'value', 'sort', 'status', 'add_time']) || !positive(child.id) || children.has(child.id) || child.temp_id !== item.id
        || !(child.type === 0 && child.relation_id === 0 || child.type === 2 && child.relation_id === supplierId) || owner !== undefined && owner !== scope
        || child.status !== 1 || !int4(child.sort) || !int4(child.add_time) || typeof child.name !== 'string' || !child.name.trim() || [...child.name].length > 255 || typeof child.value !== 'string' || [...child.value].length > 255) throw Error('参数模板包含无效、越界或归属不一致的项目');
      owner = scope; children.add(child.id);
      return { id: child.id, temp_id: item.id as number, name: child.name, value: child.value, sort: child.sort };
    });
    return { id: item.id, name: item.name, specs };
  });
}
export function productParameterDetail(value: { specs_id?: unknown; specs?: unknown; specs_selection?: unknown } = {}): { draft: SupplierProductParameterDraft; selection: SupplierProductParameterSelection | null } {
  if (value.specs_id === undefined && value.specs === undefined && value.specs_selection === undefined) return { draft: { specs_id: 0, specs: [] }, selection: null };
  const draft = productParameterDraft({ specs_id: value.specs_id, specs: value.specs }), row = record(value.specs_selection);
  if (!keys(row, ['specs_id', 'specs', 'consistent', 'available', 'truncated']) || !int4(row.specs_id)
    || !(row.specs === null || typeof row.specs === 'string' && [...row.specs].length <= rawLimit) || typeof row.consistent !== 'boolean' || typeof row.available !== 'boolean' || typeof row.truncated !== 'boolean'
    || row.available && !row.consistent || row.truncated && (row.consistent || row.available || draft.specs.length > 0)) throw Error('商品参数绑定资料不完整，请重新读取');
  if (row.consistent) {
    let raw: unknown = [];
    try { raw = row.specs === null || row.specs === '' ? [] : JSON.parse(row.specs as string); } catch { throw Error('商品参数原始快照无效'); }
    if (row.specs_id !== draft.specs_id || JSON.stringify(rows(raw, true, true)) !== JSON.stringify(draft.specs)) throw Error('商品参数快照与绑定不一致，请重新读取');
  }
  return { draft, selection: { specs_id: row.specs_id, specs: row.specs as string | null, consistent: row.consistent, available: row.available, truncated: row.truncated } };
}
export function productParameterAvailable(options: SupplierProductParameterTemplate[], draft: SupplierProductParameterDraft): boolean { return draft.specs_id === 0 || options.some(item => item.id === draft.specs_id); }
export function productParameterPayload(draft: SupplierProductParameterDraft, changed: boolean): Partial<SupplierProductParameterDraft> { return changed ? productParameterDraft(draft, true) : {}; }
