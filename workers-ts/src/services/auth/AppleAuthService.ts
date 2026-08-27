import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { cacheGet, cacheSet, cacheTake, getRedis } from "@/utils/cache";
import { ValidateException } from "@/utils/errors";
import {
  type SocialAuthResult,
  WechatAuthService,
} from "@/services/wechat/WechatAuthService";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS = createRemoteJWKSet(
  new URL("https://appleid.apple.com/auth/keys"),
  { timeoutDuration: 5_000, cooldownDuration: 30_000 },
);
const APPLE_NONCE_PREFIX = "apple_sign_in_nonce:";
const APPLE_TOKEN_PREFIX = "apple_identity_token_used:";
const APPLE_NONCE_TTL_SECONDS = 5 * 60;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;

export interface AppleSignInChallenge {
  key: string;
  nonce: string;
  nonceSha256: string;
  expiresIn: number;
}

export function appleAudienceList(value: unknown): string[] {
  const values = String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (values.length === 0) throw new ValidateException("Apple 登录尚未配置");
  if (values.length > 10 || values.some((entry) => entry.length > 255)) {
    throw new ValidateException("Apple 登录配置无效");
  }
  return [...new Set(values)];
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class AppleAuthService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  private audiences(): string[] {
    return appleAudienceList(this.env.APPLE_SIGN_IN_CLIENT_IDS);
  }

  private async checkIpRateLimit(
    scope: "challenge" | "login",
    ipValue: string,
    limit: number,
  ): Promise<void> {
    const redis = getRedis(this.env);
    if (!redis) throw new ValidateException("Apple 登录缓存尚未配置");
    const ipDigest = (await sha256Hex(ipValue.trim().slice(0, 128) || "unknown")).slice(0, 24);
    const key = `apple_sign_in_rate:${scope}:${ipDigest}`;
    const count = await redis.eval<[], number>(
      "local n=redis.call('incr',KEYS[1]); if n==1 then redis.call('expire',KEYS[1],60) end; return n",
      [key],
      [],
    );
    if (!Number.isFinite(count) || count > limit) {
      throw new ValidateException("Apple 登录请求过于频繁，请稍后重试");
    }
  }

  async createChallenge(ip = ""): Promise<AppleSignInChallenge> {
    // Validate deployment configuration before creating any capability.
    this.audiences();
    if (!getRedis(this.env)) throw new ValidateException("Apple 登录缓存尚未配置");
    await this.checkIpRateLimit("challenge", ip, 20);
    const key = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    const nonceSha256 = await sha256Hex(nonce);
    const stored = await cacheSet(
      APPLE_NONCE_PREFIX + key,
      nonce,
      this.env,
      APPLE_NONCE_TTL_SECONDS,
    );
    if (!stored) throw new ValidateException("Apple 登录挑战创建失败，请重试");
    return { key, nonce, nonceSha256, expiresIn: APPLE_NONCE_TTL_SECONDS };
  }

  async login(params: {
    identityToken: unknown;
    nonceKey: unknown;
    spreadUid?: unknown;
    ip?: string;
  }): Promise<SocialAuthResult> {
    const audiences = this.audiences();
    if (!getRedis(this.env)) throw new ValidateException("Apple 登录缓存尚未配置");
    const identityToken = String(params.identityToken ?? "").trim();
    const nonceKey = String(params.nonceKey ?? "").trim();
    if (identityToken.length < 128 || identityToken.length > 8 * 1024) {
      throw new ValidateException("Apple 身份令牌无效");
    }
    if (!UUID_PATTERN.test(nonceKey)) throw new ValidateException("Apple 登录挑战无效或已过期");
    await this.checkIpRateLimit("login", params.ip ?? "", 30);

    const nonce = await cacheGet<string>(APPLE_NONCE_PREFIX + nonceKey, this.env);
    if (!nonce) throw new ValidateException("Apple 登录挑战无效或已过期");
    const expectedNonce = await sha256Hex(nonce);

    let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
    try {
      ({ payload } = await jwtVerify(identityToken, APPLE_JWKS, {
        algorithms: ["ES256"],
        issuer: APPLE_ISSUER,
        audience: audiences,
        maxTokenAge: "10m",
        clockTolerance: 5,
      }));
    } catch {
      throw new ValidateException("Apple 身份令牌验证失败");
    }
    if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 100) {
      throw new ValidateException("Apple 身份令牌缺少用户标识");
    }
    if (typeof payload.nonce !== "string" || payload.nonce !== expectedNonce) {
      throw new ValidateException("Apple 登录 nonce 验证失败");
    }

    // Only one request may cross the verification-to-account boundary.
    const consumedNonce = await cacheTake<string>(APPLE_NONCE_PREFIX + nonceKey, this.env);
    if (consumedNonce !== nonce) throw new ValidateException("Apple 登录挑战已被使用");
    const tokenDigest = await sha256Hex(identityToken);
    const redis = getRedis(this.env);
    if (!redis) throw new ValidateException("Apple 登录缓存尚未配置");
    const now = Math.floor(Date.now() / 1000);
    const replayTtl = Math.max(1, Math.min(15 * 60, Number(payload.exp ?? now + 300) - now));
    const marked = await redis.set(APPLE_TOKEN_PREFIX + tokenDigest, "1", {
      nx: true,
      ex: replayTtl,
    });
    if (marked !== "OK") throw new ValidateException("Apple 身份令牌已被使用");

    const spreadCandidate = Number(params.spreadUid ?? 0);
    const spreadUid = Number.isSafeInteger(spreadCandidate) && spreadCandidate > 0
      ? spreadCandidate
      : 0;
    const emailVerified = payload.email_verified === true || payload.email_verified === "true";
    const suffix = payload.sub.slice(-6);
    const verifiedEmailAlias = emailVerified && typeof payload.email === "string"
      ? payload.email.split("@")[0].trim().slice(0, 48)
      : "";
    return new WechatAuthService(this.container, this.env).loginVerifiedIdentity({
      openid: payload.sub,
      userType: "apple",
      nickname: verifiedEmailAlias || `Apple用户${suffix}`,
      spreadUid,
    }, params.ip ?? "");
  }
}
