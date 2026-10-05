/** Registered dual-prefix routes, actual JWT and independent restricted SQL
 * LOGINs. Only createContainer connection wiring belongs to the fixture. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { systemAdmin, systemMenus, systemRole, systemGroup, systemGroupData, systemLog } from '../src/models/schema';
import { createToken, md5 } from '../src/utils/jwt';
import { signDayRuntimeFixture } from './helpers/signDayRuntimeFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({
  ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Sign-day HTTP fixture unavailable'); return wiring.container; },
}));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('registered sign-day editor with real Admin JWT and runtime LOGINs', () => {
  let f: Awaited<ReturnType<typeof signDayRuntimeFixture>>;
  const app = createApp(), tokens = new Map<number, string>();
  const actors = { manager: 1, reader: 2, legacy: 3, generic: 4, coupon: 5, wrongPath: 6, wrongAuth: 7, second: 8, genericGroup: 9 };
  const key = 'owned-local-sign-day-http-key';
  const env = { APP_KEY: key, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', NODE_ENV: 'test' } as unknown as Env;
  beforeEach(async () => {
    f = await signDayRuntimeFixture();
    await f.db.insert(systemMenus).values([
      { id: 154, type: 1, authType: 1, access: 1, uniqueAuth: 'marketing-integral-sign', menuPath: '/admin/marketing/integral/signIn' },
      { id: 1541, type: 1, authType: 1, access: 1, uniqueAuth: 'marketing-integral-sign', menuPath: '/admin/marketing/sign_rewards' },
      { id: 1542, type: 1, authType: 1, access: 1, uniqueAuth: 'admin-order-storeOrder-index', menuPath: '/admin/marketing/integral/signIn' },
      { id: 1543, type: 1, authType: 2, access: 1, apiUrl: 'setting/group_data', methods: 'POST' },
    ]);
    const rules: Record<string, string> = { manager: 'sign_day_config.manage', reader: 'sign_day_config.view', legacy: '154',
      generic: 'config.manage', coupon: 'coupon.manage', wrongPath: '1541', wrongAuth: '1542', second: 'sign_day_config.manage', genericGroup: '1543' };
    await f.db.insert(systemRole).values(Object.entries(actors).map(([name, id]) => ({ id, type: 1, roleName: name, rules: rules[name] })));
    await f.db.insert(systemAdmin).values(Object.entries(actors).map(([name, id]) => ({ id, account: `sign-day-${name}`,
      pwd: 'sign-day-http-fixture', level: 1, roles: String(id), adminType: 1, status: 1, isDel: 0 })));
    for (const id of Object.values(actors)) tokens.set(id, (await createToken(id, 'admin', md5('sign-day-http-fixture'), key)).token);
  }, 30_000);
  afterEach(async () => { wiring.container = undefined; tokens.clear(); await f?.close(); }, 30_000);

  async function profiles(run: (admin: { role: string }) => Promise<void>) {
    await f.withRuntimeRole(appPeer => f.withRuntimeRole(async adminPeer => {
      await f.installSlice(appPeer, 'app'); await f.installSlice(adminPeer, 'admin');
      expect((await appPeer.exec('SELECT current_user,session_user'))[0]).toEqual({ current_user: appPeer.role, session_user: appPeer.role });
      expect((await adminPeer.exec('SELECT current_user,session_user'))[0]).toEqual({ current_user: adminPeer.role, session_user: adminPeer.role });
      expect(appPeer.pid).not.toBe(adminPeer.pid);
      wiring.container = createContainerFromDb(appPeer.db);
      Object.assign(env, { HYPERDRIVE: { connectionString: appPeer.connectionString } as Env['HYPERDRIVE'],
        HYPERDRIVE_ADMIN: { connectionString: adminPeer.connectionString } as Env['HYPERDRIVE_ADMIN'] });
      try { await run(adminPeer); } finally { wiring.container = undefined; }
    }));
  }
  async function request(prefix: string, actor: number | null, path = '', method = 'GET', body?: unknown, raw?: string) {
    const response = await app.request(`${prefix}/marketing/sign-day-config${path}`, {
      method, headers: { ...(actor === null ? {} : { Authorization: `Bearer ${tokens.get(actor)}` }),
        ...(body === undefined && raw === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
    }, env);
    return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
  }
  const list = async (prefix = '/adminapi') => (await request(prefix, actors.manager)).body.data;
  const input = (revision: string) => ({ request_id: crypto.randomUUID(), revision, day: ' 第八天 🌿 ', sign_num: 12, sort: 0, status: 1 });
  const snapshot = async () => ({ groups: await f.db.select().from(systemGroup).orderBy(systemGroup.id),
    rows: await f.db.select().from(systemGroupData).orderBy(systemGroupData.id), logs: await f.db.select().from(systemLog).orderBy(systemLog.id) });

  it.each(['/adminapi', '/api/admin'])('implements all seven endpoints with private responses on %s', async prefix => {
    await profiles(async () => {
      const initial = await list(prefix), row = initial.list[0];
      expect(initial).toMatchObject({ group_present: true });
      const detail = await request(prefix, actors.reader, `/${row.id}`);
      expect(detail.body).toMatchObject({ status: 200, data: { info: { id: row.id } } });
      expect(detail.response.headers.get('Cache-Control')).toContain('no-store');
      const group = await f.db.select().from(systemGroup).where(eq(systemGroup.configName, 'sign_day_num'));
      await f.db.delete(systemGroupData).where(eq(systemGroupData.gid, group[0].id));
      const body = input((await list(prefix)).revision);
      const created = await request(prefix, actors.manager, '', 'POST', body);
      expect(created.body.status, created.body.msg).toBe(200);
      expect(created.body.data).toMatchObject({ operation: 'create', request_id: body.request_id });
      expect(created.response.headers.get('Cache-Control')).toContain('no-store');
      const id = created.body.data.id;
      expect((await request(prefix, actors.manager, `/receipts/${body.request_id}`)).body.data).toEqual(created.body.data);
      const extra = { pp: { type: 'upload', value: '/legacy/kept.png' }, ll: { arbitrary: ['untouched'] } };
      const [saved] = await f.db.select().from(systemGroupData).where(eq(systemGroupData.id, id));
      await f.db.update(systemGroupData).set({ value: JSON.stringify({ ...JSON.parse(saved.value!), ...extra }) }).where(eq(systemGroupData.id, id));
      const changed = input((await request(prefix, actors.manager, `/${id}`)).body.data.info.revision);
      changed.day = ' 原样保留文字 '; changed.sign_num = 99;
      expect((await request(prefix, actors.manager, `/${id}`, 'PUT', changed)).body.status).toBe(200);
      const [updated] = await f.db.select().from(systemGroupData).where(eq(systemGroupData.id, id));
      expect(JSON.parse(updated.value!)).toMatchObject(extra);
      expect((await request(prefix, actors.manager, `/${id}`)).body.data.info.day).toBe(changed.day);
      const toggle = { request_id: crypto.randomUUID(), revision: (await request(prefix, actors.manager, `/${id}`)).body.data.info.revision, status: 0 };
      expect((await request(prefix, actors.manager, `/${id}/status`, 'PATCH', toggle)).body.status).toBe(200);
      const removal = { request_id: crypto.randomUUID(), revision: (await request(prefix, actors.manager, `/${id}`)).body.data.info.revision };
      const removed = await request(prefix, actors.manager, `/${id}`, 'DELETE', removal);
      expect(removed.body.status, removed.body.msg).toBe(200);
      expect((await request(prefix, actors.manager, `/receipts/${removal.request_id}`)).body.data).toEqual(removed.body.data);
      const after = await snapshot();
      expect((await request(prefix, actors.manager, `/${id}`, 'DELETE', removal)).body.data).toEqual(removed.body.data);
      expect((await request(prefix, actors.manager, '', 'POST', body)).body.data).toEqual(created.body.data);
      expect(await snapshot()).toEqual(after);
    });
  });

  it('grants only exact legacy page reads, keeps generic configuration/coupon/group grants separate, and rejects every write for readers', async () => {
    await profiles(async () => {
      const page = await list(), row = page.list[0], body = input(page.revision), before = await snapshot();
      for (const prefix of ['/adminapi', '/api/admin']) {
        for (const actor of [actors.reader, actors.legacy]) {
          expect((await request(prefix, actor)).body.status).toBe(200);
          for (const [path, method, data] of [['', 'POST', body], [`/${row.id}`, 'PUT', { ...body, revision: row.revision }],
            [`/${row.id}/status`, 'PATCH', { request_id: crypto.randomUUID(), revision: row.revision, status: 0 }],
            [`/${row.id}`, 'DELETE', { request_id: crypto.randomUUID(), revision: row.revision }]] as const) {
            expect((await request(prefix, actor, path, method, data)).body.status).toBe(400011);
          }
        }
        for (const actor of [actors.generic, actors.coupon, actors.wrongPath, actors.wrongAuth, actors.genericGroup]) {
          expect((await request(prefix, actor)).body.status).toBe(400011);
          expect((await request(prefix, actor, '', 'POST', body)).body.status).toBe(400011);
        }
        expect((await request(prefix, null)).body.status).toBe(410000);
      }
      expect(await snapshot()).toEqual(before);
    });
  });

  it('binds receipt lookup to actor and immutable intent, with actual HTTP 404 for an unknown receipt', async () => {
    await profiles(async () => {
      const group = (await f.db.select().from(systemGroup).where(eq(systemGroup.configName, 'sign_day_num')))[0];
      await f.db.delete(systemGroupData).where(eq(systemGroupData.gid, group.id));
      const body = input((await list()).revision);
      const created = await request('/adminapi', actors.manager, '', 'POST', body);
      expect(created.body.status, created.body.msg).toBe(200);
      expect((await request('/adminapi', actors.second, `/receipts/${body.request_id}`)).response.status).toBe(404);
      expect((await request('/api/admin', actors.manager, `/receipts/${crypto.randomUUID()}`)).response.status).toBe(404);
      const before = await snapshot();
      expect((await request('/adminapi', actors.manager, '', 'POST', { ...body, sign_num: 13 })).body.status).not.toBe(200);
      expect(await snapshot()).toEqual(before);
      expect((await request('/api/admin', actors.manager, `/receipts/${body.request_id}`)).body.data).toEqual(created.body.data);
    });
  });

  it('rejects duplicate JSON keys, identity/group forgery, malformed labels and unwanted query fields before writes', async () => {
    await profiles(async () => {
      const body = input((await list()).revision), before = await snapshot();
      for (const extra of [{ gid: 55 }, { actor: actors.second }, { day: ' '.repeat(3) }, { day: '🌿'.repeat(65) },
        { sign_num: 0 }, { sign_num: '12' }, { sign_num: 2147483648 }, { sort: -1 }, { status: 2 }, { value: '{}' }]) {
        expect((await request('/adminapi', actors.manager, '', 'POST', { ...body, ...extra })).body.status).not.toBe(200);
      }
      const raw = JSON.stringify(body).replace('"sign_num":12', '"sign_num":12,"sign_num":13');
      expect((await request('/api/admin', actors.manager, '', 'POST', undefined, raw)).body.status).not.toBe(200);
      for (const path of ['?gid=55', '?status=1&status=0', '?config_name=other_data', '/receipts/not-a-uuid', '/01']) {
        expect((await request('/adminapi', actors.manager, path)).body.status).not.toBe(200);
      }
      expect(await snapshot()).toEqual(before);
    });
  });

  it('rolls back fixed-group initialization and first row when the real Admin audit INSERT is denied', async () => {
    await profiles(async admin => {
      const group = (await f.db.select().from(systemGroup).where(eq(systemGroup.configName, 'sign_day_num')))[0];
      await f.db.delete(systemGroupData).where(eq(systemGroupData.gid, group.id));
      await f.db.delete(systemGroup).where(eq(systemGroup.id, group.id));
      const page = await list(); expect(page).toMatchObject({ group_present: false, count: 0, list: [] });
      const before = await snapshot();
      await f.exec(`REVOKE INSERT ON public.system_log FROM "${admin.role}"`);
      const result = await request('/adminapi', actors.manager, '', 'POST', input(page.revision));
      expect(result.body.status).not.toBe(200);
      expect(await snapshot()).toEqual(before);
      expect((await f.exec(`SELECT has_table_privilege('${admin.role}','public.system_log','INSERT') AS allowed`))[0].allowed).toBe(false);
    });
  });

  it('refuses absent dedicated Admin binding instead of falling back to the app or maintenance connection', async () => {
    await profiles(async () => {
      const previous = env.HYPERDRIVE_ADMIN;
      delete (env as Partial<Env>).HYPERDRIVE_ADMIN;
      try {
        const before = await snapshot();
        expect((await request('/adminapi', actors.manager)).body.status).not.toBe(200);
        expect(await snapshot()).toEqual(before);
      } finally { env.HYPERDRIVE_ADMIN = previous; }
    });
  });
});
