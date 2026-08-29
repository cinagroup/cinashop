import { and, eq } from "drizzle-orm";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { storeService } from "@/models/schema";
import type {
  ScanLoginAudience,
  ScanLoginChallengeView,
} from "@/do/TokenBucketDO";
import { KefuAuthService } from "@/services/kefu/KefuAuthService";
import { LoginService } from "@/services/user/LoginService";
import { RateLimitException, ValidateException } from "@/utils/errors";

const CHALLENGE_TTL_SECONDS = 10 * 60;
const CREATE_LIMIT_PER_MINUTE = 20;
const POLL_LIMIT_PER_MINUTE = 180;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POLL_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function randomHex(bytes: number): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function hmacHex(keyValue: string, value: string): Promise<string> {
  if (!keyValue) throw new Error("Scan-login HMAC key unavailable");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyValue),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function challengeKey(value: unknown): string {
  const key = String(value ?? "").trim();
  if (!UUID_PATTERN.test(key)) throw new ValidateException("登录二维码无效或已过期");
  return key.toLowerCase();
}

function pollToken(value: unknown): string {
  const token = String(value ?? "").trim().toLowerCase();
  if (!POLL_TOKEN_PATTERN.test(token)) {
    throw new ValidateException("扫码登录轮询凭据无效");
  }
  return token;
}

function publicChallenge(view: ScanLoginChallengeView) {
  return {
    audience: view.audience,
    stage: view.stage,
    expires_in: Math.max(0, view.expiresAt - Math.floor(Date.now() / 1000)),
  };
}

export class ScanLoginService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  private stub(key: string) {
    return this.env.TOKEN_BUCKET.getByName(`scan-login:${key}`);
  }

  private async enforceRateLimit(
    operation: "create" | "poll",
    ip: string,
  ): Promise<void> {
    const source = await hmacHex(
      this.env.APP_KEY,
      `scan-login:${operation}\u0000${ip.trim().slice(0, 128) || "unknown"}`,
    );
    const limit = operation === "create" ? CREATE_LIMIT_PER_MINUTE : POLL_LIMIT_PER_MINUTE;
    const decision = await this.env.TOKEN_BUCKET
      .getByName(`scan-login-rate:${source.slice(0, 32)}`)
      .consumeRateLimit([{ key: operation, limit }], 60);
    if (!decision.allowed) {
      const retryAfter = Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000));
      throw new RateLimitException("扫码登录请求过于频繁，请稍后重试", retryAfter, false);
    }
  }

  private async activeUser(uid: number): Promise<void> {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("请先登录");
    const user = await this.container.userDao.findForAuth(uid);
    if (!user || !user.status) throw new ValidateException("登录用户不存在或已被禁用");
  }

  private async activeKefu(uid: number): Promise<typeof storeService.$inferSelect> {
    const rows = await this.container.db
      .select()
      .from(storeService)
      .where(and(
        eq(storeService.uid, uid),
        eq(storeService.isDel, 0),
        eq(storeService.status, 1),
        eq(storeService.accountStatus, 1),
      ))
      .limit(2);
    if (rows.length === 0) throw new ValidateException("您不是已启用的客服，无法登录");
    if (rows.length > 1) throw new ValidateException("用户关联多个客服账号，请联系管理员处理");
    return rows[0];
  }

  async create(audience: ScanLoginAudience, ip = "") {
    if (!(["pc_user", "kefu_agent"] as const).includes(audience)) {
      throw new ValidateException("扫码登录场景无效");
    }
    await this.enforceRateLimit("create", ip);
    const key = crypto.randomUUID().toLowerCase();
    const secret = randomHex(32);
    const issuedAt = Math.floor(Date.now() / 1000);
    const created = await this.stub(key).createScanLoginChallenge({
      version: 1,
      audience,
      stage: "pending",
      pollTokenHash: await sha256Hex(secret),
      issuedAt,
      expiresAt: issuedAt + CHALLENGE_TTL_SECONDS,
    });
    if (!created) throw new ValidateException("扫码登录挑战创建失败，请重试");
    return {
      key,
      poll_token: secret,
      time: issuedAt + CHALLENGE_TTL_SECONDS,
      expires_in: CHALLENGE_TTL_SECONDS,
      audience,
    };
  }

  /** Authenticated mobile inspection atomically binds the first scanning uid. */
  async inspect(keyValue: unknown, uid: number) {
    const key = challengeKey(keyValue);
    await this.activeUser(uid);
    const current = await this.stub(key).getScanLoginChallenge();
    if (!current) throw new ValidateException("二维码已过期，请重新扫描");
    if (current.audience === "kefu_agent") await this.activeKefu(uid);
    const scanned = await this.stub(key).markScanLoginChallengeScanned(uid);
    if (!scanned) throw new ValidateException("二维码已由其他账号扫描或已失效");
    return publicChallenge(scanned);
  }

  /** Authenticated mobile approval is restricted to the uid that inspected. */
  async approve(keyValue: unknown, uid: number) {
    const key = challengeKey(keyValue);
    await this.activeUser(uid);
    const current = await this.stub(key).getScanLoginChallenge();
    if (!current) throw new ValidateException("二维码已过期，请重新扫描");
    const kefu = current.audience === "kefu_agent" ? await this.activeKefu(uid) : null;
    const approved = await this.stub(key).approveScanLoginChallenge(uid, kefu?.id);
    if (!approved) throw new ValidateException("请使用扫描二维码的同一账号确认登录");
    return publicChallenge(approved);
  }

  /** Browser polling requires the non-URL secret and consumes approval once. */
  async poll(
    audience: ScanLoginAudience,
    keyValue: unknown,
    tokenValue: unknown,
    ip = "",
  ) {
    const key = challengeKey(keyValue);
    const token = pollToken(tokenValue);
    await this.enforceRateLimit("poll", ip);
    const current = await this.stub(key).getScanLoginChallenge();
    if (!current || current.audience !== audience) return { status: 0 as const };
    const result = await this.stub(key).pollScanLoginChallenge(await sha256Hex(token), audience);
    if (result.status !== 3) return result;
    if (audience === "pc_user") {
      const issued = await new LoginService(this.container, this.env)
        .loginByVerifiedUid(result.uid, ip);
      return {
        status: 3 as const,
        token: issued.token,
        exp_time: issued.expires_time,
      };
    }
    if (!result.kefuId) throw new ValidateException("客服扫码登录身份无效");
    const issued = await new KefuAuthService(this.container, this.env)
      .loginByVerifiedIdentity(result.kefuId, result.uid);
    return { status: 3 as const, ...issued };
  }
}
