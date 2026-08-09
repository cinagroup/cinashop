/**
 * JSON 响应封装
 *
 * 对应 PHP crmeb/utils/Json.php —— 所有 API 返回统一信封:
 *   { status: 200|400, msg: string, data: any }
 *
 * 注意: HTTP 状态码始终是 200, 业务错误通过 body.status 区分。
 * 这是为了与现有 CRMEB 前端契约保持一致 (前端按 status 字段判断)。
 */
import type { Context } from "hono";

export interface ApiResponse<T = unknown> {
  status: number;
  msg: string;
  data: T | null;
}

/**
 * 业务成功 (对应 PHP app('json')->success)
 * @example return jsonOk(c, data, '登录成功')
 */
export function jsonOk<T>(c: Context, data: T, msg = "ok") {
  return c.json<ApiResponse<T>>({ status: 200, msg, data });
}

/**
 * 业务失败 (对应 PHP app('json')->fail)
 * HTTP 200, body.status = 400。
 */
export function jsonFail<T>(c: Context, msg = "fail", data: T | null = null) {
  return c.json<ApiResponse<T>>({ status: 400, msg, data });
}

/**
 * 直接构造原始 envelope (用于异常处理, 可指定任意 status)
 */
export function jsonRaw<T>(
  c: Context,
  status: number,
  msg: string,
  data: T | null = null,
) {
  return c.json<ApiResponse<T>>({ status, msg, data });
}
