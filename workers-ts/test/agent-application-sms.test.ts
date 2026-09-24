import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Container } from "@/lib/di";
import type { Env } from "@/env";

const state = vi.hoisted(() => ({
  codes: new Map<string, unknown>(),
  locks: new Map<string, string>(),
}));

vi.mock("@/utils/cache", () => ({
  getRedis: () => ({
    set: async (key: string, token: string, options: { nx?: boolean }) => {
      if (options.nx && state.locks.has(key)) return null;
      state.locks.set(key, token);
      return "OK";
    },
    eval: async (_script: string, keys: string[], args: string[]) => {
      if (state.locks.get(keys[0]) === args[0]) { state.locks.delete(keys[0]); return 1; }
      return 0;
    },
  }),
  cacheGet: async (key: string) => state.codes.get(key) ?? null,
  cacheDelete: async (key: string) => { state.codes.delete(key); return true; },
}));

import { SmsVerificationService } from "@/services/message/SmsVerificationService";

describe("agent application SMS capabilities", () => {
  beforeEach(() => { state.codes.clear(); state.locks.clear(); });

  it("uses separate one-time purposes for promoter and division applications", async () => {
    const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
    const original = subtle.timingSafeEqual;
    if (!original) subtle.timingSafeEqual = (a, b) => {
      const left = new Uint8Array(a instanceof ArrayBuffer ? a : a.buffer, a instanceof ArrayBuffer ? 0 : a.byteOffset, a instanceof ArrayBuffer ? undefined : a.byteLength);
      const right = new Uint8Array(b instanceof ArrayBuffer ? b : b.buffer, b instanceof ArrayBuffer ? 0 : b.byteOffset, b instanceof ArrayBuffer ? undefined : b.byteLength);
      return left.length === right.length && left.every((byte, index) => byte === right[index]);
    };
    try {
      const service = new SmsVerificationService({} as Container, {
        UPSTASH_REDIS_URL: "https://redis.example.test", UPSTASH_REDIS_TOKEN: "test",
      } as Env);
      state.codes.set("user_verification_code_user_promoter_application_13800138000", {
        uid: 0, purpose: "user_promoter_application", code: "042731",
      });
      await expect(service.consumeUserCode("user_division_application", "13800138000", "042731"))
        .rejects.toThrow("验证码错误或已过期");
      await expect(service.consumeUserCode("user_promoter_application", "13900139000", "042731"))
        .rejects.toThrow("验证码错误或已过期");
      await expect(service.consumeUserCode("user_promoter_application", "13800138000", "042731"))
        .resolves.toBe("13800138000");
      await expect(service.consumeUserCode("user_promoter_application", "13800138000", "042731"))
        .rejects.toThrow("验证码错误或已过期");
      state.codes.set("user_verification_code_user_division_application_13800138000", {
        uid: 0, purpose: "user_division_application", code: "998877",
      });
      await expect(service.consumeUserCode("user_promoter_application", "13800138000", "998877"))
        .rejects.toThrow("验证码错误或已过期");
      await expect(service.consumeUserCode("user_division_application", "13800138000", "998877"))
        .resolves.toBe("13800138000");
    } finally { subtle.timingSafeEqual = original; }
  });
});
