import { describe, expect, it } from 'vitest';
import { integralDetailId, integralDetailMoney, integralDetailSpecs, integralPublicH5Origin, projectIntegralDetailSkus, type IntegralSkuSource } from '../src/services/activity/IntegralProductDetailData';
import { integralPublicMediaOwner } from '../src/services/activity/IntegralPublicCatalogPolicy';

const activity = { id: 9, productId: 70, productType: 0, stock: 15, quota: 12 };
const product = { id: 70, productType: 0, stock: 20 };
const sku = (change: Partial<IntegralSkuSource> = {}): IntegralSkuSource => ({ id: 90, productId: 9, productType: 0, unique: 'point009', suk: '蓝', image: '/safe.png',
  price: '4.25', otPrice: '35.00', integral: 10, stock: 8, quota: 6, isRetired: 0, ...change });
const base = (change: Partial<IntegralSkuSource> = {}) => sku({ id: 81, productId: 70, unique: 'blue0070', stock: 10, quota: 0, ...change });
describe('integral product detail safe projection', () => {
  it('accepts only canonical positive INT32 activity identity and exact decimal amounts', () => {
    expect(integralDetailId('2147483647')).toBe(2147483647);
    for (const value of ['09', '9.0', '1e1', ' 9', '0', '-1', '2147483648', 1.5, null]) expect(() => integralDetailId(value)).toThrow();
    expect(integralDetailMoney('4.2')).toBe('4.20'); expect(integralDetailMoney('9999999999.99')).toBe('9999999999.99');
    for (const value of ['NaN', 'Infinity', '-1.00', '01.00', '1e2', '1.001', 4.25]) expect(integralDetailMoney(value)).toBeNull();
  });
  it('uses all six inventory counters and the selected SKU cash/points rather than root summary', () => {
    const values = [activity.stock, activity.quota, product.stock, sku().stock, sku().quota, base().stock];
    for (let index = 0; index < values.length; index++) {
      const a = { ...activity }, p = { ...product }, s = sku(), b = base();
      if (index === 0) a.stock = 2; if (index === 1) a.quota = 2; if (index === 2) p.stock = 2;
      if (index === 3) s.stock = 2; if (index === 4) s.quota = 2; if (index === 5) b.stock = 2;
      expect(projectIntegralDetailSkus(a, p, [s], [b])[0]).toMatchObject({ price: '4.25', integral: 10, stock: 2, purchasable: true });
    }
  });
  it('retains a safe sold-out SKU while blocking malformed amount/points and retired source', () => {
    expect(projectIntegralDetailSkus(activity, product, [sku({ quota: 0 })], [base()])[0]).toMatchObject({ stock: 0, purchasable: false, issues: [] });
    for (const change of [{ price: 'NaN' }, { integral: -1 }, { integral: 0, price: '0.00' }, { stock: -1 }, { isRetired: 1 }]) {
      const row = projectIntegralDetailSkus(activity, product, [sku(change)], [base()])[0];
      expect(row.stock).toBe(0); expect(row.purchasable).toBe(false); expect(row.issues.length).toBeGreaterThan(0);
    }
    expect(projectIntegralDetailSkus(activity, product, [sku({ integral: 0 })], [base()])[0].purchasable).toBe(true);
  });
  it('rejects ambiguous combinations, conflicting legacy tokens and missing/retired base pairs', () => {
    for (const [activities, bases] of [
      [[sku(), sku({ id: 91, unique: 'other009' })], [base()]],
      [[sku()], [base(), base({ id: 82, unique: 'other070' })]],
      [[sku()], [base(), base({ id: 82, unique: 'point009', suk: '红' })]],
      [[sku()], []], [[sku()], [base({ isRetired: 1 })]],
    ] as Array<[IntegralSkuSource[], IntegralSkuSource[]]>) {
      expect(projectIntegralDetailSkus(activity, product, activities, bases).every(row => !row.purchasable && row.issues.length > 0)).toBe(true);
    }
  });
  it('strips only native char padding and emits disabled safe identity for damaged history', () => {
    expect(projectIntegralDetailSkus(activity, product, [sku({ unique: 'abc     ' })], [base()])[0].unique).toBe('abc');
    const row = projectIntegralDetailSkus(activity, product, [sku({ unique: 'a\n', suk: '蓝\n' })], [base()])[0];
    expect(row).toMatchObject({ unique: '', suk: '', stock: 0, purchasable: false });
  });
  it('projects only named specification fields and diagnoses malformed/duplicate JSON keys', () => {
    const issues: string[] = [];
    expect(integralDetailSpecs('[{"name":"材质","value":"纯棉","sort":2,"private":"ignore"}]', issues)).toEqual([{ name: '材质', value: '纯棉', sort: 2 }]);
    expect(integralDetailSpecs('[{"name":"a","name":"b","value":"c"}]', issues)).toEqual([]); expect(issues).toContain('specs_invalid');
  });
  it('keeps persisted store identity separate from its existing platform media scope', () => {
    expect(integralPublicMediaOwner(0, 0)).toEqual({ type: 0, relationId: 0 });
    expect(integralPublicMediaOwner(1, 77)).toEqual({ type: 0, relationId: 0 });
    expect(integralPublicMediaOwner(2, 88)).toEqual({ type: 2, relationId: 88 });
  });
  it('accepts only the explicit canonical HTTPS DNS H5 origin for public sharing', () => {
    expect(integralPublicH5Origin('https://cinashop-h5.pages.dev')).toBe('https://cinashop-h5.pages.dev');
    for (const value of [undefined, '', 'http://example.com', 'https://127.0.0.1', 'https://[::1]', 'https://user@example.com',
      'https://example.com:443', 'https://example.com:8443', 'https://example.com/', 'https://example.com/path', 'https://example.com?q=1',
      'https://example.com#x', ' https://example.com', 'https://EXAMPLE.com', 'https://example.com\\evil', 'https://example.com\n']) expect(integralPublicH5Origin(value)).toBe('');
  });
});
