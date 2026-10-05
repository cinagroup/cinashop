import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { systemAdmin, systemMenus, systemRole } from '../src/models/schema';
import { createToken, md5 } from '../src/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';

// The assembled router, real JWT/account checks, permission middleware and
// independent Admin/App LOGINs run unchanged. Only the host binding points at
// this owned loopback database; there is no external auth or provider call.
const wiring = vi.hoisted(() => ({ application: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({
  ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => {
    if (!wiring.application) throw Error('Owned level configuration LOGIN unavailable');
    return wiring.application;
  },
}));

const prefixes = ['/adminapi', '/api/admin'];
const actors = { manager: 8901, reader: 8902, coupon: 8903, user: 8904,
  level: 8905, legacyMenu: 8906 };
const password = 'isolated-level-configuration-only';
type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type RuntimeRole = Parameters<NonNullable<Fixture['withRuntimeRole']>>[0] extends (role: infer R) => unknown ? R : never;

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('ordinary level configuration assembled Admin HTTP and LOGIN', () => {
  let f: Fixture;
  let env: Env;
  const app = createApp();
  const tokens = new Map<string, string>();

  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture();
    f.env.APP_KEY = 'isolated-level-configuration-http-key';
    await f.db.insert(systemRole).values([
      { id: actors.manager, roleName: 'Level config manager', rules: 'config.manage' },
      { id: actors.reader, roleName: 'Level config reader', rules: 'config.view' },
      { id: actors.coupon, roleName: 'Coupon reader', rules: 'coupon.view' },
      { id: actors.user, roleName: 'User reader', rules: 'user.view' },
      { id: actors.level, roleName: 'Level manager', rules: 'level.manage' },
      { id: actors.legacyMenu, roleName: 'Legacy setup menu', rules: '1436' },
    ]);
    await f.db.insert(systemMenus).values({ id: 1436, type: 1, authType: 2, access: 1,
      menuPath: '/admin/user/setup_user', uniqueAuth: 'user-user-setup_user', apiUrl: '', methods: '' });
    await f.db.insert(systemAdmin).values(Object.entries(actors).map(([name, id]) => ({
      id, account: `local-level-config-${name}`, pwd: password,
      roles: String(id), level: 1, adminType: 1, status: 1, isDel: 0,
    })));
    for (const [name, id] of Object.entries(actors))
      tokens.set(name, (await createToken(id, 'admin', md5(password), f.env.APP_KEY)).token);
  }, 120000);

  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { wiring.application = undefined; tokens.clear(); vi.restoreAllMocks(); await f?.close(); }
  }, 30000);

  async function profiles(run: (appRole: RuntimeRole, adminRole: RuntimeRole) => Promise<void>) {
    await f.withRuntimeRole!(application => f.withRuntimeRole!(async admin => {
      const [identity] = await f.exec('SELECT current_database() AS name');
      const names = { app: application.role, admin: admin.role, maintenance: 'finance_test',
        database: String(identity.name), pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      expect(await auditRuntimeBusinessPrivileges(application.db, 'app', names)).toMatchObject({ ready: true, failures: [] });
      expect(await auditRuntimeBusinessPrivileges(admin.db, 'admin', names)).toMatchObject({ ready: true, failures: [] });
      for (const role of [application, admin]) {
        expect((await role.exec('SELECT current_user AS role,session_user AS session'))[0])
          .toEqual({ role: role.role, session: role.role });
      }
      wiring.application = createContainerFromDb(application.db);
      env = { ...f.env, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
        HYPERDRIVE: { connectionString: application.connectionString } as Env['HYPERDRIVE'],
        HYPERDRIVE_ADMIN: { connectionString: admin.connectionString } as Env['HYPERDRIVE_ADMIN'] };
      Object.assign(env, { NODE_ENV: 'test' });
      try { await run(application, admin); } finally { wiring.application = undefined; }
    }));
  }

  async function request(base: string, suffix: string, method = 'GET', actor = 'manager', body?: unknown) {
    const response = await app.request(`${base}/config/level-activation${suffix}`, {
      method,
      headers: { Authorization: `Bearer ${tokens.get(actor) ?? ''}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, env);
    const result = await response.json<{ status: number; msg: string; data: unknown }>();
    if (result.status === 200) expect(response.headers.get('Cache-Control')).toContain('no-store');
    return result;
  }

  it.each(prefixes)('authorizes read and rejects unrelated view or read-only write on %s', async base => {
    await profiles(async () => {
      const settings = await request(base, '', 'GET', 'reader');
      expect(settings.status, settings.msg).toBe(200);
      expect(settings.data).toMatchObject({ revision: expect.stringMatching(/^[a-f0-9]{64}$/),
        settings: expect.any(Object), profile_options: expect.any(Array), selected_coupons: expect.any(Array) });
      const options = await request(base, '/coupons?page=1&limit=10', 'GET', 'reader');
      expect(options.status, options.msg).toBe(200);
      expect(options.data).toMatchObject({ page: 1, limit: 10, list: expect.any(Array), count: expect.any(Number) });
      for (const actor of ['coupon', 'user', 'level', 'legacyMenu']) {
        const deniedRead = await request(base, '', 'GET', actor);
        expect(deniedRead).toMatchObject({ status: 400011, data: null });
        const deniedOptions = await request(base, '/coupons', 'GET', actor);
        expect(deniedOptions).toMatchObject({ status: 400011, data: null });
      }
      const deniedWrite = await request(base, '', 'POST', 'reader', { request_id: crypto.randomUUID() });
      expect(deniedWrite).toMatchObject({ status: 400011, data: null });
      const managerRead = await request(base, '', 'GET');
      expect(managerRead.status, managerRead.msg).toBe(200);
      const revision = (managerRead.data as { revision: string }).revision;
      const requestId = crypto.randomUUID();
      const saved = await request(base, '', 'POST', 'manager', {
        member_func_status: 1, level_activate_status: 1, level_extend_info: [],
        level_integral_status: 1, level_give_integral: 7,
        level_money_status: 1, level_give_money: '3',
        level_coupon_status: 0, level_give_coupon: [],
        coupon_revisions: [], revision, request_id: requestId,
      });
      expect(saved.status, saved.msg).toBe(200);
      expect(saved.data).toMatchObject({ committed: true, request_id: requestId,
        revision: expect.stringMatching(/^[a-f0-9]{64}$/), cache_status: 'cleared' });
      const reloaded = await request(base, '', 'GET', 'reader');
      expect(reloaded.status, reloaded.msg).toBe(200);
      expect(reloaded.data).toMatchObject({ revision: (saved.data as { revision: string }).revision,
        settings: { level_give_integral: 7, level_give_money: '3' } });
    });
  }, 120000);

  it.each(prefixes)('rejects unknown or oversized manager payload before configuration mutation on %s', async base => {
    await profiles(async () => {
      const before = (await f.query('SELECT to_jsonb(t) AS row FROM system_config t ORDER BY to_jsonb(t)::text')).rows;
      const invalid = await request(base, '', 'POST', 'manager', { request_id: crypto.randomUUID(), unknown: true });
      expect(invalid.status).not.toBe(200);
      const huge = await request(base, '', 'POST', 'manager', { request_id: crypto.randomUUID(),
        filler: 'X'.repeat(65 * 1024) });
      expect(huge.status).not.toBe(200);
      expect((await f.query('SELECT to_jsonb(t) AS row FROM system_config t ORDER BY to_jsonb(t)::text')).rows).toEqual(before);
    });
  }, 120000);
});
