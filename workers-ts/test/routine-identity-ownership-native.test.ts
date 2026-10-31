/** Actual isolated PG16 / full App LOGIN / real code2Session observation and
 * RSA prepay paths. Redis, KV and HTTP are transport fixtures only. Phone input
 * to reconcile is server-verified test input, not an SMS HTTP acceptance claim.
 * Cross-AppID configuration changes below are owned fixture maintenance only;
 * no production switch writer or historical account adoption is commissioned. */
import { Buffer } from 'node:buffer';
import { randomUUID, sign } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { systemConfig, user, userRecharge, wechatUser } from '@/models/schema';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { runRoutinePaymentRuntimeInstallation } from '@/migrations/routinePaymentRuntime';
import { runRoutineIdentityOwnershipUpgrade } from '@/migrations/runRoutineIdentityOwnershipUpgrade';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { WechatAuthService, type VerifiedSocialIdentity } from '@/services/wechat/WechatAuthService';
import { LoginService } from '@/services/user/LoginService';
import { appendRoutineIdentityOwnershipTx, readRoutineIdentityOwnerBySubjectTx,
  readRoutineIdentityOwnerForUidTx } from '@/services/wechat/RoutineIdentityOwnership';
import { RechargePaymentService } from '@/services/payment/RechargePaymentService';
import { verifyRoutineIdentityObservation } from '@/services/wechat/RoutineIdentityObservation';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { paymentQueryKeys } from './helpers/paymentQueryFixture';

const transport = vi.hoisted(() => {
  const state = { values: new Map<string, unknown>(), buckets: new Map<string, unknown>(), depth: 0,
    violations: [] as string[], kv: new Map<string, string>(), rejectGifts: false,
    abortAfterMapping: false, abortedFacts: undefined as undefined | Record<string, unknown>,
    takeHook: undefined as undefined | ((key: string) => Promise<void>) };
  const outside = (operation: string) => {
    if (state.depth) { state.violations.push(operation); throw Error('External I/O in ownership SQL transaction: ' + operation); }
  };
  const get = vi.fn(async (key: string) => { outside('cache get'); return state.values.get(key) ?? null; });
  const set = vi.fn(async (key: string, value: unknown) => { outside('cache set'); state.values.set(key, value); return true; });
  const take = vi.fn(async (key: string) => {
    outside('cache take'); const value = state.values.get(key) ?? null; state.values.delete(key);
    await state.takeHook?.(key); return value;
  });
  const remove = vi.fn(async (key: string) => { outside('cache delete'); return state.values.delete(key); });
  const setIfAbsent = vi.fn(async (key: string, value: unknown) => {
    outside('cache setnx'); if (state.values.has(key)) return false; state.values.set(key, value); return true;
  });
  const setBucket = vi.fn(async (key: string, value: unknown) => { outside('bearer set'); state.buckets.set(key, value); return true; });
  const clear = vi.fn(async (key: string) => { outside('bearer delete'); return state.buckets.delete(key); });
  const redis = { eval: vi.fn(async () => { outside('rate/replay'); return 1; }), get,
    set: vi.fn(async (key: string, value: unknown) => { await set(key, value); return 'OK'; }),
    del: vi.fn(async (key: string) => Number(await remove(key))) };
  return { state, outside, get, set, take, remove, setIfAbsent, setBucket, clear, redis };
});
vi.mock('@/utils/cache', () => ({ getRedis: () => transport.redis, cacheGet: transport.get, cacheSet: transport.set,
  cacheTake: transport.take, cacheDelete: transport.remove, cacheSetIfAbsent: transport.setIfAbsent,
  setTokenBucket: transport.setBucket, clearToken: transport.clear }));

const APP = 'wxOwnedProspectiveA', OTHER_APP = 'wxOwnedProspectiveB', OPENID = 'owned_legacy_routine',
  PHONE = '13800000011', NEW_PHONE = '13900000011', IP = '127.0.0.1', SECRET = 'owned-prospective-oauth-secret';
const SESSION = Buffer.from('0123456789abcdef').toString('base64');
const ABORT = Error('Owned caller aborted the complete identity transaction');
let keys: ReturnType<typeof paymentQueryKeys>;
type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Peer = Parameters<NonNullable<Fixture['withRuntimeRole']>>[0] extends (peer: infer P) => unknown ? P : never;
type Context = Awaited<ReturnType<typeof context>>;
const giftKey = (key: string) => /^cfg_(?:newcomer_|register_|first_order_)/u.test(key);

/** Wrap real transaction callbacks, including savepoints; never fabricate SQL
 * results or credentials. The optional abort happens after real persisted rows
 * are visible inside the transaction but before its actual commit. */
function observed(db: DbClient): DbClient {
  return new Proxy(db, { get(target, property, receiver) {
    const method: unknown = Reflect.get(target, property, receiver);
    if (typeof method !== 'function') return method;
    if (property !== 'transaction') return method.bind(target);
    return (...args: unknown[]) => Reflect.apply(method, target, [async (tx: DbClient) => {
      transport.state.depth++;
      try {
        const result = await (args[0] as (tx: DbClient) => Promise<unknown>)(observed(tx));
        if (transport.state.abortAfterMapping) {
          const [facts] = await tx.execute<Record<string, unknown>>(sql`SELECT
            (SELECT count(*)::int FROM public.routine_identity_ownership) AS owners,
            (SELECT count(*)::int FROM public.routine_identity_witness) AS witnesses,
            (SELECT count(*)::int FROM public.user_bill WHERE type='newcomer_add') AS bills,
            (SELECT count(*)::int FROM public.user_money WHERE type='newcomer_add') AS money`);
          if (Number(facts.owners) > 0) { transport.state.abortedFacts = facts; transport.state.abortAfterMapping = false; throw ABORT; }
        }
        return result;
      } finally { transport.state.depth--; }
    }, ...args.slice(1)]);
  } });
}
async function fixture(work: (c: Context) => Promise<void>) {
  const f = await refundRuntimeFixture();
  try {
    if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) throw Error('Actual owned PG16 and independent LOGINs required');
    await f.withRuntimeRole(app => f.withRuntimeRole!(async admin => {
      const c = await context(f, app, admin); await work(c);
      for (const [peer, kind] of [[app, 'app'], [admin, 'admin']] as const)
        expect(await auditRuntimeBusinessPrivileges(peer.db, kind, c.target)).toMatchObject({ ready: true, failures: [] });
    }));
  } finally { await f.close(); }
}
async function context(f: Fixture, app: Peer, admin: Peer) {
  const [identity] = await f.db.execute<{ database: string; maintenance: string }>(sql`SELECT current_database() AS database,current_user AS maintenance`);
  const target = { ...identity, app: app.role, admin: admin.role };
  await f.db.delete(systemConfig).where(inArray(systemConfig.menuName,
    ['routine_appId', 'routine_appsecret', 'pay_weixin_mchid', 'pay_weixin_serial_no', 'pay_weixin_open', 'site_url']));
  await f.db.insert(systemConfig).values(Object.entries({ routine_appId: APP, routine_appsecret: SECRET,
    pay_weixin_mchid: '1234567890', pay_weixin_serial_no: 'ABCDEF123456', pay_weixin_open: '1', site_url: 'https://owned.example' })
    .map(([menuName, value]) => ({ menuName, value: JSON.stringify(value), sort: 9 })));
  await f.db.update(user).set({ account: 'owned-existing-account', phone: PHONE, nowMoney: '25.00', integral: 81,
    level: 2, levelStatus: 1, isMoneyLevel: 1, isEverLevel: 1, overdueTime: 1999999999 }).where(eq(user.uid, 11));
  await f.db.insert(wechatUser).values([{ id: 701, uid: 11, openid: OPENID, userType: 'routine' },
    { id: 702, uid: 11, openid: 'owned_old_official', userType: 'wechat' }]);
  await f.db.insert(userRecharge).values({ uid: 11, orderId: 'czowned_historical', price: '12.34', paid: 1,
    payTime: 1700000000, rechargeType: 'weixin', tradeNo: 'owned_historical_transaction' });
  await runRuntimeBusinessCommissioning(f.db, { ...target, pricingOwner: f.pricingOwner });
  await runRoutinePaymentRuntimeInstallation(f.db, target);
  await runRoutineIdentityOwnershipUpgrade(f.db, target);
  const db = observed(app.db), container = createContainerFromDb(db);
  const env = { APP_KEY: 'owned-prospective-identity-authenticator', WECHAT_MCH_PRIVATE_KEY: keys.privateKey,
    WECHAT_PLATFORM_PUBLIC_KEY: keys.publicKey, WECHAT_PLATFORM_PUBLIC_KEY_ID: 'TEST_QUERY_PUBLIC_KEY', WECHAT_API_V3_KEY: 'a'.repeat(32),
    CONFIG_KV: { get: vi.fn(async (key: string) => {
      transport.outside('KV GET');
      if (/^cfg_(?:routine_app|wechat_app|pay_weixin_|site_url)/u.test(key)) throw Error('SQL credential/payment authority cannot fall back to KV');
      if (transport.state.rejectGifts && giftKey(key)) throw Error('Mapped login must not consult gift KV');
      return transport.state.kv.get(key) ?? '0';
    }), put: async () => { transport.outside('KV PUT'); }, delete: async () => { transport.outside('KV DEL'); } } } as unknown as Env;
  const subjects = new Map<string, { openid: string; unionid?: string }>();
  let phone = PHONE, currentApp = APP, failPrepay = false;
  const providerBodies: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    transport.outside('provider HTTP'); const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === 'https://api.weixin.qq.com') {
      if (url.pathname === '/sns/jscode2session') {
        expect(url.searchParams.get('appid')).toBe(currentApp); expect(url.searchParams.get('secret')).toBe(SECRET);
        const result = subjects.get(url.searchParams.get('js_code') ?? ''); if (!result) throw Error('Unexpected unclaimed owned provider code');
        return Response.json({ ...result, session_key: SESSION });
      }
      if (url.pathname === '/cgi-bin/token') return Response.json({ access_token: 'owned_phone_token', expires_in: 7200 });
      if (url.pathname === '/wxa/business/getuserphonenumber') return Response.json({ errcode: 0, phone_info: { purePhoneNumber: phone } });
    }
    if (url.origin === 'https://api.mch.weixin.qq.com' && url.pathname === '/v3/pay/transactions/jsapi') {
      expect(new Headers(init?.headers).get('Authorization')).toContain('WECHATPAY2-SHA256-RSA2048');
      providerBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (failPrepay) throw Error('Owned prepay transport unavailable after reservation');
      const body = JSON.stringify({ prepay_id: 'owned_prepay_' + providerBodies.length }), timestamp = String(Math.floor(Date.now() / 1000)), nonce = 'owned_prepay_response';
      return new Response(body, { headers: { 'Wechatpay-Timestamp': timestamp, 'Wechatpay-Nonce': nonce,
        'Wechatpay-Serial': 'TEST_QUERY_PUBLIC_KEY', 'Wechatpay-Signature': Buffer.from(sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), keys.privateKey)).toString('base64') } });
    }
    throw Error('Unexpected provider endpoint');
  });
  const auth = () => new WechatAuthService(container, env);
  const code = (openid = OPENID, unionid?: string) => { const value = randomUUID(); subjects.set(value, { openid, ...(unionid ? { unionid } : {}) }); return value; };
  const exchange = async (openid = OPENID, unionid?: string) => {
    const ticket = await auth().beginMiniProgramLogin({ code: code(openid, unionid), ip: IP });
    const raw = transport.state.values.get('routine_login:' + ticket.key) as { identity: VerifiedSocialIdentity } | undefined;
    if (!raw?.identity.routineObservation) throw Error('Actual server observation ticket missing');
    const identity = raw.identity, observation = verifyRoutineIdentityObservation(env, identity.routineObservation);
    expect(observation).toMatchObject({ appId: currentApp, openid });
    return { ticket, identity, observation };
  };
  const reconcile = async (openid = OPENID, verifiedPhone?: string) => {
    const proof = await exchange(openid);
    const uid = await auth().reconcileVerifiedIdentity({ ...proof.identity, ...(verifiedPhone ? { phone: verifiedPhone } : {}) });
    return { ...proof, uid };
  };
  const rotate = async (appId: string) => {
    // Owned fixture maintenance bypasses the closed production author writer.
    await f.db.update(systemConfig).set({ value: JSON.stringify(appId) }).where(eq(systemConfig.menuName, 'routine_appId')); currentApp = appId;
  };
  const subject = (appId = APP, openid = OPENID, expectedUid?: number) => withTx(container, tx =>
    readRoutineIdentityOwnerBySubjectTx(tx, env, { appId, openid, ...(expectedUid === undefined ? {} : { expectedUid }) }));
  const owner = (uid = 11, appId = APP) => withTx(container, tx => readRoutineIdentityOwnerForUidTx(tx, env, { uid, appId }));
  const pay = async (orderNo: string) => {
    await f.db.insert(userRecharge).values({ uid: 11, orderId: orderNo, price: '10.00' });
    return new RechargePaymentService(container, env).startWechatPayment(11, orderNo, 'routine');
  };
  return { f, app, admin, target, db, container, env, auth, code, exchange, reconcile, rotate, subject, owner, pay, providerBodies,
    setPhone: (value: string) => { phone = value; }, failPrepay: () => { failPrepay = true; } };
}
async function state(c: Context) {
  const [row] = await c.f.db.execute<{ value: Record<string, unknown> }>(sql`SELECT jsonb_build_object(
    'users',(SELECT jsonb_agg(to_jsonb(t) ORDER BY uid) FROM public."user" t),
    'bindings',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.wechat_user t),
    'recharges',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.user_recharge t),
    'bills',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.user_bill t),
    'money',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.user_money t),
    'owners',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY ownership_id) FROM public.routine_identity_ownership t),
    'witnesses',(SELECT jsonb_agg(to_jsonb(t) ORDER BY observation_id) FROM public.routine_identity_witness t)) AS value`);
  return row.value;
}
async function owners(c: Context) { return Array.from(await c.f.db.execute(sql`SELECT to_jsonb(t) AS row,t.xmin::text AS version FROM public.routine_identity_ownership t ORDER BY ownership_id`)); }
async function witnesses(c: Context) { return Array.from(await c.f.db.execute(sql`SELECT * FROM public.routine_identity_witness ORDER BY observation_id`)); }
const ledger = (c: Context) => c.f.db.execute(sql`SELECT to_jsonb(t) AS row,t.xmin::text AS version FROM public.routine_payment_attempt t ORDER BY order_no,event_kind`);
function gifts() {
  for (const [key, value] of Object.entries({ newcomer_status: '1', register_integral_status: '1', register_give_integral: '7',
    register_money_status: '1', register_give_money: '3', register_coupon_status: '0', first_order_status: '1' })) transport.state.kv.set('cfg_' + key, value);
}
async function encryptedPhone(phone: string) {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(Buffer.from(SESSION, 'base64')).buffer as ArrayBuffer,
    { name: 'AES-CBC' }, false, ['encrypt']);
  const iv = new Uint8Array(16), plain = new TextEncoder().encode(JSON.stringify({ purePhoneNumber: phone, watermark: { appid: APP } }));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: iv.buffer as ArrayBuffer }, key, plain.buffer as ArrayBuffer);
  return { iv: Buffer.from(iv).toString('base64'), encryptedData: Buffer.from(encrypted).toString('base64') };
}
async function refusedOrPending(work: Promise<unknown>) {
  const result = await work.then(value => ({ value }), error => ({ error }));
  if ('error' in result) expect(result.error).toMatchObject({ code: 400 });
  else expect(result.value).toMatchObject({ bindPhone: true });
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('prospective Routine identity ownership through real App PG16', () => {
  beforeAll(() => { keys = paymentQueryKeys(); });
  beforeEach(() => {
    vi.clearAllMocks(); const s = transport.state; s.values.clear(); s.buckets.clear(); s.kv.clear(); s.depth = 0;
    s.violations.length = 0; s.rejectGifts = false; s.abortAfterMapping = false; s.abortedFacts = undefined; s.takeHook = undefined;
  });
  afterEach(() => { try { expect(transport.state.depth).toBe(0); expect(transport.state.violations).toEqual([]); } finally { vi.restoreAllMocks(); } });

  it('cannot silently adopt an unmapped legacy binding even when that old UID has a phone and mandatory-phone KV is off', async () => fixture(async c => {
    gifts(); const before = await state(c);
    await refusedOrPending(c.auth().miniProgramSilentLogin({ code: c.code(), ip: IP }));
    const fresh = await c.exchange(); await expect(c.auth().completeMiniProgramLogin(fresh.ticket.key, IP)).rejects.toMatchObject({ code: 400 });
    expect(await state(c)).toEqual(before); expect(transport.state.buckets.size).toBe(0);
  }), 180000);

  it('uses the actual provider phone endpoint to prove the same UID and preserves all old rights, bindings and paid orders', async () => fixture(async c => {
    gifts(); const before = await state(c);
    expect(await c.auth().miniProgramPhoneCredentialLogin({ code: c.code(), phoneCode: randomUUID(), ip: IP, issueToken: false })).toEqual({ uid: 11 });
    const after = await state(c);
    for (const key of ['users', 'bindings', 'recharges', 'bills', 'money']) expect(after[key]).toEqual(before[key]);
    expect(await c.subject()).toMatchObject({ owner: { uid: 11, appId: APP, openid: OPENID, bindingId: 701 } });
    expect(await owners(c)).toHaveLength(1); expect(await witnesses(c)).toHaveLength(1);
  }), 180000);

  it('cannot adopt a no-phone old UID by adding an arbitrary newly verified phone which resolves to no existing UID', async () => fixture(async c => {
    await c.f.db.update(user).set({ phone: '' }).where(eq(user.uid, 11)); c.setPhone(NEW_PHONE);
    const before = await state(c);
    await expect(c.auth().miniProgramPhoneCredentialLogin({ code: c.code(), phoneCode: randomUUID(), ip: IP, issueToken: false })).rejects.toMatchObject({ code: 400 });
    expect(await state(c)).toEqual(before); expect(transport.state.buckets.size).toBe(0);
  }), 180000);

  it('rejects an independently verified phone belonging to another live UID without merging old accounts', async () => fixture(async c => {
    await c.f.db.update(user).set({ phone: NEW_PHONE }).where(eq(user.uid, 22)); const before = await state(c);
    const proof = await c.exchange();
    await expect(c.auth().reconcileVerifiedIdentity({ ...proof.identity, phone: NEW_PHONE })).rejects.toMatchObject({ code: 400 });
    expect(await state(c)).toEqual(before);
  }), 180000);

  it('creates a genuinely fresh subject, gifts, exact binding, witness and prospective map in one real transaction', async () => fixture(async c => {
    gifts(); const created = await c.reconcile('owned_fresh_subject'); expect(created.uid).not.toBe(11); expect(created.uid).not.toBe(22);
    const [account] = await c.f.db.select().from(user).where(eq(user.uid, created.uid));
    expect(account).toMatchObject({ nowMoney: '3.00', integral: 7, userType: 'routine' });
    const actual = await c.subject(APP, 'owned_fresh_subject', created.uid);
    expect(actual).toMatchObject({ owner: { uid: created.uid, appId: APP, openid: 'owned_fresh_subject', observationId: created.observation.observationId },
      witness: { observationId: created.observation.observationId, uid: created.uid } });
    const [count] = await c.f.db.execute(sql`SELECT
      (SELECT count(*)::int FROM public.user_bill WHERE uid=${created.uid} AND type='newcomer_add') AS bills,
      (SELECT count(*)::int FROM public.user_money WHERE uid=${created.uid} AND type='newcomer_add') AS money`);
    expect(count).toEqual({ bills: 1, money: 1 }); expect(await owners(c)).toHaveLength(1); expect(await witnesses(c)).toHaveLength(1);
    for (const wrong of [c.f.db, c.admin.db]) await expect(withTx(createContainerFromDb(wrong), tx => appendRoutineIdentityOwnershipTx(tx, c.env,
      { uid: created.uid, bindingId: actual!.owner.bindingId, observation: created.observation }))).rejects.toMatchObject({ code: 503 });
  }), 180000);

  it('keeps the first anchor and mapping xmin on repeat exchange and mapped silent login without registration KV', async () => fixture(async c => {
    gifts(); const first = await c.reconcile('owned_fresh_repeat'), before = await owners(c);
    transport.state.rejectGifts = true;
    const next = await c.auth().miniProgramSilentLogin({ code: c.code('owned_fresh_repeat'), ip: IP });
    expect(next).toMatchObject({ uid: first.uid }); expect(next).toHaveProperty('token');
    for (const privateValue of [SECRET, SESSION, c.env.APP_KEY, 'owned_fresh_repeat']) expect(JSON.stringify(next)).not.toContain(privateValue);
    expect(await owners(c)).toEqual(before); expect(await witnesses(c)).toHaveLength(2);
    expect(await c.subject(APP, 'owned_fresh_repeat')).toMatchObject({ owner: { observationId: first.observation.observationId },
      witness: { observationId: first.observation.observationId } });
    const newer = await c.exchange('owned_fresh_repeat');
    const bound = await withTx(c.container, tx => appendRoutineIdentityOwnershipTx(tx, c.env,
      { uid: first.uid, bindingId: Number((before[0].row as { binding_id: number }).binding_id), observation: newer.observation }));
    expect(bound.owner.observationId).toBe(first.observation.observationId); expect(bound.witness.observationId).toBe(first.observation.observationId);
    expect(await witnesses(c)).toHaveLength(3); expect(await owners(c)).toEqual(before);
  }), 180000);

  it('retains both AppID maps for one UID, chooses the intended payer and replays an old real RSA PREPAY before current identity', async () => fixture(async c => {
    await c.reconcile(OPENID, PHONE); const first = await c.pay('czowned_scope_a');
    expect(c.providerBodies[0]).toMatchObject({ appid: APP, payer: { openid: OPENID } });
    await c.rotate(OTHER_APP); await c.reconcile('owned_subject_b', PHONE);
    expect(await c.owner(11, APP)).toMatchObject({ owner: { openid: OPENID, bindingId: 701 } });
    expect(await c.owner(11, OTHER_APP)).toMatchObject({ owner: { openid: 'owned_subject_b' } });
    await c.pay('czowned_scope_b'); expect(c.providerBodies[1]).toMatchObject({ appid: OTHER_APP, payer: { openid: 'owned_subject_b' } });
    const saved = await ledger(c); await c.f.db.update(wechatUser).set({ isDel: 1 }).where(eq(wechatUser.id, 701));
    const replay = await new RechargePaymentService(c.container, c.env).startWechatPayment(11, 'czowned_scope_a', 'routine');
    expect(replay).toEqual(first); expect(c.providerBodies).toHaveLength(2); expect(await ledger(c)).toEqual(saved);
    expect(await owners(c)).toHaveLength(2);
  }), 180000);

  it('retains an old INITIATION without a receipt and refuses new provider work after account rotation', async () => fixture(async c => {
    await c.reconcile(OPENID, PHONE); c.failPrepay(); await expect(c.pay('czowned_unknown_init')).rejects.toThrow();
    expect(c.providerBodies).toHaveLength(1); const saved = await ledger(c);
    expect(saved).toHaveLength(1); expect((saved[0].row as { event_kind: string }).event_kind).toBe('INITIATION');
    await c.rotate(OTHER_APP);
    await expect(new RechargePaymentService(c.container, c.env).startWechatPayment(11, 'czowned_unknown_init', 'routine')).rejects.toMatchObject({ code: 400 });
    expect(c.providerBodies).toHaveLength(1); expect(await ledger(c)).toEqual(saved);
  }), 180000);

  it('cannot reassign the same physical binding to another AppID and rolls its fresh witness back', async () => fixture(async c => {
    await c.reconcile(OPENID, PHONE); await c.rotate(OTHER_APP); const proof = await c.exchange(); const before = await state(c);
    await expect(withTx(c.container, tx => appendRoutineIdentityOwnershipTx(tx, c.env, { uid: 11, bindingId: 701,
      observation: proof.observation }))).rejects.toMatchObject({ code: 400 });
    expect(await state(c)).toEqual(before);
  }), 180000);

  it('checks mapping HMAC and the original immutable anchor instead of accepting a valid newest witness as a substitute', async () => fixture(async c => {
    const first = await c.reconcile(OPENID, PHONE); await c.reconcile(OPENID, PHONE); const [original] = await c.f.db.execute(sql`SELECT signature FROM public.routine_identity_ownership`);
    await c.f.exec(`ALTER TABLE public.routine_identity_ownership DISABLE TRIGGER rio_immutable_rows;
      UPDATE public.routine_identity_ownership SET signature=repeat('0',64);
      ALTER TABLE public.routine_identity_ownership ENABLE TRIGGER rio_immutable_rows`);
    await expect(c.subject()).rejects.toMatchObject({ code: 503 });
    await c.f.db.transaction(async tx => {
      await tx.execute(sql`ALTER TABLE public.routine_identity_ownership DISABLE TRIGGER rio_immutable_rows`);
      await tx.execute(sql`UPDATE public.routine_identity_ownership SET signature=${original.signature}`);
      await tx.execute(sql`ALTER TABLE public.routine_identity_ownership ENABLE TRIGGER rio_immutable_rows`);
    });
    expect(await c.subject()).toMatchObject({ owner: { observationId: first.observation.observationId } });
    await c.f.db.transaction(async tx => {
      await tx.execute(sql`ALTER TABLE public.routine_identity_witness DISABLE TRIGGER riw_immutable_rows`);
      await tx.execute(sql`DELETE FROM public.routine_identity_witness WHERE observation_id=${first.observation.observationId}::uuid`);
      await tx.execute(sql`ALTER TABLE public.routine_identity_witness ENABLE TRIGGER riw_immutable_rows`);
    });
    expect(await witnesses(c)).toHaveLength(1); await expect(c.subject()).rejects.toMatchObject({ code: 503 });
  }), 180000);

  it('refuses disabled/deleted owners, an expected-UID mismatch and multiple live subjects in the same AppID', async () => fixture(async c => {
    await c.reconcile(OPENID, PHONE);
    await expect(c.subject(APP, OPENID, 22)).rejects.toMatchObject({ code: 400 });
    for (const [deny, restore] of [
      ['UPDATE public."user" SET status=0 WHERE uid=11', 'UPDATE public."user" SET status=1 WHERE uid=11'],
      ['UPDATE public."user" SET is_del=1 WHERE uid=11', 'UPDATE public."user" SET is_del=0 WHERE uid=11'],
      ['UPDATE public.wechat_user SET is_del=1 WHERE id=701', 'UPDATE public.wechat_user SET is_del=0 WHERE id=701'],
    ]) { await c.f.exec(deny); await expect(c.subject()).rejects.toThrow(); await c.f.exec(restore); }
    await c.reconcile('owned_second_same_app', PHONE);
    await expect(c.owner()).rejects.toMatchObject({ code: 400 }); expect(await owners(c)).toHaveLength(2);
  }), 180000);

  it('rolls the fresh UID, gifts, binding, witness and map back when the actual caller aborts before commit', async () => fixture(async c => {
    gifts(); const proof = await c.exchange('owned_aborted_subject'), before = await state(c); transport.state.abortAfterMapping = true;
    await expect(c.auth().reconcileVerifiedIdentity(proof.identity)).rejects.toBe(ABORT);
    expect(transport.state.abortedFacts).toEqual({ owners: 1, witnesses: 1, bills: 1, money: 1 });
    expect(await state(c)).toEqual(before); expect(transport.state.buckets.size).toBe(0);
  }), 180000);

  it('locks the real user before its exact binding while an independent peer holds the user row', async () => fixture(async c => {
    await c.reconcile(OPENID, PHONE); if (!c.f.withPeer) throw Error('Independent peer required');
    let reading: Promise<{ value?: unknown; error?: unknown }> | undefined;
    await c.f.withPeer(peer => peer.db.transaction(async tx => {
      await tx.execute(sql`SELECT uid FROM public."user" WHERE uid=11 FOR UPDATE`);
      reading = c.subject().then(value => ({ value }), error => ({ error }));
      let blocked = false;
      for (let i = 0; i < 40; i++) {
        const [lock] = await c.f.db.execute<{ blocked: boolean }>(sql`SELECT ${peer.pid}=ANY(pg_blocking_pids(${c.app.pid})) AS blocked`);
        if (lock.blocked) { blocked = true; break; } await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(blocked).toBe(true);
      // This NOWAIT succeeds only if the waiting reader has not taken the
      // binding before reaching its blocked user lock.
      expect(await tx.execute(sql`SELECT id FROM public.wechat_user WHERE id=701 FOR UPDATE NOWAIT`)).toEqual([{ id: 701 }]);
    }));
    expect(await reading).toMatchObject({ value: { owner: { uid: 11, bindingId: 701 } } });
  }), 180000);

  it('takes ordinary phone advisories before the user row so a waiting update cannot invert Routine phone locking', async () => fixture(async c => {
    await c.reconcile(OPENID, PHONE); if (!c.f.withPeer) throw Error('Independent peer required');
    const oldOwners = await owners(c), oldState = await state(c);
    let changing: Promise<{ error?: unknown; done?: true }> | undefined;
    await c.f.withPeer(peer => peer.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`user-phone:${PHONE}`}))`);
      changing = new LoginService(c.container, c.env).updatePhone(11, NEW_PHONE)
        .then(() => ({ done: true as const }), error => ({ error }));
      let blocked = false;
      for (let i = 0; i < 40; i++) {
        const [lock] = await c.f.db.execute<{ blocked: boolean }>(sql`SELECT ${peer.pid}=ANY(pg_blocking_pids(${c.app.pid})) AS blocked`);
        if (lock.blocked) { blocked = true; break; } await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(blocked).toBe(true);
      // The former updatePhone locked this row before waiting on PHONE. This
      // real independent NOWAIT would fail against that previous implementation.
      expect(await tx.execute(sql`SELECT uid FROM public."user" WHERE uid=11 FOR UPDATE NOWAIT`)).toEqual([{ uid: 11 }]);
    }));
    expect(await changing).toEqual({ done: true });
    const [account] = await c.f.db.select().from(user).where(eq(user.uid, 11));
    expect(account).toMatchObject({ phone: NEW_PHONE, nowMoney: '25.00', integral: 81, level: 2, isMoneyLevel: 1, isEverLevel: 1 });
    const after = await state(c);
    for (const key of ['bindings', 'recharges', 'bills', 'money', 'owners', 'witnesses']) expect(after[key]).toEqual(oldState[key]);
    expect(await owners(c)).toEqual(oldOwners); expect(await c.subject()).toMatchObject({ owner: { uid: 11, bindingId: 701 } });
  }), 180000);

  it('detaches the crypto-phone UID before cache I/O and never writes another UID when the caller mutates its parameter object', async () => fixture(async c => {
    await c.reconcile(OPENID, PHONE);
    const login = await c.auth().mpLogin({ code: c.code(), ip: IP }); expect(login.uid).toBe(11);
    const before = await state(c), oldOwners = await owners(c), [other] = await c.f.db.select().from(user).where(eq(user.uid, 22));
    const input = { uid: 11, ...await encryptedPhone(NEW_PHONE) }; let changed = false;
    transport.state.takeHook = async key => {
      if (!key.startsWith('routine_session:')) return;
      expect(key.endsWith(':11')).toBe(true); input.uid = 22; changed = true;
      await Promise.resolve(); // Actual asynchronous cache transport boundary.
    };
    expect(await c.auth().bindPhoneByCrypto(input)).toEqual({ phone: NEW_PHONE });
    expect(changed).toBe(true); expect(input.uid).toBe(22);
    expect((await c.f.db.select().from(user).where(eq(user.uid, 22)))[0]).toEqual(other);
    const [account] = await c.f.db.select().from(user).where(eq(user.uid, 11));
    expect(account).toMatchObject({ phone: NEW_PHONE, nowMoney: '25.00', integral: 81, level: 2,
      isMoneyLevel: 1, isEverLevel: 1, overdueTime: 1999999999 });
    const after = await state(c);
    for (const key of ['bindings', 'recharges', 'bills', 'money', 'owners', 'witnesses']) expect(after[key]).toEqual(before[key]);
    expect(await owners(c)).toEqual(oldOwners); expect(await c.subject()).toMatchObject({ owner: { uid: 11, bindingId: 701 } });
  }), 180000);
});
