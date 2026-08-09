/**
 * Admin 鉴权中间件
 *
 * 对应 PHP app/http/middleware/admin/AdminAuthTokenMiddleware.php
 *
 * 与用户 auth 中间件类似, 但:
 *   - token bucket type = 'admin'
 *   - 从 system_admin 表查用户 (不是 user 表)
 *   - 注入 c.set('adminId', ...) / c.set('adminInfo', ...)
 */
import type { MiddlewareHandler } from "hono";
import { AuthException, ApiErrorCode } from "@/utils/errors";
import { verifyToken, md5 } from "@/utils/jwt";
import { clearToken } from "@/utils/cache";
import type { AppVariables, Env } from "@/env";

export function adminAuthMiddleware(): MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> {
  return async (c, next) => {
    c.set("adminId", 0);

    const token =
      c.req.header("Authori-zation")?.replace(/^Bearer\s+/, "").trim() ||
      c.req.header("Authorization")?.replace(/^Bearer\s+/, "").trim() ||
      "";

    if (!token || token === "undefined") {
      throw new AuthException("请登录", ApiErrorCode.ERR_LOGIN);
    }

    const env = c.env;
    const key = md5(token);

    // Layer 1: token bucket
    const hasRedis = !!(env.UPSTASH_REDIS_URL && env.UPSTASH_REDIS_TOKEN);
    if (hasRedis) {
      const { getTokenBucket: gtb } = await import("@/utils/cache");
      const bucket = await gtb(key, env);
      if (!bucket || bucket.type !== "admin") {
        throw new AuthException("请登录", ApiErrorCode.ERR_LOGIN);
      }
    }

    // Layer 2: JWT
    let payload: { id: number; type: string; auth?: string };
    try {
      payload = await verifyToken(token, env.APP_KEY);
    } catch {
      await clearToken(key, env).catch(() => {});
      throw new AuthException("登录已过期", ApiErrorCode.ERR_EXPIRED);
    }
    if (payload.type !== "admin") {
      throw new AuthException("无管理员权限", ApiErrorCode.ERR_BANNED);
    }

    // Layer 3: 查 admin
    const container = c.get("container");
    const admin = await container.systemAdminDao.get(payload.id);
    if (!admin || !admin.status || admin.isDel) {
      throw new AuthException("账号不存在或已禁用", ApiErrorCode.ERR_BANNED);
    }

    // Layer 4: auth claim
    // AdminAuthService 调用 createToken(id, 'admin', md5(pwd)) → auth = md5(pwd)
    if (payload.auth !== md5(admin.pwd)) {
      throw new AuthException("登录已过期", ApiErrorCode.ERR_EXPIRED);
    }

    c.set("adminId", admin.id);
    c.set("adminInfo", {
      id: admin.id,
      account: admin.account,
      level: admin.level,
      roles: admin.roles,
      realName: admin.realName,
    });

    await next();
  };
}
