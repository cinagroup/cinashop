import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppVariables, Env } from "@/env";
import { extractToken } from "@/middleware/auth";
import { storeService } from "@/models/schema";
import { publicKefuIdentity } from "@/services/kefu/KefuAuthService";
import { clearToken, getTokenBucket } from "@/utils/cache";
import { ApiErrorCode, AuthException } from "@/utils/errors";
import { md5, verifyToken } from "@/utils/jwt";

/** Dedicated customer-service token domain. Never accepts an admin/user token. */
export const kefuAuthMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> = async (c, next) => {
  const token = extractToken(c);
  if (!token || token === "undefined" || token === "null") {
    throw new AuthException("请登录", ApiErrorCode.ERR_LOGIN);
  }

  const key = md5(token);
  const hasRedis = Boolean(c.env.UPSTASH_REDIS_URL && c.env.UPSTASH_REDIS_TOKEN);
  if (hasRedis) {
    const bucket = await getTokenBucket(key, c.env);
    if (!bucket || bucket.type !== "kefu") {
      throw new AuthException("请登录", ApiErrorCode.ERR_LOGIN);
    }
  }

  let payload: { id: number; type: string; auth?: string; exp: number };
  try {
    payload = await verifyToken(token, c.env.APP_KEY);
  } catch {
    await clearToken(key, c.env).catch(() => undefined);
    throw new AuthException("登录已过期", ApiErrorCode.ERR_EXPIRED);
  }
  if (payload.type !== "kefu") {
    throw new AuthException("无客服权限", ApiErrorCode.ERR_BANNED);
  }

  const rows = await c.get("container").db
    .select()
    .from(storeService)
    .where(
      and(
        eq(storeService.id, payload.id),
        eq(storeService.isDel, 0),
        eq(storeService.status, 1),
        eq(storeService.accountStatus, 1),
      ),
    )
    .limit(1);
  const kefu = rows[0];
  if (!kefu || kefu.uid <= 0) {
    await clearToken(key, c.env).catch(() => undefined);
    throw new AuthException("客服账号不存在、已禁用或未绑定用户", ApiErrorCode.ERR_BANNED);
  }
  if (payload.auth !== md5(kefu.password)) {
    await clearToken(key, c.env).catch(() => undefined);
    throw new AuthException("登录已过期", ApiErrorCode.ERR_EXPIRED);
  }

  c.set("kefuId", kefu.id);
  c.set("kefuUid", kefu.uid);
  c.set("kefuInfo", publicKefuIdentity(kefu));
  c.set("socketTokenKey", key);
  c.set("socketTokenExp", payload.exp);
  c.set("socketAuthId", kefu.id);
  c.set("socketAuthVersion", payload.auth ?? "");
  await next();
};
