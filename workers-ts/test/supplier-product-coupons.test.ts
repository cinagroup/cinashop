import { describe, expect, it } from 'vitest';
import { supplierCouponCatalogQuery, supplierProductCouponInput } from '@/services/supplier/SupplierProductCoupons';
import { requiredSupplierPermissions } from '@/services/supplier/SupplierPermissionService';
import { productCouponEditor, productCouponPayload, productCouponCatalog, productCouponIds } from '../../view/supplier-ts/src/utils/productCoupons';
const selection = { version: 1, ids: [1, 2], entries: [{ id: 1, title: '有效券', available: true }, { id: 2, title: '历史缺失券', available: false }], consistent: true, truncated: false };
describe('Supplier product coupon author and selection', () => {
  it('preserves omission while normalizing explicit issuance IDs and clear', () => {
    expect(supplierProductCouponInput({})).toBeUndefined();
    expect(supplierProductCouponInput({ coupon_ids: undefined })).toBeUndefined();
    expect(supplierProductCouponInput(Object.create({ coupon_ids: [9] }))).toBeUndefined();
    expect(supplierProductCouponInput({ coupon_ids: [2, '1', 2] })).toEqual([1, 2]);
    expect(supplierProductCouponInput({ coupon_ids: '2,1' })).toEqual([1, 2]);
    expect(supplierProductCouponInput({ coupon_ids: '' })).toEqual([]);
    expect(supplierProductCouponInput({ coupon_ids: [] })).toEqual([]);
  });
  it.each([null, false, {}, [0], [-1], ['bad'], [2147483648], Array(101).fill(1)])
  ('rejects malformed or excessive intent %j', value => expect(() => supplierProductCouponInput({ coupon_ids: value })).toThrow('优惠券'));
  it('bounds literal catalogue queries without granting alternate scope through parameters', () => {
    expect(supplierCouponCatalogQuery(new URLSearchParams())).toEqual({ page: 1, limit: 20, keyword: '' });
    expect(supplierCouponCatalogQuery(new URLSearchParams('page=2&limit=50&keyword=%25_'))).toEqual({ page: 2, limit: 50, keyword: '%_' });
  });
  it.each(['page=0', 'page=-1', 'page=1&page=2', 'limit=51', 'supplier_id=8', 'is_del=1', 'keyword='+ 'x'.repeat(129)])
  ('rejects unsupported catalogue query %s', query => expect(() => supplierCouponCatalogQuery(new URLSearchParams(query))).toThrow());
  it('maps only exact read catalogue routes to product view', () => {
    expect(requiredSupplierPermissions('GET', '/supplierapi/product/coupon/catalog')).toEqual(['supplier.product.view']);
    expect(requiredSupplierPermissions('HEAD', '/supplierapi/product/coupon/catalog')).toEqual(['supplier.product.view']);
    expect(requiredSupplierPermissions('POST', '/supplierapi/product/coupon/catalog')).toBeNull();
    expect(requiredSupplierPermissions('GET', '/supplierapi/product/coupon/delete/1')).toBeNull();
  });
  it('does not turn historical read state or old missing state into replacement intent', () => {
    const editor = productCouponEditor(selection);
    expect(editor.ids).toEqual([1, 2]); expect(productCouponPayload(editor)).toEqual({});
    expect(productCouponPayload({ ...editor, changed: true, ids: [] })).toEqual({ coupon_ids: [] });
    expect(productCouponPayload({ ...editor, changed: true, ids: [3, 1, 3] })).toEqual({ coupon_ids: [1, 3] });
    expect(productCouponEditor(undefined, true).ready).toBe(true);
    expect(productCouponPayload({ ...productCouponEditor(), changed: true, ids: [9] })).toEqual({});
    expect(productCouponEditor({ ...selection, consistent: false, truncated: true }).ready).toBe(true);
  });
  it.each([null, [], {}, { ...selection, version: 2 }, { ...selection, ids: [2, 1] }, { ...selection, ids: [1, 1] }, { ...selection, entries: [] }, { ...selection, extra: true }])
  ('refuses corrupt selection contract %j', raw => expect(() => productCouponEditor(raw)).toThrow());
  it.each([[true], ['1'], [0], [-1], [1.1], [2147483648], Array(101).fill(1)])
  ('refuses unsafe frontend IDs %j', raw => expect(() => productCouponIds(raw)).toThrow());
  it('accepts complete Unicode titles at the database character limit without treating surrogate pairs as extra characters', () => {
    const title = '🎁'.repeat(255);
    expect(productCouponEditor({ version: 1, ids: [1], entries: [{ id: 1, title, available: true }], consistent: true, truncated: false }).selection!.entries[0].title).toBe(title);
    expect(productCouponCatalog({ version: 1, list: [{ id: 1, title, status: 1, coupon_price: '5.00', use_min_price: '10.00', discount_type: 1 }], count: 1, page: 1, limit: 20 }).list[0].title).toBe(title);
  });
  it('accepts undeleted catalogue choices including disabled issuance without promising grant', () => {
    const raw = { version: 1, list: [{ id: 1, title: '暂时停用', status: 0, coupon_price: '5.00', use_min_price: '20.00', discount_type: 1 }], count: 1, page: 1, limit: 20 };
    expect(productCouponCatalog(raw)).toEqual(raw);
    expect(() => productCouponCatalog({ ...raw, limit: 51 })).toThrow('目录响应');
    expect(() => productCouponCatalog({ ...raw, list: [...raw.list, ...raw.list] })).toThrow('目录响应');
  });
});
