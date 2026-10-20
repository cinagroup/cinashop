import { expect, it } from "vitest";
import { advanceRateWindows, type RateWindow } from "@/services/out/OutRateLimitPolicy";

it("daily uploads admit exactly 100 attempts and reset at the fixed day boundary", () => {
  let windows: Record<string, RateWindow> = {};
  const policies = [{ key: "upload", limit: 100 }], start = 1000;
  for (let i = 0; i < 101; i++) {
    const next = advanceRateWindows(windows, policies, start + i, 86400);
    expect(next.decision.allowed).toBe(i < 100);
    expect(next.decision.resetAt).toBe(start + 86400000);
    windows = next.windows;
  }
  expect(advanceRateWindows(windows, policies, start + 86400000, 86400).decision)
    .toMatchObject({ allowed: true, remaining: 99 });
});
it("rate windows remain bounded and existing minute budgets retain their reset", () => {
  for (const seconds of [0, -1, 86401, NaN, 1.5]) {
    expect(() => advanceRateWindows({}, [{ key: "upload", limit: 100 }], 1000, seconds)).toThrow("invalid rate limit window");
  }
  const first = advanceRateWindows({}, [{ key: "login", limit: 1 }], 1000, 60);
  expect(advanceRateWindows(first.windows, [{ key: "login", limit: 1 }], 2000, 60).decision)
    .toMatchObject({ allowed: false, resetAt: 61000 });
});
