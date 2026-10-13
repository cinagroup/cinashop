import type { SupplierProductRuleCatalog, SupplierProductRulePayload, SupplierProductRuleRow, SupplierRuleDimension } from '@/types/productRules';
function invalid(): never { throw Error('规格模板结果无法核对，请重新读取'); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(); return value as Record<string, unknown>; }
function number(value: unknown, zero = false) { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > 2_147_483_647) return invalid(); return value; }
function text(value: unknown, max = 32_768) { if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) return invalid(); return value; }
function revision(value: unknown) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return invalid(); return value; }
function dimensions(value: unknown): SupplierRuleDimension[] {
  if (!Array.isArray(value) || value.length > 1000) return invalid();
  return value.map(value => { const item = object(value); if (!Array.isArray(item.detail) || item.detail.length > 1000) return invalid();
    return { value: text(item.value, 4096), detail: item.detail.map(value => text(value, 4096)) }; });
}
export function parseSupplierProductRuleRow(value: unknown): SupplierProductRuleRow {
  const row = object(value), spec = dimensions(row.spec);
  if (row.type !== 2 || row.rule_value !== null && typeof row.rule_value !== 'string' || !Array.isArray(row.attr_value) || row.attr_value.length !== spec.length) return invalid();
  const attr_name = text(row.attr_name), attr_value = row.attr_value.map(value => text(value));
  if (attr_name !== spec.map(item => item.value).join(',') || JSON.stringify(attr_value) !== JSON.stringify(spec.map(item => item.detail.join(',')))) return invalid();
  return { id: number(row.id), type: 2, relation_id: number(row.relation_id), rule_name: text(row.rule_name, 128),
    rule_value: row.rule_value === null ? null : row.rule_value.length <= 2 * 1024 * 1024 ? row.rule_value : invalid(), attr_name, attr_value, spec, revision: revision(row.revision) };
}
export function parseSupplierProductRuleCatalog(value: unknown): SupplierProductRuleCatalog {
  const data = object(value); if (!Array.isArray(data.list) || data.list.length > 1000) return invalid();
  const list = data.list.map(parseSupplierProductRuleRow), count = number(data.count, true), page = number(data.page, true), limit = number(data.limit, true);
  if (count > 1000 || count < list.length || new Set(list.map(row => row.id)).size !== list.length || new Set(list.map(row => row.relation_id)).size > 1 ||
    (page === 0 ? limit !== 0 || count !== list.length : limit < 1 || limit > 100 || list.length > limit)) return invalid();
  return { list, count, page, limit, revision: revision(data.revision) };
}
export function parseSupplierProductRuleDetail(value: unknown) { return parseSupplierProductRuleRow(object(value).info); }
export function parseSupplierProductRuleTemplates(value: unknown) {
  if (!Array.isArray(value) || value.length > 1000) return invalid();
  return value.map(value => { const row = object(value), decoded = dimensions(row.rule_value), spec = dimensions(row.spec);
    if (JSON.stringify(decoded) !== JSON.stringify(spec)) return invalid();
    const parsed = parseSupplierProductRuleRow({ ...row, rule_value: JSON.stringify(decoded) }); return { ...parsed, rule_value: decoded }; });
}
export function parseSupplierProductRuleReceipt(value: unknown) { const row = object(value); return { id: number(row.id), revision: revision(row.revision) }; }
export function supplierProductRuleDraft(name: string, values: SupplierRuleDimension[], expected?: string): SupplierProductRulePayload {
  const rule_name = name.trim();
  if (!rule_name || rule_name.length > 32 || /[\u0000-\u001f\u007f]/u.test(rule_name)) throw Error('模板名称需为1至32个字符');
  if (!Array.isArray(values) || values.length < 1 || values.length > 3) throw Error('规格维度需为1至3项');
  const spec = values.map(item => {
    const value = item.value.trim(), detail = item.detail.map(value => value.trim());
    if (!value || value.length > 32 || /[\u0000-\u001f\u007f]/u.test(value)) throw Error('请填写1至32个字符的规格名称');
    if (!detail.length || detail.length > 50 || detail.some(value => !value || value.length > 64 || /[\u0000-\u001f\u007f]/u.test(value)) || new Set(detail).size !== detail.length) throw Error('每个规格需为1至50个不重复的有效规格值');
    return { value, detail };
  });
  if (new Set(spec.map(item => item.value)).size !== spec.length) throw Error('规格名称不能重复');
  return { rule_name, spec, ...(expected ? { expected_revision: revision(expected) } : {}) };
}
export function supplierProductRuleMatches(row: SupplierProductRuleRow, payload: SupplierProductRulePayload) {
  return row.rule_name === payload.rule_name && JSON.stringify(row.spec) === JSON.stringify(payload.spec);
}
/** Stages the complete application before the caller touches its product draft. */
export function prepareSupplierProductRuleApplication(spec: SupplierRuleDimension[], max = 200) {
  if (!Number.isSafeInteger(max) || max < 1 || max > 200) throw Error('SKU组合上限无效');
  const items = supplierProductRuleDraft('模板应用', spec).spec;
  let count = 1;
  for (const item of items) { if (count > Math.floor(max / item.detail.length)) throw Error(`SKU组合不能超过${max}项`); count *= item.detail.length; }
  let details: Record<string, string>[] = [{}];
  for (const item of items) details = details.flatMap(previous => item.detail.map(value => ({ ...previous, [item.value]: value })));
  if (details.length !== count || new Set(details.map(detail => Object.values(detail).join(','))).size !== count) throw Error('规格组合名称存在歧义，请调整含逗号的规格值');
  return { items, details };
}
