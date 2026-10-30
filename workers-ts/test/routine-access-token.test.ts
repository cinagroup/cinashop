import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { systemConfig } from '@/models/schema';
import { getRoutineAccessToken, invalidateRoutineAccessToken } from '@/services/wechat/RoutineAccessTokenService';
import { readRoutineCredentials, routineCredentialCacheKey } from '@/services/wechat/RoutineRuntimeConfig';
import { financeMemoryPostgres } from './helpers/financePostgres';

const cache = vi.hoisted(() => {
  const state = {
    available: true, values: new Map<string, unknown>(), expirations: new Map<string, number>(),
    getHook: undefined as undefined | ((key: string) => Promise<void>),
    setHook: undefined as undefined | ((key: string) => Promise<void>),
    delHook: undefined as undefined | ((key: string) => Promise<void>),
    setResult: 'OK' as unknown, delResult: undefined as number | undefined,
  };
  const redis = {
    get: vi.fn(async (key: string) => {
      const expiresAt = state.expirations.get(key);
      if (expiresAt !== undefined && expiresAt <= Date.now()) { state.values.delete(key); state.expirations.delete(key); }
      const value = state.values.get(key) ?? null; await state.getHook?.(key); return value;
    }),
    set: vi.fn(async (key: string, value: unknown, options: { pxat: number }) => {
      await state.setHook?.(key);
      if (state.setResult === 'OK') {
        // Model absolute server expiry at the time the delayed SET executes,
        // not a TTL restarted when this test receives its acknowledgement.
        if (options.pxat <= Date.now()) { state.values.delete(key); state.expirations.delete(key); }
        else { state.values.set(key, value); state.expirations.set(key, options.pxat); }
      }
      return state.setResult;
    }),
    del: vi.fn(async (key: string) => {
      await state.delHook?.(key); return state.delResult ?? Number(state.values.delete(key));
    }),
  };
  return { state, redis, resolve: vi.fn(() => state.available ? redis : null) };
});
vi.mock('@/utils/cache', () => ({ getRedis: cache.resolve }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const APP = 'owned-routine-token-app', SECRET = 'owned-routine-token-secret';
const CLOCK_START = 1_800_000_000_000;
const cachedToken = (token: string, expiresAt = Date.now() + 7200 * 1000) => ({ version: 1, token, expiresAt });
const tokenResponse = (changes: Record<string, unknown> = {}) => Response.json({ access_token: 'fresh-routine-token', expires_in: 7200, ...changes });

/** Only Redis and provider transport are doubles. Credential snapshots, source
 * rotations and the short withRoutineCredentials checks execute real SQL in
 * one owned memory fixture, without claiming native cross-session lock proof. */
describe('Routine access token bound to the complete fresh SQL credential source', () => {
  let f: Awaited<ReturnType<typeof financeMemoryPostgres>>, env: Env, expectedGlobalCalls: number, now: number;
  beforeAll(async () => { f = await financeMemoryPostgres([systemConfig], { namespace: 'public' }); }, 30_000);
  afterAll(async () => { await f?.close(); }, 30_000);
  beforeEach(async () => {
    vi.clearAllMocks(); expectedGlobalCalls = 0; now = CLOCK_START;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    cache.state.available = true; cache.state.values.clear(); cache.state.expirations.clear();
    cache.state.getHook = undefined; cache.state.setHook = undefined; cache.state.delHook = undefined;
    cache.state.setResult = 'OK'; cache.state.delResult = undefined;
    await f.reset();
    await f.db.insert(systemConfig).values([
      { id: 1, menuName: 'routine_appId', value: JSON.stringify(APP), sort: 5 },
      { id: 2, menuName: 'routine_appsecret', value: JSON.stringify(SECRET), sort: 5 },
      { id: 3, menuName: 'routine_appsecret', value: 'shadow-secret', sort: -1 },
      { id: 4, menuName: 'wechat_app_appsecret', value: 'native-secret' },
      { id: 5, menuName: 'wechat_open_app_secret', value: 'open-secret' },
      { id: 6, menuName: 'wechat_appsecret', value: 'official-secret' },
    ]);
    env = { APP_KEY: 'owned-routine-token-stamp-key', CONFIG_KV: {
      get: vi.fn(async () => { throw Error('Credential authority must be fresh SQL'); }), put: vi.fn(), delete: vi.fn(),
    } } as unknown as Env;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Tests require an explicit owned provider transport'));
  });
  afterEach(() => {
    expect(env.CONFIG_KV.get).not.toHaveBeenCalled(); expect(env.CONFIG_KV.put).not.toHaveBeenCalled(); expect(env.CONFIG_KV.delete).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledTimes(expectedGlobalCalls);
    vi.useRealTimers(); vi.restoreAllMocks();
  });
  const container = () => createContainerFromDb(f.db);
  const current = () => readRoutineCredentials(container(), env);
  const rotate = (secret = 'rotated-routine-secret') => f.db.update(systemConfig).set({ value: JSON.stringify(secret) }).where(eq(systemConfig.id, 2));

  // Observe completion of real SQL transactions and charge controlled elapsed
  // wall time. Every query, lock, source read and result remains unmodified.
  function clockedContainer(afterTransaction: () => void) {
    const database = new Proxy(f.db, { get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (typeof method !== 'function') return method;
      if (property !== 'transaction') return method.bind(target);
      return async (...args: unknown[]) => {
        const result: unknown = await Reflect.apply(method, target, args);
        afterTransaction(); return result;
      };
    } });
    return createContainerFromDb(database);
  }

  it('fetches with exactly the bound pair and writes only its stamp key with the existing normal TTL', async () => {
    const credentials = await current(), fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe('https://api.weixin.qq.com/cgi-bin/token');
      expect([...url.searchParams]).toEqual([['grant_type', 'client_credential'], ['appid', APP], ['secret', SECRET]]);
      expect(init).toMatchObject({ method: 'GET', redirect: 'error' }); expect(init?.signal).toBeInstanceOf(AbortSignal);
      return tokenResponse();
    });
    expect(await getRoutineAccessToken(container(), env, credentials, { fetcher })).toBe('fresh-routine-token');
    const key = routineCredentialCacheKey(credentials, 'access_token');
    expect(key).not.toContain(APP); expect(key).not.toContain(SECRET);
    expect(cache.redis.get.mock.calls).toEqual([[key]]);
    expect(cache.redis.set.mock.calls).toEqual([[key, cachedToken('fresh-routine-token', CLOCK_START + 7200 * 1000), { pxat: CLOCK_START + 7000 * 1000 }]]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses the default fetch transport when no fetcher option is supplied', async () => {
    const credentials = await current(); expectedGlobalCalls = 1;
    vi.mocked(globalThis.fetch).mockResolvedValue(tokenResponse());
    expect(await getRoutineAccessToken(container(), env, credentials)).toBe('fresh-routine-token');
  });

  it('returns only a matching stamp cache entry and never consults legacy or other realm keys', async () => {
    const credentials = await current(), key = routineCredentialCacheKey(credentials, 'access_token');
    for (const other of ['routine_access_token', `routine_access_token:${APP}`, 'wechat_access_token', 'official_access_token:' + APP, 'native_app_access_token:' + APP])
      cache.state.values.set(other, 'wrong-realm-token');
    cache.state.values.set(key, cachedToken('current-stamp-token'));
    const fetcher = vi.fn<typeof fetch>();
    expect(await getRoutineAccessToken(container(), env, credentials, { fetcher })).toBe('current-stamp-token');
    expect(cache.redis.get.mock.calls).toEqual([[key]]); expect(cache.redis.set).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it('treats old global and AppID-only entries as misses and preserves unrelated namespaces', async () => {
    const credentials = await current();
    const old = new Map([['routine_access_token', 'global-token'], [`routine_access_token:${APP}`, 'app-id-token'], ['wechat_access_token', 'official-token']]);
    for (const [key, value] of old) cache.state.values.set(key, value);
    const fetcher = vi.fn<typeof fetch>(async () => tokenResponse());
    expect(await getRoutineAccessToken(container(), env, credentials, { fetcher })).toBe('fresh-routine-token');
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const [key, value] of old) expect(cache.state.values.get(key)).toBe(value);
    expect(cache.redis.get.mock.calls).toEqual([[routineCredentialCacheKey(credentials, 'access_token')]]);
  });

  it('forceRefresh bypasses GET and still checks the current source before provider I/O', async () => {
    const credentials = await current(), key = routineCredentialCacheKey(credentials, 'access_token');
    cache.state.values.set(key, cachedToken('ignored-cached-token'));
    const fetcher = vi.fn<typeof fetch>(async () => tokenResponse());
    expect(await getRoutineAccessToken(container(), env, credentials, { fetcher, forceRefresh: true })).toBe('fresh-routine-token');
    expect(cache.redis.get).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
    await rotate();
    await expect(getRoutineAccessToken(container(), env, credentials, { fetcher, forceRefresh: true })).rejects.toThrow('配置已变化');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['appId', 'secret'] as const)('rejects a forged %s paired with an otherwise valid source stamp', async field => {
    const credentials = await current(), forged = { ...credentials, [field]: 'tampered-credential' };
    cache.state.values.set(routineCredentialCacheKey(credentials, 'access_token'), cachedToken('must-not-return'));
    const fetcher = vi.fn<typeof fetch>();
    await expect(getRoutineAccessToken(container(), env, forged, { fetcher })).rejects.toThrow('配置已变化');
    await expect(getRoutineAccessToken(container(), env, forged, { fetcher, forceRefresh: true })).rejects.toThrow('配置已变化');
    expect(fetcher).not.toHaveBeenCalled(); expect(cache.redis.set).not.toHaveBeenCalled();
  });

  it('does not return an old cache read that completes after a real credential rotation', async () => {
    const credentials = await current(), entered = deferred(), release = deferred();
    cache.state.values.set(routineCredentialCacheKey(credentials, 'access_token'), cachedToken('old-cache-token'));
    cache.state.getHook = async () => { entered.resolve(); await release.promise; };
    const fetcher = vi.fn<typeof fetch>(), request = getRoutineAccessToken(container(), env, credentials, { fetcher });
    const rejected = expect(request).rejects.toThrow('配置已变化');
    try { await entered.promise; await rotate(); } finally { release.resolve(); }
    await rejected; expect(fetcher).not.toHaveBeenCalled(); expect(cache.redis.set).not.toHaveBeenCalled();
  });

  it('rejects a response that arrives after rotation without caching or returning it', async () => {
    const credentials = await current(), entered = deferred(), release = deferred();
    const fetcher = vi.fn<typeof fetch>(async () => { entered.resolve(); await release.promise; return tokenResponse(); });
    const request = getRoutineAccessToken(container(), env, credentials, { fetcher }), rejected = expect(request).rejects.toThrow('配置已变化');
    try { await entered.promise; await rotate(); } finally { release.resolve(); }
    await rejected; expect(cache.redis.set).not.toHaveBeenCalled();
  });

  it('rejects a changed shadow source despite an unchanged winning credential pair', async () => {
    const credentials = await current();
    const fetcher = vi.fn<typeof fetch>(async () => {
      await f.db.update(systemConfig).set({ info: 'changed shadow source' }).where(eq(systemConfig.id, 3));
      return tokenResponse();
    });
    await expect(getRoutineAccessToken(container(), env, credentials, { fetcher })).rejects.toThrow('配置已变化');
    expect(cache.redis.set).not.toHaveBeenCalled();
  });

  it('keeps a late cache write in the frozen old namespace and refuses its result after rotation', async () => {
    const credentials = await current(), oldKey = routineCredentialCacheKey(credentials, 'access_token'), entered = deferred(), release = deferred();
    cache.state.setHook = async () => { entered.resolve(); await release.promise; };
    const request = getRoutineAccessToken(container(), env, credentials, { fetcher: async () => tokenResponse() });
    const rejected = expect(request).rejects.toThrow('配置已变化');
    let nextKey = '';
    try {
      await entered.promise; await rotate();
      const next = await current(); nextKey = routineCredentialCacheKey(next, 'access_token');
      // Mutating a caller object during I/O must not redirect the in-flight SET.
      Object.assign(credentials, next);
    } finally { release.resolve(); }
    await rejected;
    expect(nextKey).not.toBe(oldKey); expect(cache.state.values.get(oldKey)).toEqual(cachedToken('fresh-routine-token', CLOCK_START + 7200 * 1000));
    expect(cache.state.values.has(nextKey)).toBe(false);
    expect(cache.redis.set.mock.calls.map(([key]) => key)).toEqual([oldKey]);
  });

  it('remains usable without Redis while still rejecting a rotation during the provider response', async () => {
    cache.state.available = false;
    const credentials = await current(), fetcher = vi.fn<typeof fetch>(async () => tokenResponse());
    expect(await getRoutineAccessToken(container(), env, credentials, { fetcher })).toBe('fresh-routine-token');
    expect(cache.redis.get).not.toHaveBeenCalled(); expect(cache.redis.set).not.toHaveBeenCalled();
    const rotating: typeof fetch = async () => { await rotate(); return tokenResponse(); };
    await expect(getRoutineAccessToken(container(), env, credentials, { fetcher: rotating })).rejects.toThrow('配置已变化');
  });

  it('does not revoke an in-flight token for unrelated App/Open/official configuration changes', async () => {
    const credentials = await current(), fetcher: typeof fetch = async () => {
      for (const id of [4, 5, 6]) await f.db.update(systemConfig).set({ value: 'other-realm-update' }).where(eq(systemConfig.id, id));
      return tokenResponse();
    };
    expect(await getRoutineAccessToken(container(), env, credentials, { fetcher })).toBe('fresh-routine-token');
    expect(cache.redis.get.mock.calls).toEqual([[routineCredentialCacheKey(credentials, 'access_token')]]);
  });

  it.each(['', 0, false, {}, [], 'old-unframed-token', 'token with space', 'token\n', '令牌', 'x'.repeat(4097)])(
    'rejects a malformed non-null cache value instead of fetching around it: %j', async value => {
      const credentials = await current(), fetcher = vi.fn<typeof fetch>();
      cache.state.values.set(routineCredentialCacheKey(credentials, 'access_token'), value);
      await expect(getRoutineAccessToken(container(), env, credentials, { fetcher })).rejects.toThrow('缓存暂时不可用');
      expect(fetcher).not.toHaveBeenCalled(); expect(cache.redis.set).not.toHaveBeenCalled();
    });

  it('rejects a real Redis GET error without falling back to the provider or leaking transport details', async () => {
    const credentials = await current(), fetcher = vi.fn<typeof fetch>();
    cache.state.getHook = async () => { throw Error(SECRET); };
    await expect(getRoutineAccessToken(container(), env, credentials, { fetcher })).rejects.toMatchObject({ code: 503, message: '小程序 access_token 缓存暂时不可用' });
    expect(fetcher).not.toHaveBeenCalled(); expect(cache.redis.set).not.toHaveBeenCalled();
  });

  it.each(['throw', 'bad-ack'] as const)('refuses a Redis SET %s rather than returning an unconfirmed result', async failure => {
    const credentials = await current();
    if (failure === 'throw') cache.state.setHook = async () => { throw Error(SECRET); };
    else cache.state.setResult = null;
    await expect(getRoutineAccessToken(container(), env, credentials, { fetcher: async () => tokenResponse() })).rejects.toThrow('缓存暂时不可用');
  });

  it.each([undefined, null, '7200', true, 0, -1, 1.5, 7201, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
    'rejects an invalid provider expires_in without caching: %j [case %#]', async expires_in => {
      const credentials = await current();
      // Raw JSON permits an overflowing numeric literal while JSON.stringify
      // would convert non-finite values to null; both must fail closed.
      const fetcher: typeof fetch = async () => Number.isNaN(expires_in) || expires_in === Infinity
        ? new Response('{"access_token":"valid-token","expires_in":1e999}') : tokenResponse({ expires_in });
      await expect(getRoutineAccessToken(container(), env, credentials, { fetcher })).rejects.toThrow('服务暂时不可用');
      expect(cache.redis.set).not.toHaveBeenCalled();
    });

  it.each([1, 60, 200, 7200])('anchors exact expiry and absolute cache lifetime for valid expires_in %i', async expires_in => {
    const credentials = await current();
    expect(await getRoutineAccessToken(container(), env, credentials, { fetcher: async () => tokenResponse({ expires_in }) })).toBe('fresh-routine-token');
    expect(cache.redis.set).toHaveBeenCalledWith(routineCredentialCacheKey(credentials, 'access_token'),
      cachedToken('fresh-routine-token', CLOCK_START + expires_in * 1000), {
        pxat: CLOCK_START + Math.min(expires_in, Math.max(60, expires_in - 200)) * 1000,
      });
  });

  it('charges provider response time from request start rather than granting a fresh lifetime on receipt', async () => {
    const credentials = await current();
    const fetcher: typeof fetch = async () => { now += 1000; return tokenResponse({ expires_in: 1 }); };
    await expect(getRoutineAccessToken(container(), env, credentials, { fetcher })).rejects.toThrow('已过期');
    expect(cache.redis.set).not.toHaveBeenCalled(); expect(await current()).toEqual(credentials);
  });

  it('preserves a still-live short token without restarting its expiry after provider and SET delays', async () => {
    const credentials = await current(), key = routineCredentialCacheKey(credentials, 'access_token');
    const fetcher: typeof fetch = async () => { now += 400; return tokenResponse({ expires_in: 1 }); };
    cache.state.setHook = async () => { now += 200; };
    expect(await getRoutineAccessToken(container(), env, credentials, { fetcher })).toBe('fresh-routine-token');
    expect(cache.redis.set.mock.calls).toEqual([[key, cachedToken('fresh-routine-token', CLOCK_START + 1000), { pxat: CLOCK_START + 1000 }]]);
    expect(cache.state.expirations.get(key)).toBe(CLOCK_START + 1000);
    expect(now).toBe(CLOCK_START + 600);
  });

  it.each([2, 3])('refuses a token expiring as actual SQL transaction %i finishes', async expiresAfterTransaction => {
    const credentials = await current(), before = await f.db.select().from(systemConfig);
    let transactions = 0;
    const observed = clockedContainer(() => { if (++transactions === expiresAfterTransaction) now += 1000; });
    await expect(getRoutineAccessToken(observed, env, credentials, {
      fetcher: async () => tokenResponse({ expires_in: 1 }),
    })).rejects.toThrow('已过期');
    expect(transactions).toBe(expiresAfterTransaction);
    expect(cache.redis.set).toHaveBeenCalledTimes(expiresAfterTransaction === 2 ? 0 : 1);
    expect(await f.db.select().from(systemConfig)).toEqual(before);
    expect(await current()).toEqual(credentials);
  });

  it('refuses a token expiring during SET and cannot retain it by restarting a relative TTL', async () => {
    const credentials = await current(), key = routineCredentialCacheKey(credentials, 'access_token');
    cache.state.setHook = async () => { now += 60_000; };
    await expect(getRoutineAccessToken(container(), env, credentials, {
      fetcher: async () => tokenResponse({ expires_in: 60 }),
    })).rejects.toThrow('已过期');
    expect(cache.redis.set.mock.calls).toEqual([[key, cachedToken('fresh-routine-token', CLOCK_START + 60_000), { pxat: CLOCK_START + 60_000 }]]);
    expect(cache.state.values.has(key)).toBe(false); expect(await current()).toEqual(credentials);
  });

  it('keeps the normal early cache deadline absolute even when SET arrives after that deadline', async () => {
    const credentials = await current(), key = routineCredentialCacheKey(credentials, 'access_token');
    cache.state.setHook = async () => { now += 7000 * 1000 + 1; };
    // The provider token remains live for almost 200 seconds, but this delayed
    // cache command must not renew its original 7000-second cache lifetime.
    expect(await getRoutineAccessToken(container(), env, credentials, { fetcher: async () => tokenResponse() })).toBe('fresh-routine-token');
    expect(cache.redis.set.mock.calls).toEqual([[key, cachedToken('fresh-routine-token', CLOCK_START + 7200 * 1000), { pxat: CLOCK_START + 7000 * 1000 }]]);
    expect(cache.state.values.has(key)).toBe(false);
  });

  it.each(['already-expired', 'GET-delay', 'SQL-delay'] as const)('does not return a cache envelope after %s expiry', async phase => {
    const credentials = await current(), key = routineCredentialCacheKey(credentials, 'access_token');
    const expiresAt = CLOCK_START + (phase === 'already-expired' ? 0 : 1000);
    // No mock TTL is assigned here: this models an old response already read
    // by Redis, or a retained/corrupt cache value whose own expiry must be checked.
    cache.state.values.set(key, cachedToken('must-not-return', expiresAt));
    if (phase === 'GET-delay') cache.state.getHook = async () => { now += 1000; };
    const observed = phase === 'SQL-delay' ? clockedContainer(() => { now += 1000; }) : container();
    const fetcher = vi.fn<typeof fetch>();
    await expect(getRoutineAccessToken(observed, env, credentials, { fetcher })).rejects.toThrow('已过期');
    expect(fetcher).not.toHaveBeenCalled(); expect(cache.redis.set).not.toHaveBeenCalled();
    expect(await current()).toEqual(credentials);
  });

  it.each([
    { version: 2, token: 'token', expiresAt: CLOCK_START + 1000 },
    { version: 1, token: 'token' },
    { version: 1, token: 'token', expiresAt: String(CLOCK_START + 1000) },
    { version: 1, token: 'token', expiresAt: NaN },
    { version: 1, token: 'token', expiresAt: Infinity },
    { version: 1, token: 'token', expiresAt: CLOCK_START + 7200 * 1000 + 1 },
    { version: 1, token: 'token', expiresAt: CLOCK_START + 1000.5 },
    { version: 1, token: 'token', expiresAt: CLOCK_START + 1000, unreviewed: true },
  ])('rejects malformed expiry envelopes without treating them as a cache miss: %j [case %#]', async value => {
    const credentials = await current(), fetcher = vi.fn<typeof fetch>();
    cache.state.values.set(routineCredentialCacheKey(credentials, 'access_token'), value);
    await expect(getRoutineAccessToken(container(), env, credentials, { fetcher })).rejects.toThrow('缓存暂时不可用');
    expect(fetcher).not.toHaveBeenCalled(); expect(cache.redis.set).not.toHaveBeenCalled();
  });

  it('checks the final expiry even when caching is disabled', async () => {
    cache.state.available = false;
    const credentials = await current(); let transactions = 0;
    const observed = clockedContainer(() => { if (++transactions === 3) now += 1000; });
    await expect(getRoutineAccessToken(observed, env, credentials, {
      fetcher: async () => tokenResponse({ expires_in: 1 }),
    })).rejects.toThrow('已过期');
    expect(cache.redis.get).not.toHaveBeenCalled(); expect(cache.redis.set).not.toHaveBeenCalled();
  });

  it.each(['', 4, null, {}, 'token\n', 'x'.repeat(4097)])('rejects an invalid provider token: %j', async access_token => {
    const credentials = await current();
    await expect(getRoutineAccessToken(container(), env, credentials, { fetcher: async () => tokenResponse({ access_token }) })).rejects.toThrow('服务暂时不可用');
    expect(cache.redis.set).not.toHaveBeenCalled();
  });

  it.each([
    () => tokenResponse({ errcode: 40013, errmsg: SECRET }),
    () => tokenResponse({ errcode: '0' }),
    () => new Response('{"access_token":"token","expires_in":7200}', { status: 500 }),
    () => new Response('not JSON'),
    () => new Response('[]'),
    () => new Response(new Uint8Array([0xff])),
    () => new Response('{}', { headers: { 'content-length': '32769' } }),
    () => new Response('{}', { headers: { 'content-length': 'not-a-size' } }),
  ])('rejects a malformed or unsuccessful bounded provider response [case %#]', async response => {
    const credentials = await current();
    await expect(getRoutineAccessToken(container(), env, credentials, { fetcher: async () => response() })).rejects.toMatchObject({
      code: 503, message: '小程序 access_token 服务暂时不可用',
    });
    expect(cache.redis.set).not.toHaveBeenCalled();
  });

  it('bounds actual streamed bytes even with no declared length and cancels an oversized unfinished body', async () => {
    const credentials = await current(), cancelled = vi.fn();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { if (!sent) { sent = true; controller.enqueue(new Uint8Array(32769)); } }, cancel: cancelled,
    });
    await expect(getRoutineAccessToken(container(), env, credentials, { fetcher: async () => new Response(body) })).rejects.toThrow('服务暂时不可用');
    expect(cancelled).toHaveBeenCalledTimes(1); expect(cache.redis.set).not.toHaveBeenCalled();
  });

  it.each(['fetch', 'body'] as const)('caps a stalled %s at 8 seconds and discards its late result', async phase => {
    const credentials = await current(), entered = deferred(), release = deferred(), closed = deferred();
    const cancelled = vi.fn(() => { closed.resolve(); });
    let signal: AbortSignal | null | undefined;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetcher: typeof fetch = async (_url, init) => {
      signal = init?.signal;
      if (phase === 'fetch') { entered.resolve(); await release.promise; }
      return new Response(new ReadableStream<Uint8Array>({
        start() { if (phase === 'body') entered.resolve(); }, cancel: cancelled,
      }));
    };
    const request = getRoutineAccessToken(container(), env, credentials, { fetcher });
    const rejected = expect(request).rejects.toThrow('服务暂时不可用');
    try {
      await entered.promise; await vi.advanceTimersByTimeAsync(7999); expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1); await rejected; expect(signal?.aborted).toBe(true);
    } finally { release.resolve(); }
    await closed.promise;
    expect(cancelled).toHaveBeenCalledTimes(1); expect(cache.redis.set).not.toHaveBeenCalled();
  });

  it('invalidates only the frozen old namespace and accepts a confirmed already-absent key', async () => {
    const old = await current(), oldKey = routineCredentialCacheKey(old, 'access_token');
    await rotate(); const next = await current(), nextKey = routineCredentialCacheKey(next, 'access_token');
    cache.state.values.set(oldKey, 'old-token'); cache.state.values.set(nextKey, 'new-token');
    cache.state.values.set('routine_access_token', 'legacy-token');
    cache.state.delHook = async () => { Object.assign(old, next); };
    await invalidateRoutineAccessToken(env, old);
    expect(cache.redis.del.mock.calls).toEqual([[oldKey]]); expect(cache.state.values.has(oldKey)).toBe(false);
    expect(cache.state.values.get(nextKey)).toBe('new-token'); expect(cache.state.values.get('routine_access_token')).toBe('legacy-token');
    cache.state.delHook = undefined; cache.state.delResult = 0;
    await expect(invalidateRoutineAccessToken(env, next)).resolves.toBeUndefined();
  });

  it('skips invalidation without Redis and refuses an actual delete error or invalid acknowledgement', async () => {
    const credentials = await current(); cache.state.available = false;
    await expect(invalidateRoutineAccessToken(env, credentials)).resolves.toBeUndefined(); expect(cache.redis.del).not.toHaveBeenCalled();
    cache.state.available = true; cache.state.delHook = async () => { throw Error(SECRET); };
    await expect(invalidateRoutineAccessToken(env, credentials)).rejects.toThrow('缓存暂时不可用');
    cache.state.delHook = undefined; cache.state.delResult = -1;
    await expect(invalidateRoutineAccessToken(env, credentials)).rejects.toThrow('缓存暂时不可用');
  });
});
