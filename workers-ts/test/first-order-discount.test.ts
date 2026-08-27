import { describe, expect, it } from "vitest";
import {
  allocateLegacyDiscountCents,
  calculateFirstOrderDiscountCents,
  parseFirstOrderPayPercent,
  type FirstOrderDiscountConfig,
} from "../src/services/activity/StoreNewcomerService";

function config(overrides: Partial<FirstOrderDiscountConfig> = {}): FirstOrderDiscountConfig {
  return {
    enabled: true,
    limitEnabled: false,
    limitDays: 0,
    payPercent: 90,
    limitCents: 10_000,
    ...overrides,
  };
}

describe("first-order discount parity", () => {
  it("matches PHP bcdiv scale=2 for decimal discount configuration", () => {
    expect(parseFirstOrderPayPercent("85.50")).toBe(85);
    expect(parseFirstOrderPayPercent('"99.99"')).toBe(99);
    expect(parseFirstOrderPayPercent("101")).toBe(100);
  });

  it("uses the PHP discount percentage and truncates to cents", () => {
    expect(calculateFirstOrderDiscountCents(9_999, config())).toBe(999);
    expect(calculateFirstOrderDiscountCents(9_999, config({ payPercent: 85 }))).toBe(1_499);
  });

  it("enforces the configured monetary cap and cannot exceed the subtotal", () => {
    expect(calculateFirstOrderDiscountCents(20_000, config({ limitCents: 1_500 }))).toBe(1_500);
    expect(calculateFirstOrderDiscountCents(500, config({ payPercent: 0 }))).toBe(500);
    expect(calculateFirstOrderDiscountCents(500, config({ limitCents: 0 }))).toBe(0);
  });

  it("allocates using PHP scale=4 truncation and assigns the remainder to the last line", () => {
    expect(allocateLegacyDiscountCents(1_000, [3_333, 3_333, 3_334])).toEqual([333, 333, 334]);
    expect(allocateLegacyDiscountCents(1, [1, 1, 1])).toEqual([0, 0, 1]);
    expect(allocateLegacyDiscountCents(0, [100, 200])).toEqual([0, 0]);
  });

  it("rejects unsafe amount inputs", () => {
    expect(() => calculateFirstOrderDiscountCents(-1, config())).toThrow("计价基数");
    expect(() => allocateLegacyDiscountCents(1, [Number.MAX_SAFE_INTEGER, 1]))
      .toThrow("权重超出安全范围");
  });
});
