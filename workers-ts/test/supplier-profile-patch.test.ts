import { expect, it } from 'vitest';
import { supplierProfilePatch } from '../../view/supplier-ts/src/utils/supplierProfilePatch';
import type { SupplierProfile } from '../../view/supplier-ts/src/types';

const profile = (): SupplierProfile => ({
  id: 1, supplier_name: '原供应商', avatar: '', name: '原联系人',
  phone: '13800138000', email: 'owner@example.com', address: '原地址',
  province: 1, city: 2, area: 3, street: 4, detailed_address: '门牌一',
  sort: 0, is_show: 1, mark: '管理员备注', account: 'primary-a',
});

it('sends only editable fields changed since the Supplier form loaded', () => {
  const original = profile();
  const edited = { ...original, name: '新联系人', province: 11, city: 12,
    area: 13, street: 14, mark: '陈旧备注', is_show: 0 };
  expect(supplierProfilePatch(original, edited)).toEqual({ name: '新联系人' });
  expect(supplierProfilePatch(original, original)).toEqual({});
  expect(supplierProfilePatch(original, { ...original, account: 'renamed' }))
    .toEqual({ account: 'renamed' });
});
