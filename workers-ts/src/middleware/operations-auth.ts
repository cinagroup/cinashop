import type { MiddlewareHandler } from "hono";
import type { AppVariables, Env } from "@/env";

export async function constantTimeEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

/**
 * 迁移、种子和诊断端点的双重门禁：
 * 1. 仅显式调试环境可用；2. 必须提供独立运维密钥。
 */
export const operationsAuthMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> = async (c, next) => {
  const enabled = c.env.DEBUG === "1" || String(c.env.NODE_ENV) === "development";
  const expected = c.env.OPERATIONS_TOKEN;
  const provided = c.req.header("X-Operations-Token") ?? "";

  if (!enabled || !expected || !provided || !(await constantTimeEqual(provided, expected))) {
    return c.json({ status: 403, msg: "运维接口不可用", data: null }, 403);
  }
  await next();
};
