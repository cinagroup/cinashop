import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { AppVariables, Env } from '../src/env';
import { createContainer, createContainerFromDb, type DbClient } from '../src/lib/di';
import { systemAdmin, systemMenus, systemRole } from '../src/models/schema';
import { adminAuthMiddleware } from '../src/middleware/admin-auth';
import { adminRuntimeAuthMiddleware } from '../src/middleware/admin-runtime-auth';
import { installRuntimeAdminBoundaryInTransaction } from '../src/migrations/runtimeAdminBoundary';
import { runtimeBusinessPrivilegePlan } from '../src/migrations/runtimeBusinessPrivilegePlan';
import { adminLegacyRoleCreateForm, adminLegacyRoleEditForm, adminLegacyRoleSave } from '../src/controllers/api/v1/AdminLegacyRoleController';
import { ApiException, HttpApiException } from '../src/utils/errors';
import { createToken, md5 } from '../src/utils/jwt';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';

type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type LoginPeer = SequenceRunnerPeer & { role: string; connectionString: string };
type Reply<T = unknown> = { status: number; msg: string; data: T };
type MenuNode = { id: number; pid: number; title: string; children: MenuNode[] };
type Form = { menus: MenuNode[]; role?: { id: number; type: number; relation_id: number;
  role_name: string; rules: string; level: number; status: number } };
const password = 'owned-native-legacy-role-password';
const dialect = new PgDialect();
const baseEnv = { APP_KEY: 'owned-native-legacy-role-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
const flatten = (nodes: MenuNode[]): number[] => nodes.flatMap(node => [node.id, ...flatten(node.children)]);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Observe the actual completed SET statement on the original transaction.
 * No query, row, isolation option or database connection is substituted. */
function observeReadOnly(db: DbClient, observe: (tx: DbClient) => Promise<void>): DbClient {
  return new Proxy(db, {
    get(target, property) {
      const method: unknown = Reflect.get(target, property);
      if (typeof method !== 'function') return method;
      if (property !== 'transaction') return method.bind(target);
      return (callback: unknown, ...options: unknown[]) => {
        if (typeof callback !== 'function') throw Error('Missing real role-form transaction callback');
        return Reflect.apply(method, target, [(tx: DbClient) => callback(new Proxy(tx, {
          get(transaction, key) {
            const operation: unknown = Reflect.get(transaction, key);
            if (typeof operation !== 'function') return operation;
            if (key !== 'execute') return operation.bind(transaction);
            return async (...args: unknown[]) => {
              const rows: unknown = await Reflect.apply(operation, transaction, args);
              if (/^\s*SET\s+TRANSACTION\s+ISOLATION\s+LEVEL\s+REPEATABLE\s+READ\s*,\s*READ\s+ONLY\s*$/i
                .test(dialect.sqlToQuery(args[0] as SQL).sql)) await observe(transaction);
              return rows;
            };
          },
        })), ...options]);
      };
    },
  });
}

/** Await the real service callback after every statement has finished, before
 * postgres-js COMMIT. Its original result, statements and rows are unchanged. */
function observeBeforeCommit(db: DbClient, observe: (tx: DbClient) => Promise<void>): DbClient {
  return new Proxy(db, {
    get(target, property) {
      const method: unknown = Reflect.get(target, property);
      if (typeof method !== 'function') return method;
      if (property !== 'transaction') return method.bind(target);
      return (callback: unknown, ...options: unknown[]) => {
        if (typeof callback !== 'function') throw Error('Missing real role-write transaction callback');
        return Reflect.apply(method, target, [async (tx: DbClient) => {
          const result: unknown = await callback(tx);
          await observe(tx);
          return result;
        }, ...options]);
      };
    },
  });
}

function errors(app: Hono<{ Bindings: Env; Variables: AppVariables }>) {
  app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500,
    msg: error.message, data: null }, error instanceof HttpApiException ? error.httpStatus : 200));
}

/** SELECT-only GETs use real Admin authentication/controller on the reader DB.
 * This local Hono mount is not a claim about deployment or full-app routing. */
function readApplication(db: DbClient) {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  const container = createContainerFromDb(db);
  app.use('*', async (c, next) => { c.set('container', container); await next(); });
  errors(app);
  for (const prefix of ['/adminapi', '/api/admin']) {
    app.get(`${prefix}/setting/role/create`, adminAuthMiddleware(), adminLegacyRoleCreateForm);
    app.get(`${prefix}/setting/role/:id/edit`, adminAuthMiddleware(), adminLegacyRoleEditForm);
  }
  return app;
}

/** Actual application authentication followed by the real independent ADMIN
 * connection factory, middleware and controller; every request pool is closed. */
function writeApplication(beforeCommit?: (tx: DbClient) => Promise<void>) {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use('*', async (c, next) => {
    const application = createContainer(c.env);
    c.set('container', application);
    try { await next(); } finally { await application.db.$client.end({ timeout: 5 }); }
  });
  errors(app);
  for (const prefix of ['/adminapi', '/api/admin']) {
    app.post(`${prefix}/setting/role/:id`, adminRuntimeAuthMiddleware(), async (c, next) => {
      if (beforeCommit) c.set('container', createContainerFromDb(observeBeforeCommit(c.get('container').db, beforeCommit)));
      await next();
    }, adminLegacyRoleSave);
  }
  return app;
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Legacy role forms and atomic delegation on real PG16 application/Admin LOGINs', () => {
  let fixture: Fixture;
  let ddl: string;
  let tokens: { reader: string; manager: string; numericManager: string };

  beforeAll(async () => {
    const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}),
      kit.generateDrizzleJson({ systemAdmin, systemRole, systemMenus }))).join('\n');
  });
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native legacy roles forbid external I/O'));
    fixture = await sequenceRunnerDatabase();
    if (fixture.format !== 'pg16' || !fixture.withRuntimeRole || !fixture.withPeer) throw Error('Real PG16 LOGIN peers required');
    await fixture.exec(ddl);
    await fixture.db.insert(systemMenus).values([
      { id: 1, pid: 0, type: 1, authType: 0, menuName: '业务目录' },
      { id: 2, pid: 1, type: 1, authType: 2, menuName: '商品读取', apiUrl: 'product/list', methods: 'GET' },
      { id: 3, pid: 0, type: 1, authType: 2, menuName: '旧角色保存', apiUrl: 'setting/role/:id', methods: 'POST' },
      { id: 4, pid: 0, type: 1, authType: 2, menuName: '有权限的父节点', apiUrl: 'product/list', methods: 'GET' },
      { id: 5, pid: 4, type: 1, authType: 2, menuName: '有权限的子节点', apiUrl: 'order/list', methods: 'GET' },
      { id: 8, pid: 0, type: 4, authType: 2, menuName: '供应商目录', apiUrl: 'product/list', methods: 'GET' },
    ]);
    await fixture.db.insert(systemRole).values([
      { id: 50, type: 0, relationId: 0, level: 2, roleName: '下一级角色', rules: '2', status: 1 },
      { id: 51, type: 0, relationId: 0, level: 2, roleName: '仅父权限', rules: '4', status: 1 },
      { id: 52, type: 1, relationId: 0, level: 2, roleName: '仅子权限', rules: '5', status: 1 },
      { id: 53, type: 0, relationId: 0, level: 2, roleName: '父子权限', rules: '4,5', status: 1 },
      { id: 60, type: 1, relationId: 0, level: 3, roleName: '其他层级', rules: '2', status: 1 },
      { id: 70, type: 4, relationId: 7, level: 2, roleName: '外域角色', rules: '8', status: 1 },
      { id: 900, type: 0, relationId: 0, level: 1, roleName: '表单只读', rules: 'system.legacy_role_form_view,2,4,5' },
      { id: 901, type: 1, relationId: 0, level: 1, roleName: '当前管理员', rules: 'system.manage,2,4,5' },
      { id: 902, type: 0, relationId: 0, level: 1, roleName: '旧数字管理员', rules: '3,2' },
    ]);
    await fixture.db.insert(systemAdmin).values([100, 101, 102].map((id, index) => ({ id,
      account: `owned-legacy-role-${id}`, pwd: password, adminType: 1, relationId: 0, level: 1,
      roles: String(900 + index) })));
    await fixture.exec("SELECT setval(pg_get_serial_sequence('system_role','id'),902,true)");
    tokens = { reader: (await createToken(100, 'admin', md5(password), baseEnv.APP_KEY)).token,
      manager: (await createToken(101, 'admin', md5(password), baseEnv.APP_KEY)).token,
      numericManager: (await createToken(102, 'admin', md5(password), baseEnv.APP_KEY)).token };
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
    const [row] = await peer.exec(`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,
      current_setting('server_version_num') AS version,current_database() AS database`);
    expect(row).toMatchObject({ role: peer.role, session: peer.role, pid: peer.pid });
    expect(Math.floor(Number(row.version) / 10_000)).toBe(16);
    const [attributes] = await peer.exec('SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    expect(attributes).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    return row;
  }
  async function read<T>(run: (peer: LoginPeer) => Promise<T>) {
    return fixture.withRuntimeRole!(async peer => {
      await fixture.exec(`GRANT SELECT ON public.system_admin,public.system_role,public.system_menus TO "${peer.role}"`);
      await identity(peer);
      return run(peer);
    });
  }
  async function runtime<T>(run: (env: Env, appRole: LoginPeer, adminRole: LoginPeer) => Promise<T>) {
    return fixture.withRuntimeRole!(async appRole => fixture.withRuntimeRole!(async adminRole => {
      await fixture.db.transaction(tx => installRuntimeAdminBoundaryInTransaction(tx, appRole.role, 'finance_test'));
      for (const [kind, peer] of [['app', appRole], ['admin', adminRole]] as const) {
        const plan = runtimeBusinessPrivilegePlan(kind);
        const grants: string[] = [];
        for (const table of ['system_admin', 'system_role', 'system_menus'] as const) {
          grants.push(`GRANT ${plan.tables[table].join(',')} ON public.${table} TO "${peer.role}"`);
          if (plan.updateColumns[table]) grants.push(`GRANT UPDATE(${plan.updateColumns[table].join(',')}) ON public.${table} TO "${peer.role}"`);
          if (plan.tables[table].includes('INSERT')) grants.push(`GRANT USAGE ON SEQUENCE public.${table}_id_seq TO "${peer.role}"`);
        }
        await fixture.exec(grants.join(';'));
      }
      await identity(appRole); await identity(adminRole);
      const env = { ...baseEnv, HYPERDRIVE: { connectionString: appRole.connectionString },
        HYPERDRIVE_ADMIN: { connectionString: adminRole.connectionString } } as Env;
      try { return await run(env, appRole, adminRole); }
      finally {
        const [state] = await fixture.db.execute(sql`SELECT count(*)::integer AS remaining FROM pg_stat_activity
          WHERE datname=current_database() AND application_name IN ('cinashop_admin','cinashop_api')`);
        expect(state.remaining).toBe(0);
      }
    }));
  }
  async function post(app: ReturnType<typeof writeApplication>, env: Env, token = tokens.manager, id = 0,
    body = { id, role_name: '原生委派角色', status: 1, checked_menus: [1, 2] }, prefix = '/adminapi') {
    const response = await app.request(`http://local${prefix}/setting/role/${id}`, { method: 'POST',
      headers: { 'Authori-zation': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env);
    return { http: response.status, body: await response.json() as Reply<{ id: number; created: boolean }> };
  }

  it('uses SELECT-only RR READ ONLY forms and independently authenticated restricted Admin writes with exact row deltas', async () => {
    const before = await snapshot();
    await read(async peer => {
      const rights = await peer.exec(`SELECT name,has_table_privilege(current_user,'public.'||name,'SELECT') AS read,
        has_table_privilege(current_user,'public.'||name,'INSERT') AS "insert",
        has_table_privilege(current_user,'public.'||name,'UPDATE') AS "update",
        has_table_privilege(current_user,'public.'||name,'DELETE') AS "delete"
        FROM (VALUES ('system_admin'),('system_role'),('system_menus')) AS t(name) ORDER BY name`);
      expect(rights).toHaveLength(3);
      expect(rights.every(row => row.read && !row.insert && !row.update && !row.delete)).toBe(true);
      let observed = 0;
      const app = readApplication(observeReadOnly(peer.db, async tx => {
        const [state] = await tx.execute(sql`SELECT pg_backend_pid() AS pid,current_user AS role,session_user AS session,
          current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly`);
        expect(state).toEqual({ pid: peer.pid, role: peer.role, session: peer.role, isolation: 'repeatable read', readonly: 'on' });
        observed++;
      }));
      for (const [prefix, suffix] of [['/adminapi', 'create'], ['/api/admin', '50/edit']] as const) {
        const response = await app.request(`http://local${prefix}/setting/role/${suffix}`,
          { headers: { 'Authori-zation': `Bearer ${tokens.reader}` } }, baseEnv);
        const body = await response.json() as Reply<Form>;
        expect(body.status).toBe(200); expect(flatten(body.data.menus)).toContain(2);
        expect(flatten(body.data.menus)).not.toContain(8);
        if (suffix === '50/edit') expect(body.data.role).toMatchObject({ id: 50, type: 0, relation_id: 0,
          level: 2, rules: '2', role_name: '下一级角色', status: 1 });
      }
      expect(observed).toBe(2);
      await expect(peer.exec("UPDATE system_role SET rules='system.manage' WHERE id=50")).rejects.toMatchObject({ code: '42501' });
      await expect(peer.exec('UPDATE system_admin SET login_count=99 WHERE id=100')).rejects.toMatchObject({ code: '42501' });
      await expect(peer.exec('DELETE FROM system_menus WHERE id=2')).rejects.toMatchObject({ code: '42501' });
    });
    expect(await snapshot()).toEqual(before);
    await runtime(async (env, appRole, adminRole) => {
      await expect(appRole.exec("INSERT INTO system_role(id,type,relation_id,level,role_name,rules) VALUES(999,0,0,2,'越权','2')"))
        .rejects.toMatchObject({ code: '42501' });
      await expect(appRole.exec("UPDATE system_role SET rules='system.manage' WHERE id=50")).rejects.toMatchObject({ code: '42501' });
      await expect(appRole.exec('UPDATE system_menus SET id=99 WHERE id=2')).rejects.toMatchObject({ code: '42501' });
      // The real Admin profile has table UPDATE, required by the common table
      // barrier. Unlike app, raw Admin SQL can update roles: prove and roll back
      // that fact instead of retaining the former column-grant 42501 oracle.
      await adminRole.exec('BEGIN');
      try {
        expect(await adminRole.exec("UPDATE system_admin SET roles='901' WHERE id=100 RETURNING id,roles"))
          .toEqual([{ id: 100, roles: '901' }]);
      } finally { await adminRole.exec('ROLLBACK'); }
      let observedWrites = 0;
      const app = writeApplication(async tx => {
        const [state] = await tx.execute(sql`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,
          current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation`);
        expect(state).toMatchObject({ role: adminRole.role, session: adminRole.role, readonly: 'off', isolation: 'read committed' });
        expect(state.pid).not.toBe(appRole.pid); observedWrites++;
      });
      const created = await post(app, env);
      expect(created.body.status).toBe(200);
      const afterCreate = await snapshot();
      const added = afterCreate.roles.filter(row => !before.roles.some(old => old.id === row.id));
      expect(added).toHaveLength(1);
      expect(added[0]).toEqual({ id: created.body.data.id, type: 0, relationId: 0, roleName: '原生委派角色', rules: '2', level: 2, status: 1 });
      expect(afterCreate.roles.filter(row => row.id !== added[0].id)).toEqual(before.roles);
      expect(afterCreate.admins).toEqual(before.admins); expect(afterCreate.menus).toEqual(before.menus);
      const edited = await post(app, env, tokens.manager, 50,
        { id: 50, role_name: '原生角色更新', status: 0, checked_menus: [1, 2] }, '/api/admin');
      expect(edited.body.status).toBe(200); expect(observedWrites).toBe(2);
      const after = await snapshot();
      expect(after.roles).toEqual(afterCreate.roles.map(row => row.id === 50 ? { ...row, roleName: '原生角色更新', status: 0 } : row));
      expect(after.admins).toEqual(before.admins); expect(after.menus).toEqual(before.menus);
      await read(async peer => {
        const reader = readApplication(peer.db);
        for (const [id, rules] of [[51, '4'], [52, '5'], [53, '4,5']] as const) {
          const response = await reader.request(`http://local/adminapi/setting/role/${id}/edit`,
            { headers: { 'Authori-zation': `Bearer ${tokens.reader}` } }, baseEnv);
          const form = await response.json() as Reply<Form>;
          expect(form.status).toBe(200); expect(form.data.role?.rules).toBe(rules);
          expect(form.data.menus.every(node => node.children.length === 0)).toBe(true);
          expect(new Set(form.data.menus.map(node => node.id)).size).toBe(form.data.menus.length);
          expect(form.data.menus.find(node => node.id === 4)?.pid).toBe(0);
          expect(form.data.menus.find(node => node.id === 5)?.pid).toBe(4);
          // Exact checked-state rule from old Vue initMenu. Since each grant is
          // an independent leaf, getCheckedAndIndeterminateNodes cannot infer
          // extra parent grants or silently drop an existing parent-only grant.
          const checkMenus = ',' + form.data.role!.rules + ',';
          const initialized = form.data.menus.map(menu => ({ id: menu.id,
            checked: checkMenus.indexOf(String(',' + menu.id + ',')) !== -1 }));
          const checked = initialized.filter(node => node.checked).map(node => node.id).sort((a, b) => a - b);
          expect(checked.join(',')).toBe(rules);
          const saved = await post(app, env, tokens.manager, id,
            { id, role_name: `仅改名-${id}`, status: 1, checked_menus: checked });
          expect(saved.body.status).toBe(200);
        }
      });
      expect(observedWrites).toBe(5);
      const afterRenames = await snapshot();
      expect(afterRenames.roles).toEqual(after.roles.map(row => [51, 52, 53].includes(row.id)
        ? { ...row, roleName: `仅改名-${row.id}` } : row));
      expect(afterRenames.admins).toEqual(before.admins); expect(afterRenames.menus).toEqual(before.menus);
    });
  }, 60_000);

  it('rejects a concurrent assigned-role revocation with controlled NOWAIT conflict and rejects its committed state', async () => {
    await runtime(async env => fixture.withPeer!(async writer => {
      const before = await snapshot();
      await writer.exec("BEGIN; UPDATE system_role SET rules='2' WHERE id=901");
      try {
        const conflicted = await post(writeApplication(), env);
        expect(conflicted).toMatchObject({ http: 409, body: { status: 409, data: null } });
        expect(await snapshot()).toEqual(before);
        await writer.exec('COMMIT');
        const rejected = await post(writeApplication(), env);
        expect(rejected.body.status).toBe(400011);
        expect(await snapshot()).toEqual({ ...before, roles: before.roles.map(row => row.id === 901 ? { ...row, rules: '2' } : row) });
      } finally { await writer.exec('ROLLBACK'); }
    }));
  }, 60_000);

  it('locks the real numeric authority menu and rejects its concurrent and committed revocation', async () => {
    await runtime(async env => fixture.withPeer!(async writer => {
      const before = await snapshot();
      await writer.exec('BEGIN; UPDATE system_menus SET access=0 WHERE id=3');
      try {
        const conflicted = await post(writeApplication(), env, tokens.numericManager);
        expect(conflicted).toMatchObject({ http: 409, body: { status: 409, data: null } });
        expect(await snapshot()).toEqual(before);
        await writer.exec('COMMIT');
        const rejected = await post(writeApplication(), env, tokens.numericManager);
        expect(rejected.body.status).toBe(400011);
        expect(await snapshot()).toEqual({ ...before, menus: before.menus.map(row => row.id === 3 ? { ...row, access: 0 } : row) });
      } finally { await writer.exec('ROLLBACK'); }
    }));
  }, 60_000);

  it('retains both authority role and menu locks until the real save transaction commits', async () => {
    await runtime(async (env, _appRole, adminRole) => fixture.withPeer!(async roleWriter => fixture.withPeer!(async menuWriter => {
      const before = await snapshot();
      const ready = deferred(), release = deferred();
      let savePid = 0;
      const app = writeApplication(async tx => {
        const [state] = await tx.execute(sql`SELECT pg_backend_pid() AS pid,current_user AS role,session_user AS session,
          current_database() AS database,current_setting('transaction_read_only') AS readonly`);
        expect(state).toMatchObject({ role: adminRole.role, session: adminRole.role, readonly: 'off' });
        const [peer] = await roleWriter.exec('SELECT current_database() AS database');
        expect(state.database).toBe(peer.database);
        savePid = Number(state.pid); ready.resolve(); await release.promise;
      });
      const pendingSave = outcome(post(app, env));
      let roleRevocation: ReturnType<typeof outcome> | undefined;
      let menuRevocation: ReturnType<typeof outcome> | undefined;
      try {
        await Promise.race([ready.promise, pendingSave.then(() => { throw Error('Save ended before its real pre-COMMIT barrier'); })]);
        expect(new Set([savePid, roleWriter.pid, menuWriter.pid]).size).toBe(3);
        await roleWriter.exec("SET lock_timeout='8s'; BEGIN"); await menuWriter.exec("SET lock_timeout='8s'; BEGIN");
        roleRevocation = outcome(roleWriter.exec("UPDATE system_role SET rules='2' WHERE id=901"));
        menuRevocation = outcome(menuWriter.exec('UPDATE system_menus SET access=0 WHERE id=2'));
        await waitForFinanceBlock(fixture.db, roleWriter.pid, savePid);
        await waitForFinanceBlock(fixture.db, menuWriter.pid, savePid);
        expect(await snapshot()).toEqual(before); // The completed INSERT is still uncommitted.
        release.resolve();
        const saved = await pendingSave; expect(saved.ok).toBe(true);
        if (saved.ok) expect(saved.value.body.status).toBe(200);
        expect((await roleRevocation).ok).toBe(true); expect((await menuRevocation).ok).toBe(true);
        await roleWriter.exec('COMMIT'); await menuWriter.exec('COMMIT');
        const after = await snapshot();
        const newId = saved.ok ? saved.value.body.data.id : 0;
        expect(after.roles).toEqual([...before.roles.map(row => row.id === 901 ? { ...row, rules: '2' } : row),
          { id: newId, type: 0, relationId: 0, roleName: '原生委派角色', rules: '2', level: 2, status: 1 }].sort((a, b) => a.id - b.id));
        expect(after.menus).toEqual(before.menus.map(row => row.id === 2 ? { ...row, access: 0 } : row));
        expect(after.admins).toEqual(before.admins);
        expect((await post(writeApplication(), env)).body.status).toBe(400011);
        expect(await snapshot()).toEqual(after);
      } finally {
        release.resolve(); await pendingSave;
        await roleRevocation; await menuRevocation;
        await roleWriter.exec('ROLLBACK'); await menuWriter.exec('ROLLBACK');
      }
    })));
  }, 60_000);
});
