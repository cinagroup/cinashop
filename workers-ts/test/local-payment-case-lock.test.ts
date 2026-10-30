import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { paymentReconciliationAction, paymentReconciliationCase } from '@/models/schema';
import { ROUTINE_PAYMENT_ATTEMPT_SQL } from '@/migrations/routinePaymentAttempt';
import { installLocalPaymentCaseLock, inspectLocalPaymentCaseLock, lockLocalPaymentCasesTx,
  LOCAL_PAYMENT_CASE_LOCK_SIGNATURE } from '@/migrations/localPaymentCaseLock';
import { lockStoreOrderPaymentBoundary } from '@/services/payment/StoreOrderPaymentBoundary';
import { assertLocalPaymentAdmissionTx } from '@/services/payment/LocalPaymentAdmission';
import { registerPaymentReconciliationIntent } from '@/services/payment/PaymentReconciliationRegistry';
import { PaymentReconciliationService } from '@/services/payment/PaymentReconciliationService';
import { financePostgres, ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

const ORDER = 'local_case_lock_target', OTHER = 'local_case_lock_other';
const signature = LOCAL_PAYMENT_CASE_LOCK_SIGNATURE;
const ident = (value: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) throw Error('Unsafe fixture identifier');
  return `"${value}"`;
};
function code(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === 'string') return value.code;
    current = value.cause;
  }
  return undefined;
}
async function rejectsCode(promise: Promise<unknown>, expected: string) {
  let failure: unknown;
  try { await promise; } catch (error) { failure = error; }
  expect(failure).toBeDefined(); expect(code(failure)).toBe(expected);
}
async function rollback(db: DbClient, work: (tx: DbClient) => Promise<void>) {
  const sentinel = Error('Owned capability catalog rollback');
  try { await db.transaction(async tx => { await work(tx as unknown as DbClient); throw sentinel; }); }
  catch (error) { if (error !== sentinel) throw error; }
}

describe.sequential('SELECT-only local case row locking on actual owned PG16', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  let client: ReturnType<typeof postgres> | undefined, runtime: DbClient;
  let owner: string, role: string, database: string;
  let ownerCreated = false, roleCreated = false;
  const rows = () => f.db.select().from(paymentReconciliationCase).orderBy(paymentReconciliationCase.id);
  const install = (roles: string[] = [role]) => f.db.transaction(tx => installLocalPaymentCaseLock(tx, {
    database, maintenance: 'finance_test', owner, runtimeRoles: roles,
  }));
  const prepare = async (tx: DbClient, gate = true) => {
    await tx.execute(sql`SELECT set_config('statement_timeout','5s',true),set_config('lock_timeout','2s',true),
      set_config('idle_in_transaction_session_timeout','5s',true)`);
    if (gate) {
      const [result] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock_shared(731670,0) AS locked`);
      expect(result.locked).toBe(true);
    }
    // The capability is not the complete local admission protocol. Here the
    // actual common boundary is held; the business-order lock belongs to the
    // service integration tests, not a fabricated row in this minimal fixture.
    await lockStoreOrderPaymentBoundary(tx, ORDER);
  };
  const locked = (work?: (tx: DbClient) => Promise<void>) => runtime.transaction(async value => {
    const tx = value as unknown as DbClient;
    await prepare(tx); await lockLocalPaymentCasesTx(tx, ORDER); await work?.(tx);
  });

  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Owned native PG16 is required for case lock capability');
    f = await financePostgres([paymentReconciliationCase, paymentReconciliationAction], { namespace: 'public' });
    await f.exec('CREATE UNIQUE INDEX prc_provider_order_uq ON public.payment_reconciliation_case(provider,order_no)');
    const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL);
    const [identity] = await f.db.execute<{ database: string; schema: string }>(sql`SELECT current_database() AS database,current_schema() AS schema`);
    if (identity.schema !== 'public' || !ownsFinanceFixtureTarget(identity.database, identity.schema, base.href)) throw Error('Unowned case lock fixture');
    database = identity.database;
  }, 30000);
  afterAll(async () => { await f?.close(); }, 30000);
  beforeEach(async () => {
    // Explicit owner-only raw ledger installation in this disposable fixture;
    // not a substitute for the formal runtime addon/role commissioning suite.
    await f.exec('DROP TABLE IF EXISTS public.routine_payment_attempt');
    await f.exec('DROP FUNCTION IF EXISTS public.routine_payment_attempt_immutable_v1()');
    await f.reset();
    await f.exec(ROUTINE_PAYMENT_ATTEMPT_SQL);
    owner = 'lpc_owner_' + randomUUID().replaceAll('-', ''); role = 'lpc_runtime_' + randomUUID().replaceAll('-', '');
    const password = randomUUID(); ownerCreated = roleCreated = false;
    await f.exec(`CREATE ROLE ${ident(owner)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    ownerCreated = true;
    await f.exec(`CREATE ROLE ${ident(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}' CONNECTION LIMIT 1`);
    roleCreated = true;
    await f.exec(`GRANT CONNECT ON DATABASE ${ident(database)} TO ${ident(role)};
      GRANT USAGE ON SCHEMA public TO ${ident(role)};
      GRANT SELECT ON public.payment_reconciliation_case,public.payment_reconciliation_action,public.routine_payment_attempt TO ${ident(role)}`);
    await f.db.insert(paymentReconciliationCase).values([
      { id: 1, replayKey: randomUUID(), provider: 'wechat', profile: 'routine', orderNo: ORDER, orderDomain: 'store_order', expectedAmountCents: 1250, currency: 'CNY' },
      { id: 2, replayKey: randomUUID(), provider: 'alipay', profile: 'alipay', orderNo: ORDER, orderDomain: 'store_order', expectedAmountCents: 1250, currency: 'CNY' },
      { id: 3, replayKey: randomUUID(), provider: 'wechat', profile: 'wechat', orderNo: OTHER, orderDomain: 'membership', expectedAmountCents: 1800, currency: 'CNY' },
    ]);
    const target = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL!);
    target.pathname = '/' + database; target.username = role; target.password = password;
    client = postgres(target.href, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0, max_lifetime: 0,
      connection: { options: '-c search_path=public -c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=5000' } });
    runtime = drizzle(client) as unknown as DbClient;
    const [identity] = await runtime.execute(sql`SELECT current_user AS role,session_user AS session,current_database() AS database,
      current_setting('server_version_num')::integer/10000 AS major,
      rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls AS elevated
      FROM pg_catalog.pg_roles WHERE rolname=current_user`);
    expect(identity).toEqual({ role, session: role, database, major: 16, elevated: false });
  }, 30000);
  afterEach(async () => {
    try { await client?.end({ timeout: 1 }); }
    finally {
      client = undefined;
      await f.exec(`DROP FUNCTION IF EXISTS ${signature}; DROP FUNCTION IF EXISTS public.local_payment_case_lock_v1(integer)`);
      try { if (roleCreated) await f.exec(`DROP OWNED BY ${ident(role)}; DROP ROLE ${ident(role)}`); }
      finally { if (ownerCreated) await f.exec(`DROP OWNED BY ${ident(owner)}; DROP ROLE ${ident(owner)}`); }
    }
  }, 30000);

  it('installs exactly once and exposes exact owner/function/runtime bindings without runtime case UPDATE', async () => {
    const before = await rows(); expect(await install()).toMatchObject({ applied: true, ready: true, ownerName: owner, grantees: [role] });
    expect(await install()).toMatchObject({ applied: false, ready: true });
    const state = await inspectLocalPaymentCaseLock(runtime, role);
    expect(state).toMatchObject({ ready: true, runtimeReady: true, runtimeRole: role, ownerName: owner, grantees: [role] });
    expect(state.functionOid).toMatch(/^[1-9]\d*$/u); expect(state.ownerOid).toMatch(/^[1-9]\d*$/u); expect(state.runtimeOid).toMatch(/^[1-9]\d*$/u);
    const [acl] = await runtime.execute(sql`SELECT has_table_privilege(current_user,'public.payment_reconciliation_case','SELECT') AS readable,
      has_table_privilege(current_user,'public.payment_reconciliation_case','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS writable,
      has_any_column_privilege(current_user,'public.payment_reconciliation_case','UPDATE') AS columns,
      has_function_privilege(current_user,${signature},'EXECUTE') AS executable`);
    expect(acl).toEqual({ readable: true, writable: false, columns: false, executable: true });
    await locked(async tx => {
      const [pid] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      await lockLocalPaymentCasesTx(tx, ORDER);
      expect(await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).toEqual([pid]);
    });
    expect(await rows()).toEqual(before);
  });
  it('preserves stricter caller statement/lock/idle deadlines during maintenance installation', async () => {
    await f.db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('statement_timeout','1250ms',true),set_config('lock_timeout','450ms',true),
        set_config('idle_in_transaction_session_timeout','900ms',true)`);
      await installLocalPaymentCaseLock(tx, { database, maintenance: 'finance_test', owner, runtimeRoles: [role] });
      expect(await tx.execute(sql`SELECT name,setting::integer AS milliseconds FROM pg_settings
        WHERE name IN('statement_timeout','lock_timeout','idle_in_transaction_session_timeout') ORDER BY name`)).toEqual([
        { name: 'idle_in_transaction_session_timeout', milliseconds: 900 },
        { name: 'lock_timeout', milliseconds: 450 }, { name: 'statement_timeout', milliseconds: 1250 },
      ]);
    });
  });
  it.each([
    'UPDATE public.payment_reconciliation_case SET id=id WHERE id=1',
    "UPDATE public.payment_reconciliation_case SET status='CLOSED' WHERE id=1",
    'DELETE FROM public.payment_reconciliation_case WHERE id=1',
    'TRUNCATE public.payment_reconciliation_case',
    'SELECT id FROM public.payment_reconciliation_case FOR UPDATE',
  ])('genuine SELECT-only runtime cannot use direct DML or locking SQL: %s', async statement => {
    await install(); const before = await rows(); await rejectsCode(client!.unsafe(statement), '42501'); expect(await rows()).toEqual(before);
  });
  it('has no request-time DDL/fallback when the capability is absent or its EXECUTE is revoked', async () => {
    expect(await inspectLocalPaymentCaseLock(runtime, role)).toMatchObject({ absent: true, ready: false });
    await expect(locked()).rejects.toThrow('未完整验收'); expect(await inspectLocalPaymentCaseLock(runtime, role)).toMatchObject({ absent: true });
    await install(); await f.exec(`REVOKE EXECUTE ON FUNCTION ${signature} FROM ${ident(role)}`);
    await expect(locked()).rejects.toThrow('未完整验收'); expect(await rows()).toHaveLength(3);
  });
  it('actual local admission uses the SELECT-only capability for pristine cases without any case UPDATE', async () => {
    await install(); const before = await rows();
    await runtime.transaction(async value => {
      const tx = value as unknown as DbClient; await prepare(tx);
      await assertLocalPaymentAdmissionTx(tx, { orderNo: ORDER, orderDomain: 'store_order', expectedAmountCents: 1250 });
      const [acl] = await tx.execute<{ update: boolean }>(sql`SELECT has_any_column_privilege(current_user,'public.payment_reconciliation_case','UPDATE') AS update`);
      expect(acl.update).toBe(false);
    });
    expect(await rows()).toEqual(before); expect(await f.db.select().from(paymentReconciliationAction)).toEqual([]);
  });
  it.each(['initiated', 'retry-action'] as const)(
    'actual local admission through the capability preserves and refuses %s history', async history => {
      await install();
      if (history === 'initiated') await registerPaymentReconciliationIntent(createContainerFromDb(f.db), {
        provider: 'wechat', profile: 'routine', orderDomain: 'store_order', orderNo: ORDER, expectedAmountCents: 1250, initiated: true,
      });
      else {
        await f.db.update(paymentReconciliationCase).set({ status: 'UNKNOWN', lastErrorCode: 'queue_dispatch_failed' }).where(eq(paymentReconciliationCase.id, 1));
        const environment = { APP_KEY: 'owned-case-lock-history-no-provider' } as Env;
        await new PaymentReconciliationService(createContainerFromDb(f.db), environment).decide({
          caseId: 1, adminId: 91, actionKey: randomUUID(), action: 'retry', reasonCode: 'retry_original_query',
        });
        expect(await f.db.select().from(paymentReconciliationAction)).toMatchObject([{ actionType: 'RETRY', beforeStatus: 'UNKNOWN', afterStatus: 'OPEN' }]);
      }
      const before = await rows(), actions = await f.db.select().from(paymentReconciliationAction).orderBy(paymentReconciliationAction.id);
      await expect(runtime.transaction(async value => {
        const tx = value as unknown as DbClient; await prepare(tx);
        await assertLocalPaymentAdmissionTx(tx, { orderNo: ORDER, orderDomain: 'store_order', expectedAmountCents: 1250 });
      })).rejects.toThrow('外部支付已发起');
      expect(await rows()).toEqual(before);
      expect(await f.db.select().from(paymentReconciliationAction).orderBy(paymentReconciliationAction.id)).toEqual(actions);
    });
  it('actual local admission fails closed when its SELECT-only role has no installed capability', async () => {
    const before = await rows();
    await expect(runtime.transaction(async value => {
      const tx = value as unknown as DbClient; await prepare(tx);
      await assertLocalPaymentAdmissionTx(tx, { orderNo: ORDER, orderDomain: 'store_order', expectedAmountCents: 1250 });
    })).rejects.toThrow('未完整验收');
    expect(await rows()).toEqual(before); expect(await inspectLocalPaymentCaseLock(runtime, role)).toMatchObject({ absent: true });
  });
  it('refuses a root handle and installation from the actual non-owner LOGIN', async () => {
    await expect(lockLocalPaymentCasesTx(runtime, ORDER)).rejects.toThrow('调用方事务');
    await expect(installLocalPaymentCaseLock(f.db, { database, maintenance: 'finance_test', owner, runtimeRoles: [role] })).rejects.toThrow('caller-owned');
    await expect(runtime.transaction(tx => installLocalPaymentCaseLock(tx, { database, maintenance: 'finance_test', owner, runtimeRoles: [role] }))).rejects.toThrow('maintenance');
    expect(await inspectLocalPaymentCaseLock(runtime, role)).toMatchObject({ absent: true });
  });
  it.each(['no-gate', 'repeatable-read', 'read-only', 'unbounded-statement', 'unbounded-lock', 'unbounded-idle'] as const)(
    'fixed function rejects an invalid transaction context: %s', async kind => {
      await install(); const before = await rows();
      await rejectsCode(runtime.transaction(async value => {
        const tx = value as unknown as DbClient;
        if (kind === 'repeatable-read') await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
        if (kind === 'read-only') await tx.execute(sql`SET TRANSACTION READ ONLY`);
        await prepare(tx, kind !== 'no-gate');
        if (kind === 'unbounded-statement') await tx.execute(sql`SELECT set_config('statement_timeout','0',true)`);
        if (kind === 'unbounded-lock') await tx.execute(sql`SELECT set_config('lock_timeout','0',true)`);
        if (kind === 'unbounded-idle') await tx.execute(sql`SELECT set_config('idle_in_transaction_session_timeout','0',true)`);
        await lockLocalPaymentCasesTx(tx, ORDER);
      }), '42501'); expect(await rows()).toEqual(before);
    });
  it.each(['', 'bad order', 'x'.repeat(65), 'bad\norder', 'bad\n', "bad'order"])(
    'rejects invalid exact order parameter %j before capability SQL', async orderNo => {
    await install(); await expect(runtime.transaction(value => lockLocalPaymentCasesTx(value as unknown as DbClient, orderNo))).rejects.toThrow('参数无效');
  });

  it.each([1, 2])('holds target provider case %i on the same backend, leaves other orders writable, and releases at commit', async id => {
    await install();
    await withFinancePeers(f.db, async ([writer, monitor]) => {
      let pending: ReturnType<typeof outcome<unknown>> | undefined;
      await locked(async tx => {
        const [identity] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        await writer.db.update(paymentReconciliationCase).set({ lastErrorCode: 'unrelated_allowed' }).where(eq(paymentReconciliationCase.id, 3));
        pending = outcome<unknown>(writer.db.update(paymentReconciliationCase).set({ lastErrorCode: 'after_commit' }).where(eq(paymentReconciliationCase.id, id)));
        await waitForFinanceBlock(monitor.db, writer.pid, identity.pid);
        expect(await monitor.db.select({ error: paymentReconciliationCase.lastErrorCode }).from(paymentReconciliationCase).where(eq(paymentReconciliationCase.id, id))).toEqual([{ error: '' }]);
      });
      expect((await pending!).ok).toBe(true);
    });
    const current = await rows();
    expect(current.find(row => row.id === id)?.lastErrorCode).toBe('after_commit');
    expect(current.find(row => row.id === (id === 1 ? 2 : 1))?.lastErrorCode).toBe('');
    expect(current[2].lastErrorCode).toBe('unrelated_allowed');
  });
  it('actually waits on an independent backend row lock and then continues on that same runtime connection', async () => {
    await install();
    await withFinancePeers(f.db, async ([holder, monitor]) => {
      await holder.exec('BEGIN'); await holder.exec('SELECT id FROM public.payment_reconciliation_case WHERE id=1 FOR UPDATE');
      let runtimePid = 0;
      const [identity] = await runtime.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`); runtimePid = identity.pid;
      const pending = outcome(locked());
      try { await waitForFinanceBlock(monitor.db, runtimePid, holder.pid); }
      finally { await holder.exec('COMMIT'); }
      expect((await pending).ok).toBe(true);
      expect(await runtime.execute(sql`SELECT pg_backend_pid() AS pid`)).toEqual([{ pid: runtimePid }]);
    });
  });
  it('rollback releases the real locks without changing case data', async () => {
    await install(); const before = await rows();
    await rollback(runtime, async tx => { await prepare(tx); await lockLocalPaymentCasesTx(tx, ORDER); });
    await f.db.transaction(async tx => { expect(await tx.select().from(paymentReconciliationCase).where(eq(paymentReconciliationCase.id, 1)).for('update', { noWait: true })).toHaveLength(1); });
    expect(await rows()).toEqual(before);
  });
  it('exclusive attempt maintenance prevents runtime admission, and shared runtime use prevents maintenance installation', async () => {
    await install();
    await withFinancePeers(f.db, async ([holder]) => {
      await holder.exec('BEGIN'); await holder.exec('SELECT pg_advisory_xact_lock(731670,0)');
      try { await rejectsCode(runtime.transaction(async value => { const tx = value as unknown as DbClient; await prepare(tx, false); await lockLocalPaymentCasesTx(tx, ORDER); }), '42501'); }
      finally { await holder.exec('ROLLBACK'); }
    });
    await locked(async () => { await expect(install()).rejects.toThrow('gate unavailable'); });
  });
  it('never independently takes witness 731669 and can reenter the addon attempt gate in one maintenance transaction', async () => {
    await withFinancePeers(f.db, async ([holder]) => {
      await holder.exec('BEGIN'); await holder.exec('SELECT pg_advisory_xact_lock(731669,0)');
      try {
        await f.db.transaction(async tx => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(731670,0)`);
          expect(await installLocalPaymentCaseLock(tx, { database, maintenance: 'finance_test', owner, runtimeRoles: [role] })).toMatchObject({ applied: true, ready: true });
        });
      } finally { await holder.exec('ROLLBACK'); }
    });
  });

  it.each([
    ['function-body', `CREATE OR REPLACE FUNCTION ${signature} RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS 'BEGIN RETURN; END'`],
    ['function-overload', `CREATE FUNCTION public.local_payment_case_lock_v1(integer) RETURNS void LANGUAGE plpgsql AS 'BEGIN RETURN; END'`],
    ['PUBLIC-execute', `GRANT EXECUTE ON FUNCTION ${signature} TO PUBLIC`],
    ['grant-option', `GRANT EXECUTE ON FUNCTION ${signature} TO RUNTIME WITH GRANT OPTION`],
    ['owner-table-update', 'GRANT UPDATE ON public.payment_reconciliation_case TO OWNER'],
    ['owner-default', 'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO OWNER'],
    ['owner-membership', 'GRANT OWNER TO RUNTIME'],
    ['table-extra-column', 'ALTER TABLE public.payment_reconciliation_case ADD COLUMN unexpected text'],
    ['table-RLS', 'ALTER TABLE public.payment_reconciliation_case ENABLE ROW LEVEL SECURITY'],
    ['table-index', 'DROP INDEX public.prc_provider_order_uq'],
  ])('catalog/owner/ACL drift refuses rather than repairing: %s', async (_kind, statement) => {
    await install();
    await rollback(f.db, async tx => {
      await tx.execute(sql.raw(statement.replaceAll('OWNER', ident(owner)).replaceAll('RUNTIME', ident(role))));
      expect((await inspectLocalPaymentCaseLock(tx, role)).runtimeReady).toBe(false);
      await expect(installLocalPaymentCaseLock(tx, { database, maintenance: 'finance_test', owner, runtimeRoles: [role] })).rejects.toThrow();
    });
    expect((await inspectLocalPaymentCaseLock(runtime, role)).runtimeReady).toBe(true);
  });
  it('permits only the existing implicit PUBLIC invoker baseline, not an explicit owner function grant or other definer', async () => {
    await f.exec("CREATE FUNCTION public.case_lock_fixture_invoker() RETURNS integer LANGUAGE sql AS 'SELECT 1'");
    try {
      await install(); expect((await inspectLocalPaymentCaseLock(runtime, role)).ready).toBe(true);
      await rollback(f.db, async tx => {
        await tx.execute(sql.raw(`GRANT EXECUTE ON FUNCTION public.case_lock_fixture_invoker() TO ${ident(owner)}`));
        expect((await inspectLocalPaymentCaseLock(tx, role)).ownerSafe).toBe(false);
      });
      await rollback(f.db, async tx => {
        await tx.execute(sql`ALTER FUNCTION public.case_lock_fixture_invoker() SECURITY DEFINER`);
        expect((await inspectLocalPaymentCaseLock(tx, role)).ownerSafe).toBe(false);
      });
    } finally { await f.exec('DROP FUNCTION public.case_lock_fixture_invoker()'); }
  });
  it('refuses a runtime principal that owns another object, even after schema CREATE is revoked', async () => {
    await install();
    await rollback(f.db, async tx => {
      await tx.execute(sql`CREATE TABLE public.case_lock_runtime_owned(id integer)`);
      await tx.execute(sql.raw(`GRANT CREATE ON SCHEMA public TO ${ident(role)}`));
      await tx.execute(sql.raw(`ALTER TABLE public.case_lock_runtime_owned OWNER TO ${ident(role)}`));
      await tx.execute(sql.raw(`REVOKE CREATE ON SCHEMA public FROM ${ident(role)}`));
      expect(await inspectLocalPaymentCaseLock(tx, role)).toMatchObject({ aclSafe: false, runtimeSafe: false, runtimeReady: false });
    });
    expect((await inspectLocalPaymentCaseLock(runtime, role)).runtimeReady).toBe(true);
  });
  it.each(['table-read', 'table-write', 'sequence', 'ownership'] as const)(
    'the function owner cannot acquire unrelated object authority: %s', async kind => {
      await install();
      await rollback(f.db, async tx => {
        await tx.execute(sql`CREATE TABLE public.case_lock_fixture_extra(id integer)`);
        if (kind === 'table-read') await tx.execute(sql.raw(`GRANT SELECT ON public.case_lock_fixture_extra TO ${ident(owner)}`));
        if (kind === 'table-write') await tx.execute(sql.raw(`GRANT UPDATE ON public.case_lock_fixture_extra TO ${ident(owner)}`));
        if (kind === 'sequence') {
          await tx.execute(sql`CREATE SEQUENCE public.case_lock_fixture_sequence`);
          await tx.execute(sql.raw(`GRANT USAGE ON SEQUENCE public.case_lock_fixture_sequence TO ${ident(owner)}`));
        }
        if (kind === 'ownership') {
          await tx.execute(sql.raw(`GRANT CREATE ON SCHEMA public TO ${ident(owner)}`));
          await tx.execute(sql.raw(`ALTER TABLE public.case_lock_fixture_extra OWNER TO ${ident(owner)}`));
          await tx.execute(sql.raw(`REVOKE CREATE ON SCHEMA public FROM ${ident(owner)}`));
        }
        expect((await inspectLocalPaymentCaseLock(tx, role)).ownerSafe).toBe(false);
      });
      expect((await inspectLocalPaymentCaseLock(runtime, role)).runtimeReady).toBe(true);
    });
});
