/**
 * API 错误码 + 自定义异常
 *
 * 对应 PHP crmeb/utils/ApiErrorCode.php + crmeb/exceptions/AuthException.php
 * 错误码与 PHP 端完全一致, 保证前端无需改动即可识别。
 */
export const ApiErrorCode = {
  ERR_LOGIN: 410000, // 请登录
  ERR_EXPIRED: 410001, // 登录已过期
  ERR_BANNED: 410002, // 已被禁止登录
  ERR_SAVE_TOKEN: 400001, // token 保存失败
} as const;

/**
 * 业务异常基类
 * 中间件捕获后转为 {status: code, msg} 响应。
 */
export class ApiException extends Error {
  constructor(
    message: string,
    /** 业务状态码, 放进 body.status (不是 HTTP code) */
    public readonly code: number = 400,
  ) {
    super(message);
    this.name = "ApiException";
  }
}

/** 未登录 / token 缺失 */
export class AuthException extends ApiException {
  constructor(message = "请登录", code: number = ApiErrorCode.ERR_LOGIN) {
    super(message, code);
    this.name = "AuthException";
  }
}

/** 参数校验错误 (对应 ValidateException) */
export class ValidateException extends ApiException {
  constructor(message: string) {
    super(message, 400);
    this.name = "ValidateException";
  }
}

/** 记录未找到 (对应_data 查询返回 null 的场景) */
export class NotFoundException extends ApiException {
  constructor(message = "数据不存在") {
    super(message, 404);
    this.name = "NotFoundException";
  }
}
