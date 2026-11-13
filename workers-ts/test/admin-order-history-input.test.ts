import { describe, expect, it } from 'vitest';
import { adminOrderHistoryId, formatAdminOrderHistoryTime, parseAdminOrderHistoryQuery } from '@/services/admin/AdminOrderHistoryService';
import { orderHistoryTime, parseAdminOrderHistory } from '../../view/admin-ts/src/utils/orderHistory';

const query = { page: 1, limit: 2 };
const record = { id: 5, oid: 8, change_type: 'unknown_event', change_message: '  原文\n<script>仅文本</script>  ', timestamp: 0, change_time: '1970-01-01 08:00:00' };
const page = () => ({ id: 8, order_id: '123456', list: [{ ...record }], count: 1, page: 1, limit: 2, revision: 'a'.repeat(64) });
describe('Admin order history input and response boundaries', () => {
  it.each([0, '0', '0820001', '1e2', 2147483648, NaN, {}, null, undefined, ' 1'])('rejects a noncanonical primary ID %j', value => {
    expect(() => adminOrderHistoryId(value)).toThrow();
  });
  it('uses a separate primary ID and binds a modern page to the exact order number', () => {
    expect(parseAdminOrderHistoryQuery({ order_id: '123456' })).toEqual({ orderNo: '123456', page: 1, limit: 20, revision: undefined });
    expect(parseAdminOrderHistoryQuery({ order_id: '123456', page: '2', limit: '100', revision: 'a'.repeat(64) }).page).toBe(2);
    expect(parseAdminOrderHistoryQuery({ order_id: '123456', page: '10000', limit: '1', revision: 'a'.repeat(64) }).page).toBe(10000);
    expect(parseAdminOrderHistory(page(), 8, '123456', query).list[0]).toEqual(record);
  });
  it.each([
    {}, { order_id: 'x', page: '0' }, { order_id: 'x', page: '01' }, { order_id: 'x', page: '10001', revision: 'a'.repeat(64) },
    { order_id: 'x', limit: '101' }, { order_id: 'x', page: '2' }, { order_id: 'x', revision: 'x' },
    { order_id: 'x', supplier_id: '7' }, { order_id: '../x' }, { order_id: 'x', page: '1e2' },
  ])('rejects malformed or unbound query %j', input => expect(() => parseAdminOrderHistoryQuery(input as Record<string, string>)).toThrow());
  it.each([
    [0, '1970-01-01 08:00:00'], [-1, '1970-01-01 07:59:59'],
    [Date.UTC(1991, 5, 1) / 1000, '1991-06-01 09:00:00'], [Date.UTC(1991, 0, 1) / 1000, '1991-01-01 08:00:00'],
  ] as const)('preserves epoch %s and named Shanghai historical offsets', (seconds, text) => {
    expect(formatAdminOrderHistoryTime(seconds)).toBe(text); expect(orderHistoryTime(seconds)).toBe(text);
  });
  it('rejects foreign identities, duplicate/out-of-order rows, incorrect clocks and incomplete pages', () => {
    const invalid: unknown[] = [null, [], { ...page(), id: 123456 }, { ...page(), order_id: 'Other' }, { ...page(), count: 2 },
      { ...page(), count: 10001 }, { ...page(), revision: '' }, { ...page(), page: 2 },
      { ...page(), list: [{ ...record, oid: 9 }] }, { ...page(), list: [{ ...record, change_time: '1970-01-01 00:00:00' }] },
      { ...page(), list: [{ ...record, change_type: '字'.repeat(33) }] }, { ...page(), list: [{ ...record, change_message: '😀'.repeat(257) }] },
      { ...page(), count: 2, list: [record, record] }, { ...page(), count: 2, list: [record, { ...record, id: 4 }] },
      { ...page(), list: [{ ...record, timestamp: 0.5 }] }];
    for (const value of invalid) expect(() => parseAdminOrderHistory(value, 8, '123456', query)).toThrow();
    expect(() => parseAdminOrderHistory(page(), 8, '123456', { ...query, revision: 'b'.repeat(64) })).toThrow();
  });
});
