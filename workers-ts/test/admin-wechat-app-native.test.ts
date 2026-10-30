import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { systemAdmin, systemConfig, systemMenus, systemRole } from '@/models/schema';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { runAdminWechatAppUpgrade } from '@/migrations/runAdminWechatAppUpgrade';
import { inspectAdminWechatAppOperation } from '@/migrations/adminWechatAppOperation';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { AdminWechatAppService } from '@/services/admin/AdminWechatAppService';
import { AdminPermissionService, canRetainOpaqueLegacyMenu, requiredAdminPermission } from '@/services/admin/AdminPermissionService';
import { WECHAT_APP_VIEW_SEED, WECHAT_APP_SAVE_SEED } from '@/services/admin/AdminWechatAppPermissionBinding';
import { WECHAT_APP_INSERT_METADATA } from '@/services/admin/AdminWechatAppMetadata';
import { md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import type { WechatAppSave } from '../../view/common/wechatApp';

type F = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Peer = Parameters<NonNullable<F['withRuntimeRole']>>[0] extends (peer: infer R) => unknown ? R : never;
const PASSWORD = 'owned-native-app-admin', KEY = 'owned-native-app-signing-key';
const expiresAt = Math.floor(Date.now() / 1000) + 86400;
const actor = (id = 8890) => ({ id, authVersion: md5(PASSWORD), expiresAt });
const request = (revision: string): WechatAppSave => ({ request_id: randomUUID(), revision, confirmed: true,
  fields: { wechat_app_appid: { action: 'keep' }, wechat_app_appsecret: { action: 'keep' } } });
const rules = ['1379,315', '1379', '315', 'config.manage', 'wechat_app.manage', 'wechat_app.view', ''];
const domain = ['wechat_app_appid', 'wechat_app_appsecret'];
async function fixture(run: (f: F, app: Peer, admin: Peer, names: { database: string; maintenance: string; app: string; admin: string; pricingOwner: string }, env: Env) => Promise<void>) {
  const f = await refundRuntimeFixture();
  try { await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
    const [row] = await f.exec('SELECT current_database() AS database,current_user AS maintenance');
    const names = { database: String(row.database), maintenance: String(row.maintenance), app: app.role, admin: admin.role, pricingOwner: f.pricingOwner };
    await runRuntimeBusinessCommissioning(f.db, names);
    await f.db.insert(systemRole).values(rules.map((rules, index) => ({ id: 8890 + index, roleName: 'Owned native App ' + index, rules })));
    await f.db.insert(systemAdmin).values(rules.map((_rules, index) => ({ id: 8890 + index, account: 'owned_native_app_' + index, pwd: PASSWORD, roles: String(8890 + index), level: 1, adminType: 1 })));
    await f.db.delete(systemMenus).where(inArray(systemMenus.id, [1379, 315]));
    await f.db.insert(systemMenus).values([{ ...WECHAT_APP_VIEW_SEED, menuName: '移动应用' }, { ...WECHAT_APP_SAVE_SEED, menuName: '保存配置' }]);
    await f.db.delete(systemConfig).where(inArray(systemConfig.menuName, domain));
    await f.db.insert(systemConfig).values([
      { id: 348, menuName: domain[0], value: '"owned-native-app-id"', sort: 5, configTabId: 73, info: 'original AppID', parameter: 'original-metadata' },
      { id: 349, menuName: domain[1], value: '"owned-native-app-secret"', sort: 5, configTabId: 73, info: 'original Secret', parameter: 'original-metadata' },
      { id: 350, menuName: domain[1], value: '"owned-native-app-shadow"', sort: -1, configTabId: 99 },
      { id: 351, menuName: domain[1], value: '"owned-native-app-store"', sort: 100, isStore: 4 },
    ]);
    const env = { APP_KEY: KEY, CONFIG_KV: { get: vi.fn(async () => { throw Error('No cached native account'); }), put: vi.fn(), delete: vi.fn(async () => {}) } } as unknown as Env;
    await run(f, app, admin, names, env);
  })); } finally { await f.close(); }
}
const service = (admin: Peer, env: Env) => new AdminWechatAppService(createContainerFromDb(admin.db), env);

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Native App unexposed author actual commissioned PG16 roles', () => {
  afterEach(() => vi.restoreAllMocks());
  it('requires separately commissioned exact immutable receipt catalog and least privilege', async () => fixture(async (f, app, admin, names, env) => {
    const author = service(admin, env), before = await author.read(actor());
    expect(before.runtime_ready).toBe(false);
    await expect(author.save(request(before.revision), actor())).rejects.toMatchObject({ code: 503 });
    expect(await runAdminWechatAppUpgrade(f.db, names)).toMatchObject({ applied: true });
    expect(await runAdminWechatAppUpgrade(f.db, names)).toMatchObject({ applied: false });
    for (const [peer, kind] of [[app, 'app'], [admin, 'admin']] as const)
      expect(await auditRuntimeBusinessPrivileges(peer.db, kind, names)).toMatchObject({ ready: true, failures: [] });
    for (const command of ['SELECT * FROM public.admin_wechat_app_operation', 'INSERT INTO public.admin_wechat_app_operation DEFAULT VALUES'])
      await expect(app.exec(command)).rejects.toMatchObject({ code: '42501' });
    for (const command of ['UPDATE public.admin_wechat_app_operation SET actor_id=1', 'DELETE FROM public.admin_wechat_app_operation', 'TRUNCATE public.admin_wechat_app_operation', 'ALTER TABLE public.admin_wechat_app_operation ADD COLUMN forbidden integer'])
      await expect(admin.exec(command)).rejects.toMatchObject({ code: '42501' });
    expect((await author.read(actor())).runtime_ready).toBe(true);
  }), 180000);

  it('returns source-bound public text and secret presence without caching, provider I/O or read-side DML', async () => fixture(async (f, _app, admin, names, env) => {
    await runAdminWechatAppUpgrade(f.db, names);
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('author never calls provider'));
    const before = await f.db.select().from(systemConfig), snapshot = await service(admin, env).read(actor());
    expect(snapshot).toMatchObject({ settings: { wechat_app_appid: 'owned-native-app-id' },
      fields: { wechat_app_appid: { present: true, parseable: true }, wechat_app_appsecret: { present: true, parseable: true } },
      secrets: { wechat_app_appsecret: { present: true } }, credentials_complete: true });
    expect(JSON.stringify(snapshot)).not.toMatch(/owned-native-app-(?:secret|shadow|store)/u);
    expect(await f.db.select().from(systemConfig)).toEqual(before);
    expect(network).not.toHaveBeenCalled(); expect(env.CONFIG_KV.get).not.toHaveBeenCalled(); expect(env.CONFIG_KV.put).not.toHaveBeenCalled();
    expect((await service(admin, env).read(actor(8891))).revision).not.toBe(snapshot.revision);
  }), 180000);

  it('keeps malformed/missing rows exactly, and writes a durable secret-free no-op receipt', async () => fixture(async (f, _app, admin, names, env) => {
    await runAdminWechatAppUpgrade(f.db, names);
    await f.db.delete(systemConfig).where(eq(systemConfig.id, 348));
    await f.db.update(systemConfig).set({ value: '{malformed-secret' }).where(eq(systemConfig.id, 349));
    const author = service(admin, env), before = await f.db.select().from(systemConfig), snapshot = await author.read(actor());
    expect(snapshot).toMatchObject({ settings: { wechat_app_appid: null }, credentials_complete: false,
      fields: { wechat_app_appid: { present: false, parseable: false }, wechat_app_appsecret: { present: true, parseable: false } } });
    const input = request(snapshot.revision); expect(await author.save(input, actor())).toMatchObject({ state: 'committed', replayed: false });
    expect(await f.db.select().from(systemConfig)).toEqual(before);
    const rows = await admin.exec('SELECT * FROM public.admin_wechat_app_operation');
    expect(rows).toHaveLength(1); expect(JSON.stringify(rows)).not.toMatch(/malformed|native-app-secret|native-app-shadow|native-app-store/u);
    expect(await author.save(input, actor())).toMatchObject({ replayed: true });
  }), 180000);

  it('replaces/clears only the explicit winner and preserves every existing metadata/shadow/store field', async () => fixture(async (f, _app, admin, names, env) => {
    await runAdminWechatAppUpgrade(f.db, names);
    const author = service(admin, env), before = await f.db.select().from(systemConfig);
    const input = request((await author.read(actor())).revision);
    input.fields.wechat_app_appsecret = { action: 'replace', value: ' s'.repeat(300) + '\n' };
    expect(await author.save(input, actor())).toMatchObject({ state: 'committed', cache_status: 'cleared' });
    const after = await f.db.select().from(systemConfig);
    for (const old of before) {
      const next = after.find(row => row.id === old.id)!;
      if (old.id !== 349) expect(next).toEqual(old);
      else { const { value: _a, ...oldMeta } = old, { value: _b, ...newMeta } = next; expect(newMeta).toEqual(oldMeta); expect(JSON.parse(next.value!)).toBe(' s'.repeat(300) + '\n'); }
    }
    const clear = request((await author.read(actor())).revision); clear.fields.wechat_app_appsecret = { action: 'clear' };
    await author.save(clear, actor()); expect((await author.read(actor())).secrets.wechat_app_appsecret.present).toBe(false);
    expect(env.CONFIG_KV.delete).toHaveBeenCalledWith('cfg_wechat_app_appsecret');
    expect(env.CONFIG_KV.delete).not.toHaveBeenCalledWith('cfg_wechat_open_app_secret');
  }), 180000);

  it('inserts a deliberately missing Secret with all fixed PHP tab73 metadata and an owned sequence identity', async () => fixture(async (f, _app, admin, names, env) => {
    await runAdminWechatAppUpgrade(f.db, names);
    await f.db.delete(systemConfig).where(eq(systemConfig.menuName, domain[1]));
    const author = service(admin, env), input = request((await author.read(actor())).revision);
    input.fields.wechat_app_appsecret = { action: 'replace', value: 'owned-new-secret' };
    await author.save(input, actor());
    const rows = await f.db.select().from(systemConfig).where(eq(systemConfig.menuName, domain[1]));
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ ...WECHAT_APP_INSERT_METADATA.wechat_app_appsecret, isStore: 0, value: '"owned-new-secret"' });
    expect(rows[0].id).toBeGreaterThan(0); expect(rows[0].id).not.toBe(349);
  }), 180000);

  it('rejects shadow source drift, atomically retains App account history and rolls back SQL failure', async () => fixture(async (f, _app, admin, names, env) => {
    await runAdminWechatAppUpgrade(f.db, names);
    const author = service(admin, env), stale = request((await author.read(actor())).revision);
    await f.db.update(systemConfig).set({ desc: 'shadow changed' }).where(eq(systemConfig.id, 350));
    await expect(author.save(stale, actor())).rejects.toMatchObject({ code: 409 });
    const rotation = request((await author.read(actor())).revision); rotation.fields.wechat_app_appid = { action: 'replace', value: 'another-app-id' };
    expect(await author.save(rotation, actor())).toMatchObject({ state: 'committed' });
    expect((await author.read(actor())).settings.wechat_app_appid).toBe('another-app-id');
    const history = await admin.exec('SELECT app_id,mch_id FROM public.native_app_payment_account');
    expect(history.map(row => JSON.parse(String(row.app_id))).sort()).toEqual(['another-app-id','owned-native-app-id']);
    const before = await f.db.select().from(systemConfig);
    const failed = request((await author.read(actor())).revision); failed.fields.wechat_app_appsecret = { action: 'replace', value: 'owned-rejected-secret' };
    await f.exec(`ALTER TABLE public.system_config ADD CONSTRAINT owned_app_reject_secret CHECK(value <> '"owned-rejected-secret"')`);
    try {
      try { await author.save(failed, actor()); throw Error('expected SQL rejection'); }
      catch (error) { expect(error).toMatchObject({ code: 503 }); expect(error).not.toHaveProperty('cause'); expect(String(error)).not.toContain('owned-rejected-secret'); }
      expect(await f.db.select().from(systemConfig)).toEqual(before);
      await expect(author.receipt(failed.request_id, actor())).rejects.toMatchObject({ code: 404 });
    } finally { await f.exec('ALTER TABLE public.system_config DROP CONSTRAINT owned_app_reject_secret'); }
  }), 180000);

  it('recovers only live owner receipts after domain permission loss and seals absent requests without config writes', async () => fixture(async (f, _app, admin, names, env) => {
    await runAdminWechatAppUpgrade(f.db, names); const author = service(admin, env);
    const input = request((await author.read(actor())).revision); await author.save(input, actor());
    await f.db.update(systemRole).set({ rules: '' }).where(eq(systemRole.id, 8890));
    await expect(author.read(actor())).rejects.toBeDefined();
    expect(await author.receipt(input.request_id, actor())).toMatchObject({ state: 'committed', replayed: true });
    const before = await f.db.select().from(systemConfig), absent = randomUUID();
    expect(await author.resolve(absent, { confirmed: true }, actor())).toMatchObject({ state: 'not_applied', replayed: false });
    expect(await f.db.select().from(systemConfig)).toEqual(before);
    await expect(author.receipt(input.request_id, actor(8891))).rejects.toMatchObject({ code: 409 });
    await f.db.update(systemRole).set({ rules: '1379,315' }).where(eq(systemRole.id, 8890));
    expect(await author.save({ ...input, request_id: absent }, actor())).toMatchObject({ state: 'not_applied', replayed: true });
    await f.db.update(systemAdmin).set({ pwd: 'changed-password' }).where(eq(systemAdmin.id, 8890));
    await expect(author.receipt(input.request_id, actor())).rejects.toBeDefined();
  }), 180000);

  it('binds the whole numerical1379/315 selection, protects copies, and preserves shared315 permissions', async () => fixture(async (f, _app, admin, _names, _env) => {
    const permissions = new AdminPermissionService(createContainerFromDb(admin.db));
    const resolve = () => permissions.resolveManyRulePermissionKeys(['1379', '315', '1379,315']);
    expect(await resolve()).toEqual([['wechat_app.view'], ['config.manage', 'config.view'], expect.arrayContaining(['wechat_app.view', 'wechat_app.manage', 'config.manage', 'config.view'])]);
    expect(await permissions.resolveRulePermissionKeys('1379,315')).toEqual((await resolve())[2]);
    expect(canRetainOpaqueLegacyMenu(WECHAT_APP_VIEW_SEED)).toBe(false);
    for (const drift of [{ pid: 1 }, { type: 2 }, { module: 'supplier' }, { controller: 'config' }, { action: 'save' }, { authType: 2 }, { menuPath: '/content/wechat-app' }, { uniqueAuth: 'app-app ' }, { apiUrl: 'wechat/app' }, { methods: 'GET' }]) {
      await f.db.update(systemMenus).set(drift).where(eq(systemMenus.id, 1379));
      expect((await resolve())[2]).not.toContain('wechat_app.manage');
      await f.db.update(systemMenus).set(WECHAT_APP_VIEW_SEED).where(eq(systemMenus.id, 1379));
    }
    await f.db.insert(systemMenus).values({ ...WECHAT_APP_VIEW_SEED, id: 991379, menuName: 'copy' });
    expect(await permissions.resolveRulePermissionKeys('991379,315')).not.toContain('wechat_app.view');
    for (const prefix of ['/api/admin/', '/adminapi/']) {
      expect(requiredAdminPermission('GET', prefix + 'wechat/app')).toBe('wechat_app.view');
      expect(requiredAdminPermission('POST', prefix + 'wechat/app')).toBe('wechat_app.manage');
      expect(requiredAdminPermission('GET', prefix + 'setting/config/edit_new_build/app')).toBe('wechat_app.view');
      expect(requiredAdminPermission('DELETE', prefix + 'wechat/app')).toBeNull();
    }
  }), 180000);

  it('uses an independent shared identity fence and detects receipt catalog drift without repair', async () => fixture(async (f, app, admin, names, env) => {
    await runAdminWechatAppUpgrade(f.db, names); const author = service(admin, env);
    const input = request((await author.read(actor())).revision);
    await app.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(731664,0)`);
      await expect(author.save(input, actor())).rejects.toMatchObject({ code: 503 });
    });
    await app.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(731661,0)`);
      expect(await author.save(input, actor())).toMatchObject({ state: 'committed' });
    });
    await f.exec('ALTER TABLE public.admin_wechat_app_operation ADD COLUMN owned_drift integer');
    expect(await inspectAdminWechatAppOperation(f.db)).toBe(false);
    await expect(runAdminWechatAppUpgrade(f.db, names)).rejects.toBeDefined();
  }), 180000);
});
