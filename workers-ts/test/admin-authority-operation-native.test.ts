import bcrypt from 'bcryptjs';
import { Hono, type Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainer, createContainerFromDb, type DbClient } from '../src/lib/di';
import { systemAdmin, systemMenus, systemRole } from '../src/models/schema';
import { adminAuthorityOperation } from '../src/models/schema/adminAuthorityOperation';
import { adminRuntimeAuthMiddleware } from '../src/middleware/admin-runtime-auth';
import { installRuntimeAdminBoundaryInTransaction } from '../src/migrations/runtimeAdminBoundary';
import { runtimeBusinessPrivilegePlan } from '../src/migrations/runtimeBusinessPrivilegePlan';
import { installAdminAuthorityOperation, assertAdminAuthorityOperationReady,
  ADMIN_AUTHORITY_OPERATION_RUNTIME_PRIVILEGES, ADMIN_AUTHORITY_OPERATION_RUNTIME_FUNCTIONS } from '../src/migrations/adminAuthorityOperation';
import { adminAuthorityPreview, adminAuthorityCommit, adminAuthorityReceipt, adminAuthorityResolve } from '../src/controllers/api/v1/AdminAuthorityOperationController';
import { AdminPermissionService } from '../src/services/admin/AdminPermissionService';
import { runAdminAuthorityOperationUpgrade, installAdminAuthorityOperationUpgradeInTransaction } from '../src/migrations/runAdminAuthorityOperationUpgrade';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { ApiException, HttpApiException } from '../src/utils/errors';
import { createToken, md5 } from '../src/utils/jwt';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';

type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type LoginPeer = SequenceRunnerPeer & { role: string; connectionString: string };
type C = Context<{ Bindings: Env; Variables: AppVariables }>;
type Operation = 'admin-save' | 'role-save' | 'role-delete';
type Intent = { operation_id: string; operation: Operation; payload: Record<string, unknown> };
type Preview = {
  operation_id: string; actor_id: number; operation: Operation; request_hash: string; revision: string; expires_at: number;
  summary: { target_id: number; target_name: string; action: 'create' | 'update' | 'delete'; before: unknown; after: unknown };
  affected_accounts: Array<{ id: number; account: string; real_name: string; level: number; status: number; is_del: number }>;
  requires_confirmation: boolean;
};
type Receipt = { operation_id: string; actor_id: number; operation: Operation; state: 'committed' | 'not_applied' | 'unknown';
  request_hash: string | null; result: { id: number; created?: boolean; deleted?: boolean } | null };
type Reply = { status: number; msg: string; data: unknown };
const password = 'owned-native-operation-password';
const baseEnv = { APP_KEY: 'owned-native-operation-hmac-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
const tables = ['system_admin', 'system_role', 'system_menus', 'admin_authority_operation'] as const;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Observe the original SQL callback/result and its real COMMIT. A lost ACK is
 * simulated only after postgres-js has successfully resolved the transaction;
 * no SQL, row, callback result, commit or rollback is replaced. */
function observeTransaction(db: DbClient, options: {
  beforeCommit?: (tx: DbClient, result: unknown) => Promise<void>;
  afterCommit?: (result: unknown) => Promise<void>;
}): DbClient {
  return new Proxy(db, { get(target, property) {
    const method: unknown = Reflect.get(target, property);
    if (typeof method !== 'function') return method;
    if (property !== 'transaction') return method.bind(target);
    return (callback: unknown, ...args: unknown[]) => {
      if (typeof callback !== 'function') throw Error('Original authority operation transaction callback required');
      const completed: Promise<unknown> = Reflect.apply(method, target, [async (tx: DbClient) => {
        const result: unknown = await callback(tx);
        await options.beforeCommit?.(tx, result);
        return result;
      }, ...args]);
      return completed.then(async result => { await options.afterCommit?.(result); return result; });
    };
  } });
}

function application(options: {
  beforeCommit?: (tx: DbClient, result: unknown) => Promise<void>;
  afterCommit?: (result: unknown) => Promise<void>;
  afterAuth?: (c: C) => Promise<void>;
} = {}) {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use('*', async (c, next) => {
    const container = createContainer(c.env); c.set('container', container);
    try { await next(); } finally { await container.db.$client.end({ timeout: 5 }); }
  });
  app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null },
    error instanceof HttpApiException ? error.httpStatus : 200));
  const observe = async (c: C, next: () => Promise<void>) => {
    await options.afterAuth?.(c);
    if (options.beforeCommit || options.afterCommit) {
      c.set('container', createContainerFromDb(observeTransaction(c.get('container').db, options)));
    }
    await next();
  };
  for (const prefix of ['/adminapi', '/api/admin']) {
    app.post(`${prefix}/system/authority/preview`, adminRuntimeAuthMiddleware(), observe, adminAuthorityPreview);
    app.post(`${prefix}/system/authority/commit`, adminRuntimeAuthMiddleware(), observe, adminAuthorityCommit);
    app.get(`${prefix}/system/authority/receipt/:operationId`, adminRuntimeAuthMiddleware(), observe, adminAuthorityReceipt);
    app.post(`${prefix}/system/authority/resolve`, adminRuntimeAuthMiddleware(), observe, adminAuthorityResolve);
  }
  return app;
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('authority preview, commit and durable resolution on actual PG16 LOGINs', () => {
  let fixture: Fixture, ddl: string;
  const tokens = new Map<number, string>();
  beforeAll(async () => {
    const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson({ systemAdmin, systemRole, systemMenus }))).join('\n');
    for (const id of [100,101,102,103,104,105]) tokens.set(id, (await createToken(id, 'admin', md5(password), baseEnv.APP_KEY)).token);
  });
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native authority operations forbid external I/O'));
    fixture = await sequenceRunnerDatabase();
    if (fixture.format !== 'pg16' || !fixture.withPeer || !fixture.withRuntimeRole) throw Error('Owned real PG16 LOGINs required');
    await fixture.exec(ddl);
    await fixture.db.transaction(async tx => {
      await installAdminAuthorityOperation(tx);
      await assertAdminAuthorityOperationReady(tx);
    });
    await fixture.db.insert(systemMenus).values([
      { id: 2, type: 1, authType: 2, menuName: '商品读取权限', apiUrl: 'product/list', methods: 'GET' },
      { id: 3, type: 1, authType: 2, menuName: '用户读取权限', apiUrl: 'user/list', methods: 'GET' },
    ]);
    await fixture.db.insert(systemRole).values([
      { id: 50, type: 0, relationId: 0, level: 2, roleName: '被引用角色', rules: 'product.view', status: 1 },
      { id: 51, type: 1, relationId: 0, level: 2, roleName: '另一个平台角色', rules: 'product.view', status: 1 },
      { id: 52, type: 4, relationId: 7, level: 2, roleName: '供应商角色', rules: 'product.view', status: 1 },
      { id: 53, type: 1, relationId: 7, level: 2, roleName: '外关系角色', rules: 'product.view', status: 1 },
      { id: 900, type: 0, relationId: 0, level: 1, roleName: '当前管理者', rules: 'system.manage,2,3', status: 1 },
      { id: 901, type: 0, relationId: 0, level: 1, roleName: '目录只读', rules: 'system.view', status: 1 },
    ]);
    await fixture.db.insert(systemAdmin).values([
      { id: 100, account: 'operation-super', pwd: password, level: 0 },
      { id: 101, account: 'operation-manager', pwd: password, level: 1, roles: '900' },
      { id: 102, account: 'operation-reader', pwd: password, level: 1, roles: '901' },
      { id: 103, account: 'foreign-relation-actor', pwd: password, level: 1, roles: '900', relationId: 7 },
      { id: 104, account: 'supplier-actor', pwd: password, adminType: 4, relationId: 7, level: 1, roles: '900' },
      { id: 105, account: 'other-manager', pwd: password, level: 1, roles: '900' },
      { id: 200, account: 'active-reference', pwd: password, level: 2, roles: '50' },
      { id: 201, account: 'disabled-reference', pwd: password, level: 2, roles: '50', status: 0 },
      { id: 202, account: 'deleted-reference', pwd: password, level: 2, roles: '50', isDel: 1 },
      { id: 203, account: 'foreign-reference', pwd: password, adminType: 4, relationId: 7, level: 2, roles: '51' },
      { id: 210, account: 'unassigned-target', pwd: password, level: 2 },
    ]);
    await fixture.exec("SELECT setval(pg_get_serial_sequence('system_admin','id'),210,true); SELECT setval(pg_get_serial_sequence('system_role','id'),901,true)");
  }, 60_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await fixture?.close(); }
  }, 30_000);

  async function snapshot() {
    return { admins: await fixture.db.select().from(systemAdmin).orderBy(systemAdmin.id),
      roles: await fixture.db.select().from(systemRole).orderBy(systemRole.id),
      menus: await fixture.db.select().from(systemMenus).orderBy(systemMenus.id),
      receipts: await fixture.db.select().from(adminAuthorityOperation).orderBy(adminAuthorityOperation.operationId) };
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
        for (const table of tables) {
          const privileges: readonly ('SELECT'|'INSERT'|'UPDATE'|'DELETE')[] | undefined = table === 'admin_authority_operation'
            ? ADMIN_AUTHORITY_OPERATION_RUNTIME_PRIVILEGES[kind] : plan.tables[table];
          if (privileges?.length) grants.push(`GRANT ${privileges.join(',')} ON public.${table} TO "${peer.role}"`);
          if (plan.updateColumns[table]) grants.push(`GRANT UPDATE(${plan.updateColumns[table].join(',')}) ON public.${table} TO "${peer.role}"`);
          if (privileges?.includes('INSERT') && table !== 'admin_authority_operation') {
            grants.push(`GRANT USAGE ON SEQUENCE public.${table}_id_seq TO "${peer.role}"`);
          }
        }
        const functions = ADMIN_AUTHORITY_OPERATION_RUNTIME_FUNCTIONS[kind];
        expect(functions).toEqual(kind === 'admin' ? ['admin_authority_menu_lock_v1()'] : []);
        for (const signature of functions) grants.push(`GRANT EXECUTE ON FUNCTION public.${signature} TO "${peer.role}"`);
        if (grants.length) await fixture.exec(grants.join(';'));
        await identity(peer);
      }
      expect(runtimeBusinessPrivilegePlan('app').tables.admin_authority_operation).toBeUndefined();
      expect(runtimeBusinessPrivilegePlan('app').updateColumns.admin_authority_operation).toBeUndefined();
      expect(runtimeBusinessPrivilegePlan('admin').tables.admin_authority_operation).toBeUndefined();
      expect(runtimeBusinessPrivilegePlan('admin').updateColumns.admin_authority_operation).toBeUndefined();
      expect(ADMIN_AUTHORITY_OPERATION_RUNTIME_PRIVILEGES).toEqual({ app: [], admin: ['SELECT','INSERT'] });
      expect(ADMIN_AUTHORITY_OPERATION_RUNTIME_FUNCTIONS).toEqual({ app: [], admin: ['admin_authority_menu_lock_v1()'] });
      const env = { ...baseEnv, HYPERDRIVE: { connectionString: appRole.connectionString },
        HYPERDRIVE_ADMIN: { connectionString: adminRole.connectionString } } as Env;
      return run(env, appRole, adminRole);
    }));
  }
  async function assertHeldBarrier(tx: DbClient, adminRole: LoginPeer, menuBarrier = false) {
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
    if (menuBarrier) {
      const menuLocks = await tx.execute(sql`SELECT c.relname AS name,l.mode,l.granted FROM pg_locks AS l
        JOIN pg_class AS c ON c.oid=l.relation JOIN pg_namespace AS n ON n.oid=c.relnamespace
        WHERE l.pid=pg_backend_pid() AND n.nspname='public' AND c.relname='system_menus' AND l.mode='ShareLock'`);
      expect(Array.from(menuLocks)).toEqual([{ name: 'system_menus', mode: 'ShareLock', granted: true }]);
    }
    return Number(state.pid);
  }
  async function request(env: Env, route: string, body: unknown, options: {
    actor?: number; token?: string; method?: 'POST' | 'GET'; prefix?: string; app?: ReturnType<typeof application>; noToken?: boolean;
  } = {}) {
    const response = await (options.app ?? application()).request(`http://local${options.prefix ?? '/adminapi'}/system/authority/${route}`, {
      method: options.method ?? 'POST', headers: { ...(options.noToken ? {} : { 'Authori-zation': `Bearer ${options.token ?? tokens.get(options.actor ?? 101)}` }),
        'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, env);
    return { http: response.status, body: await response.json() as Reply };
  }
  function intent(operation: Operation, payload: Record<string, unknown>): Intent {
    return { operation_id: randomUUID(), operation, payload };
  }
  async function preview(env: Env, input: Intent, actor = 101) {
    const before = await snapshot(), reply = await request(env, 'preview', input, { actor });
    expect(reply.body.status, JSON.stringify(reply.body)).toBe(200);
    const value = reply.body.data as Preview;
    expect(value).toMatchObject({ operation_id: input.operation_id, actor_id: actor, operation: input.operation,
      requires_confirmation: true });
    expect(value.request_hash).toMatch(/^[a-f0-9]{64}$/); expect(value.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(value.expires_at).toBeGreaterThan(Math.floor(Date.now()/1000));
    expect(value.expires_at).toBeLessThanOrEqual(Math.floor(Date.now()/1000)+301);
    expect(JSON.stringify(value)).not.toContain(password);
    expect(JSON.stringify(value)).not.toContain(String(input.payload.pwd ?? 'never-in-preview-placeholder'));
    expect(await snapshot()).toEqual(before);
    return value;
  }
  function confirmation(input: Intent, value: Preview) {
    return { ...input, revision: value.revision, expires_at: value.expires_at, confirmed: true };
  }
  async function commit(env: Env, input: Intent, value: Preview, options: Parameters<typeof request>[3] = {}) {
    const reply = await request(env, 'commit', confirmation(input, value), options);
    expect(reply.body.status).toBe(200);
    const receipt = reply.body.data as Receipt;
    expect(receipt).toMatchObject({ operation_id: input.operation_id, actor_id: options.actor ?? 101,
      operation: input.operation, state: 'committed', request_hash: value.request_hash });
    expect(receipt.result?.id).toBeGreaterThan(0);
    return receipt;
  }
  async function readReceipt(env: Env, input: Pick<Intent, 'operation_id'|'operation'>, options: Parameters<typeof request>[3] = {}) {
    return request(env, `receipt/${input.operation_id}?operation=${input.operation}`, undefined, { ...options, method: 'GET' });
  }
  function businessRows(value: Awaited<ReturnType<typeof snapshot>>) {
    return { admins: value.admins, roles: value.roles, menus: value.menus };
  }
  function assertAppend(before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>,
    receipt: Receipt, value: Preview) {
    const added = after.receipts.filter(row => !before.receipts.some(old => old.operationId === row.operationId));
    expect(added).toHaveLength(1);
    const row = added[0];
    expect(row).toEqual({ operationId: receipt.operation_id, actorId: receipt.actor_id, adminType: 1, relationId: 0,
      operation: receipt.operation, requestHash: receipt.request_hash, revision: value.revision,
      state: 'committed', result: receipt.result, createdAt: row.createdAt });
    expect(row.createdAt).toBeGreaterThan(0);
    expect(after.receipts).toEqual([...before.receipts, row].sort((a,b) => a.operationId.localeCompare(b.operationId)));
    expect(JSON.stringify(row)).not.toContain(password);
  }

  it('uses the actual four-table profile and migration constraints with genuine separate app/Admin LOGINs', async () => {
    await runtime(async (env, appRole, adminRole) => {
      const rights = async (peer: LoginPeer) => (await peer.exec(`SELECT
        has_table_privilege(current_user,'public.admin_authority_operation','SELECT') AS can_read,
        has_table_privilege(current_user,'public.admin_authority_operation','INSERT') AS can_append,
        has_table_privilege(current_user,'public.admin_authority_operation','UPDATE') AS can_rewrite,
        has_table_privilege(current_user,'public.admin_authority_operation','DELETE') AS can_remove,
        has_table_privilege(current_user,'public.admin_authority_operation','TRUNCATE') AS can_truncate`))[0];
      expect(await rights(appRole)).toEqual({ can_read: false, can_append: false, can_rewrite: false, can_remove: false, can_truncate: false });
      expect(await rights(adminRole)).toEqual({ can_read: true, can_append: true, can_rewrite: false, can_remove: false, can_truncate: false });
      // Diagnose the commissioned menu privileges on the real Admin LOGIN;
      // column UPDATE(id) must not be replaced by a wider table DML grant.
      const [menuRights] = await adminRole.exec(`SELECT
        has_table_privilege(current_user,'public.system_menus','UPDATE') AS can_update_table,
        has_table_privilege(current_user,'public.system_menus','DELETE') AS can_delete_table,
        has_column_privilege(current_user,'public.system_menus','id','UPDATE') AS can_update_id`);
      expect(menuRights).toEqual({ can_update_table: false, can_delete_table: false, can_update_id: true });
      let menuLockError: unknown;
      await adminRole.exec('BEGIN');
      try { await adminRole.exec('LOCK TABLE ONLY public.system_menus IN SHARE MODE NOWAIT'); }
      catch (error) { menuLockError = error; }
      finally { await adminRole.exec('ROLLBACK'); }
      const menuLockDiagnostic = menuLockError instanceof Error && 'code' in menuLockError
        ? { code: menuLockError.code, message: menuLockError.message } : { code: null, message: 'Menu SHARE lock unexpectedly succeeded' };
      console.info('ADMIN_AUTHORITY_MENU_LOCK_DIAGNOSTIC', JSON.stringify({ rights: menuRights, ...menuLockDiagnostic }));
      expect(menuLockError).toMatchObject({ code: '42501' });
      await expect(appRole.exec('SELECT public.admin_authority_menu_lock_v1()')).rejects.toMatchObject({ code: '42501' });
      const [lockRights] = await adminRole.exec(`SELECT
        has_function_privilege(current_user,'public.admin_authority_menu_lock_v1()','EXECUTE') AS can_lock,
        has_table_privilege(current_user,'public.system_menus','UPDATE,DELETE') AS can_mutate_table`);
      expect(lockRights).toEqual({ can_lock: true, can_mutate_table: false });
      const before = await snapshot();
      await expect(appRole.exec('SELECT * FROM public.admin_authority_operation')).rejects.toMatchObject({ code: '42501' });
      await expect(appRole.exec(`INSERT INTO public.admin_authority_operation(operation_id,actor_id,admin_type,relation_id,
        operation,request_hash,revision,state,result,created_at)
        VALUES('${randomUUID()}',101,1,0,'role-save','','','not_applied',NULL,1)`)).rejects.toMatchObject({ code: '42501' });
      await expect(adminRole.exec('UPDATE public.admin_authority_operation SET created_at=created_at')).rejects.toMatchObject({ code: '42501' });
      await expect(adminRole.exec('DELETE FROM public.admin_authority_operation')).rejects.toMatchObject({ code: '42501' });
      await expect(adminRole.exec('TRUNCATE public.admin_authority_operation')).rejects.toMatchObject({ code: '42501' });
      await expect(appRole.exec("UPDATE public.system_admin SET roles='51' WHERE id=200")).rejects.toMatchObject({ code: '42501' });
      await expect(appRole.exec('UPDATE public.system_role SET status=0 WHERE id=50')).rejects.toMatchObject({ code: '42501' });
      await expect(fixture.exec(`INSERT INTO public.admin_authority_operation(operation_id,actor_id,admin_type,relation_id,
        operation,request_hash,revision,state,result,created_at)
        VALUES('${randomUUID()}',101,1,0,'role-save','','','pending',NULL,1)`)).rejects.toMatchObject({ code: '23514' });
      expect(await snapshot()).toEqual(before);
      const input = intent('role-save', { id: 50, role_name: '所属收据' }), value = await preview(env, input);
      const receipt = await commit(env, input, value);
      expect((await readReceipt(env, input)).body.data).toEqual(receipt);
      for (const actor of [102,103,104,105]) {
        const other = await readReceipt(env, input, { actor });
        expect(other.body.status).not.toBe(200); expect(other.body.data).toBeNull();
      }
      const after = await snapshot(); assertAppend(before, after, receipt, value);
      expect(businessRows(after)).toEqual({ ...businessRows(before), roles: before.roles.map(row => row.id === 50
        ? { ...row, roleName: '所属收据' } : row) });
    });
  }, 60_000);

  it.each(['function-body','extra-execute-grant'] as const)(
    'rejects actual menu lock capability %s drift before either preview or business mutation', async drift => {
      await runtime(async (env, appRole) => {
        const input = intent('role-save', { id: 50, rules: 'user.view' }), value = await preview(env, input), before = await snapshot();
        if (drift === 'function-body') {
          await fixture.exec(`CREATE OR REPLACE FUNCTION public.admin_authority_menu_lock_v1() RETURNS void
            LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN RETURN; END $$`);
          const [definition] = await fixture.exec("SELECT prosrc FROM pg_proc WHERE oid='public.admin_authority_menu_lock_v1()'::regprocedure") as unknown as Array<{ prosrc: string }>;
          expect(definition.prosrc).toBe(' BEGIN RETURN; END ');
        } else {
          await fixture.exec(`GRANT EXECUTE ON FUNCTION public.admin_authority_menu_lock_v1() TO "${appRole.role}"`);
          const [rights] = await appRole.exec("SELECT has_function_privilege(current_user,'public.admin_authority_menu_lock_v1()','EXECUTE') AS can_lock");
          expect(rights.can_lock).toBe(true);
        }
        const deniedPreview = await request(env, 'preview', input);
        expect(deniedPreview, JSON.stringify(deniedPreview.body)).toMatchObject({ http: 503, body: { status: 503, data: null } });
        const deniedCommit = await request(env, 'commit', confirmation(input, value));
        expect(deniedCommit, JSON.stringify(deniedCommit.body)).toMatchObject({ http: 503, body: { status: 503, data: null } });
        expect(await snapshot()).toEqual(before);
      });
    }, 60_000);

  it('confirms complete referenced-role impacts, rule/status changes, soft deletion and new admin/role creation with exact row deltas', async () => {
    await runtime(async env => {
      for (const [operation, payload, change] of [
        ['role-save', { id: 50, rules: 'user.view' }, { rules: 'user.view' }],
        ['role-save', { id: 50, status: 0 }, { status: 0 }],
        ['role-delete', { id: 50 }, { status: -1 }],
      ] as const) {
        const before = await snapshot(), input = intent(operation, payload), value = await preview(env, input);
        expect(value.summary).toMatchObject({ target_id: 50, action: operation === 'role-delete' ? 'delete' : 'update' });
        expect(value.affected_accounts).toEqual(before.admins.filter(row => [200,201,202].includes(row.id))
          .map(row => ({ id: row.id, account: row.account, real_name: row.realName, level: row.level, status: row.status, is_del: row.isDel })));
        const receipt = await commit(env, input, value, { prefix: '/api/admin' });
        expect(receipt.result).toMatchObject({ id: 50, ...(operation === 'role-delete' ? { deleted: true } : {}) });
        const after = await snapshot(); assertAppend(before, after, receipt, value);
        expect(businessRows(after)).toEqual({ ...businessRows(before), roles: before.roles.map(row => row.id === 50 ? { ...row, ...change } : row) });
      }
      const beforeRole = await snapshot(), roleIntent = intent('role-save', { role_name: '真正新角色', rules: 'product.view', level: 2, status: 1 });
      const rolePreview = await preview(env, roleIntent); expect(rolePreview.summary.action).toBe('create');
      const roleReceipt = await commit(env, roleIntent, rolePreview), roleId = roleReceipt.result!.id;
      expect(roleReceipt.result).toEqual({ id: roleId, created: true });
      const afterRole = await snapshot(); assertAppend(beforeRole, afterRole, roleReceipt, rolePreview);
      expect(businessRows(afterRole)).toEqual({ ...businessRows(beforeRole), roles: [...beforeRole.roles,
        { id: roleId, type: 0, relationId: 0, roleName: '真正新角色', rules: 'product.view', level: 2, status: 1 }].sort((a,b) => a.id-b.id) });
      const newPassword = 'new-operation-password-123', startedAt = Math.floor(Date.now()/1000);
      const adminIntent = intent('admin-save', { account: 'new-operation-staff', pwd: newPassword, real_name: '真正新账号',
        phone: '13800123000', roles: String(roleId), level: 2, status: 1 });
      const adminPreview = await preview(env, adminIntent); expect(adminPreview.summary.action).toBe('create');
      expect(JSON.stringify(adminPreview)).not.toContain(newPassword);
      const adminReceipt = await commit(env, adminIntent, adminPreview), adminId = adminReceipt.result!.id;
      expect(adminReceipt.result).toEqual({ id: adminId, created: true });
      const final = await snapshot(); assertAppend(afterRole, final, adminReceipt, adminPreview);
      const staff = final.admins.find(row => row.id === adminId)!;
      expect(await bcrypt.compare(newPassword, staff.pwd)).toBe(true); expect(staff.pwd).toMatch(/^\$2[aby]\$12\$/);
      expect(staff.lastTime).toBeGreaterThanOrEqual(startedAt); expect(staff.lastTime).toBeLessThanOrEqual(Math.floor(Date.now()/1000));
      expect(staff).toEqual({ ...afterRole.admins.find(row => row.id === 210)!, id: adminId, account: 'new-operation-staff', pwd: staff.pwd,
        realName: '真正新账号', phone: '13800123000', roles: String(roleId), level: 2, status: 1, lastTime: staff.lastTime });
      expect(businessRows(final)).toEqual({ ...businessRows(afterRole), admins: [...afterRole.admins, staff].sort((a,b) => a.id-b.id) });
      expect(JSON.stringify(final.receipts)).not.toContain(newPassword);
    });
  }, 90_000);

  it('rejects missing, malformed, stale or mismatched actor/request/realm confirmations without business or receipt DML', async () => {
    await runtime(async env => {
      const input = intent('role-save', { id: 50, rules: 'user.view' }), value = await preview(env, input), before = await snapshot();
      const valid = confirmation(input, value);
      for (const body of [
        input, { ...valid, confirmed: false }, { ...valid, revision: 'x' }, { ...valid, revision: '0'.repeat(64) },
        { ...valid, expires_at: 1 }, { ...valid, payload: { id: 50, rules: 'product.view' } },
        { ...valid, operation: 'role-delete' }, { ...valid, operation_id: randomUUID() },
      ]) {
        expect((await request(env, 'commit', body)).body.status).not.toBe(200);
        expect(await snapshot()).toEqual(before);
      }
      for (const actor of [100,102,103,104,105]) {
        expect((await request(env, 'commit', valid, { actor })).body.status).not.toBe(200);
        expect(await snapshot()).toEqual(before);
      }
      for (const payload of [{ id: 52, role_name: '供应商越界' }, { id: 53, role_name: '外关系越界' }, { id: 9999, role_name: '不存在' }]) {
        expect((await request(env, 'preview', intent('role-save', payload))).body.status).not.toBe(200);
        expect(await snapshot()).toEqual(before);
      }
      expect((await request(env, 'preview', input, { noToken: true })).body.status).toBe(410000);
      expect(await snapshot()).toEqual(before);
      await fixture.withPeer!(async peer => { await peer.exec("UPDATE public.system_admin SET roles='50' WHERE id=203"); });
      const foreignReference = await snapshot();
      expect(businessRows(foreignReference)).toEqual({ ...businessRows(before), admins: before.admins.map(row => row.id === 203
        ? { ...row, roles: '50' } : row) });
      expect((await request(env, 'preview', input))).toMatchObject({ http: 409, body: { status: 409 } });
      expect((await request(env, 'commit', valid))).toMatchObject({ http: 409, body: { status: 409 } });
      expect(await snapshot()).toEqual(foreignReference);
    });
  }, 60_000);

  it('rechecks authority after ordinary app authentication and an independently committed actor-role revocation', async () => {
    await runtime(async (env, _appRole, adminRole) => fixture.withPeer!(async peer => {
      const input = intent('role-save', { id: 50, rules: 'user.view' }), value = await preview(env, input), before = await snapshot();
      let ordinaryAuthPassed = false;
      const app = application({ afterAuth: async c => {
        expect(c.get('adminId')).toBe(101);
        const info = c.get('adminInfo');
        expect(info?.roles).toBe('900');
        if (!info) throw Error('Real ordinary admin authentication information required');
        const granted = await new AdminPermissionService(c.get('container')).resolveAdminPermissionKeys(info);
        expect(granted.has('system.manage')).toBe(true);
        const [identityRow] = await c.get('container').db.execute(sql`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid`);
        expect(identityRow).toMatchObject({ role: adminRole.role, session: adminRole.role });
        expect(Number(identityRow.pid)).not.toBe(peer.pid);
        ordinaryAuthPassed = true;
        await peer.exec("UPDATE public.system_role SET rules='system.view' WHERE id=900");
      } });
      const denied = await request(env, 'commit', confirmation(input, value), { app });
      expect(ordinaryAuthPassed).toBe(true); expect(denied.body.status).toBe(400011);
      const after = await snapshot();
      expect(after).toEqual({ ...before, roles: before.roles.map(row => row.id === 900 ? { ...row, rules: 'system.view' } : row) });
    }));
  }, 60_000);

  it.each(['added-reference','removed-reference','target-role','catalogue'] as const)(
    'requires a fresh preview after an independently committed %s change', async change => {
      await runtime(async env => {
        const input = intent('role-save', { id: 50, rules: 'user.view' }), value = await preview(env, input);
        await fixture.withPeer!(async peer => {
          if (change === 'added-reference') await peer.exec("INSERT INTO public.system_admin(id,account,pwd,roles,level) VALUES(211,'late-reference','hash','50',2)");
          if (change === 'removed-reference') await peer.exec("UPDATE public.system_admin SET roles='' WHERE id=200");
          if (change === 'target-role') await peer.exec("UPDATE public.system_role SET role_name='独立新名称' WHERE id=50");
          if (change === 'catalogue') await peer.exec("UPDATE public.system_menus SET menu_name='独立新目录名称' WHERE id=3");
        });
        const afterPeer = await snapshot(), refused = await request(env, 'commit', confirmation(input, value));
        expect(refused).toMatchObject({ http: 409, body: { status: 409 } });
        expect(await snapshot()).toEqual(afterPeer);
        const fresh = await preview(env, input); expect(fresh.revision).not.toBe(value.revision);
        const receipt = await commit(env, input, fresh), final = await snapshot(); assertAppend(afterPeer, final, receipt, fresh);
        expect(businessRows(final)).toEqual({ ...businessRows(afterPeer), roles: afterPeer.roles.map(row => row.id === 50 ? { ...row, rules: 'user.view' } : row) });
      });
    }, 60_000);

  it('replays the exact original receipt after expiry and target removal, but rejects reuse for another payload, operation or owner', async () => {
    await runtime(async env => {
      const input = intent('role-save', { role_name: '重放角色', rules: 'product.view', level: 2 }), value = await preview(env, input);
      const receipt = await commit(env, input, value), afterCommit = await snapshot();
      const replay = await request(env, 'commit', { ...confirmation(input, value), expires_at: 1 });
      expect(replay.body.data).toEqual(receipt); expect(await snapshot()).toEqual(afterCommit);
      await fixture.withPeer!(async peer => { await peer.exec(`DELETE FROM public.system_role WHERE id=${receipt.result!.id}`); });
      const afterDelete = await snapshot();
      expect((await request(env, 'commit', { ...confirmation(input, value), expires_at: 1 })).body.data).toEqual(receipt);
      expect((await readReceipt(env, input, { prefix: '/api/admin' })).body.data).toEqual(receipt);
      expect((await request(env, 'resolve', { operation_id: input.operation_id, operation: input.operation })).body.data).toEqual(receipt);
      for (const [body, actor] of [
        [{ ...confirmation(input, value), payload: { ...input.payload, role_name: '不同内容' } }, 101],
        [{ ...confirmation(input, value), operation: 'role-delete', payload: { id: 50 } }, 101],
        [confirmation(input, value), 105],
      ] as const) {
        const rejected = await request(env, 'commit', body, { actor });
        expect(rejected.body.status).toBe(actor === 101 ? 409 : 400011); expect(rejected.body.data).toBeNull();
        expect(await snapshot()).toEqual(afterDelete);
      }
    });
  }, 60_000);

  it('recovers the original created id after a real COMMIT loses its ACK and leaves a merely absent receipt unknown', async () => {
    await runtime(async env => {
      const input = intent('role-save', { role_name: '已提交但响应丢失', rules: 'product.view', level: 2 }), value = await preview(env, input);
      let actualCommitCompleted = false;
      const lostAck = application({ afterCommit: async () => { actualCommitCompleted = true; throw Error('Owned native lost ACK after actual COMMIT'); } });
      const failedReply = await request(env, 'commit', confirmation(input, value), { app: lostAck });
      expect(failedReply.body.status).toBe(500); expect(actualCommitCompleted).toBe(true);
      const persisted = await snapshot(); expect(persisted.receipts).toHaveLength(1);
      const stored = persisted.receipts[0], recovered = await readReceipt(env, input);
      expect(recovered.body.status).toBe(200);
      const original = recovered.body.data as Receipt;
      expect(original).toMatchObject({ state: 'committed', request_hash: value.request_hash, result: { id: stored.result?.id, created: true } });
      expect(persisted.roles.find(row => row.id === original.result!.id)?.roleName).toBe('已提交但响应丢失');
      expect((await request(env, 'resolve', { operation_id: input.operation_id, operation: input.operation })).body.data).toEqual(original);
      expect((await request(env, 'commit', confirmation(input, value))).body.data).toEqual(original);
      const absent = intent('role-save', { role_name: '未知尚未发送', rules: 'product.view', level: 2 });
      expect((await readReceipt(env, absent)).body.data).toEqual({ operation_id: absent.operation_id, actor_id: 101,
        operation: absent.operation, state: 'unknown', request_hash: null, result: null });
      expect(await snapshot()).toEqual(persisted);
      // Losing manage does not erase an already committed owner's recovery
      // right. Current platform identity/password/expiry still pass real auth.
      await fixture.withPeer!(async peer => { await peer.exec("UPDATE public.system_role SET rules='system.view' WHERE id=900"); });
      const revoked = await snapshot();
      expect(revoked).toEqual({ ...persisted, roles: persisted.roles.map(row => row.id === 900 ? { ...row, rules: 'system.view' } : row) });
      expect((await readReceipt(env, input)).body.data).toEqual(original);
      expect((await request(env, 'resolve', { operation_id: input.operation_id, operation: input.operation })).body.data).toEqual(original);
      expect((await request(env, 'commit', confirmation(input, value))).body.status).toBe(400011);
      expect(await snapshot()).toEqual(revoked);
      const changedPassword = 'independent-current-owner-password';
      await fixture.withPeer!(async peer => { await peer.exec(`UPDATE public.system_admin SET pwd='${changedPassword}' WHERE id=101`); });
      const newIdentity = await snapshot();
      expect(newIdentity).toEqual({ ...revoked, admins: revoked.admins.map(row => row.id === 101 ? { ...row, pwd: changedPassword } : row) });
      expect((await readReceipt(env, input)).body.status).not.toBe(200);
      const freshLogin = (await createToken(101,'admin',md5(changedPassword),baseEnv.APP_KEY)).token;
      expect((await readReceipt(env, input, { token: freshLogin })).body.data).toEqual(original);
      expect((await request(env, 'resolve', { operation_id: input.operation_id, operation: input.operation }, { token: freshLogin })).body.data).toEqual(original);
      expect(await snapshot()).toEqual(newIdentity);
    });
  }, 60_000);

  it('seals an absent operation under the common barrier and permanently rejects its late original commit', async () => {
    await runtime(async (env, _appRole, adminRole) => {
      const input = intent('role-save', { role_name: '迟到请求不得新增', rules: 'product.view', level: 2 }), value = await preview(env, input);
      const before = await snapshot(); let observed = 0;
      const app = application({ beforeCommit: async tx => {
        await assertHeldBarrier(tx, adminRole); observed++;
        const rows = await tx.select().from(adminAuthorityOperation);
        expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ operationId: input.operation_id, state: 'not_applied', result: null });
        expect((await fixture.db.select().from(adminAuthorityOperation))).toHaveLength(0);
      } });
      const resolved = await request(env, 'resolve', { operation_id: input.operation_id, operation: input.operation }, { app });
      expect(resolved.body.data).toEqual({ operation_id: input.operation_id, actor_id: 101, operation: input.operation,
        state: 'not_applied', request_hash: null, result: null });
      expect(observed).toBe(1);
      const sealed = await snapshot(); expect(businessRows(sealed)).toEqual(businessRows(before));
      expect(sealed.receipts).toHaveLength(1);
      expect(sealed.receipts[0]).toEqual({ operationId: input.operation_id, actorId: 101, adminType: 1, relationId: 0,
        operation: input.operation, requestHash: '', revision: '', state: 'not_applied', result: null, createdAt: sealed.receipts[0].createdAt });
      expect((await request(env, 'commit', confirmation(input, value)))).toMatchObject({ http: 409, body: { status: 409 } });
      expect((await request(env, 'resolve', { operation_id: input.operation_id, operation: input.operation })).body.data).toEqual(resolved.body.data);
      expect((await readReceipt(env, input)).body.data).toEqual(resolved.body.data);
      expect(await snapshot()).toEqual(sealed);
    });
  }, 60_000);

  it('holds the real common barrier and receipt readback in the same transaction until COMMIT', async () => {
    await runtime(async (env, _appRole, adminRole) => fixture.withPeer!(async peer => fixture.withPeer!(async menuPeer => {
      await peer.exec("SET lock_timeout='8s'"); await menuPeer.exec("SET lock_timeout='8s'");
      const input = intent('role-save', { id: 50, rules: 'user.view' }), value = await preview(env, input), before = await snapshot();
      const entered = deferred(), release = deferred(); let savePid = 0;
      const app = application({ beforeCommit: async tx => {
        savePid = await assertHeldBarrier(tx, adminRole, true);
        const ownRole = await tx.select().from(systemRole).where(sql`${systemRole.id}=50`);
        const ownReceipts = await tx.select().from(adminAuthorityOperation);
        expect(ownRole[0].rules).toBe('user.view'); expect(ownReceipts).toHaveLength(1);
        expect(ownReceipts[0]).toMatchObject({ operationId: input.operation_id, state: 'committed', requestHash: value.request_hash });
        expect(await snapshot()).toEqual(before); entered.resolve(); await release.promise;
      } });
      const pending = outcome(request(env, 'commit', confirmation(input, value), { app }));
      let peerUpdate: ReturnType<typeof outcome> | undefined, menuInsert: ReturnType<typeof outcome> | undefined;
      try {
        await Promise.race([entered.promise, pending.then(() => { throw Error('Operation returned before its actual pre-COMMIT observer'); })]);
        expect(peer.pid).not.toBe(savePid);
        expect(new Set([peer.pid,menuPeer.pid,savePid]).size).toBe(3);
        peerUpdate = outcome(peer.exec("UPDATE public.system_admin SET roles='50' WHERE id=210"));
        menuInsert = outcome(menuPeer.exec("INSERT INTO public.system_menus(id,type,auth_type,menu_name,api_url,methods) VALUES(4,1,2,'提交后新目录','order/list','GET')"));
        await waitForFinanceBlock(fixture.db, peer.pid, savePid);
        await waitForFinanceBlock(fixture.db, menuPeer.pid, savePid);
        expect(await snapshot()).toEqual(before);
        const during = await readReceipt(env, input);
        expect(during).toMatchObject({ http: 409, body: { status: 409 } });
        const blockedResolve = await request(env, 'resolve', { operation_id: input.operation_id, operation: input.operation });
        expect(blockedResolve).toMatchObject({ http: 409, body: { status: 409 } });
        release.resolve(); const committed = await pending;
        if (!committed.ok) throw committed.error;
        expect(committed.value.body.status).toBe(200);
        const peerResult = await peerUpdate; if (!peerResult.ok) throw peerResult.error;
        const menuResult = await menuInsert; if (!menuResult.ok) throw menuResult.error;
        const receipt = committed.value.body.data as Receipt, final = await snapshot(); assertAppend(before, final, receipt, value);
        expect(businessRows(final)).toEqual({ ...businessRows(before),
          roles: before.roles.map(row => row.id === 50 ? { ...row, rules: 'user.view' } : row),
          admins: before.admins.map(row => row.id === 210 ? { ...row, roles: '50' } : row),
          menus: [...before.menus,{ ...before.menus.find(row => row.id === 2)!, id: 4, menuName: '提交后新目录', apiUrl: 'order/list' }] });
        expect((await readReceipt(env, input)).body.data).toEqual(receipt);
      } finally { release.resolve(); await pending; if (peerUpdate) await peerUpdate; if (menuInsert) await menuInsert; }
    })));
  }, 60_000);

  it.each(['suppress','modify'] as const)('rolls the business mutation back when an actual BEFORE INSERT receipt trigger does %s', async fault => {
    await runtime(async env => {
      const input = intent('role-save', { id: 50, rules: 'user.view' }), value = await preview(env, input), before = await snapshot();
      await fixture.exec(`CREATE FUNCTION public.native_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        ${fault === 'suppress' ? 'RETURN NULL;' : "NEW.request_hash := repeat('0',64); RETURN NEW;"}
      END $$;
      CREATE FUNCTION public.arm_native_receipt_fault() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
        SET search_path=pg_catalog,pg_temp AS $$ BEGIN
        IF NEW.id=50 THEN
          EXECUTE 'CREATE TRIGGER native_receipt_fault BEFORE INSERT ON public.admin_authority_operation FOR EACH ROW EXECUTE FUNCTION public.native_receipt_fault()';
        END IF;
        RETURN NEW;
      END $$;
      REVOKE ALL ON FUNCTION public.native_receipt_fault() FROM PUBLIC;
      REVOKE ALL ON FUNCTION public.arm_native_receipt_fault() FROM PUBLIC;
      CREATE TRIGGER arm_native_receipt_fault AFTER UPDATE ON public.system_role
        FOR EACH ROW EXECUTE FUNCTION public.arm_native_receipt_fault()`);
      // This maintenance-only, fixed owned-fixture trigger arms the fault
      // after the real readiness check and the real target UPDATE. The normal
      // Admin LOGIN receives no DDL/function/extra table privileges. Both that
      // role UPDATE and the newly created receipt trigger roll back together.
      const failed = await request(env, 'commit', confirmation(input, value));
      expect(failed).toMatchObject({ http: 409, body: { status: 409, msg: '权限操作回执保存结果不一致' } });
      expect(await snapshot()).toEqual(before);
      expect(await fixture.exec("SELECT count(*)::int AS count FROM pg_trigger WHERE tgrelid='public.admin_authority_operation'::regclass AND tgname='native_receipt_fault'"))
        .toEqual([{ count: 0 }]);
      expect((await readReceipt(env, input)).body.data).toEqual({ operation_id: input.operation_id, actor_id: 101,
        operation: input.operation, state: 'unknown', request_hash: null, result: null });
    });
  }, 60_000);
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('authority receipt commissioning on the complete registered PG16 runtime profile', () => {
  it('commissions the exact addon once and rejects third-party, default-ACL and owner drift without repairing the profile', async () => {
    // This independently creates the registered whole-shop schema. It does
    // not run the preceding four-table describe's beforeEach or its grants.
    const whole = await refundRuntimeFixture();
    type CatalogRow = { kind: string; key: string; name: string; owner: string | null; acl: string | null; definition: string | null };
    const catalog = async (db: Pick<DbClient, 'execute'> = whole.db): Promise<CatalogRow[]> =>
      Array.from(await db.execute(sql`SELECT 'relation' AS kind,c.oid::text AS key,c.relname AS name,c.relowner::text AS owner,c.relacl::text AS acl,
          c.relkind::text||':'||c.relpersistence::text||':'||c.relrowsecurity::text||':'||c.relforcerowsecurity::text AS definition
        FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
        UNION ALL SELECT 'column',c.oid::text||'.'||a.attnum::text,c.relname||'.'||a.attname,NULL,a.attacl::text,
          format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),'')
        FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
        UNION ALL SELECT 'function',oid::text,proname,proowner::text,proacl::text,pg_get_functiondef(oid)
        FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind IN('f','p')
        UNION ALL SELECT 'constraint',c.oid::text,c.conname,NULL,NULL,pg_get_constraintdef(c.oid)
        FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relnamespace='public'::regnamespace
        UNION ALL SELECT 'index',i.indexrelid::text,c.relname,NULL,NULL,pg_get_indexdef(i.indexrelid)
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relnamespace='public'::regnamespace
        UNION ALL SELECT 'sequence',s.seqrelid::text,c.relname,NULL,NULL,
          concat_ws(':',s.seqtypid,s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache,s.seqcycle)
        FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid WHERE c.relnamespace='public'::regnamespace
        UNION ALL SELECT 'trigger',g.oid::text,g.tgname,NULL,NULL,pg_get_triggerdef(g.oid)||':'||g.tgenabled::text
        FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT g.tgisinternal
        UNION ALL SELECT 'default-acl',d.oid::text,d.defaclobjtype::text,d.defaclrole::text,d.defaclacl::text,d.defaclnamespace::text
        FROM pg_default_acl d WHERE d.defaclnamespace IN (0,'public'::regnamespace)
        ORDER BY kind,key`)) as unknown as CatalogRow[];
    try {
      if (!whole.withRuntimeRole) throw Error('Complete profile requires genuinely independent runtime LOGINs');
      await whole.withRuntimeRole(async appRole => whole.withRuntimeRole!(async adminRole => whole.withRuntimeRole!(async thirdRole => {
        const [database] = await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance`);
        const target = { database: String(database.database), maintenance: String(database.maintenance), app: appRole.role, admin: adminRole.role };
        expect(target.maintenance).toBe('finance_test');
        expect(new Set([appRole.pid,adminRole.pid,thirdRole.pid]).size).toBe(3);
        await runRuntimeBusinessCommissioning(whole.db, { ...target, pricingOwner: whole.pricingOwner });
        const audit = async (tableCount: number) => {
          for (const [kind, peer] of [['app',appRole],['admin',adminRole]] as const) {
            const report = await auditRuntimeBusinessPrivileges(peer.db, kind, target);
            expect(report, JSON.stringify(report)).toMatchObject({ ready: true, failures: [], tableCount, readOnly: true });
          }
        };
        await audit(282);
        const before = await catalog();
        const baseTables = before.filter(row => row.kind === 'relation').map(row => row.name).sort();
        expect(baseTables).toHaveLength(282);
        const rows = async (db: Pick<DbClient, 'execute'> = whole.db) => {
          for (const table of baseTables) expect(table).toMatch(/^[a-z_][a-z_0-9]*$/);
          const statement = baseTables.map(table => `SELECT '${table}' AS name,
            coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM public."${table}" t`)
            .join(' UNION ALL ') + ' ORDER BY name';
          return Array.from(await db.execute(sql.raw(statement)));
        };
        const beforeRows = await rows();
        expect(await runAdminAuthorityOperationUpgrade(whole.db, target)).toEqual({ operation: 'admin-authority-operation-v1', applied: true });
        await audit(baseTables.length + 1);
        const installed = await catalog(), installedByKey = new Map(installed.map(row => [`${row.kind}:${row.key}`,row]));
        for (const row of before) expect(installedByKey.get(`${row.kind}:${row.key}`)).toEqual(row);
        const beforeKeys = new Set(before.map(row => `${row.kind}:${row.key}`));
        const added = installed.filter(row => !beforeKeys.has(`${row.kind}:${row.key}`));
        expect(added.filter(row => row.kind === 'relation').map(row => row.name)).toEqual(['admin_authority_operation']);
        expect(added.filter(row => row.kind === 'column')).toHaveLength(10);
        expect(added.filter(row => row.kind === 'column').every(row => row.name.startsWith('admin_authority_operation.'))).toBe(true);
        expect(added.filter(row => row.kind === 'function').map(row => row.name).sort())
          .toEqual(['admin_authority_menu_lock_v1','admin_authority_operation_immutable_v1']);
        expect(added.filter(row => row.kind === 'trigger').map(row => row.name).sort()).toEqual(['aao_immutable_rows','aao_immutable_truncate']);
        expect(added.filter(row => row.kind === 'constraint').map(row => row.name).sort())
          .toEqual(['aao_identity_ck','aao_key_ck','aao_operation_ck','aao_pk','aao_state_ck']);
        expect(added.filter(row => row.kind === 'index').map(row => row.name)).toEqual(['aao_pk']);
        expect(added).toHaveLength(21);
        expect(await rows()).toEqual(beforeRows);
        expect(Array.from(await whole.db.execute(sql`SELECT * FROM public.admin_authority_operation`))).toEqual([]);
        const [rights] = await adminRole.exec(`SELECT
          has_table_privilege(current_user,'public.admin_authority_operation','SELECT') AS receipt_read,
          has_table_privilege(current_user,'public.admin_authority_operation','INSERT') AS receipt_append,
          has_table_privilege(current_user,'public.admin_authority_operation','UPDATE,DELETE,TRUNCATE') AS receipt_rewrite,
          has_function_privilege(current_user,'public.admin_authority_menu_lock_v1()','EXECUTE') AS menu_lock,
          has_table_privilege(current_user,'public.system_menus','UPDATE,DELETE') AS menu_dml`);
        expect(rights).toEqual({ receipt_read: true, receipt_append: true, receipt_rewrite: false, menu_lock: true, menu_dml: false });
        await expect(appRole.exec('SELECT * FROM public.admin_authority_operation')).rejects.toMatchObject({ code: '42501' });
        await expect(appRole.exec('SELECT public.admin_authority_menu_lock_v1()')).rejects.toMatchObject({ code: '42501' });
        expect(await runAdminAuthorityOperationUpgrade(whole.db, target)).toEqual({ operation: 'admin-authority-operation-v1', applied: false });
        expect(await catalog()).toEqual(installed); expect(await rows()).toEqual(beforeRows);
        for (const [name, statement] of [
          ['third-party receipt ACL', `GRANT SELECT ON TABLE public.admin_authority_operation TO "${thirdRole.role}"`],
          ['public default table ACL', 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC'],
          ['receipt owner', `ALTER TABLE public.admin_authority_operation OWNER TO "${thirdRole.role}"`],
        ] as const) {
          const rollback = new Error(`Rollback owned ${name} fixture`);
          await expect(whole.db.transaction(async tx => {
            await tx.execute(sql.raw(statement));
            const drifted = await catalog(tx); expect(drifted).not.toEqual(installed);
            await expect(installAdminAuthorityOperationUpgradeInTransaction(tx, target)).rejects.toThrow('exact existing runtime profiles');
            expect(await catalog(tx)).toEqual(drifted); expect(await rows(tx)).toEqual(beforeRows);
            throw rollback;
          }, { isolationLevel: 'read committed', accessMode: 'read write' })).rejects.toBe(rollback);
          expect(await catalog()).toEqual(installed); expect(await rows()).toEqual(beforeRows);
          expect(Array.from(await whole.db.execute(sql`SELECT * FROM public.admin_authority_operation`))).toEqual([]);
          await audit(baseTables.length + 1);
        }
      })));
    } finally { await whole.close(); }
  }, 180_000);
});
