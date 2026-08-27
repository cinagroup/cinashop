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
import { cacheGet, cacheSet, cacheTake, getRedis, setTokenBucket } from "@/utils/cache";
import { decryptMiniProgramData } from "@/utils/wechat-crypto";
import { UserFinanceService } from "@/services/user/UserFinanceService";
import { UserBehaviorService } from "@/services/user/UserBehaviorService";
import { LoginService } from "@/services/user/LoginService";
import {
  applyRegistrationGifts,
  StoreNewcomerService,
} from "@/services/activity/StoreNewcomerService";
import { SystemConfigService } from "@/services/system/SystemConfigService";

const SOCIAL_PENDING_TTL_SECONDS = 15 * 60;
const SOCIAL_PENDING_PREFIX = "social_pending:";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SocialUserType = "wechat" | "routine" | "apple";

export interface VerifiedSocialIdentity {
  openid: string;
  unionid?: string;
  userType: SocialUserType;
  nickname?: string;
  avatar?: string;
  sex?: number;
  spreadUid?: number;
}

interface PendingSocialIdentity extends VerifiedSocialIdentity {
  version: 1;
  issuedAt: number;
}

export type SocialAuthResult =
  | { token: string; expiresTime: number; uid: number }
  | { bindPhone: true; key: string; expiresIn: number };

function phoneBindingRequired(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function normalizeIdentity(input: VerifiedSocialIdentity): VerifiedSocialIdentity {
  const openid = String(input.openid ?? "").trim();
  const unionid = String(input.unionid ?? "").trim();
  if (!openid || openid.length > 100) throw new ValidateException("社交身份无效");
  if (unionid.length > 30) throw new ValidateException("社交身份无效");
  if (!["wechat", "routine", "apple"].includes(input.userType)) {
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
    && ["wechat", "routine", "apple"].includes(String(pending.userType))
    && Number.isSafeInteger(pending.issuedAt)
    && Number(pending.issuedAt) > 0
    && age >= -60
    && age <= SOCIAL_PENDING_TTL_SECONDS + 60;
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
    const session = await this.code2Session(code, "routine");
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

    const { token, exp } = await createToken(uid, "api", user.pwd, this.env.APP_KEY);
    await setTokenBucket(
      (await import("@/utils/jwt")).md5(token),
      { uid, type: "api", token, exp: exp - Math.floor(Date.now() / 1000) + 60 },
      this.env,
    );

    await new UserBehaviorService(this.container)
      .recordLoginVisit(uid, params.ip)
      .catch((error: unknown) => {
        console.error(JSON.stringify({
          event: "user_visit_record_failed",
          uid,
          message: error instanceof Error ? error.message : String(error),
        }));
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
    const session = await cacheGet<{ openid?: string; sessionKey?: string }>(
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

    const data = await decryptMiniProgramData(params.encryptedData, session.sessionKey, params.iv);
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
  async oauthLogin(code: string, ip = ""): Promise<SocialAuthResult> {
    if (!code) throw new ValidateException("code 不能为空");

    // 1. code 换 access_token + openid
    const tokenResp = await this.oauthAccessToken(code, "wechat");
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
    }, ip);
  }

  /**
   * Continue a provider-verified identity without trusting client identity
   * fields. When phone binding is mandatory, no new user is created until the
   * independent SMS confirmation completes.
   */
  async loginVerifiedIdentity(
    input: VerifiedSocialIdentity,
    ip = "",
  ): Promise<SocialAuthResult> {
    const identity = normalizeIdentity(input);
    const config = await new SystemConfigService(this.container, this.env)
      .get("store_user_mobile");
    if (phoneBindingRequired(config)) {
      const existing = await this.findExistingIdentityUser(identity);
      if (!existing?.phone) return this.createPendingIdentity(identity);
      return this.issueSocialToken(existing.uid, ip, identity.spreadUid);
    }

    const uid = await this.reconcileVerifiedIdentity(identity);
    return this.issueSocialToken(uid, ip, identity.spreadUid);
  }

  /** Ensure a pending key exists before consuming the independent SMS code. */
  async assertPendingIdentity(keyValue: unknown): Promise<void> {
    const key = String(keyValue ?? "").trim();
    if (!UUID_PATTERN.test(key)) throw new ValidateException("社交绑定凭据无效或已过期");
    if (!getRedis(this.env)) throw new ValidateException("社交绑定缓存尚未配置");
    const pending = await cacheGet<PendingSocialIdentity>(SOCIAL_PENDING_PREFIX + key, this.env);
    if (!validPendingIdentity(pending)) {
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
  ): Promise<{ token: string; expiresTime: number; uid: number }> {
    const key = String(keyValue ?? "").trim();
    if (!UUID_PATTERN.test(key)) throw new ValidateException("社交绑定凭据无效或已过期");
    if (!getRedis(this.env)) throw new ValidateException("社交绑定缓存尚未配置");
    const pending = await cacheTake<PendingSocialIdentity>(
      SOCIAL_PENDING_PREFIX + key,
      this.env,
    );
    if (!validPendingIdentity(pending)) {
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

  // ─── 内部: 微信 API 调用 ─────────────────────────────────

  /** jscode2session (小程序) */
  private async code2Session(code: string, _type: string): Promise<{
    openid: string;
    session_key: string;
    unionid?: string;
  }> {
    const appId = await this.getAppId("routine");
    const secret = await this.getAppSecret("routine");
    const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${appId}&secret=${secret}&js_code=${code}&grant_type=authorization_code`;
    const resp = await fetch(url);
    const data = (await resp.json()) as { openid?: string; session_key?: string; unionid?: string; errcode?: number; errmsg?: string };
    if (data.errcode) throw new ValidateException(`微信登录失败: ${data.errmsg}`);
    if (!data.openid || !data.session_key) throw new ValidateException("微信登录失败: 未返回 openid");
    return { openid: data.openid, session_key: data.session_key, unionid: data.unionid };
  }

  /** OAuth access_token (公众号) */
  private async oauthAccessToken(code: string, _type: string): Promise<{
    access_token: string;
    openid: string;
    unionid?: string;
  }> {
    const appId = await this.getAppId("wechat");
    const secret = await this.getAppSecret("wechat");
    const url = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${appId}&secret=${secret}&code=${code}&grant_type=authorization_code`;
    const resp = await fetch(url);
    const data = (await resp.json()) as { access_token?: string; openid?: string; unionid?: string; errcode?: number; errmsg?: string };
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
    const url = `https://api.weixin.qq.com/sns/userinfo?access_token=${accessToken}&openid=${openid}&lang=zh_CN`;
    const resp = await fetch(url);
    return (await resp.json()) as { nickname?: string; headimgurl?: string; sex?: number };
  }

  /** 获取 jsapi_ticket (带缓存) */
  private async getJsapiTicket(): Promise<string> {
    const { cacheGet, cacheSet } = await import("@/utils/cache");
    const cached = await cacheGet<string>("jsapi_ticket", this.env);
    if (cached) return cached;

    const accessToken = await this.getAccessToken();
    const url = `https://api.weixin.qq.com/cgi-bin/ticket/getticket?access_token=${accessToken}&type=jsapi`;
    const resp = await fetch(url);
    const data = (await resp.json()) as { ticket?: string; expires_in?: number; errcode?: number };
    if (!data.ticket) throw new ValidateException("获取 jsapi_ticket 失败");
    await cacheSet("jsapi_ticket", data.ticket, this.env, data.expires_in ?? 7200);
    return data.ticket;
  }

  /** 获取 access_token (带缓存, 公众号) */
  private async getAccessToken(): Promise<string> {
    const { cacheGet, cacheSet } = await import("@/utils/cache");
    const cached = await cacheGet<string>("wechat_access_token", this.env);
    if (cached) return cached;

    const appId = await this.getAppId("wechat");
    const secret = await this.getAppSecret("wechat");
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${secret}`;
    const resp = await fetch(url);
    const data = (await resp.json()) as { access_token?: string; expires_in?: number; errcode?: number };
    if (!data.access_token) throw new ValidateException("获取 access_token 失败");
    await cacheSet("wechat_access_token", data.access_token, this.env, (data.expires_in ?? 7200) - 200);
    return data.access_token;
  }

  // ─── 内部: 用户查/建 ─────────────────────────────────────

  private async createPendingIdentity(
    identity: VerifiedSocialIdentity,
  ): Promise<{ bindPhone: true; key: string; expiresIn: number }> {
    if (!getRedis(this.env)) throw new ValidateException("社交绑定缓存尚未配置");
    const key = crypto.randomUUID();
    const pending: PendingSocialIdentity = {
      ...identity,
      version: 1,
      issuedAt: Math.floor(Date.now() / 1000),
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

    const { token, exp } = await createToken(uid, "api", user.pwd, this.env.APP_KEY);
    const stored = await setTokenBucket(
      md5(token),
      { uid, type: "api", token, exp: exp - Math.floor(Date.now() / 1000) + 60 },
      this.env,
    );
    if (!stored) throw new ValidateException("登录状态保存失败，请重试");

    await new UserBehaviorService(this.container)
      .recordLoginVisit(uid, ip)
      .catch((error: unknown) => {
        console.error(JSON.stringify({
          event: "user_visit_record_failed",
          uid,
          message: error instanceof Error ? error.message : String(error),
        }));
      });
    return { token, expiresTime: exp, uid };
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
