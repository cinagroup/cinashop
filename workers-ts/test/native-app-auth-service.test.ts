import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import type { Env } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import { systemConfig, user, wechatUser } from '../src/models/schema';
import { financeMemoryPostgres } from './helpers/financePostgres';
import { WechatAppAuthService, type NativeAppAuthResult } from '../src/services/wechat/WechatAppAuthService';
import { WechatAuthService } from '../src/services/wechat/WechatAuthService';
import { LoginService } from '../src/services/user/LoginService';
import { readNativeAppCredentials } from '../src/services/wechat/NativeAppRuntimeConfig';
import { md5, verifyToken } from '../src/utils/jwt';
import { ServiceUnavailableException } from '../src/utils/errors';

// Real owned SQL/savepoints, reconciliation, LoginService and JWT signing.
// Redis atomic primitives, HTTP provider transport, SMS and post-commit derived
// effects are controlled; this suite proves neither PG16 roles nor real OAuth.
const memory = vi.hoisted(() => ({ values: new Map<string, unknown>(), buckets: new Map<string, unknown>(),
  sets: [] as Array<{ key: string; ttl: number }>, cleared: [] as string[], sms: [] as unknown[][],
  effects: [] as number[], redis: true, rate: 1, bucketFault: false, clearFault: false }));
vi.mock('../src/utils/cache', async original => ({ ...await original<typeof import('../src/utils/cache')>(),
  getRedis: vi.fn(() => memory.redis ? { eval: async () => memory.rate } : null),
  cacheSetIfAbsent: vi.fn(async (key: string, value: unknown, _env: unknown, ttl: number) => {
    memory.sets.push({ key, ttl }); if (memory.values.has(key)) return false; memory.values.set(key, value); return true;
  }),
  cacheGet: vi.fn(async (key: string) => memory.values.get(key) ?? null),
  cacheTake: vi.fn(async (key: string) => { const value = memory.values.get(key) ?? null; memory.values.delete(key); return value; }),
  setTokenBucket: vi.fn(async (key: string, value: unknown) => {
    memory.buckets.set(key, value); if (memory.bucketFault) throw Error('owned bucket ACK failure'); return true;
  }),
  clearToken: vi.fn(async (key: string) => {
    memory.cleared.push(key); if (memory.clearFault) throw Error('owned revocation failure'); memory.buckets.delete(key); return true;
  }),
}));
vi.mock('../src/services/message/SmsVerificationService', () => ({ SmsVerificationService: class {
  async consumeUserCode(...args: unknown[]) { memory.sms.push(args); return String(args[1]); }
} }));
vi.mock('../src/services/agent/AgentLevelRegistrationEffects', () => ({
  evaluateAgentLevelsAfterRegistration: vi.fn(async (_container: unknown, uid: number) => { memory.effects.push(uid); }),
}));

const APP = 'owned_native_App1', SECRET = 'owned-native-server-secret', IP = '127.0.0.1';
const tokenPayload = () => ({ access_token: 'owned-provider-token', expires_in: 7200, openid: 'native-openid',
  unionid: 'owned-union', scope: 'snsapi_userinfo' });
const profilePayload = () => ({ openid: 'native-openid', unionid: 'owned-union', nickname: 'Owned profile', headimgurl: '', sex: 1 });
function issued(value: NativeAppAuthResult): asserts value is { token: string; exp_time: number; uid: number } {
  expect(value).toHaveProperty('token'); if (!('token' in value)) throw Error('owned expected bearer');
}
function pending(value: NativeAppAuthResult): asserts value is { need_phone: true; key: string; expiresIn: number } {
  expect(value).toHaveProperty('need_phone', true); if (!('need_phone' in value)) throw Error('owned expected pending');
}

describe('native App OAuth server-only capability and atomic identity publication', () => {
  let f: Awaited<ReturnType<typeof financeMemoryPostgres>>, env: Env;
  let network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  beforeAll(async () => {
    f = await financeMemoryPostgres([systemConfig, user, wechatUser], { namespace: 'public' });
    await f.exec('CREATE UNIQUE INDEX native_auth_owned_openid ON wechat_user(openid)');
  });
  afterAll(async () => { await f.close(); });
  beforeEach(async () => {
    memory.values.clear(); memory.buckets.clear(); memory.sets.length = 0; memory.cleared.length = 0;
    memory.sms.length = 0; memory.effects.length = 0; memory.redis = true; memory.rate = 1;
    memory.bucketFault = false; memory.clearFault = false;
    env = { APP_KEY: 'owned-native-signing-key', UPSTASH_REDIS_URL: 'owned-only', UPSTASH_REDIS_TOKEN: 'owned-token',
      CONFIG_KV: { get: vi.fn(async (key: string) => {
        if (/cfg_(wechat_app_|wechat_appid|wechat_appsecret|routine_)/u.test(key)) throw Error('credential realm must use fresh SQL');
        return '0';
      }), put: vi.fn(), delete: vi.fn() } } as unknown as Env;
    await f.reset();
    await f.db.insert(systemConfig).values([
      { id: 1, menuName: 'wechat_app_appid', value: JSON.stringify(APP), status: 0 },
      { id: 2, menuName: 'wechat_app_appsecret', value: JSON.stringify(SECRET), status: 0 },
      { id: 3, menuName: 'store_user_mobile', value: '0', status: 0 },
      { id: 4, menuName: 'wechat_appid', value: 'official-must-not-win' },
      { id: 5, menuName: 'routine_appId', value: 'routine-must-not-win' },
    ]);
    network = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => Response.json(
      new URL(String(input)).pathname.endsWith('/access_token') ? tokenPayload() : profilePayload()));
  });
  afterEach(() => { vi.restoreAllMocks(); });
  const container = () => createContainerFromDb(f.db);
  const service = () => new WechatAppAuthService(container(), env);
  const rotate = () => f.db.update(systemConfig).set({ value: JSON.stringify('owned-next-secret') }).where(eq(systemConfig.id, 2));
  async function start() {
    const auth = service(), state = await auth.createState(IP);
    return { auth, state, login: (code = crypto.randomUUID()) => auth.login({ code, state: state.state, verifier: state.verifier }, IP) };
  }
  async function owner(phone = '', type: 'wechat' | 'routine' = 'wechat') {
    await f.db.insert(user).values({ uid: 77, account: 'owned-user', pwd: md5('owned-password'), phone });
    await f.db.insert(wechatUser).values({ uid: 77, openid: 'prior-' + type, unionid: 'owned-union', userType: type });
  }
  const mobileRequired = () => f.db.update(systemConfig).set({ value: '1' }).where(eq(systemConfig.id, 3));

  it('creates native-only state with public AppID and verifier binding, consuming fresh AppSecret only at the fixed provider endpoint', async () => {
    const flow = await start(), values = [...memory.values.values()];
    expect(flow.state).toEqual({ state: expect.stringMatching(/^[a-f0-9-]{36}$/u), verifier: expect.stringMatching(/^[a-f0-9]{64}$/u), appId: APP, expiresIn: 300 });
    expect(memory.sets).toEqual([{ key: expect.stringMatching(/^native_app_oauth_state_v1:/u), ttl: 300 }]);
    expect(values[0]).toMatchObject({ version: 1, purpose: 'native_app_oauth', stamp: (await readNativeAppCredentials(container(), env)).stamp });
    for (const secret of [SECRET, flow.state.verifier, APP]) expect(JSON.stringify(values)).not.toContain(secret);
    const result = await flow.login(); issued(result);
    const url = new URL(String(network.mock.calls[0][0])); expect(url.origin + url.pathname).toBe('https://api.weixin.qq.com/sns/oauth2/access_token');
    expect(url.searchParams.get('appid')).toBe(APP); expect(url.searchParams.get('secret')).toBe(SECRET);
    expect(url.searchParams.get('grant_type')).toBe('authorization_code');
    expect(network.mock.calls.every(call => call[1]?.redirect === 'error')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET); expect(env.CONFIG_KV.put).not.toHaveBeenCalled();
  });
  it.each(['missing-app', 'missing-secret', 'missing-key', 'nul-app', 'multiline-secret'])('has no official/routine/env fallback for %s', async kind => {
    if (kind === 'missing-app') await f.db.delete(systemConfig).where(eq(systemConfig.id, 1));
    if (kind === 'missing-secret') await f.db.delete(systemConfig).where(eq(systemConfig.id, 2));
    if (kind === 'missing-key') env.APP_KEY = '';
    if (kind === 'nul-app') await f.db.update(systemConfig).set({ value: JSON.stringify('native\0id') }).where(eq(systemConfig.id, 1));
    if (kind === 'multiline-secret') await f.db.update(systemConfig).set({ value: JSON.stringify('secret\nnext') }).where(eq(systemConfig.id, 2));
    await expect(start()).rejects.toThrow(/原生App/u); expect(network).not.toHaveBeenCalled(); expect(memory.values.size).toBe(0);
  });
  it('fails closed on unavailable Redis or malformed/rate-exhausted atomic counter', async () => {
    memory.redis = false; await expect(start()).rejects.toThrow('状态存储');
    memory.redis = true; memory.rate = 0; await expect(start()).rejects.toThrow('限流状态');
    memory.rate = 31; await expect(start()).rejects.toThrow('过于频繁'); expect(network).not.toHaveBeenCalled();
  });
  it('wrong verifier and source cannot exchange code; the exact state is one-use', async () => {
    const flow = await start();
    await expect(flow.auth.login({ code: 'unused', state: flow.state.state, verifier: 'b'.repeat(64) }, IP)).rejects.toThrow('授权状态');
    expect(network).not.toHaveBeenCalled();
    const result = await flow.login('owned-once'); issued(result);
    await expect(flow.login('different-code')).rejects.toThrow('授权状态');
    const other = await start(); await expect(other.auth.login({ code: 'unused', state: other.state.state, verifier: other.state.verifier }, 'different-ip')).rejects.toThrow('授权状态');
    expect(network).toHaveBeenCalledTimes(2);
  });
  it.each(['version', 'purpose', 'expired', 'future', 'stamp'])('rejects tampered state %s before provider I/O', async kind => {
    const flow = await start(), [key, raw] = [...memory.values.entries()][0], record = { ...(raw as Record<string, unknown>) };
    if (kind === 'version') record.version = 2;
    if (kind === 'purpose') record.purpose = 'website_open';
    if (kind === 'expired') { record.issuedAt = Math.floor(Date.now() / 1000) - 301; record.expiresAt = Number(record.issuedAt) + 300; }
    if (kind === 'future') { record.issuedAt = Math.floor(Date.now() / 1000) + 60; record.expiresAt = Number(record.issuedAt) + 300; }
    if (kind === 'stamp') record.stamp = 'a'.repeat(64);
    memory.values.set(key, record); await expect(flow.login()).rejects.toThrow(/授权状态|配置已变化/u); expect(network).not.toHaveBeenCalled();
  });
  it('claims a code across fresh states and does not permit retry after an ambiguous transport failure', async () => {
    network.mockRejectedValueOnce(Error('owned transport containing secret=' + SECRET));
    await expect((await start()).login('same-code')).rejects.toThrow('授权服务');
    await expect((await start()).login('same-code')).rejects.toThrow('code已使用');
    expect(network).toHaveBeenCalledTimes(1); expect(memory.sets.filter(row => row.key.startsWith('native_app_oauth_code_used_v1:')).every(row => row.ttl === 600)).toBe(true);
    expect(await f.db.select().from(user)).toEqual([]);
  });
  it('returns trusted uid from the committed exact App association and preserves the prior union channel row', async () => {
    await owner('13800138000'); await mobileRequired(); const before = await f.db.select().from(wechatUser);
    const result = await (await start()).login(); issued(result); expect(result.uid).toBe(77);
    expect(await verifyToken(result.token, env.APP_KEY)).toMatchObject({ id: 77, type: 'api' });
    expect(decodeJwt(result.token).nonce).toMatch(/^[a-f0-9-]{36}$/u);
    const associations = await f.db.select().from(wechatUser); expect(associations).toHaveLength(2);
    expect(associations.find(row => row.userType === 'wechat')).toEqual(before[0]);
    expect(associations.find(row => row.userType === 'app')).toMatchObject({ uid: 77, openid: 'native-openid', unionid: 'owned-union' });
    expect(await f.db.select().from(user)).toHaveLength(1); expect(memory.effects).toEqual([77]); expect(memory.sms).toEqual([]);
  });
  it('creates one actual App account, with a nonce-isolated bearer and no provider token in SQL or pending storage', async () => {
    const result = await (await start()).login(); issued(result);
    expect(await f.db.select().from(user)).toMatchObject([{ uid: result.uid, userType: 'app', lastIp: IP }]);
    expect(await f.db.select().from(wechatUser)).toMatchObject([{ uid: result.uid, userType: 'app', openid: 'native-openid' }]);
    expect(memory.buckets.has(md5(result.token))).toBe(true);
    expect(JSON.stringify([...memory.values.values()])).not.toContain('owned-provider-token');
  });
  it('keeps same-second native login buckets distinct and does not revoke a prior bearer on later rollback', async () => {
    await owner(); const instant = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(instant);
    const first = await (await start()).login(); issued(first);
    const second = await (await start()).login(); issued(second); expect(first.token).not.toBe(second.token);
    const original = LoginService.prototype.loginByVerifiedUid;
    vi.spyOn(LoginService.prototype, 'loginByVerifiedUid').mockImplementation(async function (this: LoginService, ...args) {
      await original.apply(this, args); throw Error('owned failure after actual token and SQL touch');
    });
    await expect((await start()).login()).rejects.toThrow('owned failure');
    expect([...memory.buckets.keys()].sort()).toEqual([md5(first.token), md5(second.token)].sort());
    expect(memory.cleared).toHaveLength(1); expect(memory.cleared).not.toContain(md5(first.token));
  });
  it('rolls back new user, exact channel and login touch after bucket ACK failure and revokes only the observed bearer', async () => {
    memory.bucketFault = true; await expect((await start()).login()).rejects.toThrow('owned bucket ACK failure');
    expect(await f.db.select().from(user)).toEqual([]); expect(await f.db.select().from(wechatUser)).toEqual([]);
    expect(memory.cleared).toHaveLength(1); expect(memory.buckets.size).toBe(0); expect(memory.effects).toEqual([]);
    memory.clearFault = true; await expect((await start()).login()).rejects.toThrow('登录状态撤销未确认');
    expect(await f.db.select().from(user)).toEqual([]);
  });
  it('rejects disabled/deleted or cross-channel global openid conflicts before any bearer', async () => {
    await owner(); await f.db.update(user).set({ status: 0 }).where(eq(user.uid, 77));
    await expect((await start()).login()).rejects.toThrow('禁止'); expect(memory.buckets.size).toBe(0);
    await f.db.update(user).set({ status: 1 }).where(eq(user.uid, 77));
    await f.db.insert(wechatUser).values({ uid: 77, openid: 'native-openid', userType: 'routine', isDel: 0 });
    await expect((await start()).login()).rejects.toThrow(/冲突/u);
    await f.db.update(wechatUser).set({ userType: 'app', isDel: 1 }).where(eq(wechatUser.openid, 'native-openid'));
    await expect((await start()).login()).rejects.toThrow(/冲突/u); expect(memory.buckets.size).toBe(0);
  });
  it('fresh configuration rotation after token transport prevents identity and bearer publication', async () => {
    network.mockImplementation(async input => {
      if (new URL(String(input)).pathname.endsWith('/access_token')) { await rotate(); return Response.json(tokenPayload()); }
      return Response.json(profilePayload());
    });
    await expect((await start()).login()).rejects.toThrow('配置已变化'); expect(network).toHaveBeenCalledTimes(1);
    expect(await f.db.select().from(user)).toEqual([]); expect(memory.buckets.size).toBe(0);
  });
  it('checks the final real source stamp after token issuance and rolls back config, identity and bearer on a late SQL change', async () => {
    const original = LoginService.prototype.loginByVerifiedUid;
    vi.spyOn(LoginService.prototype, 'loginByVerifiedUid').mockImplementation(async function (this: LoginService, ...args) {
      const result = await original.apply(this, args);
      // Deliberate caller-owned transaction fault injection, not a claim that a
      // public writer is authorized to bypass the exclusive App account gate.
      const bound = (this as unknown as { container: ReturnType<typeof container> }).container;
      await bound.db.update(systemConfig).set({ value: 'owned-late-change' }).where(eq(systemConfig.id, 2));
      return result;
    });
    await expect((await start()).login()).rejects.toThrow('配置已变化');
    expect((await f.db.select().from(systemConfig).where(eq(systemConfig.id, 2)))[0].value).toBe(JSON.stringify(SECRET));
    expect(await f.db.select().from(user)).toEqual([]); expect(await f.db.select().from(wechatUser)).toEqual([]);
    expect(memory.buckets.size).toBe(0); expect(memory.cleared).toHaveLength(1); expect(memory.effects).toEqual([]);
  });
  it('phone-required policy uses fresh SQL and emits only a separate verifier-bound native capability without identity DML', async () => {
    const flow = await start(); await mobileRequired(); const result = await flow.login(); pending(result);
    expect(Object.keys(result).sort()).toEqual(['expiresIn', 'key', 'need_phone']);
    expect(await f.db.select().from(user)).toEqual([]); expect(await f.db.select().from(wechatUser)).toEqual([]); expect(memory.buckets.size).toBe(0);
    const row = [...memory.values.entries()].find(([key]) => key.startsWith('native_app_oauth_phone_v1:'))!;
    expect(row[1]).toMatchObject({ purpose: 'native_app_oauth_phone', identity: { openid: 'native-openid', userType: 'app' } });
    expect(JSON.stringify(row[1])).not.toContain(flow.state.verifier); expect(JSON.stringify(row[1])).not.toContain(SECRET);
    expect([...memory.values.keys()].some(key => key.startsWith('social_pending:'))).toBe(false);
    await expect(flow.auth.completePhone({ key: result.key, verifier: 'b'.repeat(64), phone: '13800138000', captcha: '123456' }, IP)).rejects.toThrow('续绑凭据');
    expect(memory.sms).toEqual([]);
  });
  it('consumes independent social-binding SMS then native pending once and commits trusted uid, phone and App association together', async () => {
    await mobileRequired(); const flow = await start(), result = await flow.login(); pending(result);
    const input = { key: result.key, verifier: flow.state.verifier, phone: '13800138000', captcha: '123456' };
    const login = await flow.auth.completePhone(input, IP); issued(login);
    expect(memory.sms).toEqual([['user_social_binding', input.phone, input.captcha]]);
    expect(await f.db.select().from(user)).toMatchObject([{ uid: login.uid, phone: input.phone }]);
    expect(await f.db.select().from(wechatUser)).toMatchObject([{ uid: login.uid, userType: 'app' }]);
    await expect(flow.auth.completePhone(input, IP)).rejects.toThrow('续绑凭据'); expect(memory.sms).toHaveLength(1);
  });
  it.each(['purpose', 'expired', 'channel', 'unknown-field'])('rejects tampered native pending %s before spending SMS', async kind => {
    await mobileRequired(); const flow = await start(), result = await flow.login(); pending(result);
    const [key, raw] = [...memory.values.entries()].find(([key]) => key.startsWith('native_app_oauth_phone_v1:'))!;
    const record = { ...(raw as Record<string, unknown>) };
    if (kind === 'purpose') record.purpose = 'social_pending';
    if (kind === 'expired') { record.issuedAt = Math.floor(Date.now() / 1000) - 601; record.expiresAt = Number(record.issuedAt) + 600; }
    if (kind === 'channel') record.identity = { ...(record.identity as object), userType: 'wechat' };
    if (kind === 'unknown-field') record.secret = 'not-allowed';
    memory.values.set(key, record);
    await expect(flow.auth.completePhone({ key: result.key, verifier: flow.state.verifier, phone: '13800138000', captcha: '123456' }, IP)).rejects.toThrow('续绑凭据');
    expect(memory.sms).toEqual([]); expect(memory.buckets.size).toBe(0);
  });
  it('does not spend SMS after pending stamp rotation or wrong realm, and cannot route App through legacy social_pending', async () => {
    await mobileRequired(); const flow = await start(), result = await flow.login(); pending(result);
    await rotate(); await expect(flow.auth.completePhone({ key: result.key, verifier: flow.state.verifier, phone: '13800138000', captcha: '123456' }, IP)).rejects.toThrow('配置已变化');
    expect(memory.sms).toEqual([]);
    await expect(new WechatAuthService(container(), env).loginVerifiedIdentity({ openid: 'untrusted', userType: 'app' }, IP)).rejects.toThrow('独立授权状态与凭据屏障');
    expect([...memory.values.keys()].some(key => key.startsWith('social_pending:'))).toBe(false);
  });
  it('rejects a verified phone belonging to a different union account without merging accounts', async () => {
    await owner(); await f.db.insert(user).values({ uid: 78, account: '13800138000', phone: '13800138000' });
    await mobileRequired(); const flow = await start(), result = await flow.login(); pending(result);
    await expect(flow.auth.completePhone({ key: result.key, verifier: flow.state.verifier, phone: '13800138000', captcha: '123456' }, IP)).rejects.toThrow('不同账号');
    expect(await f.db.select().from(user)).toHaveLength(2); expect(await f.db.select().from(wechatUser)).toHaveLength(1); expect(memory.buckets.size).toBe(0);
  });
  it.each([
    { scope: 'snsapi_base' }, { appid: 'wrong-app' }, { openid: '' }, { unionid: 'u'.repeat(31) },
    { expires_in: '7200' }, { access_token: '' }, { errcode: 40029 },
  ])('rejects invalid provider token scalars %j without exposing body or secrets', async change => {
    network.mockResolvedValue(Response.json({ ...tokenPayload(), ...change }));
    await expect((await start()).login()).rejects.toThrow('返回身份无效'); expect(await f.db.select().from(user)).toEqual([]); expect(memory.buckets.size).toBe(0);
  });
  it('rejects contradictory optional profile identity rather than overwriting token authority', async () => {
    network.mockImplementation(async input => Response.json(new URL(String(input)).pathname.endsWith('/access_token')
      ? tokenPayload() : { ...profilePayload(), unionid: 'different-union' }));
    await expect((await start()).login()).rejects.toThrow('身份不一致'); expect(memory.buckets.size).toBe(0);
  });
  it('optional unavailable profile cannot supply a different identity and may retain the token-verified identity', async () => {
    network.mockImplementation(async input => {
      if (new URL(String(input)).pathname.endsWith('/access_token')) return Response.json(tokenPayload());
      throw new ServiceUnavailableException('owned optional enrichment unavailable');
    });
    const result = await (await start()).login(); issued(result);
    expect(await f.db.select().from(wechatUser)).toMatchObject([{ uid: result.uid, openid: 'native-openid', unionid: 'owned-union', nickname: '' }]);
  });
  it.each(['redirect', 'declared-size', 'actual-size', 'bad-utf8', 'duplicate'])('bounds or rejects token response %s before any identity DML', async kind => {
    if (kind === 'redirect') network.mockResolvedValue(Response.redirect('https://untrusted.test/', 302));
    if (kind === 'declared-size') network.mockResolvedValue(new Response('{}', { headers: { 'content-length': '32769' } }));
    if (kind === 'actual-size') network.mockResolvedValue(new Response('x'.repeat(32769)));
    if (kind === 'bad-utf8') network.mockResolvedValue(new Response(new Uint8Array([0xc3, 0x28])));
    if (kind === 'duplicate') network.mockResolvedValue(new Response('{"openid":"one","openid":"two"}'));
    await expect((await start()).login()).rejects.toThrow('授权服务'); expect(await f.db.select().from(user)).toEqual([]);
  });
  it('aborts provider I/O against the total deadline and returns only a normalized error', async () => {
    network.mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Error('owned secret=' + SECRET)), { once: true });
    }));
    const flow = await start(); vi.useFakeTimers();
    try {
      const login = flow.login(), rejected = expect(login).rejects.toThrow('授权服务');
      // Drain hashing/state/SQL microtasks until actual fetch has started, then
      // advance only the controlled provider timer; no native PG timing claim.
      await vi.waitFor(() => expect(network).toHaveBeenCalled(), { timeout: 1000, interval: 1 });
      await vi.advanceTimersByTimeAsync(8001); await rejected;
      expect(await f.db.select().from(user)).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});
