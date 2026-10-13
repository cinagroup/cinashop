import { describe, expect, it } from 'vitest';
import { requiredSupplierPermissions } from '@/services/supplier/SupplierPermissionService';

describe('supplier category exact permission contracts', () => {
  it('keeps every list, selector, detail and dynamic form a read grant', () => {
    const reads = ['product/category', 'product/category/tree', 'product/category/tree/0', 'product/category/tree/1',
      'product/category/tree/2', 'product/category/cascader_list', 'product/category/cascader_list/1',
      'product/category/cascader_list/2', 'product/category/create', 'product/category/12', 'product/category/12/detail'];
    for (const path of reads) for (const method of ['GET', 'HEAD']) expect(requiredSupplierPermissions(method, `/supplierapi/${path}`)).toEqual(['supplier.product.view']);
  });
  it('requires product management for each actual mutation', () => {
    for (const [method, path] of [['POST', 'product/category'], ['PUT', 'product/category/12'],
      ['DELETE', 'product/category/12'], ['PUT', 'product/category/set_show/12/0'], ['PUT', 'product/category/set_show/12/1']]) {
      expect(requiredSupplierPermissions(method, path)).toEqual(['supplier.product.manage']);
    }
    expect(requiredSupplierPermissions('PUT', 'product/category/set_show/:id/:is_show')).toEqual(['supplier.product.manage']);
    expect(requiredSupplierPermissions('GET', 'product/category/:id')).toEqual(['supplier.product.view']);
  });
  it('denies unproved quick-edit, extra children and wrong mutation verbs', () => {
    for (const [method, path] of [['GET', 'product/category/set_category/12'], ['GET', 'product/category/set_show/12/1'],
      ['POST', 'product/category/set_show/12/1'], ['PATCH', 'product/category/12'], ['DELETE', 'product/category/create'],
      ['PUT', 'product/category/set_show/12/2'], ['GET', 'product/category/12/extra'], ['POST', 'product/category/tree'],
      ['GET', 'product/category/tree/99']]) expect(requiredSupplierPermissions(method, path), `${method} ${path}`).toBeNull();
  });
});
