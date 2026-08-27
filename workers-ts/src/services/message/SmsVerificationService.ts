import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Env, SmsVerificationMessage } from "@/env";
import type { Container } from "@/lib/di";
import { withTx } from "@/lib/di";
import { smsRecord, systemNotification, user } from "@/models/schema";
import { cacheDelete, cacheGet, cacheSet, getRedis } from "@/utils/cache";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { TurnstileService } from "@/services/auth/TurnstileService";

const SMS_LOCK_NAMESPACE = 505_606;
const CODE_TTL_SECONDS = 300;
const PHONE_DAILY_LIMIT = 10;
const IP_DAILY_LIMIT = 50;
const GLOBAL_MINUTE_LIMIT = 20;
const COOLDOWN_SECONDS = 60;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const CHALLENGE_TTL_SECONDS = 300;
const CHALLENGE_CREATE_LIMIT_PER_MINUTE = 20;
const CHALLENGE_VERIFY_LIMIT = 5;
const TURNSTILE_ACTION = "sms_send";

export type SmsVerificationPurpose = SmsVerificationMessage["purpose"];
export type UserSmsType =
  | "register"
  | "mobile"
  | "reset"
  | "binding"
  | "social_binding"
  | "update_phone";
export type UserSmsPurpose = Exclude<SmsVerificationPurpose, "supplier_application">;

export interface VerificationCodeCache {
  code: string;
  uid: number;
  purpose: SmsVerificationPurpose;
}

interface PublicSmsChallenge {
  version: 1;
  phone: string;
  purpose: UserSmsPurpose;
  auditIp: string;
  state: "pending" | "verified";
  createdAt: number;
  expiresAt: number;
  verifiedAt?: number;
}

export interface PublicSmsChallengeResult {
  key: string;
  expire_time: number;
  site_key: string;
  action: typeof TURNSTILE_ACTION;
}

function codeCacheKey(purpose: SmsVerificationPurpose, phone: string): string {
  return purpose === "supplier_application"
    ? `supplier_application_code_${phone}`
    : `user_verification_code_${purpose}_${phone}`;
}

function challengeCacheKey(key: string): string {
  return `sms_challenge_${key}`;
}

function challengeKey(value: unknown): string {
  const key = String(value ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    throw new ValidateException("人机验证挑战无效，请重新获取");
  }
  return key;
}

function phoneNumber(value: unknown): string {
  const phone = String(value ?? "").trim();
  if (!/^1\d{10}$/.test(phone)) throw new ValidateException("手机号格式错误");
  return phone;
}

function stableInt(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

async function normalizedAuditIp(value: string): Promise<string> {
  const ip = value.trim().slice(0, 128);
  const ipv4 = ip.split(".");
  if (
    ipv4.length === 4 &&
    ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  ) return ip;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip || "unknown"));
  const token = [...new Uint8Array(digest)].slice(0, 7)
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `v6${token}`;
}

export function secureSixDigitCode(): string {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  const word = new Uint32Array(1);
  do crypto.getRandomValues(word); while (word[0] >= limit);
  return String(word[0] % 1_000_000).padStart(6, "0");
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

function requireSmsProvider(env: Env): void {
  if (
    !env.ALIYUN_SMS_ACCESS_KEY_ID ||
    !env.ALIYUN_SMS_ACCESS_KEY_SECRET ||
    !env.ALIYUN_SMS_SIGN_NAME
  ) {
    throw new ValidateException("短信服务尚未配置");
  }
}

function requireSmsInfrastructure(env: Env): void {
  if (!env.UPSTASH_REDIS_URL || !env.UPSTASH_REDIS_TOKEN) {
    throw new ValidateException("短信验证缓存尚未配置");
  }
  requireSmsProvider(env);
}

function requireVerificationCache(env: Env): void {
  if (!env.UPSTASH_REDIS_URL || !env.UPSTASH_REDIS_TOKEN) {
    throw new ValidateException("短信验证缓存尚未配置");
  }
}

export function normalizeUserSmsType(value: unknown): {
  type: UserSmsType;
  purpose: UserSmsPurpose;
} {
  const type = String(value ?? "").trim().toLowerCase();
  if (type === "register") return { type, purpose: "user_register" };
  if (type === "mobile" || type === "login") return { type: "mobile", purpose: "user_login" };
  if (type === "reset") return { type, purpose: "user_password_reset" };
  if (type === "binding") return { type, purpose: "user_phone_binding" };
  if (type === "social_binding") return { type, purpose: "user_social_binding" };
  if (type === "update_phone") return { type, purpose: "user_phone_update" };
  throw new ValidateException("短信验证码用途错误");
}

export function isSmsVerificationMessage(value: unknown): value is SmsVerificationMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SmsVerificationMessage>;
  return (
    candidate.action === "sendSmsVerification" &&
    Number.isSafeInteger(candidate.recordId) &&
    Number(candidate.recordId) > 0 &&
    Number.isSafeInteger(candidate.uid) &&
    Number(candidate.uid) >= 0 &&
    typeof candidate.phone === "string" &&
    /^1\d{10}$/.test(candidate.phone) &&
    typeof candidate.code === "string" &&
    /^\d{6}$/.test(candidate.code) &&
    [
      "supplier_application",
      "user_register",
      "user_login",
      "user_password_reset",
      "user_phone_binding",
      "user_social_binding",
      "user_phone_update",
    ].includes(
      String(candidate.purpose),
    ) &&
    (candidate.purpose !== "supplier_application" || Number(candidate.uid) > 0) &&
    Number.isSafeInteger(candidate.expiresIn) &&
    Number(candidate.expiresIn) > 0 &&
    Number(candidate.expiresIn) <= 600 &&
    typeof candidate.templateCode === "string" &&
    candidate.templateCode.length > 0 &&
    candidate.templateCode.length <= 50
  );
}

export class SmsVerificationService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async createPublicChallenge(
    phoneValue: unknown,
    typeValue: unknown,
    ipValue: string,
  ): Promise<PublicSmsChallengeResult> {
    requireVerificationCache(this.env);
    const phone = phoneNumber(phoneValue);
    const { purpose } = normalizeUserSmsType(typeValue);
    const turnstile = new TurnstileService(this.env);
    const { siteKey } = turnstile.publicConfig();
    const redis = getRedis(this.env);
    if (!redis) throw new ValidateException("短信验证缓存尚未配置");
    const key = crypto.randomUUID();
    const auditIp = await normalizedAuditIp(ipValue);
    const minute = Math.floor(Date.now() / 60_000);
    const count = await redis.eval<[string], number>(
      "local n=redis.call('incr',KEYS[1]); if n==1 then redis.call('expire',KEYS[1],ARGV[1]) end; return n",
      [`sms_challenge_create_${auditIp}_${minute}`],
      ["61"],
    );
    if (Number(count) > CHALLENGE_CREATE_LIMIT_PER_MINUTE) {
      throw new ValidateException("人机验证请求过于频繁，请稍后重试");
    }
    const createdAt = Math.floor(Date.now() / 1_000);
    const stored = await cacheSet(
      challengeCacheKey(key),
      {
        version: 1,
        phone,
        purpose,
        auditIp,
        state: "pending",
        createdAt,
        expiresAt: createdAt + CHALLENGE_TTL_SECONDS,
      } satisfies PublicSmsChallenge,
      this.env,
      CHALLENGE_TTL_SECONDS,
    );
    if (!stored) throw new ValidateException("验证码挑战创建失败，请稍后重试");
    return {
      key,
      expire_time: Math.ceil(CHALLENGE_TTL_SECONDS / 60),
      site_key: siteKey,
      action: TURNSTILE_ACTION,
    };
  }

  async publicChallengePage(keyValue: unknown): Promise<{
    key: string;
    siteKey: string;
    action: typeof TURNSTILE_ACTION;
  }> {
    requireVerificationCache(this.env);
    const key = challengeKey(keyValue);
    const challenge = await cacheGet<PublicSmsChallenge>(challengeCacheKey(key), this.env);
    const now = Math.floor(Date.now() / 1_000);
    if (!challenge || challenge.version !== 1 || challenge.expiresAt <= now) {
      throw new ValidateException("人机验证挑战已过期，请重新获取");
    }
    const { siteKey } = new TurnstileService(this.env).publicConfig();
    return { key, siteKey, action: TURNSTILE_ACTION };
  }

  async completePublicChallenge(
    keyValue: unknown,
    tokenValue: unknown,
    ipValue: string,
  ): Promise<{ verified: true; expires_in: number }> {
    requireVerificationCache(this.env);
    const key = challengeKey(keyValue);
    const challenge = await cacheGet<PublicSmsChallenge>(challengeCacheKey(key), this.env);
    const now = Math.floor(Date.now() / 1_000);
    if (!challenge || challenge.version !== 1 || challenge.expiresAt <= now) {
      throw new ValidateException("人机验证挑战已过期，请重新获取");
    }
    if (challenge.state === "verified") {
      return { verified: true, expires_in: challenge.expiresAt - now };
    }
    const redis = getRedis(this.env);
    if (!redis) throw new ValidateException("短信验证缓存尚未配置");
    const attempts = await redis.eval<[string], number>(
      "local n=redis.call('incr',KEYS[1]); if n==1 then redis.call('expire',KEYS[1],ARGV[1]) end; return n",
      [`sms_challenge_verify_${key}`],
      [String(CHALLENGE_TTL_SECONDS)],
    );
    if (Number(attempts) > CHALLENGE_VERIFY_LIMIT) {
      throw new ValidateException("人机验证尝试次数过多，请重新获取");
    }
    await new TurnstileService(this.env).verify(
      tokenValue,
      ipValue,
      TURNSTILE_ACTION,
      key,
    );
    const expiresIn = challenge.expiresAt - now;
    const stored = await cacheSet(
      challengeCacheKey(key),
      { ...challenge, state: "verified", verifiedAt: now } satisfies PublicSmsChallenge,
      this.env,
      expiresIn,
    );
    if (!stored) throw new ValidateException("人机验证状态保存失败，请重试");
    return { verified: true, expires_in: expiresIn };
  }

  async publicChallengeStatus(
    keyValue: unknown,
    ipValue: string,
  ): Promise<{ verified: boolean; expires_in: number }> {
    requireVerificationCache(this.env);
    const key = challengeKey(keyValue);
    const challenge = await cacheGet<PublicSmsChallenge>(challengeCacheKey(key), this.env);
    const now = Math.floor(Date.now() / 1_000);
    const auditIp = await normalizedAuditIp(ipValue);
    if (
      !challenge ||
      challenge.version !== 1 ||
      challenge.expiresAt <= now ||
      challenge.auditIp !== auditIp
    ) {
      throw new ValidateException("人机验证挑战已过期，请重新获取");
    }
    return {
      verified: challenge.state === "verified",
      expires_in: challenge.expiresAt - now,
    };
  }

  async requestUserCode(
    phoneValue: unknown,
    typeValue: unknown,
    keyValue: unknown,
    ipValue: string,
  ): Promise<{ queued: true; expires_in: number }> {
    const phone = phoneNumber(phoneValue);
    const { purpose } = normalizeUserSmsType(typeValue);
    const key = challengeKey(keyValue);
    requireSmsInfrastructure(this.env);
    const redis = getRedis(this.env);
    if (!redis) throw new ValidateException("短信验证缓存尚未配置");
    const challenge = await redis.getdel<PublicSmsChallenge>(challengeCacheKey(key));
    const auditIp = await normalizedAuditIp(ipValue);
    if (
      !challenge ||
      challenge.version !== 1 ||
      challenge.state !== "verified" ||
      challenge.expiresAt <= Math.floor(Date.now() / 1_000) ||
      challenge.auditIp !== auditIp ||
      challenge.phone !== phone ||
      challenge.purpose !== purpose
    ) {
      throw new ValidateException("请先完成人机验证");
    }

    if (purpose === "user_register") {
      const duplicate = await this.container.db.select({ uid: user.uid }).from(user)
        .where(and(
          eq(user.isDel, 0),
          sql`(${user.account} = ${phone} OR ${user.phone} = ${phone})`,
        ))
        .limit(1);
      if (duplicate[0]) throw new ValidateException("手机号已注册");
    }
    return this.queueCode(0, phone, purpose, ipValue);
  }

  async requestSupplierCode(uidValue: unknown, phoneValue: unknown, ipValue: string) {
    const uid = Number(uidValue);
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("用户ID错误");
    const phone = phoneNumber(phoneValue);
    requireSmsInfrastructure(this.env);
    return this.queueCode(uid, phone, "supplier_application", ipValue);
  }

  private async queueCode(
    uid: number,
    phone: string,
    purpose: SmsVerificationPurpose,
    ipValue: string,
  ): Promise<{ queued: true; expires_in: number }> {
    const templateCode = await this.resolveTemplateCode();
    const auditIp = await normalizedAuditIp(ipValue);
    const now = Math.floor(Date.now() / 1000);
    const utc8Now = now + 8 * 3_600;
    const dayStart = utc8Now - (utc8Now % 86_400) - 8 * 3_600;
    const code = secureSixDigitCode();

    const recordId = await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SMS_LOCK_NAMESPACE}, 0)`);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${SMS_LOCK_NAMESPACE}, ${stableInt(`${phone}:${auditIp}`)})`,
      );
      if (purpose === "supplier_application") {
        const users = await tx
          .select({ uid: user.uid })
          .from(user)
          .where(and(eq(user.uid, uid), eq(user.status, 1), eq(user.isDel, 0)))
          .for("update")
          .limit(1);
        if (!users[0]) throw new NotFoundException("用户不存在或已停用");
      }

      const phoneCounts = await tx.select({ count: sql<number>`count(*)::int` })
        .from(smsRecord).where(and(eq(smsRecord.phone, phone), gte(smsRecord.addTime, dayStart)));
      const ipCounts = await tx.select({ count: sql<number>`count(*)::int` })
        .from(smsRecord).where(and(eq(smsRecord.addIp, auditIp), gte(smsRecord.addTime, dayStart)));
      const latest = await tx.select({ addTime: smsRecord.addTime }).from(smsRecord)
        .where(eq(smsRecord.phone, phone)).orderBy(desc(smsRecord.id)).limit(1);
      const recentCounts = await tx.select({ count: sql<number>`count(*)::int` })
        .from(smsRecord).where(gte(smsRecord.addTime, now - COOLDOWN_SECONDS));
      if (Number(phoneCounts[0]?.count ?? 0) >= PHONE_DAILY_LIMIT) {
        throw new ValidateException("该手机号今日验证码次数已达上限");
      }
      if (Number(ipCounts[0]?.count ?? 0) >= IP_DAILY_LIMIT) {
        throw new ValidateException("当前网络今日验证码次数已达上限");
      }
      if (Number(recentCounts[0]?.count ?? 0) >= GLOBAL_MINUTE_LIMIT) {
        throw new ValidateException("短信服务当前繁忙，请稍后再试");
      }
      if (latest[0] && now - latest[0].addTime < COOLDOWN_SECONDS) {
        throw new ValidateException("验证码发送过于频繁，请稍后再试");
      }
      const inserted = await tx.insert(smsRecord).values({
        uid: String(uid),
        phone,
        content: `${purpose} verification code (redacted)`,
        addTime: now,
        addIp: auditIp,
        template: templateCode,
        resultcode: 134,
      }).returning({ id: smsRecord.id });
      return inserted[0].id;
    });

    const message: SmsVerificationMessage = {
      action: "sendSmsVerification",
      recordId,
      uid,
      phone,
      code,
      expiresIn: CODE_TTL_SECONDS,
      purpose,
      templateCode,
    };
    try {
      await this.env.ORDER_QUEUE.send(message);
    } catch {
      await this.container.db.update(smsRecord).set({ resultcode: 130 })
        .where(eq(smsRecord.id, recordId));
      throw new ValidateException("验证码任务提交失败，请稍后重试");
    }
    return { queued: true, expires_in: CODE_TTL_SECONDS };
  }

  async verifySupplierCode(uid: number, phoneValue: unknown, codeValue: unknown): Promise<string> {
    const phone = phoneNumber(phoneValue);
    const code = String(codeValue ?? "").trim();
    if (!/^\d{6}$/.test(code)) throw new ValidateException("验证码格式错误");
    const cached = await cacheGet<VerificationCodeCache>(
      codeCacheKey("supplier_application", phone),
      this.env,
    );
    if (
      !cached ||
      cached.uid !== uid ||
      cached.purpose !== "supplier_application" ||
      !(await constantTimeEqual(cached.code, code))
    ) {
      throw new ValidateException("验证码错误或已过期");
    }
    return phone;
  }

  async consumeSupplierCode(phone: string): Promise<void> {
    await cacheDelete(codeCacheKey("supplier_application", phone), this.env);
  }

  async consumeUserCode(
    purpose: UserSmsPurpose,
    phoneValue: unknown,
    codeValue: unknown,
  ): Promise<string> {
    requireVerificationCache(this.env);
    const phone = phoneNumber(phoneValue);
    const code = String(codeValue ?? "").trim();
    if (!/^\d{6}$/.test(code)) throw new ValidateException("验证码格式错误");
    const redis = getRedis(this.env);
    if (!redis) throw new ValidateException("短信验证缓存尚未配置");
    const cacheKey = codeCacheKey(purpose, phone);
    const lockKey = `${cacheKey}:consume_lock`;
    const lockToken = crypto.randomUUID();
    const acquired = await redis.set(lockKey, lockToken, { nx: true, ex: 5 });
    if (acquired !== "OK") throw new ValidateException("验证码正在验证，请稍后重试");
    try {
      const cached = await cacheGet<VerificationCodeCache>(cacheKey, this.env);
      if (
        !cached ||
        cached.uid !== 0 ||
        cached.purpose !== purpose ||
        !(await constantTimeEqual(cached.code, code))
      ) {
        throw new ValidateException("验证码错误或已过期");
      }
      await cacheDelete(cacheKey, this.env);
      return phone;
    } finally {
      await redis.eval<[string], number>(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        [lockKey],
        [lockToken],
      ).catch(() => 0);
    }
  }

  async processMessage(
    message: SmsVerificationMessage,
    fetcher: typeof fetch = fetch,
  ): Promise<"sent" | "duplicate"> {
    requireSmsInfrastructure(this.env);
    const rows = await this.container.db.select({ resultcode: smsRecord.resultcode })
      .from(smsRecord).where(eq(smsRecord.id, message.recordId)).limit(1);
    if (!rows[0]) throw new NotFoundException("短信审计记录不存在");
    if (rows[0].resultcode === 100) return "duplicate";

    await cacheSet(codeCacheKey(message.purpose, message.phone), {
      code: message.code,
      uid: message.uid,
      purpose: message.purpose,
    } satisfies VerificationCodeCache, this.env, message.expiresIn);

    await sendAliyunSms(this.env, message, fetcher);
    await this.container.db.update(smsRecord).set({ resultcode: 100 })
      .where(eq(smsRecord.id, message.recordId));
    return "sent";
  }

  async abandon(message: SmsVerificationMessage): Promise<void> {
    await Promise.all([
      cacheDelete(codeCacheKey(message.purpose, message.phone), this.env),
      this.container.db.update(smsRecord).set({ resultcode: 130 })
        .where(eq(smsRecord.id, message.recordId)),
    ]);
  }

  private async resolveTemplateCode(): Promise<string> {
    const configured = this.env.ALIYUN_SMS_VERIFICATION_TEMPLATE_CODE?.trim();
    if (configured) return configured.slice(0, 50);
    const rows = await this.container.db.select({ smsId: systemNotification.smsId })
      .from(systemNotification)
      .where(and(
        eq(systemNotification.mark, "VERIFICATION_CODE_TIME"),
        eq(systemNotification.isSms, 1),
      ))
      .orderBy(desc(systemNotification.id)).limit(1);
    const fallback = rows[0]?.smsId.trim() ?? "";
    if (!fallback) throw new ValidateException("短信验证码模板尚未配置");
    return fallback;
  }
}

function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/g, "~");
}

async function hmacSha1Base64(key: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value)),
  );
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error("Aliyun SMS response exceeded 64 KiB");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Aliyun SMS response exceeded 64 KiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function sendAliyunSms(
  env: Env,
  message: SmsVerificationMessage,
  fetcher: typeof fetch = fetch,
): Promise<{ bizId: string; requestId: string }> {
  return sendAliyunTemplateSms(env, {
    phone: message.phone,
    templateCode: message.templateCode,
    templateParams: { code: message.code },
  }, fetcher);
}

export interface AliyunTemplateSmsRequest {
  phone: string;
  templateCode: string;
  templateParams: Record<string, string>;
  outId?: string;
}

export class AliyunSmsRejectedError extends Error {
  constructor(readonly code: string) {
    super(`Aliyun SMS rejected request: ${code}`);
    this.name = "AliyunSmsRejectedError";
  }
}

export async function sendAliyunTemplateSms(
  env: Env,
  request: AliyunTemplateSmsRequest,
  fetcher: typeof fetch = fetch,
): Promise<{ bizId: string; requestId: string }> {
  requireSmsProvider(env);
  const parameters: Record<string, string> = {
    AccessKeyId: env.ALIYUN_SMS_ACCESS_KEY_ID!,
    Action: "SendSms",
    Format: "JSON",
    PhoneNumbers: request.phone,
    RegionId: env.ALIYUN_SMS_REGION_ID?.trim() || "cn-hangzhou",
    SignName: env.ALIYUN_SMS_SIGN_NAME!,
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: "1.0",
    TemplateCode: request.templateCode,
    TemplateParam: JSON.stringify(request.templateParams),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    Version: "2017-05-25",
  };
  if (request.outId) parameters.OutId = request.outId.slice(0, 255);
  const canonical = Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`).join("&");
  const stringToSign = `POST&%2F&${percentEncode(canonical)}`;
  const signature = await hmacSha1Base64(
    `${env.ALIYUN_SMS_ACCESS_KEY_SECRET!}&`,
    stringToSign,
  );
  const body = `${canonical}&Signature=${percentEncode(signature)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  let response: Response;
  let text: string;
  try {
    response = await fetcher("https://dysmsapi.aliyuncs.com/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
    });
    text = await readBoundedText(response);
  } finally {
    clearTimeout(timeout);
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Aliyun SMS returned invalid JSON (${response.status})`);
  }
  if (!response.ok || payload.Code !== "OK") {
    throw new AliyunSmsRejectedError(String(payload.Code ?? response.status));
  }
  return { bizId: String(payload.BizId ?? ""), requestId: String(payload.RequestId ?? "") };
}
