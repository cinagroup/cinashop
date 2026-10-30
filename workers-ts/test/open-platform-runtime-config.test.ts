import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import type { Env } from '../src/env';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { systemConfig, user, wechatUser, storeService } from '../src/models/schema';
import { financeMemoryPostgres } from './helpers/financePostgres';
import { readOpenPlatformAppId, readOpenPlatformCredentials, withOpenPlatformCredentials } from '../src/services/wechat/OpenPlatformRuntimeConfig';
import { WechatOpenWebAuthService } from '../src/services/wechat/WechatOpenWebAuthService';
import { WechatAuthService } from '../src/services/wechat/WechatAuthService';
import { LoginService } from '../src/services/user/LoginService';
import { KefuAuthService } from '../src/services/kefu/KefuAuthService';
import * as agentEffects from '../src/services/agent/AgentLevelRegistrationEffects';
import { PcCompatibilityService } from '../src/services/pc/PcCompatibilityService';
import { KefuCoreService } from '../src/services/kefu/KefuCoreService';
import { createToken, md5, verifyToken } from '../src/utils/jwt';
import { WECHAT_OPEN_AUTHORITY_KEY } from '../../view/common/wechatOpen';

// Only transport/storage is controlled. Resolver SQL, transactions/savepoints,
// identity reconciliation, mature login and JWT signing are the actual code.
const store = vi.hoisted(() => ({ values: new Map<string, unknown>(), buckets: new Map<string, unknown>(),
  sets: [] as Array<{ key: string; ttl: number }>, cleared: [] as string[], rate: 1, redis: true,
  bucketFault: false, clearFault: false }));
vi.mock('../src/utils/cache', async original => ({
  ...await original<typeof import('../src/utils/cache')>(),
  getRedis: vi.fn(() => store.redis ? { eval: async () => store.rate } : null),
  cacheSetIfAbsent: vi.fn(async (key: string, value: unknown, _env: unknown, ttl: number) => {
    store.sets.push({ key, ttl }); if (store.values.has(key)) return false; store.values.set(key, value); return true;
  }),
  cacheTake: vi.fn(async (key: string) => { const value = store.values.get(key) ?? null; store.values.delete(key); return value; }),
  setTokenBucket: vi.fn(async (key: string, bucket: unknown) => {
    store.buckets.set(key, bucket); if (store.bucketFault) throw Error('owned bucket write ACK failure'); return true;
  }),
  clearToken: vi.fn(async (key: string) => { store.cleared.push(key); if (store.clearFault) throw Error('owned revocation failure'); store.buckets.delete(key); }),
}));
const APP = 'wx0123456789abcdef', SECRET = 'owned-database-secret';

describe('open-platform fresh credentials and actual OAuth identity publication', () => {
  let f: Awaited<ReturnType<typeof financeMemoryPostgres>>, env: Env;
  let network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  beforeAll(async () => {
    f = await financeMemoryPostgres([systemConfig, user, wechatUser, storeService]);
    await f.exec('CREATE UNIQUE INDEX open_fixture_openid ON wechat_user(openid)');
  });
  afterAll(async () => { await f.close(); });
  beforeEach(async () => {
    store.values.clear(); store.buckets.clear(); store.sets.length = 0; store.cleared.length = 0;
    store.rate = 1; store.redis = true; store.bucketFault = false; store.clearFault = false;
    env = { APP_KEY: 'owned-open-runtime-key', UPSTASH_REDIS_URL: 'owned-transport', UPSTASH_REDIS_TOKEN: 'owned-token',
      CONFIG_KV: { get: vi.fn(async (key: string) => {
        if (key.startsWith('cfg_wechat_open_')) throw Error('Open credentials must never read cached cfg authority');
        return key === 'cfg_site_name' ? 'Owned shop' : '0';
      }), put: vi.fn(), delete: vi.fn() },
    } as unknown as Env;
    await f.reset();
    await f.db.insert(systemConfig).values([
      { id: 1, menuName: 'wechat_open_app_id', value: JSON.stringify(APP), status: 0 },
      { id: 2, menuName: 'wechat_open_app_secret', value: JSON.stringify(SECRET), status: 0 },
      { id: 3, menuName: WECHAT_OPEN_AUTHORITY_KEY, value: 'database', status: 0 },
    ]);
    network = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => Response.json(new URL(String(input)).pathname.endsWith('/access_token')
      ? { access_token: 'owned-provider-access', openid: 'owned-openid', unionid: 'owned-union' }
      : { unionid: 'owned-union', nickname: 'Owned profile', headimgurl: '', sex: 1 }));
  });
  afterEach(() => { vi.restoreAllMocks(); });
  const container = () => createContainerFromDb(f.db);
  const auth = () => new WechatOpenWebAuthService(container(), env);
  const credentials = () => readOpenPlatformCredentials(container(), env);
  const rotate = () => f.db.update(systemConfig).set({ value: 'rotated-secret' }).where(eq(systemConfig.id, 2));
  async function start(audience: 'pc_user' | 'kefu_agent' = 'pc_user') {
    const service = auth(), state = await service.createOauthState(audience, '127.0.0.1', 'https://shop.example.test');
    return { service, state, login: (code = crypto.randomUUID()) => service.login(audience, code, state.state, state.verifier, '127.0.0.1') };
  }
  async function owner() {
    await f.db.insert(user).values({ uid: 77, account: 'owned-user', pwd: md5('owned-password') });
    await f.db.insert(wechatUser).values({ uid: 77, openid: 'owned-openid', unionid: 'owned-union', userType: 'pc' });
    await f.db.insert(storeService).values({ id: 88, uid: 77, account: 'owned-kefu', password: 'owned-password', nickname: 'Owned agent' });
  }

  it('reads the complete JSON-normalized database pair fresh without KV or SQL mutation', async () => {
    const before = await f.db.select().from(systemConfig), result = await credentials();
    expect(result).toMatchObject({ appId: APP, secret: SECRET, authority: 'database' }); expect(result.stamp).toMatch(/^[a-f0-9]{64}$/);
    expect(await f.db.select().from(systemConfig)).toEqual(before); expect(env.CONFIG_KV.get).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it('deployment Secret wins even when database authority is disabled, and its rotation changes the stamp', async () => {
    await f.db.delete(systemConfig).where(eq(systemConfig.id, 3)); env.WECHAT_OPEN_APP_SECRET = 'owned-deployment-secret';
    const result = await credentials(); expect(result).toMatchObject({ secret: 'owned-deployment-secret', authority: 'deployment' });
    env.WECHAT_OPEN_APP_SECRET = 'owned-next-deployment'; expect((await credentials()).stamp).not.toBe(result.stamp);
  });
  it.each(['', 'wx123456', 'legacy-app', 'wx1234567890abcde', 'wx1234567890abcdefg', 'wx1234567890abc ef'])('preserves invalid historical public AppID %j while refusing a usable state', async appId => {
    await f.db.update(systemConfig).set({ value: JSON.stringify(appId) }).where(eq(systemConfig.id, 1));
    // Scalar normalization is retained for public compatibility; a short or
    // otherwise malformed historical value never constitutes runtime readiness.
    expect(await readOpenPlatformAppId(container())).toBe(appId.trim());
    await expect(credentials()).rejects.toThrow('尚未配置'); await expect(start()).rejects.toThrow('尚未配置');
    expect(store.values.size).toBe(0); expect(network).not.toHaveBeenCalled();
  });
  it.each([' ', '\t', 'invalid secret', '\n'])('does not silently fall back from invalid nonempty deployment %j', async value => {
    env.WECHAT_OPEN_APP_SECRET = value; await expect(credentials()).rejects.toThrow('尚未配置');
  });
  it.each(['deployment', ' database', 'database ', '"database"', 'DATABASE', ''])('requires the exact raw database sentinel, not %j', async value => {
    await f.db.update(systemConfig).set({ value }).where(eq(systemConfig.id, 3)); await expect(credentials()).rejects.toThrow('尚未配置');
  });
  it('fails closed on missing sentinel, missing signing key or invalid Secret without caching anything', async () => {
    await expect(readOpenPlatformCredentials(container(), { APP_KEY: '' })).rejects.toThrow('签名尚未配置');
    await f.db.delete(systemConfig).where(eq(systemConfig.id, 3)); await expect(credentials()).rejects.toThrow('尚未配置');
    expect(env.CONFIG_KV.put).not.toHaveBeenCalled(); expect(store.sets).toEqual([]);
  });
  it('sort/id winners include hidden fields; all platform shadow metadata/xmin binds the stamp; store rows are excluded', async () => {
    await f.db.insert(systemConfig).values([
      { id: 10, menuName: 'wechat_open_app_secret', value: 'store-secret', sort: 999, isStore: 1 },
      { id: 11, menuName: 'wechat_open_app_secret', value: 'shadow-secret', sort: -1 },
      { id: 12, menuName: 'wechat_open_app_secret', value: 'winner-secret', status: 0 },
    ]);
    const first = await credentials(); expect(first.secret).toBe('winner-secret');
    await f.db.update(systemConfig).set({ desc: 'only shadow metadata' }).where(eq(systemConfig.id, 11));
    const next = await credentials(); expect(next.secret).toBe(first.secret); expect(next.stamp).not.toBe(first.stamp);
    await f.db.update(systemConfig).set({ value: 'changed-store' }).where(eq(systemConfig.id, 10)); expect((await credentials()).stamp).toBe(next.stamp);
    // Even a no-op value rewrite changes xmin; a state cannot cross that write.
    await f.db.update(systemConfig).set({ value: 'shadow-secret' }).where(eq(systemConfig.id, 11)); expect((await credentials()).stamp).not.toBe(next.stamp);
  });
  it('permits 64 complete source rows and rejects overflow or overlarge metadata rather than truncating', async () => {
    await f.db.insert(systemConfig).values(Array.from({ length: 61 }, (_, i) => ({ id: 10 + i, menuName: 'wechat_open_app_secret', value: 'shadow', sort: -1 })));
    await expect(credentials()).resolves.toHaveProperty('secret', SECRET);
    await f.db.insert(systemConfig).values({ id: 100, menuName: 'wechat_open_app_secret', value: 'late-shadow', sort: -1 });
    await expect(credentials()).rejects.toThrow('完整读取容量');
    await f.db.delete(systemConfig).where(eq(systemConfig.id, 100));
    // PostgreSQL varchar(5000) bounds Unicode characters, while the resolver
    // bounds complete UTF-8 bytes. All 61 real shadow rows remain schema-valid
    // at 5000 four-byte characters each and together exceed the 1 MiB budget.
    await f.db.update(systemConfig).set({ value: '😀'.repeat(5000) }).where(eq(systemConfig.sort, -1));
    const rows = await f.db.select().from(systemConfig);
    expect(rows).toHaveLength(64); expect(new TextEncoder().encode(JSON.stringify(rows)).byteLength).toBeGreaterThan(1024 * 1024);
    await expect(credentials()).rejects.toThrow('完整读取容量');
  });
  it('both actual public bootstrap consumers use fresh SQL with no Secret or APP_KEY prerequisite', async () => {
    await f.db.delete(systemConfig).where(eq(systemConfig.id, 2)); env.APP_KEY = '';
    expect(await readOpenPlatformAppId(container())).toBe(APP);
    expect(await new PcCompatibilityService(container(), env).appId()).toHaveProperty('appid', APP);
    expect(await new KefuCoreService(container(), env).clientConfig()).toMatchObject({ appid: APP, site_name: 'Owned shop' });
    await f.db.update(systemConfig).set({ value: 'wx1111111111111111' }).where(eq(systemConfig.id, 1));
    expect(await new PcCompatibilityService(container(), env).appId()).toHaveProperty('appid', 'wx1111111111111111');
    expect(await new KefuCoreService(container(), env).clientConfig()).toHaveProperty('appid', 'wx1111111111111111');
    expect((env.CONFIG_KV.get as ReturnType<typeof vi.fn>).mock.calls.flat()).not.toContain('cfg_wechat_open_app_id');
    await expect(start()).rejects.toThrow('尚未配置');
  });
  it('state v2 returns the actual pair AppID, binds only its HMAC stamp, and retains 15min state/10min one-use code TTL', async () => {
    const flow = await start(); expect(flow.state.appId).toBe(APP);
    const stored = [...store.values.values()][0]; expect(stored).toMatchObject({ version: 2, credentialsStamp: (await credentials()).stamp, audience: 'pc_user' });
    expect(JSON.stringify(stored)).not.toContain(SECRET); expect(JSON.stringify(stored)).not.toContain(APP);
    await flow.login('owned-code'); expect(store.sets.map(row => row.ttl)).toEqual([900, 600]);
    expect(network.mock.calls[0][0]).toContain('appid=' + APP); expect(network.mock.calls[0][0]).toContain('secret=' + SECRET);
  });
  it('actual PC reconciliation and mature login create one active identity and a nonce-isolated verifiable bucket', async () => {
    const flow = await start(), result = await flow.login();
    const accounts = await f.db.select().from(user), identities = await f.db.select().from(wechatUser);
    expect(accounts).toHaveLength(1); expect(identities).toMatchObject([{ uid: accounts[0].uid, openid: 'owned-openid', unionid: 'owned-union', userType: 'pc' }]);
    expect(await verifyToken(result.token, env.APP_KEY)).toMatchObject({ id: accounts[0].uid, type: 'api' });
    expect(decodeJwt(result.token).nonce).toMatch(/^[a-f0-9-]{36}$/); expect(store.buckets.has(md5(result.token))).toBe(true);
    expect(accounts[0].lastIp).toBe('127.0.0.1');
  });
  it('actual Kefu unionid mapping requires one active owner and service and preserves its response identity', async () => {
    await owner(); const result = await (await start('kefu_agent')).login();
    expect(await verifyToken(result.token, env.APP_KEY)).toMatchObject({ id: 88, type: 'kefu' });
    expect(result).toHaveProperty('kefuInfo', expect.objectContaining({ id: 88, uid: 77, account: 'owned-kefu' }));
    expect(await f.db.select().from(user)).toHaveLength(1); expect(store.buckets.has(md5(result.token))).toBe(true);
  });
  it.each(['missing', 'disabled', 'ambiguous'] as const)('does not issue a Kefu token for %s union/service ownership', async mode => {
    if (mode !== 'missing') await owner();
    if (mode === 'disabled') await f.db.update(storeService).set({ accountStatus: 0 });
    if (mode === 'ambiguous') {
      await f.db.insert(user).values({ uid: 78 }); await f.db.insert(wechatUser).values({ uid: 78, openid: 'other-openid', unionid: 'owned-union' });
    }
    await expect((await start('kefu_agent')).login()).rejects.toThrow(/未绑定客服用户|客服不存在|关联多个用户/); expect(store.buckets.size).toBe(0);
  });
  it('consumes states once, rejects old v1/wrong audience, and globally claims a code once across audiences', async () => {
    const old = await start(); const [key, value] = [...store.values.entries()][0]; store.values.set(key, { ...(value as object), version: 1 });
    await expect(old.login()).rejects.toThrow('授权状态'); expect(network).not.toHaveBeenCalled();
    const wrong = await start(); await expect(wrong.service.login('kefu_agent', 'unused', wrong.state.state, wrong.state.verifier)).rejects.toThrow('授权状态');
    await expect(wrong.login()).rejects.toThrow('授权状态');
    const first = await start(); await first.login('single-provider-code'); await expect(first.login()).rejects.toThrow('授权状态');
    const next = await start('kefu_agent'); await expect(next.login('single-provider-code')).rejects.toThrow('code 已使用'); expect(network).toHaveBeenCalledTimes(2);
  });
  it('requires Redis and preserves request throttling before provider traffic', async () => {
    store.redis = false; await expect(start()).rejects.toThrow('状态存储不可用');
    store.redis = true; store.rate = 31; await expect(start()).rejects.toThrow('过于频繁'); expect(network).not.toHaveBeenCalled();
    store.rate = 1; const flow = await start(); store.rate = 31; await expect(flow.login()).rejects.toThrow('过于频繁'); expect(network).not.toHaveBeenCalled();
  });
  it.each(['before', 'token', 'profile'] as const)('refuses a rotation %s provider I/O before any durable identity or bucket', async phase => {
    const flow = await start();
    if (phase === 'before') await rotate();
    else network.mockImplementation(async input => {
      const token = new URL(String(input)).pathname.endsWith('/access_token');
      if ((phase === 'token') === token) await rotate();
      return Response.json(token ? { access_token: 'old-token', openid: 'owned-openid' } : { unionid: 'owned-union' });
    });
    await expect(flow.login()).rejects.toThrow('授权配置已变化'); expect(network).toHaveBeenCalledTimes(phase === 'before' ? 0 : phase === 'token' ? 1 : 2);
    expect(await f.db.select().from(user)).toEqual([]); expect(await f.db.select().from(wechatUser)).toEqual([]); expect(store.buckets.size).toBe(0);
  });
  it('rejects same-winner shadow rotation after profile I/O', async () => {
    await f.db.insert(systemConfig).values({ id: 10, menuName: 'wechat_open_app_secret', value: 'shadow', sort: -1 });
    const flow = await start(); network.mockImplementation(async input => {
      const token = new URL(String(input)).pathname.endsWith('/access_token');
      if (!token) await f.db.update(systemConfig).set({ info: 'changed-source' }).where(eq(systemConfig.id, 10));
      return Response.json(token ? { access_token: 'old-token', openid: 'owned-openid' } : { unionid: 'owned-union' });
    });
    await expect(flow.login()).rejects.toThrow('授权配置已变化'); expect(await f.db.select().from(user)).toEqual([]);
  });
  it('bound container shares the actual outer SQL session, nested reconcile SAVEPOINT and rollback', async () => {
    const current = await credentials(), root = container(), transactions = vi.spyOn(f.db, 'transaction'); let boundDb: unknown;
    await expect(withOpenPlatformCredentials(root, env, current.stamp, async bound => {
      boundDb = bound.db; expect(bound.db).not.toBe(root.db);
      const [outer] = await bound.db.execute<{ id: string }>(sql`SELECT txid_current()::text AS id`);
      const nested = await withTx(bound, async tx => (await tx.execute<{ id: string }>(sql`SELECT txid_current()::text AS id`))[0].id);
      expect(nested).toBe(outer.id);
      const uid = await new WechatAuthService(bound, env).reconcileVerifiedIdentity({ openid: 'owned-openid', unionid: 'owned-union', userType: 'pc' });
      expect(await bound.userDao.findForAuth(uid)).toHaveProperty('uid', uid);
      throw Error('owned outer rollback');
    })).rejects.toThrow('owned outer rollback');
    expect(boundDb).toBeDefined(); expect(transactions).toHaveBeenCalledTimes(1);
    expect(await f.db.select().from(user)).toEqual([]); expect(await f.db.select().from(wechatUser)).toEqual([]);
  });
  it('the final fresh stamp fences even a source write inside the callback and rolls it back', async () => {
    const current = await credentials(); await expect(withOpenPlatformCredentials(container(), env, current.stamp, async bound => {
      await bound.db.update(systemConfig).set({ value: 'incomplete-race' }).where(eq(systemConfig.id, 2)); return 'must-not-publish';
    })).rejects.toThrow('授权配置已变化'); expect((await credentials()).stamp).toBe(current.stamp);
  });
  it.each(['pc_user', 'kefu_agent'] as const)('revokes exactly the actual %s token and rolls back all identity SQL after mature publication fails', async audience => {
    if (audience === 'kefu_agent') await owner();
    const previous = await createToken(77, audience === 'pc_user' ? 'api' : 'kefu', 'old-auth', env.APP_KEY);
    store.buckets.set(md5(previous.token), { token: previous.token });
    if (audience === 'pc_user') {
      const original = LoginService.prototype.loginByVerifiedUid;
      vi.spyOn(LoginService.prototype, 'loginByVerifiedUid').mockImplementation(async function (this: LoginService, ...args) { await original.apply(this, args); throw Error('owned failure after issue'); });
    } else {
      const original = KefuAuthService.prototype.loginByVerifiedIdentity;
      vi.spyOn(KefuAuthService.prototype, 'loginByVerifiedIdentity').mockImplementation(async function (this: KefuAuthService, ...args) { await original.apply(this, args); throw Error('owned failure after issue'); });
    }
    await expect((await start(audience)).login()).rejects.toThrow('owned failure after issue');
    expect(store.cleared).toHaveLength(1); expect(store.cleared[0]).not.toBe(md5(previous.token)); expect([...store.buckets.keys()]).toEqual([md5(previous.token)]);
    expect(await f.db.select().from(user)).toHaveLength(audience === 'pc_user' ? 0 : 1);
    expect(await f.db.select().from(wechatUser)).toHaveLength(audience === 'pc_user' ? 0 : 1);
  });
  it('observer captures an actual bearer before a lost bucket ACK; cleanup failure never returns a bearer', async () => {
    store.bucketFault = true; await expect((await start()).login()).rejects.toThrow('owned bucket write ACK failure');
    expect(store.cleared).toHaveLength(1); expect(store.buckets.size).toBe(0); expect(await f.db.select().from(user)).toEqual([]);
    store.clearFault = true; await expect((await start()).login()).rejects.toThrow('登录状态撤销未确认');
    expect(await f.db.select().from(user)).toEqual([]); expect(await f.db.select().from(wechatUser)).toEqual([]);
  });
  it('ordinary same-second JWTs remain identical, Open nonces differ, and verification returns the unchanged protocol', async () => {
    const now = Math.floor(Date.now() / 1000), args = [77, 'api', 'auth-digest', env.APP_KEY, 'cinashop', now] as const;
    const first = await createToken(...args), second = await createToken(...args);
    expect(first).toEqual(second); expect(decodeJwt(first.token)).not.toHaveProperty('nonce');
    const a = await createToken(...args, crypto.randomUUID()), b = await createToken(...args, crypto.randomUUID());
    expect(a.token).not.toBe(b.token); expect(await verifyToken(a.token, env.APP_KEY)).toEqual({ id: 77, type: 'api', auth: 'auth-digest', exp: a.exp });
    expect(decodeJwt(a.token)).toMatchObject({ jti: { id: 77, type: 'api' }, iat: now, iss: 'cinashop', auth: 'auth-digest' });
    for (const bad of ['', 'not-a-uuid', '11111111-1111-1111-8111-111111111111', '11111111-1111-4111-7111-111111111111', '{"jti":{"id":1}}']) {
      await expect(createToken(...args, bad)).rejects.toThrow('invalid token issuance nonce');
    }
  });
  it('two actual Open logins for an existing owner at the same second issue different buckets', async () => {
    await owner(); const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
    const a = await (await start()).login(), b = await (await start()).login();
    expect(a.token).not.toBe(b.token); expect(decodeJwt(a.token).iat).toBe(decodeJwt(b.token).iat); expect(store.buckets.size).toBe(2);
  });
  it('Open defers the mature standalone agent effect until commit; rollback never evaluates and ordinary login still evaluates', async () => {
    const effect = agentEffects.evaluateAgentLevelsAfterRegistration, seen: number[] = [];
    const observed = vi.spyOn(agentEffects, 'evaluateAgentLevelsAfterRegistration').mockImplementation(async (root, uid) => {
      expect(root.db).toBe(f.db);
      // A root query here would wait indefinitely if the effect still ran
      // inside the fixture's outer transaction. The committed user is visible.
      expect(await root.userDao.findForAuth(uid)).toHaveProperty('uid', uid);
      seen.push(uid); await effect(root, uid);
    });
    await (await start()).login(); expect(seen).toHaveLength(1);
    const uid = seen[0];
    await new LoginService(container(), env).loginByVerifiedUid(uid); expect(seen).toEqual([uid, uid]);
    observed.mockClear();
    const original = LoginService.prototype.loginByVerifiedUid;
    vi.spyOn(LoginService.prototype, 'loginByVerifiedUid').mockImplementation(async function (this: LoginService, ...args) {
      await original.apply(this, args); throw Error('owned rollback before post-commit evaluation');
    });
    await expect((await start()).login()).rejects.toThrow('owned rollback before post-commit');
    expect(observed).not.toHaveBeenCalled();
  });
  it.each([
    { access_token: '', openid: 'owned-openid' }, { errcode: 40029 }, { access_token: 'ok', openid: 'x'.repeat(101) },
  ])('retains provider response identity checks for %j', async token => {
    network.mockResolvedValue(Response.json(token)); await expect((await start()).login()).rejects.toThrow('授权失败'); expect(store.buckets.size).toBe(0);
  });
  it('retains provider response byte bounds before any identity write', async () => {
    network.mockResolvedValue(new Response('x'.repeat(32769))); await expect((await start()).login()).rejects.toThrow('微信开放平台');
    expect(await f.db.select().from(user)).toEqual([]); expect(store.buckets.size).toBe(0);
  });
});
