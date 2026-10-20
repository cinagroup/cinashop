import { describe, expect, it } from 'vitest';
import { assertIntegralOnceLimit, assertIntegralTotalLimit, integralPurchaseLimit } from '../src/services/activity/IntegralPurchaseAdmission';
import { ValidateException } from '../src/utils/errors';

// Business boundary checks only. Native PostgreSQL tests cover retained-root
// SQL, real transaction isolation, author serialization and rollback.
describe('PHP integral purchase limit business boundaries', () => {
  it('accepts only the explicit -1 sentinel or a nonnegative signed int32 limit', () => {
    for (const value of [-1, 0, 1, 2147483647]) expect(integralPurchaseLimit(value)).toBe(true);
    for (const value of [undefined, null, '-1', '0', true, -2, 0.5, NaN, Infinity, 2147483648, 1n]) {
      expect(integralPurchaseLimit(value)).toBe(false);
      expect(() => assertIntegralOnceLimit(value, 1)).toThrow(ValidateException);
      expect(() => assertIntegralTotalLimit(value, 1, 0n)).toThrow(ValidateException);
    }
  });

  it('treats zero as closed and -1 as unlimited for a positive requested quantity', () => {
    expect(() => assertIntegralOnceLimit(0, 1)).toThrow(ValidateException);
    expect(() => assertIntegralTotalLimit(0, 1, 0n)).toThrow(ValidateException);
    expect(() => assertIntegralOnceLimit(-1, 32767)).not.toThrow();
    expect(() => assertIntegralTotalLimit(-1, 32767, 9223372036854775807n)).not.toThrow();
  });

  it('admits the exact once boundary but keeps the independent 1..32767 cart quantity bound', () => {
    expect(() => assertIntegralOnceLimit(2, 2)).not.toThrow();
    expect(() => assertIntegralOnceLimit(2, 3)).toThrow(ValidateException);
    expect(() => assertIntegralOnceLimit(2147483647, 32767)).not.toThrow();
    for (const requested of [-1, 0, 0.5, 32768, NaN, Infinity]) {
      expect(() => assertIntegralOnceLimit(-1, requested)).toThrow(ValidateException);
      expect(() => assertIntegralTotalLimit(-1, requested, 0n)).toThrow(ValidateException);
    }
  });

  it('compares retained totals above int32 and JavaScript safe-number bounds using exact units', () => {
    expect(() => assertIntegralTotalLimit(2147483647, 1, 2147483646n)).not.toThrow();
    expect(() => assertIntegralTotalLimit(2147483647, 2, 2147483646n)).toThrow(ValidateException);
    for (const purchased of [2147483647n, 4294967294n, 9007199254740993n]) {
      expect(() => assertIntegralTotalLimit(2147483647, 1, purchased)).toThrow(ValidateException);
      expect(() => assertIntegralTotalLimit(-1, 1, purchased)).not.toThrow();
    }
  });

  it('does not reinterpret invalid negative retained history as available capacity, including unlimited caps', () => {
    expect(() => assertIntegralTotalLimit(-1, 1, -1n)).toThrow(ValidateException);
    expect(() => assertIntegralTotalLimit(2, 1, -1n)).toThrow(ValidateException);
  });
});
