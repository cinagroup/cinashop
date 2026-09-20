import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { offlinePredecessorSchemaSql } from './helpers/offlinePredecessorSchema';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { checkoutPricingMigrationDatabase as sequenceRunnerDatabase } from './helpers/checkoutPricingMigrationDatabase';
import { OFFLINE_CATALOG_SQL, OFFLINE_CATALOG_VERSIONS, OFFLINE_DEPENDENCIES, OFFLINE_TABLES } from '../src/migrations/offlineOrderCatalog';
import { OFFLINE_ORDER_ADMISSION_SQL } from '../src/migrations/offlineOrderAdmission';
import { OFFLINE_ORDER_PAYMENT_SELECTION_SQL } from '../src/migrations/offlineOrderPaymentSelection';
import { OFFLINE_ORDER_BALANCE_SQL } from '../src/migrations/offlineOrderBalance';
import { OFFLINE_ORDER_EXTERNAL_PAYMENT_SQL } from '../src/migrations/offlineOrderExternalPayment';
import { OFFLINE_ORDER_CALLBACK_DOMAIN_SQL } from '../src/migrations/offlineOrderCallbackDomain';
import { OFFLINE_ORDER_PAYMENT_DISPATCH_SQL } from '../src/migrations/offlineOrderPaymentDispatch';
import { OFFLINE_INSTALLATION_SQL } from '../src/migrations/offlineOrderInstallation';
import { inspectOfflineOrderSchema, runOfflineOrderSchema, inspectOfflineOrder, runOfflineOrder } from '../src/migrations/runOfflineOrder';
import { user, systemConfig } from '../src/models/schema';
import { createContainerFromDb } from '../src/lib/di';
import { admitOfflineOrder } from '../src/services/order/OfflineOrderAdmissionService';
import { payOfflineOrderBalance } from '../src/services/order/OfflineOrderBalanceService';
import { MigrationService } from '../src/services/MigrationService';

const candidate = [OFFLINE_ORDER_ADMISSION_SQL, OFFLINE_ORDER_PAYMENT_SELECTION_SQL, OFFLINE_ORDER_BALANCE_SQL,
  OFFLINE_ORDER_EXTERNAL_PAYMENT_SQL, OFFLINE_ORDER_CALLBACK_DOMAIN_SQL, OFFLINE_ORDER_PAYMENT_DISPATCH_SQL].join('\n');
describe('offline controlled PG16 installation', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>, ddl: string;
  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Owned native PG16 required');
    ddl = await offlinePredecessorSchemaSql();
  }, 30000);
  beforeEach(async () => { f = await sequenceRunnerDatabase(); await f.exec(ddl); }, 30000);
  afterEach(async () => { await f?.close(); }, 30000);
  it('pins the independently constructed canonical catalog', async () => {
    for (const state of ['fresh', 'v1'] as const) {
      if (state === 'v1') await f.db.transaction(tx => tx.execute(sql.raw(candidate)));
      const rows = await f.db.execute(sql.raw(OFFLINE_CATALOG_SQL));
      expect(rows).toHaveLength(27);
      expect(rows.filter(r => r.present).every(r => r.owned && r.safe)).toBe(true);
      expect(Object.fromEntries(rows.filter(r => r.present).map(r => [r.name, r.fingerprint]))).toEqual(OFFLINE_CATALOG_VERSIONS[state]);
      expect(await inspectOfflineOrderSchema(f.db)).toEqual({ state });
    }
  });
  const identities = () => f.db.execute(sql`SELECT 'relation' AS kind,oid::text,relfilenode::text FROM pg_class WHERE relnamespace='public'::regnamespace
    UNION ALL SELECT 'function',oid::text,NULL FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY kind,oid`);
  it('installs once and preserves populated receipts and every object on repeats', async () => {
    const before = await identities();
    await runOfflineOrderSchema(f.db);
    expect((await identities()).filter(r => before.some(b => b.kind === r.kind && b.oid === r.oid))).toEqual(before);
    await f.db.insert(user).values({ uid: 11, account: 'installation-buyer', nowMoney: '100.00' });
    await f.db.insert(systemConfig).values([{ menuName: 'balance_func_status', value: '1' }, { menuName: 'yue_pay_status', value: '1' }]);
    const container = createContainerFromDb(f.db), orderNo = 'xx' + '1'.repeat(30);
    await admitOfflineOrder(container, { uid: 11, requestKey: randomUUID(), money: '10.00', expectedPayPrice: '10.00', from: 'h5', orderNo });
    await payOfflineOrderBalance(container, { uid: 11, orderNo });
    const rows = await f.exec('SELECT * FROM public.offline_order_balance'), installed = await identities();
    expect(rows).toHaveLength(1);
    await runOfflineOrderSchema(f.db); await f.db.transaction(tx => tx.execute(sql.raw(OFFLINE_INSTALLATION_SQL)));
    expect(await identities()).toEqual(installed); expect(await f.exec('SELECT * FROM public.offline_order_balance')).toEqual(rows);
    await expect(f.exec('DELETE FROM public.offline_order_balance')).rejects.toThrow();
    await expect(f.exec('UPDATE public.user_money SET number=0')).rejects.toThrow();
    expect(await inspectOfflineOrderSchema(f.db)).toEqual({ state: 'v1' });
  });
  const mutations = [
    'ALTER TABLE public.offline_order_admission ALTER COLUMN request_hash DROP NOT NULL',
    'ALTER TABLE public.offline_order_balance DROP CONSTRAINT oob_money_ck',
    'ALTER TABLE public.offline_order_payment_selection ADD COLUMN unexpected text',
    'ALTER TABLE public.offline_order_callback_binding ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE public.offline_order_payment_selection DISABLE TRIGGER oops_wallet_commit',
    'ALTER TABLE public.other_order DISABLE TRIGGER ooep_paid_commit',
    'ALTER TABLE public.payment_callback_event DISABLE TRIGGER oocb_event_guard',
    'ALTER TABLE public.offline_order_external_payment SET UNLOGGED',
    'ALTER INDEX public.oopd_attempt_uq RENAME TO unexpected',
    'DROP INDEX public.prc_provider_transaction_lookup',
    'ALTER FUNCTION public.ooa_guard() SECURITY INVOKER',
    'ALTER FUNCTION public.ooep_guard() RESET search_path',
    'CREATE FUNCTION public.oopd_guard(integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$',
    'GRANT SELECT ON public.offline_order_admission TO PUBLIC',
    'GRANT UPDATE ON public.offline_order_payment_dispatch TO PUBLIC',
    'GRANT UPDATE(case_id) ON public.offline_order_payment_dispatch TO PUBLIC',
    'GRANT EXECUTE ON FUNCTION public.ooa_lock_pricing() TO PUBLIC',
    'GRANT EXECUTE ON FUNCTION public.ooep_guard() TO PUBLIC',
    'CREATE RULE unexpected AS ON DELETE TO public.offline_order_external_payment DO INSTEAD NOTHING',
    'ALTER TABLE public.payment_callback_event DROP CONSTRAINT pce_order_domain_ck',
    'ALTER TABLE public.payment_reconciliation_case DROP CONSTRAINT prc_order_domain_ck',
  ];
  it.each(mutations)('refuses drift without repairing objects: %s', async mutation => {
    await runOfflineOrderSchema(f.db); await f.exec(mutation);
    const before = await identities(), catalog = await f.db.execute(sql.raw(OFFLINE_CATALOG_SQL));
    expect((await inspectOfflineOrderSchema(f.db)).state).toBe('drift');
    await expect(runOfflineOrderSchema(f.db)).rejects.toThrow();
    expect(await identities()).toEqual(before); expect(await f.db.execute(sql.raw(OFFLINE_CATALOG_SQL))).toEqual(catalog);
  });
  it('refuses partial candidates, including widened domains without their evidence', async () => {
    await f.exec(OFFLINE_ORDER_CALLBACK_DOMAIN_SQL);
    const before = await identities();
    expect((await inspectOfflineOrderSchema(f.db)).state).toBe('drift');
    await expect(runOfflineOrderSchema(f.db)).rejects.toThrow(); expect(await identities()).toEqual(before);
  });
  it('rolls back all additions and shared domain changes on a late index collision', async () => {
    await f.exec('CREATE TABLE public.unrelated(id integer PRIMARY KEY); ALTER INDEX public.unrelated_pkey RENAME TO oopd_case_uq');
    const before = await identities();
    await expect(runOfflineOrderSchema(f.db)).rejects.toThrow(); expect(await identities()).toEqual(before);
    expect(await inspectOfflineOrderSchema(f.db)).toEqual({ state: 'fresh' });
  });
  it('requires the common advisory lock and every dependency and ledger lock without waiting', async () => {
    await runOfflineOrderSchema(f.db);
    for (const statement of ['SELECT pg_advisory_xact_lock(731611,0)', ...[...OFFLINE_DEPENDENCIES, ...OFFLINE_TABLES]
      .map(name => `LOCK TABLE public."${name}" IN ROW EXCLUSIVE MODE`)]) {
      await f.withPeer!(async peer => {
        await peer.exec('BEGIN; ' + statement);
        try { await expect(runOfflineOrderSchema(f.db)).rejects.toThrow(); } finally { await peer.exec('ROLLBACK'); }
      });
      expect(await inspectOfflineOrderSchema(f.db)).toEqual({ state: 'v1' });
    }
  }, 30000);
  it('rolls back unsafe default table and function privileges', async () => {
    await f.withRuntimeRole!(async peer => {
      for (const [privilege, kind] of [['UPDATE', 'TABLES'], ['EXECUTE', 'FUNCTIONS']]) {
        await f.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ${privilege} ON ${kind} TO "${peer.role}"`);
        const before = await identities();
        try { await expect(runOfflineOrderSchema(f.db)).rejects.toThrow(); expect(await identities()).toEqual(before); }
        finally { await f.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ${privilege} ON ${kind} FROM "${peer.role}"`); }
        expect(await inspectOfflineOrderSchema(f.db)).toEqual({ state: 'fresh' });
      }
    });
  });
  it('commissions only protocol rights for a real separate LOGIN and rejects privilege escalation', async () => {
    await f.withRuntimeRole!(async peer => {
      expect(await inspectOfflineOrder(f.db, peer.role)).toEqual({ state: 'fresh', runtimeSafe: true, protocolPrivilegesReady: false });
      expect(await runOfflineOrder(f.db, peer.role)).toEqual({ state: 'v1', runtimeSafe: true, protocolPrivilegesReady: true });
      for (const table of OFFLINE_TABLES) {
        expect(await peer.exec(`SELECT * FROM public.${table}`)).toEqual([]);
        await expect(peer.exec(`DELETE FROM public.${table}`)).rejects.toMatchObject({ code: '42501' });
        await expect(peer.exec(`TRUNCATE public.${table}`)).rejects.toMatchObject({ code: '42501' });
      }
      expect(await peer.exec('UPDATE public.offline_order_payment_dispatch SET state=state')).toEqual([]);
      for (const statement of ['UPDATE public.offline_order_payment_dispatch SET case_id=case_id',
        'SELECT public.ooa_guard()', 'ALTER TABLE public.offline_order_admission ADD COLUMN unexpected integer',
        'SET session_replication_role=replica', 'SET ROLE finance_test'])
        await expect(peer.exec(statement)).rejects.toMatchObject({ code: '42501' });
      await peer.exec('BEGIN; SELECT public.ooa_lock_pricing(); ROLLBACK');
      expect(await inspectOfflineOrder(f.db, peer.role)).toEqual({ state: 'v1', runtimeSafe: true, protocolPrivilegesReady: true });
      await f.exec(`GRANT UPDATE ON public.offline_order_balance TO "${peer.role}"`);
      expect((await inspectOfflineOrder(f.db, peer.role)).state).toBe('drift');
      await expect(runOfflineOrder(f.db, peer.role)).rejects.toThrow();
    });
  });
  it('refuses transitive NOINHERIT SET ROLE authority even before installing tables', async () => {
    await f.withRuntimeRole!(async peer => {
      await f.withRuntimeRole!(async authority => {
        await f.exec(`GRANT SET ON PARAMETER session_replication_role TO "${authority.role}";
          GRANT "${authority.role}" TO "${peer.role}" WITH INHERIT FALSE, SET TRUE`);
        try {
          expect((await inspectOfflineOrder(f.db, peer.role)).runtimeSafe).toBe(false);
          await expect(runOfflineOrder(f.db, peer.role)).rejects.toThrow();
          expect((await inspectOfflineOrderSchema(f.db)).state).toBe('fresh');
        } finally { await f.exec(`REVOKE "${authority.role}" FROM "${peer.role}"; REVOKE SET ON PARAMETER session_replication_role FROM "${authority.role}"`); }
      });
    });
  });
  it.each(['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', 'SET TRANSACTION READ ONLY', "SET LOCAL session_replication_role='replica'"])
    ('refuses incompatible raw transaction: %s', async statement => {
      await expect(f.db.transaction(async tx => { await tx.execute(sql.raw(statement)); await tx.execute(sql.raw(OFFLINE_INSTALLATION_SQL)); })).rejects.toThrow();
      expect((await inspectOfflineOrderSchema(f.db)).state).toBe('fresh');
    });
  it('rejects nested installation and restores caller timeouts and search path', async () => {
    await f.db.transaction(async tx => { await expect(runOfflineOrderSchema(tx)).rejects.toThrow('root database'); });
    await f.exec('SET statement_timeout=5000; SET lock_timeout=100; SET idle_in_transaction_session_timeout=500; SET search_path=pg_catalog,public');
    const settings = () => f.exec(`SELECT name,setting FROM pg_settings WHERE name IN
      ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout','search_path','row_security') ORDER BY name`);
    const before = await settings(); await runOfflineOrderSchema(f.db); expect(await settings()).toEqual(before);
  });
  it('refuses enabled DDL hooks and does not invoke them to repair the schema', async () => {
    await f.exec('CREATE FUNCTION public.ddl_hook() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$; CREATE EVENT TRIGGER ddl_hook ON ddl_command_start EXECUTE FUNCTION public.ddl_hook()');
    try { await expect(runOfflineOrderSchema(f.db)).rejects.toThrow(); } finally { await f.exec('DROP EVENT TRIGGER ddl_hook'); }
    expect((await inspectOfflineOrderSchema(f.db)).state).toBe('fresh');
  });
  it('uses only public objects and rejects role-name injection or trailing newlines', async () => {
    await f.exec('CREATE TEMP TABLE offline_order_admission(marker integer); INSERT INTO pg_temp.offline_order_admission VALUES(23)');
    for (const role of ['bad"; DROP TABLE public.other_order; --', 'finance_test\n'])
      await expect(runOfflineOrder(f.db, role)).rejects.toThrow('Invalid explicit');
    await runOfflineOrderSchema(f.db); expect(await f.exec('SELECT * FROM pg_temp.offline_order_admission')).toEqual([{ marker: 23 }]);
  });
  it('executes the explicit CLI and never prints credentials or accepts implicit writes', async () => {
    const [identity] = await f.db.execute(sql`SELECT current_database() AS database`);
    if (typeof identity.database !== 'string' || !/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(identity.database)) throw Error('Not owned fixture');
    const database = identity.database, target = new URL(process.env.TEST_FINANCE_POSTGRES_URL!); target.pathname = '/' + database;
    await f.withRuntimeRole!(async peer => {
      const run = (args: string[], value = target.href) => spawnSync(process.execPath,
        ['node_modules/tsx/dist/cli.mjs', 'scripts/offline-order-maintenance.ts', ...args],
        { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, OFFLINE_ORDER_MAINTENANCE_DATABASE_URL: value } });
      const first = run(['inspect', database, peer.role]); expect(first.status).toBe(2);
      expect(JSON.parse(first.stdout)).toMatchObject({ state: 'fresh', protocolPrivilegesReady: false });
      const missing = run(['install', database, peer.role]); expect(missing.status).toBe(1);
      expect((await inspectOfflineOrderSchema(f.db)).state).toBe('fresh');
      const install = run(['install', database, peer.role, '--confirm-install']); expect(install.status).toBe(0);
      expect(JSON.parse(install.stdout)).toMatchObject({ state: 'v1', protocolPrivilegesReady: true });
      const again = run(['inspect', database, peer.role]); expect(again.status).toBe(0);
      const wrong = run(['inspect', 'wrong-target', peer.role]), absent = run(['inspect', database, peer.role], '');
      expect(wrong.status).toBe(1); expect(absent.status).toBe(1);
      for (const result of [first, missing, install, again, wrong, absent]) {
        expect(result.error).toBeUndefined(); expect(result.stdout + result.stderr).not.toContain(target.password);
        expect(result.stdout + result.stderr).not.toContain(target.href);
      }
    });
  }, 120000);
  it.each(['external', 'embedded'])('registers the complete %s schema without relaxing fingerprints', async path => {
    const whole = await sequenceRunnerDatabase();
    try {
      if (path === 'external') {
        await whole.exec('SET client_min_messages=warning');
        for (const name of readdirSync('migrations').filter(n => /^\d+.*\.sql$/.test(n)).sort())
          await whole.db.transaction(tx => tx.execute(sql.raw(readFileSync('migrations/' + name, 'utf8'))));
      } else {
        await whole.exec('SET client_min_messages=warning');
        const result = await new MigrationService(createContainerFromDb(whole.db)).runAll();
        expect(result.errors).toEqual([]); expect(result.executed).toHaveLength(167);
      }
      const rows = await whole.db.execute(sql.raw(OFFLINE_CATALOG_SQL));
      expect(Object.fromEntries(rows.filter(r => r.present).map(r => [r.name, r.fingerprint]))).toEqual(OFFLINE_CATALOG_VERSIONS.v1);
      expect(await inspectOfflineOrderSchema(whole.db)).toEqual({ state: 'v1' });
      await runOfflineOrderSchema(whole.db); expect(await inspectOfflineOrderSchema(whole.db)).toEqual({ state: 'v1' });
    } finally { await whole.close(); }
  }, 120000);
});
