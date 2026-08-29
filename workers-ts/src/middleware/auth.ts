/**
 * 鉴权中间件
 *
 * 对应 PHP app/http/middleware/api/AuthTokenMiddleware.php + UserAuthServices::parseToken。
 *
 * 双层验证 (与 PHP 完全一致):
 *   1. Upstash token bucket: md5(token) → {uid, type, token, exp}  (快失败)
 *   2. JWT 签名 + exp: jose.jwtVerify
 *   3. DB 查用户: status 是否封禁
 *   4. auth claim 校验: md5(pwd) 必须匹配 (改密后失效)
 *
 * 用法:
 *   app.get("/user", authMiddleware({ force: true }), handler)   // 必须登录
 *   app.get("/products", authMiddleware({ force: false }), handler) // 可选登录
 *
 * 注入 c.var:
 *   - uid: number (未登录为 0)
 *   - user: AuthUser | undefined
 *   - isLogin: boolean
 */
import type { Context, MiddlewareHandler } from "hono";
import { AuthException, ApiErrorCode } from "@/utils/errors";
import { verifyToken, md5 } from "@/utils/jwt";
import { getTokenBucket, clearToken } from "@/utils/cache";
import type { AppVariables, AuthUser, Env } from "@/env";

interface AuthOptions {
  /** true=必须登录, 未登录抛 410000; false=可选, 未登录放行 uid=0 */
  force: boolean;
}

/** 从 HTTP header 或 WebSocket 子协议提取 token。 */
export function extractToken(c: Context): string | null {
  const h1 = c.req.header("Authori-zation");
  if (h1) return h1.replace(/^Bearer\s+/, "").trim();
  const h2 = c.req.header("Authorization");
  if (h2) return h2.replace(/^Bearer\s+/, "").trim();
  const protocols = c.req.header("Sec-WebSocket-Protocol")?.split(",") ?? [];
  const authProtocol = protocols.map((value) => value.trim()).find((value) => value.startsWith("cinashop-auth."));
  if (authProtocol) return authProtocol.slice("cinashop-auth.".length);
  return null;
}

/** 把 AuthUser 字段裁剪成中间件需要的最小集 (schema 用驼峰) */
function toAuthUser(u: {
  uid: number;
  account: string;
  pwd: string;
  status: number;
  nickname: string;
  avatar: string;
  phone: string;
  nowMoney: string;
  integral: number;
  level: number;
}): AuthUser {
  return {
    uid: u.uid,
    account: u.account,
    pwd: u.pwd,
    status: u.status,
    nickname: u.nickname,
    avatar: u.avatar,
    phone: u.phone,
    now_money: typeof u.nowMoney === "string" ? u.nowMoney : String(u.nowMoney),
    integral: u.integral,
    level: u.level,
  };
}

export function authMiddleware(opts: AuthOptions): MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> {
  const { force } = opts;
  return async (c, next) => {
    // 默认未登录状态
    c.set("uid", 0);
    c.set("isLogin", false);

    const token = extractToken(c);

    // 无 token
    if (!token || token === "undefined" || token === "null") {
      if (force) throw new AuthException("请登录", ApiErrorCode.ERR_LOGIN);
      await next();
      return;
    }

    const env = c.env;
    const key = md5(token);

    // Layer 1: token bucket. Production never degrades to a bearer-only JWT;
    // local/test environments may omit Redis for isolated unit work.
    const bucket = await getTokenBucket(key, env);
    const hasRedis = !!(c.env.UPSTASH_REDIS_URL && c.env.UPSTASH_REDIS_TOKEN);
    if (hasRedis) {
      // Redis 可用时, bucket 校验是必须的
      if (
        !bucket
        || bucket.type !== "api"
        || bucket.token !== token
        || (typeof bucket.uid !== "number" && typeof bucket.uid !== "string")
      ) {
        if (force) throw new AuthException("请登录", ApiErrorCode.ERR_LOGIN);
        await next();
        return;
      }
    }

    // Layer 2: JWT 签名 + exp
    let payload: { id: number; type: string; auth?: string; exp: number };
    try {
      payload = await verifyToken(token, env.APP_KEY);
    } catch {
      await clearToken(key, env).catch(() => {});
      if (force) throw new AuthException("登录已过期,请重新登录", ApiErrorCode.ERR_EXPIRED);
      await next();
      return;
    }

    if (payload.type !== "api") {
      if (force) throw new AuthException("无用户端权限", ApiErrorCode.ERR_BANNED);
      await next();
      return;
    }

    // bucket uid 与 JWT uid 必须一致 (Redis 不可用时跳过此检查)
    if (hasRedis && bucket && Number(payload.id) !== Number(bucket.uid)) {
      await clearToken(key, env).catch(() => {});
      if (force) throw new AuthException("登录状态有误,请重新登录", ApiErrorCode.ERR_BANNED);
      await next();
      return;
    }

    // Layer 3: 查用户 (DI 容器已注入 c.var)
    const container = c.get("container");
    if (!container) {
      throw new Error("container not found in c.var — 装配中间件未运行?");
    }
    const user = await container.userDao.findForAuth(payload.id);
    if (!user) {
      if (force) throw new AuthException("用户不存在,请重新登陆", ApiErrorCode.ERR_EXPIRED);
      await next();
      return;
    }
    if (!user.status) {
      if (force) throw new AuthException("您已被禁止登录,请联系管理员", ApiErrorCode.ERR_BANNED);
      await next();
      return;
    }

    // Layer 4: PHP BaseServices::createToken 会把数据库密码哈希再 md5 一次。
    // 迁移初期的 Worker 曾错误地直接写入 user.pwd；旧值只在当前 token 的
    // 精确 Redis bucket 仍活跃时兼容。旧签发器修复后，该窗口最多持续一个
    // API token bucket 生命周期（7 天 + 60 秒），且改密仍会立即使其失效。
    const authoritativeAuth = md5(user.pwd);
    const activeLegacyWorkerToken = hasRedis
      && bucket?.type === "api"
      && bucket.token === token
      && Number(bucket.uid) === Number(user.uid)
      && payload.auth === user.pwd;
    if (payload.auth !== authoritativeAuth && !activeLegacyWorkerToken) {
      if (force) throw new AuthException("登录已过期,请重新登录", ApiErrorCode.ERR_EXPIRED);
      await next();
      return;
    }

    // 全部通过 → 注入登录态
    c.set("uid", user.uid);
    c.set("user", toAuthUser(user));
    c.set("isLogin", true);
    c.set("socketTokenKey", key);
    c.set("socketTokenExp", payload.exp);
    c.set("socketAuthId", user.uid);
    c.set("socketAuthVersion", payload.auth ?? "");
    await next();
  };
}
