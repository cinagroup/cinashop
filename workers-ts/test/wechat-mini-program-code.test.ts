import { describe, expect, it } from "vitest";
import {
  createAgentInviteSignature,
  verifyAgentInviteSignature,
} from "@/services/wechat/WechatMiniProgramCodeService";

describe("mini-program agent invite signatures", () => {
  const secret = "test-app-key-with-enough-entropy";
  const now = 1_800_000_000;

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
});
