import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { systemAdmin, systemConfig, systemMenus, systemRole, user, wechatUser } from '@/models/schema';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { runAdminWechatAppUpgrade } from '@/migrations/runAdminWechatAppUpgrade';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { AdminWechatAppService } from '@/services/admin/AdminWechatAppService';
import { WECHAT_APP_VIEW_SEED, WECHAT_APP_SAVE_SEED } from '@/services/admin/AdminWechatAppPermissionBinding';
import { WechatAppAuthService, type NativeAppAuthResult } from '@/services/wechat/WechatAppAuthService';
import { WechatAuthService } from '@/services/wechat/WechatAuthService';
import { readNativeAppCredentials } from '@/services/wechat/NativeAppRuntimeConfig';
import { LoginService } from '@/services/user/LoginService';
import { md5, verifyToken } from '@/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import type { WechatAppSave } from '../../view/common/wechatApp';

/** Actual isolated PG16, complete migrations and reviewed commissioning; App
 * and Admin are separately authenticated restricted LOGINs, never SET ROLE on
 * maintenance. Credential readers/fence, identity SQL/savepoints, LoginService
 * and JWT are real. Redis atomic primitives/token buckets, provider HTTP, SMS
 * verification and post-commit derived effects are controlled test doubles.
 * This does not prove a real Redis race, SMS delivery, WeChat or device OAuth. */
const memory = vi.hoisted(() => ({ values: new Map<string, unknown>(), buckets: new Map<string, unknown>(),
  cleared: [] as string[], sms: [] as unknown[][], effects: [] as number[],
  beforeSms: undefined as undefined | (() => Promise<void>) }));
vi.mock('../src/utils/cache', async original => ({ ...await original<typeof import('../src/utils/cache')>(),
  getRedis: vi.fn(() => ({ eval: async () => 1 })),
  cacheSetIfAbsent: vi.fn(async (key: string, value: unknown) => {
    if (memory.values.has(key)) return false; memory.values.set(key, value); return true;
  }),
  cacheGet: vi.fn(async (key: string) => memory.values.get(key) ?? null),
  cacheTake: vi.fn(async (key: string) => { const value = memory.values.get(key) ?? null; memory.values.delete(key); return value; }),
  setTokenBucket: vi.fn(async (key: string, value: unknown) => { memory.buckets.set(key, value); return true; }),
  clearToken: vi.fn(async (key: string) => { memory.cleared.push(key); memory.buckets.delete(key); return true; }),
}));
vi.mock('../src/services/message/SmsVerificationService', () => ({ SmsVerificationService: class {
  async consumeUserCode(...args: unknown[]) { await memory.beforeSms?.(); memory.sms.push(args); return String(args[1]); }
} }));
vi.mock('../src/services/agent/AgentLevelRegistrationEffects', () => ({
  evaluateAgentLevelsAfterRegistration: vi.fn(async (_container: unknown, uid: number) => { memory.effects.push(uid); }),
}));

type F = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Peer = Parameters<NonNullable<F['withRuntimeRole']>>[0] extends (peer: infer R) => unknown ? R : never;
const APP = 'owned_native_App1', SECRET = 'owned-native-oauth-server-secret', KEY = 'owned-native-oauth-signing-key';
const PASSWORD = 'owned-native-oauth-admin', ADMIN = 888890, OWNER = 888877, OTHER = 888878, IP = '127.0.0.1';
const domain = ['wechat_app_appid', 'wechat_app_appsecret'];
const expiresAt = Math.floor(Date.now() / 1000) + 3600;
const actor = () => ({ id: ADMIN, authVersion: md5(PASSWORD), expiresAt });
const save = (revision: string): WechatAppSave => ({ request_id: randomUUID(), revision, confirmed: true,
  fields: { wechat_app_appid: { action: 'keep' }, wechat_app_appsecret: { action: 'replace', value: 'owned-native-next-secret' } } });
function issued(value: NativeAppAuthResult): asserts value is { token: string; exp_time: number; uid: number } {
  expect(value).toHaveProperty('token'); if (!('token' in value)) throw Error('Owned expected native bearer');
}
function pending(value: NativeAppAuthResult): asserts value is { need_phone: true; key: string; expiresIn: number } {
  expect(value).toHaveProperty('need_phone', true); if (!('need_phone' in value)) throw Error('Owned expected native pending');
}
async function fixture(run: (ctx: {
  f: F; app: Peer; admin: Peer; env: Env; auth: WechatAppAuthService; author: AdminWechatAppService;
  start: () => Promise<{ state: string; verifier: string; appId: string; expiresIn: number }>;
  login: (state: { state: string; verifier: string }) => Promise<NativeAppAuthResult>;
  owner: (phone?: string) => Promise<void>; required: () => Promise<unknown>;
  rows: () => Promise<{ users: unknown[]; associations: unknown[] }>;
  provider: { openid: string; unionid: string; beforeTokenReply?: () => Promise<void> };
  network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
}) => Promise<void>) {
  memory.values.clear(); memory.buckets.clear(); memory.cleared.length = 0;
  memory.sms.length = 0; memory.effects.length = 0; memory.beforeSms = undefined;
  const f = await refundRuntimeFixture();
  try {
    if (f.format !== 'pg16' || !f.withRuntimeRole) throw Error('Actual independently authenticated PG16 required');
    await f.withRuntimeRole(app => f.withRuntimeRole!(async admin => {
      const [identity] = await f.exec('SELECT current_database() AS database,current_user AS maintenance');
      const names = { database: String(identity.database), maintenance: String(identity.maintenance), app: app.role,
        admin: admin.role, pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      await runAdminWechatAppUpgrade(f.db, names);
      for (const [peer, kind] of [[app, 'app'], [admin, 'admin']] as const)
        expect(await auditRuntimeBusinessPrivileges(peer.db, kind, names)).toMatchObject({ ready: true, failures: [] });
      await f.db.insert(systemRole).values({ id: ADMIN, roleName: 'Owned native OAuth author', rules: '1379,315' });
      await f.db.insert(systemAdmin).values({ id: ADMIN, account: 'owned_native_oauth_author', pwd: PASSWORD,
        roles: String(ADMIN), level: 1, adminType: 1 });
      await f.db.delete(systemMenus).where(inArray(systemMenus.id, [1379, 315]));
      await f.db.insert(systemMenus).values([{ ...WECHAT_APP_VIEW_SEED, menuName: '移动应用' }, { ...WECHAT_APP_SAVE_SEED, menuName: '保存配置' }]);
      await f.db.delete(systemConfig).where(inArray(systemConfig.menuName, [...domain, 'store_user_mobile']));
      await f.db.insert(systemConfig).values([
        { id: 888348, menuName: domain[0], value: JSON.stringify(APP), sort: 5, configTabId: 73 },
        { id: 888349, menuName: domain[1], value: JSON.stringify(SECRET), sort: 5, configTabId: 73 },
        { id: 888350, menuName: 'store_user_mobile', value: '0', status: 0 },
      ]);
      const env = { APP_KEY: KEY, UPSTASH_REDIS_URL: 'owned-only', UPSTASH_REDIS_TOKEN: 'owned-token',
        CONFIG_KV: { get: vi.fn(async (key: string) => {
          if (/^cfg_(?:wechat_app_|wechat_appid|wechat_appsecret|routine_)/u.test(key)) throw Error('Native account must use fresh SQL');
          return '0';
        }), put: vi.fn(), delete: vi.fn(async () => {}) } } as unknown as Env;
      const auth = new WechatAppAuthService(createContainerFromDb(app.db), env);
      const author = new AdminWechatAppService(createContainerFromDb(admin.db), env);
      const provider = { openid: 'native-pg-openid', unionid: 'owned-pg-union' } as {
        openid: string; unionid: string; beforeTokenReply?: () => Promise<void> };
      const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
        const url = new URL(String(input));
        expect(url.origin).toBe('https://api.weixin.qq.com');
        if (url.pathname.endsWith('/access_token')) {
          expect(url.searchParams.get('appid')).toBe(APP);
          await provider.beforeTokenReply?.();
          return Response.json({ access_token: 'owned-provider-token', expires_in: 7200, scope: 'snsapi_userinfo',
            openid: provider.openid, unionid: provider.unionid });
        }
        expect(url.pathname).toBe('/sns/userinfo');
        return Response.json({ openid: provider.openid, unionid: provider.unionid, nickname: 'Owned native profile', sex: 1 });
      });
      const rows = async () => ({ users: await f.db.select().from(user).orderBy(user.uid),
        associations: await f.db.select().from(wechatUser).orderBy(wechatUser.id) });
      await run({ f, app, admin, env, auth, author, network, provider, rows,
        start: () => auth.createState(IP),
        login: state => auth.login({ code: randomUUID(), state: state.state, verifier: state.verifier }, IP),
        owner: async (phone = '') => {
          await f.db.insert(user).values({ uid: OWNER, account: 'owned-prior-channel', pwd: md5('owned-password'), phone, status: 1 });
          await f.db.insert(wechatUser).values({ uid: OWNER, openid: 'prior-pg-wechat', unionid: 'owned-pg-union', userType: 'wechat' });
        },
        required: async () => { await f.db.update(systemConfig).set({ value: '1' }).where(eq(systemConfig.id, 888350)); },
      });
    }));
  } finally { await f.close(); }
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Native App OAuth actual commissioned PG16 identity publication', () => {
  afterEach(() => { vi.restoreAllMocks(); memory.beforeSms = undefined; });

  it('uses a true restricted App LOGIN with no system_config table or column writes to commit native SQL and a signed JWT', async () => fixture(async ctx => {
    const [identity] = await ctx.app.exec(`SELECT current_user AS role,session_user AS session,current_setting('server_version_num')::integer AS version,
      pg_backend_pid() AS pid,has_table_privilege(current_user,'public.system_config','SELECT') AS readable,
      has_table_privilege(current_user,'public.system_config','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS table_write,
      has_any_column_privilege(current_user,'public.system_config','INSERT,UPDATE,REFERENCES') AS column_write`);
    expect(identity).toMatchObject({ role: ctx.app.role, session: ctx.app.role, pid: ctx.app.pid,
      readable: true, table_write: false, column_write: false });
    expect(Math.floor(Number(identity.version) / 10000)).toBe(16);
    await expect(ctx.app.exec("UPDATE public.system_config SET value='forbidden' WHERE id=888349")).rejects.toMatchObject({ code: '42501' });
    await expect(ctx.app.db.transaction(tx => tx.execute(sql`LOCK TABLE public.system_config IN SHARE MODE`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    const result = await ctx.login(await ctx.start()); issued(result);
    expect(await verifyToken(result.token, ctx.env.APP_KEY)).toMatchObject({ id: result.uid, type: 'api' });
    expect(decodeJwt(result.token).nonce).toMatch(/^[a-f0-9-]{36}$/u);
    expect(await ctx.f.db.select().from(user).where(eq(user.uid, result.uid))).toMatchObject([{ userType: 'app', lastIp: IP }]);
    expect(await ctx.f.db.select().from(wechatUser).where(eq(wechatUser.openid, 'native-pg-openid')))
      .toMatchObject([{ uid: result.uid, userType: 'app', unionid: 'owned-pg-union' }]);
    expect(memory.buckets.has(md5(result.token))).toBe(true); expect(memory.effects).toEqual([result.uid]);
    expect(JSON.stringify(result)).not.toContain(SECRET); expect(JSON.stringify([...memory.values.values()])).not.toContain('owned-provider-token');
    expect(ctx.env.CONFIG_KV.put).not.toHaveBeenCalled();
  }), 180000);

  it('adds the exact App channel to an existing union UID and preserves the old channel even when phone binding is required', async () => fixture(async ctx => {
    await ctx.owner('13800138000'); await ctx.required();
    const prior = await ctx.f.db.select().from(wechatUser).where(eq(wechatUser.openid, 'prior-pg-wechat'));
    const beforeUsers = (await ctx.rows()).users.length;
    const result = await ctx.login(await ctx.start()); issued(result); expect(result.uid).toBe(OWNER);
    expect((await ctx.rows()).users).toHaveLength(beforeUsers);
    expect(await ctx.f.db.select().from(wechatUser).where(eq(wechatUser.openid, 'prior-pg-wechat'))).toEqual(prior);
    expect(await ctx.f.db.select().from(wechatUser).where(eq(wechatUser.openid, 'native-pg-openid')))
      .toMatchObject([{ uid: OWNER, userType: 'app', unionid: 'owned-pg-union' }]);
    expect(await verifyToken(result.token, ctx.env.APP_KEY)).toMatchObject({ id: OWNER }); expect(memory.sms).toEqual([]);
  }), 180000);

  it('does zero identity DML for phone-required pending then consumes independent SMS once and commits phone and exact App association atomically', async () => fixture(async ctx => {
    await ctx.owner(); await ctx.required(); const before = await ctx.rows(), state = await ctx.start();
    const value = await ctx.login(state); pending(value);
    expect(Object.keys(value).sort()).toEqual(['expiresIn', 'key', 'need_phone']);
    expect(await ctx.rows()).toEqual(before); expect(memory.buckets.size).toBe(0); expect(memory.effects).toEqual([]);
    const input = { key: value.key, verifier: state.verifier, phone: '13800138000', captcha: '123456' };
    await expect(ctx.auth.completePhone({ ...input, verifier: 'b'.repeat(64) }, IP)).rejects.toThrow('续绑凭据');
    expect(memory.sms).toEqual([]);
    memory.beforeSms = async () => { expect(await ctx.rows()).toEqual(before); expect(memory.buckets.size).toBe(0); };
    const result = await ctx.auth.completePhone(input, IP); issued(result); expect(result.uid).toBe(OWNER);
    expect(memory.sms).toEqual([['user_social_binding', input.phone, input.captcha]]);
    expect(await ctx.f.db.select().from(user).where(eq(user.uid, OWNER))).toMatchObject([{ phone: input.phone }]);
    expect(await ctx.f.db.select().from(wechatUser).where(eq(wechatUser.openid, 'native-pg-openid'))).toMatchObject([{ uid: OWNER, userType: 'app' }]);
    expect(await verifyToken(result.token, ctx.env.APP_KEY)).toMatchObject({ id: OWNER });
    await expect(ctx.auth.completePhone(input, IP)).rejects.toThrow('续绑凭据'); expect(memory.sms).toHaveLength(1);
  }), 180000);

  it('uses actual Admin author rotation after provider I/O to invalidate the in-flight login and older state and pending before SMS', async () => fixture(async ctx => {
    await ctx.required(); const oldState = await ctx.start(), pendingState = await ctx.start();
    const oldPending = await ctx.login(pendingState); pending(oldPending); const before = await ctx.rows();
    const rotation = save((await ctx.author.read(actor())).revision);
    const inFlight = await ctx.start();
    ctx.provider.beforeTokenReply = async () => {
      ctx.provider.beforeTokenReply = undefined;
      expect(await ctx.author.save(rotation, actor())).toMatchObject({ state: 'committed' });
    };
    await expect(ctx.login(inFlight)).rejects.toThrow('配置已变化');
    const callsAfterRotation = ctx.network.mock.calls.length;
    await expect(ctx.login(oldState)).rejects.toThrow('配置已变化');
    await expect(ctx.auth.completePhone({ key: oldPending.key, verifier: pendingState.verifier, phone: '13800138000', captcha: '123456' }, IP))
      .rejects.toThrow('配置已变化');
    expect(ctx.network).toHaveBeenCalledTimes(callsAfterRotation); expect(memory.sms).toEqual([]);
    expect(await ctx.rows()).toEqual(before); expect(memory.buckets.size).toBe(0);
    expect(await ctx.author.receipt(rotation.request_id, actor())).toMatchObject({ state: 'committed', request_id: rotation.request_id });
    expect((await readNativeAppCredentials(createContainerFromDb(ctx.app.db), ctx.env)).secret).toBe('owned-native-next-secret');
  }), 180000);

  it('refuses publication under an independent exclusive731664 owner and admits a fresh login after that owner releases', async () => fixture(async ctx => {
    const state = await ctx.start(), before = await ctx.rows();
    await ctx.admin.db.transaction(async tx => {
      const [held] = await tx.execute<{ pid: number; locked: boolean }>(sql`SELECT pg_backend_pid() AS pid,pg_try_advisory_xact_lock(731664,0) AS locked`);
      expect(held).toEqual({ pid: ctx.admin.pid, locked: true }); expect(held.pid).not.toBe(ctx.app.pid);
      await expect(ctx.login(state)).rejects.toThrow('配置正在维护');
      expect(await ctx.rows()).toEqual(before); expect(memory.buckets.size).toBe(0);
    });
    expect(ctx.network).toHaveBeenCalledTimes(2);
    const result = await ctx.login(await ctx.start()); issued(result);
    expect(await verifyToken(result.token, ctx.env.APP_KEY)).toMatchObject({ id: result.uid });
  }), 180000);

  it('holds the actual shared731664 fence through JWT issuance while independent shared and Open gates coexist and a real author cannot rotate', async () => fixture(async ctx => {
    const input = save((await ctx.author.read(actor())).revision), before = await ctx.f.db.select().from(systemConfig);
    const original = LoginService.prototype.loginByVerifiedUid;
    let observed = 0;
    vi.spyOn(LoginService.prototype, 'loginByVerifiedUid').mockImplementation(async function (this: LoginService, ...args) {
      const result = await original.apply(this, args);
      const bound = (this as unknown as { container: ReturnType<typeof createContainerFromDb> }).container;
      const [owner] = await bound.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      expect(owner.pid).toBe(ctx.app.pid); observed++;
      await ctx.admin.db.transaction(async tx => {
        const [locks] = await tx.execute<{ pid: number; exclusive: boolean; shared: boolean; open: boolean }>(sql`
          SELECT pg_backend_pid() AS pid,pg_try_advisory_xact_lock(731664,0) AS exclusive,
            pg_try_advisory_xact_lock_shared(731664,0) AS shared,pg_try_advisory_xact_lock(731661,0) AS open`);
        expect(locks).toEqual({ pid: ctx.admin.pid, exclusive: false, shared: true, open: true });
        expect(locks.pid).not.toBe(owner.pid);
      });
      await expect(ctx.author.save(input, actor())).rejects.toMatchObject({ code: 503 });
      return result;
    });
    const result = await ctx.login(await ctx.start()); issued(result); expect(observed).toBe(1);
    expect(await ctx.f.db.select().from(systemConfig)).toEqual(before);
    expect(await ctx.author.save(input, actor())).toMatchObject({ state: 'committed' });
    expect(memory.buckets.has(md5(result.token))).toBe(true);
  }), 180000);

  it('rolls back actual late identity and login SQL and revokes only the observed nonce bearer while preserving an earlier bearer', async () => fixture(async ctx => {
    await ctx.owner(); const first = await ctx.login(await ctx.start()); issued(first);
    const before = await ctx.rows(), effectsBefore = [...memory.effects];
    ctx.provider.openid = 'owned-late-new-openid'; ctx.provider.unionid = 'owned-late-new-union';
    const original = LoginService.prototype.loginByVerifiedUid; let lateToken = '';
    vi.spyOn(LoginService.prototype, 'loginByVerifiedUid').mockImplementation(async function (this: LoginService, ...args) {
      const result = await original.apply(this, args); lateToken = result.token;
      expect(memory.buckets.has(md5(lateToken))).toBe(true);
      expect(await verifyToken(lateToken, ctx.env.APP_KEY)).toMatchObject({ type: 'api' });
      throw Error('Owned late failure after actual bearer and login touch');
    });
    await expect(ctx.login(await ctx.start())).rejects.toThrow('Owned late failure');
    expect(lateToken).not.toBe(''); expect(lateToken).not.toBe(first.token);
    expect(decodeJwt(lateToken).nonce).not.toBe(decodeJwt(first.token).nonce);
    expect(await ctx.rows()).toEqual(before); expect(memory.effects).toEqual(effectsBefore);
    expect(memory.cleared).toEqual([md5(lateToken)]); expect([...memory.buckets.keys()]).toEqual([md5(first.token)]);
  }), 180000);

  it('consumes verified SMS but refuses distinct union and phone UIDs without merging or partially appending the App identity', async () => fixture(async ctx => {
    await ctx.owner(); await ctx.f.db.insert(user).values({ uid: OTHER, account: '13800138000', phone: '13800138000', status: 1 });
    await ctx.required(); const before = await ctx.rows(), state = await ctx.start(), value = await ctx.login(state); pending(value);
    expect(await ctx.rows()).toEqual(before);
    await expect(ctx.auth.completePhone({ key: value.key, verifier: state.verifier, phone: '13800138000', captcha: '123456' }, IP))
      .rejects.toThrow('不同账号');
    expect(memory.sms).toEqual([['user_social_binding', '13800138000', '123456']]);
    expect(await ctx.rows()).toEqual(before); expect(memory.buckets.size).toBe(0); expect(memory.effects).toEqual([]);
    expect(await ctx.f.db.select().from(wechatUser).where(eq(wechatUser.userType, 'app'))).toEqual([]);
  }), 180000);

  it('rejects App identities in old social_pending and generic login without borrowing native verifier or SQL authority', async () => fixture(async ctx => {
    const before = await ctx.rows(), oldKey = randomUUID();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(IP));
    const auditIp = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('').slice(0, 24);
    memory.values.set('social_pending:' + oldKey, { version: 1, issuedAt: Math.floor(Date.now() / 1000), auditIp,
      openid: 'native-pg-openid', unionid: 'owned-pg-union', userType: 'app' });
    const old = new WechatAuthService(createContainerFromDb(ctx.app.db), ctx.env);
    await expect(old.assertPendingIdentity(oldKey, IP)).rejects.toThrow('社交绑定凭据');
    await expect(old.completePendingPhoneBinding(oldKey, '13800138000', IP)).rejects.toThrow('社交绑定凭据');
    await expect(old.loginVerifiedIdentity({ openid: 'native-pg-openid', userType: 'app' }, IP)).rejects.toThrow('独立授权状态与凭据屏障');
    await expect(ctx.auth.completePhone({ key: oldKey, verifier: 'a'.repeat(64), phone: '13800138000', captcha: '123456' }, IP))
      .rejects.toThrow('续绑凭据');
    expect(await ctx.rows()).toEqual(before); expect(memory.sms).toEqual([]); expect(memory.buckets.size).toBe(0);
    expect(ctx.network).not.toHaveBeenCalled(); expect(memory.effects).toEqual([]);
  }), 180000);
});
