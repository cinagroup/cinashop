import { afterEach, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { spawnSync } from 'node:child_process';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { OFFLINE_CATALOG_SQL, OFFLINE_CATALOG_VERSIONS, OFFLINE_ORM_CATALOG_VERSIONS, OFFLINE_TABLES, OFFLINE_DEPENDENCIES } from '../src/migrations/offlineOrderCatalog';
import { OFFLINE_INSTALLATION_SQL, OFFLINE_ORM_INSTALLATION_SQL } from '../src/migrations/offlineOrderInstallation';
import { inspectOfflineOrderSchema, inspectOfflineOrder, runOfflineOrder, runOfflineOrderSchema } from '../src/migrations/runOfflineOrder';
import { OFFLINE_ORDER_ADMISSION_GUARD_SQL } from '../src/migrations/offlineOrderAdmission';

// Deliberately unprotected synthetic rows. FK checks alone are bypassed during
// fixture creation, never during installation; these are not trusted history.
const key = '11111111-1111-4111-8111-111111111111', order = 'xx' + '1'.repeat(30), hash = '1'.repeat(64);
const populated: Record<typeof OFFLINE_TABLES[number], string> = {
  offline_order_admission: `INSERT INTO public.offline_order_admission VALUES(1,'${key}','${hash}',1,'${order}','offline-admission-v1',1,1,false,0,'h5',1)`,
  offline_order_payment_selection: `INSERT INTO public.offline_order_payment_selection VALUES(1,'${key}',1,'${order}','offline-payment-v1','yue','','','','','','CNY',1,1)`,
  offline_order_balance: `INSERT INTO public.offline_order_balance VALUES(1,1,'${order}','offline-balance-v1',1,2,1,1,0,0,0,0,0,false,NULL,NULL,false,'{}',1)`,
  offline_order_query_evidence: `INSERT INTO public.offline_order_query_evidence VALUES('${key}','${key}',1,'${key}','offline-query-v1','wechat-signed-query','wechat','wechat','${order}','tx','SUCCESS',100,'CNY',1,'${hash}','${hash}',1)`,
  offline_order_callback_binding: `INSERT INTO public.offline_order_callback_binding VALUES(1,'${key}','${hash}','${hash}',1)`,
  offline_order_external_payment: `INSERT INTO public.offline_order_external_payment VALUES(1,1,NULL,1,'${order}','offline-external-v1','wechat','wechat','tx',1,1,0,0,0,0,0,false,NULL,NULL,false,'{}',1)`,
  offline_order_payment_dispatch: `INSERT INTO public.offline_order_payment_dispatch VALUES('${key}','${key}',1,'ISSUING','','',1,0,0)`,
};
describe('offline registered schema PG16', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>, ddl: string;
  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Owned PG16 required');
    const kit = await import('drizzle-kit/api'), models = await import('../src/models/schema');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson(models))).join('\n');
  }, 30000);
  beforeEach(async () => { f = await sequenceRunnerDatabase(); await f.exec(ddl); }, 30000);
  afterEach(async () => { await f?.close(); }, 30000);
  const identities = () => f.db.execute(sql`SELECT 'relation' AS kind,oid::text,relfilenode::text FROM pg_class WHERE relnamespace='public'::regnamespace
    UNION ALL SELECT 'function',oid::text,NULL FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY kind,oid`);
  const catalog = () => f.db.execute(sql.raw(OFFLINE_CATALOG_SQL));
  it('pins independently generated ORM and protected catalog fingerprints and preserves all existing objects', async () => {
    expect(await f.exec("SELECT count(*)::int AS count FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p')")).toEqual([{ count: 279 }]);
    expect(await inspectOfflineOrderSchema(f.db)).toEqual({ state: 'orm-pending' });
    let rows = await catalog();
    expect(rows).toHaveLength(27);
    expect(rows.filter(r => r.present)).toHaveLength(17);
    expect(rows.filter(r => r.present).every(r => r.owned && r.safe)).toBe(true);
    expect(Object.fromEntries(rows.filter(r => r.present).map(r => [r.name,r.fingerprint]))).toEqual(OFFLINE_ORM_CATALOG_VERSIONS);
    const before = await identities();
    await runOfflineOrderSchema(f.db, true);
    const installed = await identities();
    expect(installed.filter(row => before.some(old => old.kind === row.kind && old.oid === row.oid))).toEqual(before);
    rows = await catalog();
    expect(rows).toHaveLength(27);
    expect(rows.every(r => r.present && r.owned && r.safe)).toBe(true);
    expect(Object.fromEntries(rows.map(r => [r.name,r.fingerprint]))).toEqual(OFFLINE_CATALOG_VERSIONS.v1);
    await runOfflineOrderSchema(f.db); await runOfflineOrderSchema(f.db, true);
    expect(await identities()).toEqual(installed);
    expect(await inspectOfflineOrderSchema(f.db)).toEqual({ state: 'v1' });
    await expect(f.exec('TRUNCATE public.offline_order_payment_dispatch')).rejects.toThrow();
  });
  it('rejects implicit ORM completion through both root and raw registered installers', async () => {
    const before = await identities(), shape = await catalog();
    await expect(runOfflineOrderSchema(f.db)).rejects.toThrow();
    await expect(f.db.transaction(tx => tx.execute(sql.raw(OFFLINE_INSTALLATION_SQL)))).rejects.toThrow();
    expect(await identities()).toEqual(before); expect(await catalog()).toEqual(shape);
    expect(await inspectOfflineOrderSchema(f.db)).toEqual({ state: 'orm-pending' });
  });
  it.each(OFFLINE_TABLES)('refuses any unprotected data in %s without synthesizing evidence', async table => {
    await f.exec('BEGIN; SET LOCAL session_replication_role=replica; ' + populated[table] + '; COMMIT');
    expect(await f.exec('SHOW session_replication_role')).toEqual([{ session_replication_role: 'origin' }]);
    expect(await inspectOfflineOrderSchema(f.db)).toEqual({ state: 'orm-pending' });
    const before = await identities(), rows = await f.exec('SELECT * FROM public.' + table);
    await expect(runOfflineOrderSchema(f.db, true)).rejects.toThrow();
    await expect(f.db.transaction(tx => tx.execute(sql.raw(OFFLINE_ORM_INSTALLATION_SQL)))).rejects.toThrow();
    expect(await identities()).toEqual(before);
    expect(await f.exec('SELECT * FROM public.' + table)).toEqual(rows);
    expect(await inspectOfflineOrderSchema(f.db)).toEqual({ state: 'orm-pending' });
  });
  it.each([
    'ALTER TABLE public.offline_order_balance DROP CONSTRAINT oob_money_ck',
    'ALTER TABLE public.offline_order_payment_selection RENAME CONSTRAINT offline_order_payment_selection_order_id_fkey TO unexpected',
    'DROP INDEX public.prc_provider_transaction_lookup',
    'DROP INDEX public.ooqe_selection_idx',
    'ALTER TABLE public.offline_order_admission ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE public.offline_order_query_evidence DISABLE TRIGGER ALL',
    'GRANT SELECT ON public.offline_order_payment_dispatch TO PUBLIC',
    'CREATE FUNCTION public.oopd_guard(integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$',
  ])('refuses mismatched ORM catalog instead of repairing it: %s', async mutation => {
    await f.exec(mutation);
    const before = await identities(), shape = await catalog();
    expect(await inspectOfflineOrderSchema(f.db)).toEqual({ state: 'drift' });
    await expect(runOfflineOrderSchema(f.db, true)).rejects.toThrow();
    expect(await identities()).toEqual(before); expect(await catalog()).toEqual(shape);
  });
  it('does not complete a partially installed trigger protocol', async () => {
    await f.db.transaction(tx => tx.execute(sql.raw(OFFLINE_ORDER_ADMISSION_GUARD_SQL)));
    const before = await identities();
    expect(await inspectOfflineOrderSchema(f.db)).toEqual({ state: 'drift' });
    await expect(runOfflineOrderSchema(f.db, true)).rejects.toThrow(); expect(await identities()).toEqual(before);
  });
  it('locks every dependency and ledger before checking emptiness or adding guards', async () => {
    const before = await identities();
    for (const statement of ['SELECT pg_advisory_xact_lock(731611,0)', ...[...OFFLINE_DEPENDENCIES,...OFFLINE_TABLES]
      .map(table => 'LOCK TABLE public."' + table + '" IN ROW EXCLUSIVE MODE')]) {
      await f.withPeer!(async peer => {
        await peer.exec('BEGIN; ' + statement);
        try { await expect(runOfflineOrderSchema(f.db, true)).rejects.toThrow(); }
        finally { await peer.exec('ROLLBACK'); }
      });
      expect(await identities()).toEqual(before);
    }
    expect(await inspectOfflineOrderSchema(f.db)).toEqual({ state: 'orm-pending' });
  }, 30000);
  it('rolls back newly added guards if default function privileges are unsafe', async () => {
    await f.withRuntimeRole!(async peer => {
      await f.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO "' + peer.role + '"');
      const before = await identities(), shape = await catalog();
      try {
        await expect(runOfflineOrderSchema(f.db, true)).rejects.toThrow();
        expect(await identities()).toEqual(before); expect(await catalog()).toEqual(shape);
      } finally { await f.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM "' + peer.role + '"'); }
    });
    expect(await inspectOfflineOrderSchema(f.db)).toEqual({ state: 'orm-pending' });
  });
  it('explicitly commissions only offline protocol grants for a real restricted LOGIN', async () => {
    await f.withRuntimeRole!(async peer => {
      expect(await inspectOfflineOrder(f.db,peer.role)).toEqual({ state:'orm-pending', runtimeSafe:true, protocolPrivilegesReady:false });
      await expect(runOfflineOrder(f.db,peer.role)).rejects.toThrow();
      expect(await runOfflineOrder(f.db,peer.role,true)).toEqual({ state:'v1', runtimeSafe:true, protocolPrivilegesReady:true });
      for (const table of OFFLINE_TABLES) {
        expect(await peer.exec('SELECT * FROM public.'+table)).toEqual([]);
        await expect(peer.exec('DELETE FROM public.'+table)).rejects.toMatchObject({ code:'42501' });
      }
    });
  });
  it('requires explicit CLI completion and confirmation without leaking its target or credentials', async () => {
    const [identity] = await f.db.execute(sql`SELECT current_database() AS database`);
    if (typeof identity.database !== 'string' || !/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(identity.database)) throw Error('Not owned fixture');
    const target = new URL(process.env.TEST_FINANCE_POSTGRES_URL!); target.pathname='/'+identity.database;
    await f.withRuntimeRole!(async peer => {
      for (const [mode, confirmation, status] of [['inspect',false,2],['complete-orm',false,1],['install',true,1],['complete-orm',true,0]] as const) {
        const result = spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/offline-order-maintenance.ts',
          mode,identity.database as string,peer.role,...(confirmation ? ['--confirm-install'] : [])],
          { encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,OFFLINE_ORDER_MAINTENANCE_DATABASE_URL:target.href} });
        expect(result.error).toBeUndefined(); expect(result.status,result.stderr).toBe(status);
        expect(result.stdout+result.stderr).not.toContain(target.href);
        expect(result.stdout+result.stderr).not.toContain(target.password);
      }
    });
    expect(await inspectOfflineOrderSchema(f.db)).toEqual({ state:'v1' });
  }, 120000);
});
