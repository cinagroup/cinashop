import type { MiddlewareHandler } from "hono";
import type { AppVariables, Env } from "@/env";
import { clearToken, getTokenBucket } from "@/utils/cache";
import { ApiErrorCode, AuthException } from "@/utils/errors";
import { md5, verifyToken } from "@/utils/jwt";
import { extractToken } from "@/middleware/auth";

/**
 * Supplier 独立后台鉴权。
 *
 * supplierId 始终从已签名 token 对应的 system_admin 关系中派生，
 * 业务处理器不得接受客户端传入的 supplierId 覆盖它。
 */
export const supplierAuthMiddleware: MiddlewareHandler<{
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
    if (!bucket || bucket.type !== "supplier") {
      throw new AuthException("请登录", ApiErrorCode.ERR_LOGIN);
    }
  }

  let payload: { id: number; type: string; auth?: string };
  try {
    payload = await verifyToken(token, c.env.APP_KEY);
  } catch {
    await clearToken(key, c.env).catch(() => undefined);
    throw new AuthException("登录已过期", ApiErrorCode.ERR_EXPIRED);
  }
  if (payload.type !== "supplier") {
    throw new AuthException("无供应商权限", ApiErrorCode.ERR_BANNED);
  }

  const container = c.get("container");
  const admin = await container.systemAdminDao.get(payload.id);
  if (!admin || admin.adminType !== 4 || admin.isDel || !admin.status || admin.relationId <= 0) {
    await clearToken(key, c.env).catch(() => undefined);
    throw new AuthException("供应商账号不存在或已禁用", ApiErrorCode.ERR_BANNED);
  }
  if (payload.auth !== md5(admin.pwd)) {
    await clearToken(key, c.env).catch(() => undefined);
    throw new AuthException("登录已过期", ApiErrorCode.ERR_EXPIRED);
  }

  const supplier = await container.systemSupplierDao.findActiveByRelation(admin.relationId, admin.id);
  if (!supplier) {
    await clearToken(key, c.env).catch(() => undefined);
    throw new AuthException("供应商已停用或绑定关系无效", ApiErrorCode.ERR_BANNED);
  }

  c.set("supplierAdminId", admin.id);
  c.set("supplierId", supplier.id);
  c.set("supplierInfo", {
    id: supplier.id,
    adminId: admin.id,
    supplierName: supplier.supplierName,
    name: supplier.name,
    isShow: supplier.isShow,
  });
  await next();
};
