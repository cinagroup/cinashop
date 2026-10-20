import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import type { Env } from "@/env";

afterEach(async () => { await reset(); });
it("the real Durable Object admits daily media budgets and persists the count through eviction", async () => {
  const stub = (env as unknown as Env).TOKEN_BUCKET.getByName("user-upload:runtime-video");
  const first = await stub.consumeRateLimit([{ key: "upload", limit: 100 }], 86400);
  expect(first).toMatchObject({ allowed: true, remaining: 99 });
  expect(first.resetAt - Date.now()).toBeGreaterThan(86300000);
  await evictDurableObject(stub);
  const second = await stub.consumeRateLimit([{ key: "upload", limit: 100 }], 86400);
  expect(second).toMatchObject({ allowed: true, remaining: 98, resetAt: first.resetAt });
  const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
  expect(alarm).toBe(first.resetAt);
});
it("the real daily bucket serializes concurrent uploads", async () => {
  const stub = (env as unknown as Env).TOKEN_BUCKET.getByName("user-upload:runtime-concurrent");
  const decisions = await Promise.all(Array.from({ length: 12 }, () => stub.consumeRateLimit([{ key: "upload", limit: 10 }], 86400)));
  expect(decisions.filter(value => value.allowed)).toHaveLength(10);
  expect(decisions.filter(value => value.auditEvent)).toHaveLength(1);
});
