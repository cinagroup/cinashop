/**
 * Upstash Redis 封装
 *
 * 对应 PHP crmeb/services/CacheService.php + RedisService。
 *
 * Workers 不能开 TCP 长连接, 所以用 Upstash 的 REST API (@upstash/redis)。
 * 这反而更适合 Workers (无连接数限制)。
 *
 * Token bucket 相关方法保留 PHP 命名 (getTokenBucket/setTokenBucket/clearToken),
 * 便于对照。
 */
import { Redis } from "@upstash/redis/cloudflare";
import { ServiceUnavailableException } from "@/utils/errors";
export interface RedisEnv {
  UPSTASH_REDIS_URL: string;
  UPSTASH_REDIS_TOKEN: string;
  NODE_ENV?: string;
}

/** Token bucket 存储结构 (对应 PHP CacheService::setTokenBucket 的 value) */
export interface TokenBucket {
  uid: number;
  type: string;
  token: string;
  exp: number; // 秒
}

let _redis: Redis | null = null;

/** 惰性单例 (同一 isolate 复用, 避免重复创建 client) */
export function getRedis(env: RedisEnv): Redis | null {
  if (_redis) return _redis;
  if (!env.UPSTASH_REDIS_URL || !env.UPSTASH_REDIS_TOKEN) {
    return null; // Redis 未配置, 调用方降级处理
  }
  _redis = new Redis({
    url: env.UPSTASH_REDIS_URL,
    token: env.UPSTASH_REDIS_TOKEN,
  });
  return _redis;
}

/** key 前缀 (PHP cache.stores.redis.prefix, 默认空) */
const PREFIX = "";

// ─── Token Bucket (鉴权令牌桶) ─────────────────────────────

/** token bucket key 前缀 */
const TB_PREFIX = "tb_";

/** 取令牌桶 (对应 CacheService::getTokenBucket) */
export async function getTokenBucket(key: string, env: RedisEnv): Promise<TokenBucket | null> {
  const r = getRedis(env);
  if (!r) {
    if (env.NODE_ENV === "production") {
      throw new ServiceUnavailableException("令牌状态存储不可用");
    }
    return null;
  }
  try {
    const raw = await r.get<TokenBucket>(PREFIX + TB_PREFIX + key);
    return raw ?? null;
  } catch {
    throw new ServiceUnavailableException("令牌状态存储不可用");
  }
}

/** 存令牌桶, 带 TTL (对应 CacheService::setTokenBucket) */
export async function setTokenBucket(
  key: string,
  bucket: TokenBucket,
  env: RedisEnv,
): Promise<boolean> {
  const r = getRedis(env);
  if (!r) throw new ServiceUnavailableException("令牌状态存储不可用");
  try {
    const result = await r.set(PREFIX + TB_PREFIX + key, bucket, { ex: bucket.exp });
    if (result !== "OK") throw new ServiceUnavailableException("令牌状态存储不可用");
    return true;
  } catch (error) {
    if (error instanceof ServiceUnavailableException) throw error;
    throw new ServiceUnavailableException("令牌状态存储不可用");
  }
}

/** 清除令牌桶 (对应 CacheService::clearToken) */
export async function clearToken(key: string, env: RedisEnv): Promise<boolean> {
  const r = getRedis(env);
  if (!r) {
    if (env.NODE_ENV === "production") {
      throw new ServiceUnavailableException("令牌状态存储不可用");
    }
    return true;
  }
  try {
    const count = await r.del(PREFIX + TB_PREFIX + key);
    return count > 0;
  } catch {
    throw new ServiceUnavailableException("令牌状态存储不可用");
  }
}

// ─── 通用缓存 (对应 CacheService::get/set/delete) ──────────

export async function cacheGet<T>(key: string, env: RedisEnv): Promise<T | null> {
  const r = getRedis(env);
  if (!r) return null;
  return r.get<T>(PREFIX + key);
}

/**
 * Atomically read and delete a cache value.
 *
 * This is reserved for one-time capabilities (for example a verified social
 * identity waiting for phone confirmation). Callers must still fail closed
 * when Redis is not configured; a null result never means "continue anyway".
 */
export async function cacheTake<T>(key: string, env: RedisEnv): Promise<T | null> {
  const r = getRedis(env);
  if (!r) return null;
  return r.getdel<T>(PREFIX + key);
}

export async function cacheSet(
  key: string,
  value: unknown,
  env: RedisEnv,
  ttlSeconds?: number,
): Promise<boolean> {
  const r = getRedis(env);
  if (!r) return true;
  const result =
    ttlSeconds !== undefined
      ? await r.set(PREFIX + key, value, { ex: ttlSeconds })
      : await r.set(PREFIX + key, value);
  return result === "OK";
}

/** Set a TTL-bound value only when the key does not already exist. */
export async function cacheSetIfAbsent(
  key: string,
  value: unknown,
  env: RedisEnv,
  ttlSeconds: number,
): Promise<boolean> {
  const r = getRedis(env);
  if (!r) return false;
  const result = await r.set(PREFIX + key, value, { ex: ttlSeconds, nx: true });
  return result === "OK";
}

export async function cacheDelete(key: string, env: RedisEnv): Promise<boolean> {
  const r = getRedis(env);
  if (!r) return true;
  const count = await r.del(PREFIX + key);
  return count > 0;
}
