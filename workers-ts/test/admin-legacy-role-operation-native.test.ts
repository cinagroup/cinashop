import { Hono } from 'hono';
import { expect, it, describe, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Env, AppVariables } from '@/env';
import { createContainer, createContainerFromDb, type DbClient } from '@/lib/di';
import { systemAdmin, systemMenus, systemRole } from '@/models/schema';
import { adminAuthorityOperation } from '@/models/schema/adminAuthorityOperation';
import { assertAdminLegacyRoleOperationReady } from '@/migrations/adminAuthorityOperation';
import { runAdminAuthorityOperationUpgrade } from '@/migrations/runAdminAuthorityOperationUpgrade';
import { runAdminLegacyAdminOperationUpgrade } from '@/migrations/runAdminLegacyAdminOperationUpgrade';
import { runAdminLegacyRoleOperationUpgrade } from '@/migrations/runAdminLegacyRoleOperationUpgrade';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { adminRuntimeAuthMiddleware } from '@/middleware/admin-runtime-auth';
import { adminLegacyRoleStatus, adminLegacyRoleDelete, adminLegacyRolePreview, adminLegacyRoleReceipt,
  adminLegacyRoleResolve } from '@/controllers/api/v1/AdminLegacyRoleOperationController';
import { AdminLegacyRoleOperationService, type LegacyRoleActor, type LegacyRoleOperationKind,
  type LegacyRolePreview, type LegacyRoleReceipt } from '@/services/admin/AdminLegacyRoleOperationService';
import { ApiException, HttpApiException } from '@/utils/errors';
import { createToken, md5 } from '@/utils/jwt';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';

const password = 'owned-native-legacy-role-password', key = 'owned-native-legacy-role-key';
const baseEnv = { APP_KEY: key, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
const writerRules = 'system.legacy_role_status,system.legacy_role_delete,product.view';
type Intent = { operation_id: string; operation: LegacyRoleOperationKind; payload: Record<string, unknown> };
type Reply = { status: number; msg: string; data: unknown };
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
/** Hooks observe the real transaction lifecycle without mocking SQL, rows,
 * connections or COMMIT. Loss is injected only after actual COMMIT resolves. */
function observed(db: DbClient, options: { beforeCommit?: (tx: DbClient) => Promise<void>; afterCommit?: () => void }): DbClient {
  return new Proxy(db, { get(database, property) {
    const method: unknown = Reflect.get(database, property); if (typeof method !== 'function') return method;
    if (property !== 'transaction') return method.bind(database);
    return (callback: (tx: DbClient) => Promise<unknown>, ...args: unknown[]) => {
      const completed: Promise<unknown> = Reflect.apply(method, database, [async (tx: DbClient) => {
        const value = await callback(tx); await options.beforeCommit?.(tx); return value;
      }, ...args]);
      return completed.then(value => { options.afterCommit?.(); return value; });
    };
  } });
}
function application(observe?: Parameters<typeof observed>[1]) {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null },
    error instanceof HttpApiException ? error.httpStatus : error instanceof ApiException ? 200 : 500));
  app.use('*', async (c, next) => { const container = createContainer(c.env); c.set('container', container);
    try { await next(); } finally { await container.db.$client.end({ timeout: 5 }); } });
  for (const prefix of ['/adminapi', '/api/admin']) {
    const middleware = adminRuntimeAuthMiddleware();
    const observer = async (c: Parameters<typeof adminLegacyRoleStatus>[0], next: () => Promise<void>) => {
      if (observe) c.set('container', createContainerFromDb(observed(c.get('container').db, observe))); await next();
    };
    app.post(`${prefix}/setting/role-authority/preview`, middleware, observer, adminLegacyRolePreview);
    app.get(`${prefix}/setting/role-authority/receipt/:operationId`, middleware, observer, adminLegacyRoleReceipt);
    app.post(`${prefix}/setting/role-authority/resolve`, middleware, observer, adminLegacyRoleResolve);
    app.put(`${prefix}/setting/role/set_status/:id/:status`, middleware, observer, adminLegacyRoleStatus);
    app.delete(`${prefix}/setting/role/:id`, middleware, observer, adminLegacyRoleDelete);
  }
  return app;
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('legacy role operation on actual PG16 and complete commissioned app/Admin LOGINs', () => {
  it('proves atomic v3 DELETE commissioning, real canonical impact mutations, locks, rollback and owner recovery without provider access', async () => {
    const fixture = await refundRuntimeFixture(), provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No provider access in owned native role acceptance'));
    try {
      if (!fixture.withRuntimeRole || !fixture.withPeer) throw Error('Actual independent runtime LOGINs and peer backends required');
      await fixture.withRuntimeRole(async app => fixture.withRuntimeRole!(async admin => {
        const [identity] = await fixture.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance`);
        const target = { database: String(identity.database), maintenance: String(identity.maintenance), app: app.role, admin: admin.role };
        await runRuntimeBusinessCommissioning(fixture.db, { ...target, pricingOwner: fixture.pricingOwner });
        await runAdminAuthorityOperationUpgrade(fixture.db, target); await runAdminLegacyAdminOperationUpgrade(fixture.db, target);
        for (const [kind, peer] of [['app', app], ['admin', admin]] as const) {
          expect(await auditRuntimeBusinessPrivileges(peer.db, kind, target)).toMatchObject({ ready: true, failures: [], readOnly: true });
          const [state] = await peer.exec('SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_database() AS database');
          expect(state).toMatchObject({ role: peer.role, session: peer.role, pid: peer.pid, database: target.database });
        }
        const [oldRight] = await admin.exec("SELECT has_table_privilege(current_user,'public.system_role','DELETE') AS allowed");
        expect(oldRight.allowed).toBe(false);
        await expect(admin.exec('DELETE FROM public.system_role WHERE id=2147483647')).rejects.toMatchObject({ code: '42501' });
        expect(await runAdminLegacyRoleOperationUpgrade(fixture.db, target)).toEqual({ operation: 'admin-legacy-role-operation-v3', applied: true });
        for (const [kind, peer] of [['app', app], ['admin', admin]] as const) {
          expect(await auditRuntimeBusinessPrivileges(peer.db, kind, target)).toMatchObject({ ready: true, failures: [], readOnly: true });
          const [right] = await peer.exec("SELECT has_table_privilege(current_user,'public.system_role','DELETE') AS allowed");
          expect(right.allowed).toBe(kind === 'admin');
        }
        await expect(app.exec('DELETE FROM public.system_role WHERE id=2147483647')).rejects.toMatchObject({ code: '42501' });
        await expect(app.exec('SELECT * FROM public.admin_authority_operation')).rejects.toMatchObject({ code: '42501' });
        await admin.db.transaction(tx => assertAdminLegacyRoleOperationReady(tx));
        await fixture.db.delete(systemAdmin); await fixture.db.delete(systemRole); await fixture.db.delete(systemMenus);
        await fixture.db.insert(systemMenus).values([{ id: 1, authType: 0, menuName: '平台结构' },
          { id: 2, pid: 1, authType: 2, menuName: '商品读取', apiUrl: 'product/list', methods: 'GET' }]);
        await fixture.db.insert(systemRole).values([{ id: 900, level: 1, rules: writerRules },
          { id: 50, level: 2, roleName: '被引用角色50', rules: '1,2' }, { id: 51, level: 2, roleName: '被引用角色51', rules: '2' }]);
        await fixture.db.insert(systemAdmin).values([{ id: 101, account: 'native-role-manager', pwd: password, level: 1, roles: '900' },
          { id: 102, account: 'native-role-manager-other', pwd: password, level: 1, roles: '900' },
          { id: 200, account: 'native-role-reference', pwd: password, level: 2, roles: '50' },
          { id: 201, account: 'native-role-reference-other', pwd: password, level: 2, roles: '50,51' }]);
        const env = { ...baseEnv, HYPERDRIVE: { connectionString: app.connectionString }, HYPERDRIVE_ADMIN: { connectionString: admin.connectionString } } as Env;
        const tokens = new Map<number, string>(); for (const id of [101, 102]) tokens.set(id, (await createToken(id, 'admin', md5(password), key)).token);
        const sessionExpiresAt = Math.floor(Date.now() / 1000) + 3600;
        const claims = (): LegacyRoleActor => ({ id: 101, authVersion: md5(password), expiresAt: sessionExpiresAt });
        const service = new AdminLegacyRoleOperationService(createContainerFromDb(admin.db), key);
        const snapshot = async () => ({ admins: await fixture.db.select().from(systemAdmin).orderBy(systemAdmin.id), roles: await fixture.db.select().from(systemRole).orderBy(systemRole.id),
          menus: await fixture.db.select().from(systemMenus).orderBy(systemMenus.id), receipts: await fixture.db.select().from(adminAuthorityOperation).orderBy(adminAuthorityOperation.operationId) });
        const intent = (operation: LegacyRoleOperationKind, payload: Record<string, unknown>): Intent => ({ operation_id: randomUUID(), operation, payload });
        const confirmation = async (input: Intent) => { const value = await service.preview(input, claims()); return { ...input, revision: value.revision, expires_at: value.expires_at, confirmed: true }; };
        const request = async (route: string, method: string, body?: unknown, options: { prefix?: string; actor?: number; headers?: Record<string, string>; app?: ReturnType<typeof application> } = {}) => {
          const response = await (options.app ?? application()).request(`http://owned${options.prefix ?? '/adminapi'}/${route}`, { method,
            headers: { 'Authori-zation': `Bearer ${tokens.get(options.actor ?? 101)}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
          return { http: response.status, body: await response.json() as Reply };
        };
        const preview = async (input: Intent, prefix = '/adminapi') => { const before = await snapshot(), reply = await request('setting/role-authority/preview', 'POST', input, { prefix });
          expect(reply.body.status, JSON.stringify(reply)).toBe(200); expect(await snapshot()).toEqual(before); return reply.body.data as LegacyRolePreview; };
        const commit = (input: Intent, value: LegacyRolePreview, options: Parameters<typeof request>[3] = {}, legacyDeleteBody?: unknown) => request(
          input.operation === 'legacy-role-delete' ? `setting/role/${input.payload.id}` : `setting/role/set_status/${input.payload.id}/${input.payload.status}`,
          input.operation === 'legacy-role-delete' ? 'DELETE' : 'PUT', legacyDeleteBody, { ...options, headers: { 'X-Admin-Operation-Id': input.operation_id,
            'X-Admin-Revision': value.revision, 'X-Admin-Expires-At': String(value.expires_at), 'X-Admin-Confirmed': 'true', ...options.headers } });
        // Real controller methods and actual JWT middleware at both bases.
        const original = await snapshot();
        for (const prefix of ['/adminapi', '/api/admin']) for (const status of [0, 1]) {
          const input = intent('legacy-role-status', { id: 50, status }), value = await preview(input, prefix);
          expect(value.summary.impact).toMatchObject({ reference_count: 2, active_reference_count: 2 });
          expect((await commit(input, value, { prefix })).body.data).toMatchObject({ state: 'committed', result: { id: 50, created: false } });
          expect((await snapshot()).admins).toEqual(original.admins);
        }
        for (const [index, prefix] of ['/adminapi', '/api/admin'].entries()) {
          const id = 50 + index, input = intent('legacy-role-delete', { id }), value = await preview(input, prefix);
          expect(value.summary.after).toBeNull(); const reply = await commit(input, value, { prefix }, index ? { ids: '' } : undefined);
          expect(reply.body.data).toMatchObject({ state: 'committed', result: { id, deleted: true } });
          expect(await fixture.db.select().from(systemRole).where(eq(systemRole.id, id))).toHaveLength(0); expect((await snapshot()).admins).toEqual(original.admins);
          const stored = (await snapshot()).receipts.find(row => row.operationId === input.operation_id)!;
          expect(stored.result).toMatchObject({ deleted_role: { id, level: 2, type: 0, relation_id: 0 } });
          expect((await commit(input, value, { prefix })).body.data).toEqual(reply.body.data);
        }
        expect((await request('setting/role/set_status/50/1', 'PUT')).body.status).not.toBe(200);
        const seed = async (id: number) => { await fixture.db.insert(systemRole).values({ id, level: 2, roleName: `独立角色${id}`, rules: '1,2' });
          await fixture.db.insert(systemAdmin).values({ id: 10000 + id, account: `native-reference-${id}`, pwd: password, level: 2, roles: String(id) }); };
        // Three independent peer modifications remain blocked until actual COMMIT.
        await seed(1000);
        await fixture.withPeer!(async staff => fixture.withPeer!(async role => fixture.withPeer!(async menu => {
          const input = intent('legacy-role-status', { id: 1000, status: 0 }), value = await confirmation(input), entered = gate(), release = gate(); let blocker = 0;
          const guarded = new AdminLegacyRoleOperationService(createContainerFromDb(observed(admin.db, { beforeCommit: async tx => {
            const [state] = await tx.execute(sql`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('transaction_isolation') AS isolation`);
            expect(state).toMatchObject({ role: admin.role, session: admin.role, isolation: 'read committed' }); blocker = Number(state.pid);
            const locks = Array.from(await tx.execute(sql`SELECT c.relname AS name,l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE l.pid=pg_backend_pid() AND l.granted
              AND ((c.relname IN ('system_admin','system_role') AND l.mode='ShareRowExclusiveLock') OR (c.relname='system_menus' AND l.mode='ShareLock')) ORDER BY c.relname`));
            expect(locks).toEqual([{ name: 'system_admin', mode: 'ShareRowExclusiveLock' }, { name: 'system_menus', mode: 'ShareLock' }, { name: 'system_role', mode: 'ShareRowExclusiveLock' }]); entered.release(); await release.promise;
          } })), key);
          const applied = outcome(guarded.commit(value, claims())); await entered.promise;
          const pending = [outcome(staff.exec("INSERT INTO system_admin(id,account,pwd,level,roles) VALUES(12000,'new-concurrent-reference','owned-password',2,'1000')")),
            outcome(role.exec("UPDATE system_role SET role_name='after-real-COMMIT' WHERE id=1000")), outcome(menu.exec("UPDATE system_menus SET menu_name='after-real-COMMIT' WHERE id=2"))];
          try { for (const peer of [staff, role, menu]) await waitForFinanceBlock(fixture.db, peer.pid, blocker); } finally { release.release(); }
          expect((await applied).ok).toBe(true); for (const result of await Promise.all(pending)) expect(result.ok).toBe(true);
          expect((await fixture.db.select().from(systemRole).where(eq(systemRole.id, 1000)))[0].status).toBe(0);
        })));
        // Fresh independent writes make the complete impact confirmation stale.
        await seed(1001);
        await fixture.withPeer!(async peer => {
          for (const change of ["UPDATE system_admin SET real_name='live-reference' WHERE id=11001", "INSERT INTO system_admin(id,account,pwd,level,roles) VALUES(12001,'changed-new-reference','owned-password',2,'1001')",
            "UPDATE system_menus SET menu_name='changed-live-menu' WHERE id=2", "UPDATE system_role SET rules='product.view' WHERE id=900"]) {
            const input = intent('legacy-role-status', { id: 1001, status: 0 }), value = await confirmation(input); await peer.exec(change); const after = await snapshot();
            await expect(service.commit(value, claims())).rejects.toThrow(); expect(await snapshot()).toEqual(after);
          }
        });
        await fixture.db.update(systemRole).set({ rules: writerRules }).where(eq(systemRole.id, 900));
        // Each owned trigger executes on real PG16; none is replaced by a mock.
        for (const [index, sabotage] of ['status-skip', 'status-protected', 'status-readback', 'delete-skip', 'delete-reinsert', 'delete-csv-cascade', 'delete-receipt-conflict'].entries()) {
          const id = 1010 + index; await seed(id); const deleting = sabotage.startsWith('delete'), input = intent(deleting ? 'legacy-role-delete' : 'legacy-role-status', { id, ...(deleting ? {} : { status: 0 }) });
          const value = await confirmation(input), before = await snapshot();
          const body = sabotage.endsWith('skip') ? 'RETURN NULL;' : sabotage === 'status-protected' ? 'NEW.relation_id=9; RETURN NEW;'
            : sabotage === 'status-readback' ? 'IF pg_trigger_depth()=1 THEN UPDATE public.system_role SET role_name=\'after-returning-rewrite\' WHERE id=NEW.id; END IF; RETURN NEW;'
              : sabotage === 'delete-reinsert' ? 'INSERT INTO public.system_role SELECT OLD.*; RETURN OLD;'
                : sabotage === 'delete-csv-cascade' ? `UPDATE public.system_admin SET roles='' WHERE id=${10000 + id}; RETURN OLD;`
                  : `INSERT INTO public.admin_authority_operation(operation_id,actor_id,admin_type,relation_id,operation,request_hash,revision,state,result,created_at) VALUES('${input.operation_id}',101,1,0,'legacy-role-delete','','','not_applied',NULL,extract(epoch from now())::integer); RETURN OLD;`;
          const timing = sabotage.endsWith('skip') || sabotage === 'status-protected' ? 'BEFORE' : 'AFTER';
          await fixture.exec(`CREATE FUNCTION owned_role_sabotage() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN ${body} END $$;
            CREATE TRIGGER owned_role_sabotage ${timing} ${deleting ? 'DELETE' : 'UPDATE'} ON public.system_role FOR EACH ROW WHEN(OLD.id=${id}) EXECUTE FUNCTION owned_role_sabotage()`);
          try { await expect(service.commit(value, claims())).rejects.toThrow(); expect(await snapshot()).toEqual(before); }
          finally { await fixture.exec('DROP TRIGGER owned_role_sabotage ON public.system_role; DROP FUNCTION owned_role_sabotage()'); }
        }
        // Actual COMMIT succeeds, response is lost, original owner recovers through
        // JWT middleware after writer revocation and a fresh password/session.
        await seed(1030); const lostInput = intent('legacy-role-delete', { id: 1030 }), lostPreview = await preview(lostInput);
        const lost = await commit(lostInput, lostPreview, { app: application({ afterCommit: () => { throw Error('Owned response loss after actual role COMMIT'); } }) });
        expect(lost.http).toBe(500); expect(await fixture.db.select().from(systemRole).where(eq(systemRole.id, 1030))).toHaveLength(0);
        const afterLoss = await snapshot(), recovered = await request(`setting/role-authority/receipt/${lostInput.operation_id}?operation=legacy-role-delete`, 'GET');
        expect(recovered.body.data).toMatchObject({ state: 'committed', request_hash: lostPreview.request_hash, result: { id: 1030, deleted: true } });
        expect((await request(`setting/role-authority/receipt/${lostInput.operation_id}?operation=legacy-role-delete`, 'GET', undefined, { actor: 102 })).body.status).not.toBe(200);
        await fixture.db.update(systemRole).set({ rules: 'product.view' }).where(eq(systemRole.id, 900));
        expect((await request(`setting/role-authority/receipt/${lostInput.operation_id}?operation=legacy-role-delete`, 'GET')).body.data).toEqual(recovered.body.data);
        const absent = intent('legacy-role-delete', { id: 1031 });
        expect((await request(`setting/role-authority/receipt/${absent.operation_id}?operation=legacy-role-delete`, 'GET')).body.data).toMatchObject({ state: 'unknown' });
        expect((await request('setting/role-authority/resolve', 'POST', { operation_id: absent.operation_id, operation: absent.operation })).body.data).toMatchObject({ state: 'not_applied', result: null });
        const oldToken = tokens.get(101)!; await fixture.db.update(systemAdmin).set({ pwd: 'fresh-owner-password' }).where(eq(systemAdmin.id, 101));
        tokens.set(101, (await createToken(101, 'admin', md5('fresh-owner-password'), key)).token);
        expect((await request(`setting/role-authority/receipt/${lostInput.operation_id}?operation=legacy-role-delete`, 'GET')).body.data).toEqual(recovered.body.data);
        expect((await request(`setting/role-authority/receipt/${lostInput.operation_id}?operation=legacy-role-delete`, 'GET', undefined, { headers: { 'Authori-zation': `Bearer ${oldToken}` } })).body.status).not.toBe(200);
        expect(afterLoss.receipts.some(row => row.operationId === lostInput.operation_id)).toBe(true);
        await fixture.db.update(systemAdmin).set({ pwd: password }).where(eq(systemAdmin.id, 101)); await fixture.db.update(systemRole).set({ rules: writerRules }).where(eq(systemRole.id, 900));
        tokens.set(101, (await createToken(101, 'admin', md5(password), key)).token);
        // Independent Admin LOGIN request pools contend for one permanent result.
        await seed(1040); const race = intent('legacy-role-status', { id: 1040, status: 0 }), raceValue = await preview(race);
        const raced = await Promise.all([commit(race, raceValue), request('setting/role-authority/resolve', 'POST', { operation_id: race.operation_id, operation: race.operation })]);
        expect(raced.some(reply => reply.body.status === 200)).toBe(true);
        const durable = (await request(`setting/role-authority/receipt/${race.operation_id}?operation=${race.operation}`, 'GET')).body.data as LegacyRoleReceipt;
        expect(['committed', 'not_applied']).toContain(durable.state); expect((await snapshot()).receipts.filter(row => row.operationId === race.operation_id)).toHaveLength(1);
        expect((await fixture.db.select().from(systemRole).where(eq(systemRole.id, 1040)))[0].status).toBe(durable.state === 'committed' ? 0 : 1);
        await expect(admin.exec('UPDATE public.admin_authority_operation SET actor_id=102')).rejects.toMatchObject({ code: '42501' });
        expect(provider).not.toHaveBeenCalled();
      }));
    } finally { provider.mockRestore(); await fixture.close(); }
  }, 180_000);
});
