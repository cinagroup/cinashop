import { describe, expect, it } from 'vitest';
import { couponIssueCreate, couponIssueQuery, couponIssueRevision } from '../src/services/admin/AdminCouponIssueInput';

const body = (changes: Record<string, unknown> = {}) => ({ title: '普通发行', discount_type: 1, scope_type: 0, category: 0,
  category_id: 0, brand_id: 0, product_ids: [], coupon_price: '5.1', use_min_price: '0', valid_days: 7, use_start_time: null,
  use_end_time: null, start_time: null, end_time: null, receive_type: 1, is_permanent: 0, total_count: 10,
  rule: '第一行\n第二行', status: 1, sort: 0, ...changes });
describe('Independent issuer definitions and query capacity', () => {
  it('keeps discount and scope meanings separate and canonicalizes precise money', () => {
    expect(couponIssueCreate(body({ discount_type: 2, scope_type: 3, brand_id: 4501, coupon_price: '85.99' })))
      .toMatchObject({ discountType: 2, scopeType: 3, brandId: 4501, couponPrice: '85.99', useMinPrice: '0.00', category: 0 });
  });
  it.each([{ scope_type: 1, category_id: 4101 }, { scope_type: 2, product_ids: [4101, 4100] }, { scope_type: 3, brand_id: 4501 }])
    ('supports the complete explicit scope %j', changes => {
      const result = couponIssueCreate(body(changes));
      expect(result.scopeType).toBe(changes.scope_type);
      if (result.scopeType === 2) expect(result.productIds).toBe('4100,4101');
    });
  it.each([{ scope_type: 0, brand_id: 1 }, { scope_type: 1, category_id: 4101, product_ids: [4100] },
    { scope_type: 2, product_ids: [4100, 4100] }, { scope_type: 3 }, { coupon_price: '1e2' }, { coupon_price: '1.001' },
    { coupon_price: '100.01', discount_type: 2 }, { total_count: 0, is_permanent: 0 }, { total_count: 1, is_permanent: 1 },
    { category: 2, receive_type: 3 }, { category: 1 }, { receive_type: 2, is_permanent: 0 }, { rule: '\u0000' }])
    ('rejects ambiguous definitions before SQL %j', changes => expect(() => couponIssueCreate(body(changes))).toThrow());
  it('requires a real fixed-use window and compares it to the claim window', () => {
    const windows = { valid_days: 0, use_start_time: '2026-10-01T00:00:00Z', use_end_time: '2026-11-01T00:00:00Z',
      start_time: '2026-09-30T00:00:00Z', end_time: '2026-10-15T00:00:00Z' };
    expect(couponIssueCreate(body(windows)).validDays).toBe(0);
    for (const changes of [{ use_start_time: null }, { use_end_time: '2026-10-01T00:00:00Z' },
      { start_time: '2026-10-02T00:00:00Z' }, { end_time: '2026-11-02T00:00:00Z' }, { use_start_time: '2026-02-30T00:00:00Z' }]) {
      expect(() => couponIssueCreate(body({ ...windows, ...changes }))).toThrow();
    }
  });
  it('rejects silent option truncation and oversized product CSV definitions', () => {
    expect(() => couponIssueCreate(body({ scope_type: 2, product_ids: Array.from({ length: 101 }, (_, i) => i + 1) }))).toThrow();
    expect(() => couponIssueCreate(body({ scope_type: 2, product_ids: Array.from({ length: 100 }, (_, i) => 2147483647 - i) }))).toThrow();
  });
  it('defaults the source list to active and preserves the complete bounded filter contract', () => {
    expect(couponIssueQuery(new URLSearchParams())).toMatchObject({ page: 1, limit: 15, status: 1 });
    expect(couponIssueQuery(new URLSearchParams('keyword=%25_&status=&discount_type=2&receive_type=4&page=8&limit=15')))
      .toMatchObject({ keyword: '%_', status: undefined, discountType: 2, receiveType: 4, offset: 105 });
    for (const query of ['page=0', 'limit=101', 'page=10001&limit=100', 'status=1&status=0', 'extra=x', 'receive_type=0']) {
      expect(() => couponIssueQuery(new URLSearchParams(query))).toThrow();
    }
    expect(() => couponIssueQuery(new URLSearchParams('keyword=other'), 'claims')).toThrow();
    expect(() => couponIssueRevision('not-a-revision')).toThrow();
  });
});
