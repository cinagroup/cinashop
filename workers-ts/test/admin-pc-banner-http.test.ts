/** Registered routes, real JWT and separate actual app/Admin LOGINs. Only the
 * request's app connection wiring is supplied by this owned native fixture. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { systemAdmin, systemGroup, systemGroupData, systemMenus, systemRole } from '../src/models/schema';
import { pcBannerCanonical, pcBannerHash } from '../src/services/admin/AdminPcBannerInput';
import { createToken, md5 } from '../src/utils/jwt';
import { pcBannerFixture, pcBannerValues, pcBannerTestBindings } from './helpers/pcBannerFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({ ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Owned PC-banner HTTP fixture unavailable'); return wiring.container; },
}));
type HttpBindings = Pick<Env, 'APP_KEY' | 'UPSTASH_REDIS_URL' | 'UPSTASH_REDIS_TOKEN'> & { NODE_ENV: 'test' };
// These tested bindings retain Env's exact value types. All other bindings are
// unused in this request contract; provider fetches are forbidden below.
const env = { ...pcBannerTestBindings, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', NODE_ENV: 'test' } satisfies HttpBindings;
const httpEnv = env as unknown as Env;
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('registered PC banner HTTP contract with actual Admin authentication', () => {
  let f: Awaited<ReturnType<typeof pcBannerFixture>>;
  const app = createApp(), tokens = new Map<number, string>();
  const actors = { manager: 1, reader: 2, legacy: 3, generic: 4, wrongPath: 5, wrongAuth: 6, pcMall: 7, second: 8, genericGroup: 9 };
  let fetchGuard: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    f = await pcBannerFixture();
    await f.db.insert(systemMenus).values([
      { id: 481, type: 1, authType: 1, access: 1, uniqueAuth: 'setting-system-group_data-pc', menuPath: '/admin/setting/system_group_data/pc/:id' },
      { id: 482, type: 1, authType: 1, access: 1, uniqueAuth: 'setting-system-group_data-pc', menuPath: '/admin/setting/system_group_data/slide/66' },
      { id: 483, type: 1, authType: 1, access: 1, uniqueAuth: 'setting-system-group_data', menuPath: '/admin/setting/system_group_data/pc/66' },
      { id: 1036, type: 1, authType: 1, access: 1, uniqueAuth: 'setting-config-pc', menuPath: '/admin/setting/system_config/pc' },
      { id: 484, type: 1, authType: 2, access: 1, apiUrl: 'setting/group_data', methods: 'POST' },
    ]);
    const rules: Record<string, string> = { manager: 'pc_home_banner.manage', reader: 'pc_home_banner.view', legacy: '481', generic: 'config.manage',
      wrongPath: '482', wrongAuth: '483', pcMall: '1036', second: 'pc_home_banner.manage', genericGroup: '484' };
    await f.db.insert(systemRole).values(Object.entries(actors).map(([name, id]) => ({ id, type: 1, roleName: name, rules: rules[name] })));
    await f.db.insert(systemAdmin).values(Object.entries(actors).map(([name, id]) => ({ id, account: `pc-banner-${name}`, pwd: 'owned-pc-banner-password',
      level: 1, roles: String(id), adminType: 1, status: 1, isDel: 0 })));
    for (const id of Object.values(actors)) tokens.set(id, (await createToken(id, 'admin', md5('owned-pc-banner-password'), env.APP_KEY)).token);
    fetchGuard = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('PC-banner editor must not call providers or fetch media'); });
  }, 30_000);
  afterEach(async () => { if (fetchGuard) expect(fetchGuard).not.toHaveBeenCalled(); fetchGuard?.mockRestore(); wiring.container = undefined; tokens.clear(); await f?.close(); }, 30_000);
  async function profiles(run: (admin: { role: string }) => Promise<void>) {
    await f.withRuntimeRole(appPeer => f.withRuntimeRole(async adminPeer => {
      await f.installSlice(appPeer, adminPeer);
      expect((await appPeer.exec('SELECT current_user,session_user'))[0]).toEqual({ current_user: appPeer.role, session_user: appPeer.role });
      expect((await adminPeer.exec('SELECT current_user,session_user'))[0]).toEqual({ current_user: adminPeer.role, session_user: adminPeer.role });
      wiring.container = createContainerFromDb(appPeer.db);
      Object.assign(httpEnv, { HYPERDRIVE: { connectionString: appPeer.connectionString } as Env['HYPERDRIVE'],
        HYPERDRIVE_ADMIN: { connectionString: adminPeer.connectionString } as Env['HYPERDRIVE_ADMIN'] });
      try { await run(adminPeer); } finally { wiring.container = undefined; }
    }));
  }
  async function request(prefix: string, actor: number | null, suffix = '', method = 'GET', body?: unknown, raw?: string) {
    const response = await app.request(`${prefix}/setting/pc-banners${suffix}`, { method,
      headers: { ...(actor === null ? {} : { Authorization: `Bearer ${tokens.get(actor)}` }), ...(body === undefined && raw === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
    }, httpEnv);
    return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
  }
  const list = async (prefix = '/adminapi') => (await request(prefix, actors.manager)).body.data;
  const input = (revision: string) => ({ request_id: crypto.randomUUID(), revision, values: pcBannerValues(' 原样 🌿 '), sort: 80, status: 1 });

  it.each(['/adminapi', '/api/admin'])('exposes all seven endpoints and stable actor-bound receipts on %s', async prefix => {
    await profiles(async () => {
      const initial = await list(prefix), row = initial.list[0];
      const detail = await request(prefix, actors.reader, `/${row.id}`); expect(detail.body).toMatchObject({ status: 200, data: { info: { id: row.id, editable: true } } });
      expect(detail.response.headers.get('Cache-Control')).toContain('no-store');
      const body = input(initial.revision), created = await request(prefix, actors.manager, '', 'POST', body);
      expect(created.body.status, created.body.msg).toBe(200); expect(created.body.data).toMatchObject({ operation: 'create', request_id: body.request_id });
      const id = created.body.data.id; expect(id).toBeGreaterThan(0);
      expect((await request(prefix, actors.manager, `/request/${body.request_id}`)).body.data).toEqual(created.body.data);
      const update = input((await request(prefix, actors.manager, `/${id}`)).body.data.info.revision); update.values.title = ' 新标题 ';
      expect((await request(prefix, actors.manager, `/${id}`, 'PUT', update)).body.status).toBe(200);
      expect((await request(prefix, actors.manager, `/${id}`)).body.data.info.values.title).toBe(' 新标题 ');
      const toggle = { request_id: crypto.randomUUID(), revision: (await request(prefix, actors.manager, `/${id}`)).body.data.info.revision, status: 0 };
      expect((await request(prefix, actors.manager, `/${id}/status`, 'PATCH', toggle)).body.status).toBe(200);
      expect((await request(prefix, actors.reader, '?status=0')).body.data.list.some((entry: { id: number }) => entry.id === id)).toBe(true);
      const removal = { request_id: crypto.randomUUID(), revision: (await request(prefix, actors.manager, `/${id}`)).body.data.info.revision };
      const removed = await request(prefix, actors.manager, `/${id}`, 'DELETE', removal); expect(removed.body.status).toBe(200); expect(removed.body.data.id).toBe(id);
      const after = await f.snapshot();
      expect((await request(prefix, actors.manager, `/request/${removal.request_id}`)).body.data).toEqual(removed.body.data);
      expect((await request(prefix, actors.manager, `/${id}`, 'DELETE', removal)).body.data).toEqual(removed.body.data);
      expect((await request(prefix, actors.manager, '', 'POST', body)).body.data).toEqual(created.body.data);
      expect((await request(prefix, actors.manager, `/${id}`)).response.status).toBe(404);
      expect(await f.snapshot()).toEqual(after);
    });
  });

  it('admits only the exact legacy menu/auth pair for reads, denies all reader writes and keeps broad configuration/PC-mall/group grants separate', async () => {
    await profiles(async () => {
      const page = await list(), row = page.list[0], body = input(page.revision), before = await f.snapshot();
      for (const prefix of ['/adminapi', '/api/admin']) {
        for (const actor of [actors.reader, actors.legacy]) {
          expect((await request(prefix, actor)).body.status).toBe(200);
          for (const [suffix, method, data] of [['', 'POST', body], [`/${row.id}`, 'PUT', { ...body, revision: row.revision }],
            [`/${row.id}/status`, 'PATCH', { request_id: crypto.randomUUID(), revision: row.revision, status: 0 }],
            [`/${row.id}`, 'DELETE', { request_id: crypto.randomUUID(), revision: row.revision }]] as const) expect((await request(prefix, actor, suffix, method, data)).body.status).toBe(400011);
        }
        for (const actor of [actors.generic, actors.wrongPath, actors.wrongAuth, actors.pcMall, actors.genericGroup]) {
          expect((await request(prefix, actor)).body.status).toBe(400011); expect((await request(prefix, actor, '', 'POST', body)).body.status).toBe(400011);
        }
        expect((await request(prefix, null)).body.status).toBe(410000);
      }
      expect(await f.snapshot()).toEqual(before);
    });
  });

  it('binds nonce lookup and replay to actor and complete intent, with actual HTTP 404 for foreign/absent receipts', async () => {
    await profiles(async () => {
      const body = input((await list()).revision), created = await request('/adminapi', actors.manager, '', 'POST', body);
      expect(created.body.status, created.body.msg).toBe(200); const before = await f.snapshot();
      for (const prefix of ['/adminapi', '/api/admin']) {
        expect((await request(prefix, actors.second, `/request/${body.request_id}`)).response.status).toBe(404);
        expect((await request(prefix, actors.manager, `/request/${crypto.randomUUID()}`)).response.status).toBe(404);
        expect((await request(prefix, actors.second, '', 'POST', body)).body.status).not.toBe(200);
        const changed = await request(prefix, actors.manager, '', 'POST', { ...body, sort: body.sort + 1 });
        expect(changed.body.status).not.toBe(200); expect(changed.body.data?.code).not.toBe('PC_BANNER_STALE_VERSION');
        expect((await request(prefix, actors.manager, '', 'POST', body)).body.data).toEqual(created.body.data);
      }
      expect(await f.snapshot()).toEqual(before);
    });
  });

  it('rejects duplicate/unknown query and JSON keys, identity/group forgery, unsafe links and unavailable images before business writes', async () => {
    await profiles(async () => {
      const body = input((await list()).revision), before = await f.snapshot();
      for (const change of [{ gid: 90 }, { actor: 8 }, { value: '{}' }, { sort: -1 }, { status: 2 }, { values: { title: 'x', image: '/x.png' } },
        { values: { ...body.values, url: 'javascript:alert(1)' } }, { values: { ...body.values, image: '/api/assets/42' } },
        { values: { ...body.values, image: '/api/assets/41?expires=1&signature=x' } }]) {
        const result = await request('/adminapi', actors.manager, '', 'POST', { ...body, ...change });
        expect(result.body.status).not.toBe(200); expect(result.body.data?.code).not.toBe('PC_BANNER_STALE_VERSION');
      }
      const raw = JSON.stringify(body).replace('"sort":80', '"sort":80,"sort":81');
      expect((await request('/api/admin', actors.manager, '', 'POST', undefined, raw)).body.status).not.toBe(200);
      for (const suffix of ['?gid=66', '?status=1&status=0', '?page=01', '/request/not-a-uuid', '/01', '/301?status=1']) expect((await request('/adminapi', actors.manager, suffix)).body.status).not.toBe(200);
      expect((await request('/api/admin', actors.manager, '/900')).response.status).toBe(404);
      expect(await f.snapshot()).toEqual(before);
    });
  });

  it.each(['/adminapi', '/api/admin'])('returns narrow actual HTTP409 after rollback with matching canonical proof on %s', async prefix => {
    await profiles(async () => {
      const body = input((await list(prefix)).revision);
      await f.db.update(systemGroupData).set({ sort: 101 }).where(eq(systemGroupData.id, 302));
      const before = await f.snapshot(), stale = await request(prefix, actors.manager, '', 'POST', body);
      expect(stale.response.status).toBe(409); expect(stale.body).toMatchObject({ status: 409, data: { code: 'PC_BANNER_STALE_VERSION', operation: 'create',
        request_id: body.request_id, payload_hash: await pcBannerHash(pcBannerCanonical('create', undefined, body).canonical) } });
      expect(await f.snapshot()).toEqual(before);
      expect((await request(prefix, actors.manager, `/request/${body.request_id}`)).response.status).toBe(404);
      const refreshed = { ...body, request_id: crypto.randomUUID(), revision: (await list(prefix)).revision };
      const created = await request(prefix, actors.manager, '', 'POST', refreshed); expect(created.body.status, created.body.msg).toBe(200);
      expect((await request(prefix, actors.manager, '', 'POST', refreshed)).body.data).toEqual(created.body.data);
    });
  });

  it('keeps missing-group initialization atomic when the real Admin audit permission is absent', async () => {
    await profiles(async admin => {
      await f.db.delete(systemGroupData).where(eq(systemGroupData.gid, 66)); await f.db.delete(systemGroup).where(eq(systemGroup.id, 66));
      const page = await list(); expect(page).toMatchObject({ group_present: false, count: 0 });
      const before = await f.snapshot(); await f.exec(`REVOKE INSERT ON system_log FROM "${admin.role}"`);
      const result = await request('/adminapi', actors.manager, '', 'POST', input(page.revision));
      expect(result.body.status).not.toBe(200); expect(result.body.data?.code).not.toBe('PC_BANNER_STALE_VERSION');
      expect(await f.snapshot()).toEqual(before);
      expect((await f.exec(`SELECT has_table_privilege('${admin.role}','system_log','INSERT') AS allowed`))[0].allowed).toBe(false);
    });
  });

  it('refuses a missing dedicated Admin binding instead of using app or maintenance authority', async () => {
    await profiles(async () => {
      const previous = httpEnv.HYPERDRIVE_ADMIN; delete (httpEnv as Partial<Env>).HYPERDRIVE_ADMIN;
      try { const before = await f.snapshot(); expect((await request('/api/admin', actors.manager)).body.status).not.toBe(200); expect(await f.snapshot()).toEqual(before); }
      finally { httpEnv.HYPERDRIVE_ADMIN = previous; }
    });
  });
});
