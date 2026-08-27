/**
 * 路由汇总
 *
 * 对应 PHP route/api.php 的整体结构。
 * 全部接口挂在 /api 前缀下 (与 PHP Route::group('api', ...) 一致)。
 */
import { Hono } from "hono";
import { v1Routes } from "./v1";
import { v2Routes } from "./v2";
import type { AppVariables, Env } from "@/env";

export const apiRoutes = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

// 注意: PHP 中 v1 是控制器命名空间, 不是 URL 前缀
// route/api.php 的 /api/logout 实际是 app\controller\api\v1\Login::logout
// 只有 v2 才是真正的 URL 前缀 (/api/v2/*)
apiRoutes.route("/", v1Routes);
apiRoutes.route("/v2", v2Routes);
