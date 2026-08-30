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
  ERR_AUTH: 400011, // 暂无权限访问
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
    /** PHP compatibility payload for exceptional envelopes. */
    public readonly data: unknown = null,
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

/** Strongly-consistent edge rate limit; unlike ordinary compatibility errors
 * this is also surfaced as an HTTP 429 so third-party clients can back off. */
export class RateLimitException extends ApiException {
  constructor(
    message = "请求过于频繁，请稍后重试",
    public readonly retryAfterSeconds = 60,
    public readonly recordAudit = true,
  ) {
    super(message, 429);
    this.name = "RateLimitException";
  }
}

/** Security-boundary failures that must carry a real HTTP error status.
 * Ordinary PHP-compatible validation errors intentionally retain their
 * historical HTTP-200 envelope semantics. */
export class HttpApiException extends ApiException {
  constructor(
    message: string,
    code: number,
    public readonly httpStatus: 400 | 403 | 409 | 503,
  ) {
    super(message, code);
    this.name = "HttpApiException";
  }
}

export class ForbiddenException extends HttpApiException {
  constructor(message = "请求来源不受信任") {
    super(message, 403, 403);
    this.name = "ForbiddenException";
  }
}

export class ServiceUnavailableException extends HttpApiException {
  constructor(message = "登录服务暂时不可用，请稍后重试") {
    super(message, 503, 503);
    this.name = "ServiceUnavailableException";
  }
}
