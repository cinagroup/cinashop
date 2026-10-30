import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { systemAdmin, systemConfig, systemMenus, systemRole } from '@/models/schema';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { runAdminWechatMenuUpgrade } from '@/migrations/runAdminWechatMenuUpgrade';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { inspectAdminWechatMenuOperation } from '@/migrations/adminWechatMenuOperation';
import { OfficialAccountMenuProvider } from '@/services/wechat/OfficialAccountMenuProvider';
import { AdminWechatMenuService } from '@/services/admin/AdminWechatMenuService';
import { AdminPermissionService } from '@/services/admin/AdminPermissionService';
import { createToken, md5 } from '@/utils/jwt';
import { ApiErrorCode } from '@/utils/errors';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
type F = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Peer = Parameters<NonNullable<F['withRuntimeRole']>>[0] extends (peer: infer R) => unknown ? R : never;
const PASSWORD = 'owned-menu-test-password', KEY = 'owned-menu-app-signing-key';
const click = (name = '菜单') => ({ name, type: 'click', key: 'MENU_KEY' });
const children = [click('帮助'), { name: '小程序', type: 'miniprogram', appid: 'wx1234567890abcdef', pagepath: 'pages/index?from=menu', url: 'https://owned.example.test/fallback' }];
const complete = [{ name: '首页', type: 'view', url: 'https://owned.example.test/' }, { name: '服务', type: 'click', key: 'hidden', url: 'https://old.example.test/', sub_button: children }, click('联系')];
const ACTOR_EXPIRES = Math.floor(Date.now() / 1000) + 86400;
const actor = (id = 8860) => ({ id, authVersion: md5(PASSWORD), expiresAt: ACTOR_EXPIRES });
const roles = { manage: 8860, view: 8861, generic: 8862, legacy: 8863 };
async function fixture(run: (f: F, app: Peer, admin: Peer, names: { database: string; maintenance: string; app: string; admin: string; pricingOwner: string }) => Promise<void>) {
  const f = await refundRuntimeFixture();
  try {
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      const [row] = await f.exec('SELECT current_database() AS database,current_user AS maintenance');
      const names = { database: String(row.database), maintenance: String(row.maintenance), app: app.role, admin: admin.role, pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      await f.db.insert(systemRole).values(Object.entries(roles).map(([name, id]) => ({ id, roleName: 'Owned menu ' + name,
        rules: name === 'manage' ? 'wechat_menu.manage' : name === 'view' ? 'wechat_menu.view' : name === 'legacy' ? '92,507,508' : 'wechat_content.manage,system.manage' })));
      await f.db.insert(systemAdmin).values(Object.entries(roles).map(([name, id]) => ({ id, account: 'owned_menu_' + name, pwd: PASSWORD, roles: String(id), level: 1, adminType: 1 })));
      await f.db.delete(systemMenus).where(inArray(systemMenus.id, [92, 507, 508]));
      await f.db.insert(systemMenus).values([
        { id: 92, pid: 69, type: 1, module: 'admin', controller: 'application.wechat_menus', action: 'index', authType: 1,
          menuName: '微信菜单', menuPath: '/admin/app/wechat/setting/menus/index', uniqueAuth: 'application-wechat-menus', apiUrl: '', methods: '' },
        { id: 507, pid: 92, type: 1, module: 'admin', controller: '', action: '', authType: 2, menuName: '微信菜单列表', apiUrl: 'app/wechat/menu', methods: 'GET', menuPath: '', uniqueAuth: '' },
        { id: 508, pid: 92, type: 1, module: 'admin', controller: '', action: '', authType: 2, menuName: '微信菜单保存', apiUrl: 'app/wechat/menu', methods: 'POST', menuPath: '', uniqueAuth: '' },
      ]);
      try { await run(f, app, admin, names); }
      finally {
        await f.db.execute(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND usename=${app.role} AND application_name='cinashop_api' AND pid<>pg_backend_pid()`);
      }
    }));
  } finally { await f.close(); }
}
async function account(f: F, suffix: number) {
  await f.db.delete(systemConfig).where(inArray(systemConfig.menuName, ['wechat_appid', 'wechat_appsecret']));
  await f.db.insert(systemConfig).values([{ menuName: 'wechat_appid', value: JSON.stringify('wx' + suffix.toString(16).padStart(16, '0')) },
    { menuName: 'wechat_appsecret', value: JSON.stringify('owned-secret-' + suffix) }]);
}
async function unrelated(db: DbClient) {
  const tables = await db.execute<{ tablename: string }>(sql`SELECT tablename FROM pg_tables WHERE schemaname='public'
    AND tablename NOT IN ('cache','admin_wechat_menu_operation') ORDER BY tablename`);
  const result: Record<string, unknown> = {};
  for (const { tablename } of tables) {
    result[tablename] = await db.execute(sql.raw(`SELECT to_jsonb(t) AS row FROM public."${tablename.replaceAll('"', '""')}" t ORDER BY to_jsonb(t)::text`));
  }
  result.sequences = await db.execute(sql`SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`);
  return result;
}
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('WeChat menu actual commissioned LOGIN, durable publication and production Hono', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it('commissions only the addon, executes complete author publish and PHP aliases, and retains uncertain operations without resending', async () => {
    await fixture(async (f, app, admin, names) => {
      await account(f, 1);
      const service = new AdminWechatMenuService(createContainerFromDb(admin.db), KEY, new OfficialAccountMenuProvider((input, init) => globalThis.fetch(input, init)));
      expect((await service.read(actor())).runtime_ready).toBe(false);
      expect(await runAdminWechatMenuUpgrade(f.db, names)).toMatchObject({ applied: true });
      expect(await runAdminWechatMenuUpgrade(f.db, names)).toMatchObject({ applied: false });
      for (const [peer, kind] of [[app, 'app'], [admin, 'admin']] as const) expect(await auditRuntimeBusinessPrivileges(peer.db, kind, names)).toMatchObject({ ready: true, failures: [] });
      expect((await f.exec("SELECT count(*)::integer AS n FROM pg_tables WHERE schemaname='public'"))[0].n).toBe(284);
      await expect(app.exec('SELECT * FROM public.admin_wechat_menu_operation')).rejects.toMatchObject({ code: '42501' });
      await expect(admin.exec('UPDATE public.admin_wechat_menu_operation SET state=state')).rejects.toMatchObject({ code: '42501' });
      const transport: Array<{ path: string; method: string; button?: unknown }> = [];
      let mode = 'accepted', remote: unknown[] = complete, duringToken: (() => Promise<void>) | undefined;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = new URL(String(input)), method = init?.method ?? 'GET';
        expect(url.origin).toBe('https://api.weixin.qq.com');
        transport.push({ path: url.pathname, method, ...(init?.body ? { button: JSON.parse(String(init.body)).button } : {}) });
        if (url.pathname === '/cgi-bin/token') {
          const callback = duringToken; duringToken = undefined; await callback?.();
          return Response.json({ access_token: 'owned-token-never-returned-to-admin', expires_in: 7200 });
        }
        if (url.pathname === '/cgi-bin/menu/get') return Response.json({ menu: { button: remote }, conditionalmenu: [{ menuid: 'must-not-merge' }] });
        expect(url.pathname).toBe('/cgi-bin/menu/create');
        if (mode === 'unknown') throw Error('owned lost ACK');
        if (mode === 'rejected') return Response.json({ errcode: 48001, errmsg: 'owned-provider-text-must-not-escape' });
        return Response.json({ errcode: 0, errmsg: 'ok' });
      });
      const env = { HYPERDRIVE: { connectionString: app.connectionString }, HYPERDRIVE_ADMIN: { connectionString: admin.connectionString }, APP_KEY: KEY,
        UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', CONFIG_KV: { get: async () => 'poisoned-configuration-cache' } } as unknown as Env;
      const http = createApp(), token = (await createToken(roles.manage, 'admin', md5(PASSWORD), KEY)).token;
      const call = async (path: string, method = 'GET', body?: unknown, auth = token, headers: Record<string, string> = {}) => {
        const response = await http.request(path, { method, headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
        const data = await response.json<{ status: number; msg: string; data: any }>();
        await f.db.execute(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND usename=${app.role} AND application_name='cinashop_api' AND pid<>pg_backend_pid()`);
        expect(JSON.stringify(data)).not.toMatch(/owned-secret|owned-token|owned-provider-text/); return data;
      };
      const original = await unrelated(f.db), read = await call('/adminapi/wechat/menu'); expect(read.status).toBe(200);
      const id = randomUUID(), payload = { operation_id: id, revision: read.data.revision, button: complete, confirmed: true };
      const published = await call('/adminapi/wechat/menu', 'POST', payload); expect(published.status, published.msg).toBe(200);
      expect(published.data).toMatchObject({ operation_id: id, state: 'accepted', local_saved: true, replayed: false });
      expect(transport.filter(v => v.method === 'POST')).toEqual([{ path: '/cgi-bin/menu/create', method: 'POST', button: [complete[0], { name: '服务', sub_button: children }, complete[2]] }]);
      expect((await call('/api/admin/app/wechat/menu')).data.menus).toEqual(complete);
      expect(await unrelated(f.db)).toEqual(original);
      expect((await call('/api/admin/wechat/menu', 'POST', payload)).data).toMatchObject({ state: 'accepted', replayed: true });
      expect(transport.filter(v => v.method === 'POST')).toHaveLength(1);
      expect((await call('/adminapi/wechat/menu', 'POST', { ...payload, button: [click('改动')] })).status).toBe(409);
      expect((await call('/adminapi/wechat/menu', 'POST', { ...payload, revision: (await call('/adminapi/wechat/menu')).data.revision })).status).toBe(409);
      const legacyToken = (await createToken(roles.legacy, 'admin', md5(PASSWORD), KEY)).token;
      const viewToken = (await createToken(roles.view, 'admin', md5(PASSWORD), KEY)).token;
      const genericToken = (await createToken(roles.generic, 'admin', md5(PASSWORD), KEY)).token;
      for (const prefix of ['/adminapi', '/api/admin']) {
        expect((await call(prefix + '/app/wechat/menu', 'GET', undefined, legacyToken)).data.menus).toEqual(complete);
        const legacyId = randomUUID();
        expect((await call(prefix + '/app/wechat/menu', 'POST', { button: complete }, legacyToken, { 'X-Menu-Operation': legacyId })).status).toBe(200);
        const beforeReplay = transport.length;
        expect((await call(prefix + '/app/wechat/menu', 'POST', { button: complete }, legacyToken, { 'X-Menu-Operation': legacyId })).data.replayed).toBe(true);
        expect(transport).toHaveLength(beforeReplay);
        expect((await call(prefix + '/wechat/menu', 'GET', undefined, genericToken)).status).toBe(ApiErrorCode.ERR_AUTH);
        const view = await call(prefix + '/wechat/menu', 'GET', undefined, viewToken);
        expect((await call(prefix + '/wechat/menu', 'POST', { operation_id: randomUUID(), revision: view.data.revision, button: complete, confirmed: true }, viewToken)).status).toBe(ApiErrorCode.ERR_AUTH);
      }
      // A rejected pre-admission request can be fenced, even after its account
      // credentials disappear. The original UUID then has no future send path.
      const missing = { operation_id: randomUUID(), revision: (await service.read(actor())).revision, button: complete, confirmed: true };
      await f.db.execute(sql`UPDATE public.cache SET add_time=add_time+1 WHERE key='wechat_menus'`);
      const noAdmissionCalls = transport.length;
      expect((await call('/adminapi/wechat/menu', 'POST', missing)).status).toBe(409);
      expect((await call('/adminapi/wechat/menu/operations/' + missing.operation_id)).status).toBe(404);
      const sealPath = '/api/admin/wechat/menu/operations/' + missing.operation_id + '/resolve-missing';
      expect((await call(sealPath, 'POST', missing, viewToken)).status).toBe(ApiErrorCode.ERR_AUTH);
      expect((await call(sealPath, 'POST', { ...missing, operation_id: randomUUID() })).status).not.toBe(200);
      await f.db.delete(systemConfig).where(eq(systemConfig.menuName, 'wechat_appsecret'));
      const [cacheBeforeSeal] = await f.exec("SELECT to_jsonb(c) AS row FROM public.cache c WHERE key='wechat_menus'");
      const sealed = await call(sealPath, 'POST', missing);
      expect(sealed.status, sealed.msg).toBe(200);
      expect(sealed.data).toMatchObject({ operation_id: missing.operation_id, state: 'not_dispatched', local_saved: false });
      expect((await f.exec("SELECT to_jsonb(c) AS row FROM public.cache c WHERE key='wechat_menus'"))[0]).toEqual(cacheBeforeSeal);
      expect(await service.resolveMissing(missing.operation_id, missing, actor())).toMatchObject({ state: 'not_dispatched' });
      await expect(service.resolveMissing(missing.operation_id, { ...missing, button: [click('不同原文')] }, actor())).rejects.toThrow('不一致');
      await expect(service.resolveMissing(missing.operation_id, missing, actor(roles.legacy))).rejects.toThrow('不一致');
      await account(f, 1);
      expect(await service.publish(missing, actor())).toMatchObject({ state: 'not_dispatched', replayed: true });
      expect(transport).toHaveLength(noAdmissionCalls);
      await account(f, 2); mode = 'rejected';
      const rejected = await service.publish({ operation_id: randomUUID(), revision: (await service.read(actor())).revision, button: [click()], confirmed: true }, actor());
      expect(rejected).toMatchObject({ state: 'rejected', provider_code: 48001, local_saved: false });
      expect((await service.read(actor())).menus).toEqual(complete);
      await account(f, 3); mode = 'unknown';
      const uncertain = { operation_id: randomUUID(), revision: (await service.read(actor())).revision, button: complete, confirmed: true };
      expect(await service.publish(uncertain, actor())).toMatchObject({ state: 'unknown', local_saved: false });
      const callsBefore = transport.length;
      expect(await service.publish(uncertain, actor())).toMatchObject({ state: 'unknown', replayed: true });
      expect(transport).toHaveLength(callsBefore);
      expect(await service.resolveMissing(uncertain.operation_id, uncertain, actor())).toMatchObject({ state: 'unknown', local_saved: false });
      expect(transport).toHaveLength(callsBefore);
      expect((await admin.exec(`SELECT count(*)::integer AS n FROM public.admin_wechat_menu_operation WHERE operation_id='${uncertain.operation_id}'`))[0].n).toBe(1);
      await expect(service.publish({ ...uncertain, operation_id: randomUUID() }, actor())).rejects.toThrow('待核对');
      remote = [click('不同')]; expect(await service.observe(uncertain.operation_id, actor())).toMatchObject({ observed: true, matches: false });
      remote = complete; const observation = await service.observe(uncertain.operation_id, actor()); expect(observation).toMatchObject({ observed: true, matches: true });
      expect((await service.receipt(uncertain.operation_id, actor())).state).toBe('unknown');
      await expect(service.confirmObservation(uncertain.operation_id, { observation: observation.observation, confirmed: true }, actor())).rejects.toThrow('30秒');
      const realNow = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(realNow + 31000);
      expect(await service.confirmObservation(uncertain.operation_id, { observation: observation.observation, confirmed: true }, actor())).toMatchObject({ state: 'observed_match', local_saved: true });
      vi.mocked(Date.now).mockRestore();
      await account(f, 4); mode = 'accepted';
      expect((await call('/api/admin/app/wechat/menu', 'POST', { button: [click('旧接口')] })).status).toBe(200);
      await account(f, 5); mode = 'unknown';
      const legacyUnknown = await call('/adminapi/app/wechat/menu', 'POST', { button: [click('旧待核')] }); expect(legacyUnknown.status).toBe(503);
      expect(legacyUnknown.msg).toMatch(/[a-f0-9-]{36}/);
      await account(f, 6); mode = 'accepted';
      const fresh = await service.read(actor()); duringToken = async () => { await f.db.update(systemAdmin).set({ pwd: 'owned-rotated-password' }).where(eq(systemAdmin.id, roles.manage)); };
      const postsBefore = transport.filter(v => v.method === 'POST').length;
      expect(await service.publish({ operation_id: randomUUID(), revision: fresh.revision, button: [click()], confirmed: true }, actor())).toMatchObject({ state: 'not_dispatched' });
      expect(transport.filter(v => v.method === 'POST')).toHaveLength(postsBefore);
    });
  }, 180000);
  it('protects exact legacy tuples, fresh account binding, full invalid history, immutable catalog and provider/cache separation', async () => {
    await fixture(async (f, app, admin, names) => {
      await account(f, 10); await runAdminWechatMenuUpgrade(f.db, names);
      const service = new AdminWechatMenuService(createContainerFromDb(admin.db), KEY, new OfficialAccountMenuProvider((input, init) => globalThis.fetch(input, init)));
      const permissions = new AdminPermissionService(createContainerFromDb(app.db));
      expect(await permissions.resolveRulePermissionKeys('92,507,508')).toEqual(expect.arrayContaining(['wechat_menu.view', 'wechat_menu.manage']));
      for (const [id, patch] of [[92, { pid: 70 }], [507, { module: 'fake' }], [508, { methods: 'GET' }]] as const) {
        const [before] = await f.db.select().from(systemMenus).where(eq(systemMenus.id, id)); await f.db.update(systemMenus).set(patch).where(eq(systemMenus.id, id));
        expect(await permissions.resolveRulePermissionKeys(String(id))).toEqual([]); await f.db.update(systemMenus).set(before).where(eq(systemMenus.id, id));
      }
      await expect(service.publish({ operation_id: randomUUID(), revision: (await service.read(actor(roles.view))).revision, button: [click()], confirmed: true }, actor(roles.view))).rejects.toThrow('权限');
      await expect(service.read(actor(roles.generic))).rejects.toThrow('权限');
      await f.db.update(systemAdmin).set({ roles: roles.view + ',1999999999' }).where(eq(systemAdmin.id, roles.view));
      await expect(service.read(actor(roles.view))).rejects.toThrow();
      await f.db.update(systemAdmin).set({ roles: String(roles.view) }).where(eq(systemAdmin.id, roles.view));
      const raw = '[{"name":"保留原文","type":"scancode_push","key":"raw","extra":{"nested":[1,2,3]}}]';
      await f.db.execute(sql`INSERT INTO public.cache(key,result,expire_time,add_time) VALUES('wechat_menus',${raw},1,123) ON CONFLICT(key) DO UPDATE SET result=excluded.result,expire_time=1,add_time=123`);
      const historical = await service.read(actor()); expect(historical).toMatchObject({ menus: null, raw, present: true, expired: true });
      expect(historical.issues.length).toBeGreaterThan(0);
      await expect(service.publish({ operation_id: randomUUID(), revision: historical.revision, button: [click()], confirmed: true }, actor())).rejects.toThrow('整体替换');
      let rotate = false, calls = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        calls++; if (String(input).includes('/token?')) return Response.json({ access_token: 'owned-token', expires_in: 7200 });
        if (rotate) await f.db.update(systemConfig).set({ value: 'owned-new-secret' }).where(eq(systemConfig.menuName, 'wechat_appsecret'));
        return Response.json({ errcode: 0 });
      });
      rotate = true;
      const id = randomUUID(), result = await service.publish({ operation_id: id, revision: historical.revision, button: complete, replace_history: true, confirmed: true }, actor());
      expect(result).toMatchObject({ state: 'accepted_unstored', local_saved: false }); expect((await service.read(actor())).raw).toBe(raw);
      const prior = await admin.exec(`SELECT prior_cache FROM public.admin_wechat_menu_operation WHERE operation_id='${id}' AND phase=0`);
      expect(prior[0].prior_cache).toMatchObject({ result: raw, expire_time: 1, add_time: 123 }); expect(calls).toBe(2);
      expect(await withTx(createContainerFromDb(admin.db), tx => inspectAdminWechatMenuOperation(tx, names))).toBe(true);
      await f.exec('ALTER INDEX public.awmo_account_idx RENAME TO owned_drift_idx');
      expect((await auditRuntimeBusinessPrivileges(admin.db, 'admin', names)).ready).toBe(false);
      expect((await auditRuntimeBusinessPrivileges(app.db, 'app', names)).ready).toBe(false);
      await expect(runAdminWechatMenuUpgrade(f.db, names)).rejects.toThrow('profile');
      await f.exec('ALTER INDEX public.owned_drift_idx RENAME TO awmo_account_idx');
      await expect(f.exec('DELETE FROM public.admin_wechat_menu_operation')).rejects.toMatchObject({ code: '42501' });
      const before = (await service.read(actor())).revision; await f.db.update(systemConfig).set({ value: 'another-owned-secret' }).where(eq(systemConfig.menuName, 'wechat_appsecret'));
      await expect(service.publish({ operation_id: randomUUID(), revision: before, button: [click()], replace_history: true, confirmed: true }, actor())).rejects.toThrow('已变化');
      expect(calls).toBe(2);
      await f.exec("CREATE FUNCTION public.owned_cache_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.result := '[]'; RETURN NEW; END $$; CREATE TRIGGER owned_cache_rewrite BEFORE INSERT OR UPDATE ON public.cache FOR EACH ROW EXECUTE FUNCTION public.owned_cache_rewrite()");
      const unsafe = await service.read(actor());
      await expect(service.publish({ operation_id: randomUUID(), revision: unsafe.revision, button: [click()], replace_history: true, confirmed: true }, actor())).rejects.toThrow('缓存目录');
      expect(calls).toBe(2);
      await f.exec('DROP TRIGGER owned_cache_rewrite ON public.cache; DROP FUNCTION public.owned_cache_rewrite()');
      await account(f, 11);
      vi.mocked(fetch).mockImplementation(async input => String(input).includes('/token?') ? Response.json({ access_token: 'owned-token', expires_in: 7200 }) : Promise.reject(Error('owned unknown')));
      const unknownId = randomUUID();
      expect(await service.publish({ operation_id: unknownId, revision: (await service.read(actor())).revision, button: [click()], replace_history: true, confirmed: true }, actor())).toMatchObject({ state: 'unknown' });
      await admin.exec(`INSERT INTO public.admin_wechat_menu_operation SELECT operation_id,1,actor_id,resolver_id,app_id,account_stamp,request_hash,base_revision,button,'accepted',NULL,created_at,prior_cache FROM public.admin_wechat_menu_operation WHERE operation_id='${unknownId}' AND phase=0`);
      await expect(service.receipt(unknownId, actor())).rejects.toThrow('记录不完整');
    });
  }, 180000);
});
