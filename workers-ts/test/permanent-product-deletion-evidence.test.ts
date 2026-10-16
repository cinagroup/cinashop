import { describe, expect, it } from 'vitest';
import { parseSupplierPermanentDeletionFact } from '@/services/product/PermanentProductDeletionEvidence';

const expected = { productId: 81, skuId: 302, skuUnique: 'card0002', supplierId: 20, productType: 1 };
const dependency = { version: 1, kind: 'supplier_product_permanent_delete', owner_type: 2, supplier_id: 20, product_type: 1 };
const row = { productId: 81, skuId: 302, uniqueSnapshot: 'card0002', action: 'permanent_delete', dependencySnapshot: JSON.stringify(dependency) };
describe('exact protected Supplier permanent deletion identity receipt', () => {
  it('accepts the five-field source contract and derives the owner for a mixed-order legacy snapshot', () => {
    expect(Object.keys(dependency)).toHaveLength(5);
    expect(parseSupplierPermanentDeletionFact(row, expected)).toEqual({ skuId: 302, supplierId: 20, productType: 1 });
    expect(parseSupplierPermanentDeletionFact(row, { ...expected, supplierId: undefined })).toEqual({ skuId: 302, supplierId: 20, productType: 1 });
    expect(parseSupplierPermanentDeletionFact(row, { ...expected, skuId: undefined })).toEqual({ skuId: 302, supplierId: 20, productType: 1 });
  });
  it('refuses altered SKU, product, owner, delivery type, action and extra or missing dependency fields', () => {
    for (const changed of [{ productId: 82 }, { skuId: 301 }, { skuUnique: 'card0001' }, { supplierId: 30 }, { supplierId: 0 }, { productType: 0 }])
      expect(parseSupplierPermanentDeletionFact(row, { ...expected, ...changed })).toBeNull();
    for (const changed of [{ version: 2 }, { kind: 'arbitrary_absence' }, { owner_type: 0 }, { supplier_id: 0 }, { supplier_id: '20' }, { product_type: '1' }, { extra: true }])
      expect(parseSupplierPermanentDeletionFact({ ...row, dependencySnapshot: JSON.stringify({ ...dependency, ...changed }) }, expected)).toBeNull();
    expect(parseSupplierPermanentDeletionFact({ ...row, action: 'retire' }, expected)).toBeNull();
    expect(parseSupplierPermanentDeletionFact({ ...row, dependencySnapshot: JSON.stringify({ ...dependency, supplier_id: undefined }) }, expected)).toBeNull();
    expect(parseSupplierPermanentDeletionFact({ ...row, dependencySnapshot: '{broken' }, expected)).toBeNull();
  });
});
