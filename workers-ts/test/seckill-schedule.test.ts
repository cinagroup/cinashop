import { describe, expect, it } from "vitest";
import { assertSeckillSchedule, evaluateSeckillSchedule, seckillSlotIds, seckillSlotMinutes, type SeckillScheduleSnapshot } from "../src/services/activity/SeckillScheduleService";

const day = (value: string) => Math.floor(Date.parse(`${value}T00:00:00+08:00`) / 1000);
function fixture(): SeckillScheduleSnapshot {
  return { child: { id: 20, activityId: 9, productId: 70, status: 1, isShow: 1, isDel: 0, timeId: "4,8",
    startTime: new Date("2026-09-07T00:00:00+08:00"), stopTime: new Date("2026-09-08T00:00:00+08:00") },
  parent: { id: 9, type: 1, status: 1, isDel: 0, startDay: day("2026-09-07"), endDay: day("2026-09-08"), timeId: "4,8" },
  slots: [{ id: 4, status: 1, startTime: "0800", endTime: "10:00" }, { id: 8, status: 1, startTime: "18:00", endTime: "2000" }] };
}
const state = (time: string, value = fixture()) => evaluateSeckillSchedule(value, new Date(time));
describe("seckill Shanghai schedule policy", () => {
  it.each([
    ["2026-09-06T09:00:00+08:00", "future"], ["2026-09-07T07:59:59.999+08:00", "future"],
    ["2026-09-07T08:00:00+08:00", "active"], ["2026-09-07T09:59:59.999+08:00", "active"],
    ["2026-09-07T10:00:00+08:00", "future"], ["2026-09-07T18:00:00+08:00", "active"],
    ["2026-09-07T20:00:00+08:00", "waiting"], ["2026-09-08T18:01:00+08:00", "active"],
    ["2026-09-09T00:00:00+08:00", "ended"], ["2026-09-07T00:00:00Z", "active"],
  ])("evaluates %s as %s independent of host timezone", (time, expected) => { expect(state(time).state).toBe(expected); });
  it("returns exact admission boundaries and only currently active slots", () => {
    expect(state("2026-09-07T08:00:00+08:00")).toEqual({ state: "active", message: "秒杀进行中",
      startsAt: Date.parse("2026-09-07T08:00:00+08:00"), endsAt: Date.parse("2026-09-07T10:00:00+08:00"), activeSlotIds: [4] });
    const value = fixture(); value.slots.push({ id: 12, status: 1, startTime: "08:00", endTime: "12:00" });
    expect(state("2026-09-07T09:00:00+08:00", value).endsAt).toBe(Date.parse("2026-09-07T10:00:00+08:00"));
  });
  it("intersects parent and child dates and slot IDs instead of widening either authority", () => {
    const value = fixture(); value.parent!.timeId = "8,12";
    expect(state("2026-09-07T09:00:00+08:00", value).state).toBe("future");
    expect(state("2026-09-07T19:00:00+08:00", value).activeSlotIds).toEqual([8]);
    value.parent!.endDay = day("2026-09-07"); expect(state("2026-09-08T19:00:00+08:00", value).state).toBe("ended");
    value.parent!.timeId = "12"; expect(state("2026-09-07T19:00:00+08:00", value).state).toBe("invalid");
  });
  it("allows standalone legacy seckill rows but still requires their own enabled slots", () => {
    const value = fixture(); value.child.activityId = 0; value.parent = null;
    expect(state("2026-09-07T09:00:00+08:00", value).state).toBe("active");
    value.child.timeId = ""; expect(state("2026-09-07T09:00:00+08:00", value).state).toBe("invalid");
  });
  it("rejects missing, disabled, wrong-type or deleted parents and hidden/deleted children", () => {
    for (const change of [{ status: 0 }, { isDel: 1 }, { type: 2 }, { id: 99 }]) {
      const value = fixture(); Object.assign(value.parent!, change); expect(state("2026-09-07T09:00:00+08:00", value).state).toBe("unavailable");
    }
    const missing = fixture(); missing.parent = null; expect(state("2026-09-07T09:00:00+08:00", missing).state).toBe("unavailable");
    for (const change of [{ status: 0 }, { isDel: 1 }, { isShow: 0 }]) {
      const value = fixture(); Object.assign(value.child, change); expect(() => assertSeckillSchedule(value, new Date("2026-09-07T09:00:00+08:00"))).toThrow("已下架");
    }
  });
  it("does not authorize through missing/disabled slots or silently interpret overnight intervals", () => {
    const value = fixture(); value.slots = []; expect(state("2026-09-07T09:00:00+08:00", value).state).toBe("unavailable");
    value.slots = [{ id: 4, status: 0, startTime: "08:00", endTime: "10:00" }]; expect(state("2026-09-07T09:00:00+08:00", value).state).toBe("unavailable");
    for (const [startTime, endTime] of [["2200", "0200"], ["0800", "0800"], ["8am", "1000"], ["0800", "2460"]]) {
      value.slots = [{ id: 4, status: 1, startTime, endTime }]; expect(state("2026-09-07T09:00:00+08:00", value).state).toBe("invalid");
    }
  });
  it("preserves precise non-midnight endpoints while treating legacy midnight dates inclusively", () => {
    const value = fixture(); value.child.stopTime = new Date("2026-09-07T09:15:00+08:00");
    expect(state("2026-09-07T09:15:00+08:00", value).state).toBe("active");
    expect(state("2026-09-07T09:15:00.001+08:00", value).state).toBe("ended");
    value.child.stopTime = new Date("2026-09-07T00:00:00+08:00");
    expect(state("2026-09-07T19:00:00+08:00", value).state).toBe("active");
  });
  it("allows explicit whole-day slots and closes exactly at the final-day boundary", () => {
    const value = fixture(); value.slots = [{ id: 4, status: 1, startTime: "0000", endTime: "2400" }];
    expect(state("2026-09-08T23:59:59.999+08:00", value).state).toBe("active");
    expect(state("2026-09-09T00:00:00+08:00", value).state).toBe("ended");
  });
  it("rejects malformed or reversed date data", () => {
    for (const change of [{ startDay: 0 }, { endDay: day("2026-09-06") }, { endDay: day("2026-09-08") + 1 }]) {
      const value = fixture(); Object.assign(value.parent!, change); expect(state("2026-09-07T09:00:00+08:00", value).state).toBe("invalid");
    }
    const value = fixture(); value.child.startTime = new Date(NaN); expect(state("2026-09-07T09:00:00+08:00", value).state).toBe("invalid");
    expect(evaluateSeckillSchedule(fixture(), new Date(NaN)).state).toBe("invalid");
  });
  it("bounds ID lists and accepts only clock formats supported by the migration contract", () => {
    expect(seckillSlotIds("4, 8,4")).toEqual([4, 8]); expect(seckillSlotMinutes("0800")).toBe(480);
    expect(seckillSlotMinutes("08:00")).toBe(480); expect(seckillSlotMinutes("24:00", true)).toBe(1440);
    for (const value of [null, "", "0", "4,", "4,x", "01", "1e1", "2147483648", "1,".repeat(64) + "2", "1".repeat(1025)]) expect(() => seckillSlotIds(value)).toThrow();
    for (const value of ["24:00", "1:00", "080000", " 0800", "2360", "-100"]) expect(() => seckillSlotMinutes(value)).toThrow();
  });
});
