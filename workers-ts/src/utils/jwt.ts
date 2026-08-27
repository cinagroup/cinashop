/**
 * JWT 工具
 *
 * 对应 PHP crmeb/utils/JwtAuth.php。
 *
 * 关键契约 (与 PHP 完全一致, 保证新旧 token 互通):
 *   - 算法: HS256
 *   - 密钥: APP_KEY 环境变量 (默认 'crmeb_app_key')
 *   - payload: iss/aud/iat/nbf/exp + jti:{id,type} + auth:md5(pwd)
 *   - exp: web 7 天, app 30 天, out 1 天
 *   - 容差: 60 秒 (leeway)
 */
import { SignJWT, jwtVerify } from "jose";
import { createHash } from "node:crypto";

/** JWT 类型 (对应 PHP jti.type) */
export type TokenType = "api" | "admin" | "out" | "kefu" | "supplier";

/** token 过期时长 (秒) */
const EXP_SECONDS: Record<TokenType, number> = {
  api: 7 * 24 * 3600,
  admin: 7 * 24 * 3600,
  out: 1 * 24 * 3600,
  kefu: 7 * 24 * 3600,
  supplier: 7 * 24 * 3600,
};

/**
 * 自定义 payload 结构。
 *
 * 注意: PHP 的 jti 是对象 {id, type}, 而 jose 的 JWTPayload.jti 类型是 string,
 * 所以这里不 extends JWTPayload, 而是自定义接口 + 类型断言。
 */
export interface CrmebJWTPayload {
  iss?: string;
  aud?: string;
  iat?: number;
  nbf?: number;
  exp?: number;
  jti: { id: number; type: TokenType };
  /** md5(pwd) —— 用于校验改密后旧 token 失效 */
  auth?: string;
}

/**
 * md5 实现 (Workers nodejs_compat 支持 node:crypto)
 * 必须与 PHP md5() 输出一致 (登录/校验都依赖)
 */
export function md5(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

/**
 * 创建 token (对应 PHP JwtAuth::getToken)
 *
 * @param id 用户/管理员 ID
 * @param type token 类型
 * @param pwdMd5 用户密码的 md5, 作为 auth claim (改密后失效)
 * @param secret APP_KEY
 * @param iss 签发方 (域名)
 */
export async function createToken(
  id: number,
  type: TokenType,
  pwdMd5: string,
  secret: string,
  iss = "cinashop",
): Promise<{ token: string; exp: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + EXP_SECONDS[type];
  // jti 是对象 (与 PHP 一致), jose 类型不认, 用 unknown 断言
  const payload: CrmebJWTPayload = {
    iss,
    aud: iss,
    iat: now,
    nbf: now,
    exp,
    jti: { id, type },
    auth: pwdMd5,
  };
  const token = await new SignJWT(
    payload as unknown as import("jose").JWTPayload,
  )
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(secret));

  return { token, exp };
}

/**
 * 验证并解析 token (对应 PHP JwtAuth::verifyToken + parseToken)
 *
 * 失败抛异常 (jwtVerify 抛 JWSSignatureVerificationFailed / JWTExpired 等),
 * 调用方在 auth 中间件捕获后转 AuthException(410001)。
 *
 * @returns { id, type, auth, exp }
 */
export async function verifyToken(
  token: string,
  secret: string,
): Promise<{ id: number; type: TokenType; auth?: string; exp: number }> {
  const { payload } = await jwtVerify(
    token,
    new TextEncoder().encode(secret),
    { algorithms: ["HS256"], clockTolerance: 60 },
  );
  const p = payload as unknown as CrmebJWTPayload;
  if (!p.jti || typeof p.jti.id !== "number" || typeof p.exp !== "number" || !Number.isSafeInteger(p.exp)) {
    throw new Error("invalid jti claim");
  }
  return {
    id: p.jti.id,
    type: p.jti.type,
    auth: p.auth,
    exp: p.exp,
  };
}

/** md5(token) —— 作为 token bucket 的 redis key (与 PHP md5($token) 一致) */
export async function tokenKey(token: string): Promise<string> {
  return md5(token);
}
