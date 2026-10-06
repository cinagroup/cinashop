/** Actual registered app/JWT and independent non-owner app/Admin LOGINs.
 * Only the connection factory boundary is supplied by this owned fixture. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { systemAdmin, systemDise, systemLog, systemMenus, systemRole } from '../src/models/schema';
import { themeCanonical } from '../src/services/admin/AdminThemeSettingsInput';
import { AdminPermissionService } from '../src/services/admin/AdminPermissionService';
import { themeHash } from '../src/services/content/ThemeReadService';
import { createToken, md5 } from '../src/utils/jwt';
import { themeConfigEnv, themeSettingsFixture } from './helpers/themeSettingsFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({ ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Owned theme HTTP fixture unavailable'); return wiring.container; },
}));
const bindings = { APP_KEY: 'owned-theme-http-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', NODE_ENV: 'test', ...themeConfigEnv } satisfies
  Pick<Env, 'APP_KEY' | 'UPSTASH_REDIS_URL' | 'UPSTASH_REDIS_TOKEN'> & typeof themeConfigEnv & { NODE_ENV: 'test' };
// Unused external bindings are deliberately absent; the actual methods used
// above have checked binding shapes. This is a test boundary, not production Env.
const env = bindings as unknown as Env;

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('registered theme settings HTTP with genuine JWT and production ACL slice', () => {
  let f: Awaited<ReturnType<typeof themeSettingsFixture>>, fetchGuard: ReturnType<typeof vi.spyOn>;
  const app = createApp(), tokens = new Map<number, string>();
  const actors = { manager: 1, reader: 2, legacy: 3, generic: 4, wrongPath: 5, wrongAuth: 6, second: 8, legacyChild: 9, pc: 10, oldAction: 11 };
  beforeEach(async () => {
    f = await themeSettingsFixture();
    await f.db.insert(systemMenus).values([
      { id: 1035, type: 1, authType: 1, access: 1, uniqueAuth: 'admin-setting-theme_style', menuPath: '/admin/setting/theme_style' },
      { id: 1075, type: 1, authType: 1, access: 1, uniqueAuth: 'admin-setting-theme_style', menuPath: '/admin/setting/theme_style' },
      { id: 1036, type: 1, authType: 1, access: 1, uniqueAuth: 'admin-setting-pc_setting', menuPath: '/admin/setting/pc_setting' },
      { id: 91001, type: 1, authType: 1, access: 1, uniqueAuth: 'admin-setting-theme_style', menuPath: '/admin/setting/other' },
      { id: 91002, type: 1, authType: 1, access: 1, uniqueAuth: 'admin-setting-other', menuPath: '/admin/setting/theme_style' },
      { id: 1280, type: 1, authType: 2, access: 1, uniqueAuth: '', apiUrl: 'diy/get_color_change/<type>', methods: 'GET' },
      { id: 1281, type: 1, authType: 2, access: 1, uniqueAuth: '', apiUrl: 'diy/color_change/:status/<type>', methods: 'PUT' },
    ]);
    const rules: Record<string, string> = { manager: 'theme_settings.manage', reader: 'theme_settings.view', legacy: '1035', legacyChild: '1075',
      generic: 'config.manage,dise.manage', wrongPath: '91001', wrongAuth: '91002', second: 'theme_settings.manage', pc: '1036', oldAction: '1280,1281' };
    await f.db.insert(systemRole).values(Object.entries(actors).map(([name, id]) => ({ id, type: 1, roleName: name, rules: rules[name] })));
    await f.db.insert(systemAdmin).values(Object.entries(actors).map(([name, id]) => ({ id, account: `theme-${name}`, pwd: 'owned-theme-password', level: 1,
      roles: String(id), adminType: 1, status: 1, isDel: 0 })));
    for (const id of Object.values(actors)) tokens.set(id, (await createToken(id, 'admin', md5('owned-theme-password'), bindings.APP_KEY)).token);
    fetchGuard = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Theme settings must not call a provider'); });
  }, 30_000);
  afterEach(async () => { if (fetchGuard) expect(fetchGuard).not.toHaveBeenCalled(); fetchGuard?.mockRestore(); tokens.clear(); wiring.container = undefined; await f?.close(); }, 30_000);
  type Peer = Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0];
  async function profiles(run: (admin: Peer, appPeer: Peer) => Promise<void>) {
    await f.withRuntimeRole(appPeer => f.withRuntimeRole(async adminPeer => {
      await f.installSlice(appPeer, adminPeer);
      for (const peer of [appPeer, adminPeer]) expect((await peer.exec('SELECT current_user,session_user'))[0]).toEqual({ current_user: peer.role, session_user: peer.role });
      expect(appPeer.pid).not.toBe(adminPeer.pid); wiring.container = createContainerFromDb(appPeer.db);
      Object.assign(env, { HYPERDRIVE: { connectionString: appPeer.connectionString } as Env['HYPERDRIVE'], HYPERDRIVE_ADMIN: { connectionString: adminPeer.connectionString } as Env['HYPERDRIVE_ADMIN'] });
      try { await run(adminPeer, appPeer); } finally { wiring.container = undefined; }
    }));
  }
  async function request(prefix: string, actor: number | null, suffix = '', method = 'GET', body?: unknown, raw?: string, path = '/setting/theme-style') {
    const response = await app.request(`${prefix}${path}${suffix}`, { method, headers: { ...(actor === null ? {} : { Authorization: `Bearer ${tokens.get(actor)}` }),
      ...(body === undefined && raw === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
    return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
  }
  const page = async (prefix = '/adminapi') => (await request(prefix, actors.manager)).body.data;
  const input = (revision: string, status = 2) => ({ request_id: crypto.randomUUID(), revision, status });

  it.each(['/adminapi', '/api/admin'])('reads, writes and replays the exact actor-bound receipt on %s', async prefix => {
    await profiles(async () => {
      const initial = await request(prefix, actors.reader), before = await f.snapshot();
      expect(initial.body).toMatchObject({ status: 200, data: { status: 1, configured: true, editable: true, issues: [] } });
      expect(initial.response.headers.get('Cache-Control')).toContain('no-store'); expect(await f.snapshot()).toEqual(before);
      const body = input(initial.body.data.revision), saved = await request(prefix, actors.manager, '', 'POST', body);
      expect(saved.response.status).toBe(200); expect(saved.body).toMatchObject({ status: 200, data: { operation: 'update', id: 88, request_id: body.request_id, payload_hash: await themeHash(themeCanonical(body).canonical) } });
      expect((await request(prefix, actors.manager, `/request/${body.request_id}`)).body.data).toEqual(saved.body.data);
      const committed = await f.snapshot(); expect((await request(prefix, actors.manager, '', 'POST', body)).body.data).toEqual(saved.body.data); expect(await f.snapshot()).toEqual(committed);
      expect((await page(prefix)).status).toBe(2); expect(committed.logs).toHaveLength(1);
      const publicResponse = await request('/api/v2', null, '', 'GET', undefined, undefined, '/diy/color_change/color_change');
      expect(publicResponse.body).toMatchObject({ status: 200, data: { status: 2, navigation: 1, product_category_level: 2, theme_issues: [] } });
      expect(publicResponse.response.headers.get('Cache-Control')).toContain('no-store'); expect(await f.snapshot()).toEqual(committed);
    });
  });
  it('requires modern explicit manage and exact 1035/1075 page pairs in both real single and batched authorization', async () => {
    await profiles(async (admin, appPeer) => {
      const body = input((await page()).revision), before = await f.snapshot();
      for (const prefix of ['/adminapi', '/api/admin']) {
        for (const actor of [actors.reader, actors.legacy, actors.legacyChild]) {
          expect((await request(prefix, actor)).body.status).toBe(200); expect((await request(prefix, actor, '', 'POST', body)).body).toMatchObject({ status: 400011, data: null });
        }
        for (const actor of [actors.generic, actors.wrongPath, actors.wrongAuth, actors.pc, actors.oldAction]) {
          expect((await request(prefix, actor)).body.status).toBe(400011); expect((await request(prefix, actor, '', 'POST', body)).body.status).toBe(400011);
        }
        expect((await request(prefix, null)).body.status).toBe(410000);
      }
      const permissions = new AdminPermissionService(createContainerFromDb(admin.db));
      expect(await permissions.resolveManyRulePermissionKeys(['1035', '1075', '91001', '91002', '1280', '1281'])).toEqual([['theme_settings.view'], ['theme_settings.view'], [], [], ['dise.view'], ['dise.manage', 'dise.view']]);
      for (const patch of [{ uniqueAuth: 'wrong-auth' }, { menuPath: '/admin/setting/other' }, { type: 2 }, { authType: 2 }, { access: 0 }, { isDel: 1 }]) {
        await f.db.update(systemMenus).set({ uniqueAuth: 'admin-setting-theme_style', menuPath: '/admin/setting/theme_style', type: 1, authType: 1, access: 1, isDel: 0, ...patch }).where(eq(systemMenus.id, 1035));
        expect(await permissions.resolveRulePermissionKeys('1035')).toEqual([]); expect(await permissions.resolveManyRulePermissionKeys(['1035'])).toEqual([[]]);
        expect((await request('/adminapi', actors.legacy)).body.status).toBe(400011);
      }
      await f.db.update(systemMenus).set({ apiUrl: '/setting/theme-style', methods: 'POST', uniqueAuth: '' }).where(eq(systemMenus.id, 1281));
      expect(await permissions.resolveRulePermissionKeys('1281')).toEqual([]); expect((await request('/api/admin', actors.oldAction, '', 'POST', body)).body.status).toBe(400011);
      expect((await f.snapshot()).rows).toEqual(before.rows); expect((await f.snapshot()).logs).toEqual(before.logs);
      await expect(appPeer.exec("UPDATE system_dise SET value='6' WHERE id=88")).rejects.toMatchObject({ code: '42501' });
    });
  });
  it.each(['/adminapi', '/api/admin'])('proves stale409 and pre-DML400 rollback with the exact nonce and intent hash on %s', async prefix => {
    await profiles(async () => {
      const body = input((await page(prefix)).revision); await f.db.update(systemDise).set({ title: 'peer metadata change' }).where(eq(systemDise.id, 88));
      let before = await f.snapshot(); const stale = await request(prefix, actors.manager, '', 'POST', body);
      expect(stale.response.status).toBe(409); expect(stale.body).toMatchObject({ status: 409, data: { code: 'THEME_SETTINGS_STALE_VERSION', operation: 'update', request_id: body.request_id, payload_hash: await themeHash(themeCanonical(body).canonical) } });
      expect(await f.snapshot()).toEqual(before); expect((await request(prefix, actors.manager, `/request/${body.request_id}`)).response.status).toBe(404);
      await f.db.insert(systemDise).values({ templateName: '\u00a0COLOR_CHANGE\u00a0', type: 3, value: '6' });
      const ambiguous = await page(prefix), rejectedBody = input(ambiguous.revision); before = await f.snapshot();
      const rejected = await request(prefix, actors.manager, '', 'POST', rejectedBody);
      expect(rejected.response.status).toBe(400); expect(rejected.body).toMatchObject({ status: 400, data: { code: 'THEME_SETTINGS_REJECTED', operation: 'update', request_id: rejectedBody.request_id, payload_hash: await themeHash(themeCanonical(rejectedBody).canonical) } });
      expect(await f.snapshot()).toEqual(before); expect((await request(prefix, actors.manager, `/request/${rejectedBody.request_id}`)).response.status).toBe(404);
    });
  });
  it('preserves unknown outcomes for actor/hash conflicts and corrupt receipts instead of sending a rejection proof', async () => {
    await profiles(async () => {
      const body = input((await page()).revision); expect((await request('/adminapi', actors.manager, '', 'POST', body)).body.status).toBe(200);
      let before = await f.snapshot();
      for (const prefix of ['/adminapi', '/api/admin']) {
        expect((await request(prefix, actors.second, `/request/${body.request_id}`)).response.status).toBe(404);
        for (const [actor, data] of [[actors.second, body], [actors.manager, { ...body, status: 6 }]] as const) {
          const conflict = await request(prefix, actor, '', 'POST', data); expect(conflict.response.status).toBe(200); expect(conflict.body).toMatchObject({ status: 400, data: null });
        }
      }
      expect(await f.snapshot()).toEqual(before);
      await f.db.update(systemLog).set({ action: 'corrupt receipt' }).where(eq(systemLog.path, `/setting/theme-style/request/${body.request_id}`)); before = await f.snapshot();
      expect((await request('/adminapi', actors.manager, '', 'POST', body)).body).toMatchObject({ status: 400, data: null });
      expect((await request('/api/admin', actors.manager, `/request/${body.request_id}`)).body).toMatchObject({ status: 400, data: null }); expect(await f.snapshot()).toEqual(before);
    });
  });
  it('keeps raw parse/query/transport failures and unregistered legacy writes outside rollback proof', async () => {
    await profiles(async () => {
      const body = input((await page()).revision), before = await f.snapshot();
      for (const changed of [{ ...body, actor: 8 }, { ...body, request_id: 'not-uuid' }, { ...body, revision: 'a' }, { ...body, status: '2' }, { ...body, status: 0 }]) {
        const bad = await request('/adminapi', actors.manager, '', 'POST', changed); expect(bad.response.status).toBe(200); expect(bad.body).toMatchObject({ status: 400, data: null });
      }
      for (const raw of ['{bad', JSON.stringify(body).replace('"status":2', '"status":2,"stat\\u0075s":3'), ' '.repeat(4097)]) expect((await request('/api/admin', actors.manager, '', 'POST', undefined, raw)).body).toMatchObject({ status: 400, data: null });
      for (const suffix of ['?x=1', '?x=1&x=1', '/request/not-uuid', `/request/${crypto.randomUUID()}?x=1`]) expect((await request('/adminapi', actors.manager, suffix)).body).toMatchObject({ status: 400, data: null });
      for (const prefix of ['/adminapi', '/api/admin']) {
        for (const path of ['/setting/theme-style', '/diy/color_change/3/color_change']) {
          const legacy = await request(prefix, actors.manager, '', 'PUT', body, undefined, path);
          expect(legacy.response.status).toBe(200); expect(legacy.body).toMatchObject({ status: prefix === '/adminapi' ? 501 : 404, data: null });
        }
      }
      expect(await f.snapshot()).toEqual(before);
    });
  });
  it('blocks generic save and delete for correct, mistyped and normalized theme identities while ordinary DIY remains usable', async () => {
    await profiles(async () => {
      for (const patch of [{ templateName: 'color_change', type: 3 }, { templateName: 'color_change', type: 1 },
        { templateName: '\tCOLOR_CHANGE\n', type: 1 }, { templateName: '\u00a0color_change\u00a0', type: 2 }]) {
        await f.db.update(systemDise).set(patch).where(eq(systemDise.id, 88)); const before = await f.snapshot();
        for (const prefix of ['/adminapi', '/api/admin']) {
          const saving = await request(prefix, actors.generic, '', 'POST', { id: 88, value: '[]', name: 'forged ordinary' }, undefined, '/dise/save');
          expect(saving.body).toMatchObject({ status: 400, data: null }); expect(saving.body.msg).toContain('专用可视化配置');
          const deleting = await request(prefix, actors.generic, '', 'DELETE', undefined, undefined, '/dise/del/88');
          expect(deleting.body).toMatchObject({ status: 400, data: null }); expect(deleting.body.msg).toContain('主题配置');
        }
        expect(await f.snapshot()).toEqual(before);
      }
      expect((await request('/adminapi', actors.generic, '', 'POST', { id: 2, value: '[]', name: 'ordinary changed' }, undefined, '/dise/save')).body.status).toBe(200);
      expect((await request('/api/admin', actors.generic, '', 'DELETE', undefined, undefined, '/dise/del/2')).body.status).toBe(200);
      expect((await f.db.select().from(systemDise).where(eq(systemDise.id, 2)))[0]).toMatchObject({ name: 'ordinary changed', isDel: 1 }); expect((await f.snapshot()).logs).toHaveLength(0);
    });
  });
  it('rolls back first initialization without a proof on missing real journal INSERT privilege or absent Admin binding', async () => {
    await profiles(async admin => {
      await f.db.delete(systemDise).where(eq(systemDise.id, 88)); const missing = await page(), before = await f.snapshot();
      expect(missing).toMatchObject({ status: null, configured: false, editable: true, issues: ['theme_missing'] });
      await f.exec(`REVOKE INSERT ON system_log FROM "${admin.role}"`);
      const failed = await request('/adminapi', actors.manager, '', 'POST', input(missing.revision)); expect(failed.body.status).not.toBe(200);
      expect(failed.body.data?.code).not.toBe('THEME_SETTINGS_REJECTED'); expect(failed.body.data?.code).not.toBe('THEME_SETTINGS_STALE_VERSION'); expect(await f.snapshot()).toEqual(before);
      const previous = env.HYPERDRIVE_ADMIN; delete (env as Partial<Env>).HYPERDRIVE_ADMIN;
      try { expect((await request('/api/admin', actors.manager)).body.status).not.toBe(200); expect(await f.snapshot()).toEqual(before); }
      finally { env.HYPERDRIVE_ADMIN = previous; }
    });
  });
});
