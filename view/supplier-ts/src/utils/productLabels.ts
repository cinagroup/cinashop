import type { SupplierProductLabelCatalog, SupplierProductLabelForm, SupplierProductLabelReceipt, SupplierProductLabelRow,
  SupplierProductLabelTreeGroup, SupplierProductLabelPayload } from '@/types/productLabels';

function invalid(): never { throw Error('商品标签结果无法核对，请刷新后再操作'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function integer(value: unknown, zero = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > 2_147_483_647) return invalid();
  return value;
}
function signedInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) return invalid(); return value;
}
function text(value: unknown, maximum = 255): string {
  if (typeof value !== 'string' || value.length > maximum) return invalid(); return value;
}
function revision(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return invalid(); return value; }
function flag(value: unknown): number { if (value !== 0 && value !== 1) return invalid(); return value; }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') return invalid(); return value; }
function array(value: unknown, maximum: number): unknown[] { if (!Array.isArray(value) || value.length > maximum) return invalid(); return value; }
function owner(row: Record<string, unknown>, supplierOnly = false): { type: 0 | 2; relation_id: number } {
  if (row.type !== 2 && (supplierOnly || row.type !== 0)) return invalid();
  const relation_id = integer(row.relation_id, row.type === 0);
  if (row.type === 0 && relation_id !== 0) return invalid(); return { type: row.type, relation_id };
}

export function parseSupplierProductLabelCatalog(value: unknown): SupplierProductLabelCatalog {
  const root = object(value);
  const groups = array(root.groups, 1000).map(value => { const row = object(value); return { id: integer(row.id), name: text(row.name), ...owner(row), is_show: flag(row.is_show) }; });
  const list = array(root.list, 2000).map(value => {
    const row = object(value); const scope = owner(row, true);
    return { id: integer(row.id), type: 2 as const, relation_id: scope.relation_id, label_cate: integer(row.label_cate, true), label_name: text(row.label_name),
      style_type: integer(row.style_type, true), color: text(row.color, 32), bg_color: text(row.bg_color, 32), border_color: text(row.border_color, 32), icon: text(row.icon),
      is_show: flag(row.is_show), status: flag(row.status), sort: signedInteger(row.sort), add_time: text(row.add_time, 32), group_name: text(row.group_name),
      group_valid: boolean(row.group_valid), selectable: boolean(row.selectable), revision: revision(row.revision) };
  });
  if (integer(root.count, true) !== list.length || new Set(list.map(row => row.id)).size !== list.length || new Set(groups.map(row => row.id)).size !== groups.length ||
    new Set(list.map(row => row.relation_id)).size > 1) return invalid();
  return { count: list.length, revision: revision(root.revision), groups, list };
}
export function parseSupplierProductLabelReceipt(value: unknown): SupplierProductLabelReceipt {
  const row = object(value); return { id: integer(row.id), revision: revision(row.revision) };
}
export function parseSupplierProductLabelForm(value: unknown): SupplierProductLabelForm {
  const root = object(value), rules = array(root.rules, 2);
  if (root.method !== 'POST' || root.action !== 'product/label/0' || rules.length !== 2) return invalid();
  const group = object(rules[0]), name = object(rules[1]);
  if (group.type !== 'select' || group.field !== 'label_cate' || group.value !== '' || name.type !== 'input' || name.field !== 'label_name' || name.value !== '' || object(name.props).maxlength !== 20) return invalid();
  const options = array(group.options, 1000).map(value => { const row = object(value); return { label: text(row.label), value: integer(row.value) }; });
  if (new Set(options.map(row => row.value)).size !== options.length) return invalid();
  return { title: text(root.title), method: 'POST', action: 'product/label/0', rules: [
    { type: 'select', field: 'label_cate', title: text(group.title), value: '', options },
    { type: 'input', field: 'label_name', title: text(name.title), value: '', props: { maxlength: 20 } },
  ] };
}
export function parseSupplierProductLabelTree(value: unknown): SupplierProductLabelTreeGroup[] {
  return array(value, 1000).map(value => {
    const row = object(value), id = integer(row.id), scope = owner(row);
    if (row.value !== id || row.label_cate !== 0) return invalid();
    const children = array(row.children, 5000).map(value => {
      const leaf = object(value), labelId = integer(leaf.id), labelScope = owner(leaf);
      if (leaf.value !== labelId || leaf.label_cate !== id || scope.type === 2 && (labelScope.type !== 2 || labelScope.relation_id !== scope.relation_id)) return invalid();
      return { id: labelId, value: labelId, label: text(leaf.label), label_name: text(leaf.label_name), label_cate: id, ...labelScope };
    });
    return { id, value: id, label: text(row.label), label_name: text(row.label_name), label_cate: 0 as const, ...scope, children };
  });
}
export function supplierProductLabelDraft(group: number | undefined, name: string, expectedRevision?: string): SupplierProductLabelPayload {
  if (!group || !Number.isSafeInteger(group) || group <= 0) throw Error('请选择标签组');
  const label_name = name.trim(); if (!label_name || [...label_name].length > 20 || /[\u0000-\u001f\u007f]/u.test(label_name)) throw Error('请输入1至20个字的标签名称');
  return { label_cate: group, label_name, ...(expectedRevision ? { expected_revision: expectedRevision } : {}) };
}
export function supplierProductLabelMatches(row: SupplierProductLabelRow, payload: SupplierProductLabelPayload): boolean {
  return row.label_cate === payload.label_cate && row.label_name === payload.label_name;
}
