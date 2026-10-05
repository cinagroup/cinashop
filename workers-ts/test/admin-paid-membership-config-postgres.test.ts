import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { createContainerFromDb, type Container, type DbClient } from '../src/lib/di';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { systemAdmin, systemConfig, systemLog, systemMenus, systemRole } from '../src/models/schema';
import { AdminPaidMembershipConfigService } from '../src/services/admin/AdminPaidMembershipConfigService';
import { AdminLevelActivationService } from '../src/services/admin/AdminLevelActivationService';
import { LEVEL_ACTIVATION_KEYS } from '../src/services/admin/AdminLevelActivationInput';
import { AdminConfigBatchService } from '../src/services/system/AdminConfigBatchService';
import { PAID_MEMBERSHIP_CONFIG_KEYS, type PaidMembershipConfigDto, type PaidMembershipConfigInput } from '../src/services/admin/AdminPaidMembershipConfigInput';
import { createToken, md5 } from '../src/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { observeCouponTemplateDb, withCouponTemplatePeer, type CouponTemplateRuntimePeer } from './helpers/couponTemplateFixture';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

// Only local host binding is replaced. The assembled router, JWT/account/ACL
// checks and independent commissioned Admin/App LOGINs execute unchanged.
const wiring = vi.hoisted(() => ({ application: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({
  ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => {
    if (!wiring.application) throw Error('Owned paid configuration LOGIN unavailable');
    return wiring.application;
  },
}));
const prefixes = ['/adminapi', '/api/admin'];
const actors = { manager: 8951, reader: 8952, coupon: 8953, user: 8954, level: 8955, legacyMenu: 8956 };
const actor = { id: actors.manager }, password = 'isolated-paid-config-only';
const logType = 'paid_membership_config';
type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('paid membership configuration on formal PG16 and genuine Admin/App LOGINs', () => {
  let f: Fixture, env: Env;
  const app = createApp(), tokens = new Map<string, string>();
  const cacheDeletes = vi.fn(async (_key: string): Promise<void> => {});
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    cacheDeletes.mockReset(); cacheDeletes.mockResolvedValue(undefined);
    f = await refundRuntimeFixture(); f.env.APP_KEY = 'isolated-paid-config-http-key';
    await f.db.delete(systemConfig).where(inArray(systemConfig.menuName, [...PAID_MEMBERSHIP_CONFIG_KEYS]));
    await f.db.insert(systemRole).values([
      { id: actors.manager, roleName: 'Paid config manager', rules: 'config.manage' },
      { id: actors.reader, roleName: 'Paid config reader', rules: 'config.view' },
      { id: actors.coupon, roleName: 'Coupon reader', rules: 'coupon.view' },
      { id: actors.user, roleName: 'User reader', rules: 'user.view' },
      { id: actors.level, roleName: 'Level manager', rules: 'level.manage' },
      { id: actors.legacyMenu, roleName: 'Legacy setup menu', rules: '1436' },
    ]);
    await f.db.insert(systemMenus).values({ id: 1436, type: 1, authType: 2, access: 1,
      menuPath: '/admin/user/setup_user', uniqueAuth: 'user-user-setup_user', apiUrl: '', methods: '' });
    await f.db.insert(systemAdmin).values(Object.entries(actors).map(([name, id]) => ({ id,
      account: `local-paid-config-${name}`, pwd: password, roles: String(id), level: 1, adminType: 1, status: 1, isDel: 0 })));
    for (const [name, id] of Object.entries(actors)) tokens.set(name, (await createToken(id, 'admin', md5(password), f.env.APP_KEY)).token);
  }, 120000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { wiring.application = undefined; tokens.clear(); vi.restoreAllMocks(); await f?.close(); }
  }, 30000);
  const environment = () => ({ ...f.env, CONFIG_KV: { ...f.env.CONFIG_KV, delete: cacheDeletes } });
  const serviceFor = (db: DbClient) => new AdminPaidMembershipConfigService(createContainerFromDb(db), environment());
  async function snapshot() {
    // Whole rows across these scenario tables; PostgreSQL sequences may retain
    // rollback gaps and are deliberately not claimed to be transactional.
    const result: Record<string, unknown> = {};
    for (const table of ['system_config', 'system_log', 'user', 'user_bill', 'user_money', 'member_card',
      'member_right', 'member_card_batch', 'member_ship', 'store_order', 'store_coupon_issue'])
      result[table] = (await f.query(`SELECT to_jsonb(t) AS row FROM public."${table}" t ORDER BY to_jsonb(t)::text`)).rows;
    return result;
  }
  async function commissioned(run: (admin: CouponTemplateRuntimePeer, app: CouponTemplateRuntimePeer,
    service: AdminPaidMembershipConfigService) => Promise<void>) {
    await f.withRuntimeRole!(application => f.withRuntimeRole!(async admin => {
      const [identity] = await f.exec('SELECT current_database() AS name');
      const names = { app: application.role, admin: admin.role, maintenance: 'finance_test', database: String(identity.name), pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      for (const [role, profile] of [[application, 'app'], [admin, 'admin']] as const) {
        expect(await auditRuntimeBusinessPrivileges(role.db, profile, names)).toMatchObject({ ready: true, failures: [] });
        expect((await role.exec('SELECT current_user AS role,session_user AS session'))[0]).toEqual({ role: role.role, session: role.role });
        expect((await role.exec('SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user'))[0])
          .toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
      }
      wiring.application = createContainerFromDb(application.db);
      env = { ...environment(), UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
        HYPERDRIVE: { connectionString: application.connectionString } as Env['HYPERDRIVE'],
        HYPERDRIVE_ADMIN: { connectionString: admin.connectionString } as Env['HYPERDRIVE_ADMIN'] };
      Object.assign(env, { NODE_ENV: 'test' });
      try { await run(admin, application, serviceFor(admin.db)); } finally { wiring.application = undefined; }
    }));
  }
  async function request(base: string, method = 'GET', name = 'manager', body?: unknown, suffix = '', raw = false) {
    const response = await app.request(`${base}/config/paid-membership${suffix}`, { method,
      headers: { Authorization: `Bearer ${tokens.get(name) ?? ''}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: raw ? String(body) : JSON.stringify(body) }) }, env);
    const result = await response.json<{ status: number; msg: string; data: unknown }>();
    if (result.status === 200) expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    return result;
  }
  const body = async (service: AdminPaidMembershipConfigService): Promise<PaidMembershipConfigInput> => ({
    member_card_status: 1, svip_price_status: 0, revision: (await service.get()).revision, request_id: crypto.randomUUID(),
  });
  const receipts = () => f.db.select().from(systemLog).where(eq(systemLog.type, logType)).orderBy(systemLog.id);

  it.each(prefixes)('uses actual JWT/config permissions and round-trips the exact two switches on %s', async base => {
    await commissioned(async () => {
      const before = await snapshot(), initial = await request(base, 'GET', 'reader');
      expect(initial.status, initial.msg).toBe(200);
      expect(initial.data).toMatchObject({ settings: { member_card_status: null, svip_price_status: null },
        missing_keys: [...PAID_MEMBERSHIP_CONFIG_KEYS], raw_values: { member_card_status: null, svip_price_status: null } });
      for (const name of ['coupon', 'user', 'level', 'legacyMenu']) {
        expect(await request(base, 'GET', name)).toMatchObject({ status: 400011, data: null });
        expect(await request(base, 'POST', name, {})).toMatchObject({ status: 400011, data: null });
      }
      expect((await request(base, 'GET', 'anonymous')).status).not.toBe(200);
      expect(await request(base, 'POST', 'reader', {})).toMatchObject({ status: 400011, data: null });
      expect(await snapshot()).toEqual(before);
      const input = { member_card_status: 0, svip_price_status: 1, revision: (initial.data as PaidMembershipConfigDto).revision, request_id: crypto.randomUUID() };
      const saved = await request(base, 'POST', 'manager', input);
      expect(saved.status, saved.msg).toBe(200);
      expect(saved.data).toMatchObject({ committed: true, request_id: input.request_id, cache_status: 'cleared' });
      const after = await snapshot(); expect((await request(base, 'POST', 'manager', input)).data).toEqual(saved.data);
      expect(await snapshot()).toEqual(after); expect(await receipts()).toHaveLength(1);
      expect((await request(base, 'GET', 'reader')).data).toMatchObject({ settings: { member_card_status: 0, svip_price_status: 1 },
        revision: (saved.data as { revision: string }).revision });
    });
  }, 120000);

  it.each(prefixes)('rejects unknown queries, duplicate keys, malformed bits and oversized manager input on %s', async base => {
    await commissioned(async (_admin, _app, service) => {
      const before = await snapshot(), input = await body(service);
      expect((await request(base, 'GET', 'manager', undefined, '?page=1')).status).not.toBe(200);
      expect((await request(base, 'POST', 'manager', input, '?ignored=1')).status).not.toBe(200);
      for (const invalid of [{ ...input, member_card_status: '1' }, { ...input, svip_price_status: null },
        { ...input, member_func_status: 1 }, { ...input, filler: 'X'.repeat(65 * 1024) }])
        expect((await request(base, 'POST', 'manager', invalid)).status).not.toBe(200);
      const duplicate = JSON.stringify(input).replace('"member_card_status":1', '"member_card_status":1,"member_card_\\u0073tatus":0');
      expect((await request(base, 'POST', 'manager', duplicate, '', true)).status).not.toBe(200);
      expect(await snapshot()).toEqual(before); expect(cacheDeletes).not.toHaveBeenCalled();
    });
  }, 120000);

  it('keeps GET on bounded read-only RR and denies App configuration writes without elevating either LOGIN', async () => {
    await commissioned(async (admin, application) => {
      const before = await snapshot(), states: unknown[] = []; let commands = 0;
      const observed = serviceFor(observeCouponTemplateDb(admin.db, async (tx, command) => {
        if (command === 'execute' && ++commands === 2) states.push((await tx.execute(sql`SELECT
          current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,
          (SELECT setting::integer FROM pg_settings WHERE name='statement_timeout') AS statement,
          (SELECT setting::integer FROM pg_settings WHERE name='lock_timeout') AS lock,
          (SELECT setting::integer FROM pg_settings WHERE name='idle_in_transaction_session_timeout') AS idle`))[0]);
      }));
      expect((await observed.get()).missing_keys).toEqual([...PAID_MEMBERSHIP_CONFIG_KEYS]);
      expect(states).toEqual([{ isolation: 'repeatable read', read_only: 'on', statement: 5000, lock: 2000, idle: 5000 }]);
      await expect(application.exec("UPDATE system_config SET value='1' WHERE menu_name='member_card_status'")).rejects.toMatchObject({ code: '42501' });
      expect(await snapshot()).toEqual(before); expect(cacheDeletes).not.toHaveBeenCalled();
    });
  }, 120000);

  it('rejects every protected key atomically at the assembled legacy batch route and retains unrelated configuration writes', async () => {
    await commissioned(async () => {
      const legacy = async (path: string, input: unknown) => {
        const response = await app.request(path, { method: 'POST',
          headers: { Authorization: `Bearer ${tokens.get('manager')}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(input) }, env);
        return { response, body: await response.json<{ status: number; msg: string }>() };
      };
      const before = await snapshot();
      for (const key of [...PAID_MEMBERSHIP_CONFIG_KEYS, ...LEVEL_ACTIVATION_KEYS]) {
        const result = await legacy('/api/admin/config/save', { whole_free_shipping: '1', [key]: '1' });
        expect(result.body).toMatchObject({ status: 400, msg: expect.stringContaining('专用接口') });
        expect(await snapshot()).toEqual(before);
      }
      expect(cacheDeletes).not.toHaveBeenCalled();
      const absent = await legacy('/adminapi/config/save', { whole_free_shipping: '1' });
      // Unregistered legacy Admin paths use the existing HTTP-200/501 envelope.
      expect(absent.response.status).toBe(200);
      expect(absent.body).toMatchObject({ status: 501, msg: expect.stringContaining('尚未迁移') });
      expect(await snapshot()).toEqual(before);
      const saved = await legacy('/api/admin/config/save', { whole_free_shipping: '1' });
      expect(saved.body.status, saved.body.msg).toBe(200);
      expect(await f.db.select({ value: systemConfig.value }).from(systemConfig).where(eq(systemConfig.menuName, 'whole_free_shipping')))
        .toContainEqual({ value: '1' });
      expect(cacheDeletes.mock.calls).toEqual([['cfg_whole_free_shipping']]);
    });
  }, 120000);

  it('preserves hidden winners metadata, store/loser rows and other domains; rejects raw/winner changes and audit-token ABA', async () => {
    await f.db.insert(systemConfig).values([
      { menuName: 'member_card_status', value: '0', sort: 8, status: 1, info: 'loser' },
      { menuName: 'member_card_status', value: '"1"', sort: 8, status: 0, info: 'winner', type: 'legacy' },
      { menuName: 'member_card_status', value: '0', sort: 999, isStore: 1, info: 'store' },
      { menuName: 'member_func_status', value: '0', info: 'other-domain' },
    ]);
    await commissioned(async (_admin, _app, service) => {
      const before = await snapshot(), rows = await f.db.select().from(systemConfig), input = await body(service);
      const receipt = await service.save(input, actor), after = await snapshot();
      for (const table of Object.keys(before).filter(key => !['system_config', 'system_log'].includes(key))) expect(after[table]).toEqual(before[table]);
      const winner = rows.find(row => row.info === 'winner'); expect(winner).toBeDefined();
      const saved = await f.db.select().from(systemConfig);
      for (const row of rows) expect(saved.find(actual => actual.id === row.id)).toEqual(row.id === winner?.id ? { ...row, value: '1' } : row);
      const stale = await body(service); const same = await service.save(stale, actor);
      expect(same.revision).not.toBe(receipt.revision);
      await expect(service.save({ ...stale, request_id: crypto.randomUUID() }, actor)).rejects.toThrow('已变化');
      const priority = await body(service);
      await f.db.insert(systemConfig).values({ menuName: 'member_card_status', value: '1', sort: 10, status: 0 });
      const beforeReject = await snapshot(); await expect(service.save(priority, actor)).rejects.toThrow('已变化');
      expect(await snapshot()).toEqual(beforeReject);
      await expect(service.save({ ...input, svip_price_status: 1 }, actor)).rejects.toThrow('请求标识');
      await expect(service.save(input, { id: actors.reader })).rejects.toThrow('已变化');
      await service.save({ ...await body(service), member_card_status: 0 }, actor);
      await service.save(await body(service), actor);
      expect((await service.get()).revision).not.toBe(same.revision);
      const latest = await snapshot(); expect(await service.save(input, actor)).toEqual(receipt); expect(await snapshot()).toEqual(latest);
      for (const log of await receipts()) { expect(log.action).toHaveLength(203); expect(log.action).toMatch(/^v1;p=[a-f0-9]{64};b=[a-f0-9]{64};a=[a-f0-9]{64}$/); }
    });
  }, 120000);

  it('rolls back both keys on native late audit failure and reports committed KV failures without repeating SQL', async () => {
    await commissioned(async (_admin, _app, service) => {
      const input = await body(service), before = await snapshot();
      await f.exec("ALTER TABLE system_log ADD CONSTRAINT paid_config_fixture_failure CHECK(type <> 'paid_membership_config')");
      await expect(service.save(input, actor)).rejects.toThrow();
      expect(await snapshot()).toEqual(before); expect(cacheDeletes).not.toHaveBeenCalled();
      await f.exec('ALTER TABLE system_log DROP CONSTRAINT paid_config_fixture_failure');
      cacheDeletes.mockImplementation(async key => { if (key === 'cfg_member_card_status') throw Error('Synthetic KV failure'); });
      const receipt = await service.save(input, actor), after = await snapshot();
      expect(receipt.cache_status).toBe('pending'); expect(cacheDeletes).toHaveBeenCalledTimes(2);
      expect((await service.get()).revision).toBe(receipt.revision);
      cacheDeletes.mockReset(); cacheDeletes.mockResolvedValue(undefined);
      expect(await service.save(input, actor)).toEqual({ ...receipt, cache_status: 'cleared' });
      expect(cacheDeletes).toHaveBeenCalledTimes(2); expect(await snapshot()).toEqual(after);
    });
  }, 120000);

  it.each([true, false])('serializes independent Admin peers with the actual table fence (same UUID: %s)', async replay => {
    await commissioned(async (admin, _app, service) => withCouponTemplatePeer(admin, async peer => {
      const input = await body(service), next = replay ? input : { ...input, request_id: crypto.randomUUID() };
      let enter!: () => void, release!: () => void, paused = false;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const observed = serviceFor(observeCouponTemplateDb(admin.db, async (tx, command) => {
        if (command !== 'execute' || paused) return;
        const [lock] = await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid()
          AND relation='system_config'::regclass AND mode='ShareRowExclusiveLock' AND granted) AS held`);
        if (lock?.held) { paused = true; enter(); await gate; }
      }));
      const first = outcome(observed.save(input, actor));
      let second: ReturnType<typeof outcome<Awaited<ReturnType<typeof service.save>>>> | undefined;
      try {
        await Promise.race([entered, first.then(() => { throw Error('First transaction completed without its fence barrier'); })]);
        second = outcome(serviceFor(peer.db).save(next, actor)); await waitForFinanceBlock(f.db, peer.pid, admin.pid);
      } finally { release(); }
      const a = await first, b = await second;
      expect(a.ok).toBe(true); if (!a.ok) throw a.error;
      expect(b).toBeDefined(); if (!b) throw Error('Second peer did not run');
      if (replay) { expect(b.ok).toBe(true); if (b.ok) expect(b.value).toEqual(a.value); }
      else { expect(b.ok).toBe(false); if (!b.ok) expect(String(b.error)).toContain('已变化'); }
      expect(await receipts()).toHaveLength(1); expect((await service.get()).revision).toBe(a.value.revision);
    }));
  }, 120000);

  it.each(['level', 'batch'] as const)('shares the fence with the existing %s writer without conflating domain receipts', async kind => {
    await commissioned(async (admin, _app, service) => withCouponTemplatePeer(admin, async peer => {
      const input = await body(service), level = new AdminLevelActivationService(createContainerFromDb(admin.db), environment());
      const levelInput = { member_func_status: 1, level_activate_status: 1, level_extend_info: [],
        level_integral_status: 0, level_give_integral: 0, level_money_status: 0, level_give_money: '0',
        level_coupon_status: 0, level_give_coupon: [], coupon_revisions: [],
        revision: (await level.get()).revision, request_id: input.request_id };
      let enter!: () => void, release!: () => void, paused = false;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const db = observeCouponTemplateDb(admin.db, async (tx, command) => {
        if (command !== 'execute' || paused) return;
        const [lock] = await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid()
          AND relation='system_config'::regclass AND mode='ShareRowExclusiveLock' AND granted) AS held`);
        if (lock?.held) { paused = true; enter(); await gate; }
      });
      const first = outcome<Awaited<ReturnType<typeof level.save>> | void>(kind === 'level'
        ? new AdminLevelActivationService(createContainerFromDb(db), environment()).save(levelInput, actor)
        : new AdminConfigBatchService(createContainerFromDb(db), environment()).save({ whole_free_shipping: '1' }));
      let second: ReturnType<typeof outcome<Awaited<ReturnType<typeof service.save>>>> | undefined;
      try {
        await Promise.race([entered, first.then(() => { throw Error('Existing writer bypassed the configuration fence'); })]);
        second = outcome(serviceFor(peer.db).save(input, actor)); await waitForFinanceBlock(f.db, peer.pid, admin.pid);
      } finally { release(); }
      const a = await first, b = await second; expect(a.ok).toBe(true); if (!a.ok) throw a.error;
      expect(b).toBeDefined(); if (!b) throw Error('Paid writer did not run');
      if (kind === 'level') {
        expect(b.ok).toBe(true); if (!b.ok) throw b.error;
        expect(await receipts()).toHaveLength(1);
        expect(await f.db.select().from(systemLog).where(eq(systemLog.type, 'level_activation_config'))).toHaveLength(1);
        expect((await level.get()).settings.member_func_status).toBe(1);
        expect((await service.get()).settings).toEqual({ member_card_status: 1, svip_price_status: 0 });
        const after = await snapshot(); expect(await service.save(input, actor)).toEqual(b.value);
        expect(await level.save(levelInput, actor)).toEqual(a.value); expect(await snapshot()).toEqual(after);
      } else {
        expect(b.ok).toBe(true); if (!b.ok) throw b.error;
        expect(await receipts()).toHaveLength(1);
        expect((await service.get()).settings).toEqual({ member_card_status: 1, svip_price_status: 0 });
        expect(await createContainerFromDb(admin.db).systemConfigDao.getValue('whole_free_shipping')).toBe('1');
        const after = await snapshot(); expect(await service.save(input, actor)).toEqual(b.value);
        expect(await snapshot()).toEqual(after);
      }
    }));
  }, 120000);
});
