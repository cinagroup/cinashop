/**
 * CORS 中间件
 * 对应 PHP app/http/middleware/AllowOriginMiddleware.php
 */
import { cors } from "hono/cors";
import type { Env } from "@/env";
import { isAllowedCorsOrigin } from "@/services/auth/TrustedAuthClient";

/**
 * 只反射精确允许的来源；生产环境没有 ALLOWED_ORIGINS 时不返回 ACAO。
 * 非生产环境额外接受 localhost/127.0.0.1/[::1] 的 HTTP Origin。
 */
export const corsMiddleware = cors({
  origin: (origin, c) => isAllowedCorsOrigin(origin, c.env as Env) ? origin : null,
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: [
    "Content-Type",
    "Form-type",
    "Authori-zation", // CRMEB 自定义 header (避开某些服务器 Authorization 被吞的问题)
    "Authorization",
    "Idempotency-Key",
    "X-Scan-Poll-Token",
    "X-Visitor-Token",
    "X-Requested-With",
  ],
  exposeHeaders: ["Content-Disposition"],
  credentials: true,
  maxAge: 86400,
});
