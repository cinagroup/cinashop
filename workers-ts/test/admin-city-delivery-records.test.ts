import { describe, expect, it } from 'vitest';
import { cityDeliveryDistance, cityDeliveryLike, cityDeliveryMoney, cityDeliveryQueryKeys, cityDeliveryRecordFilters, cityDeliveryRecordId, cityDeliveryStoreFilters } from '../src/services/admin/AdminCityDeliveryRecordInput';

describe('city delivery record read input', () => {
  it('keeps zero, negative and unknown historical status values separate from absent filters', () => {
    expect(cityDeliveryRecordFilters(new URLSearchParams())).toEqual({ page: 1, limit: 20, offset: 0, keyword: '', station_type: null, status: null, store_id: null, date_from: null, date_to: null });
    for (const status of ['0', '1', '-1', '32767', '-2147483648', '2147483647']) expect(cityDeliveryRecordFilters(new URLSearchParams({ status })).status).toBe(Number(status));
    expect(cityDeliveryRecordFilters(new URLSearchParams('station_type=2&store_id=7&date_from=0&date_to=2147483647'))).toMatchObject({ station_type: 2, store_id: 7, date_from: 0, date_to: 2147483647 });
  });
  it('rejects noncanonical numbers, unsupported and duplicate parameters before SQL', () => {
    for (const query of ['status=-0', 'status=01', 'status=1e1', 'status=+1', 'status=2147483648', 'status=-2147483649', 'station_type=0', 'station_type=3', 'store_id=0', 'page=0', 'limit=101', 'status=', 'status=1&status=2', 'unknown=1']) expect(() => cityDeliveryRecordFilters(new URLSearchParams(query)), query).toThrow();
    for (const id of ['', '0', '01', '-1', '1.0', '2147483648']) expect(() => cityDeliveryRecordId(id)).toThrow();
    expect(cityDeliveryRecordId('2147483647')).toBe(2147483647);
    expect(() => cityDeliveryQueryKeys(new URLSearchParams('x=1'), [])).toThrow();
  });
  it('bounds both independent pages and requires paired inclusive time bounds', () => {
    expect(cityDeliveryRecordFilters(new URLSearchParams('page=1001&limit=100')).offset).toBe(100000);
    expect(() => cityDeliveryRecordFilters(new URLSearchParams('page=1002&limit=100'))).toThrow();
    for (const query of ['date_from=1', 'date_to=2', 'date_from=2&date_to=1', 'date_from=-1&date_to=1']) expect(() => cityDeliveryRecordFilters(new URLSearchParams(query))).toThrow();
    expect(cityDeliveryRecordFilters(new URLSearchParams('date_from=7&date_to=7')).date_to).toBe(7);
    expect(cityDeliveryStoreFilters(new URLSearchParams('limit=50')).limit).toBe(50);
    for (const query of ['limit=51', 'store_id=1', 'keyword=a&keyword=b']) expect(() => cityDeliveryStoreFilters(new URLSearchParams(query))).toThrow();
  });
  it('treats percent, underscore and slash as literal search data and rejects control characters before trim', () => {
    expect(cityDeliveryLike('a%_\\中')).toBe('%a\\%\\_\\\\中%');
    expect(cityDeliveryRecordFilters(new URLSearchParams({ keyword: '  %_\\  ' })).keyword).toBe('%_\\');
    expect(cityDeliveryStoreFilters(new URLSearchParams({ keyword: '🌤'.repeat(100) })).keyword).toHaveLength(200);
    for (const keyword of ['\nabc', 'abc\u007f', '中'.repeat(101)]) expect(() => cityDeliveryRecordFilters(new URLSearchParams({ keyword }))).toThrow();
  });
  it('preserves exact decimal money strings and flags invalid historical values', () => {
    for (const money of ['0', '0.00', '2.10', '999999.99']) expect(cityDeliveryMoney(money)).toBe(money);
    for (const money of ['NaN', 'Infinity', '-0.01', '1e2', '', '01.00']) expect(cityDeliveryMoney(money)).toBeNull();
  });
  it('converts stored meters to decimal km without float division artifacts or silent zero defaults', () => {
    expect(cityDeliveryDistance(1320.5)).toEqual({ meters: 1320.5, km: '1.3205' });
    expect(cityDeliveryDistance(13.2).km).toBe('0.0132');
    expect(cityDeliveryDistance(1e-7).km).toBe('0.0000000001');
    expect(cityDeliveryDistance(1e21).km).toBe('1000000000000000000');
    expect(cityDeliveryDistance(-0)).toEqual({ meters: 0, km: '0' });
    for (const value of [Number.NaN, Infinity, -Infinity, -1]) expect(cityDeliveryDistance(value)).toEqual({ meters: null, km: null });
  });
});
