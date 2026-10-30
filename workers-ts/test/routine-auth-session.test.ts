import { Buffer } from 'node:buffer';
import { eq, sql } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { agentLevel, agentLevelTask, agentLevelTaskRecord, luckLottery, storeCouponIssue, storeCouponIssueUser, storeCouponUser,
  storeOrder, systemConfig, user, userBill, userFriends, userMoney, userSpread, userVisit, wechatUser } from '@/models/schema';
import { WechatAuthService, type SocialAuthResult, type VerifiedSocialIdentity } from '@/services/wechat/WechatAuthService';
import { readRoutineCredentials } from '@/services/wechat/RoutineRuntimeConfig';
import { issueRoutineIdentityObservation, verifyRoutineIdentityObservation } from '@/services/wechat/RoutineIdentityObservation';
import { ROUTINE_IDENTITY_WITNESS_SQL } from '@/migrations/routineIdentityWitness';
import { createToken, md5, verifyToken } from '@/utils/jwt';
import { financePostgres } from './helpers/financePostgres';
import { outcome, withFinancePeers } from './helpers/financePeers';

const transport = vi.hoisted(() => {
  const state = {
    values: new Map<string, unknown>(), buckets: new Map<string, { uid: number; type: string; token: string; exp: number }>(),
    depth: 0, violations: [] as string[],
    writeHook: undefined as undefined | ((key: string, value: unknown) => Promise<void>),
    takeHook: undefined as undefined | ((key: string) => Promise<void>),
    bucketHook: undefined as undefined | ((key: string) => Promise<void>),
    kvHook: undefined as undefined | ((key: string) => Promise<void>),
    bucketResult: true,
  };
  const outside = (operation: string) => {
    if (state.depth !== 0) { state.violations.push(operation); throw Error('External I/O inside a routine SQL transaction: ' + operation); }
  };
  const get = vi.fn(async (key: string) => { outside('GET ' + key); return state.values.get(key) ?? null; });
  const set = vi.fn(async (key: string, value: unknown) => {
    outside('SET ' + key); state.values.set(key, value); await state.writeHook?.(key, value); return true;
  });
  const take = vi.fn(async (key: string) => {
    outside('GETDEL ' + key); const value = state.values.get(key) ?? null; state.values.delete(key);
    await state.takeHook?.(key); return value;
  });
  const remove = vi.fn(async (key: string) => { outside('DEL ' + key); return state.values.delete(key); });
  const setIfAbsent = vi.fn(async (key: string, value: unknown) => {
    outside('SET NX ' + key); if (state.values.has(key)) return false;
    state.values.set(key, value); await state.writeHook?.(key, value); return true;
  });
  const setBucket = vi.fn(async (key: string, value: { uid: number; type: string; token: string; exp: number }) => {
    outside('SET bearer'); state.buckets.set(key, value); await state.bucketHook?.(key); return state.bucketResult;
  });
  const clear = vi.fn(async (key: string) => { outside('DEL bearer'); return state.buckets.delete(key); });
  const redis = {
    eval: vi.fn(async () => { outside('rate/replay'); return 1; }), get,
    set: vi.fn(async (key: string, value: unknown) => { await set(key, value); return 'OK'; }),
    del: vi.fn(async (key: string) => Number(await remove(key))),
  };
  return { state, outside, get, set, take, remove, setIfAbsent, setBucket, clear, redis };
});
vi.mock('@/utils/cache', () => ({
  getRedis: () => transport.redis,
  cacheGet: transport.get, cacheSet: transport.set, cacheTake: transport.take,
  cacheDelete: transport.remove, cacheSetIfAbsent: transport.setIfAbsent,
  setTokenBucket: transport.setBucket, clearToken: transport.clear,
}));

const APP = 'owned-routine-session-app', SECRET = 'owned-routine-session-secret', IP = '127.0.0.1';
const OPENID = 'owned-routine-session-openid', PHONE = '13800000000', NEXT_PHONE = '13900000000';
const SESSION = Buffer.from('0123456789abcdef').toString('base64');
type Issued = Extract<SocialAuthResult, { token: string }>;
function issued(value: SocialAuthResult): asserts value is Issued {
  expect(value).toHaveProperty('token'); if (!('token' in value)) throw Error('Expected an independently issued routine bearer');
}
function pending(value: SocialAuthResult): asserts value is Extract<SocialAuthResult, { bindPhone: true }> {
  expect(value).toHaveProperty('bindPhone', true); if (!('bindPhone' in value)) throw Error('Expected an owned pending capability');
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Real SQL/savepoints, reconciliation, registration gifts, phone updates,
 * AES-CBC and JWT signing. Only Redis/KV/provider transports are controlled.
 * Native PG16 may use this same fixture; memory does not prove peer lock ACLs.
 * No public request identity, SQL result or credential fence is mocked. */
describe('Routine source-bound tickets, identity commits and isolated bearer publication', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, env: Env;
  let network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  const kv = new Map<string, string>();

  // Retain all original DB methods/results. Wrapping actual transaction
  // callbacks also observes nested savepoints through bound containers.
  function observed(db: DbClient): DbClient {
    return new Proxy(db, { get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (typeof method !== 'function') return method;
      if (property !== 'transaction') return method.bind(target);
      return (...args: unknown[]) => {
        const callback = args[0]; if (typeof callback !== 'function') throw Error('Real SQL callback required');
        return Reflect.apply(method, target, [async (tx: DbClient) => {
          transport.state.depth++;
          try { return await callback(observed(tx)); } finally { transport.state.depth--; }
        }, ...args.slice(1)]);
      };
    } });
  }
  const container = () => createContainerFromDb(observed(f.db));
  const service = () => new WechatAuthService(container(), env);
  const current = () => readRoutineCredentials(container(), env);
  const rotate = () => f.db.update(systemConfig).set({ value: JSON.stringify('rotated-owned-routine-secret') }).where(eq(systemConfig.id, 2));
  const state = async () => ({
    users: await f.db.select().from(user).orderBy(user.uid), identities: await f.db.select().from(wechatUser).orderBy(wechatUser.id),
    integral: await f.db.select().from(userBill).orderBy(userBill.id), money: await f.db.select().from(userMoney).orderBy(userMoney.id),
  });
  const identity = async (changes: Partial<VerifiedSocialIdentity> = {}): Promise<VerifiedSocialIdentity> => {
    const credentials = await current();
    const value: VerifiedSocialIdentity = { openid: OPENID, userType: 'routine', routineStamp: credentials.stamp, ...changes };
    return { ...value, routineObservation: issueRoutineIdentityObservation(env, { appId: credentials.appId,
      openid: value.openid, unionid: value.unionid, sourceStamp: credentials.stamp }) };
  };
  const begin = (code = crypto.randomUUID()) => service().beginMiniProgramLogin({ code, ip: IP });
  const complete = async () => { const ticket = await begin(); return service().completeMiniProgramLogin(ticket.key, IP); };
  const sessionKey = (stamp: string, uid = 7) => `routine_session:v2:${stamp}:${uid}`;
  const sessionRecord = (stamp: string) => ({ version: 2, openid: OPENID, sessionKey: SESSION, stamp });
  const rawTicket = (key: string) => transport.state.values.get('routine_login:' + key) as {
    identity: Record<string, unknown>; [key: string]: unknown;
  };
  const rawPending = (key: string) => transport.state.values.get('social_pending:' + key) as Record<string, unknown>;

  beforeAll(async () => {
    f = await financePostgres([systemConfig, user, wechatUser, userVisit, userBill, userMoney, storeCouponIssue, storeCouponIssueUser, storeCouponUser,
      userSpread, userFriends, luckLottery, agentLevel, agentLevelTask, agentLevelTaskRecord, storeOrder], { namespace: 'public' });
    await f.exec('CREATE UNIQUE INDEX routine_session_owned_openid ON public.wechat_user(openid)');
    // Owner-only fixture installation, once per disposable database. This raw
    // immutable ledger is intentionally outside reset() and old state counts.
    await f.exec(ROUTINE_IDENTITY_WITNESS_SQL);
  }, 30_000);
  afterAll(async () => { await f?.close(); }, 30_000);
  beforeEach(async () => {
    vi.clearAllMocks(); transport.state.values.clear(); transport.state.buckets.clear(); transport.state.violations.length = 0;
    transport.state.depth = 0; transport.state.writeHook = undefined; transport.state.takeHook = undefined;
    transport.state.bucketHook = undefined; transport.state.kvHook = undefined; transport.state.bucketResult = true; kv.clear();
    await f.reset();
    await f.db.insert(systemConfig).values([
      { id: 1, menuName: 'routine_appId', value: JSON.stringify(APP), sort: 5 },
      { id: 2, menuName: 'routine_appsecret', value: JSON.stringify(SECRET), sort: 5 },
      { id: 3, menuName: 'routine_appsecret', value: 'owned-shadow', sort: -1 },
    ]);
    await f.db.insert(user).values({ uid: 7, account: 'owned-existing-user', pwd: md5('owned-existing-password'), phone: PHONE,
      nickname: 'Existing member', userType: 'routine', status: 1, nowMoney: '25.00', integral: 81, level: 2, levelStatus: 1, isMoneyLevel: 1 });
    await f.db.insert(wechatUser).values({ id: 7, uid: 7, openid: OPENID, userType: 'routine' });
    env = { APP_KEY: 'owned-routine-session-signing-key', CONFIG_KV: {
      get: vi.fn(async (key: string) => {
        transport.outside('KV GET ' + key); await transport.state.kvHook?.(key);
        if (/^cfg_(?:routine_appId|routine_appsecret|wechat_app_|wechat_open_)/u.test(key)) throw Error('Credential KV fallback is forbidden');
        return kv.get(key) ?? '0';
      }),
      put: vi.fn(async (key: string, value: string) => { transport.outside('KV PUT ' + key); kv.set(key, value); }),
      delete: vi.fn(async (key: string) => { transport.outside('KV DEL ' + key); kv.delete(key); }),
    } } as unknown as Env;
    network = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      transport.outside('provider');
      const url = new URL(String(input));
      if (url.origin !== 'https://api.weixin.qq.com') throw Error('Unexpected owned provider endpoint');
      if (url.pathname === '/sns/jscode2session') return Response.json({ openid: OPENID, session_key: SESSION });
      if (url.pathname === '/cgi-bin/token') return Response.json({ access_token: 'owned-phone-token', expires_in: 7200 });
      if (url.pathname === '/wxa/business/getuserphonenumber') return Response.json({ errcode: 0, phone_info: { purePhoneNumber: NEXT_PHONE } });
      throw Error('Unexpected owned provider path');
    });
  });
  afterEach(() => {
    try { expect(transport.state.depth).toBe(0); expect(transport.state.violations).toEqual([]); }
    finally { vi.restoreAllMocks(); }
  });

  async function normalSession() {
    const token = await createToken(7, 'api', md5(md5('owned-existing-password')), env.APP_KEY);
    const key = md5(token.token), bucket = { uid: 7, type: 'api', token: token.token, exp: 3600 };
    transport.state.buckets.set(key, bucket); return { key, bucket };
  }
  async function phoneData(appId = APP, session = SESSION) {
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(session), c => c.charCodeAt(0)).buffer as ArrayBuffer, { name: 'AES-CBC' }, false, ['encrypt']);
    const iv = new Uint8Array(16), bytes = new TextEncoder().encode(JSON.stringify({ purePhoneNumber: NEXT_PHONE, watermark: { appid: appId } }));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: iv.buffer as ArrayBuffer }, key, bytes.buffer as ArrayBuffer);
    return { iv: Buffer.from(iv).toString('base64'), encryptedData: Buffer.from(encrypted).toString('base64') };
  }
  async function makePending() {
    await f.db.update(user).set({ phone: '' }).where(eq(user.uid, 7)); kv.set('cfg_store_user_mobile', '1');
    const result = await service().loginVerifiedIdentity(await identity(), IP); pending(result); return result;
  }

  it('carries the fresh routine stamp in both ticket and pending capabilities without copying credentials', async () => {
    const credentials = await current(), before = await state(), ticket = await begin();
    expect(rawTicket(ticket.key).identity).toMatchObject({ openid: OPENID, userType: 'routine', routineStamp: credentials.stamp });
    expect(await state()).toEqual(before);
    const value = await makePending();
    expect(rawPending(value.key)).toMatchObject({ openid: OPENID, userType: 'routine', routineStamp: credentials.stamp });
    for (const identity of [rawTicket(ticket.key).identity, rawPending(value.key)]) {
      expect(verifyRoutineIdentityObservation(env, identity.routineObservation,
        { openid: OPENID, sourceStamp: credentials.stamp })).toMatchObject({ appId: APP, openid: OPENID });
    }
    for (const record of [rawTicket(ticket.key), rawPending(value.key)]) {
      expect(JSON.stringify(record)).not.toContain(SECRET); expect(JSON.stringify(record)).not.toContain(SESSION);
    }
  });

  it.each([undefined, '', 'not-a-stamp', 'A'.repeat(64)])('rejects an old or malformed routine ticket stamp %j before identity or bearer publication', async stamp => {
    const ticket = await begin(), raw = rawTicket(ticket.key);
    const changed = { ...raw.identity }; if (stamp === undefined) delete changed.routineStamp; else changed.routineStamp = stamp;
    transport.state.values.set('routine_login:' + ticket.key, { ...raw, identity: changed });
    const before = await state();
    await expect(service().completeMiniProgramLogin(ticket.key, IP)).rejects.toThrow();
    expect(await state()).toEqual(before); expect(transport.setBucket).not.toHaveBeenCalled();
  });

  it.each([undefined, 'bad-stamp', 'A'.repeat(64), 'a'.repeat(64)])('refuses a missing, malformed or unrelated direct routine identity stamp %j', async routineStamp => {
    const before = await state(), input: VerifiedSocialIdentity = { openid: OPENID, userType: 'routine', routineStamp };
    await expect(service().loginVerifiedIdentity(input, IP)).rejects.toThrow();
    await expect(service().reconcileVerifiedIdentity(input)).rejects.toThrow();
    expect(await state()).toEqual(before); expect(transport.state.buckets.size).toBe(0);
  });

  it.each(['ticket', 'pending', 'direct'] as const)('refuses a legacy stamp-only %s without manufacturing an observation', async mode => {
    if (mode === 'ticket') {
      const ticket = await begin(), raw = rawTicket(ticket.key), changed = { ...raw.identity };
      delete changed.routineObservation;
      transport.state.values.set('routine_login:' + ticket.key, { ...raw, identity: changed });
      const before = await state();
      await expect(service().completeMiniProgramLogin(ticket.key, IP)).rejects.toThrow();
      expect(await state()).toEqual(before);
    } else if (mode === 'pending') {
      const value = await makePending(), changed = { ...rawPending(value.key) };
      delete changed.routineObservation;
      transport.state.values.set('social_pending:' + value.key, changed);
      const before = await state();
      await expect(service().assertPendingIdentity(value.key, IP)).rejects.toThrow();
      await expect(service().completePendingPhoneBinding(value.key, NEXT_PHONE, IP)).rejects.toThrow();
      expect(await state()).toEqual(before);
    } else {
      const credentials = await current(), before = await state();
      const stampOnly: VerifiedSocialIdentity = { openid: OPENID, userType: 'routine', routineStamp: credentials.stamp };
      await expect(service().loginVerifiedIdentity(stampOnly, IP)).rejects.toThrow();
      await expect(service().reconcileVerifiedIdentity(stampOnly)).rejects.toThrow();
      expect(await state()).toEqual(before);
    }
    expect(transport.setBucket).not.toHaveBeenCalled(); expect(transport.state.buckets.size).toBe(0);
  });

  it.each(['wechat', 'apple', 'pc', 'app'] as const)('rejects a %s identity transplanted into the routine ticket realm', async userType => {
    const ticket = await begin(), raw = rawTicket(ticket.key), before = await state();
    transport.state.values.set('routine_login:' + ticket.key, { ...raw, identity: { ...raw.identity, openid: 'transplanted-new-openid', userType } });
    await expect(service().completeMiniProgramLogin(ticket.key, IP)).rejects.toThrow();
    expect(await state()).toEqual(before); expect(transport.state.buckets.size).toBe(0);
  });

  it('rejects a once-valid ticket after credential rotation and leaves the old UID and rights unchanged', async () => {
    const ticket = await begin(), before = await state(); await rotate();
    await expect(service().completeMiniProgramLogin(ticket.key, IP)).rejects.toThrow(/配置已变化|重新授权/u);
    expect(await state()).toEqual(before); expect(transport.setBucket).not.toHaveBeenCalled();
  });

  it('issues a distinct UUID-nonce bearer for each existing-UID login without revoking a normal API session', async () => {
    const old = await normalSession(), before = await state(), first = await complete(), second = await complete();
    expect(first.uid).toBe(7); expect(second.uid).toBe(7); expect(first.token).not.toBe(second.token);
    expect(first.token).not.toBe(old.bucket.token); expect(second.token).not.toBe(old.bucket.token);
    for (const value of [first, second]) {
      expect(await verifyToken(value.token, env.APP_KEY)).toMatchObject({ id: 7, type: 'api' });
      expect(decodeJwt(value.token).nonce).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
      expect(transport.state.buckets.get(md5(value.token))?.token).toBe(value.token);
    }
    expect(transport.state.buckets.get(old.key)).toEqual(old.bucket); expect(transport.clear).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
  });

  it('rechecks after bearer Redis I/O and revokes only this issuance when the source rotates', async () => {
    const old = await normalSession(), prior = await complete(), ticket = await begin(), before = await state();
    const kept = new Map(transport.state.buckets); transport.setBucket.mockClear(); transport.clear.mockClear();
    transport.state.bucketHook = async () => { await rotate(); };
    await expect(service().completeMiniProgramLogin(ticket.key, IP)).rejects.toThrow(/配置已变化|重新授权/u);
    expect(transport.setBucket).toHaveBeenCalledTimes(1); expect(transport.clear).toHaveBeenCalledTimes(1);
    const failed = transport.setBucket.mock.calls[0][0];
    expect(failed).not.toBe(old.key); expect(failed).not.toBe(md5(prior.token)); expect(transport.clear.mock.calls[0][0]).toBe(failed);
    expect([...transport.state.buckets]).toEqual([...kept]); expect(await state()).toEqual(before);
  });

  it.each(['throw', 'false'] as const)('revokes only the new bearer after an ambiguous %s bucket acknowledgement and preserves existing sessions', async failure => {
    const old = await normalSession(), ticket = await begin(), before = await state();
    if (failure === 'throw') transport.state.bucketHook = async () => { throw Error('owned post-write transport failure'); };
    else transport.state.bucketResult = false;
    await expect(service().completeMiniProgramLogin(ticket.key, IP)).rejects.toThrow();
    expect(transport.clear).toHaveBeenCalledTimes(1); expect(transport.clear.mock.calls[0][0]).not.toBe(old.key);
    expect([...transport.state.buckets]).toEqual([[old.key, old.bucket]]); expect(await state()).toEqual(before);
  });

  it.each(['routine_login:', 'social_pending:'])('refuses a %s cache publication that crosses a credential rotation', async prefix => {
    if (prefix === 'social_pending:') {
      await f.db.update(user).set({ phone: '' }).where(eq(user.uid, 7)); kv.set('cfg_store_user_mobile', '1');
    }
    const before = await state();
    transport.state.writeHook = async key => { if (key.startsWith(prefix)) await rotate(); };
    const request = prefix === 'routine_login:' ? begin() : service().loginVerifiedIdentity(await identity(), IP);
    await expect(request).rejects.toThrow(/配置已变化|重新授权/u);
    expect(await state()).toEqual(before); expect(transport.state.buckets.size).toBe(0);
  });

  it.each([undefined, 'bad-stamp'])('requires fresh authorization for legacy routine pending stamp %j', async stamp => {
    const value = await makePending(), raw = { ...rawPending(value.key) };
    if (stamp === undefined) delete raw.routineStamp; else raw.routineStamp = stamp;
    transport.state.values.set('social_pending:' + value.key, raw); const before = await state();
    await expect(service().assertPendingIdentity(value.key, IP)).rejects.toThrow();
    await expect(service().completePendingPhoneBinding(value.key, NEXT_PHONE, IP)).rejects.toThrow();
    expect(await state()).toEqual(before); expect(transport.setBucket).not.toHaveBeenCalled();
  });

  it('binds a live pending capability to the existing UID and refuses it after rotation', async () => {
    const value = await makePending(), before = await state(); await rotate();
    await expect(service().completePendingPhoneBinding(value.key, NEXT_PHONE, IP)).rejects.toThrow(/配置已变化|重新授权/u);
    expect(await state()).toEqual(before); expect(transport.setBucket).not.toHaveBeenCalled();
  });

  it('completes a live routine pending phone binding through actual SQL with its old rights retained', async () => {
    const value = await makePending(), before = await state();
    const result = await service().completePendingPhoneBinding(value.key, NEXT_PHONE, IP);
    expect(result.uid).toBe(7); expect(await verifyToken(result.token, env.APP_KEY)).toMatchObject({ id: 7, type: 'api' });
    const after = await state(); expect(after.users).toEqual(before.users.map(row => ({ ...row, phone: NEXT_PHONE })));
    expect(after.identities).toEqual(before.identities); expect(after.integral).toEqual(before.integral); expect(after.money).toEqual(before.money);
    await expect(service().completePendingPhoneBinding(value.key, NEXT_PHONE, IP)).rejects.toThrow();
  });

  it.each(['key', 'code'] as const)('retains the existing UID through the SMS phone-login %s path under its source gate', async mode => {
    const before = await state(), ticket = mode === 'key' ? await begin() : undefined;
    const result = await service().miniProgramPhoneLogin({
      ...(ticket ? { key: ticket.key } : { code: 'owned-direct-phone-login' }), phone: PHONE, ip: IP,
    });
    expect(result.uid).toBe(7); expect(await verifyToken(result.token, env.APP_KEY)).toMatchObject({ id: 7, type: 'api' });
    expect(decodeJwt(result.token).nonce).toMatch(/^[a-f0-9-]{36}$/u); expect(await state()).toEqual(before);
  });

  it('refuses a rotated SMS phone-login ticket before its old identity enters complete reconciliation', async () => {
    const ticket = await begin(), before = await state(); await rotate();
    await expect(service().miniProgramPhoneLogin({ key: ticket.key, phone: PHONE, ip: IP })).rejects.toThrow(/配置已变化|重新授权/u);
    expect(await state()).toEqual(before); expect(transport.setBucket).not.toHaveBeenCalled();
  });

  it.each(['wechat', 'apple', 'pc'] as const)('retains unstamped %s pending behavior independently of routine rotation', async userType => {
    const before = await state();
    const value = await service().loginVerifiedIdentity({ openid: 'owned-' + userType, userType }, IP, { forcePendingForNew: true });
    pending(value); expect(rawPending(value.key)).not.toHaveProperty('routineStamp'); await rotate();
    const result = await service().completePendingPhoneBinding(value.key, PHONE, IP);
    expect(result.uid).toBe(7); expect(await verifyToken(result.token, env.APP_KEY)).toMatchObject({ id: 7, type: 'api' });
    const after = await state(); expect(after.users).toEqual(before.users); expect(after.identities).toHaveLength(before.identities.length + 1);
    expect(after.identities.find(row => row.openid === 'owned-' + userType)).toMatchObject({ uid: 7, userType });
  });

  it('prefetches actual newcomer gifts outside the gate and commits them only for a newly created routine UID', async () => {
    const before = await state();
    for (const [key, value] of Object.entries({ newcomer_status: '1', register_integral_status: '1', register_give_integral: '5',
      register_money_status: '1', register_give_money: '2' })) kv.set('cfg_' + key, value);
    network.mockImplementation(async () => { transport.outside('provider'); return Response.json({ openid: 'owned-new-routine-user', session_key: SESSION }); });
    const result = await service().miniProgramSilentLogin({ code: 'owned-new-user-code', ip: IP }); issued(result);
    expect(result.uid).not.toBe(7);
    const after = await state(), created = after.users.find(row => row.uid === result.uid);
    expect(created).toMatchObject({ integral: 5, nowMoney: '2.00', userType: 'routine' });
    expect(after.users.find(row => row.uid === 7)).toEqual(before.users[0]);
    expect(after.integral.filter(row => row.uid === result.uid)).toMatchObject([{ eventKey: 'newcomer_give_integral', number: '5.00' }]);
    expect(after.money.filter(row => row.uid === result.uid)).toMatchObject([{ type: 'newcomer_add', number: '2.00' }]);
    expect(env.CONFIG_KV.get).toHaveBeenCalledWith('cfg_register_give_integral'); expect(transport.state.violations).toEqual([]);
  });

  it('commits a real referral before standalone enabled-policy level evaluation, retaining rights and an already granted upgrade on retries or policy disable', async () => {
    await f.db.insert(user).values({ uid: 8, account: 'owned-routine-referrer', status: 1 });
    await f.db.insert(systemConfig).values([
      { id: 90011, menuName: 'brokerage_func_status', value: '1' },
      { id: 90012, menuName: 'is_self_brokerage', value: '0' },
      { id: 90013, menuName: 'store_brokerage_binding_status', value: '1' },
      { id: 90014, menuName: 'store_brokerage_binding_time', value: '30' },
    ]);
    await f.db.insert(agentLevel).values({ id: 42, name: 'Owned referral level', grade: 1, status: 1, isDel: 0 });
    await f.db.insert(agentLevelTask).values({ id: 420, levelId: 42, type: 1, number: 1, isMust: 1, status: 1, isDel: 0 });
    const before = await state();
    // Observe the actual INSERT transactions. Different top-level XIDs prove
    // that evaluation did not run in a savepoint of the credential transaction.
    // Native PG additionally observes the real advisory gate, without replacing
    // the evaluator, SQL return values or the routine source fence.
    const gateHeld = process.env.TEST_FINANCE_POSTGRES_URL
      ? `EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid()
          AND locktype='advisory' AND classid=731666::oid AND objid=0::oid
          AND objsubid=2 AND mode='ShareLock' AND granted)`
      : 'false';
    try {
      await f.exec(`CREATE TABLE public.routine_owned_referral_observation
        (kind text NOT NULL, uid integer NOT NULL, xid text NOT NULL, routine_gate boolean NOT NULL);
        CREATE FUNCTION public.routine_owned_referral_observe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          INSERT INTO public.routine_owned_referral_observation VALUES (TG_ARGV[0], NEW.uid, txid_current()::text, ${gateHeld});
          RETURN NEW; END $$;
        CREATE TRIGGER routine_owned_referral_observe AFTER INSERT ON public.user_spread
          FOR EACH ROW EXECUTE FUNCTION public.routine_owned_referral_observe('referral');
        CREATE TRIGGER routine_owned_agent_observe AFTER INSERT ON public.agent_level_task_record
          FOR EACH ROW EXECUTE FUNCTION public.routine_owned_referral_observe('agent')`);
      const login = async () => {
        const ticket = await service().beginMiniProgramLogin({ code: crypto.randomUUID(), spreadUid: 8, ip: IP });
        const result = await service().completeMiniProgramLogin(ticket.key, IP);
        expect(result.uid).toBe(7); expect(await verifyToken(result.token, env.APP_KEY)).toMatchObject({ id: 7, type: 'api' });
        return result;
      };
      await login();
      const after = await state(), child = after.users.find(row => row.uid === 7)!;
      expect(child.spreadTime).toBeGreaterThan(0);
      expect(child).toEqual({ ...before.users.find(row => row.uid === 7), spreadUid: 8, spreadTime: child.spreadTime });
      expect(after.users.find(row => row.uid === 8)).toEqual({ ...before.users.find(row => row.uid === 8), spreadCount: 1, agentLevel: 42 });
      expect(after.identities).toEqual(before.identities); expect(after.integral).toEqual(before.integral); expect(after.money).toEqual(before.money);
      const relations = await f.db.select().from(userSpread).orderBy(userSpread.id);
      const friends = await f.db.select().from(userFriends).orderBy(userFriends.id);
      const records = await f.db.select().from(agentLevelTaskRecord).orderBy(agentLevelTaskRecord.id);
      expect(relations).toMatchObject([{ uid: 7, spreadUid: 8, spreadTime: child.spreadTime }]); expect(relations).toHaveLength(1);
      expect(friends).toMatchObject([{ uid: 7, friendsUid: 8 }]); expect(friends).toHaveLength(1);
      expect(records).toMatchObject([{ uid: 8, levelId: 42, taskId: 420, status: 0 }]); expect(records).toHaveLength(1);
      const observedCommits = await f.db.execute<{ kind: string; uid: number; xid: string; routine_gate: boolean }>(
        sql`SELECT kind,uid,xid,routine_gate FROM public.routine_owned_referral_observation ORDER BY kind`);
      expect([...observedCommits].map(row => ({ kind: row.kind, uid: row.uid }))).toEqual([{ kind: 'agent', uid: 8 }, { kind: 'referral', uid: 7 }]);
      expect(observedCommits[0].xid).not.toBe(observedCommits[1].xid);
      if (process.env.TEST_FINANCE_POSTGRES_URL) {
        expect(observedCommits[0].routine_gate).toBe(false); expect(observedCommits[1].routine_gate).toBe(true);
      }
      await login(); // Enabled retry must not duplicate completed evidence.
      await f.db.update(systemConfig).set({ value: '0' }).where(eq(systemConfig.id, 90011));
      await login(); // Disabling evaluation must not revoke an earned rank.
      expect(await state()).toEqual(after);
      expect(await f.db.select().from(userSpread).orderBy(userSpread.id)).toEqual(relations);
      expect(await f.db.select().from(userFriends).orderBy(userFriends.id)).toEqual(friends);
      expect(await f.db.select().from(agentLevelTaskRecord).orderBy(agentLevelTaskRecord.id)).toEqual(records);
      expect([...(await f.db.execute(sql`SELECT kind,uid,xid,routine_gate FROM public.routine_owned_referral_observation ORDER BY kind`))]).toEqual([...observedCommits]);
    } finally {
      await f.exec(`DROP TRIGGER IF EXISTS routine_owned_referral_observe ON public.user_spread;
        DROP TRIGGER IF EXISTS routine_owned_agent_observe ON public.agent_level_task_record;
        DROP FUNCTION IF EXISTS public.routine_owned_referral_observe(); DROP TABLE IF EXISTS public.routine_owned_referral_observation`);
    }
  });

  it('publishes only the v2 stamp/UID session and leaves both old global session keys untouched', async () => {
    const credentials = await current(), old = await normalSession(), before = await state();
    transport.state.values.set('session_key:' + OPENID, 'legacy-session');
    transport.state.values.set('session_key_uid:7', { openid: OPENID, sessionKey: 'legacy-session' });
    const result = await service().mpLogin({ code: 'owned-mp-session', ip: IP });
    expect(result.uid).toBe(7); expect(transport.state.values.get(sessionKey(credentials.stamp))).toEqual(sessionRecord(credentials.stamp));
    expect(transport.state.values.get('session_key:' + OPENID)).toBe('legacy-session');
    expect(transport.state.values.get('session_key_uid:7')).toEqual({ openid: OPENID, sessionKey: 'legacy-session' });
    expect(transport.set.mock.calls.some(([key]) => /^session_key(?::|_uid:)/u.test(key))).toBe(false);
    expect(transport.state.buckets.get(old.key)).toEqual(old.bucket); expect(await state()).toEqual(before);
  });

  it('refuses returning an mp bearer when publishing its session crosses a credential rotation', async () => {
    const old = await normalSession(), before = await state();
    transport.state.writeHook = async key => { if (key.startsWith('routine_session:v2:')) await rotate(); };
    await expect(service().mpLogin({ code: 'owned-mp-rotating-session', ip: IP })).rejects.toThrow(/配置已变化|重新授权/u);
    expect(await state()).toEqual(before); expect([...transport.state.buckets]).toEqual([[old.key, old.bucket]]);
  });

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('PG16 keeps the newer same-UID session usable when an older paused publisher fails the actual source gate', async () => {
    await f.db.update(user).set({ phone: '' }).where(eq(user.uid, 7));
    const credentials = await current(), scoped = sessionKey(credentials.stamp), old = await normalSession();
    const newerSession = Buffer.from('fedcba9876543210').toString('base64');
    const newerRecord = { ...sessionRecord(credentials.stamp), sessionKey: newerSession };
    const entered = barrier(), release = barrier();
    const original = network.getMockImplementation()!;
    network.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/sns/jscode2session' && url.searchParams.get('js_code') === 'owned-session-race-B') {
        transport.outside('provider'); return Response.json({ openid: OPENID, session_key: newerSession });
      }
      return original(input, init);
    });
    let paused = false;
    transport.state.writeHook = async (key, value) => {
      if (key !== scoped || paused) return;
      paused = true; expect(value).toEqual(sessionRecord(credentials.stamp));
      entered.resolve(); await release.promise;
    };
    await withFinancePeers(f.db, async ([owner]) => {
      const older = outcome(service().mpLogin({ code: 'owned-session-race-A', ip: IP }));
      try {
        // An unexpected early rejection must fail this test without leaving a
        // hanging transport barrier or unhandled request promise.
        await Promise.race([entered.promise, older.then(() => { throw Error('Older login ended before the owned SET barrier'); })]);
        const newer = await service().mpLogin({ code: 'owned-session-race-B', ip: IP });
        expect(newer.uid).toBe(7); expect(await verifyToken(newer.token, env.APP_KEY)).toMatchObject({ id: 7, type: 'api' });
        expect(transport.state.values.get(scoped)).toEqual(newerRecord);
        await owner.db.transaction(async tx => {
          const [held] = await tx.execute<{ locked: boolean; pid: number }>(
            sql`SELECT pg_try_advisory_xact_lock(731666,0) AS locked,pg_backend_pid() AS pid`);
          expect(held).toEqual({ locked: true, pid: owner.pid });
          release.resolve();
          const failed = await older;
          expect(failed.ok).toBe(false);
          if (failed.ok) throw Error('Older login escaped the independent maintenance gate');
          expect(failed.error).toMatchObject({ message: expect.stringMatching(/正在维护/u) });
          // A has no ownership of B's shared key. Neither the newer session nor
          // either earlier successful bearer may be removed by A's failure.
          expect(transport.state.values.get(scoped)).toEqual(newerRecord);
          expect(transport.remove.mock.calls.some(([key]) => key === scoped)).toBe(false);
          expect(transport.clear).not.toHaveBeenCalled();
        });
        expect(transport.setBucket).toHaveBeenCalledTimes(1);
        expect(transport.state.buckets.get(old.key)).toEqual(old.bucket);
        expect(transport.state.buckets.get(md5(newer.token))?.token).toBe(newer.token);
        // A different AES key makes this an actual use of B's retained session,
        // rather than just checking that some value survived in the map.
        expect(await service().bindPhoneByCrypto({ uid: 7, ...await phoneData(APP, newerSession) })).toEqual({ phone: NEXT_PHONE });
        expect((await f.db.select().from(user).where(eq(user.uid, 7)))[0]).toMatchObject({ phone: NEXT_PHONE, nowMoney: '25.00', integral: 81, level: 2, levelStatus: 1, isMoneyLevel: 1 });
        expect(transport.state.values.has(scoped)).toBe(false);
        expect(await verifyToken(newer.token, env.APP_KEY)).toMatchObject({ id: 7, type: 'api' });
      } finally { release.resolve(); await older; }
    });
  });

  it('refuses legacy phone sessions without reading or stamping their old cache entries', async () => {
    const credentials = await current(), encrypted = await phoneData(), before = await state();
    transport.state.values.set('session_key:' + OPENID, SESSION);
    transport.state.values.set('session_key_uid:7', { openid: OPENID, sessionKey: SESSION });
    await expect(service().bindPhoneByCrypto({ uid: 7, ...encrypted })).rejects.toThrow(/会话|重新登录|重新授权/u);
    expect(transport.take.mock.calls.map(([key]) => key)).toEqual([sessionKey(credentials.stamp)]);
    expect(transport.get.mock.calls.some(([key]) => /^session_key(?::|_uid:)/u.test(key))).toBe(false);
    expect(transport.state.values.get('session_key:' + OPENID)).toBe(SESSION);
    expect(transport.state.values.get('session_key_uid:7')).toEqual({ openid: OPENID, sessionKey: SESSION });
    expect(await state()).toEqual(before);
  });

  it('binds a current v2 session using real AES and phone SQL, then rejects its replay', async () => {
    await f.db.update(user).set({ phone: '' }).where(eq(user.uid, 7));
    await service().mpLogin({ code: 'owned-current-phone-session', ip: IP });
    const before = await state(), encrypted = await phoneData();
    expect(await service().bindPhoneByCrypto({ uid: 7, ...encrypted })).toEqual({ phone: NEXT_PHONE });
    const after = await state(); expect(after.users).toEqual(before.users.map(row => ({ ...row, phone: NEXT_PHONE })));
    expect(after.identities).toEqual(before.identities);
    await expect(service().bindPhoneByCrypto({ uid: 7, ...encrypted })).rejects.toThrow();
  });

  it('retains the provider watermark boundary when decrypting a current scoped session', async () => {
    const credentials = await current(), before = await state();
    transport.state.values.set(sessionKey(credentials.stamp), sessionRecord(credentials.stamp));
    await expect(service().bindPhoneByCrypto({ uid: 7, ...await phoneData('another-app-id') })).rejects.toThrow('所属小程序不匹配');
    expect(await state()).toEqual(before);
  });

  it('does not adopt an old scoped session after a same-AppID Secret rotation', async () => {
    const credentials = await current(); await service().mpLogin({ code: 'owned-old-phone-session', ip: IP });
    await rotate(); const next = await current(), before = await state(); transport.take.mockClear();
    await expect(service().bindPhoneByCrypto({ uid: 7, ...await phoneData() })).rejects.toThrow();
    expect(transport.take.mock.calls.map(([key]) => key)).toEqual([sessionKey(next.stamp)]);
    expect(transport.state.values.get(sessionKey(credentials.stamp))).toEqual(sessionRecord(credentials.stamp));
    expect(await state()).toEqual(before);
  });

  it('rejects source rotation while a scoped session GETDEL is in flight, before phone DML', async () => {
    const credentials = await current(); transport.state.values.set(sessionKey(credentials.stamp), sessionRecord(credentials.stamp));
    const before = await state();
    transport.state.takeHook = async key => { if (key.startsWith('routine_session:v2:')) await rotate(); };
    await expect(service().bindPhoneByCrypto({ uid: 7, ...await phoneData() })).rejects.toThrow(/配置已变化|重新授权/u);
    expect(await state()).toEqual(before);
  });

  it('rejects a mismatched stamp carried inside an otherwise current session key', async () => {
    const credentials = await current(), before = await state();
    transport.state.values.set(sessionKey(credentials.stamp), sessionRecord('a'.repeat(64)));
    await expect(service().bindPhoneByCrypto({ uid: 7, ...await phoneData() })).rejects.toThrow();
    expect(await state()).toEqual(before);
  });

  it('rolls back both phone and a deliberate late source mutation in the same actual SQL transaction', async () => {
    const credentials = await current(); transport.state.values.set(sessionKey(credentials.stamp), sessionRecord(credentials.stamp));
    const before = await state(), configBefore = await f.db.select().from(systemConfig).orderBy(systemConfig.id);
    // Owned fault injection, not an authorized generic writer: the trigger
    // demonstrates that the final source check and phone UPDATE share a commit.
    await f.exec(`CREATE FUNCTION public.routine_owned_phone_source_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE public.system_config SET value='"owned-late-source-change"' WHERE id=2; RETURN NEW; END $$;
      CREATE TRIGGER routine_owned_phone_source_fault BEFORE UPDATE OF phone ON public."user"
      FOR EACH ROW EXECUTE FUNCTION public.routine_owned_phone_source_fault()`);
    try {
      await expect(service().bindPhoneByCrypto({ uid: 7, ...await phoneData() })).rejects.toThrow(/配置已变化|重新授权/u);
      expect(await state()).toEqual(before); expect(await f.db.select().from(systemConfig).orderBy(systemConfig.id)).toEqual(configBefore);
    } finally { await f.exec('DROP TRIGGER routine_owned_phone_source_fault ON public."user"; DROP FUNCTION public.routine_owned_phone_source_fault()'); }
  });

  it('rejects a phone-provider response crossing rotation before identity/phone writes, including issueToken:false', async () => {
    await f.db.update(user).set({ phone: '' }).where(eq(user.uid, 7));
    const ticket = await begin(), before = await state();
    const original = network.getMockImplementation()!;
    network.mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname === '/wxa/business/getuserphonenumber') {
        transport.outside('phone provider'); await rotate(); return Response.json({ errcode: 0, phone_info: { purePhoneNumber: NEXT_PHONE } });
      }
      return original(input, init);
    });
    await expect(service().miniProgramPhoneCredentialLogin({ key: ticket.key, phoneCode: 'owned-provider-phone-code', ip: IP, issueToken: false }))
      .rejects.toThrow(/配置已变化|重新授权/u);
    expect(await state()).toEqual(before); expect(transport.setBucket).not.toHaveBeenCalled();
  });

  it('commits the live phone-code identity path with issueToken:false through actual SQL without publishing a bearer', async () => {
    await f.db.update(user).set({ phone: '' }).where(eq(user.uid, 7));
    const ticket = await begin(), before = await state();
    expect(await service().miniProgramPhoneCredentialLogin({ key: ticket.key, phoneCode: 'owned-live-phone-code', ip: IP, issueToken: false })).toEqual({ uid: 7 });
    const after = await state(); expect(after.users).toEqual(before.users.map(row => ({ ...row, phone: NEXT_PHONE })));
    expect(after.identities).toEqual(before.identities); expect(after.integral).toEqual(before.integral); expect(after.money).toEqual(before.money);
    expect(transport.setBucket).not.toHaveBeenCalled();
  });
});
