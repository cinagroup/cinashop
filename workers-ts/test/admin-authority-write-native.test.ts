import bcrypt from 'bcryptjs';
import { Hono, type Context } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainer, createContainerFromDb, type DbClient } from '../src/lib/di';
import { systemAdmin, systemMenus, systemRole } from '../src/models/schema';
import { adminRuntimeAuthMiddleware } from '../src/middleware/admin-runtime-auth';
import { installRuntimeAdminBoundaryInTransaction } from '../src/migrations/runtimeAdminBoundary';
import { runtimeBusinessPrivilegePlan } from '../src/migrations/runtimeBusinessPrivilegePlan';
import { adminSystemAdminSave, adminSystemRoleSave, adminSystemRoleDel } from '../src/controllers/api/v1/AdminCrudController';
import { acquireAdminAuthorityWriteBarrier, assertRemainingActivePlatformSuperAdmin } from '../src/services/admin/AdminAuthorityWriteService';
import { ApiException, HttpApiException } from '../src/utils/errors';
import { createToken, md5 } from '../src/utils/jwt';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';

type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type LoginPeer = SequenceRunnerPeer & { role: string; connectionString: string };
type C = Context<{ Bindings: Env; Variables: AppVariables }>;
type Reply = { status: number; msg: string; data: { id: number } | null };
const password = 'owned-native-authority-password';
const baseEnv = { APP_KEY: 'owned-native-authority-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Only observe the original service callback's actual completed result. The
 * SQL, rows, options, connection and result sent to postgres-js are unchanged;
 * the pause is between callback return and the real COMMIT. */
function observeBeforeCommit(db: DbClient, observe: (tx: DbClient) => Promise<void>): DbClient {
  return new Proxy(db, {
    get(target, property) {
      const method: unknown = Reflect.get(target, property);
      if (typeof method !== 'function') return method;
      if (property !== 'transaction') return method.bind(target);
      return (callback: unknown, ...options: unknown[]) => {
        if (typeof callback !== 'function') throw Error('Missing original authority transaction callback');
        return Reflect.apply(method, target, [async (tx: DbClient) => {
          const result: unknown = await callback(tx);
          await observe(tx);
          return result;
        }, ...options]);
      };
    },
  });
}

function application(options: { beforeCommit?: (tx: DbClient) => Promise<void>; afterAuth?: (c: C) => Promise<void> } = {}) {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use('*', async (c, next) => {
    const container = createContainer(c.env); c.set('container', container);
    try { await next(); } finally { await container.db.$client.end({ timeout: 5 }); }
  });
  app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null },
    error instanceof HttpApiException ? error.httpStatus : 200));
  const observe = async (c: C, next: () => Promise<void>) => {
    await options.afterAuth?.(c);
    if (options.beforeCommit) c.set('container', createContainerFromDb(observeBeforeCommit(c.get('container').db, options.beforeCommit)));
    await next();
  };
  for (const prefix of ['/adminapi', '/api/admin']) {
    app.post(`${prefix}/system_admin/save`, adminRuntimeAuthMiddleware(), observe, adminSystemAdminSave);
    app.post(`${prefix}/system_role/save`, adminRuntimeAuthMiddleware(), observe, adminSystemRoleSave);
    app.delete(`${prefix}/system_role/del/:id`, adminRuntimeAuthMiddleware(), observe, adminSystemRoleDel);
  }
  return app;
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('modern authority writes on actual PG16 app/Admin LOGINs and a common table barrier', () => {
  let fixture: Fixture, ddl: string;
  const tokens = new Map<number, string>();
  beforeAll(async () => {
    const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson({ systemAdmin, systemRole, systemMenus }))).join('\n');
    for (const id of [100,101,102,103,104]) tokens.set(id, (await createToken(id, 'admin', md5(password), baseEnv.APP_KEY)).token);
  });
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native authority writes forbid external I/O'));
    fixture = await sequenceRunnerDatabase();
    if (fixture.format !== 'pg16' || !fixture.withPeer || !fixture.withRuntimeRole) throw Error('Owned real PG16 LOGINs required');
    await fixture.exec(ddl);
    await fixture.db.insert(systemMenus).values([
      { id: 2, type: 1, authType: 2, menuName: '商品读取权限', apiUrl: 'product/list', methods: 'GET' },
    ]);
    await fixture.db.insert(systemRole).values([
      { id: 50, type: 0, relationId: 0, level: 2, roleName: '未引用角色', rules: 'product.view', status: 1 },
      { id: 51, type: 1, relationId: 0, level: 2, roleName: '被引用角色', rules: 'product.view', status: 1 },
      { id: 52, type: 4, relationId: 7, level: 2, roleName: '供应商角色', rules: 'product.view', status: 1 },
      { id: 53, type: 1, relationId: 7, level: 2, roleName: '外关系角色', rules: 'product.view', status: 1 },
      { id: 54, type: 0, relationId: 0, level: 2, roleName: '软删除角色', rules: 'product.view', status: -1 },
      { id: 55, type: 0, relationId: 0, level: 2, roleName: '权限范围外角色', rules: 'user.view', status: 1 },
      { id: 900, type: 0, relationId: 0, level: 1, roleName: '当前管理者', rules: 'system.manage,2', status: 1 },
      { id: 901, type: 0, relationId: 0, level: 1, roleName: '目录只读', rules: 'system.view', status: 1 },
    ]);
    await fixture.db.insert(systemAdmin).values([
      { id: 100, account: 'authority-super', pwd: password, level: 0 },
      { id: 101, account: 'authority-manager', pwd: password, level: 1, roles: '900' },
      { id: 102, account: 'authority-reader', pwd: password, level: 1, roles: '901' },
      { id: 103, account: 'foreign-relation-actor', pwd: password, level: 1, roles: '900', relationId: 7 },
      { id: 104, account: 'supplier-actor', pwd: password, adminType: 4, relationId: 7, level: 1, roles: '900' },
      { id: 200, account: 'target-staff', pwd: password, level: 2 },
      { id: 201, account: 'supplier-target', pwd: password, adminType: 4, relationId: 7, level: 2 },
      { id: 202, account: 'foreign-target', pwd: password, relationId: 7, level: 2 },
      { id: 203, account: 'deleted-target', pwd: password, isDel: 1, level: 2 },
      { id: 205, account: 'disabled-super', pwd: password, level: 0, status: 0 },
      { id: 206, account: 'inactive-reference', pwd: password, level: 2, roles: '51', status: 0 },
      { id: 207, account: 'deleted-reference', pwd: password, level: 2, roles: '51', isDel: 1 },
      { id: 208, account: 'foreign-reference', pwd: password, adminType: 4, relationId: 7, level: 2, roles: '51' },
    ]);
    await fixture.exec("SELECT setval(pg_get_serial_sequence('system_admin','id'),208,true); SELECT setval(pg_get_serial_sequence('system_role','id'),901,true)");
  }, 60_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await fixture?.close(); }
  }, 30_000);

  async function snapshot() {
    return { admins: await fixture.db.select().from(systemAdmin).orderBy(systemAdmin.id),
      roles: await fixture.db.select().from(systemRole).orderBy(systemRole.id),
      menus: await fixture.db.select().from(systemMenus).orderBy(systemMenus.id) };
  }
  async function identity(peer: LoginPeer) {
    const [state] = await peer.exec(`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,
      current_database() AS database,current_setting('server_version_num') AS version`);
    expect(state).toMatchObject({ role: peer.role, session: peer.role, pid: peer.pid });
    expect(Math.floor(Number(state.version) / 10_000)).toBe(16);
    const [attributes] = await peer.exec('SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    expect(attributes).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    return state;
  }
  async function runtime<T>(run: (env: Env, appRole: LoginPeer, adminRole: LoginPeer) => Promise<T>) {
    return fixture.withRuntimeRole!(async appRole => fixture.withRuntimeRole!(async adminRole => {
      await fixture.db.transaction(tx => installRuntimeAdminBoundaryInTransaction(tx, appRole.role, 'finance_test'));
      for (const [kind, peer] of [['app', appRole], ['admin', adminRole]] as const) {
        const plan = runtimeBusinessPrivilegePlan(kind), grants: string[] = [];
        // Fixed projection of the actual runtime plan onto this owned three-table
        // fixture. Do not grant absent whole-shop objects or fabricate a profile.
        for (const table of ['system_admin', 'system_role', 'system_menus'] as const) {
          expect(plan.tables[table]).toContain('SELECT');
          grants.push(`GRANT ${plan.tables[table].join(',')} ON public.${table} TO "${peer.role}"`);
          if (plan.updateColumns[table]) grants.push(`GRANT UPDATE(${plan.updateColumns[table].join(',')}) ON public.${table} TO "${peer.role}"`);
          if (plan.tables[table].includes('INSERT')) grants.push(`GRANT USAGE ON SEQUENCE public.${table}_id_seq TO "${peer.role}"`);
        }
        await fixture.exec(grants.join(';'));
        await identity(peer);
        const rights = await peer.exec(`SELECT name,has_table_privilege(current_user,'public.'||name,'UPDATE') AS table_update,
          has_table_privilege(current_user,'public.'||name,'DELETE') AS hard_delete
          FROM (VALUES ('system_admin'),('system_role')) AS tables(name) ORDER BY name`);
        expect(rights).toEqual([{ name: 'system_admin', table_update: true, hard_delete: false },
          { name: 'system_role', table_update: true, hard_delete: false }]);
      }
      const env = { ...baseEnv, HYPERDRIVE: { connectionString: appRole.connectionString },
        HYPERDRIVE_ADMIN: { connectionString: adminRole.connectionString } } as Env;
      return run(env, appRole, adminRole);
    }));
  }
  async function request(env: Env, route: string, body: unknown, options: {
    actor?: number; method?: 'POST' | 'DELETE'; prefix?: string; app?: ReturnType<typeof application>; noToken?: boolean;
  } = {}) {
    const response = await (options.app ?? application()).request(`http://local${options.prefix ?? '/adminapi'}/${route}`, {
      method: options.method ?? 'POST', headers: { ...(options.noToken ? {} : { 'Authori-zation': `Bearer ${tokens.get(options.actor ?? 101)}` }),
        'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, env);
    return { http: response.status, body: await response.json() as Reply };
  }
  async function assertHeldTableBarrier(tx: DbClient, adminRole: LoginPeer): Promise<number> {
    const [state] = await tx.execute(sql`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,
      current_database() AS database,current_setting('server_version_num') AS version,
      current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly`);
    expect(state).toMatchObject({ role: adminRole.role, session: adminRole.role, isolation: 'read committed', readonly: 'off' });
    expect(Math.floor(Number(state.version) / 10_000)).toBe(16);
    const [observer] = await fixture.exec('SELECT current_database() AS database,pg_backend_pid() AS pid') as unknown as Array<{ database: string; pid: number }>;
    expect(state.database).toBe(observer.database); expect(state.pid).not.toBe(observer.pid);
    const locks = await tx.execute(sql`SELECT c.relname AS name,l.mode,l.granted FROM pg_locks AS l
      JOIN pg_class AS c ON c.oid=l.relation JOIN pg_namespace AS n ON n.oid=c.relnamespace
      WHERE l.pid=pg_backend_pid() AND n.nspname='public' AND c.relname IN ('system_admin','system_role')
        AND l.mode='ShareRowExclusiveLock' ORDER BY c.relname`);
    expect(Array.from(locks)).toEqual([{ name: 'system_admin', mode: 'ShareRowExclusiveLock', granted: true },
      { name: 'system_role', mode: 'ShareRowExclusiveLock', granted: true }]);
    return Number(state.pid);
  }

  it('uses the actual table-UPDATE plan, app trigger boundary and all three real modern handlers with complete row deltas', async () => {
    const before = await snapshot();
    await runtime(async (env, appRole, adminRole) => {
      await expect(appRole.exec("UPDATE system_admin SET roles='50' WHERE id=200")).rejects.toMatchObject({ code: '42501' });
      await expect(appRole.exec("UPDATE system_role SET status=0 WHERE id=50")).rejects.toMatchObject({ code: '42501' });
      await expect(appRole.exec("INSERT INTO system_admin(account,pwd,admin_type) VALUES('forbidden','hash',1)")).rejects.toMatchObject({ code: '42501' });
      await expect(appRole.exec('UPDATE system_menus SET id=99 WHERE id=2')).rejects.toMatchObject({ code: '42501' });
      await adminRole.exec('BEGIN');
      try { expect(await adminRole.exec("UPDATE system_admin SET roles='50' WHERE id=200 RETURNING id,roles"))
        .toEqual([{ id: 200, roles: '50' }]); } finally { await adminRole.exec('ROLLBACK'); }
      expect(await snapshot()).toEqual(before);
      let observed = 0;
      const app = application({ beforeCommit: async tx => { await assertHeldTableBarrier(tx, adminRole); observed++; } });
      const updated = await request(env, 'system_admin/save', { id: 200, real_name: '真实更新', phone: '13800123000', roles: '50' }, { app });
      expect(updated.body).toMatchObject({ status: 200, data: { id: 200 } });
      const afterAdmin = await snapshot();
      expect(afterAdmin).toEqual({ ...before, admins: before.admins.map(row => row.id === 200
        ? { ...row, realName: '真实更新', phone: '13800123000', roles: '50' } : row) });
      const renamed = await request(env, 'system_role/save', { id: 50, role_name: '仅改名称' }, { app, prefix: '/api/admin' });
      expect(renamed.body).toMatchObject({ status: 200, data: { id: 50 } });
      const afterRename = await snapshot();
      expect(afterRename).toEqual({ ...afterAdmin, roles: afterAdmin.roles.map(row => row.id === 50 ? { ...row, roleName: '仅改名称' } : row) });
      const createdRole = await request(env, 'system_role/save', { role_name: '新角色', rules: 'product.view', level: 2, status: 1 }, { app });
      expect(createdRole.body.status).toBe(200); const roleId = createdRole.body.data!.id;
      const afterRole = await snapshot();
      expect(afterRole).toEqual({ ...afterRename, roles: [...afterRename.roles,
        { id: roleId, type: 0, relationId: 0, roleName: '新角色', rules: 'product.view', level: 2, status: 1 }].sort((a,b) => a.id-b.id) });
      const deleted = await request(env, `system_role/del/${roleId}`, undefined, { app, prefix: '/api/admin', method: 'DELETE' });
      expect(deleted.body).toMatchObject({ status: 200, data: null });
      const afterDelete = await snapshot();
      expect(afterDelete).toEqual({ ...afterRole, roles: afterRole.roles.map(row => row.id === roleId ? { ...row, status: -1 } : row) });
      const startedAt = Math.floor(Date.now()/1000);
      const createdAdmin = await request(env, 'system_admin/save', { account: 'new-native-staff', pwd: 'new-native-password-123',
        real_name: '新管理员', phone: '13900123000', roles: '50', level: 2, status: 1, admin_type: 4, relation_id: 77 }, { app });
      expect(createdAdmin.body.status).toBe(200);
      const final = await snapshot(), added = final.admins.filter(row => !afterDelete.admins.some(old => old.id === row.id));
      expect(added).toHaveLength(1); const staff = added[0];
      expect(staff.id).toBe(createdAdmin.body.data!.id); expect(await bcrypt.compare('new-native-password-123', staff.pwd)).toBe(true);
      expect(staff.pwd).toMatch(/^\$2[aby]\$12\$/); expect(staff.lastTime).toBeGreaterThanOrEqual(startedAt);
      expect(staff.lastTime).toBeLessThanOrEqual(Math.floor(Date.now()/1000));
      expect(staff).toEqual({ ...before.admins.find(row => row.id === 200)!, id: staff.id, account: 'new-native-staff', pwd: staff.pwd,
        realName: '新管理员', phone: '13900123000', roles: '50', level: 2, status: 1, adminType: 1, relationId: 0, lastTime: staff.lastTime });
      expect(final).toEqual({ ...afterDelete, admins: [...afterDelete.admins, staff].sort((a,b) => a.id-b.id) });
      expect(observed).toBe(5);
    });
  }, 60_000);

  it('enforces live JWT, platform realms, self authority, last super and bounded fields without changing any rows', async () => {
    await runtime(async (env, _appRole, adminRole) => {
      const before = await snapshot();
      expect((await request(env, 'system_role/save', { id: 50, role_name: '无登录' }, { noToken: true })).body.status).toBe(410000);
      for (const actor of [102,103,104]) {
        expect((await request(env, 'system_role/save', { id: 50, role_name: '越权' }, { actor })).body.status).not.toBe(200);
      }
      const self = await request(env, 'system_admin/save', { id: 101, roles: '', status: 0, level: 2 });
      expect(self).toMatchObject({ http: 409, body: { status: 409 } });
      expect((await request(env, 'system_role/save', { id: 900, rules: '' })).body.status).toBe(409);
      expect((await request(env, 'system_role/del/900', undefined, { method: 'DELETE' })).body.status).toBe(409);
      expect((await request(env, 'system_admin/save', { id: 100, status: 0 }, { actor: 100 })).body.status).toBe(409);
      // Independently exercise the actual last-super guard under the same table
      // barrier. The public self guard rejects its self-disable before this gate.
      await expect(adminRole.db.transaction(async tx => {
        await acquireAdminAuthorityWriteBarrier(tx as unknown as DbClient);
        await assertRemainingActivePlatformSuperAdmin(tx as unknown as DbClient, 100);
      })).rejects.toMatchObject({ code: 409 });
      for (const id of [201,202,203,9999]) expect((await request(env, 'system_admin/save', { id, real_name: '外域' })).body.status).toBe(400);
      for (const id of [52,53,54,9999]) {
        expect((await request(env, 'system_role/save', { id, role_name: '外域' })).body.status).toBe(400);
        expect((await request(env, `system_role/del/${id}`, undefined, { method: 'DELETE' })).body.status).toBe(400);
      }
      const invalidAdmin = [{ id: 200, level: 10 }, { id: 200, status: 2 }, { id: 200, roles: '01' },
        { id: 200, real_name: '😀'.repeat(17) }, { account: 'a'.repeat(33), pwd: 'new-native-password-123' }, { id: 200, pwd: 'short' }];
      const invalidRole = [{ id: 50, level: 10 }, { id: 50, status: 2 }, { id: 50, role_name: '😀'.repeat(33) },
        { id: 50, rules: 'x'.repeat(16385) }, { id: 50, rules: Array.from({ length: 2049 }, (_,i) => String(100000+i)).join(',') },
        { id: 50, rules: 'product.view\n' }];
      for (const body of invalidAdmin) expect((await request(env, 'system_admin/save', body)).body.status).toBe(400);
      for (const body of invalidRole) expect((await request(env, 'system_role/save', body)).body.status).toBe(400);
      expect((await request(env, 'system_admin/save', { id: 200, roles: '52' })).body.status).toBe(400);
      expect((await request(env, 'system_admin/save', { id: 200, roles: '55' })).body.status).toBe(400);
      const [remaining] = await fixture.exec('SELECT count(*)::int AS count FROM system_admin WHERE admin_type=1 AND relation_id=0 AND is_del=0 AND status=1 AND level=0') as unknown as Array<{ count: number }>;
      expect(remaining.count).toBe(1); expect(await snapshot()).toEqual(before);
    });
  }, 60_000);

  it('rejects authority changes on exact references, including disabled, deleted and foreign references, while permitting a name-only edit', async () => {
    await runtime(async env => {
      const before = await snapshot();
      for (const body of [{ id: 51, status: 0 }, { id: 51, rules: '' }]) {
        const rejected = await request(env, 'system_role/save', body);
        expect(rejected).toMatchObject({ http: 409, body: { status: 409 } });
      }
      expect((await request(env, 'system_role/del/51', undefined, { method: 'DELETE' })).body.status).toBe(409);
      expect(await snapshot()).toEqual(before);
      const renamed = await request(env, 'system_role/save', { id: 51, role_name: '引用角色仅改名' }); expect(renamed.body.status).toBe(200);
      expect(await snapshot()).toEqual({ ...before, roles: before.roles.map(row => row.id === 51 ? { ...row, roleName: '引用角色仅改名' } : row) });
    });
  }, 60_000);

  it('rechecks committed authority revocation after ordinary authentication on the real separate Admin session', async () => {
    await runtime(async (env, _appRole, adminRole) => fixture.withPeer!(async writer => {
      const before = await snapshot(); let observed = false;
      const app = application({ afterAuth: async c => {
        expect(c.get('adminInfo')).toMatchObject({ id: 101, roles: '900' });
        const [actual] = await c.get('container').db.execute(sql`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid`);
        expect(actual).toMatchObject({ role: adminRole.role, session: adminRole.role }); expect(actual.pid).not.toBe(writer.pid);
        await writer.exec("BEGIN; UPDATE system_role SET rules='product.view' WHERE id=900; COMMIT"); observed = true;
      } });
      const rejected = await request(env, 'system_role/save', { id: 50, role_name: '不应更新' }, { app });
      expect(observed).toBe(true); expect(rejected.body.status).toBe(400011);
      expect(await snapshot()).toEqual({ ...before, roles: before.roles.map(row => row.id === 900 ? { ...row, rules: 'product.view' } : row) });
    }));
  }, 60_000);

  it.each(['disable','soft-delete'] as const)('serializes role %s with a new Admin assignment, rejects NOWAIT and rejects the committed inactive role', async mode => {
    await runtime(async (env, _appRole, adminRole) => {
      const before = await snapshot(), ready = deferred(), release = deferred();
      let mutatorPid = 0;
      const paused = application({ beforeCommit: async tx => {
        mutatorPid = await assertHeldTableBarrier(tx, adminRole); ready.resolve(); await release.promise;
      } });
      const mutator = outcome(mode === 'disable'
        ? request(env, 'system_role/save', { id: 50, status: 0 }, { app: paused })
        : request(env, 'system_role/del/50', undefined, { app: paused, method: 'DELETE' }));
      try {
        await Promise.race([ready.promise, mutator.then(() => { throw Error('Role mutation ended before actual pre-COMMIT pause'); })]);
        expect(mutatorPid).toBeGreaterThan(0);
        const assignment = await request(env, 'system_admin/save', { id: 200, roles: '50' });
        expect(assignment).toMatchObject({ http: 409, body: { status: 409 } });
        expect(await snapshot()).toEqual(before);
        release.resolve(); const mutated = await mutator; expect(mutated.ok).toBe(true);
        if (mutated.ok) expect(mutated.value.body.status).toBe(200);
        const after = await snapshot();
        expect(after).toEqual({ ...before, roles: before.roles.map(row => row.id === 50 ? { ...row, status: mode === 'disable' ? 0 : -1 } : row) });
        expect((await request(env, 'system_admin/save', { id: 200, roles: '50' })).body.status).toBe(400);
        expect(await snapshot()).toEqual(after);
      } finally { release.resolve(); await mutator; }
    });
  }, 60_000);

  it('holds both table barriers and real menu authority locks through COMMIT, including rows being newly assigned', async () => {
    await runtime(async (env, _appRole, adminRole) => fixture.withPeer!(async roleWriter => fixture.withPeer!(async adminWriter => fixture.withPeer!(async menuWriter => {
      const before = await snapshot(), ready = deferred(), release = deferred();
      let savePid = 0;
      const app = application({ beforeCommit: async tx => { savePid = await assertHeldTableBarrier(tx, adminRole); ready.resolve(); await release.promise; } });
      const saved = outcome(request(env, 'system_role/save', { id: 50, role_name: '提交保持锁' }, { app }));
      let roleChange: ReturnType<typeof outcome> | undefined, adminAssignment: ReturnType<typeof outcome> | undefined, menuChange: ReturnType<typeof outcome> | undefined;
      try {
        await Promise.race([ready.promise, saved.then(() => { throw Error('Save ended before its real pre-COMMIT pause'); })]);
        expect(new Set([savePid, roleWriter.pid, adminWriter.pid, menuWriter.pid]).size).toBe(4);
        for (const peer of [roleWriter,adminWriter,menuWriter]) await peer.exec("SET lock_timeout='8s'; BEGIN");
        roleChange = outcome(roleWriter.exec("UPDATE system_role SET rules='product.view' WHERE id=900"));
        adminAssignment = outcome(adminWriter.exec("UPDATE system_admin SET roles='50' WHERE id=200"));
        menuChange = outcome(menuWriter.exec('UPDATE system_menus SET access=0 WHERE id=2'));
        await waitForFinanceBlock(fixture.db, roleWriter.pid, savePid);
        await waitForFinanceBlock(fixture.db, adminWriter.pid, savePid);
        await waitForFinanceBlock(fixture.db, menuWriter.pid, savePid);
        expect(await snapshot()).toEqual(before);
        release.resolve(); const result = await saved; expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.body.status).toBe(200);
        expect((await roleChange).ok).toBe(true); expect((await adminAssignment).ok).toBe(true); expect((await menuChange).ok).toBe(true);
        await roleWriter.exec('COMMIT'); await adminWriter.exec('COMMIT'); await menuWriter.exec('COMMIT');
        const after = await snapshot();
        expect(after).toEqual({ admins: before.admins.map(row => row.id === 200 ? { ...row, roles: '50' } : row),
          roles: before.roles.map(row => row.id === 50 ? { ...row, roleName: '提交保持锁' } : row.id === 900 ? { ...row, rules: 'product.view' } : row),
          menus: before.menus.map(row => row.id === 2 ? { ...row, access: 0 } : row) });
        expect((await request(env, 'system_role/save', { id: 50, role_name: '被撤权后' })).body.status).toBe(400011);
        expect(await snapshot()).toEqual(after);
      } finally {
        release.resolve(); await saved; await roleChange; await adminAssignment; await menuChange;
        await roleWriter.exec('ROLLBACK'); await adminWriter.exec('ROLLBACK'); await menuWriter.exec('ROLLBACK');
      }
    }))));
  }, 60_000);
});
