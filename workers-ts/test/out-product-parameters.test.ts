import { describe, expect, it } from 'vitest';
import { outProductParameterInput, outProductParameterRelationsMatch, outProductParameterTemplateOwned } from '../src/services/out/OutProductParameterBindings';
import { normalizeOutPhysicalProductInput } from '../src/services/out/OutProductService';
import { outRequestHash } from '../src/services/out/OutIdempotency';
const product = { product_type: 0, supplier_id: 0, cate_id: [10], store_name: '参数商品', slider_image: ['/test.png'],
  delivery_type: [1], freight: 1, spec_type: 0, attrs: [{ suk: '默认', price: '10.00', stock: 8, bar_code: 'PARAM-1' }] };
describe('Out parameter intent and platform selection', () => {
  it('keeps omission and explicit undefined absent while binding explicit empty and selected intent into replay hashes', async () => {
    const omitted = normalizeOutPhysicalProductInput(product);
    expect(Object.hasOwn(omitted, 'parameters')).toBe(false);
    expect(normalizeOutPhysicalProductInput({ ...product, specs: undefined, specs_id: undefined })).toEqual(omitted);
    const empty = normalizeOutPhysicalProductInput({ ...product, specs: [], specs_id: 0 });
    expect(empty.parameters).toEqual({ specs_id: 0, specs: [] });
    expect(await outRequestHash(empty)).not.toBe(await outRequestHash(omitted));
    const selected = normalizeOutPhysicalProductInput({ ...product, specs_id: '600', specs: [{ name: ' 材质 ', value: '棉', sort: '-2', type: 2, relation_id: 44 }] });
    expect(selected.parameters).toEqual({ specs_id: 600, specs: [{ id: 0, temp_id: 0, name: ' 材质 ', value: '棉', sort: -2 }] });
    expect(await outRequestHash(selected)).not.toBe(await outRequestHash(empty));
    expect(selected).toEqual(normalizeOutPhysicalProductInput({ ...product, specs_id: 600, specs: [{ name: ' 材质 ', value: '棉', sort: -2 }] }));
  });
  it.each([{ specs_id: 1 }, { specs: [] }, { specs_id: null, specs: [] }, { specs_id: '0600', specs: [] },
    { specs_id: 2147483648, specs: [] }, { specs_id: 0, specs: null }, { specs_id: 0, specs: '[ ]' },
    { specs_id: 0, specs: [{ name: '0', value: '棉' }] }, { specs_id: 0, specs: [{ name: '材质', value: '\n' }] },
    { specs_id: 0, specs: Array(101).fill({ name: '材质', value: '棉' }) }])('rejects incomplete or malformed intent before SQL: %j', value => {
    expect(() => normalizeOutPhysicalProductInput({ ...product, ...value })).toThrow('参数');
  });
  it('keeps free-form five-key snapshot values independent of catalog child identities', () => {
    expect(outProductParameterInput({ specs_id: 0, specs: [{ id: 999, temp_id: 888, name: '😀', value: ' 自写值 ', sort: -2147483648 }] }))
      .toEqual({ specs_id: 0, specs: [{ id: 999, temp_id: 888, name: '😀', value: ' 自写值 ', sort: -2147483648 }] });
  });
  it('admits only platform group3 owner0 and preserves the existing lack of an isShow restriction', () => {
    expect(outProductParameterTemplateOwned({ type: 0, relationId: 0, group: 3, ownerId: 0 })).toBe(true);
    for (const bad of [{ type: 2, relationId: 0, group: 3, ownerId: 0 }, { type: 0, relationId: 44, group: 3, ownerId: 0 },
      { type: 0, relationId: 0, group: 2, ownerId: 0 }, { type: 0, relationId: 0, group: 3, ownerId: 7 }]) expect(outProductParameterTemplateOwned(bad)).toBe(false);
  });
  it('accepts the Out show/hide relationship states but refuses mismatched, duplicate and malformed relationships', () => {
    const row = { relationId: 600, relationPid: 0, status: 1 };
    expect(outProductParameterRelationsMatch(0, [])).toBe(true);
    expect(outProductParameterRelationsMatch(600, [row])).toBe(true);
    expect(outProductParameterRelationsMatch(600, [{ ...row, status: 0 }])).toBe(true);
    for (const rows of [[], [row, row], [{ ...row, relationId: 601 }], [{ ...row, relationPid: 1 }], [{ ...row, status: 2 }]]) expect(outProductParameterRelationsMatch(600, rows)).toBe(false);
    expect(outProductParameterRelationsMatch(0, [row])).toBe(false);
    expect(outProductParameterRelationsMatch(-1, [])).toBe(false);
  });
});
