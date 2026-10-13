import { describe, expect, it } from 'vitest';
import { requiredSupplierPermissions } from '@/services/supplier/SupplierPermissionService';

describe('Supplier batch catalog route admission', () => {
  it('keeps selection facts view-only and real application manage-only', () => {
    for (const prefix of ['', '/supplierapi/']) {
      for (const verb of ['GET', 'HEAD']) expect(requiredSupplierPermissions(verb, prefix + 'product/product/batch-selection')).toEqual(['supplier.product.view']);
      expect(requiredSupplierPermissions('POST', prefix + 'product/batch_process')).toEqual(['supplier.product.manage']);
    }
  });
  it('rejects alternate verbs and unknown batch children', () => {
    for (const verb of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH']) expect(requiredSupplierPermissions(verb, 'product/batch_process')).toBeNull();
    for (const verb of ['POST', 'PUT', 'DELETE', 'PATCH']) expect(requiredSupplierPermissions(verb, 'product/product/batch-selection')).toBeNull();
    expect(requiredSupplierPermissions('POST', 'product/batch_process/extra')).toBeNull();
    expect(requiredSupplierPermissions('GET', 'product/product/batch-selection/12')).toBeNull();
  });
});
