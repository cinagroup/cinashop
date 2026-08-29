/**
 * CORS 中间件
 * 对应 PHP app/http/middleware/AllowOriginMiddleware.php
 */
import { cors } from "hono/cors";

/**
 * 允许跨域。origin 从配置读, 默认允许所有 (CRMEB 默认行为)。
 * 生产环境应在 wrangler.toml 配 ALLOWED_ORIGINS。
 */
export const corsMiddleware = cors({
  origin: (origin) => {
    // CRMEB 默认放行所有来源; 如需收紧, 在此处校验 origin 白名单
    return origin ?? "*";
  },
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: [
    "Content-Type",
    "Authori-zation", // CRMEB 自定义 header (避开某些服务器 Authorization 被吞的问题)
    "Authorization",
    "Idempotency-Key",
    "X-Scan-Poll-Token",
    "X-Requested-With",
  ],
  exposeHeaders: ["Content-Disposition"],
  credentials: true,
  maxAge: 86400,
});
