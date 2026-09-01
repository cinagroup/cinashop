/**
 * 微信用户 Dao + 登录 Service (M6)
 */
import { eq, or, and, sql } from "drizzle-orm";
import { BaseDao, type DB } from "@/dao/BaseDao";
import { wechatUser, user as userTable } from "@/models/schema";
import { withTx, type Container } from "@/lib/di";
import type { Env } from "@/env";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { createToken, md5 } from "@/utils/jwt";
import {
  cacheDelete,
  cacheGet,
  cacheSet,
  cacheSetIfAbsent,
  cacheTake,
  getRedis,
  setTokenBucket,
} from "@/utils/cache";
import { decryptMiniProgramData } from "@/utils/wechat-crypto";
import { UserFinanceService } from "@/services/user/UserFinanceService";
import { UserBehaviorService } from "@/services/user/UserBehaviorService";
import { LoginService } from "@/services/user/LoginService";
import {
  applyRegistrationGifts,
  StoreNewcomerService,
} from "@/services/activity/StoreNewcomerService";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { V2UserCompatibilityService } from "@/services/user/V2UserCompatibilityService";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";

const SOCIAL_PENDING_TTL_SECONDS = 15 * 60;
const SOCIAL_PENDING_PREFIX = "social_pending:";
const ROUTINE_LOGIN_PREFIX = "routine_login:";
const OAUTH_STATE_PREFIX = "wechat_oauth_state:";
const WECHAT_CODE_PREFIX = "wechat_code_used:";
const WECHAT_CODE_TTL_SECONDS = 10 * 60;
const WECHAT_AUTH_LIMIT_PER_MINUTE = 30;
const WECHAT_RESPONSE_MAX_BYTES = 32 * 1024;
const WECHAT_FETCH_TIMEOUT_MS = 8_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SocialUserType = "wechat" | "routine" | "apple" | "pc";

export interface VerifiedSocialIdentity {
  openid: string;
  unionid?: string;
  userType: SocialUserType;
  nickname?: string;
  avatar?: string;
  sex?: number;
  spreadUid?: number;
}

export interface OfficialSubscriberProfile {
  openid: string;
  unionid: string;
  nickname: string;
  avatar: string;
  sex: number;
  language: string;
  city: string;
  province: string;
  country: string;
  subscribe: number;
  subscribeTime: number;
}

interface PendingSocialIdentity extends VerifiedSocialIdentity {
  version: 1;
  issuedAt: number;
  auditIp: string;
}

export type SocialAuthResult =
  | {
    token: string;
    expiresTime: number;
    uid: number;
    userInfo: { uid: number; nickname: string; avatar: string; phone: string; user_type: string };
    storeUserAvatar: number;
  }
  | { bindPhone: true; key: string; expiresIn: number };

interface RoutineLoginTicket {
  version: 1;
  purpose: "routine_login";
  identity: VerifiedSocialIdentity;
  requiresPhone: boolean;
  issuedAt: number;
  auditIp: string;
}

interface WechatOauthState {
  version: 1;
  purpose: "wechat_oauth_login";
  auditIp: string;
  issuedAt: number;
}

function phoneBindingRequired(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function normalizeIdentity(input: VerifiedSocialIdentity): VerifiedSocialIdentity {
  const openid = String(input.openid ?? "").trim();
  const unionid = String(input.unionid ?? "").trim();
  if (!openid || openid.length > 100) throw new ValidateException("社交身份无效");
  if (unionid.length > 30) throw new ValidateException("社交身份无效");
  if (!["wechat", "routine", "apple", "pc"].includes(input.userType)) {
    throw new ValidateException("社交身份渠道无效");
  }
  const spreadUid = Number(input.spreadUid ?? 0);
  return {
    openid,
    unionid,
    userType: input.userType,
    nickname: String(input.nickname ?? "").trim().slice(0, 60),
    avatar: String(input.avatar ?? "").trim().slice(0, 256),
    sex: [1, 2].includes(Number(input.sex)) ? Number(input.sex) : 0,
    spreadUid: Number.isSafeInteger(spreadUid) && spreadUid > 0 ? spreadUid : 0,
  };
}

function validPendingIdentity(value: unknown): value is PendingSocialIdentity {
  if (!value || typeof value !== "object") return false;
  const pending = value as Partial<PendingSocialIdentity>;
  const age = Math.floor(Date.now() / 1000) - Number(pending.issuedAt ?? 0);
  return pending.version === 1
    && typeof pending.openid === "string"
    && pending.openid.length > 0
    && pending.openid.length <= 100
    && ["wechat", "routine", "apple", "pc"].includes(String(pending.userType))
    && Number.isSafeInteger(pending.issuedAt)
    && Number(pending.issuedAt) > 0
    && typeof pending.auditIp === "string"
    && pending.auditIp.length === 24
    && age >= -60
    && age <= SOCIAL_PENDING_TTL_SECONDS + 60;
}

function validRoutineLoginTicket(value: unknown): value is RoutineLoginTicket {
  if (!value || typeof value !== "object") return false;
  const ticket = value as Partial<RoutineLoginTicket>;
  const age = Math.floor(Date.now() / 1000) - Number(ticket.issuedAt ?? 0);
  return ticket.version === 1
    && ticket.purpose === "routine_login"
    && typeof ticket.requiresPhone === "boolean"
    && typeof ticket.auditIp === "string"
    && ticket.auditIp.length === 24
    && validPendingIdentity({
      ...(ticket.identity ?? {}),
      version: 1,
      issuedAt: ticket.issuedAt,
      auditIp: ticket.auditIp,
    })
    && age >= -60
    && age <= SOCIAL_PENDING_TTL_SECONDS + 60;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function normalizedAuditIp(value: string): Promise<string> {
  const input = value.trim().slice(0, 128) || "unknown";
  return (await sha256Hex(input)).slice(0, 24);
}

// ─── Dao ─────────────────────────────────────────────────────
export class WechatUserDao extends BaseDao<typeof wechatUser> {
  constructor(db: DB) {
    super(db, wechatUser, {
      uid: (v) => eq(wechatUser.uid, Number(v)),
      userType: (v) => eq(wechatUser.userType, String(v)),
      openid: (v) => eq(wechatUser.openid, String(v)),
      isDel: (v) => eq(wechatUser.isDel, Number(v)),
    });
  }

  /** 按 openid/unionid 查 (对应 PHP getAuthUserInfo) */
  async findByOpenid(openid: string, userType?: string) {
    const where = userType
      ? and(
          or(eq(wechatUser.openid, openid), eq(wechatUser.unionid, openid)),
          eq(wechatUser.userType, userType),
          eq(wechatUser.isDel, 0),
        )
      : and(
          or(eq(wechatUser.openid, openid), eq(wechatUser.unionid, openid)),
          eq(wechatUser.isDel, 0),
        );
    const rows = await this.db.select().from(wechatUser).where(where ?? sql`true`).limit(1);
    return rows[0] ?? null;
  }
}

// ─── Service ─────────────────────────────────────────────────
export class WechatAuthService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  /**
   * Create a one-time OAuth state bound to the requesting network. Login
   * callbacks must consume it before exchanging a provider code.
   */
  async createOauthState(ip = ""): Promise<{ state: string; expiresIn: number }> {
    const redis = getRedis(this.env);
    if (!redis) throw new ValidateException("微信授权状态缓存尚未配置");
    const auditIp = await normalizedAuditIp(ip);
    const minute = Math.floor(Date.now() / 60_000);
    const count = await redis.eval<[string], number>(
      "local n=redis.call('incr',KEYS[1]); if n==1 then redis.call('expire',KEYS[1],ARGV[1]) end; return n",
      [`wechat_oauth_state_rate_${auditIp}_${minute}`],
      ["61"],
    );
    if (Number(count) > WECHAT_AUTH_LIMIT_PER_MINUTE) {
      throw new ValidateException("微信授权状态请求过于频繁，请稍后重试");
    }
    const state = crypto.randomUUID();
    const issuedAt = Math.floor(Date.now() / 1000);
    const stored = await cacheSetIfAbsent(
      OAUTH_STATE_PREFIX + state,
      {
        version: 1,
        purpose: "wechat_oauth_login",
        auditIp,
        issuedAt,
      } satisfies WechatOauthState,
      this.env,
      SOCIAL_PENDING_TTL_SECONDS,
    );
    if (!stored) throw new ValidateException("微信授权状态创建失败，请重试");
    return { state, expiresIn: SOCIAL_PENDING_TTL_SECONDS };
  }

  /** Begin the PHP v2 auth_type flow without creating a user or token. */
  async beginMiniProgramLogin(params: {
    code: string;
    spreadUid?: number;
    ip?: string;
  }): Promise<{ bindPhone: boolean; key: string; expiresIn: number }> {
    const session = await this.code2Session(params.code, "routine", params.ip ?? "");
    const identity = normalizeIdentity({
      openid: session.openid,
      unionid: session.unionid ?? "",
      userType: "routine",
      spreadUid: params.spreadUid,
    });
    const [existing, requiredConfig] = await Promise.all([
      this.findExistingIdentityUser(identity),
      new SystemConfigService(this.container, this.env).get("store_user_mobile"),
    ]);
    const requiresPhone = phoneBindingRequired(requiredConfig) && !existing?.phone;
    const key = crypto.randomUUID();
    const stored = await cacheSetIfAbsent(
      ROUTINE_LOGIN_PREFIX + key,
      {
        version: 1,
        purpose: "routine_login",
        identity,
        requiresPhone,
        issuedAt: Math.floor(Date.now() / 1000),
        auditIp: await normalizedAuditIp(params.ip ?? ""),
      } satisfies RoutineLoginTicket,
      this.env,
      SOCIAL_PENDING_TTL_SECONDS,
    );
    if (!stored) throw new ValidateException("小程序登录凭据创建失败，请重试");
    return { bindPhone: requiresPhone, key, expiresIn: SOCIAL_PENDING_TTL_SECONDS };
  }

  /** Atomically consume auth_type's key and issue a token. */
  async completeMiniProgramLogin(
    keyValue: unknown,
    ip = "",
  ): Promise<Extract<SocialAuthResult, { token: string }>> {
    const preview = await this.peekRoutineLoginTicket(keyValue, ip);
    if (preview.requiresPhone) {
      throw new ValidateException("请先绑定手机号");
    }
    const ticket = await this.takeRoutineLoginTicket(keyValue, ip);
    const uid = await this.reconcileVerifiedIdentity(ticket.identity);
    return this.issueSocialToken(uid, ip, ticket.identity.spreadUid);
  }

  async assertMiniProgramPhoneLoginCredential(params: {
    key?: unknown;
    code?: unknown;
    ip?: string;
  }): Promise<void> {
    const key = String(params.key ?? "").trim();
    const code = String(params.code ?? "").trim();
    if ((key ? 1 : 0) + (code ? 1 : 0) !== 1) {
      throw new ValidateException("小程序登录凭据有误，请重新授权");
    }
    if (key) {
      await this.peekRoutineLoginTicket(key, params.ip ?? "");
    } else if (code.length > 512) {
      throw new ValidateException("微信授权 code 无效");
    }
  }

  /**
   * Finish a Mini Program identity with an independently scoped SMS code.
   * The controller consumes that code before entering this method.
   */
  async miniProgramPhoneLogin(params: {
    key?: unknown;
    code?: string;
    phone: string;
    spreadUid?: number;
    ip?: string;
  }): Promise<Extract<SocialAuthResult, { token: string }>> {
    const key = String(params.key ?? "").trim();
    const code = String(params.code ?? "").trim();
    if ((key ? 1 : 0) + (code ? 1 : 0) !== 1) {
      throw new ValidateException("小程序登录凭据有误，请重新授权");
    }
    let identity: VerifiedSocialIdentity;
    if (key) {
      identity = (await this.takeRoutineLoginTicket(key, params.ip ?? "")).identity;
    } else {
      const session = await this.code2Session(code, "routine", params.ip ?? "");
      identity = normalizeIdentity({
        openid: session.openid,
        unionid: session.unionid ?? "",
        userType: "routine",
        spreadUid: params.spreadUid,
      });
    }
    const uid = await this.reconcileVerifiedIdentity({ ...identity, phone: params.phone });
    return this.issueSocialToken(uid, params.ip ?? "", identity.spreadUid);
  }

  /**
   * Bind a provider-verified Mini Program identity to a provider-verified
   * phone credential. Supports the current phone code and the legacy
   * encryptedData/iv contract; neither credential can be replayed.
   */
  async miniProgramPhoneCredentialLogin(params: {
    key?: unknown;
    code?: string;
    phoneCode?: string;
    iv?: string;
    encryptedData?: string;
    spreadUid?: number;
    ip?: string;
    issueToken?: boolean;
  }): Promise<Extract<SocialAuthResult, { token: string }> | { uid: number }> {
    const key = String(params.key ?? "").trim();
    const loginCode = String(params.code ?? "").trim();
    const phoneCode = String(params.phoneCode ?? "").trim();
    const ip = params.ip ?? "";
    let ticket: RoutineLoginTicket | null = null;
    if (key) ticket = await this.peekRoutineLoginTicket(key, ip);

    let identity: VerifiedSocialIdentity | null = ticket?.identity ?? null;
    let phone = "";
    if (phoneCode) {
      if (!identity && !loginCode) {
        throw new ValidateException("请先完成小程序身份授权");
      }
      if (loginCode) {
        const session = await this.code2Session(loginCode, "routine", ip);
        const fromCode = normalizeIdentity({
          openid: session.openid,
          unionid: session.unionid ?? "",
          userType: "routine",
          spreadUid: params.spreadUid,
        });
        if (identity && identity.openid !== fromCode.openid) {
          throw new ValidateException("小程序身份与手机号凭据不匹配");
        }
        identity = identity ?? fromCode;
      }
      phone = await this.phoneNumberFromCode(phoneCode, ip);
    } else {
      if (!loginCode || !params.iv || !params.encryptedData) {
        throw new ValidateException("手机号凭据参数有误");
      }
      const session = await this.code2Session(loginCode, "routine", ip);
      const fromCode = normalizeIdentity({
        openid: session.openid,
        unionid: session.unionid ?? "",
        userType: "routine",
        spreadUid: params.spreadUid,
      });
      if (identity && identity.openid !== fromCode.openid) {
        throw new ValidateException("小程序身份与手机号凭据不匹配");
      }
      identity = identity ?? fromCode;
      let decrypted: Record<string, unknown>;
      try {
        decrypted = await decryptMiniProgramData(
          params.encryptedData,
          session.session_key,
          params.iv,
        );
      } catch {
        throw new ValidateException("手机号解密失败，请重新授权");
      }
      const appId = await this.getAppId("routine");
      const watermark = decrypted.watermark as { appid?: unknown } | undefined;
      if (String(watermark?.appid ?? "") !== appId) {
        throw new ValidateException("手机号凭据所属小程序不匹配");
      }
      phone = String(decrypted.purePhoneNumber ?? decrypted.phoneNumber ?? "").trim();
    }
    if (!identity || !/^1\d{10}$/.test(phone)) {
      throw new ValidateException("手机号凭据无效");
    }
    if (ticket) {
      const consumed = await this.takeRoutineLoginTicket(key, ip);
      if (consumed.identity.openid !== identity.openid) {
        throw new ValidateException("小程序身份凭据不匹配");
      }
      identity = consumed.identity;
    }
    const uid = await this.reconcileVerifiedIdentity({ ...identity, phone });
    if (params.issueToken === false) return { uid };
    return this.issueSocialToken(uid, ip, identity.spreadUid);
  }

  /** PHP v2 routine silent/profile aliases share one provider-verified core. */
  async miniProgramSilentLogin(params: {
    code: string;
    spreadUid?: number;
    ip?: string;
    forcePendingForNew?: boolean;
  }): Promise<SocialAuthResult> {
    const session = await this.code2Session(params.code, "routine", params.ip ?? "");
    return this.loginVerifiedIdentity({
      openid: session.openid,
      unionid: session.unionid ?? "",
      userType: "routine",
      spreadUid: params.spreadUid,
    }, params.ip ?? "", { forcePendingForNew: params.forcePendingForNew });
  }

  /**
   * 小程序登录 (对应 PHP RoutineServices::mp_auth)
   *
   * 流程:
   *   1. code → openid + session_key (调微信 jscode2session)
   *   2. 按 openid/unionid 查/建 user
   *   3. 发 JWT token
   */
  async mpLogin(params: {
    code: string;
    userType?: string;
    spreadUid?: number;
    ip?: string;
  }): Promise<{ token: string; expiresTime: number; uid: number }> {
    const { code } = params;
    if (!code) throw new ValidateException("code 不能为空");

    // 1. code2session
    const session = await this.code2Session(code, "routine", params.ip ?? "");
    const { openid, session_key, unionid } = session;

    // 2. 查/建用户
    const uid = await this.reconcileVerifiedIdentity({
      openid,
      unionid: unionid ?? "",
      userType: "routine",
    });

    // Invalid referral scenes do not block a valid WeChat login, but valid
    // relationships use the same transactional bind/count/audit path.
    const spreadUid = Number(params.spreadUid ?? 0);
    if (Number.isSafeInteger(spreadUid) && spreadUid > 0 && spreadUid !== uid) {
      await new UserFinanceService(this.container)
        .bindSpread(uid, spreadUid)
        .catch((error: unknown) => {
          if (error instanceof ValidateException || error instanceof NotFoundException) return;
          throw error;
        });
    }

    // Store the active Mini Program session under the authenticated uid. The
    // phone-binding endpoint must never select an identity from client input.
    const sessionCached = await Promise.all([
      cacheSet(`session_key:${openid}`, session_key, this.env, 600),
      cacheSet(`session_key_uid:${uid}`, { openid, sessionKey: session_key }, this.env, 600),
    ]);
    if (sessionCached.some((stored) => !stored)) {
      throw new ValidateException("微信会话缓存失败，请重新登录");
    }

    // 3. 发 token
    const user = await this.container.userDao.findForAuth(uid);
    if (!user) throw new NotFoundException("用户创建失败");
    if (!user.status) throw new ValidateException("您已被禁止登录");

    const { token, exp } = await createToken(uid, "api", md5(user.pwd), this.env.APP_KEY);
    const stored = await setTokenBucket(
      md5(token),
      { uid, type: "api", token, exp: exp - Math.floor(Date.now() / 1000) + 60 },
      this.env,
    );
    if (!stored) throw new ValidateException("登录状态保存失败，请重试");

    await new UserBehaviorService(this.container)
      .recordLoginVisit(uid, params.ip)
      .catch((error: unknown) => {
        emitOperationalEvent("error", {
          event: "user_visit_record_failed",
          component: "login",
          operation: "analytics_write",
          outcome: "failure",
          errorCode: operationalErrorCode(error),
        });
      });

    return { token, expiresTime: exp, uid };
  }

  /**
   * 小程序手机号授权 (对应 PHP authBindingPhone)
   * 用 session_key + iv 解密 encryptedData 拿手机号, 绑定到用户。
   */
  async bindPhoneByCrypto(params: {
    uid: number;
    iv: string;
    encryptedData: string;
  }): Promise<{ phone: string }> {
    if (!Number.isSafeInteger(params.uid) || params.uid <= 0) {
      throw new ValidateException("请先登录");
    }
    const session = await cacheTake<{ openid?: string; sessionKey?: string }>(
      `session_key_uid:${params.uid}`,
      this.env,
    );
    if (!session?.openid || !session.sessionKey) {
      throw new ValidateException("微信会话已过期，请重新登录");
    }

    const linked = await this.container.db.select({ uid: wechatUser.uid }).from(wechatUser)
      .where(and(
        eq(wechatUser.uid, params.uid),
        eq(wechatUser.openid, session.openid),
        eq(wechatUser.userType, "routine"),
        eq(wechatUser.isDel, 0),
      ))
      .limit(1);
    if (!linked[0]) throw new ValidateException("微信身份与当前账号不匹配，请重新登录");

    let data: Record<string, unknown>;
    try {
      data = await decryptMiniProgramData(params.encryptedData, session.sessionKey, params.iv);
    } catch {
      throw new ValidateException("手机号解密失败，请重新登录");
    } finally {
      await cacheDelete(`session_key:${session.openid}`, this.env).catch(() => false);
    }
    const appId = await this.getAppId("routine");
    const watermark = data.watermark as { appid?: unknown } | undefined;
    if (String(watermark?.appid ?? "") !== appId) {
      throw new ValidateException("手机号凭据所属小程序不匹配");
    }
    const phone = (data.purePhoneNumber ?? data.phoneNumber) as string;
    if (!/^1\d{10}$/.test(phone)) throw new ValidateException("手机号解密失败");

    // Reuse the same advisory-lock and duplicate-identity rules as SMS
    // registration/binding instead of directly updating the user row.
    const current = await this.container.userDao.findForAuth(params.uid);
    if (!current) throw new NotFoundException("用户不存在");
    if (current.phone === phone) return { phone };
    const login = new LoginService(this.container, this.env);
    if (current.phone) await login.updatePhone(params.uid, phone);
    else await login.bindPhone(params.uid, phone);
    return { phone };
  }

  /**
   * 公众号 OAuth 授权登录 (对应 PHP WechatServices::auth)
   *
   * 流程:
   *   1. code → access_token + openid (sns/oauth2/access_token)
   *   2. access_token + openid → userinfo (sns/userinfo)
   *   3. 查/建用户
   *   4. 发 token
   */
  async oauthLogin(
    code: string,
    ip = "",
    options: { state?: unknown; spreadUid?: number; forcePendingForNew?: boolean } = {},
  ): Promise<SocialAuthResult> {
    if (!code) throw new ValidateException("code 不能为空");

    await this.consumeOauthState(options.state, ip);

    // 1. code 换 access_token + openid
    const tokenResp = await this.oauthAccessToken(code, "wechat", ip);
    const { access_token, openid, unionid } = tokenResp;

    // 2. 取 userinfo
    let nickname = "";
    let headimgurl = "";
    let sex = 0;
    try {
      const userInfo = await this.oauthUserInfo(access_token, openid);
      nickname = userInfo.nickname ?? "";
      headimgurl = userInfo.headimgurl ?? "";
      sex = userInfo.sex ?? 0;
    } catch {
      // snsapi_base 无 userinfo, 忽略
    }

    // Provider calls have finished. From this point forward the identity is
    // server-verified and can either log in or become a one-time pending bind.
    return this.loginVerifiedIdentity({
      openid,
      unionid: unionid ?? "",
      userType: "wechat",
      nickname,
      avatar: headimgurl,
      sex,
      spreadUid: options.spreadUid,
    }, ip, { forcePendingForNew: options.forcePendingForNew });
  }

  /**
   * Refresh an already-authenticated user's official-account profile.
   * The OAuth code and provider response establish the openid; the caller can
   * never choose which social identity is written.
   */
  async refreshOfficialProfile(
    uid: number,
    code: string,
    ip = "",
  ): Promise<{ nickname: string; avatar: string; is_complete: 1 }> {
    if (!code) throw new ValidateException("code 不能为空");
    const token = await this.oauthAccessToken(code, "wechat", ip);
    let official: {
      nickname?: string;
      headimgurl?: string;
      sex?: number;
      language?: string;
      city?: string;
      province?: string;
      country?: string;
    };
    try {
      official = await this.officialUserInfo(token.openid);
    } catch (error) {
      throw new ValidateException(
        `更新公众号用户信息失败：${error instanceof Error ? error.message : "微信接口错误"}`,
      );
    }
    const oauth = await this.oauthUserInfo(token.access_token, token.openid);
    return new V2UserCompatibilityService(this.container).refreshVerifiedOfficialProfile(
      uid,
      {
        openid: token.openid,
        ...official,
        nickname: oauth.nickname ?? official.nickname ?? "",
        headimgurl: oauth.headimgurl ?? official.headimgurl ?? "",
        sex: oauth.sex ?? official.sex ?? 0,
      },
      ip,
    );
  }

  /**
   * Continue a provider-verified identity without trusting client identity
   * fields. When phone binding is mandatory, no new user is created until the
   * independent SMS confirmation completes.
   */
  async loginVerifiedIdentity(
    input: VerifiedSocialIdentity,
    ip = "",
    options: { forcePendingForNew?: boolean } = {},
  ): Promise<SocialAuthResult> {
    const identity = normalizeIdentity(input);
    const config = await new SystemConfigService(this.container, this.env)
      .get("store_user_mobile");
    if (phoneBindingRequired(config) || options.forcePendingForNew) {
      const existing = await this.findExistingIdentityUser(identity);
      if (!existing || (phoneBindingRequired(config) && !existing.phone)) {
        return this.createPendingIdentity(identity, ip);
      }
      return this.issueSocialToken(existing.uid, ip, identity.spreadUid);
    }

    const uid = await this.reconcileVerifiedIdentity(identity);
    return this.issueSocialToken(uid, ip, identity.spreadUid);
  }

  /** Ensure a pending key exists before consuming the independent SMS code. */
  async assertPendingIdentity(keyValue: unknown, ip = ""): Promise<void> {
    const key = String(keyValue ?? "").trim();
    if (!UUID_PATTERN.test(key)) throw new ValidateException("社交绑定凭据无效或已过期");
    if (!getRedis(this.env)) throw new ValidateException("社交绑定缓存尚未配置");
    const pending = await cacheGet<PendingSocialIdentity>(SOCIAL_PENDING_PREFIX + key, this.env);
    if (!validPendingIdentity(pending) || pending.auditIp !== await normalizedAuditIp(ip)) {
      throw new ValidateException("社交绑定凭据无效或已过期");
    }
  }

  /**
   * Atomically consume a verified identity and reconcile openid/unionid/phone
   * in one short PostgreSQL transaction. Redis and PostgreSQL cannot share a
   * commit, so a database failure intentionally requires fresh provider auth.
   */
  async completePendingPhoneBinding(
    keyValue: unknown,
    phone: string,
    ip = "",
  ): Promise<Extract<SocialAuthResult, { token: string }>> {
    const key = String(keyValue ?? "").trim();
    if (!UUID_PATTERN.test(key)) throw new ValidateException("社交绑定凭据无效或已过期");
    if (!getRedis(this.env)) throw new ValidateException("社交绑定缓存尚未配置");
    const pending = await cacheTake<PendingSocialIdentity>(
      SOCIAL_PENDING_PREFIX + key,
      this.env,
    );
    if (!validPendingIdentity(pending) || pending.auditIp !== await normalizedAuditIp(ip)) {
      throw new ValidateException("社交绑定凭据无效或已过期");
    }
    const uid = await this.reconcileVerifiedIdentity({ ...pending, phone });
    return this.issueSocialToken(uid, ip, pending.spreadUid);
  }

  /**
   * JS-SDK 配置签名 (对应 PHP WechatServices::config)
   *
   * 流程:
   *   1. 取 access_token (缓存)
   *   2. 取 jsapi_ticket (缓存)
   *   3. SHA1 签名
   */
  async jsSdkConfig(url: string): Promise<{
    appId: string;
    timestamp: number;
    nonceStr: string;
    signature: string;
  }> {
    const { jsSdkSignature, generateNonceStr } = await import("@/utils/wechat-crypto");
    const ticket = await this.getJsapiTicket();
    const timestamp = Math.floor(Date.now() / 1000);
    const nonceStr = generateNonceStr();
    const signature = await jsSdkSignature(ticket, nonceStr, timestamp, url);

    const appId = await this.getAppId("wechat");
    return { appId, timestamp, nonceStr, signature };
  }

  private async consumeOauthState(stateValue: unknown, ip: string): Promise<void> {
    const state = String(stateValue ?? "").trim();
    if (!UUID_PATTERN.test(state)) {
      throw new ValidateException("微信授权状态无效或已过期");
    }
    if (!getRedis(this.env)) throw new ValidateException("微信授权状态缓存尚未配置");
    const record = await cacheTake<WechatOauthState>(OAUTH_STATE_PREFIX + state, this.env);
    const age = Math.floor(Date.now() / 1000) - Number(record?.issuedAt ?? 0);
    if (
      !record
      || record.version !== 1
      || record.purpose !== "wechat_oauth_login"
      || record.auditIp !== await normalizedAuditIp(ip)
      || !Number.isSafeInteger(record.issuedAt)
      || age < -60
      || age > SOCIAL_PENDING_TTL_SECONDS + 60
    ) {
      throw new ValidateException("微信授权状态无效或已过期");
    }
  }

  private routineTicketKey(value: unknown): string {
    const key = String(value ?? "").trim();
    if (!UUID_PATTERN.test(key)) throw new ValidateException("小程序登录凭据无效或已过期");
    if (!getRedis(this.env)) throw new ValidateException("小程序登录缓存尚未配置");
    return key;
  }

  private async peekRoutineLoginTicket(value: unknown, ip: string): Promise<RoutineLoginTicket> {
    const key = this.routineTicketKey(value);
    const ticket = await cacheGet<RoutineLoginTicket>(ROUTINE_LOGIN_PREFIX + key, this.env);
    if (!validRoutineLoginTicket(ticket) || ticket.auditIp !== await normalizedAuditIp(ip)) {
      throw new ValidateException("小程序登录凭据无效或已过期");
    }
    return ticket;
  }

  private async takeRoutineLoginTicket(value: unknown, ip: string): Promise<RoutineLoginTicket> {
    const key = this.routineTicketKey(value);
    const ticket = await cacheTake<RoutineLoginTicket>(ROUTINE_LOGIN_PREFIX + key, this.env);
    if (!validRoutineLoginTicket(ticket) || ticket.auditIp !== await normalizedAuditIp(ip)) {
      throw new ValidateException("小程序登录凭据无效或已过期");
    }
    return ticket;
  }

  private async claimProviderCode(
    channel: "routine_login" | "routine_phone" | "wechat_oauth",
    codeValue: string,
    ip: string,
  ): Promise<string> {
    const code = String(codeValue ?? "").trim();
    if (!code || code.length > 512) throw new ValidateException("微信授权 code 无效");
    const redis = getRedis(this.env);
    if (!redis) throw new ValidateException("微信授权重放缓存尚未配置");
    const auditIp = await normalizedAuditIp(ip);
    const minute = Math.floor(Date.now() / 60_000);
    const count = await redis.eval<[string], number>(
      "local n=redis.call('incr',KEYS[1]); if n==1 then redis.call('expire',KEYS[1],ARGV[1]) end; return n",
      [`wechat_auth_rate_${channel}_${auditIp}_${minute}`],
      ["61"],
    );
    if (Number(count) > WECHAT_AUTH_LIMIT_PER_MINUTE) {
      throw new ValidateException("微信授权请求过于频繁，请稍后重试");
    }
    const digest = await sha256Hex(`${channel}:${code}`);
    const claimed = await cacheSetIfAbsent(
      `${WECHAT_CODE_PREFIX}${channel}:${digest}`,
      { usedAt: Math.floor(Date.now() / 1000) },
      this.env,
      WECHAT_CODE_TTL_SECONDS,
    );
    if (!claimed) throw new ValidateException("微信授权 code 已使用或已过期");
    return code;
  }

  private async fetchWechatJson(
    url: string,
    init?: RequestInit,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WECHAT_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > WECHAT_RESPONSE_MAX_BYTES) {
        throw new Error("Wechat response exceeded size limit");
      }
      if (!response.body) throw new Error("Wechat response body was empty");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > WECHAT_RESPONSE_MAX_BYTES) {
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
      throw new ValidateException("微信授权服务暂时不可用，请重试");
    } finally {
      clearTimeout(timeout);
    }
  }

  private async phoneNumberFromCode(codeValue: string, ip: string): Promise<string> {
    const code = await this.claimProviderCode("routine_phone", codeValue, ip);
    const accessToken = await this.getMiniProgramAccessToken();
    const url = new URL("https://api.weixin.qq.com/wxa/business/getuserphonenumber");
    url.searchParams.set("access_token", accessToken);
    const data = await this.fetchWechatJson(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    }) as {
      errcode?: number;
      errmsg?: string;
      phone_info?: { phoneNumber?: string; purePhoneNumber?: string };
    };
    if (Number(data.errcode ?? 0) !== 0) {
      throw new ValidateException(`手机号凭据验证失败: ${String(data.errmsg ?? "微信接口错误")}`);
    }
    const phone = String(data.phone_info?.purePhoneNumber ?? data.phone_info?.phoneNumber ?? "").trim();
    if (!/^1\d{10}$/.test(phone)) throw new ValidateException("手机号凭据无效");
    return phone;
  }

  // ─── 内部: 微信 API 调用 ─────────────────────────────────

  /** jscode2session (小程序) */
  private async code2Session(codeValue: string, _type: string, ip = ""): Promise<{
    openid: string;
    session_key: string;
    unionid?: string;
  }> {
    const appId = await this.getAppId("routine");
    const secret = await this.getAppSecret("routine");
    const code = await this.claimProviderCode("routine_login", codeValue, ip);
    const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
    url.searchParams.set("appid", appId);
    url.searchParams.set("secret", secret);
    url.searchParams.set("js_code", code);
    url.searchParams.set("grant_type", "authorization_code");
    const data = await this.fetchWechatJson(url.toString()) as {
      openid?: string;
      session_key?: string;
      unionid?: string;
      errcode?: number;
      errmsg?: string;
    };
    if (data.errcode) throw new ValidateException(`微信登录失败: ${data.errmsg}`);
    if (!data.openid || !data.session_key) throw new ValidateException("微信登录失败: 未返回 openid");
    return { openid: data.openid, session_key: data.session_key, unionid: data.unionid };
  }

  /** OAuth access_token (公众号) */
  private async oauthAccessToken(codeValue: string, _type: string, ip = ""): Promise<{
    access_token: string;
    openid: string;
    unionid?: string;
  }> {
    const appId = await this.getAppId("wechat");
    const secret = await this.getAppSecret("wechat");
    const code = await this.claimProviderCode("wechat_oauth", codeValue, ip);
    const url = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
    url.searchParams.set("appid", appId);
    url.searchParams.set("secret", secret);
    url.searchParams.set("code", code);
    url.searchParams.set("grant_type", "authorization_code");
    const data = await this.fetchWechatJson(url.toString()) as {
      access_token?: string;
      openid?: string;
      unionid?: string;
      errcode?: number;
      errmsg?: string;
    };
    if (data.errcode) throw new ValidateException(`OAuth 失败: ${data.errmsg}`);
    if (!data.access_token || !data.openid) throw new ValidateException("OAuth 失败");
    return { access_token: data.access_token, openid: data.openid, unionid: data.unionid };
  }

  /** OAuth userinfo (公众号) */
  private async oauthUserInfo(accessToken: string, openid: string): Promise<{
    nickname?: string;
    headimgurl?: string;
    sex?: number;
  }> {
    const url = new URL("https://api.weixin.qq.com/sns/userinfo");
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("openid", openid);
    url.searchParams.set("lang", "zh_CN");
    return await this.fetchWechatJson(url.toString()) as {
      nickname?: string;
      headimgurl?: string;
      sex?: number;
    };
  }

  /**
   * Resolve a callback openid through the provider before creating or linking a
   * local account. Provider I/O completes before reconcileVerifiedIdentity opens
   * its short PostgreSQL transaction.
   */
  async reconcileOfficialSubscriber(openidValue: string): Promise<{
    uid: number;
    profile: OfficialSubscriberProfile;
  }> {
    const openid = String(openidValue ?? "").trim();
    if (!openid || openid.length > 100) throw new ValidateException("公众号身份无效");
    const data = await this.officialUserInfo(openid);
    const profile: OfficialSubscriberProfile = {
      openid,
      unionid: String(data.unionid ?? "").trim().slice(0, 30),
      nickname: String(data.nickname ?? "").trim().slice(0, 64),
      avatar: String(data.headimgurl ?? "").trim().slice(0, 256),
      sex: [1, 2].includes(Number(data.sex)) ? Number(data.sex) : 0,
      language: String(data.language ?? "").trim().slice(0, 64),
      city: String(data.city ?? "").trim().slice(0, 64),
      province: String(data.province ?? "").trim().slice(0, 64),
      country: String(data.country ?? "").trim().slice(0, 64),
      subscribe: Number(data.subscribe) === 1 ? 1 : 0,
      subscribeTime: Number.isSafeInteger(Number(data.subscribe_time))
        && Number(data.subscribe_time) > 0
        ? Number(data.subscribe_time)
        : Math.floor(Date.now() / 1000),
    };
    if (profile.subscribe !== 1) throw new ValidateException("公众号用户未关注");
    const uid = await this.reconcileVerifiedIdentity({
      openid,
      unionid: profile.unionid,
      userType: "wechat",
      nickname: profile.nickname,
      avatar: profile.avatar,
      sex: profile.sex,
    });
    return { uid, profile };
  }

  /** Resolve a member-card phone through WeChat, then reuse identity reconciliation. */
  async reconcileOfficialMemberCard(
    openidValue: string,
    cardIdValue: string,
    codeValue: string,
  ): Promise<number> {
    const openid = String(openidValue ?? "").trim();
    const cardId = String(cardIdValue ?? "").trim();
    const code = String(codeValue ?? "").trim();
    if (!openid || openid.length > 100 || !cardId || cardId.length > 50 || !code || code.length > 50) {
      throw new ValidateException("会员卡凭据无效");
    }
    const accessToken = await this.getAccessToken();
    const url = new URL("https://api.weixin.qq.com/card/membercard/userinfo/get");
    url.searchParams.set("access_token", accessToken);
    const data = await this.fetchWechatJson(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ card_id: cardId, code }),
    }) as {
      errcode?: number;
      errmsg?: string;
      user_info?: {
        common_field_list?: Array<{ name?: string; value?: string }>;
      };
    };
    if (Number(data.errcode ?? 0) !== 0) {
      throw new ValidateException(`会员卡资料验证失败: ${String(data.errmsg ?? "微信接口错误")}`);
    }
    const fields = Array.isArray(data.user_info?.common_field_list)
      ? data.user_info.common_field_list
      : [];
    const phone = String(fields.find((field) => (
      String(field?.name ?? "").toUpperCase() === "USER_FORM_INFO_FLAG_MOBILE"
    ))?.value ?? "").trim();
    if (!/^1\d{10}$/.test(phone)) throw new ValidateException("会员卡手机号凭据无效");
    return this.reconcileVerifiedIdentity({ openid, userType: "wechat", phone });
  }

  /** Official-account subscriber profile (the second provider read used by PHP). */
  private async officialUserInfo(openid: string): Promise<{
    nickname?: string;
    headimgurl?: string;
    sex?: number;
    language?: string;
    city?: string;
    province?: string;
    country?: string;
    unionid?: string;
    subscribe?: number;
    subscribe_time?: number;
  }> {
    const accessToken = await this.getAccessToken();
    const url = new URL("https://api.weixin.qq.com/cgi-bin/user/info");
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("openid", openid);
    url.searchParams.set("lang", "zh_CN");
    const data = await this.fetchWechatJson(url.toString()) as {
      nickname?: string;
      headimgurl?: string;
      sex?: number;
      language?: string;
      city?: string;
      province?: string;
      country?: string;
      unionid?: string;
      subscribe?: number;
      subscribe_time?: number;
      errcode?: number;
      errmsg?: string;
    };
    if (data.errcode) throw new Error(data.errmsg || "微信接口错误");
    return data;
  }

  /** 获取 jsapi_ticket (带缓存) */
  private async getJsapiTicket(): Promise<string> {
    const { cacheGet, cacheSet } = await import("@/utils/cache");
    const cached = await cacheGet<string>("jsapi_ticket", this.env);
    if (cached) return cached;

    const accessToken = await this.getAccessToken();
    const url = new URL("https://api.weixin.qq.com/cgi-bin/ticket/getticket");
    url.searchParams.set("access_token", accessToken);
    url.searchParams.set("type", "jsapi");
    const data = await this.fetchWechatJson(url.toString()) as {
      ticket?: string;
      expires_in?: number;
      errcode?: number;
      errmsg?: string;
    };
    if (!data.ticket || data.errcode) {
      throw new ValidateException(`获取 jsapi_ticket 失败: ${String(data.errmsg ?? "微信接口错误")}`);
    }
    if (!(await cacheSet("jsapi_ticket", data.ticket, this.env, data.expires_in ?? 7200))) {
      throw new ValidateException("jsapi_ticket 缓存失败");
    }
    return data.ticket;
  }

  /** 获取 access_token (带缓存, 公众号) */
  private async getAccessToken(): Promise<string> {
    const { cacheGet, cacheSet } = await import("@/utils/cache");
    const cached = await cacheGet<string>("wechat_access_token", this.env);
    if (cached) return cached;

    const appId = await this.getAppId("wechat");
    const secret = await this.getAppSecret("wechat");
    const url = new URL("https://api.weixin.qq.com/cgi-bin/token");
    url.searchParams.set("grant_type", "client_credential");
    url.searchParams.set("appid", appId);
    url.searchParams.set("secret", secret);
    const data = await this.fetchWechatJson(url.toString()) as {
      access_token?: string;
      expires_in?: number;
      errcode?: number;
      errmsg?: string;
    };
    if (!data.access_token || data.errcode) {
      throw new ValidateException(`获取 access_token 失败: ${String(data.errmsg ?? "微信接口错误")}`);
    }
    const ttl = Math.max(60, Number(data.expires_in ?? 7200) - 200);
    if (!(await cacheSet("wechat_access_token", data.access_token, this.env, ttl))) {
      throw new ValidateException("公众号 access_token 缓存失败");
    }
    return data.access_token;
  }

  /** Mini Program access token used by the current phone-number code API. */
  private async getMiniProgramAccessToken(): Promise<string> {
    const cached = await cacheGet<string>("routine_access_token", this.env);
    if (cached) return cached;
    const appId = await this.getAppId("routine");
    const secret = await this.getAppSecret("routine");
    const url = new URL("https://api.weixin.qq.com/cgi-bin/token");
    url.searchParams.set("grant_type", "client_credential");
    url.searchParams.set("appid", appId);
    url.searchParams.set("secret", secret);
    const data = await this.fetchWechatJson(url.toString()) as {
      access_token?: string;
      expires_in?: number;
      errcode?: number;
      errmsg?: string;
    };
    if (!data.access_token || data.errcode) {
      throw new ValidateException(`获取小程序 access_token 失败: ${String(data.errmsg ?? "微信接口错误")}`);
    }
    const ttl = Math.max(60, Number(data.expires_in ?? 7200) - 200);
    if (!(await cacheSet("routine_access_token", data.access_token, this.env, ttl))) {
      throw new ValidateException("小程序 access_token 缓存失败");
    }
    return data.access_token;
  }

  // ─── 内部: 用户查/建 ─────────────────────────────────────

  private async createPendingIdentity(
    identity: VerifiedSocialIdentity,
    ip: string,
  ): Promise<{ bindPhone: true; key: string; expiresIn: number }> {
    if (!getRedis(this.env)) throw new ValidateException("社交绑定缓存尚未配置");
    const key = crypto.randomUUID();
    const pending: PendingSocialIdentity = {
      ...identity,
      version: 1,
      issuedAt: Math.floor(Date.now() / 1000),
      auditIp: await normalizedAuditIp(ip),
    };
    const stored = await cacheSet(
      SOCIAL_PENDING_PREFIX + key,
      pending,
      this.env,
      SOCIAL_PENDING_TTL_SECONDS,
    );
    if (!stored) throw new ValidateException("社交绑定凭据创建失败，请重新授权");
    return { bindPhone: true, key, expiresIn: SOCIAL_PENDING_TTL_SECONDS };
  }

  private async findExistingIdentityUser(identity: VerifiedSocialIdentity) {
    // Include deleted/global-openid rows because the physical unique index is
    // global. Reusing such a value would otherwise fail late or cross channels.
    const exact = await this.container.db.select({
      uid: wechatUser.uid,
      userType: wechatUser.userType,
      isDel: wechatUser.isDel,
    }).from(wechatUser).where(eq(wechatUser.openid, identity.openid)).limit(2);
    if (exact.length > 1 || exact.some((row) => row.isDel !== 0 || row.userType !== identity.userType)) {
      throw new ValidateException("社交身份存在历史或渠道冲突，请联系客服处理");
    }

    const union = identity.unionid
      ? await this.container.db.select({ uid: wechatUser.uid }).from(wechatUser)
        .where(and(eq(wechatUser.unionid, identity.unionid), eq(wechatUser.isDel, 0)))
        .groupBy(wechatUser.uid)
        .limit(2)
      : [];
    if ([...exact, ...union].some((row) => !Number.isSafeInteger(row.uid) || row.uid <= 0)) {
      throw new ValidateException("社交身份关联账号不可用，请联系客服处理");
    }
    const candidates = new Set<number>([
      ...exact.map((row) => row.uid),
      ...union.map((row) => row.uid),
    ].filter((uid) => Number.isSafeInteger(uid) && uid > 0));
    if (candidates.size > 1) {
      throw new ValidateException("社交身份关联多个账号，请联系客服处理");
    }
    const uid = [...candidates][0];
    if (!uid) return null;
    const user = await this.container.userDao.findForAuth(uid);
    if (!user) throw new ValidateException("社交身份关联账号不可用，请联系客服处理");
    return user;
  }

  private async issueSocialToken(uid: number, ip = "", spreadUid = 0) {
    const user = await this.container.userDao.findForAuth(uid);
    if (!user) throw new NotFoundException("用户创建失败");
    if (!user.status) throw new ValidateException("您已被禁止登录");

    if (Number.isSafeInteger(spreadUid) && spreadUid > 0 && spreadUid !== uid) {
      await new UserFinanceService(this.container)
        .bindSpread(uid, spreadUid)
        .catch((error: unknown) => {
          if (error instanceof ValidateException || error instanceof NotFoundException) return;
          throw error;
        });
    }

    const [profiles, storeUserAvatarValue] = await Promise.all([
      this.container.db.select({
        uid: userTable.uid,
        nickname: userTable.nickname,
        avatar: userTable.avatar,
        phone: userTable.phone,
        userType: userTable.userType,
      }).from(userTable).where(and(
        eq(userTable.uid, uid),
        eq(userTable.isDel, 0),
      )).limit(1),
      new SystemConfigService(this.container, this.env).get("store_user_avatar"),
    ]);
    const profile = profiles[0];
    if (!profile) throw new NotFoundException("用户不存在");
    const storeUserAvatar = Number.parseInt(storeUserAvatarValue, 10) || 0;
    const { token, exp } = await createToken(uid, "api", md5(user.pwd), this.env.APP_KEY);
    const stored = await setTokenBucket(
      md5(token),
      { uid, type: "api", token, exp: exp - Math.floor(Date.now() / 1000) + 60 },
      this.env,
    );
    if (!stored) throw new ValidateException("登录状态保存失败，请重试");

    await new UserBehaviorService(this.container)
      .recordLoginVisit(uid, ip)
      .catch((error: unknown) => {
        emitOperationalEvent("error", {
          event: "user_visit_record_failed",
          component: "login",
          operation: "analytics_write",
          outcome: "failure",
          errorCode: operationalErrorCode(error),
        });
      });
    return {
      token,
      expiresTime: exp,
      uid,
      userInfo: {
        uid,
        nickname: profile.nickname,
        avatar: profile.avatar,
        phone: profile.phone,
        user_type: profile.userType,
      },
      storeUserAvatar,
    };
  }

  /**
   * Resolve provider identity and an optional verified phone under the same
   * deterministic lock set. Distinct identity candidates are never merged.
   */
  async reconcileVerifiedIdentity(
    input: VerifiedSocialIdentity & { phone?: string },
  ): Promise<number> {
    const params = normalizeIdentity(input);
    const phone = String(input.phone ?? "").trim();
    if (phone && !/^1\d{10}$/.test(phone)) throw new ValidateException("手机号格式错误");
    const c = this.container;

    if (!phone) {
      const current = await this.findExistingIdentityUser(params);
      if (current) return current.uid;
    }

    const registration = await new StoreNewcomerService(c, this.env).registrationState();
    return withTx(c, async (tx) => {
      const now = Math.floor(Date.now() / 1000);
      const identityLocks = [
        `social-openid:${params.openid}`,
        ...(params.unionid ? [`social-unionid:${params.unionid}`] : []),
        ...(phone ? [`user-phone:${phone}`] : []),
      ].sort();
      for (const identity of identityLocks) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${identity}))`);
      }

      const exact = await tx
        .select({
          uid: wechatUser.uid,
          userType: wechatUser.userType,
          isDel: wechatUser.isDel,
        })
        .from(wechatUser)
        .where(eq(wechatUser.openid, params.openid))
        .limit(2);
      if (exact.length > 1 || exact.some((row) => (
        row.isDel !== 0 || row.userType !== params.userType
      ))) {
        throw new ValidateException("社交身份存在历史或渠道冲突，请联系客服处理");
      }

      const union = params.unionid
        ? await tx.select({ uid: wechatUser.uid }).from(wechatUser)
          .where(and(eq(wechatUser.unionid, params.unionid), eq(wechatUser.isDel, 0)))
          .groupBy(wechatUser.uid)
          .limit(2)
        : [];
      if ([...exact, ...union].some((row) => !Number.isSafeInteger(row.uid) || row.uid <= 0)) {
        throw new ValidateException("社交身份关联账号不可用，请联系客服处理");
      }
      const phoneRows = phone
        ? await tx.select({ uid: userTable.uid }).from(userTable)
          .where(and(
            eq(userTable.isDel, 0),
            or(eq(userTable.account, phone), eq(userTable.phone, phone)),
          ))
          .for("update")
          .limit(2)
        : [];
      if (phoneRows.length > 1) {
        throw new ValidateException("手机号关联多个账号，请联系客服处理");
      }

      const candidates = new Set<number>([
        ...exact.map((row) => row.uid),
        ...union.map((row) => row.uid),
        ...phoneRows.map((row) => row.uid),
      ].filter((uid) => Number.isSafeInteger(uid) && uid > 0));
      if (candidates.size > 1) {
        throw new ValidateException("社交身份与手机号属于不同账号，请联系客服处理");
      }

      let uid = [...candidates][0];
      if (uid) {
        const users = await tx.select({
          uid: userTable.uid,
          account: userTable.account,
          phone: userTable.phone,
        }).from(userTable).where(and(
          eq(userTable.uid, uid),
          eq(userTable.isDel, 0),
        )).for("update").limit(1);
        const user = users[0];
        if (!user) throw new ValidateException("社交身份关联账号不可用，请联系客服处理");
        if (phone && user.phone && user.phone !== phone) {
          throw new ValidateException("社交身份已绑定其他手机号，请联系客服处理");
        }
        if (phone && !user.phone) {
          await tx.update(userTable).set({
            phone,
            ...(user.account === "" ? { account: phone } : {}),
          }).where(eq(userTable.uid, uid));
        }
      } else {
        // Social accounts never inherit PHP's known default password 123456.
        const account = phone || `${params.userType === "apple" ? "apple" : "wx"}_${params.openid.slice(-12)}`;
        const newUser = await tx.insert(userTable).values({
          account,
          pwd: md5(crypto.randomUUID()),
          nickname: params.nickname || `${params.userType === "apple" ? "Apple" : "微信"}用户${params.openid.slice(-6)}`,
          avatar: params.avatar ?? "",
          phone,
          sex: params.sex ?? 0,
          userType: params.userType,
          addTime: now,
          lastTime: now,
          ...registration.flags,
        }).returning({ uid: userTable.uid });
        uid = newUser[0]?.uid;
        if (!uid) throw new Error("用户创建失败");
        await applyRegistrationGifts(tx, uid, registration.gifts, now);
      }

      if (!exact[0]) {
        await tx.insert(wechatUser).values({
          uid,
          openid: params.openid,
          unionid: params.unionid ?? "",
          nickname: params.nickname ?? "",
          headimgurl: params.avatar ?? "",
          sex: params.sex ?? 0,
          userType: params.userType,
          addTime: now,
          subscribeTime: now,
        });
      }

      return uid;
    });
  }

  // ─── 内部: 配置读取 ───────────────────────────────────────

  /** 从 system_config 读 appId */
  private async getAppId(type: "routine" | "wechat"): Promise<string> {
    const svc = new (await import("@/services/system/SystemConfigService")).SystemConfigService(
      this.container,
      this.env,
    );
    const key = type === "routine" ? "routine_appId" : "wechat_appid";
    const id = await svc.get(key);
    if (!id) throw new ValidateException(`${type} appId 未配置`);
    return id;
  }

  private async getAppSecret(type: "routine" | "wechat"): Promise<string> {
    const svc = new (await import("@/services/system/SystemConfigService")).SystemConfigService(
      this.container,
      this.env,
    );
    const key = type === "routine" ? "routine_appsecret" : "wechat_appsecret";
    const secret = await svc.get(key);
    if (!secret) throw new ValidateException(`${type} appSecret 未配置`);
    return secret;
  }
}
