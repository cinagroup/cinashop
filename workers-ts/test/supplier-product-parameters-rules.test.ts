import { describe, expect, it } from 'vitest';
import { SUPPLIER_PARAMETER_RAW_POINTS, supplierProductParameterInput, supplierProductParameterRows,
  supplierProductParameterStored, supplierProductParameterTemplateOwned, supplierProductParameterRelationsMatch } from '@/services/supplier/SupplierProductParameterBindings';
import { supplierProductParameterCopyRows } from '@/services/supplier/SupplierProductParameterCopyCapability';
import { normalizeProductParameterSnapshot } from '@/services/product/ProductAssociationService';
const valid = { name: '材质', value: '棉', sort: 0 };
describe('Supplier PHP free parameter authoring, bounded history and opaque copy boundary', () => {
  it('distinguishes paired omission, clear, template-less snapshot and actual PHP field projection', () => {
    expect(supplierProductParameterInput({})).toBeUndefined(); expect(supplierProductParameterInput({ specs_id: undefined, specs: undefined })).toBeUndefined();
    expect(supplierProductParameterInput({ specs_id: '0', specs: [] })).toEqual({ specs_id: 0, specs: [] });
    expect(supplierProductParameterInput({ specs_id: '0', specs: [{ ...valid, id: '21', temp_id: '301', status: 0, type: 2, relation_id: 99, private: true }] }))
      .toEqual({ specs_id: 0, specs: [{ id: 21, temp_id: 301, ...valid }] });
  });
  it('preserves raw whitespace and PHP truthy padded zero, duplicate names and signed order', () => {
    expect(supplierProductParameterRows([{ name: ' 材质 ', value: ' 0 ', sort: '-2147483648' }, { ...valid, sort: 2147483647 }, valid]))
      .toEqual([{ id: 0, temp_id: 0, name: ' 材质 ', value: ' 0 ', sort: -2147483648 }, { id: 0, temp_id: 0, ...valid, sort: 2147483647 }, { id: 0, temp_id: 0, ...valid }]);
  });
  it('accepts 100 complete Unicode rows, copies every row and never truncates to fit', () => {
    const input = Array.from({ length: 100 }, () => ({ name: '😀'.repeat(255), value: '\\'.repeat(255) }));
    const parsed = supplierProductParameterRows(input); expect(parsed).toHaveLength(100); input[0].name = 'mutated'; expect(parsed[0].name).toBe('😀'.repeat(255));
    expect(() => supplierProductParameterRows([...input, valid])).toThrow();
  });
  it.each([{ specs_id: 1 }, { specs: [] }, { specs_id: undefined, specs: [] }, { specs_id: 0, specs: undefined }, { specs_id: null, specs: [] }, { specs_id: '01', specs: [] },
    { specs_id: -1, specs: [] }, { specs_id: 2147483648, specs: [] }, { specs_id: 0, specs: null }, { specs_id: 0, specs: '{}' }])('rejects incomplete or malformed parameter pairs %j', value => {
    expect(() => supplierProductParameterInput(value)).toThrow();
  });
  it.each([{ ...valid, id: '01' }, { ...valid, temp_id: -1 }, { ...valid, id: null }, { ...valid, temp_id: true },
    { ...valid, name: '' }, { ...valid, name: '  ' }, { ...valid, name: '0' }, { ...valid, value: '0' }, { ...valid, value: false }, { ...valid, value: null }, { ...valid, name: '带\n换行' }, { ...valid, value: '带\u007f控制符' },
    { ...valid, name: '\ud800' }, { ...valid, value: '\udfff' },
    { ...valid, name: '😀'.repeat(256) }, { ...valid, sort: '-0' }, { ...valid, sort: -0 }, { ...valid, sort: '01' }, { ...valid, sort: '+1' }, { ...valid, sort: ' 1' },
    { ...valid, sort: '1e2' }, { ...valid, sort: '1.0' }, { ...valid, sort: -2147483649 }, { ...valid, sort: 2147483648 }, { ...valid, sort: null }, { ...valid, sort: 1.5 }])('rejects malformed five-field row %j', value => {
    expect(() => supplierProductParameterRows([value])).toThrow();
  });
  it.each([null, '', '[]'])('preserves valid empty raw %j', raw => expect(supplierProductParameterStored(raw)).toEqual({ rows: [], raw, parsed: true, truncated: false }));
  it('reads mature four-field history by the actual PHP five-key projection without inventing template name constraints', () => {
    const raw = JSON.stringify([{ name: '自写名称', value: '自写值', sort: -4, status: 0 }]);
    expect(supplierProductParameterStored(raw)).toEqual({ rows: [{ id: 0, temp_id: 0, name: '自写名称', value: '自写值', sort: -4 }], raw, parsed: true, truncated: false });
  });
  it.each(['{bad', '{}', '[null]', '[{"name":"材质","value":""}]', '[{"name":"0","value":"棉"}]'])('keeps bad raw %j without author authority', raw => {
    expect(supplierProductParameterStored(raw)).toEqual({ rows: [], raw, parsed: false, truncated: false });
  });
  it('bounds supplementary history in Unicode points and retains a complete worst-case PHP escaped snapshot', () => {
    const raw = '😀'.repeat(SUPPLIER_PARAMETER_RAW_POINTS + 1), projected = supplierProductParameterStored(raw);
    expect(projected).toMatchObject({ rows: [], parsed: false, truncated: true }); expect([...projected.raw!]).toHaveLength(SUPPLIER_PARAMETER_RAW_POINTS);
    const rows = Array.from({ length: 100 }, () => ({ id: 2147483647, temp_id: 2147483647, name: '😀'.repeat(255), value: '😀'.repeat(255), sort: -2147483648 }));
    const escaped = JSON.stringify(rows).replace(/😀/gu, '\\ud83d\\ude00'); expect(escaped.length).toBeGreaterThan(600_000);
    expect(supplierProductParameterStored(escaped)).toEqual({ rows, raw: escaped, parsed: true, truncated: false });
  });
  it('admits only platform or exact Supplier group3 owner0 without adding an isShow restriction', () => {
    expect(supplierProductParameterTemplateOwned({ type: 0, relationId: 0, group: 3, ownerId: 0 }, 7)).toBe(true);
    expect(supplierProductParameterTemplateOwned({ type: 2, relationId: 7, group: 3, ownerId: 0 }, 7)).toBe(true);
    for (const row of [{ type: 0, relationId: 7, group: 3, ownerId: 0 }, { type: 2, relationId: 8, group: 3, ownerId: 0 }, { type: 2, relationId: 7, group: 2, ownerId: 0 }, { type: 2, relationId: 7, group: 3, ownerId: 1 }]) expect(supplierProductParameterTemplateOwned(row, 7)).toBe(false);
  });
  it('requires exact actual type6 cardinality, status and parent for projection consistency', () => {
    const row = { relationId: 301, relationPid: 0, status: 1 };
    expect(supplierProductParameterRelationsMatch(0, [])).toBe(true); expect(supplierProductParameterRelationsMatch(301, [row])).toBe(true);
    for (const rows of [[], [row, row], [{ ...row, relationPid: 1 }], [{ ...row, status: 0 }], [{ ...row, relationId: 302 }]]) expect(supplierProductParameterRelationsMatch(301, rows)).toBe(false);
    expect(supplierProductParameterRelationsMatch(0, [row])).toBe(false);
  });
  it('keeps the default generic uniqueness/signed-sort rules and rejects fake serialized copy handles', () => {
    expect(() => normalizeProductParameterSnapshot([valid, valid])).toThrow(); expect(() => normalizeProductParameterSnapshot([{ ...valid, sort: -1 }])).toThrow();
    for (const forged of [{}, { supplierId: 7, sourceId: 80, trusted: true }, JSON.parse('{}')]) expect(() => supplierProductParameterCopyRows(forged as never, 0, [valid])).toThrow();
  });
});
