import { describe, expect, it } from 'vitest';
import { supplierProductScheduleInput, supplierProductScheduleTime } from '@/services/supplier/SupplierProductScheduleInput';
import { normalizeSupplierProductInput } from '@/services/supplier/SupplierProductManagementService';
import { supplierProductScheduleBody } from './helpers/supplierProductSchedule';

describe('Supplier schedule authoring preserves explicit cancellation and PHP Shanghai wire semantics', () => {
  it('distinguishes omitted fields from the PHP empty-string and numeric-zero cancellation', () => {
    expect(supplierProductScheduleInput({})).toEqual({});
    expect(supplierProductScheduleInput({ auto_on_time: undefined })).toEqual({});
    expect(supplierProductScheduleInput({ auto_on_time: '', auto_off_time: 0 })).toEqual({ autoOnTime: 0, autoOffTime: 0 });
    expect(normalizeSupplierProductInput(supplierProductScheduleBody())).not.toHaveProperty('autoOnTime');
    expect(normalizeSupplierProductInput(supplierProductScheduleBody({ auto_on_time: '', auto_off_time: 0 })))
      .toMatchObject({ autoOnTime: 0, autoOffTime: 0 });
  });
  it.each([
    [0, 0], [1, 1], [2_147_483_647, 2_147_483_647],
    ['', 0], ['2026-10-17 16:00', 1_792_224_000], ['2026-10-17 16:00:01', 1_792_224_001],
    ['2026-10-17T08:00:00Z', 1_792_224_000], ['2026-10-17T08:00:00.999Z', 1_792_224_000],
    ['2024-02-29 08:00:00', 1_709_164_800], ['2038-01-19 11:14:07', 2_147_483_647],
  ] as const)('normalizes explicit time %j to exact integer seconds %i', (value, expected) => {
    expect(supplierProductScheduleTime(value)).toBe(expected);
  });
  it.each([
    null, true, false, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648,
    '0', '1792224000', ' ', '2026-02-29 12:00', '2026-04-31 12:00:00', '2026-10-17 24:00',
    '2026-10-17 08:60', '2026-10-17 08:00:60', '2026-10-17T08:00:00', '2026-10-17T08:00:00+08:00',
    '2026-10-17T08:00:00.1234Z', '2038-01-19 11:14:08', {}, [],
  ])('rejects invalid schedule wire %j without coercion or calendar rollover', value => {
    expect(() => supplierProductScheduleTime(value)).toThrow();
  });
  it('accepts already-due, equal and reversed schedules without a new widget-only 24-hour policy', () => {
    expect(supplierProductScheduleInput({ auto_on_time: 100, auto_off_time: 100 })).toEqual({ autoOnTime: 100, autoOffTime: 100 });
    expect(supplierProductScheduleInput({ auto_on_time: 200, auto_off_time: 100 })).toEqual({ autoOnTime: 200, autoOffTime: 100 });
    expect(supplierProductScheduleInput({ auto_on_time: 0 })).toEqual({ autoOnTime: 0 });
  });
});
