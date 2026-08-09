/**
 * 通用 API 类型
 * 与后端 crmeb\utils\Json.php 的信封格式一致:
 *   { status: 200|400|410xxx, msg: string, data: T }
 */

/** 后端响应信封 */
export interface ApiResponse<T = unknown> {
  status: number;
  msg: string;
  data: T;
}

/** 登录成功响应 */
export interface LoginResult {
  token: string;
  expires_time: number;
}

/** 分页列表响应 */
export interface PageResult<T> {
  list: T[];
  count: number | null;
}
