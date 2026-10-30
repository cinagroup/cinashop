import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { systemConfig, user, wechatUser } from '@/models/schema';
import { WechatAuthService } from '@/services/wechat/WechatAuthService';
import { readRoutineCredentials } from '@/services/wechat/RoutineRuntimeConfig';
import { financePostgres } from './helpers/financePostgres';

const transport = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  return {
    values,
    redis: { eval: vi.fn(async () => 1), get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: unknown) => { values.set(key, value); return 'OK'; }),
      del: vi.fn(async (key: string) => Number(values.delete(key))) },
    setIfAbsent: vi.fn(async (key: string, value: unknown) => {
      if (values.has(key)) return false; values.set(key, value); return true;
    }),
  };
});
vi.mock('@/utils/cache', () => ({
  getRedis: () => transport.redis,
  cacheSetIfAbsent: transport.setIfAbsent,
  cacheGet: async (key: string) => transport.values.get(key) ?? null,
  cacheSet: async (key: string, value: unknown) => { transport.values.set(key, value); return true; },
  cacheTake: async (key: string) => { const value = transport.values.get(key) ?? null; transport.values.delete(key); return value; },
  cacheDelete: async (key: string) => { transport.values.delete(key); return true; },
  setTokenBucket: vi.fn(async () => true),
  clearToken: vi.fn(async () => true),
}));

/** Actual auth_type entry, SQL configuration/user reads and source rechecks.
 * Provider/Redis are controlled transports, not real WeChat or delivery proof.
 * Ticket-consumption/session cases use a separate owned fixture in
 * routine-auth-session.test.ts; this suite retains the exchange boundary.
 */
describe('Routine auth_type exchange uses the fresh paired credential source', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, env: Env;
  let fetcher: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  const provider = () => Response.json({ openid: 'owned-existing-routine-openid', session_key: 'owned-session-key' });
  const service = () => new WechatAuthService(createContainerFromDb(f.db), env);
  const tickets = () => [...transport.values].filter(([key]) => key.startsWith('routine_login:'));
  const userState = async () => ({ users: await f.db.select().from(user), identities: await f.db.select().from(wechatUser) });
  beforeAll(async () => { f = await financePostgres([systemConfig, user, wechatUser], { namespace: 'public' }); });
  afterAll(async () => { if (f) await f.close(); });
  beforeEach(async () => {
    vi.clearAllMocks(); transport.values.clear(); await f.reset();
    await f.db.insert(systemConfig).values([
      { id: 1, menuName: 'routine_appId', value: '"fresh-sql-routine-id"', sort: 5 },
      { id: 2, menuName: 'routine_appsecret', value: '"fresh-sql-routine-secret"', sort: 5 },
      { id: 3, menuName: 'routine_appsecret', value: 'shadow-secret', sort: -1 },
    ]);
    await f.db.insert(user).values({ uid: 7, account: 'owned-existing-user', phone: '13800000000', status: 1 });
    await f.db.insert(wechatUser).values({ id: 7, uid: 7, openid: 'owned-existing-routine-openid', userType: 'routine' });
    env = { APP_KEY: 'owned-routine-auth-signing-key', CONFIG_KV: {
      get: vi.fn(async (key: string) => {
        if (key === 'cfg_store_user_mobile') return '0';
        throw Error('Auth cannot use stale cfg_* credentials');
      }), put: vi.fn(), delete: vi.fn(),
    } } as unknown as Env;
    fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(provider());
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('passes one current SQL pair to the provider and keeps the old UID/identity rows unchanged', async () => {
    const before = await userState(), credentials = await readRoutineCredentials(createContainerFromDb(f.db), env);
    const result = await service().beginMiniProgramLogin({ code: 'owned-fresh-code', ip: '127.0.0.1' });
    expect(result).toMatchObject({ bindPhone: false, expiresIn: 900 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://api.weixin.qq.com/sns/jscode2session');
    expect(url.searchParams.get('appid')).toBe('fresh-sql-routine-id');
    expect(url.searchParams.get('secret')).toBe('fresh-sql-routine-secret');
    expect(url.searchParams.get('js_code')).toBe('owned-fresh-code');
    expect(tickets()).toHaveLength(1);
    expect(tickets()[0][0]).toBe('routine_login:' + result.key);
    expect(tickets()[0][1]).toMatchObject({ identity: {
      openid: 'owned-existing-routine-openid', userType: 'routine', routineStamp: credentials.stamp,
    } });
    expect(JSON.stringify(tickets()[0][1])).not.toContain(credentials.secret);
    expect(await userState()).toEqual(before);
    expect(env.CONFIG_KV.get).toHaveBeenCalledTimes(1);
    expect(env.CONFIG_KV.get).toHaveBeenCalledWith('cfg_store_user_mobile');
    expect(env.CONFIG_KV.put).not.toHaveBeenCalled();
  });

  it.each(['winner', 'shadow'] as const)('rejects a provider response arriving after a %s rotation without creating a login ticket', async kind => {
    const before = await userState();
    fetcher.mockImplementation(async () => {
      await f.db.update(systemConfig).set(kind === 'winner' ? { value: '"new-secret"' } : { info: 'changed-shadow-source' })
        .where(eq(systemConfig.id, kind === 'winner' ? 2 : 3));
      return provider();
    });
    await expect(service().beginMiniProgramLogin({ code: 'owned-rotating-code' })).rejects.toThrow('配置已变化');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(tickets()).toEqual([]);
    expect(await userState()).toEqual(before);
    expect(env.CONFIG_KV.get).not.toHaveBeenCalled();
  });

  it('rejects an incomplete SQL pair before consuming the provider code or consulting legacy KV', async () => {
    await f.db.delete(systemConfig).where(eq(systemConfig.id, 2));
    await f.db.delete(systemConfig).where(eq(systemConfig.id, 3));
    const before = await userState();
    await expect(service().beginMiniProgramLogin({ code: 'unused-code' })).rejects.toThrow('凭据未完整配置');
    expect(fetcher).not.toHaveBeenCalled(); expect(transport.redis.eval).not.toHaveBeenCalled();
    expect(transport.setIfAbsent).not.toHaveBeenCalled(); expect(env.CONFIG_KV.get).not.toHaveBeenCalled();
    expect(tickets()).toEqual([]); expect(await userState()).toEqual(before);
  });

  it('keeps one-time provider-code rejection before a second provider call', async () => {
    await service().beginMiniProgramLogin({ code: 'single-use-code' });
    await expect(service().beginMiniProgramLogin({ code: 'single-use-code' })).rejects.toThrow('code 已使用');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(tickets()).toHaveLength(1);
  });
});
