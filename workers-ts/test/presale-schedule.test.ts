import { describe, expect, it } from "vitest";
import { presaleSchedule, type PresaleScheduleInput } from "../src/services/activity/PresaleScheduleService";

const start = 1_790_006_400, end = start + 3600;
const product: PresaleScheduleInput = { isPresaleProduct: 1, presaleStartTime: start, presaleEndTime: end, presaleDay: 7 };
describe("PHP full-payment presale schedule", () => {
  it("keeps both integer-second endpoints inclusive, including the final subsecond", () => {
    for (const [clock, state, status] of [[start * 1000 - 1, "future", 1], [start * 1000, "active", 2],
      [end * 1000, "active", 2], [end * 1000 + 999, "active", 2], [(end + 1) * 1000, "ended", 3]] as const) {
      expect(presaleSchedule(product, new Date(clock))).toMatchObject({ state, presale_pay_status: status });
    }
  });
  it("does not extend a midnight end to another day like seckill", () => {
    const midnight = Date.parse("2026-09-21T16:00:00.000Z") / 1000;
    const data = { ...product, presaleStartTime: midnight - 3600, presaleEndTime: midnight };
    expect(presaleSchedule(data, new Date(midnight * 1000 + 999))).toMatchObject({ state: "active", ends_at: "2026-09-21T16:00:01.000Z" });
    expect(presaleSchedule(data, new Date(midnight * 1000 + 1000)).state).toBe("ended");
  });
  it("exposes configured shipping days without inventing a deposit or delivery appointment", () => {
    expect(presaleSchedule(product, new Date(start * 1000))).toEqual({ timezone: "Asia/Shanghai", state: "active",
      presale_pay_status: 2, starts_at: new Date(start * 1000).toISOString(), ends_at: new Date((end + 1) * 1000).toISOString(),
      start_time: start, stop_time: end, shipping_days_after_end: 7 });
  });
  it("preserves zero default times as already ended, not indefinitely available", () => {
    expect(presaleSchedule({ ...product, presaleStartTime: 0, presaleEndTime: 0, presaleDay: 0 }, new Date(start * 1000)))
      .toMatchObject({ state: "ended", shipping_days_after_end: 0 });
  });
  it("supports a one-second window and the maximum stored Unix second without overflow", () => {
    for (const stamp of [start, 2_147_483_647]) {
      const input = { ...product, presaleStartTime: stamp, presaleEndTime: stamp };
      expect(presaleSchedule(input, new Date(stamp * 1000 + 999)).state).toBe("active");
      expect(presaleSchedule(input, new Date((stamp + 1) * 1000)).state).toBe("ended");
    }
  });
  it("rejects unknown flags, inverted times, nonfinite clocks and invalid integer fields", () => {
    for (const flag of [0, 2, -1]) expect(() => presaleSchedule({ ...product, isPresaleProduct: flag })).toThrow();
    for (const key of ["presaleStartTime", "presaleEndTime", "presaleDay"] as const) {
      for (const value of [-1, 0.5, NaN, Infinity, 2_147_483_648]) expect(() => presaleSchedule({ ...product, [key]: value })).toThrow();
    }
    expect(() => presaleSchedule({ ...product, presaleEndTime: start - 1 })).toThrow();
    expect(() => presaleSchedule(product, new Date(NaN))).toThrow();
  });
});
