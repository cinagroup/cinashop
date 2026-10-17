import { describe, expect, it } from 'vitest';
import { supplierProductBrandInput, supplierProductBrandPath, supplierProductBrandPathMatches } from '@/services/supplier/SupplierProductBrandBindings';
describe('Supplier product brand complete-path input', () => {
  it('distinguishes omission from explicit empty replacement and detaches valid inputs', () => {
    expect(supplierProductBrandInput({})).toBeUndefined(); expect(supplierProductBrandInput({ brand_id: undefined })).toBeUndefined();
    expect(supplierProductBrandInput({ brand_id: [] })).toEqual([]);
    const ids = [101, 102], result = supplierProductBrandPath(ids); ids.push(103); expect(result).toEqual([101, 102]);
  });
  it.each([null, false, '', '101,102', 101, {}, [0], [-1], [1.5], [2147483648], ['01'], [101, 101], Array.from({ length: 17 }, (_, i) => i + 1),
    [' 101'], ['101 '], ['+101'], ['1e2'], ['101.0'], [''], ['2147483648'], [true], [null], [101, '101'],
    [2147483647,2147483646,2147483645,2147483644,2147483643,2147483642]])('rejects malformed or unrepresentable path %j', value => {
    expect(() => supplierProductBrandPath(value)).toThrow();
  });
  it.each([{ wire: ['101'], expected: [101] }, { wire: ['101','102'], expected: [101,102] },
    { wire: ['101','102','103'], expected: [101,102,103] }, { wire: [101,'102',103], expected: [101,102,103] }])
    ('normalizes the actual PHP Cascader path $wire to numeric IDs', ({ wire, expected }) => {
      expect(supplierProductBrandPath(wire)).toEqual(expected);
      expect(supplierProductBrandInput({ brand_id: wire })).toEqual(expected);
    });
  it('validates root-to-node order and each actual selectable platform ancestor', () => {
    const rows = [{ id: 101, pid: 0, storeId: 0, isShow: 1, isDel: 0 }, { id: 102, pid: 101, storeId: 0, isShow: 1, isDel: 0 }];
    expect(supplierProductBrandPathMatches([101, 102], rows)).toBe(true);
    expect(supplierProductBrandPathMatches([101], [rows[0]])).toBe(true);
    expect(supplierProductBrandPathMatches([], [])).toBe(true);
    expect(supplierProductBrandPathMatches([102, 101], rows)).toBe(false);
    expect(supplierProductBrandPathMatches([102], [rows[1]])).toBe(false);
    for (const override of [{ pid: 999 }, { storeId: 7 }, { isShow: 0 }, { isDel: 1 }])
      expect(supplierProductBrandPathMatches([101, 102], [rows[0], { ...rows[1], ...override }])).toBe(false);
    expect(supplierProductBrandPathMatches([101, 102], [rows[0]])).toBe(false);
  });
});
