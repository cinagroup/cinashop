/**
 * Hono 应用装配
 *
 * 中间件顺序:
 *   1. cors
 *   2. container (DI 注入, 必须在 auth 之前, 因为 auth 要用 container.userDao)
 *   3. 业务路由 (/api/*)
 *   4. onError (兜底)
 *
 * 对应 PHP 的中间件栈: AllowOrigin → InstallMiddleware → StationOpen → AuthToken
 * (InstallMiddleware / StationOpen M1 暂不实现, M2 补)
 */
import { Hono } from "hono";
import { corsMiddleware } from "@/middleware/cors";
import { containerMiddleware } from "@/middleware/container";
import { errorHandler } from "@/middleware/error";
import { apiRoutes } from "@/routes";
import { adminapiRoutes } from "@/routes/adminapi";
import { supplierapiRoutes } from "@/routes/supplierapi";
import { outapiRoutes } from "@/routes/outapi";
import { kefuapiRoutes } from "@/routes/kefuapi";
import type { AppVariables, Env } from "@/env";

export function createApp() {
  const app = new Hono<{
    Bindings: Env;
    Variables: AppVariables;
  }>();

  // 1. CORS
  app.use("*", corsMiddleware);

  // 2. DI 容器 (每请求注入)
  app.use("*", containerMiddleware);

  // 3. 健康检查 (无 auth, 无 DB)
  app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

  // 4. 业务路由
  app.route("/api", apiRoutes);

  // 5. Admin 前端兼容路由 (/adminapi/*)
  app.route("/adminapi", adminapiRoutes);

  // 6. Supplier 独立后台兼容路由 (/supplierapi/*)
  app.route("/supplierapi", supplierapiRoutes);

  // 7. PHP-compatible third-party API routes use a separate token/ACL domain.
  app.route("/outapi", outapiRoutes);

  // 8. Dedicated customer-service token and data scope (/kefuapi/*).
  app.route("/kefuapi", kefuapiRoutes);

  // 9. 404 (对应 PHP Route::miss)
  app.notFound((c) => c.json({ status: 404, msg: "not found", data: null }));

  // 10. 错误兜底
  app.onError(errorHandler);

  return app;
}
