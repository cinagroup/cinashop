import * as Cache from '@/utils/cache';
import { WechatOpenWebAuthService } from '@/services/wechat/WechatOpenWebAuthService';
import { readOpenPlatformCredentials } from '@/services/wechat/OpenPlatformRuntimeConfig';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { systemAdmin, systemConfig, systemMenus, systemRole, user, wechatUser } from '@/models/schema';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { runAdminWechatMenuUpgrade } from '@/migrations/runAdminWechatMenuUpgrade';
import { runAdminWechatBaseUpgrade } from '@/migrations/runAdminWechatBaseUpgrade';
import { runAdminWechatOpenUpgrade } from '@/migrations/runAdminWechatOpenUpgrade';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { inspectAdminWechatOpenOperation } from '@/migrations/adminWechatOpenOperation';
import { AdminWechatOpenService } from '@/services/admin/AdminWechatOpenService';
import { AdminPermissionService, canRetainOpaqueLegacyMenu } from '@/services/admin/AdminPermissionService';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { WECHAT_OPEN_KEYS, WECHAT_OPEN_AUTHORITY_KEY, type WechatOpenSave } from '../../view/common/wechatOpen';
type F = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Peer = Parameters<NonNullable<F['withRuntimeRole']>>[0] extends (peer: infer R) => unknown ? R : never;
const PASSWORD = 'owned-open-test-password', KEY = 'owned-open-app-signing-key', expiresAt = Math.floor(Date.now() / 1000) + 86400;
const actor = (id = 8890) => ({ id, authVersion: md5(PASSWORD), expiresAt });
const rules = ['wechat_open.manage', 'wechat_open.view', 'config.manage,wechat_base.manage', '1360,315', '315', '1360', 'config.manage', 'config.view', ''];
const page = { id: 1360, pid: 135, type: 1, module: 'admin', controller: '', action: '', authType: 1, isShow: 0, menuName: '微信开放平台',
  menuPath: '/admin/app/wechat_open', uniqueAuth: 'app-wechat-open', apiUrl: '', methods: '' };
const saveSeed = { id: 315, pid: 23, type: 1, module: 'admin', controller: '', action: '', authType: 2, menuName: '保存配置', menuPath: '', uniqueAuth: '', apiUrl: 'setting/config/save_basics', methods: 'POST' };
const domain = [...WECHAT_OPEN_KEYS, WECHAT_OPEN_AUTHORITY_KEY];
async function fixture(run: (f: F, app: Peer, admin: Peer, names: { database: string; maintenance: string; app: string; admin: string; pricingOwner: string }) => Promise<void>) {
  const f = await refundRuntimeFixture();
  try { await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
    const [row] = await f.exec('SELECT current_database() AS database,current_user AS maintenance');
    const names = { database: String(row.database), maintenance: String(row.maintenance), app: app.role, admin: admin.role, pricingOwner: f.pricingOwner };
    await runRuntimeBusinessCommissioning(f.db, names); await runAdminWechatMenuUpgrade(f.db, names); await runAdminWechatBaseUpgrade(f.db, names);
    await f.db.insert(systemRole).values(rules.map((rules, index) => ({ id: 8890 + index, roleName: 'Owned open ' + index, rules })));
    await f.db.insert(systemAdmin).values(rules.map((_rules, index) => ({ id: 8890 + index, account: 'owned_open_' + index, pwd: PASSWORD, roles: String(8890 + index), level: index === 8 ? 0 : 1, adminType: 1 })));
    await f.db.delete(systemMenus).where(inArray(systemMenus.id, [1360,315])); await f.db.insert(systemMenus).values([page, saveSeed]);
    try { await run(f, app, admin, names); } finally { await f.exec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND usename='${app.role.replaceAll("'", "''")}' AND application_name='cinashop_api' AND pid<>pg_backend_pid()`); }
  })); } finally { await f.close(); }
}
async function seed(f: F) {
  await f.db.delete(systemConfig).where(inArray(systemConfig.menuName, domain));
  await f.db.insert(systemConfig).values([
    { menuName: 'wechat_open_app_id', value: '"wx1234567890abcdef"', sort: 9, info: 'original-app-id', configTabId: 74, parameter: 'preserve' },
    { menuName: 'wechat_open_app_secret', value: '"owned-original-secret"', sort: 9, info: 'original-secret', configTabId: 74, parameter: 'preserve' },
    { menuName: 'wechat_open_app_secret', value: '"owned-shadow-secret"', sort: -1 },
    { menuName: 'wechat_open_app_secret', value: '"owned-store-secret"', isStore: 9 },
  ]);
}
const intent = (revision: string): WechatOpenSave => ({ request_id: randomUUID(), revision, confirmed: true, database_credentials: true,
  settings: { wechat_open_app_id: 'wx1234567890abcdef' }, secrets: { wechat_open_app_secret: { action: 'replace', value: 'owned-replacement-secret' } } });

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('WeChat open actual commissioned PG16 LOGIN and production dual-prefix Hono', () => {
  afterEach(() => vi.restoreAllMocks());
  it('commissions exact addon and atomically authors the complete two fields with durable secret-free recovery and dual legacy dispatch', async () => fixture(async (f, app, admin, names) => {
    await seed(f); let cacheFails = false; const invalidated: string[] = [];
    const env = { HYPERDRIVE: { connectionString: app.connectionString }, HYPERDRIVE_ADMIN: { connectionString: admin.connectionString }, APP_KEY: KEY, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
      CONFIG_KV: { get: async () => 'poisoned-config-cache', delete: async (key: string) => { invalidated.push(key); if (cacheFails) throw Error('owned cache unavailable'); } } } as unknown as Env;
    const service = new AdminWechatOpenService(createContainerFromDb(admin.db), env);
    expect((await service.read(actor())).runtime_ready).toBe(false);
    await expect(service.save(intent((await service.read(actor())).revision), actor())).rejects.toMatchObject({ code: 503 });
    expect(await runAdminWechatOpenUpgrade(f.db, names)).toMatchObject({ applied: true }); expect(await runAdminWechatOpenUpgrade(f.db, names)).toMatchObject({ applied: false });
    for (const [peer, kind] of [[app, 'app'], [admin, 'admin']] as const) expect(await auditRuntimeBusinessPrivileges(peer.db, kind, names)).toMatchObject({ ready: true, failures: [] });
    expect((await f.exec("SELECT count(*)::integer AS n FROM pg_tables WHERE schemaname='public'"))[0].n).toBe(286);
    for (const command of ['SELECT * FROM public.admin_wechat_open_operation', 'INSERT INTO public.admin_wechat_open_operation DEFAULT VALUES']) await expect(app.exec(command)).rejects.toMatchObject({ code: '42501' });
    for (const command of ['UPDATE public.admin_wechat_open_operation SET actor_id=1', 'DELETE FROM public.admin_wechat_open_operation', 'TRUNCATE public.admin_wechat_open_operation', 'ALTER TABLE public.admin_wechat_open_operation ADD COLUMN forbidden integer']) await expect(admin.exec(command)).rejects.toMatchObject({ code: '42501' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('settings must not call provider'));
    const http = createApp(), tokens = await Promise.all(rules.map(async (_rules, i) => (await createToken(8890 + i, 'admin', md5(PASSWORD), KEY)).token));
    const call = async (path: string, method = 'GET', body?: unknown, index = 0, raw?: string) => {
      const response = await http.request(path, { method, headers: { Authorization: 'Bearer ' + tokens[index], 'Content-Type': 'application/json' }, ...(body === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(body) }) }, env);
      const text = await response.text(); expect(text).not.toMatch(/owned-(?:original|replacement|shadow|store|bypass)-secret/u);
      const data = JSON.parse(text) as { status: number; msg: string; data: any };
      await f.db.execute(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND usename=${app.role} AND application_name='cinashop_api' AND pid<>pg_backend_pid()`);
      return { ...data, headers: response.headers };
    };
    const before = await f.db.select().from(systemConfig);
    const read = await call('/adminapi/wechat/open'); expect(read.status, read.msg).toBe(200); expect(read.headers.get('Cache-Control')).toBe('private, no-store');
    expect(read.data).toMatchObject({ runtime_ready: true, credentials: { authority: 'disabled', ready: false }, secrets: { wechat_open_app_secret: { present: true, valid: true } } });
    const save = intent(read.data.revision); cacheFails = true; const result = await call('/adminapi/wechat/open', 'POST', save);
    expect(result.status, result.msg).toBe(200); expect(result.data).toMatchObject({ request_id: save.request_id, state: 'committed', cache_status: 'pending', replayed: false });
    cacheFails = false; expect((await call('/api/admin/wechat/open', 'POST', save)).data).toMatchObject({ replayed: true, cache_status: 'cleared' });
    expect((await call('/api/admin/wechat/open/operations/' + save.request_id)).data.state).toBe('committed');
    expect((await call('/api/admin/wechat/open', 'POST', { ...save, database_credentials: false })).status).toBe(409);
    expect((await call('/api/admin/setting/config/edit_new_build/wxopen')).data).toMatchObject({ settings: save.settings, credentials: { authority: 'database', ready: true } });
    const persisted = await f.db.select().from(systemConfig);
    for (const original of before) { const current = persisted.find(row => row.id === original.id)!; const { value: _old, ...oldMeta } = original, { value: _new, ...newMeta } = current; expect(newMeta).toEqual(oldMeta); if (!domain.includes(original.menuName as typeof domain[number]) || original.isStore !== 0 || original.sort === -1) expect(current).toEqual(original); }
    const receipts = await admin.exec('SELECT * FROM public.admin_wechat_open_operation'); expect(receipts).toHaveLength(1); expect(JSON.stringify(receipts)).not.toContain('owned-replacement-secret'); expect(invalidated).toContain('cfg_wechat_open_app_secret'); expect(fetch).not.toHaveBeenCalled();
    for (const prefix of ['/adminapi','/api/admin']) {
      for (const index of [1,5]) expect((await call(prefix + '/wechat/open', 'GET', undefined, index)).status).toBe(200);
      for (const index of [2,4,6]) expect((await call(prefix + '/wechat/open', 'GET', undefined, index)).status).not.toBe(200);
      for (const index of [1,2,4,5,6]) expect((await call(prefix + '/wechat/open', 'POST', intent((await service.read(actor())).revision), index)).status).not.toBe(200);
      const legacy = await call(prefix + '/wechat/open', 'GET', undefined, 3); expect((await call(prefix + '/setting/config/save_basics', 'POST', intent(legacy.data.revision), 3)).status).toBe(200);
      expect((await call(prefix + '/setting/config/save_basics', 'POST', { wechat_open_app_secret: 'owned-bypass-secret' }, 3)).status).not.toBe(200);
      for (const raw of ['{bad','[]','{}'.padEnd(65537)]) expect((await call(prefix + '/wechat/open', 'POST', undefined, 0, raw)).status).not.toBe(200);
    }
    const baseline = await f.db.select().from(systemConfig);
    for (const index of [4,6,7,8]) { const list = await call('/api/admin/config/list', 'GET', undefined, index); expect(list.status, list.msg).toBe(200); expect(list.data.some((row: { menuName: string }) => domain.includes(row.menuName as typeof domain[number]))).toBe(false);
      for (const key of domain) for (const path of ['/adminapi/setting/config/','/api/admin/config/']) expect((await call(path + key, 'GET', undefined, index)).status).not.toBe(200);
    }
    for (const index of [4,6,8]) for (const key of domain) expect((await call('/api/admin/config/save', 'POST', { site_name: 'must-not-write', [key]: 'owned-bypass-secret' }, index)).status).not.toBe(200);
    expect(await f.db.select().from(systemConfig)).toEqual(baseline);
    const stale = intent((await service.read(actor())).revision); await f.db.update(systemConfig).set({ desc: 'shadow metadata changed' }).where(eq(systemConfig.sort, -1)); await expect(service.save(stale, actor())).rejects.toMatchObject({ code: 409 });
    await f.db.update(systemRole).set({ rules: '' }).where(eq(systemRole.id, 8890)); expect((await call('/adminapi/wechat/open')).status).not.toBe(200);
    expect((await call('/adminapi/wechat/open/operations/' + save.request_id)).data.state).toBe('committed');
    expect((await call('/api/admin/wechat/open/operations/' + stale.request_id + '/resolve', 'POST', { confirmed: true })).data.state).toBe('not_applied');
    expect((await call('/api/admin/wechat/open/operations/' + stale.request_id, 'GET', undefined, 3)).status).not.toBe(200);
    await f.db.update(systemRole).set({ rules: 'wechat_open.manage' }).where(eq(systemRole.id, 8890)); expect(await service.save(stale, actor())).toMatchObject({ state: 'not_applied', replayed: true });
    await f.db.update(systemAdmin).set({ pwd: 'rotated-password' }).where(eq(systemAdmin.id, 8890)); await expect(service.receipt(save.request_id, actor())).rejects.toBeDefined();
  }), 180000);
  it('rejects full seed drift, generic fallback, half-pair deployment rotation, SQL errors and copied immutable evidence', async () => fixture(async (f, app, admin, names) => {
    await seed(f); await runAdminWechatOpenUpgrade(f.db, names);
    const permissions = new AdminPermissionService(createContainerFromDb(admin.db)), resolved = async () => permissions.resolveManyRulePermissionKeys(['1360','315','1360,315']);
    expect((await resolved())[0]).toEqual(['wechat_open.view']); expect((await resolved())[1]).not.toContain('wechat_open.manage'); expect((await resolved())[2]).toContain('wechat_open.manage');
    expect(canRetainOpaqueLegacyMenu(page)).toBe(false);
    for (const drift of [{ pid: 1 },{ type: 2 },{ module: 'supplier' },{ controller: 'config' },{ action: 'save' },{ authType: 2 },{ menuPath: '/content/wechat-open' },{ uniqueAuth: 'app-wechat-open ' },{ apiUrl: 'wechat/open' },{ methods: 'GET' }]) { await f.db.update(systemMenus).set(drift).where(eq(systemMenus.id,1360)); expect((await resolved())[2]).not.toContain('wechat_open.manage'); await f.db.update(systemMenus).set(page).where(eq(systemMenus.id,1360)); }
    for (const drift of [{ pid: 1 },{ type: 2 },{ module: 'supplier' },{ controller: 'config' },{ action: 'save' },{ authType: 1 },{ menuPath: '/content/wechat-open' },{ uniqueAuth: 'wechat_open.manage' },{ apiUrl: 'wechat/open' },{ methods: 'PUT' }]) { await f.db.update(systemMenus).set(drift).where(eq(systemMenus.id,315)); expect((await resolved())[2]).not.toContain('wechat_open.manage'); await f.db.update(systemMenus).set(saveSeed).where(eq(systemMenus.id,315)); }
    await f.db.insert(systemMenus).values({ ...saveSeed, id: 999315 }); expect((await permissions.resolveManyRulePermissionKeys(['1360,999315']))[0]).not.toContain('wechat_open.manage');
    await f.db.insert(systemMenus).values({ ...page, id: 9991360, isShow: 1 }); expect((await permissions.resolveManyRulePermissionKeys(['9991360,315']))[0].some(key => key.startsWith('wechat_open.'))).toBe(false);
    const env = { APP_KEY: KEY, CONFIG_KV: { delete: async () => {} } } as unknown as Env, service = new AdminWechatOpenService(createContainerFromDb(admin.db), env);
    const baseline = await f.db.select().from(systemConfig), failed = intent((await service.read(actor())).revision); failed.settings.wechat_open_app_id = 'wxabcdef1234567890'; failed.secrets.wechat_open_app_secret = { action: 'replace', value: 'owned-rollback-secret' };
    await f.exec(`ALTER TABLE public.system_config ADD CONSTRAINT owned_open_reject_secret CHECK(value <> '"owned-rollback-secret"')`);
    try { try { await service.save(failed, actor()); throw Error('Expected SQL rejection'); } catch (error) { expect(error).toMatchObject({ code: 503 }); expect(error).not.toHaveProperty('cause'); expect(String(error)).not.toContain('owned-rollback-secret'); } expect(await f.db.select().from(systemConfig)).toEqual(baseline); await expect(service.receipt(failed.request_id, actor())).rejects.toMatchObject({ code: 404 }); } finally { await f.exec('ALTER TABLE public.system_config DROP CONSTRAINT owned_open_reject_secret'); }
    const incompleteRotation = intent((await service.read(actor())).revision); incompleteRotation.settings.wechat_open_app_id = 'wxabcdef1234567890'; incompleteRotation.secrets.wechat_open_app_secret = { action: 'keep' };
    await expect(service.save(incompleteRotation, actor())).rejects.toMatchObject({ code: 400 }); expect(await f.db.select().from(systemConfig)).toEqual(baseline);
    const deployed = new AdminWechatOpenService(createContainerFromDb(admin.db), { ...env, WECHAT_OPEN_APP_SECRET: 'owned-deployment-secret' });
    const rotation = intent((await deployed.read(actor())).revision); rotation.settings.wechat_open_app_id = 'wxabcdef1234567890'; await expect(deployed.save(rotation, actor())).rejects.toMatchObject({ code: 409 });
    await app.db.transaction(async tx => { await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(731661,0)`); await expect(service.save(intent((await service.read(actor())).revision), actor())).rejects.toMatchObject({ code: 503 }); });
    const save = intent((await service.read(actor())).revision); await service.save(save, actor());
    await f.db.update(systemConfig).set({ value: '"wx123456"' }).where(eq(systemConfig.menuName, 'wechat_open_app_id'));
    expect((await service.read(actor())).credentials).toMatchObject({ authority: 'database', ready: false });
    await expect(readOpenPlatformCredentials(createContainerFromDb(app.db), env)).rejects.toMatchObject({ code: 503 });
    await f.db.update(systemConfig).set({ value: '"wx1234567890abcdef"' }).where(eq(systemConfig.menuName, 'wechat_open_app_id'));
    const copy = randomUUID(); await f.db.execute(sql`INSERT INTO public.admin_wechat_open_operation SELECT ${copy}::uuid,actor_id,operation,format_version,payload_hash,revision,state,result,created_at FROM public.admin_wechat_open_operation WHERE operation_id=${save.request_id}::uuid`); await expect(service.receipt(copy, actor())).rejects.toMatchObject({ code: 503 });
    for (const command of ['UPDATE public.admin_wechat_open_operation SET actor_id=1','DELETE FROM public.admin_wechat_open_operation','TRUNCATE public.admin_wechat_open_operation']) await expect(f.exec(command)).rejects.toMatchObject({ code: '42501' });
    await f.exec('ALTER TABLE public.admin_wechat_open_operation ADD COLUMN owned_drift integer'); expect(await inspectAdminWechatOpenOperation(f.db)).toBe(false); await expect(runAdminWechatOpenUpgrade(f.db,names)).rejects.toBeDefined();
  }), 180000);
  it('uses actual App LOGIN OAuth and mature identity SAVEPOINTs behind the same independent-session rotation barrier', async () => fixture(async (f, app, admin, names) => {
    await seed(f); await runAdminWechatOpenUpgrade(f.db, names);
    const env = { APP_KEY: KEY, CONFIG_KV: { get: async () => '0', put: async () => {}, delete: async () => {} } } as unknown as Env;
    const author = new AdminWechatOpenService(createContainerFromDb(admin.db), env), appContainer = createContainerFromDb(app.db);
    await author.save(intent((await author.read(actor())).revision), actor());
    expect(await readOpenPlatformCredentials(appContainer, env)).toMatchObject({ appId: 'wx1234567890abcdef', secret: 'owned-replacement-secret', authority: 'database' });
    const values = new Map<string, unknown>(), buckets = new Map<string, unknown>(), cleared: string[] = [];
    vi.spyOn(Cache, 'getRedis').mockReturnValue({ eval: async () => 1 } as never);
    vi.spyOn(Cache, 'cacheSetIfAbsent').mockImplementation(async (key, value) => { if (values.has(key)) return false; values.set(key, value); return true; });
    vi.spyOn(Cache, 'cacheTake').mockImplementation(async key => { const value = values.get(key) ?? null; values.delete(key); return value as never; });
    vi.spyOn(Cache, 'clearToken').mockImplementation(async key => { cleared.push(key); return buckets.delete(key); });
    const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
    let providerPause: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null = null;
    let bucketPause: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null = null;
    let bucketFault = false, suffix = 'first';
    vi.spyOn(Cache, 'setTokenBucket').mockImplementation(async (key, bucket) => {
      buckets.set(key, bucket); if (bucketPause) { bucketPause.entered.resolve(); await bucketPause.release.promise; }
      if (bucketFault) throw Error('owned native bucket lost ACK'); return true;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const token = new URL(String(input)).pathname.endsWith('/access_token');
      if (token && providerPause) { providerPause.entered.resolve(); await providerPause.release.promise; }
      return Response.json(token ? { access_token: 'owned-native-access', openid: 'native-open-' + suffix, unionid: 'native-union-' + suffix }
        : { unionid: 'native-union-' + suffix, nickname: 'Native Open ' + suffix, sex: 1 });
    });
    async function start() { const service = new WechatOpenWebAuthService(appContainer, env), state = await service.createOauthState('pc_user', '127.0.0.1', 'https://owned.example.test');
      return { state, login: () => service.login('pc_user', randomUUID(), state.state, state.verifier, '127.0.0.1') }; }
    // No account/table lock is held across provider network I/O: rotation can
    // commit, and the late old response is then rejected before any identity.
    providerPause = { entered: deferred(), release: deferred() }; const old = await start(), oldLogin = old.login();
    const oldOutcome = expect(oldLogin).rejects.toMatchObject({ code: 400 });
    await providerPause.entered.promise;
    const change = intent((await author.read(actor())).revision); change.settings.wechat_open_app_id = 'wxabcdef1234567890'; change.secrets.wechat_open_app_secret = { action: 'replace', value: 'owned-rotated-secret' };
    try { await author.save(change, actor()); } finally { providerPause.release.resolve(); }
    await oldOutcome; providerPause = null;
    expect(await f.db.select().from(wechatUser).where(eq(wechatUser.openid,'native-open-first'))).toHaveLength(0);
    expect(buckets.size).toBe(0);
    // Actual mature reconcile and login run in App's outer transaction. While
    // its token bucket awaits ACK, another independent Admin cannot rotate.
    suffix = 'committed'; bucketPause = { entered: deferred(), release: deferred() }; const live = await start(), publishing = live.login();
    await bucketPause.entered.promise;
    try { await expect(author.save(intent((await author.read(actor())).revision), actor())).rejects.toMatchObject({ code: 503 }); }
    finally { bucketPause.release.resolve(); }
    const result = await publishing; bucketPause = null;
    expect(live.state.appId).toBe('wxabcdef1234567890');
    expect(result.token).toBeTruthy(); expect(buckets.has(md5(result.token))).toBe(true);
    const identity = await f.db.select().from(wechatUser).where(eq(wechatUser.openid, 'native-open-committed')); expect(identity).toHaveLength(1);
    expect(await f.db.select().from(user).where(eq(user.uid,identity[0].uid))).toHaveLength(1);
    // Opposite lock direction: Admin is already rotating; provider calls may
    // finish but the final App identity transaction must fail before issuing.
    suffix = 'blocked'; const blocked = await start();
    await admin.db.transaction(async tx => { await tx.execute(sql`SELECT pg_advisory_xact_lock(731661,0)`); await expect(blocked.login()).rejects.toMatchObject({ code: 503 }); });
    expect(await f.db.select().from(wechatUser).where(eq(wechatUser.openid,'native-open-blocked'))).toHaveLength(0);
    // A real token bucket write followed by lost ACK cannot leave a new SQL
    // user/identity behind or revoke the successful, nonce-distinct old token.
    suffix = 'rollback'; bucketFault = true; await expect((await start()).login()).rejects.toThrow('owned native bucket lost ACK');
    expect(await f.db.select().from(wechatUser).where(eq(wechatUser.openid,'native-open-rollback'))).toHaveLength(0);
    expect(await f.db.select().from(user).where(eq(user.nickname,'Native Open rollback'))).toHaveLength(0);
    expect(cleared).toHaveLength(1); expect(buckets.size).toBe(1); expect(buckets.has(md5(result.token))).toBe(true);
  }), 180000);

});
