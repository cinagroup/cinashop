import type { Env } from "@/env";
import { advanceRateWindows, type RateWindow, type RateLimitPolicy } from "@/services/out/OutRateLimitPolicy";

/** Explicit process-local DO boundary for unrelated image regression suites. */
export function userUploadRateFixture(): Env["TOKEN_BUCKET"] {
  const states = new Map<string, Record<string, RateWindow>>();
  return { getByName: (name: string) => ({ consumeRateLimit: async (policies: RateLimitPolicy[], seconds: number) => {
    const next = advanceRateWindows(states.get(name) ?? {}, policies, Date.now(), seconds);
    states.set(name, next.windows); return next.decision;
  } }) } as unknown as Env["TOKEN_BUCKET"];
}
