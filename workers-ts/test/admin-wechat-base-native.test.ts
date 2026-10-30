import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { qrcode, systemAdmin, systemConfig, systemMenus, systemRole } from '@/models/schema';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { runAdminWechatMenuUpgrade } from '@/migrations/runAdminWechatMenuUpgrade';
import { runAdminWechatBaseUpgrade } from '@/migrations/runAdminWechatBaseUpgrade';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { inspectAdminWechatBaseOperation } from '@/migrations/adminWechatBaseOperation';
import { AdminWechatBaseService } from '@/services/admin/AdminWechatBaseService';
import { OfficialAccountQrcodeService } from '@/services/wechat/OfficialAccountQrcodeService';
import { AdminPermissionService, canRetainOpaqueLegacyMenu } from '@/services/admin/AdminPermissionService';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { WECHAT_BASE_KEYS, type WechatBaseSave } from '../../view/common/wechatBase';

type F = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Peer = Parameters<NonNullable<F['withRuntimeRole']>>[0] extends (peer: infer R) => unknown ? R : never;
const PASSWORD = 'owned-base-test-password', KEY = 'owned-base-app-signing-key';
const ACTOR_EXPIRES = Math.floor(Date.now() / 1000) + 86400;
const actor = (id = 8870) => ({ id, authVersion: md5(PASSWORD), expiresAt: ACTOR_EXPIRES });
const roleRules = ['wechat_base.manage', 'wechat_base.view', 'config.manage,wechat_content.manage,wechat_menu.manage', '1362,315', '315', '1362', 'config.manage', 'config.view', ''];
const page = { id: 1362, pid: 69, type: 1, module: 'admin', controller: '', action: '', authType: 1,
  menuName: '公众号配置', menuPath: '/admin/app/wechat/base', uniqueAuth: 'app-wechat-base', apiUrl: '', methods: '' };
const saveSeed = { id: 315, pid: 23, type: 1, module: 'admin', controller: '', action: '', authType: 2,
  menuName: '保存配置', menuPath: '', uniqueAuth: '', apiUrl: 'setting/config/save_basics', methods: 'POST' };
async function fixture(run: (f: F, app: Peer, admin: Peer, names: { database: string; maintenance: string; app: string; admin: string; pricingOwner: string }) => Promise<void>) {
  const f = await refundRuntimeFixture();
  try {
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      const [row] = await f.exec('SELECT current_database() AS database,current_user AS maintenance');
      const names = { database: String(row.database), maintenance: String(row.maintenance), app: app.role, admin: admin.role, pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      await runAdminWechatMenuUpgrade(f.db, names);
      await f.db.insert(systemRole).values(roleRules.map((rules, index) => ({ id: 8870 + index, roleName: 'Owned base ' + index, rules })));
      await f.db.insert(systemAdmin).values(roleRules.map((_rules, index) => ({ id: 8870 + index, account: 'owned_base_' + index, pwd: PASSWORD, roles: String(8870 + index), level: index === 8 ? 0 : 1, adminType: 1 })));
      await f.db.delete(systemMenus).where(inArray(systemMenus.id, [1362, 315]));
      await f.db.insert(systemMenus).values([page, saveSeed]);
      try { await run(f, app, admin, names); }
      finally { await f.db.execute(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND usename=${app.role} AND application_name='cinashop_api' AND pid<>pg_backend_pid()`); }
    }));
  } finally { await f.close(); }
}
async function seed(f: F) {
  await f.db.delete(systemConfig).where(inArray(systemConfig.menuName, [...WECHAT_BASE_KEYS, 'site_url', 'api', 'wechat_base_callback_authority']));
  const values = ['wx1234567890abcdef', 'owned-original-secret', 'A'.repeat(43), 'OriginalToken', '0', '0', '0', '', '1'];
  const keys = ['wechat_appid', 'wechat_appsecret', 'wechat_encodingaeskey', 'wechat_token', 'wechat_encode', 'share_qrcode', 'spread_share_forever', 'wechat_qrcode', 'create_wechat_user'];
  await f.db.insert(systemConfig).values(keys.map((menuName, i) => ({ menuName, value: JSON.stringify(values[i]), isStore: 0, configTabId: 2,
    parameter: 'preserve-' + i, info: 'fixed-' + i, desc: 'source metadata', sort: 7, status: 1 })));
  await f.db.insert(systemConfig).values([{ menuName: 'site_url', value: '"https://owned.example.test"' }, { menuName: 'api', value: '"do-not-author-derived-row"' },
    { menuName: 'wechat_appsecret', value: '"owned-shadow-secret"', sort: -1 }, { menuName: 'wechat_appsecret', value: '"owned-store-secret"', isStore: 9 }]);
}
function intent(revision: string): WechatBaseSave {
  return { request_id: randomUUID(), revision, confirmed: true, database_callback: true,
    settings: { wechat_appid: 'wx1234567890abcdef', wechat_encode: 2, share_qrcode: 1, spread_share_forever: 1, wechat_qrcode: '', create_wechat_user: 0 },
    secrets: { wechat_appsecret: { action: 'replace', value: 'owned-replacement-secret' }, wechat_encodingaeskey: { action: 'keep' }, wechat_token: { action: 'replace', value: 'ReplacementToken' } } };
}
async function unrelated(db: DbClient) {
  const tables = await db.execute<{ tablename: string }>(sql`SELECT tablename FROM pg_tables WHERE schemaname='public'
    AND tablename NOT IN ('system_config','admin_wechat_base_operation') ORDER BY tablename`);
  const result: Record<string, unknown> = {};
  for (const { tablename } of tables) result[tablename] = Array.from(await db.execute(sql.raw(`SELECT to_jsonb(t) AS row FROM public."${tablename.replaceAll('"', '""')}" t ORDER BY to_jsonb(t)::text`)));
  result.sequences = Array.from(await db.execute(sql`SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' AND sequencename<>'system_config_id_seq' ORDER BY sequencename`));
  return result;
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('WeChat base actual commissioned PG16 LOGIN and production dual-prefix Hono', () => {
  afterEach(() => vi.restoreAllMocks());
  it('installs one immutable addon, saves all fixed fields without secret readback, replays and recovers owner requests', async () => fixture(async (f, app, admin, names) => {
    await seed(f);
    let cacheFails = false;
    const invalidated: string[] = [];
    const env = { HYPERDRIVE: { connectionString: app.connectionString }, HYPERDRIVE_ADMIN: { connectionString: admin.connectionString }, APP_KEY: KEY,
      UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', CONFIG_KV: { get: async () => 'poisoned-config-cache', delete: async (key: string) => { invalidated.push(key); if (cacheFails) throw Error('owned cache unavailable'); } } } as unknown as Env;
    const service = new AdminWechatBaseService(createContainerFromDb(admin.db), env);
    expect((await service.read(actor())).runtime_ready).toBe(false);
    await expect(service.save(intent((await service.read(actor())).revision), actor())).rejects.toMatchObject({ code: 503 });
    expect(await runAdminWechatBaseUpgrade(f.db, names)).toMatchObject({ applied: true });
    expect(await runAdminWechatBaseUpgrade(f.db, names)).toMatchObject({ applied: false });
    for (const [peer, kind] of [[app, 'app'], [admin, 'admin']] as const) expect(await auditRuntimeBusinessPrivileges(peer.db, kind, names)).toMatchObject({ ready: true, failures: [] });
    expect((await f.exec("SELECT count(*)::integer AS n FROM pg_tables WHERE schemaname='public'"))[0].n).toBe(285);
    for (const command of ['SELECT * FROM public.admin_wechat_base_operation', 'INSERT INTO public.admin_wechat_base_operation DEFAULT VALUES']) await expect(app.exec(command)).rejects.toMatchObject({ code: '42501' });
    for (const command of ['UPDATE public.admin_wechat_base_operation SET actor_id=1', 'DELETE FROM public.admin_wechat_base_operation', 'TRUNCATE public.admin_wechat_base_operation', 'ALTER TABLE public.admin_wechat_base_operation ADD COLUMN forbidden integer']) await expect(admin.exec(command)).rejects.toMatchObject({ code: '42501' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Base settings must not call external providers'));
    const http = createApp(), tokens = await Promise.all(roleRules.map(async (_rules, i) => (await createToken(8870 + i, 'admin', md5(PASSWORD), KEY)).token));
    const call = async (path: string, method = 'GET', body?: unknown, index = 0, raw?: string) => {
      const response = await http.request(path, { method, headers: { Authorization: 'Bearer ' + tokens[index], 'Content-Type': 'application/json' },
        ...(body === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(body) }) }, env);
      const text = await response.text(); expect(text).not.toMatch(/owned-(?:original|replacement|shadow|store)-secret|OriginalToken|ReplacementToken|A{43}/u);
      const data = JSON.parse(text) as { status: number; msg: string; data: any };
      await f.db.execute(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND usename=${app.role} AND application_name='cinashop_api' AND pid<>pg_backend_pid()`);
      return { ...data, headers: response.headers };
    };
    const before = await unrelated(f.db), rowsBefore = await f.db.select().from(systemConfig);
    const read = await call('/adminapi/wechat/base'); expect(read.status, read.msg).toBe(200);
    expect(read.headers.get('Cache-Control')).toBe('private, no-store');
    expect(read.data).toMatchObject({ runtime_ready: true, api: 'https://owned.example.test/api/wechat/serve', settings: { wechat_encode: 0, create_wechat_user: 1 }, secrets: { wechat_appsecret: { present: true, valid: true } }, callback: { authority: 'disabled', ready: false } });
    const save = intent(read.data.revision); cacheFails = true;
    const result = await call('/adminapi/wechat/base', 'POST', save); expect(result.status, result.msg).toBe(200);
    expect(result.data).toMatchObject({ request_id: save.request_id, actor_id: 8870, state: 'committed', replayed: false, cache_status: 'pending' });
    cacheFails = false;
    expect((await call('/api/admin/wechat/base', 'POST', save)).data).toMatchObject({ replayed: true, cache_status: 'cleared' });
    expect((await call('/api/admin/wechat/base/operations/' + save.request_id)).data.state).toBe('committed');
    expect((await call('/adminapi/wechat/base', 'POST', { ...save, settings: { ...save.settings, share_qrcode: 0 } })).status).toBe(409);
    const after = await call('/api/admin/setting/config/edit_new_build/wechat');
    expect(after.data).toMatchObject({ callback: { authority: 'database', ready: true, mode: 2 }, settings: save.settings });
    const persisted = await f.db.select().from(systemConfig);
    for (const original of rowsBefore) {
      const current = persisted.find(row => row.id === original.id)!;
      const { value: _oldValue, ...oldMeta } = original, { value: _newValue, ...newMeta } = current; expect(newMeta).toEqual(oldMeta);
      if (original.isStore !== 0 || original.sort === -1 || ['api', 'site_url'].includes(original.menuName)) expect(current).toEqual(original);
    }
    expect(persisted.find(row => row.menuName === 'wechat_appsecret' && row.sort === 7)?.value).toBe('"owned-replacement-secret"');
    expect(await unrelated(f.db)).toEqual(before);
    const receipts = await admin.exec('SELECT * FROM public.admin_wechat_base_operation'); expect(receipts).toHaveLength(1);
    expect(JSON.stringify(receipts)).not.toMatch(/owned-.*secret|ReplacementToken|A{43}/u);
    expect(Object.keys(receipts[0].result as object).sort()).toEqual(['revision', 'signature']);
    expect(invalidated).toContain('cfg_wechat_appsecret'); expect(fetch).not.toHaveBeenCalled();
    for (const prefix of ['/adminapi', '/api/admin']) {
      for (const index of [1, 5]) expect((await call(prefix + '/wechat/base', 'GET', undefined, index)).status).toBe(200);
      for (const index of [2, 4]) expect((await call(prefix + '/wechat/base', 'GET', undefined, index)).status).not.toBe(200);
      for (const index of [1, 2, 4, 5]) {
        expect((await call(prefix + '/wechat/base', 'POST', intent((await service.read(actor())).revision), index)).status).not.toBe(200);
        expect((await call(prefix + '/wechat/base/attachment-categories', 'GET', undefined, index)).status).not.toBe(200);
      }
      expect((await call(prefix + '/wechat/base/attachment-categories')).status).toBe(200);
      expect((await call(prefix + '/sms/config', 'POST', { sms_sign: 'ordinary', wechat_appsecret: 'owned-replacement-secret' })).status).not.toBe(200);
      const legacy = await call(prefix + '/wechat/base', 'GET', undefined, 3);
      expect((await call(prefix + '/setting/config/save_basics', 'POST', intent(legacy.data.revision), 3)).status).toBe(200);
      for (const raw of ['{bad', '[]', '{}'.padEnd(65537)]) expect((await call(prefix + '/wechat/base', 'POST', undefined, 0, raw)).status).not.toBe(200);
      expect((await call(prefix + '/setting/config/save_basics', 'POST', { wechat_appsecret: 'owned-replacement-secret' })).status).not.toBe(200);
    }
    // Generic config roles and level-zero administrators cannot bypass the
    // domain contract or retrieve its stored credential rows.
    const domain = [...WECHAT_BASE_KEYS, 'wechat_base_callback_authority'];
    for (const index of [4, 6, 7, 8]) {
      const listed = await call('/api/admin/config/list', 'GET', undefined, index); expect(listed.status, listed.msg).toBe(200);
      expect(listed.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
      expect(listed.data.some((row: { menuName: string }) => domain.includes(row.menuName))).toBe(false);
      for (const key of domain) for (const path of ['/adminapi/setting/config/', '/api/admin/config/']) expect((await call(path + key, 'GET', undefined, index)).status).not.toBe(200);
      expect((await call('/api/admin/config/site_url', 'GET', undefined, index)).data.value).toBe('poisoned-config-cache');
    }
    expect((await call('/api/admin/config/save', 'POST', { legacy_ordinary_setting: 'owned-legacy-normal-value' }, 4)).status).toBe(200);
    expect((await f.db.select().from(systemConfig).where(eq(systemConfig.menuName, 'legacy_ordinary_setting')))[0].value).toBe('owned-legacy-normal-value');
    const configBeforeBypass = await f.db.select().from(systemConfig);
    for (const index of [4, 6, 8]) for (const key of domain) expect((await call('/api/admin/config/save', 'POST', { site_name: 'must-not-write', [key]: 'owned-bypass-secret' }, index)).status).not.toBe(200);
    expect(await f.db.select().from(systemConfig)).toEqual(configBeforeBypass);
    const stale = intent((await service.read(actor())).revision);
    await f.db.update(systemConfig).set({ desc: 'changed shadow metadata' }).where(eq(systemConfig.sort, -1));
    await expect(service.save(stale, actor())).rejects.toMatchObject({ code: 409 });
    await expect(service.receipt(stale.request_id, actor())).rejects.toMatchObject({ code: 404 });
    await f.db.update(systemRole).set({ rules: '' }).where(eq(systemRole.id, 8870));
    expect((await call('/adminapi/wechat/base')).status).not.toBe(200);
    expect((await call('/adminapi/wechat/base/operations/' + save.request_id)).data.state).toBe('committed');
    expect((await call('/api/admin/wechat/base/operations/' + stale.request_id + '/resolve', 'POST', { confirmed: true })).data.state).toBe('not_applied');
    expect((await call('/adminapi/wechat/base/operations/' + stale.request_id, 'GET', undefined, 3)).status).not.toBe(200);
    await f.db.update(systemRole).set({ rules: 'wechat_base.manage' }).where(eq(systemRole.id, 8870));
    expect(await service.save(stale, actor())).toMatchObject({ state: 'not_applied', replayed: true });
    await f.db.update(systemAdmin).set({ pwd: 'owned-password-rotated' }).where(eq(systemAdmin.id, 8870));
    expect((await call('/adminapi/wechat/base/operations/' + save.request_id)).status).not.toBe(200);
    await expect(service.receipt(save.request_id, actor())).rejects.toBeDefined();
  }), 180000);

  it('protects the complete legacy tuple, rejects catalog drift and copied signed receipts, and leaves owner evidence immutable', async () => fixture(async (f, _app, admin, names) => {
    await seed(f); await runAdminWechatBaseUpgrade(f.db, names);
    const permissions = new AdminPermissionService(createContainerFromDb(admin.db));
    const resolved = async () => permissions.resolveManyRulePermissionKeys(['1362', '315', '1362,315']);
    const legacyResolved = await resolved();
    expect(legacyResolved[0]).toEqual(['wechat_base.view']);
    expect(legacyResolved[1]).toContain('config.manage'); expect(legacyResolved[1].some(key => key.startsWith('wechat_base.'))).toBe(false);
    expect(legacyResolved[2]).toEqual(expect.arrayContaining(['wechat_base.manage', 'wechat_base.view', 'config.manage']));
    expect(canRetainOpaqueLegacyMenu(page)).toBe(false); expect(canRetainOpaqueLegacyMenu(saveSeed)).toBe(false);
    for (const drift of [{ pid: 1 }, { type: 2 }, { module: 'supplier' }, { controller: 'config' }, { action: 'save' }, { authType: 2 }, { menuPath: '/content/wechat-base' }, { uniqueAuth: 'app-wechat-base ' }, { apiUrl: 'wechat/base' }, { methods: 'GET' }]) {
      await f.db.update(systemMenus).set(drift).where(eq(systemMenus.id, 1362));
      expect((await resolved())[2]).not.toContain('wechat_base.manage');
      await f.db.update(systemMenus).set(page).where(eq(systemMenus.id, 1362));
    }
    await f.db.insert(systemMenus).values({ ...page, id: 9991362 });
    expect((await permissions.resolveManyRulePermissionKeys(['9991362,315']))[0].some(key => key.startsWith('wechat_base.'))).toBe(false);
    const service = new AdminWechatBaseService(createContainerFromDb(admin.db), { APP_KEY: KEY, CONFIG_KV: { delete: async () => {} } } as unknown as Env);
    const operation = intent((await service.read(actor())).revision); await service.save(operation, actor());
    // Actual driver errors may include secret-bearing SQL params. Roll back all
    // config changes and expose only a generic recovery instruction.
    const baseline = await f.db.select().from(systemConfig);
    const failed = intent((await service.read(actor())).revision);
    failed.secrets.wechat_appsecret = { action: 'replace', value: 'owned-rollback-secret' };
    await f.exec(`ALTER TABLE public.system_config ADD CONSTRAINT owned_base_reject_secret CHECK(value <> '"owned-rollback-secret"')`);
    try {
      try { await service.save(failed, actor()); throw Error('Expected real SQL rejection'); }
      catch (error) { expect(error).toMatchObject({ code: 503 }); expect(error).not.toHaveProperty('cause'); expect(String(error)).not.toContain('owned-rollback-secret'); }
      expect(await f.db.select().from(systemConfig)).toEqual(baseline);
      await expect(service.receipt(failed.request_id, actor())).rejects.toMatchObject({ code: 404 });
    } finally { await f.exec('ALTER TABLE public.system_config DROP CONSTRAINT owned_base_reject_secret'); }
    // Existing tickets cannot silently acquire a different generating account.
    await f.db.insert(qrcode).values({ thirdType: 'wechatqrcode', thirdId: 887001, ticket: 'owned-historical-ticket', url: 'https://mp.weixin.qq.com/owned-old-code', status: 1 });
    const changeAccount = intent((await service.read(actor())).revision); changeAccount.settings.wechat_appid = 'wxabcdef1234567890';
    await expect(service.save(changeAccount, actor())).rejects.toMatchObject({ code: 409 });
    expect(await f.db.select().from(systemConfig)).toEqual(baseline);
    expect((await f.db.select().from(qrcode).where(eq(qrcode.thirdId, 887001)))[0].ticket).toBe('owned-historical-ticket');
    const copy = randomUUID();
    await f.db.execute(sql`INSERT INTO public.admin_wechat_base_operation SELECT ${copy}::uuid,actor_id,operation,format_version,payload_hash,revision,state,result,created_at FROM public.admin_wechat_base_operation WHERE operation_id=${operation.request_id}::uuid`);
    await expect(service.receipt(copy, actor())).rejects.toMatchObject({ code: 503 });
    for (const command of ['UPDATE public.admin_wechat_base_operation SET actor_id=actor_id', 'DELETE FROM public.admin_wechat_base_operation', 'TRUNCATE public.admin_wechat_base_operation']) await expect(f.exec(command)).rejects.toMatchObject({ code: '42501' });
    await expect(f.db.transaction(async tx => {
      await tx.execute(sql`ALTER TABLE public.admin_wechat_base_operation ADD COLUMN forbidden integer`);
      expect(await inspectAdminWechatBaseOperation(tx, names)).toBe(false); throw Error('Owned drift rollback');
    })).rejects.toThrow('Owned drift rollback');
    await expect(f.db.transaction(async tx => {
      await tx.execute(sql.raw(`GRANT SELECT ON public.admin_wechat_base_operation TO "${names.app}"`));
      expect(await inspectAdminWechatBaseOperation(tx, names)).toBe(false); throw Error('Owned ACL rollback');
    })).rejects.toThrow('Owned ACL rollback');
    expect(await inspectAdminWechatBaseOperation(f.db, names)).toBe(true);
  }), 180000);

  it('publishes permanent QR results through the actual SELECT-only-config App LOGIN and fences account-writer races without wider grants', async () => fixture(async (f, app, admin, names) => {
    await seed(f); await runAdminWechatBaseUpgrade(f.db, names);
    await expect(app.db.transaction(tx => tx.execute(sql`LOCK TABLE ONLY public.system_config IN SHARE MODE NOWAIT`))).rejects.toBeDefined();
    const cache = new Map<string, string>();
    const env = { APP_KEY: KEY, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
      CONFIG_KV: { get: async (key: string) => cache.get(key) ?? null, put: async (key: string, value: string) => { cache.set(key, value); }, delete: async (key: string) => { cache.delete(key); } } } as unknown as Env;
    const author = new AdminWechatBaseService(createContainerFromDb(admin.db), env);
    const transport: string[] = []; let rotate = false;
    const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input)); expect(url.origin).toBe('https://api.weixin.qq.com'); transport.push(url.pathname);
      if (url.pathname === '/cgi-bin/token') return Response.json({ access_token: 'owned-app-token', expires_in: 7200 });
      expect(url.pathname).toBe('/cgi-bin/qrcode/create');
      if (rotate) { rotate = false; const save = intent((await author.read(actor())).revision); await author.save(save, actor()); }
      return Response.json({ ticket: 'owned-app-ticket', url: 'https://weixin.qq.com/owned-provision', expire_seconds: 0 });
    });
    const qr = new OfficialAccountQrcodeService(createContainerFromDb(app.db), env, fetcher as typeof fetch);
    expect(await qr.processProvision({ action: 'provisionOfficialAccountQrcode', thirdType: 'reply', thirdId: 887010 })).toMatchObject({ status: 'ready', reused: false });
    const sends = transport.length;
    expect(await qr.processProvision({ action: 'provisionOfficialAccountQrcode', thirdType: 'reply', thirdId: 887010 })).toMatchObject({ status: 'ready', reused: true });
    expect(transport).toHaveLength(sends);
    rotate = true;
    await expect(qr.processProvision({ action: 'provisionOfficialAccountQrcode', thirdType: 'reply', thirdId: 887011 })).rejects.toThrow('配置已变化');
    expect((await f.db.select().from(qrcode).where(eq(qrcode.thirdId, 887011)))[0]).toMatchObject({ ticket: '', url: '', status: 0 });
    const input = intent((await author.read(actor())).revision), before = await f.db.select().from(systemConfig);
    await app.db.transaction(async tx => {
      expect((await tx.execute(sql`SELECT pg_try_advisory_xact_lock_shared(731659,0) AS locked`))[0].locked).toBe(true);
      await expect(author.save(input, actor())).rejects.toMatchObject({ code: 503 });
    });
    expect(await f.db.select().from(systemConfig)).toEqual(before);
    await admin.db.transaction(async tx => {
      expect((await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731659,0) AS locked`))[0].locked).toBe(true);
      await expect(qr.processProvision({ action: 'provisionOfficialAccountQrcode', thirdType: 'reply', thirdId: 887010 })).rejects.toBeDefined();
    });
    for (const [peer, kind] of [[app, 'app'], [admin, 'admin']] as const) expect(await auditRuntimeBusinessPrivileges(peer.db, kind, names)).toMatchObject({ ready: true, failures: [] });
    expect((await app.exec("SELECT has_table_privilege(current_user,'public.system_config','UPDATE,DELETE,TRUNCATE') AS can_mutate"))[0].can_mutate).toBe(false);
  }), 180000);
});
