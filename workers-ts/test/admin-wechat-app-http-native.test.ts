import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { systemAdmin, systemConfig, systemMenus, systemRole } from '@/models/schema';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { runAdminWechatMenuUpgrade } from '@/migrations/runAdminWechatMenuUpgrade';
import { runAdminWechatBaseUpgrade } from '@/migrations/runAdminWechatBaseUpgrade';
import { runAdminWechatAppUpgrade } from '@/migrations/runAdminWechatAppUpgrade';
import { WECHAT_APP_VIEW_SEED, WECHAT_APP_SAVE_SEED } from '@/services/admin/AdminWechatAppPermissionBinding';
import { AdminPermissionService, normalizeRoleRules } from '@/services/admin/AdminPermissionService';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import type { WechatAppSave } from '../../view/common/wechatApp';

const PASSWORD = 'owned-native-app-http-password', KEY = 'owned-native-app-http-key', ADMIN = 882100;
const rules = ['1379,315', '1379', '315', 'wechat_app.manage', 'wechat_app.view', 'config.manage', ''];
const domain = ['wechat_app_appid', 'wechat_app_appsecret'];
const prefixes = ['/adminapi', '/api/admin'];
const request = (revision: string): WechatAppSave => ({ request_id: randomUUID(), revision, confirmed: true,
  fields: { wechat_app_appid: { action: 'keep' }, wechat_app_appsecret: { action: 'keep' } } });

/** Actual production Hono routes, JWT middleware and separately authenticated
 * restricted PG16 LOGINs. All SQL/HTTP is local to this owned disposable test
 * fixture; the author must never call a provider or return stored secrets. */
async function fixture(run: (ctx: {
  f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  install: () => Promise<unknown>;
  call: (path: string, method?: string, body?: unknown, index?: number, raw?: string) => Promise<{
    status: number; msg: string; data: any; httpStatus: number; headers: Headers;
  }>;
  cached: string[]; invalidated: string[]; failCache: { value: boolean };
}) => Promise<void>, install = true) {
  const f = await refundRuntimeFixture();
  try {
    if (f.format !== 'pg16' || !f.withRuntimeRole) throw Error('Actual independent PG16 LOGINs required');
    await f.withRuntimeRole(app => f.withRuntimeRole!(async admin => {
      const [identity] = await f.exec('SELECT current_database() AS database,current_user AS maintenance');
      const names = { database: String(identity.database), maintenance: String(identity.maintenance), app: app.role,
        admin: admin.role, pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      await runAdminWechatMenuUpgrade(f.db, names); await runAdminWechatBaseUpgrade(f.db, names);
      await f.db.insert(systemRole).values(rules.map((rules, i) => ({ id: ADMIN + i, roleName: 'Owned App HTTP ' + i, rules })));
      await f.db.insert(systemAdmin).values(rules.map((_rules, i) => ({ id: ADMIN + i, account: 'owned_app_http_' + i,
        pwd: PASSWORD, roles: String(ADMIN + i), level: 1, adminType: 1 })));
      await f.db.delete(systemMenus).where(inArray(systemMenus.id, [1379, 315]));
      await f.db.insert(systemMenus).values([{ ...WECHAT_APP_VIEW_SEED, menuName: '移动应用' }, { ...WECHAT_APP_SAVE_SEED, menuName: '保存配置' }]);
      await f.db.delete(systemConfig).where(inArray(systemConfig.menuName, domain));
      await f.db.insert(systemConfig).values([
        { id: 882348, menuName: domain[0], value: '"native-http-app"', sort: 5, configTabId: 73, parameter: 'preserve-id-metadata' },
        { id: 882349, menuName: domain[1], value: '"owned-app-http-original-secret"', sort: 5, configTabId: 73, parameter: 'preserve-secret-metadata' },
        { id: 882350, menuName: domain[1], value: '"owned-app-http-shadow-secret"', sort: -1 },
        { id: 882351, menuName: domain[1], value: '"owned-app-http-store-secret"', isStore: 9 },
      ]);
      const cached: string[] = [], invalidated: string[] = [], failCache = { value: false };
      const env = { HYPERDRIVE: { connectionString: app.connectionString }, HYPERDRIVE_ADMIN: { connectionString: admin.connectionString },
        APP_KEY: KEY, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', CONFIG_KV: {
          get: async (key: string) => { cached.push(key); return 'poisoned-native-app-cache'; }, put: async () => {},
          delete: async (key: string) => { invalidated.push(key); if (failCache.value) throw Error('Owned cache unavailable'); },
        } } as unknown as Env;
      const upgrade = () => runAdminWechatAppUpgrade(f.db, names);
      if (install) await upgrade();
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('App author HTTP fixture forbids provider I/O'));
      const http = createApp(), tokens = await Promise.all(rules.map(async (_rules, i) =>
        (await createToken(ADMIN + i, 'admin', md5(PASSWORD), KEY)).token));
      const cleanupApi = () => f.db.execute(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname=current_database() AND usename=${app.role} AND application_name='cinashop_api' AND pid<>pg_backend_pid()`);
      const call = async (path: string, method = 'GET', body?: unknown, index = 0, raw?: string) => {
        const response = await http.request(path, { method, headers: { Authorization: 'Bearer ' + tokens[index], 'Content-Type': 'application/json' },
          ...(body === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(body) }) }, env);
        const text = await response.text();
        expect(text).not.toMatch(/owned-app-http-(?:original|shadow|store|replacement|bypass)-secret/u);
        const data = JSON.parse(text) as { status: number; msg: string; data: any };
        await cleanupApi(); return { ...data, httpStatus: response.status, headers: response.headers };
      };
      try {
        await run({ f, install: upgrade, call, cached, invalidated, failCache });
        expect(fetch).not.toHaveBeenCalled();
        expect(cached.some(key => domain.some(name => key === 'cfg_' + name))).toBe(false);
      } finally { await cleanupApi(); }
    }));
  } finally { await f.close(); }
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Native App actual dual-prefix Hono and restricted PG16 authority', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads before the optional bundle exists, then commits and recovers a complete save through both route prefixes', async () => fixture(async ctx => {
    const before = await ctx.call('/adminapi/wechat/app');
    expect(before.status, before.msg).toBe(200); expect(before.data.runtime_ready).toBe(false);
    const blocked = request(before.data.revision);
    expect((await ctx.call('/adminapi/wechat/app', 'POST', blocked)).status).toBe(503);
    await ctx.install();
    const read = await ctx.call('/api/admin/wechat/app');
    expect(read.data).toMatchObject({ runtime_ready: true, credentials_complete: true,
      settings: { wechat_app_appid: 'native-http-app' }, secrets: { wechat_app_appsecret: { present: true } } });
    expect(read.headers.get('Cache-Control')).toBe('private, no-store');
    const input = request(read.data.revision); input.fields.wechat_app_appsecret = { action: 'replace', value: 'owned-app-http-replacement-secret' };
    ctx.failCache.value = true;
    expect((await ctx.call('/adminapi/wechat/app', 'POST', input)).data).toMatchObject({ state: 'committed', cache_status: 'pending', replayed: false });
    ctx.failCache.value = false;
    expect((await ctx.call('/api/admin/wechat/app', 'POST', input)).data).toMatchObject({ state: 'committed', cache_status: 'cleared', replayed: true });
    const receipt = await ctx.call('/api/admin/wechat/app/operations/' + input.request_id);
    expect(receipt.data).toMatchObject({ request_id: input.request_id, actor_id: ADMIN, state: 'committed' });
    expect(receipt.headers.get('Cache-Control')).toBe('private, no-store');
    const changed = structuredClone(input); changed.fields.wechat_app_appsecret = { action: 'clear' };
    expect((await ctx.call('/adminapi/wechat/app', 'POST', changed)).status).toBe(409);
    expect((await ctx.call('/adminapi/setting/config/edit_new_build/app')).data.settings).toEqual({ wechat_app_appid: 'native-http-app' });
    const rows = await ctx.f.db.select().from(systemConfig).where(inArray(systemConfig.id, [882348, 882349, 882350, 882351]));
    expect(rows.find(row => row.id === 882349)).toMatchObject({ value: '"owned-app-http-replacement-secret"', parameter: 'preserve-secret-metadata' });
    expect(rows.find(row => row.id === 882350)?.value).toBe('"owned-app-http-shadow-secret"');
    expect(rows.find(row => row.id === 882351)?.value).toBe('"owned-app-http-store-secret"');
    expect(ctx.invalidated).toContain('cfg_wechat_app_appsecret');
    expect(ctx.invalidated).not.toContain('cfg_wechat_open_app_secret');
  }, false), 180000);

  it('admits only the complete fixed numeric authority and dispatches the shared legacy URL by whole App envelope', async () => fixture(async ctx => {
    const permissions = new AdminPermissionService(createContainerFromDb(ctx.f.db));
    expect(permissions.permissionTree().some(group => group.key === 'wechat_app')).toBe(false);
    for (const direct of ['wechat_app.view', 'wechat_app.manage']) expect(() => normalizeRoleRules(direct)).toThrow('完整的旧菜单组合');
    expect(normalizeRoleRules('1379,315')).toBe('315,1379');
    const superadmin = await permissions.resolveAdminPermissionKeys({ level: 0, roles: '' });
    expect(superadmin.has('wechat_app.view')).toBe(true); expect(superadmin.has('wechat_app.manage')).toBe(true);
    for (const prefix of prefixes) {
      const read = await ctx.call(prefix + '/wechat/app'); expect(read.status, read.msg).toBe(200);
      expect((await ctx.call(prefix + '/wechat/app', 'GET', undefined, 1)).status).toBe(200);
      for (const index of [2,3,4,5,6]) expect((await ctx.call(prefix + '/wechat/app', 'GET', undefined, index)).status).not.toBe(200);
      for (const index of [1,2,3,4,5,6])
        expect((await ctx.call(prefix + '/wechat/app', 'POST', request(read.data.revision), index)).status).not.toBe(200);
      const input = request(read.data.revision);
      expect((await ctx.call(prefix + '/setting/config/save_basics', 'POST', input)).data).toMatchObject({ state: 'committed', request_id: input.request_id });
      const fresh = await ctx.call(prefix + '/wechat/app');
      for (const index of [1,2,3,4,5,6])
        expect((await ctx.call(prefix + '/setting/config/save_basics', 'POST', request(fresh.data.revision), index)).status).not.toBe(200);
    }
  }), 180000);

  it('rejects duplicate, mixed, oversized, query and owner-spoofing bodies without any config or receipt mutation', async () => fixture(async ctx => {
    const before = await ctx.f.db.select().from(systemConfig), read = await ctx.call('/adminapi/wechat/app');
    const input = request(read.data.revision), raw = JSON.stringify(input);
    const duplicate = raw.replace('"confirmed":true', '"confirmed":false,"confirmed":true');
    const invalid: Array<unknown> = [{ ...input, actor_id: ADMIN + 1 }, { ...input, settings: { wechat_open_app_id: 'foreign-open' } },
      { ...input, fields: { ...input.fields, wechat_open_app_secret: { action: 'clear' } } },
      { ...input, fields: { wechat_app_appid: { action: 'keep' } } }];
    for (const prefix of prefixes) {
      for (const path of ['/wechat/app', '/setting/config/save_basics']) {
        for (const body of invalid) expect((await ctx.call(prefix + path, 'POST', body)).status).not.toBe(200);
        for (const text of ['{bad', '[]', duplicate])
          expect((await ctx.call(prefix + path, 'POST', undefined, 0, text)).status).not.toBe(200);
        const oversized = await ctx.call(prefix + path, 'POST', undefined, 0, raw.padEnd(65537));
        expect(oversized.status).toBe(400); expect(oversized.msg).toContain('64 KiB');
        expect((await ctx.call(prefix + path + '?actor_id=' + ADMIN, 'POST', input)).status).not.toBe(200);
      }
      expect((await ctx.call(prefix + '/wechat/app?x=1')).status).not.toBe(200);
    }
    expect(await ctx.f.db.select().from(systemConfig)).toEqual(before);
    expect((await ctx.f.exec('SELECT count(*)::integer AS n FROM public.admin_wechat_app_operation'))[0].n).toBe(0);
  }), 180000);

  it('keeps generic read, mixed batch and SMS compatibility writers closed even for an otherwise authorized generic administrator', async () => fixture(async ctx => {
    const before = await ctx.f.db.select().from(systemConfig);
    // Generic list/batch exist only under the modern prefix; the SMS writer
    // has both prefixes and the legacy reader is /setting/config/:menuName. Exercise their
    // actual guards rather than treating an unregistered alias as a writer.
    const list = await ctx.call('/api/admin/config/list', 'GET', undefined, 5);
    expect(list.status, list.msg).toBe(200);
    expect(list.data.some((row: { menuName: string }) => domain.includes(row.menuName))).toBe(false);
    for (const name of domain) {
      for (const path of ['/adminapi/setting/config/', '/api/admin/config/']) {
        const read = await ctx.call(path + name, 'GET', undefined, 5);
        expect(read.status).toBe(400); expect(read.msg).toContain('原生App配置只能通过专用接口读取');
      }
      const batch = await ctx.call('/api/admin/config/save', 'POST', { site_name: 'must-not-write', [name]: 'owned-app-http-bypass-secret' }, 5);
      expect(batch.status).toBe(400); expect(batch.msg).toContain('/wechat/app专用接口保存');
      for (const prefix of prefixes) {
        const sms = await ctx.call(prefix + '/sms/config', 'POST', { sms_sign: 'must-not-write', [name]: 'owned-app-http-bypass-secret' }, 5);
        expect(sms.status).toBe(400); expect(sms.msg).toContain('短信凭据');
      }
    }
    for (const prefix of prefixes)
      expect((await ctx.call(prefix + '/sms/config', 'POST', { pay_weixin_mchid: '1900000999' }, 5)).status).toBe(400);
    for (const [path, method] of [['/adminapi/config/list', 'GET'], ['/adminapi/config/save', 'POST']])
      expect((await ctx.call(path, method, method === 'POST' ? { wechat_app_appsecret: 'owned-app-http-bypass-secret' } : undefined, 5)).status).toBe(501);
    expect(await ctx.f.db.select().from(systemConfig)).toEqual(before);
  }), 180000);

  it('allows only the live request owner to recover after permission revocation and seals a missing operation against late save', async () => fixture(async ctx => {
    const read = await ctx.call('/adminapi/wechat/app'), saved = request(read.data.revision), missing = request(read.data.revision);
    expect((await ctx.call('/adminapi/wechat/app', 'POST', saved)).status).toBe(200);
    await ctx.f.db.update(systemRole).set({ rules: '' }).where(eq(systemRole.id, ADMIN));
    expect((await ctx.call('/adminapi/wechat/app')).status).not.toBe(200);
    expect((await ctx.call('/api/admin/wechat/app/operations/' + saved.request_id)).data.state).toBe('committed');
    expect((await ctx.call('/adminapi/wechat/app/operations/' + missing.request_id + '/resolve', 'POST', { confirmed: true })).data.state).toBe('not_applied');
    expect((await ctx.call('/api/admin/wechat/app/operations/' + saved.request_id, 'GET', undefined, 1)).status).not.toBe(200);
    await ctx.f.db.update(systemRole).set({ rules: '1379,315' }).where(eq(systemRole.id, ADMIN));
    expect((await ctx.call('/api/admin/wechat/app', 'POST', missing)).data).toMatchObject({ state: 'not_applied', replayed: true });
    await ctx.f.db.update(systemAdmin).set({ pwd: 'owned-rotated-password' }).where(eq(systemAdmin.id, ADMIN));
    expect((await ctx.call('/adminapi/wechat/app/operations/' + saved.request_id)).status).not.toBe(200);
  }), 180000);
});
