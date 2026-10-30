import type { Env } from '@/env';
import type { Container } from '@/lib/di';
import { getRedis } from '@/utils/cache';
import { ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { routineCredentialCacheKey, withRoutineCredentials, type RoutineCredentials } from './RoutineRuntimeConfig';

const RESPONSE_BYTES = 32 * 1024, PROVIDER_TIMEOUT_MS = 8_000;
const MAX_TOKEN_LIFETIME_MS = 7200 * 1000;
type CachedToken = { version: 1; token: string; expiresAt: number };
const validToken = (value: unknown): value is string => typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/u.test(value);
const cacheUnavailable = () => new ServiceUnavailableException('小程序 access_token 缓存暂时不可用');
const providerUnavailable = () => new ServiceUnavailableException('小程序 access_token 服务暂时不可用');

function assertUnexpired(expiresAt: number): void {
  if (Date.now() >= expiresAt) throw new ServiceUnavailableException('小程序 access_token 已过期，请重试');
}

function parseCachedToken(value: unknown): CachedToken {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw cacheUnavailable();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 3 || !Object.hasOwn(row, 'version') || !Object.hasOwn(row, 'token')
    || !Object.hasOwn(row, 'expiresAt') || row.version !== 1 || !validToken(row.token)
    || typeof row.expiresAt !== 'number' || !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= 0
    || row.expiresAt > Date.now() + MAX_TOKEN_LIFETIME_MS) throw cacheUnavailable();
  assertUnexpired(row.expiresAt);
  return { version: 1, token: row.token, expiresAt: row.expiresAt };
}

function freezeCredentials(credentials: RoutineCredentials): Readonly<RoutineCredentials> {
  const snapshot = Object.freeze({ appId: credentials.appId, secret: credentials.secret, stamp: credentials.stamp });
  if (typeof snapshot.appId !== 'string' || !snapshot.appId || typeof snapshot.secret !== 'string' || !snapshot.secret
    || typeof snapshot.stamp !== 'string') throw new ValidateException('小程序微信凭据无效，请重新授权');
  // Validate the stamp before either Redis or provider I/O.
  routineCredentialCacheKey(snapshot, 'access_token');
  return snapshot;
}

async function assertCurrent(container: Container, env: Env, expected: Readonly<RoutineCredentials>): Promise<void> {
  await withRoutineCredentials(container, env, expected.stamp, async (_bound, current) => {
    if (current.appId !== expected.appId || current.secret !== expected.secret)
      throw new ValidateException('小程序微信配置已变化，请重新授权');
  });
}

/** The deadline covers fetch and body consumption, including a custom fetcher
 * that ignores abort. A late response is cancelled and cannot reach Redis. */
async function providerJson(fetcher: typeof fetch, url: URL): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    try {
      const pending = reader ? reader.cancel() : response?.body?.cancel();
      void pending?.catch(() => undefined);
    } catch { /* Cleanup must not expose a provider URL or replace the failure. */ }
  };
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { stopped = true; controller.abort(); cancel(); reject(providerUnavailable()); }, PROVIDER_TIMEOUT_MS);
  });
  const receive = async () => {
    response = await fetcher(url.toString(), { method: 'GET', redirect: 'error', signal: controller.signal });
    if (stopped) { cancel(); throw providerUnavailable(); }
    const declared = response.headers.get('content-length');
    if (!response.ok || response.redirected || !response.body || declared !== null
      && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > RESPONSE_BYTES))
      throw providerUnavailable();
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0, complete = false;
    try {
      while (true) {
        const next = await reader.read();
        if (stopped) throw providerUnavailable();
        if (next.done) { complete = true; break; }
        size += next.value.byteLength;
        if (size > RESPONSE_BYTES) throw providerUnavailable();
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw providerUnavailable();
      return value as Record<string, unknown>;
    } finally {
      if (!complete) cancel();
      // A pending read after timeout releases its lock when receive settles.
      try { reader.releaseLock(); } catch { /* A pending read still owns it. */ }
    }
  };
  try { return await Promise.race([receive(), deadline]); }
  catch { stopped = true; controller.abort(); cancel(); throw providerUnavailable(); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Only the full source-stamp namespace is eligible. All network/cache I/O is
 * outside the short SQL checks, and late writes remain in the frozen old key.
 * Redis is optional; absence skips caching without claiming persistence. */
export async function getRoutineAccessToken(container: Container, env: Env, credentials: RoutineCredentials,
  options: { fetcher?: typeof fetch; forceRefresh?: boolean } = {}): Promise<string> {
  const snapshot = freezeCredentials(credentials), key = routineCredentialCacheKey(snapshot, 'access_token');
  let redis: ReturnType<typeof getRedis>;
  try { redis = getRedis(env); } catch { throw cacheUnavailable(); }
  if (redis && !options.forceRefresh) {
    let cached: unknown;
    try { cached = await redis.get<unknown>(key); } catch { throw cacheUnavailable(); }
    await assertCurrent(container, env, snapshot);
    if (cached !== null) {
      return parseCachedToken(cached).token;
    }
  } else await assertCurrent(container, env, snapshot);

  const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
  url.search = new URLSearchParams({ grant_type: 'client_credential', appid: snapshot.appId, secret: snapshot.secret }).toString();
  // Anchor before the request, not receipt or Redis acknowledgement. Both
  // network time and every following SQL/cache delay consume this lifetime.
  const requestedAt = Date.now(), data = await providerJson(options.fetcher ?? fetch, url);
  await assertCurrent(container, env, snapshot);
  if (data.errcode !== undefined && data.errcode !== 0 || !validToken(data.access_token)
    || typeof data.expires_in !== 'number' || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0 || data.expires_in > 7200)
    throw providerUnavailable();
  const token = data.access_token, expiresAt = requestedAt + data.expires_in * 1000;
  const cacheExpiresAt = requestedAt + Math.min(data.expires_in, Math.max(60, data.expires_in - 200)) * 1000;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0 || !Number.isSafeInteger(cacheExpiresAt) || cacheExpiresAt <= 0)
    throw providerUnavailable();
  assertUnexpired(expiresAt);
  const entry: CachedToken = { version: 1, token, expiresAt };
  if (redis) {
    // Installed @upstash/redis SetCommandOptions supports PXAT milliseconds.
    // A late SET therefore cannot restart or extend the original cache TTL.
    try { if (await redis.set(key, entry, { pxat: cacheExpiresAt }) !== 'OK') throw cacheUnavailable(); }
    catch { throw cacheUnavailable(); }
  }
  await assertCurrent(container, env, snapshot);
  assertUnexpired(expiresAt);
  return token;
}

/** Invalidating an old operation can delete only its old stamp namespace. */
export async function invalidateRoutineAccessToken(env: Env, credentials: RoutineCredentials): Promise<void> {
  const key = routineCredentialCacheKey({ stamp: credentials.stamp }, 'access_token');
  let redis: ReturnType<typeof getRedis>;
  try { redis = getRedis(env); } catch { throw cacheUnavailable(); }
  if (!redis) return;
  try {
    const count = await redis.del(key);
    if (!Number.isSafeInteger(count) || count < 0) throw cacheUnavailable();
  } catch { throw cacheUnavailable(); }
}
