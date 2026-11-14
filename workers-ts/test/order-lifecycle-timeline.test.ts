import { describe, expect, it } from 'vitest';
import { buildOrderLifecycleLog, lifecycleTime } from '@/services/order/OrderLifecycleTimeline';
import { lifecycleEntries, parseCityOrderLifecycleLog, parseOrderLifecycleLog } from '../../view/common/orderLifecycle';

const empty = { create: '', pay: '', delivery: '', take: '', complete: '' };
describe('PHP lifecycle dates and strict shared client contract', () => {
  it('keeps absent events empty and ignores header-like and unrelated events', () => {
    expect(buildOrderLifecycleLog([{ changeType: 'paid', changeTime: 100 }, { changeType: 'split_create_order', changeTime: 100 }])).toEqual(empty);
    expect(lifecycleEntries(empty)).toEqual([]);
  });
  it('keeps delivery priority independent of event dates, including Unix zero', () => {
    const rows = [{ changeType: 'delivery', changeTime: 0 }, { changeType: 'delivery_goods', changeTime: 86400 }, { changeType: 'delivery_fictitious', changeTime: 172800 }];
    expect(buildOrderLifecycleLog(rows).delivery).toBe('1970-01-01');
    expect(buildOrderLifecycleLog(rows.slice(1)).delivery).toBe('1970-01-02');
    expect(buildOrderLifecycleLog(rows.slice(2)).delivery).toBe('1970-01-03');
  });
  it('chooses the latest time and then physical ID per exact event type', () => {
    expect(buildOrderLifecycleLog([{ id: 9, changeType: 'pay_success', changeTime: 86400 },
      { id: 10, changeType: 'pay_success', changeTime: 0 }]).pay).toBe('1970-01-02');
  });
  it('uses Shanghai historical daylight saving rather than a fixed eight-hour offset', () => {
    expect(lifecycleTime(Date.UTC(1988, 6, 1, 15, 30) / 1000, false)).toBe('1988-07-02 00:30:00');
    expect(lifecycleTime(-1, false)).toBe('1970-01-01 07:59:59');
    expect(lifecycleTime(-2147483648)).toBe('1901-12-14');
    expect(lifecycleTime(2147483647)).toBe('2038-01-19');
  });
  it.each([NaN, Infinity, 0.5, -2147483649, 2147483648])('refuses invalid recorded timestamp %s', time => {
    expect(() => lifecycleTime(time)).toThrow('订单进度时间无效');
  });
  it('collapses city repeats, retains substring behavior and sorts selected event ties by ID', () => {
    const result = buildOrderLifecycleLog([
      { id: 1, changeType: 'city_delivery_2', changeTime: 0 },
      { id: 4, changeType: 'city_delivery_2', changeTime: 60 },
      { id: 3, changeType: 'city_delivery_100', changeTime: 60 },
      { id: 5, changeType: 'prefix_city_delivery_4', changeTime: 120 },
      { id: 6, changeType: 'city_delivery_constructor', changeTime: 180 },
      { id: 7, changeType: 'city_delivery___proto__', changeTime: 240 },
    ], true);
    expect(result.city_delivery).toEqual([
      { time: '1970-01-01 08:01:00', label: '骑士到店' },
      { time: '1970-01-01 08:01:00', label: '待取货' },
      { time: '1970-01-01 08:02:00', label: '配送中' },
      { time: '1970-01-01 08:03:00', label: '配送中' },
      { time: '1970-01-01 08:04:00', label: '配送中' },
    ]);
    expect(result).not.toHaveProperty('delivery');
    expect(parseCityOrderLifecycleLog(result)).toEqual(result);
  });
  it('accepts valid Gregorian days, clones the DTO and renders only recorded events', () => {
    const raw = { ...empty, create: '2000-02-29', delivery: '1988-07-02' };
    const parsed = parseOrderLifecycleLog(raw); raw.create = '';
    expect(lifecycleEntries(parsed)).toEqual([{ key: 'create', label: '订单生成', time: '2000-02-29' }, { key: 'delivery', label: '发货记录', time: '1988-07-02' }]);
  });
  it.each([undefined, null, [], {}, { ...empty, create: '1900-02-29' }, { ...empty, pay: '2024-04-31' },
    { ...empty, complete: '2024-01-01 00:00:00' }, { ...empty, delivery: null }, { ...empty, extra: '' },
    Object.assign(Object.create({ delivery: '' }), { create: '', pay: '', take: '', complete: '', other: '' })])('refuses absent or malformed normal DTO %#', raw => {
    expect(() => parseOrderLifecycleLog(raw)).toThrow('订单进度记录响应无效');
  });
  it.each([{ create: '', pay: '', take: '', complete: '', city_delivery: [{ time: '2024-02-30 08:00:00', label: '配送中' }] },
    { create: '', pay: '', take: '', complete: '', city_delivery: [{ time: '2024-01-01 24:00:00', label: '配送中' }] },
    { create: '', pay: '', take: '', complete: '', city_delivery: [{ time: '2024-01-01 08:00:00', label: '<script>' }] },
    { create: '', pay: '', take: '', complete: '', city_delivery: new Array(10001).fill(null) }])('refuses malformed city DTO %#', raw => {
    expect(() => parseCityOrderLifecycleLog(raw)).toThrow('订单进度记录响应无效');
  });
});
