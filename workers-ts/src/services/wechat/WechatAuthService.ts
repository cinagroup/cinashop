/**
 * 微信用户 Dao + 登录 Service (M6)
 */
import { eq, or, and, sql } from "drizzle-orm";
import { BaseDao, type DB } from "@/dao/BaseDao";
import { wechatUser, user as userTable } from "@/models/schema";
import type { Container, DbClient } from "@/lib/di";
import type { Env } from "@/env";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { createToken } from "@/utils/jwt";
import { setTokenBucket } from "@/utils/cache";
import { decryptMiniProgramData } from "@/utils/wechat-crypto";

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
  }): Promise<{ token: string; expiresTime: number; uid: number }> {
    const { code } = params;
    if (!code) throw new ValidateException("code 不能为空");

    // 1. code2session
    const session = await this.code2Session(code, "routine");
    const { openid, session_key, unionid } = session;

    // 2. 查/建用户
    const uid = await this.findOrCreateUser({
      openid,
      unionid: unionid ?? "",
      userType: "routine",
    });

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

    // 缓存 session_key (供手机号解密用, key=openid)
    const { cacheSet } = await import("@/utils/cache");
    await cacheSet(`session_key:${openid}`, session_key, this.env, 600);

    return { token, expiresTime: exp, uid };
  }

  /**
   * 小程序手机号授权 (对应 PHP authBindingPhone)
   * 用 session_key + iv 解密 encryptedData 拿手机号, 绑定到用户。
   */
  async bindPhoneByCrypto(params: {
    openid: string;
    iv: string;
    encryptedData: string;
  }): Promise<{ phone: string }> {
    const { cacheGet } = await import("@/utils/cache");
    const sessionKey = await cacheGet<string>(`session_key:${params.openid}`, this.env);
    if (!sessionKey) throw new ValidateException("session_key 已过期, 请重新登录");

    const data = await decryptMiniProgramData(params.encryptedData, sessionKey, params.iv);
    const phone = (data.purePhoneNumber ?? data.phoneNumber) as string;
    if (!phone) throw new ValidateException("手机号解密失败");

    // 绑定手机号到 user
    const wechat = await this.container.wechatUserDao.findByOpenid(params.openid, "routine");
    if (wechat?.uid) {
      await this.container.userDao.update(wechat.uid, { phone });
    }
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
  async oauthLogin(code: string): Promise<{ token: string; expiresTime: number; uid: number }> {
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

    // 3. 查/建用户
    const uid = await this.findOrCreateUser({
      openid,
      unionid: unionid ?? "",
      userType: "wechat",
      nickname,
      avatar: headimgurl,
      sex,
    });

    // 4. 发 token
    const user = await this.container.userDao.findForAuth(uid);
    if (!user) throw new NotFoundException("用户创建失败");
    if (!user.status) throw new ValidateException("您已被禁止登录");

    const { token, exp } = await createToken(uid, "api", user.pwd, this.env.APP_KEY);
    await setTokenBucket(
      (await import("@/utils/jwt")).md5(token),
      { uid, type: "api", token, exp: exp - Math.floor(Date.now() / 1000) + 60 },
      this.env,
    );

    return { token, expiresTime: exp, uid };
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

  /**
   * 按 openid/unionid 查用户, 不存在则建 (对应 PHP wechatOauthAfter)
   * 优先级: phone → unionid → openid
   */
  private async findOrCreateUser(params: {
    openid: string;
    unionid?: string;
    userType: string;
    nickname?: string;
    avatar?: string;
    sex?: number;
  }): Promise<number> {
    const c = this.container;

    // 查 wechat_user
    let wechat = await c.wechatUserDao.findByOpenid(params.openid, params.userType);
    if (wechat && wechat.uid) return wechat.uid;

    // 查 unionid (跨端)
    if (params.unionid) {
      wechat = await c.wechatUserDao.findByOpenid(params.unionid);
      if (wechat && wechat.uid) {
        // 已有 unionid 绑定, 补一条 openid 记录
        await c.wechatUserDao.save({
          uid: wechat.uid,
          openid: params.openid,
          unionid: params.unionid,
          nickname: params.nickname ?? "",
          headimgurl: params.avatar ?? "",
          sex: params.sex ?? 0,
          userType: params.userType,
          addTime: Math.floor(Date.now() / 1000),
        });
        return wechat.uid;
      }
    }

    // 新建 user + wechat_user
    return this.runInTx(c.db, async (tx) => {
      const now = Math.floor(Date.now() / 1000);
      // 建 eb_user (随机账号 + 默认密码)
      const newUser = await tx.insert(userTable).values({
        account: `wx_${params.openid.slice(-12)}`,
        pwd: (await import("@/utils/jwt")).md5("123456"),
        nickname: params.nickname ?? params.openid.slice(-8),
        avatar: params.avatar ?? "",
        phone: "",
        sex: params.sex ?? 0,
        userType: params.userType,
        addTime: now,
        lastTime: now,
      }).returning();
      const uid = newUser[0]?.uid;
      if (!uid) throw new Error("用户创建失败");

      // 建 wechat_user 绑定
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

      return uid;
    });
  }

  private async runInTx<T>(db: DbClient, fn: (tx: DbClient) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => fn(tx as unknown as DbClient));
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
