/**
 * 全局错误处理
 *
 * 对应 PHP app/ExceptionHandle.php —— 把异常转为统一 JSON 响应。
 * 放在 Hono app.onError。
 */
import type { Context } from "hono";
import { ApiException, RateLimitException } from "@/utils/errors";
import { jsonRaw } from "@/utils/json";

export function errorHandler(err: Error, c: Context) {
  if (err instanceof RateLimitException) {
    c.header("Retry-After", String(err.retryAfterSeconds));
    c.header("Cache-Control", "private, no-store");
    return c.json({ status: err.code, msg: err.message, data: null }, 429);
  }
  // 已知的业务异常: 用其携带的 code/msg
  if (err instanceof ApiException) {
    return jsonRaw(c, err.code, err.message, null);
  }

  // 未知异常: 隐藏详情, 记录到日志
  console.error("[unhandled]", err.name, err.message, err.stack);
  return jsonRaw(c, 500, "系统繁忙,请稍后再试", null);
}
