import { and, eq } from "drizzle-orm";
import type { ScanLoginAudience } from "@/do/TokenBucketDO";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { storeService, wechatUser } from "@/models/schema";
import { KefuAuthService } from "@/services/kefu/KefuAuthService";
import { LoginService } from "@/services/user/LoginService";
import { WechatAuthService } from "@/services/wechat/WechatAuthService";
import { evaluateAgentLevelsAfterRegistration } from '@/services/agent/AgentLevelRegistrationEffects';
import { cacheSetIfAbsent, cacheTake, clearToken, getRedis } from "@/utils/cache";
import { md5 } from '@/utils/jwt';
import { readOpenPlatformCredentials, withOpenPlatformCredentials, type OpenPlatformCredentials } from './OpenPlatformRuntimeConfig';
import { ServiceUnavailableException, ValidateException } from "@/utils/errors";

const STATE_TTL_SECONDS = 15 * 60;
const PROVIDER_CODE_TTL_SECONDS = 10 * 60;
const STATE_PREFIX = "open_web_oauth_state:";
const CODE_PREFIX = "open_web_oauth_code_used:";
const LIMIT_PER_MINUTE = 30;
const RESPONSE_MAX_BYTES = 32 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface OpenWebOauthState {
  version: 2;
  purpose: "open_web_oauth_login";
  audience: ScanLoginAudience;
  auditIp: string;
  clientOrigin: string;
  issuedAt: number;
  credentialsStamp: string;
}

interface OpenWebIdentity {
  openid: string;
  unionid: string;
  nickname: string;
  avatar: string;
  sex: number;
}

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

async function auditIp(value: string): Promise<string> {
  return (await sha256Hex(value.trim().slice(0, 128) || "unknown")).slice(0, 24);
}

function audienceValue(value: unknown): ScanLoginAudience {
  if (value !== "pc_user" && value !== "kefu_agent") {
    throw new ValidateException("微信开放平台登录场景无效");
  }
  return value;
}

export class WechatOpenWebAuthService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async createOauthState(
    audienceInput: ScanLoginAudience,
    ip = "",
    clientOrigin = "",
  ) {
    const audience = audienceValue(audienceInput);
    const redis = getRedis(this.env);
    if (!redis) throw new ServiceUnavailableException("微信授权状态存储不可用");
    const source = await auditIp(ip);
    const minute = Math.floor(Date.now() / 60_000);
    const count = await redis.eval<[string], number>(
      "local n=redis.call('incr',KEYS[1]); if n==1 then redis.call('expire',KEYS[1],ARGV[1]) end; return n",
      [`open_web_oauth_state_rate_${audience}_${source}_${minute}`],
      ["61"],
    );
    if (Number(count) > LIMIT_PER_MINUTE) {
      throw new ValidateException("微信授权状态请求过于频繁，请稍后重试");
    }
    const credentials = await readOpenPlatformCredentials(this.container, this.env);
    const state = crypto.randomUUID();
    const verifier = randomHex(32);
    const verifierHash = await sha256Hex(verifier);
    const stored = await cacheSetIfAbsent(
      `${STATE_PREFIX}${state}:${verifierHash}`,
      {
        version: 2,
        purpose: "open_web_oauth_login",
        audience,
        auditIp: source,
        clientOrigin,
        issuedAt: Math.floor(Date.now() / 1000),
        credentialsStamp: credentials.stamp,
      } satisfies OpenWebOauthState,
      this.env,
      STATE_TTL_SECONDS,
    );
    if (!stored) throw new ValidateException("微信授权状态创建失败，请重试");
    return { state, expiresIn: STATE_TTL_SECONDS, verifier, appId: credentials.appId };
  }

  async login(
    audienceInput: ScanLoginAudience,
    codeValue: unknown,
    stateValue: unknown,
    verifierValue: unknown,
    ip = "",
  ) {
    const audience = audienceValue(audienceInput);
    const stamp = await this.consumeState(audience, stateValue, verifierValue);
    const credentials = await this.currentCredentials(stamp);
    const code = await this.claimCode(audience, codeValue, ip);
    const identity = await this.exchangeCode(code, credentials);
    let issuedToken = '';
    let committedUid = 0;
    const observe = (token: string) => { issuedToken = token; };
    // Provider I/O is complete before acquiring the shared account barrier.
    // The fresh comparison and all identity writes use one outer transaction.
    try {
      const nonce = crypto.randomUUID();
      const result = await withOpenPlatformCredentials(this.container, this.env, stamp, bound => audience === 'pc_user'
        ? this.loginPc(identity, ip, bound, observe, nonce, uid => { committedUid = uid; })
        : this.loginKefu(identity, bound, observe, nonce));
      // This mature derived-level effect explicitly requires a standalone
      // transaction and is best-effort. Identity and bearer already committed.
      if (committedUid) await evaluateAgentLevelsAfterRegistration(this.container, committedUid);
      return result;
    } catch (error) {
      if (issuedToken) {
        try { await clearToken(md5(issuedToken), this.env); }
        catch { throw new ServiceUnavailableException('微信登录提交未完成，登录状态撤销未确认，请重新发起登录'); }
      }
      throw error;
    }
  }

  private async consumeState(
    audience: ScanLoginAudience,
    stateValue: unknown,
    verifierValue: unknown,
  ): Promise<string> {
    const state = String(stateValue ?? "").trim();
    const verifier = String(verifierValue ?? "").trim().toLowerCase();
    if (!getRedis(this.env)) {
      throw new ServiceUnavailableException("微信授权状态存储不可用");
    }
    if (!UUID_PATTERN.test(state) || !/^[a-f0-9]{64}$/.test(verifier)) {
      throw new ValidateException("微信授权状态无效或已过期");
    }
    const record = await cacheTake<OpenWebOauthState>(
      `${STATE_PREFIX}${state}:${await sha256Hex(verifier)}`,
      this.env,
    );
    const age = Math.floor(Date.now() / 1000) - Number(record?.issuedAt ?? 0);
    if (
      !record
      || record.version !== 2
      || record.purpose !== "open_web_oauth_login"
      || record.audience !== audience
      || !record.clientOrigin
      || !Number.isSafeInteger(record.issuedAt)
      || age < -60
      || age > STATE_TTL_SECONDS + 60
      || !/^[a-f0-9]{64}$/u.test(record.credentialsStamp)
    ) {
      throw new ValidateException("微信授权状态无效或已过期");
    }
    return record.credentialsStamp;
  }

  private async claimCode(
    audience: ScanLoginAudience,
    codeValue: unknown,
    ip: string,
  ): Promise<string> {
    const code = String(codeValue ?? "").trim();
    if (!code || code.length > 512) throw new ValidateException("微信授权 code 无效");
    const redis = getRedis(this.env);
    if (!redis) throw new ServiceUnavailableException("微信授权重放存储不可用");
    const source = await auditIp(ip);
    const minute = Math.floor(Date.now() / 60_000);
    const count = await redis.eval<[string], number>(
      "local n=redis.call('incr',KEYS[1]); if n==1 then redis.call('expire',KEYS[1],ARGV[1]) end; return n",
      [`open_web_oauth_rate_${audience}_${source}_${minute}`],
      ["61"],
    );
    if (Number(count) > LIMIT_PER_MINUTE) {
      throw new ValidateException("微信授权请求过于频繁，请稍后重试");
    }
    const claimed = await cacheSetIfAbsent(
      CODE_PREFIX + await sha256Hex(code),
      { usedAt: Math.floor(Date.now() / 1000) },
      this.env,
      PROVIDER_CODE_TTL_SECONDS,
    );
    if (!claimed) throw new ValidateException("微信授权 code 已使用或已过期");
    return code;
  }

  private async currentCredentials(stamp: string): Promise<OpenPlatformCredentials> {
    const credentials = await readOpenPlatformCredentials(this.container, this.env);
    if (credentials.stamp !== stamp) throw new ValidateException('微信授权配置已变化，请重新发起登录');
    return credentials;
  }

  private async exchangeCode(code: string, config: OpenPlatformCredentials): Promise<OpenWebIdentity> {
    const tokenUrl = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
    tokenUrl.searchParams.set("appid", config.appId);
    tokenUrl.searchParams.set("secret", config.secret);
    tokenUrl.searchParams.set("code", code);
    tokenUrl.searchParams.set("grant_type", "authorization_code");
    const token = await this.fetchWechatJson(tokenUrl.toString());
    await this.currentCredentials(config.stamp);
    const accessToken = String(token.access_token ?? "");
    const openid = String(token.openid ?? "").trim();
    if (token.errcode || !accessToken || !openid || openid.length > 100) {
      throw new ValidateException("微信开放平台授权失败");
    }

    const profileUrl = new URL("https://api.weixin.qq.com/sns/userinfo");
    profileUrl.searchParams.set("access_token", accessToken);
    profileUrl.searchParams.set("openid", openid);
    profileUrl.searchParams.set("lang", "zh_CN");
    const profile = await this.fetchWechatJson(profileUrl.toString());
    await this.currentCredentials(config.stamp);
    const unionid = String(profile.unionid ?? token.unionid ?? "").trim();
    if (profile.errcode || !unionid || unionid.length > 30) {
      throw new ValidateException("微信开放平台未返回可验证的 unionid");
    }
    return {
      openid,
      unionid,
      nickname: String(profile.nickname ?? "").trim().slice(0, 60),
      avatar: String(profile.headimgurl ?? "").trim().slice(0, 256),
      sex: [1, 2].includes(Number(profile.sex)) ? Number(profile.sex) : 0,
    };
  }

  private async loginPc(identity: OpenWebIdentity, ip: string, bound: Container, onIssued: (token: string) => void, nonce: string, afterCommit: (uid: number) => void) {
    const uid = await new WechatAuthService(bound, this.env)
      .reconcileVerifiedIdentity({
        openid: identity.openid,
        unionid: identity.unionid,
        userType: "pc",
        nickname: identity.nickname,
        avatar: identity.avatar,
        sex: identity.sex,
      });
    const issued = await new LoginService(bound, this.env)
      .loginByVerifiedUid(uid, ip, undefined, onIssued, nonce, true);
    afterCommit(uid);
    return { token: issued.token, exp_time: issued.expires_time };
  }

  private async loginKefu(identity: OpenWebIdentity, bound: Container, onIssued: (token: string) => void, nonce: string) {
    const identityRows = await bound.db
      .selectDistinct({ uid: wechatUser.uid })
      .from(wechatUser)
      .where(and(
        eq(wechatUser.unionid, identity.unionid),
        eq(wechatUser.isDel, 0),
      ))
      .limit(2);
    const uids = identityRows.map((row) => row.uid).filter((uid) => uid > 0);
    if (uids.length !== 1) {
      throw new ValidateException(
        uids.length ? "微信身份关联多个用户，请联系管理员处理" : "微信身份未绑定客服用户",
      );
    }
    const user = await bound.userDao.findForAuth(uids[0]);
    if (!user || !user.status) throw new ValidateException("微信身份关联用户不存在或已被禁用");
    const rows = await bound.db
      .select()
      .from(storeService)
      .where(and(
        eq(storeService.uid, uids[0]),
        eq(storeService.isDel, 0),
        eq(storeService.status, 1),
        eq(storeService.accountStatus, 1),
      ))
      .limit(2);
    if (rows.length !== 1) {
      throw new ValidateException(
        rows.length ? "用户关联多个客服账号，请联系管理员处理" : "客服不存在或已被禁用",
      );
    }
    return new KefuAuthService(bound, this.env)
      .loginByVerifiedIdentity(rows[0].id, uids[0], undefined, onIssued, nonce);
  }

  private async fetchWechatJson(url: string): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > RESPONSE_MAX_BYTES) {
        throw new Error("Wechat response exceeded size limit");
      }
      if (!response.ok || !response.body) throw new Error("Wechat response unavailable");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > RESPONSE_MAX_BYTES) {
          await reader.cancel();
          throw new Error("Wechat response exceeded size limit");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Wechat response was not an object");
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ValidateException) throw error;
      throw new ServiceUnavailableException("微信开放平台服务暂时不可用，请重试");
    } finally {
      clearTimeout(timeout);
    }
  }
}
