import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDbFromConnectionString, type DbClient } from '../src/lib/di';
import { auditManagerRuntimePrivileges, inspectManagerRuntimePrivileges } from '../src/migrations/auditManagerRuntimePrivileges';
import { inspectLocalPaymentCaseLock } from '../src/migrations/localPaymentCaseLock';
import { managerRoutinePaymentSuccessor, type ManagerRoutinePaymentForward } from '../src/migrations/managerRoutinePaymentRuntime';
import { MANAGER_RUNTIME_ROLE } from '../src/migrations/managerRuntimePrivilegePlan';
import { provisionManagerRuntime, type ManagerProvisionTarget } from '../src/migrations/provisionManagerRuntime';
import { inspectRoutinePaymentRuntime, runRoutinePaymentRuntimeInstallation } from '../src/migrations/routinePaymentRuntime';
import { managerRuntimePrivilegeFixture } from './helpers/managerRuntimePrivilegeFixture';
import { validateFinanceFixtureUrl } from './helpers/financePostgres';

// Complete canonical fixture and independent PG16 LOGINs. No SQL/catalog,
// installer, source fence or credential verification implementation is mocked.
describe.sequential('fresh fixed Manager commissioning after existing Mini storage on owned PG16', () => {
  let f: Awaited<ReturnType<typeof managerRuntimePrivilegeFixture>>;
  let target: ManagerProvisionTarget, password: string;
  const clients: DbClient[] = [], owners: string[] = [];
  beforeEach(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Owned native PG16 required');
    f = await managerRuntimePrivilegeFixture();
    target = { database: f.database, maintenanceRole: 'finance_test' };
    password = Array.from(randomBytes(32), byte => byte.toString(16).padStart(2, '0')).join('');
  }, 180000);
  afterEach(async () => {
    try { await Promise.all(clients.splice(0).map(db => db.$client.end({ timeout: 2 }))); }
    finally {
      try { for (const owner of owners.splice(0)) await f.exec(`DROP OWNED BY "${owner}"; DROP ROLE "${owner}"`); }
      finally { await f?.close(); }
    }
  }, 30000);
  const login = () => {
    const url = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL!);
    url.pathname = '/' + target.database; url.username = MANAGER_RUNTIME_ROLE; url.password = password;
    const db = createDbFromConnectionString(url.href, 1); clients.push(db); return db;
  };
  const managerAbsent = async () => {
    expect(await f.db.execute(sql`SELECT oid FROM pg_roles WHERE rolname=${MANAGER_RUNTIME_ROLE}`)).toEqual([]);
  };
  const history = () => f.db.execute(sql`SELECT * FROM (
    SELECT 'attempt' AS kind,to_jsonb(t) AS payload FROM public.routine_payment_attempt t
    UNION ALL SELECT 'witness',to_jsonb(w) FROM public.routine_identity_witness w
    ) history ORDER BY kind,payload::text`);
  const rawAcl = () => f.db.execute(sql`SELECT c.relname,c.relowner::text AS owner,c.relacl::text,
    ARRAY(SELECT a.attacl::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 ORDER BY a.attnum) AS columns
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace
    AND c.relname IN('routine_identity_witness','routine_payment_attempt','payment_reconciliation_case','payment_reconciliation_action') ORDER BY c.relname`);
  const withExistingStorage = async (work: (input: ManagerRoutinePaymentForward) => Promise<void>) => {
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      const owner = 'manager_provision_case_' + randomUUID().replaceAll('-', '');
      await f.exec(`CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      owners.push(owner);
      const previous = { database: f.database, maintenance: 'finance_test', app: app.role, admin: admin.role };
      expect(await runRoutinePaymentRuntimeInstallation(f.db, previous)).toMatchObject({ applied: true, after: { ready: true } });
      // Historical presence is only retained denial evidence, never a claimed
      // cryptographic initiation, identity or original-payment authority.
      await f.db.execute(sql`INSERT INTO public.routine_payment_attempt
        VALUES('manager_provision_old','INITIATION','{"fixture_denial_presence_only":true}',1,${'a'.repeat(64)})`);
      await f.db.execute(sql`INSERT INTO public.routine_identity_witness
        VALUES(${randomUUID()},7,9,1,'{"fixture_storage_history_only":true}',1,${'b'.repeat(64)})`);
      await work({ previous, caseLockOwner: owner });
    }));
  };

  it('commissions one exact fresh LOGIN and fixed addon successor without rewriting history or rotating an existing credential', async () => {
    await withExistingStorage(async routine => {
      await managerAbsent();
      const before = await history(), successor = managerRoutinePaymentSuccessor(routine);
      expect(await provisionManagerRuntime(f.db, password, target, routine)).toMatchObject({ created: true, commissioned: true,
        role: { name: MANAGER_RUNTIME_ROLE, login: true, restricted: true, no_memberships: true, connection_limit: 15 },
        privileges: { ready: true, profileReady: true, routineStage: 'ready' } });
      await f.markManagerRoleOwned();
      const runtime = login();
      expect(await auditManagerRuntimePrivileges(runtime, successor)).toMatchObject({ ready: true, profileReady: true,
        failures: [], completeServiceCoverageVerified: false });
      const [identity] = await runtime.execute(sql`SELECT current_user AS role,session_user AS session,
        pg_backend_pid() AS pid,has_any_column_privilege(current_user,'public.payment_reconciliation_case','UPDATE') AS case_update,
        has_table_privilege(current_user,'public.routine_payment_attempt','SELECT') AS attempt_read,
        has_table_privilege(current_user,'public.routine_payment_attempt','INSERT') AS attempt_insert,
        has_table_privilege(current_user,'public.routine_identity_witness','SELECT,INSERT') AS witness,
        has_function_privilege(current_user,'public.local_payment_case_lock_v1(text)','EXECUTE') AS lock_execute`);
      const [maintenance] = await f.db.execute(sql`SELECT pg_backend_pid() AS pid`);
      expect(identity).toMatchObject({ role: MANAGER_RUNTIME_ROLE, session: MANAGER_RUNTIME_ROLE, case_update: false,
        attempt_read: true, attempt_insert: false, witness: false, lock_execute: true });
      expect(identity.pid).not.toBe(maintenance.pid);
      await expect(runtime.execute(sql`UPDATE public.payment_reconciliation_case SET id=id`)).rejects.toMatchObject({ cause: { code: '42501' } });
      expect(await history()).toEqual(before);
      const [credential] = await f.db.execute(sql`SELECT oid::text AS oid,rolpassword AS hash FROM pg_authid WHERE rolname=${MANAGER_RUNTIME_ROLE}`);
      const grants = await rawAcl();
      await expect(provisionManagerRuntime(f.db, Array.from(randomBytes(32), byte => byte.toString(16).padStart(2, '0')).join(''), target, routine)).rejects.toThrow('outcome not confirmed');
      expect((await f.db.execute(sql`SELECT oid::text AS oid,rolpassword AS hash FROM pg_authid WHERE rolname=${MANAGER_RUNTIME_ROLE}`))[0]).toEqual(credential);
      expect(await rawAcl()).toEqual(grants); expect(await history()).toEqual(before);
      expect(await auditManagerRuntimePrivileges(runtime, successor)).toMatchObject({ ready: true });
    });
  }, 60000);

  it.each(['wrong-prior', 'dirty-cap-owner'] as const)('rolls back the new role and grants on %s instead of repairing the explicit binding', async reason => {
    await withExistingStorage(async routine => {
      if (reason === 'dirty-cap-owner') await f.exec(`GRANT SELECT ON public."user" TO "${routine.caseLockOwner}"`);
      const before = await history(), grants = await rawAcl();
      const attempted = reason === 'wrong-prior'
        ? { ...routine, previous: { ...routine.previous, app: routine.previous.admin, admin: routine.previous.app } } : routine;
      await expect(provisionManagerRuntime(f.db, password, target, attempted)).rejects.toThrow('outcome not confirmed');
      await managerAbsent();
      expect(await rawAcl()).toEqual(grants); expect(await history()).toEqual(before);
      expect((await inspectLocalPaymentCaseLock(f.db)).absent).toBe(true);
      expect(await inspectRoutinePaymentRuntime(f.db, routine.previous)).toMatchObject({ ready: true });
    });
  }, 60000);

  it('keeps canonical maintenance gates and rolls back even after the complete LOGIN and forward audit succeeded inside the caller transaction', async () => {
    await withExistingStorage(async routine => {
      const before = await history(), grants = await rawAcl(), successor = managerRoutinePaymentSuccessor(routine);
      await f.withPeer!(peer => peer.db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(731670,0)`);
        await expect(provisionManagerRuntime(f.db, password, target, routine)).rejects.toThrow('outcome not confirmed');
      }));
      await managerAbsent();
      let fullAuditInside = false;
      const rollback = { $client: f.db.$client, transaction: async (...args: Parameters<typeof f.db.transaction>) =>
        f.db.transaction(async tx => {
          await tx.execute(sql`SELECT set_config('statement_timeout','4500ms',true),set_config('lock_timeout','700ms',true),
            set_config('idle_in_transaction_session_timeout','4500ms',true)`);
          const result = await args[0](tx);
          expect(result).toMatchObject({ commissioned: true, privileges: { ready: true } });
          fullAuditInside = (await inspectManagerRuntimePrivileges(tx, { requireLogin: true,
            routine: { target: successor, stage: 'ready' } })).ready;
          const [gates] = await tx.execute(sql`SELECT count(*)=3 AS ready FROM pg_locks WHERE pid=pg_backend_pid()
            AND locktype='advisory' AND objsubid=2 AND mode='ExclusiveLock' AND granted
            AND (classid=731669 AND objid=0 OR classid=731670 AND objid=0 OR classid=731812 AND objid=1)`);
          expect(gates.ready).toBe(true);
          const [caps] = await tx.execute(sql`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,
            current_setting('idle_in_transaction_session_timeout') AS idle`);
          expect(caps).toEqual({ statement: '4500ms', lock: '700ms', idle: '4500ms' });
          throw Error('rollback after actual complete commissioning');
        }, args[1]) } as unknown as DbClient;
      await expect(provisionManagerRuntime(rollback, password, target, routine)).rejects.toThrow('outcome not confirmed');
      expect(fullAuditInside).toBe(true);
      await managerAbsent();
      expect(await rawAcl()).toEqual(grants); expect(await history()).toEqual(before);
      expect((await inspectLocalPaymentCaseLock(f.db)).absent).toBe(true);
      expect(await inspectRoutinePaymentRuntime(f.db, routine.previous)).toMatchObject({ ready: true });
    });
  }, 60000);

  it('keeps the old no-binding refusal and rejects a different explicit maintenance target without creating a role', async () => {
    await withExistingStorage(async routine => {
      const before = await history(), grants = await rawAcl();
      await expect(provisionManagerRuntime(f.db, password, target)).rejects.toThrow('outcome not confirmed');
      for (const previous of [{ ...routine.previous, database: 'wrong_database' }, { ...routine.previous, maintenance: 'wrong_maintenance' }])
        await expect(provisionManagerRuntime(f.db, password, target, { ...routine, previous })).rejects.toThrow('must match');
      await managerAbsent();
      expect(await rawAcl()).toEqual(grants); expect(await history()).toEqual(before);
      expect((await inspectLocalPaymentCaseLock(f.db)).absent).toBe(true);
    });
  }, 60000);
});
