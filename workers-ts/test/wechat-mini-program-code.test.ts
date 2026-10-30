import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createAgentInviteSignature,
  WechatMiniProgramCodeService,
  verifyAgentInviteSignature,
} from "@/services/wechat/WechatMiniProgramCodeService";
import { createContainerFromDb } from "@/lib/di";
import { systemConfig } from "@/models/schema";
import type { Env } from "@/env";
import { financeMemoryPostgres } from './helpers/financePostgres';

describe("mini-program agent invite signatures", () => {
  const secret = "test-app-key-with-enough-entropy";
  const now = 1_800_000_000;
  let f: Awaited<ReturnType<typeof financeMemoryPostgres>>;
  beforeAll(async () => {
    f = await financeMemoryPostgres([systemConfig]);
    await f.db.insert(systemConfig).values([
      { menuName: 'routine_appId', value: '"test-app-id"' },
      { menuName: 'routine_appsecret', value: '"test-app-secret"' },
    ]);
  }, 30_000);
  afterAll(async () => { await f?.close(); }, 30_000);

  it("accepts an untampered short-lived signature", async () => {
    const expires = now + 600;
    const signature = await createAgentInviteSignature(42, expires, secret);
    await expect(verifyAgentInviteSignature(42, expires, signature, secret, now)).resolves.toBe(true);
  });

  it("rejects uid, expiry and signature tampering", async () => {
    const expires = now + 600;
    const signature = await createAgentInviteSignature(42, expires, secret);
    await expect(verifyAgentInviteSignature(43, expires, signature, secret, now)).resolves.toBe(false);
    await expect(verifyAgentInviteSignature(42, expires + 1, signature, secret, now)).resolves.toBe(false);
    await expect(verifyAgentInviteSignature(42, expires, `${signature.slice(0, -1)}A`, secret, now)).resolves.toBe(false);
  });

  it("rejects expired or excessively long-lived URLs", async () => {
    const expired = now - 1;
    const expiredSignature = await createAgentInviteSignature(42, expired, secret);
    await expect(verifyAgentInviteSignature(42, expired, expiredSignature, secret, now)).resolves.toBe(false);

    const tooFar = now + 601;
    const futureSignature = await createAgentInviteSignature(42, tooFar, secret);
    await expect(verifyAgentInviteSignature(42, tooFar, futureSignature, secret, now)).resolves.toBe(false);
  });

  it("rejects malformed inputs before verification", async () => {
    await expect(verifyAgentInviteSignature(0, now + 60, "not-valid+base64", secret, now)).resolves.toBe(false);
    await expect(verifyAgentInviteSignature(42, Number.NaN, "abc", secret, now)).resolves.toBe(false);
  });

  it("creates the legacy user spread page code without requiring an agent role", async () => {
    const get = vi.fn(async () => { throw Error('Mini credentials must come from fresh SQL'); });
    const env = {
      APP_KEY: secret,
      UPSTASH_REDIS_URL: "",
      UPSTASH_REDIS_TOKEN: "",
      CONFIG_KV: {
        get,
        put: async () => {},
        delete: async () => {},
      },
    } as unknown as Env;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (requests.length === 1) {
        return Response.json({ access_token: "token", expires_in: 7200 });
      }
      return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
        headers: { "Content-Type": "image/png" },
      });
    };
    const service = new WechatMiniProgramCodeService(createContainerFromDb(f.db), env, fetcher);
    const result = await service.createUserSpreadDataUrl(42);

    expect(result).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(requests).toHaveLength(2);
    expect(new URL(requests[0].url).searchParams.get('appid')).toBe('test-app-id');
    expect(new URL(requests[0].url).searchParams.get('secret')).toBe('test-app-secret');
    expect(get).not.toHaveBeenCalled();
    const payload = JSON.parse(String(requests[1]?.init?.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      scene: "42",
      page: "pages/users/user_spread_user/index",
      check_path: true,
      env_version: "release",
    });
  });
});
