import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { AppVariables, Env } from '@/env';
import { createContainer, createContainerFromDb, type DbClient } from '@/lib/di';
import { systemAdmin, systemMenus, systemRole } from '@/models/schema';
import { adminAuthorityOperation } from '@/models/schema/adminAuthorityOperation';
import { installAdminAuthorityOperation, assertAdminLegacyAdminOperationReady,
  ADMIN_AUTHORITY_OPERATION_RUNTIME_FUNCTIONS, ADMIN_AUTHORITY_OPERATION_RUNTIME_PRIVILEGES } from '@/migrations/adminAuthorityOperation';
import { installAdminLegacyAdminOperationUpgrade } from '@/migrations/runAdminLegacyAdminOperationUpgrade';
import { installRuntimeAdminBoundaryInTransaction } from '@/migrations/runtimeAdminBoundary';
import { runtimeBusinessPrivilegePlan } from '@/migrations/runtimeBusinessPrivilegePlan';
import { adminAuthMiddleware } from '@/middleware/admin-auth';
import { adminRuntimeAuthMiddleware } from '@/middleware/admin-runtime-auth';
import { adminLegacyAdminCreateForm, adminLegacyAdminEditForm, adminLegacyAdminCreate, adminLegacyAdminUpdate,
  adminLegacyAdminStatus, adminLegacyAdminDelete, adminLegacyAdminPreview, adminLegacyAdminReceipt,
  adminLegacyAdminResolve } from '@/controllers/api/v1/AdminLegacyAdminController';
import { AdminLegacyAdminWorkflowService, type LegacyAdminPreview, type LegacyAdminReceipt, type LegacyAdminActor,
  type LegacyAdminOperationKind } from '@/services/admin/AdminLegacyAdminWorkflowService';
import { ApiException, HttpApiException } from '@/utils/errors';
import { createToken, md5 } from '@/utils/jwt';
import { waitForFinanceBlock, outcome } from './helpers/financePeers';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';

type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type Peer = SequenceRunnerPeer & { role: string; connectionString: string };
type Intent = { operation_id: string; operation: LegacyAdminOperationKind; payload: Record<string, unknown> };
type Reply = { status: number; msg: string; data: unknown };
const password = 'owned-native-legacy-staff-password', key = 'owned-native-legacy-staff-key';
const baseEnv = { APP_KEY: key, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
const dialect = new PgDialect();
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
/** Observe actual transaction lifecycle and statements; never replace SQL,
 * isolation, connections or returned database rows. Loss is after real COMMIT. */
function observed(db: DbClient, options: { beforeCommit?: (tx: DbClient) => Promise<void>; afterCommit?: () => void; readOnly?: (tx: DbClient) => Promise<void> }): DbClient {
  return new Proxy(db, { get(database, key) {
    const method: unknown = Reflect.get(database, key); if (typeof method !== 'function') return method;
    if (key !== 'transaction') return method.bind(database);
    return (callback: (tx: DbClient) => Promise<unknown>, ...args: unknown[]) => {
      const completed: Promise<unknown> = Reflect.apply(method, database, [async (tx: DbClient) => {
        const result = await callback(new Proxy(tx, { get(transaction, field) {
          const operation: unknown = Reflect.get(transaction, field); if (typeof operation !== 'function') return operation;
          if (field !== 'execute') return operation.bind(transaction);
          return async (statement: SQL, ...parameters: unknown[]) => {
            const rows: unknown = await Reflect.apply(operation, transaction, [statement, ...parameters]);
            if (/^\s*SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY\s*$/i.test(dialect.sqlToQuery(statement).sql)) await options.readOnly?.(transaction);
            return rows;
          };
        } }));
        await options.beforeCommit?.(tx); return result;
      }, ...args]);
      return completed.then(result => { options.afterCommit?.(); return result; });
    };
  } });
}
function errors(app: Hono<{ Bindings: Env; Variables: AppVariables }>) {
  app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null },
    error instanceof HttpApiException ? error.httpStatus : error instanceof ApiException ? 200 : 500));
}
function readApplication(db: DbClient) {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>(); errors(app);
  app.use('*', async (c, next) => { c.set('container', createContainerFromDb(db)); await next(); });
  for (const prefix of ['/adminapi', '/api/admin']) {
    app.get(`${prefix}/setting/admin/create`, adminAuthMiddleware(), adminLegacyAdminCreateForm);
    app.get(`${prefix}/setting/admin/:id/edit`, adminAuthMiddleware(), adminLegacyAdminEditForm);
  }
  return app;
}
function application(observe?: Parameters<typeof observed>[1]) {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>(); errors(app);
  app.use('*', async (c, next) => {
    const container = createContainer(c.env); c.set('container', container);
    try { await next(); } finally { await container.db.$client.end({ timeout: 5 }); }
  });
  for (const prefix of ['/adminapi', '/api/admin']) {
    const middleware = adminRuntimeAuthMiddleware();
    const observer = async (c: Parameters<typeof adminLegacyAdminCreate>[0], next: () => Promise<void>) => {
      if (observe) c.set('container', createContainerFromDb(observed(c.get('container').db, observe))); await next();
    };
    app.post(`${prefix}/setting/admin-authority/preview`, middleware, observer, adminLegacyAdminPreview);
    app.get(`${prefix}/setting/admin-authority/receipt/:operationId`, middleware, observer, adminLegacyAdminReceipt);
    app.post(`${prefix}/setting/admin-authority/resolve`, middleware, observer, adminLegacyAdminResolve);
    app.post(`${prefix}/setting/admin`, middleware, observer, adminLegacyAdminCreate);
    app.put(`${prefix}/setting/admin/:id`, middleware, observer, adminLegacyAdminUpdate);
    app.put(`${prefix}/setting/set_status/:id/:status`, middleware, observer, adminLegacyAdminStatus);
    app.delete(`${prefix}/setting/admin/:id`, middleware, observer, adminLegacyAdminDelete);
  }
  return app;
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('legacy staff workflow on real PG16 SELECT-only reader and separate app/Admin LOGINs', () => {
  let fixture: Fixture, ddl: string, tokens: Map<number, string>;
  const actor = (id = 101): LegacyAdminActor => ({ id, authVersion: md5(password), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  beforeAll(async () => {
    const kit = await import('drizzle-kit/api'); ddl = (await kit.generateMigration(kit.generateDrizzleJson({}),
      kit.generateDrizzleJson({ systemAdmin, systemRole, systemMenus }))).join('\n');
  });
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native legacy staff forbids external I/O'));
    fixture = await sequenceRunnerDatabase();
    if (fixture.format !== 'pg16' || !fixture.withRuntimeRole || !fixture.withPeer) throw Error('Owned PG16 independent LOGINs required');
    await fixture.exec(ddl);
    await fixture.db.transaction(async tx => { await installAdminAuthorityOperation(tx); await installAdminLegacyAdminOperationUpgrade(tx); await assertAdminLegacyAdminOperationReady(tx); });
    await fixture.db.insert(systemMenus).values([
      { id: 1, authType: 0, menuName: '平台目录' },
      { id: 2, pid: 1, authType: 2, menuName: '商品读取', apiUrl: 'product/list', methods: 'GET' },
      { id: 3, authType: 2, menuName: 'opaque extension', apiUrl: 'owned-historical-extension', methods: 'GET' },
      { id: 4, authType: 2, menuName: '用户读取', apiUrl: 'user/list', methods: 'GET' },
    ]);
    await fixture.db.insert(systemRole).values([
      { id: 50, level: 2, roleName: '平台数字角色', rules: '1,2' },
      { id: 51, type: 1, level: 2, roleName: '旧opaque身份', rules: '3' },
      { id: 52, level: 2, roleName: '超出委派', rules: '4' },
      { id: 900, level: 1, rules: 'system.legacy_admin_manage,2,3' },
      { id: 901, level: 1, rules: 'system.legacy_admin_form_view,2,3' },
    ]);
    await fixture.db.insert(systemAdmin).values([
      { id: 100, account: 'native-super', pwd: password, level: 0 },
      { id: 101, account: 'native-manager', pwd: password, level: 1, roles: '900' },
      { id: 102, account: 'native-reader', pwd: password, level: 1, roles: '901' },
      { id: 103, account: 'native-manager-two', pwd: password, level: 1, roles: '900' },
      { id: 200, account: 'native-staff', pwd: password, phone: '13800000001', realName: '原始姓名', level: 2, roles: '50' },
      { id: 201, account: 'native-other-staff', pwd: password, phone: '13800000002', level: 2, roles: '50' },
    ]);
    await fixture.exec("SELECT setval(pg_get_serial_sequence('system_admin','id'),201,true)");
    tokens = new Map(); for (const id of [100, 101, 102, 103]) tokens.set(id, (await createToken(id, 'admin', md5(password), key)).token);
  }, 60000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await fixture?.close(); } }, 30000);
  const snapshot = async () => ({ admins: await fixture.db.select().from(systemAdmin).orderBy(systemAdmin.id),
    roles: await fixture.db.select().from(systemRole).orderBy(systemRole.id), menus: await fixture.db.select().from(systemMenus).orderBy(systemMenus.id),
    receipts: await fixture.db.select().from(adminAuthorityOperation).orderBy(adminAuthorityOperation.operationId) });
  async function identity(peer: Peer) {
    const [state] = await peer.exec("SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_database() AS database,current_setting('server_version_num') AS version");
    expect(state).toMatchObject({ role: peer.role, session: peer.role, pid: peer.pid }); expect(Math.floor(Number(state.version) / 10000)).toBe(16);
    const [attributes] = await peer.exec('SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    expect(attributes).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
  }
  async function runtime<T>(run: (env: Env, app: Peer, admin: Peer) => Promise<T>) {
    return fixture.withRuntimeRole!(async app => fixture.withRuntimeRole!(async admin => {
      await fixture.db.transaction(tx => installRuntimeAdminBoundaryInTransaction(tx, app.role, 'finance_test'));
      for (const [kind, peer] of [['app', app], ['admin', admin]] as const) {
        const plan = runtimeBusinessPrivilegePlan(kind), statements: string[] = [];
        for (const table of ['system_admin', 'system_role', 'system_menus'] as const) {
          statements.push(`GRANT ${plan.tables[table].join(',')} ON public.${table} TO "${peer.role}"`);
          if (plan.updateColumns[table]) statements.push(`GRANT UPDATE(${plan.updateColumns[table].join(',')}) ON public.${table} TO "${peer.role}"`);
          if (plan.tables[table].includes('INSERT')) statements.push(`GRANT USAGE ON SEQUENCE public.${table}_id_seq TO "${peer.role}"`);
        }
        const receiptRights = ADMIN_AUTHORITY_OPERATION_RUNTIME_PRIVILEGES[kind];
        if (receiptRights.length) statements.push(`GRANT ${receiptRights.join(',')} ON public.admin_authority_operation TO "${peer.role}"`);
        for (const signature of ADMIN_AUTHORITY_OPERATION_RUNTIME_FUNCTIONS[kind]) statements.push(`GRANT EXECUTE ON FUNCTION public.${signature} TO "${peer.role}"`);
        await fixture.exec(statements.join(';')); await identity(peer);
      }
      return run({ ...baseEnv, HYPERDRIVE: { connectionString: app.connectionString }, HYPERDRIVE_ADMIN: { connectionString: admin.connectionString } } as Env, app, admin);
    }));
  }
  async function request(env: Env, route: string, method = 'POST', body?: unknown, options: { prefix?: string; actor?: number; headers?: Record<string, string>; app?: ReturnType<typeof application> } = {}) {
    const response = await (options.app ?? application()).request(`http://local${options.prefix ?? '/adminapi'}/${route}`, { method,
      headers: { 'Authori-zation': `Bearer ${tokens.get(options.actor ?? 101)}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
    return { http: response.status, body: await response.json() as Reply };
  }
  const body = (id = 0) => ({ id, account: id ? 'renamed-native-staff' : 'created-native-staff', real_name: '原生管理员', phone: '13800000099', roles: [50, 51],
    pwd: id ? '' : 'native-created-password-1234', conf_pwd: id ? '' : 'native-created-password-1234', status: 1 });
  const intent = (operation: LegacyAdminOperationKind, payload: Record<string, unknown>): Intent => ({ operation_id: randomUUID(), operation, payload });
  async function preview(env: Env, input: Intent, options: Parameters<typeof request>[4] = {}) {
    const before = await snapshot(), reply = await request(env, 'setting/admin-authority/preview', 'POST', input, options);
    expect(reply.body.status, JSON.stringify(reply)).toBe(200); const value = reply.body.data as LegacyAdminPreview;
    expect(value).toMatchObject({ operation_id: input.operation_id, operation: input.operation, actor_id: options.actor ?? 101, requires_confirmation: true });
    expect(await snapshot()).toEqual(before); return value;
  }
  const headers = (input: Intent, value: LegacyAdminPreview) => ({ 'X-Admin-Operation-Id': input.operation_id, 'X-Admin-Revision': value.revision,
    'X-Admin-Expires-At': String(value.expires_at), 'X-Admin-Confirmed': 'true' });
  async function commit(env: Env, input: Intent, value: LegacyAdminPreview, options: Parameters<typeof request>[4] = {}) {
    const id = Number(input.payload.id); let route: string, method: string, payload: unknown;
    if (input.operation === 'legacy-admin-save') { route = `setting/admin${id ? `/${id}` : ''}`; method = id ? 'PUT' : 'POST'; const { id: ignored, ...seven } = input.payload; payload = seven; }
    else { route = input.operation === 'legacy-admin-status' ? `setting/set_status/${id}/${input.payload.status}` : `setting/admin/${id}`;
      method = input.operation === 'legacy-admin-status' ? 'PUT' : 'DELETE'; }
    return request(env, route, method, payload, { ...options, headers: { ...headers(input, value), ...options.headers } });
  }
  it('runs real SELECT-only RR READ ONLY form auth and seven-field controllers at both bases, with narrow reader/Admin/app privileges', async () => {
    await fixture.withRuntimeRole!(async reader => {
      await fixture.exec(`GRANT SELECT ON public.system_admin,public.system_role,public.system_menus TO "${reader.role}"`); await identity(reader);
      let readCount = 0;
      const app = readApplication(observed(reader.db, { readOnly: async tx => {
        const [state] = await tx.execute(sql`SELECT current_user AS role,session_user AS session,current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly`);
        expect(state).toMatchObject({ role: reader.role, session: reader.role, isolation: 'repeatable read', readonly: 'on' }); readCount++;
      } }));
      for (const prefix of ['/adminapi', '/api/admin']) for (const route of ['create', '200/edit']) {
        const response = await app.request(`http://local${prefix}/setting/admin/${route}`, { headers: { 'Authori-zation': `Bearer ${tokens.get(102)}` } }, baseEnv);
        const reply = await response.json() as Reply; expect(reply.status).toBe(200); expect(JSON.stringify(reply)).not.toContain(password);
        expect((reply.data as { rules: unknown[] }).rules).toHaveLength(7);
      }
      expect(readCount).toBe(4); await expect(reader.exec("UPDATE public.system_admin SET status=0 WHERE id=200")).rejects.toMatchObject({ code: '42501' });
    });
    await runtime(async (env, app, admin) => {
      await expect(app.exec('SELECT * FROM public.admin_authority_operation')).rejects.toMatchObject({ code: '42501' });
      await expect(app.exec('SELECT public.admin_authority_menu_lock_v1()')).rejects.toMatchObject({ code: '42501' });
      await admin.db.transaction(tx => assertAdminLegacyAdminOperationReady(tx));
      for (const prefix of ['/adminapi', '/api/admin']) {
        const input = intent('legacy-admin-save', body(200)), value = await preview(env, input, { prefix });
        expect(value.summary).toMatchObject({ before: { account: prefix === '/adminapi' ? 'native-staff' : 'renamed-native-staff' }, after: { account: 'renamed-native-staff', roles: [50, 51], password_changed: false } });
        const saved = await commit(env, input, value, { prefix }); expect(saved).toMatchObject({ http: 200, body: { status: 200, msg: '修改成功', data: { state: 'committed', result: { id: 200, created: false } } } });
        expect((await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, 200)))[0]).toMatchObject({ account: 'renamed-native-staff', pwd: password, roles: '50,51' });
      }
      const before = await snapshot();
      expect((await request(env, 'setting/admin', 'POST', body())).http).toBe(409);
      expect((await request(env, 'setting/admin-authority/preview', 'POST', intent('legacy-admin-save', body()), { actor: 102 })).body.status).not.toBe(200);
      expect(await snapshot()).toEqual(before);
    });
  });
  it('serializes two real Admin connections attempting duplicate account and phone, with only one committed business row/receipt', async () => {
    await runtime(async (env, _app, admin) => {
      const first = intent('legacy-admin-save', body()), second = intent('legacy-admin-save', body());
      const p1 = await preview(env, first), p2 = await preview(env, second, { actor: 103 });
      const replies = await Promise.all([commit(env, first, p1), commit(env, second, p2, { actor: 103 })]);
      expect(replies.filter(reply => reply.body.status === 200)).toHaveLength(1);
      expect(replies.filter(reply => reply.http === 409)).toHaveLength(1);
      const matching = await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.account, 'created-native-staff'));
      expect(matching).toHaveLength(1); expect((await snapshot()).receipts).toHaveLength(1);
      const phoneOnly = intent('legacy-admin-save', { ...body(), account: 'different-native-account' });
      expect((await request(env, 'setting/admin-authority/preview', 'POST', phoneOnly)).http).toBe(409);
      await expect(admin.exec('UPDATE public.admin_authority_operation SET actor_id=103')).rejects.toMatchObject({ code: '42501' });
    });
  });
  it('holds both authority table barriers and the complete menu lock until actual COMMIT while other LOGIN changes block', async () => {
    await runtime(async (_env, _app, admin) => fixture.withPeer!(async peer => {
      const claims = actor(), input = intent('legacy-admin-status', { id: 200, status: 0 });
      const service = new AdminLegacyAdminWorkflowService(createContainerFromDb(admin.db), key), value = await service.preview(input, claims);
      const entered = gate(), release = gate(); let transactionPid = 0;
      const guarded = new AdminLegacyAdminWorkflowService(createContainerFromDb(observed(admin.db, { beforeCommit: async tx => {
        const [state] = await tx.execute(sql`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('transaction_isolation') AS isolation`);
        expect(state).toMatchObject({ role: admin.role, session: admin.role, isolation: 'read committed' }); transactionPid = Number(state.pid);
        const locks = await tx.execute(sql`SELECT c.relname AS name,l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
          WHERE l.pid=pg_backend_pid() AND l.granted AND ((c.relname IN ('system_admin','system_role') AND l.mode='ShareRowExclusiveLock') OR (c.relname='system_menus' AND l.mode='ShareLock')) ORDER BY c.relname`);
        expect(Array.from(locks)).toEqual([{ name: 'system_admin', mode: 'ShareRowExclusiveLock' }, { name: 'system_menus', mode: 'ShareLock' }, { name: 'system_role', mode: 'ShareRowExclusiveLock' }]);
        entered.release(); await release.promise;
      } })), key);
      const applied = outcome(guarded.commit({ ...input, revision: value.revision, expires_at: value.expires_at, confirmed: true }, claims));
      await entered.promise;
      const changing = outcome(peer.exec("UPDATE public.system_role SET role_name='after-real-commit' WHERE id=50"));
      try { await waitForFinanceBlock(fixture.db, peer.pid, transactionPid); } finally { release.release(); }
      expect((await applied).ok).toBe(true); expect((await changing).ok).toBe(true);
      expect((await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, 200)))[0].status).toBe(0);
      expect((await snapshot()).receipts).toHaveLength(1);
    }));
  });
  it('rejects post-preview target/menu/role/actor-password changes read by real independent LOGINs without mutation deltas', async () => {
    await runtime(async (env) => fixture.withPeer!(async peer => {
      for (const change of ["UPDATE system_admin SET last_ip='127.0.0.2' WHERE id=200", "UPDATE system_role SET role_name='changed-live-role' WHERE id=50",
        "UPDATE system_menus SET menu_name='changed-live-menu' WHERE id=2", "UPDATE system_admin SET pwd='changed-live-password' WHERE id=101"]) {
        const input = intent('legacy-admin-save', body(200)), value = await preview(env, input);
        await peer.exec(change); const afterChange = await snapshot();
        expect((await commit(env, input, value)).body.status).not.toBe(200); expect(await snapshot()).toEqual(afterChange);
      }
    }));
  });
  it.each(['skip', 'protected-rewrite', 'readback-rewrite', 'receipt-failure'] as const)('rolls back real trigger %s with no partial staff or receipt', async sabotage => {
    await runtime(async (env) => {
      const input = intent('legacy-admin-save', body(200)), value = await preview(env, input), before = await snapshot();
      const definition = sabotage === 'receipt-failure'
        ? `CREATE FUNCTION owned_legacy_sabotage() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
          INSERT INTO public.admin_authority_operation(operation_id,actor_id,admin_type,relation_id,operation,request_hash,revision,state,result,created_at)
          VALUES('${input.operation_id}',101,1,0,'legacy-admin-save','','','not_applied',NULL,extract(epoch from now())::integer); RETURN NEW;
          END $$; CREATE TRIGGER owned_legacy_sabotage AFTER UPDATE ON system_admin FOR EACH ROW EXECUTE FUNCTION owned_legacy_sabotage()`
        : sabotage === 'skip' ? "CREATE FUNCTION owned_legacy_sabotage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER owned_legacy_sabotage BEFORE UPDATE ON system_admin FOR EACH ROW EXECUTE FUNCTION owned_legacy_sabotage()"
          : sabotage === 'protected-rewrite' ? "CREATE FUNCTION owned_legacy_sabotage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.relation_id=9; RETURN NEW; END $$; CREATE TRIGGER owned_legacy_sabotage BEFORE UPDATE ON system_admin FOR EACH ROW EXECUTE FUNCTION owned_legacy_sabotage()"
            : "CREATE FUNCTION owned_legacy_sabotage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF pg_trigger_depth()=1 THEN UPDATE system_admin SET head_pic='after-returning-rewrite' WHERE id=NEW.id; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_legacy_sabotage AFTER UPDATE ON system_admin FOR EACH ROW EXECUTE FUNCTION owned_legacy_sabotage()";
      await fixture.exec(definition);
      expect((await commit(env, input, value)).body.status).not.toBe(200); expect(await snapshot()).toEqual(before);
    });
  });
  it('preserves inactive assigned numeric-role identity for repair/retirement while rejecting missing/foreign/malformed bindings', async () => {
    await runtime(async (env, app) => {
      await fixture.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 50));
      const form = await new AdminLegacyAdminWorkflowService(createContainerFromDb(app.db), key).editForm('200', new URLSearchParams(), actor());
      expect(form.rules.find(row => row.field === 'roles')?.value).toEqual([50]);
      expect(form.rules.find(row => row.field === 'roles')?.options?.find(option => option.value === 50)?.label).toContain('请移除');
      const repair = intent('legacy-admin-save', { ...body(200), roles: [51] }), value = await preview(env, repair);
      expect((await commit(env, repair, value)).body.status).toBe(200);
      const disable = intent('legacy-admin-status', { id: 201, status: 0 }), disabling = await preview(env, disable);
      expect((await commit(env, disable, disabling)).body.status).toBe(200);
      const removal = intent('legacy-admin-delete', { id: 201 }), removing = await preview(env, removal);
      expect((await commit(env, removal, removing)).body.status).toBe(200);
      for (const roles of ['999', '52,999']) {
        await fixture.db.update(systemAdmin).set({ roles }).where(eq(systemAdmin.id, 200)); const before = await snapshot();
        expect((await request(env, 'setting/admin-authority/preview', 'POST', intent('legacy-admin-delete', { id: 200 }))).body.status).not.toBe(200);
        expect(await snapshot()).toEqual(before);
      }
    });
  });
  it('recovers original actual COMMIT after lost response, permits only original actor, preserves unknown and permanently seals absent key', async () => {
    await runtime(async (env) => {
      const input = intent('legacy-admin-save', body()), value = await preview(env, input);
      const lost = application({ afterCommit: () => { throw Error('owned response lost after real database COMMIT'); } });
      const reply = await commit(env, input, value, { app: lost }); expect(reply.http).toBe(500);
      const afterCommit = await snapshot(); expect(afterCommit.receipts).toHaveLength(1);
      const recovered = await request(env, `setting/admin-authority/receipt/${input.operation_id}?operation=${input.operation}`, 'GET');
      expect(recovered.body.data).toMatchObject({ state: 'committed', request_hash: value.request_hash, result: { created: true } });
      const createdId = (recovered.body.data as LegacyAdminReceipt).result!.id;
      const [stored] = await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, createdId));
      expect(await bcrypt.compare('native-created-password-1234', stored.pwd)).toBe(true);
      expect((await commit(env, input, value)).body.data).toEqual(recovered.body.data); expect(await snapshot()).toEqual(afterCommit);
      expect((await request(env, `setting/admin-authority/receipt/${input.operation_id}?operation=${input.operation}`, 'GET', undefined, { actor: 103 })).body.status).not.toBe(200);
      await fixture.db.update(systemRole).set({ rules: 'product.view' }).where(eq(systemRole.id, 900));
      expect((await request(env, `setting/admin-authority/receipt/${input.operation_id}?operation=${input.operation}`, 'GET')).body.data).toEqual(recovered.body.data);
      const absent = intent('legacy-admin-delete', { id: 200 });
      expect((await request(env, `setting/admin-authority/receipt/${absent.operation_id}?operation=${absent.operation}`, 'GET')).body.data).toMatchObject({ state: 'unknown' });
      expect((await request(env, 'setting/admin-authority/resolve', 'POST', { operation_id: absent.operation_id, operation: absent.operation })).body.data).toMatchObject({ state: 'not_applied', result: null });
      await fixture.db.update(systemRole).set({ rules: 'system.legacy_admin_manage,2,3' }).where(eq(systemRole.id, 900));
      expect((await request(env, 'setting/admin-authority/preview', 'POST', absent)).http).toBe(409);
      expect((await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, 200)))[0].isDel).toBe(0);
      const oldToken = tokens.get(101)!;
      await fixture.db.update(systemAdmin).set({ pwd: 'new-live-owner-password' }).where(eq(systemAdmin.id, 101));
      tokens.set(101, (await createToken(101, 'admin', md5('new-live-owner-password'), key)).token);
      expect((await request(env, `setting/admin-authority/receipt/${input.operation_id}?operation=${input.operation}`, 'GET')).body.data).toEqual(recovered.body.data);
      expect((await request(env, `setting/admin-authority/receipt/${input.operation_id}?operation=${input.operation}`, 'GET', undefined,
        { headers: { 'Authori-zation': `Bearer ${oldToken}` } })).body.status).not.toBe(200);
    });
  });
  it('serializes actual commit versus permanent resolve on independent request pools with exactly one durable outcome', async () => {
    await runtime(async (env) => {
      const input = intent('legacy-admin-status', { id: 200, status: 0 }), value = await preview(env, input);
      const replies = await Promise.all([commit(env, input, value), request(env, 'setting/admin-authority/resolve', 'POST',
        { operation_id: input.operation_id, operation: input.operation })]);
      expect(replies.some(reply => reply.body.status === 200)).toBe(true);
      const receipt = await request(env, `setting/admin-authority/receipt/${input.operation_id}?operation=${input.operation}`, 'GET');
      expect(receipt.body.status).toBe(200); const result = receipt.body.data as LegacyAdminReceipt;
      expect(['committed', 'not_applied']).toContain(result.state);
      const rows = (await snapshot()).receipts.filter(row => row.operationId === input.operation_id); expect(rows).toHaveLength(1);
      expect((await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, 200)))[0].status).toBe(result.state === 'committed' ? 0 : 1);
      expect((await commit(env, input, value)).body.status).toBe(result.state === 'committed' ? 200 : 409);
    });
  });
  it('uses six canonical staff URLs for create, edit, independent status, soft delete and narrow realm/self refusal at both bases', async () => {
    await runtime(async (env) => {
      for (const [index, prefix] of ['/adminapi', '/api/admin'].entries()) {
        const input = intent('legacy-admin-save', { ...body(), account: `staff-base-${index}`, phone: `1380000008${index}` }), value = await preview(env, input, { prefix });
        const created = await commit(env, input, value, { prefix }); expect(created.body.status).toBe(200);
        const id = (created.body.data as LegacyAdminReceipt).result!.id;
        const status = intent('legacy-admin-status', { id, status: 0 }), statusPreview = await preview(env, status, { prefix });
        expect((await commit(env, status, statusPreview, { prefix })).body.msg).toBe('关闭成功');
        const removal = intent('legacy-admin-delete', { id }), deletePreview = await preview(env, removal, { prefix });
        expect((await commit(env, removal, deletePreview, { prefix })).body.data).toMatchObject({ result: { id, deleted: true } });
        expect((await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, id)))[0]).toMatchObject({ level: 2, status: 0, isDel: 1 });
      }
      const before = await snapshot();
      for (const id of [100, 101]) expect((await request(env, 'setting/admin-authority/preview', 'POST', intent('legacy-admin-delete', { id }))).body.status).not.toBe(200);
      expect(await snapshot()).toEqual(before);
    });
  });
  it('persists and reads actor9 to true next-level10 rows on PG16 without silently imposing the modern0..9 target policy', async () => {
    await fixture.db.update(systemAdmin).set({ level: 9 }).where(eq(systemAdmin.id, 101));
    await fixture.db.update(systemRole).set({ level: 10 }).where(inArray(systemRole.id, [50, 51]));
    await runtime(async (env, app) => {
      const input = intent('legacy-admin-save', body()), value = await preview(env, input);
      expect(value.summary.after.level).toBe(10);
      const reply = await commit(env, input, value); expect(reply.body.status).toBe(200);
      const id = (reply.body.data as LegacyAdminReceipt).result!.id;
      const edited = await new AdminLegacyAdminWorkflowService(createContainerFromDb(app.db), key).editForm(String(id), new URLSearchParams(), actor());
      expect(edited.rules.find(rule => rule.field === 'roles')?.value).toEqual([50, 51]);
      expect((await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, id)))[0]).toMatchObject({ level: 10, roles: '50,51' });
      const removal = intent('legacy-admin-delete', { id }), p = await preview(env, removal);
      expect((await commit(env, removal, p)).body.status).toBe(200);
    });
  });
});
