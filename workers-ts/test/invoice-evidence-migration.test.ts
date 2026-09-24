import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { checkoutPricingMigrationDatabase as sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/checkoutPricingMigrationDatabase';
import { storeOrderInvoice } from '../src/models/schema/order_auxiliary';
import { storeOrder } from '../src/models/schema/order';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { prepareSplitInvoice, materializeSplitInvoice } from '../src/services/order/SplitInvoiceAllocation';
import { MigrationService } from '../src/services/MigrationService';
import { INVOICE_EVIDENCE_SQL, INVOICE_HISTORY_V1_SQL } from '../src/migrations/invoiceEvidence';
import { INVOICE_CATALOG_VERSIONS as expected, INVOICE_EVIDENCE_CATALOG_SQL } from '../src/migrations/invoiceEvidenceCatalog';
import { inspectInvoiceEvidence, runInvoiceEvidence } from '../src/migrations/runInvoiceEvidence';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('invoice evidence controlled PG16 installation', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeEach(async () => {
    vi.stubGlobal('fetch',()=>{ throw Error('External fetch forbidden in invoice installation fixtures'); });
    f = await sequenceRunnerDatabase();
    const api = await import('drizzle-kit/api');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson({storeOrderInvoice}))).join('\n'));
  },30000);
  afterEach(async () => { try { await f?.close(); } finally { vi.unstubAllGlobals(); } },45000);
  const catalog = () => f.db.execute(sql.raw(INVOICE_EVIDENCE_CATALOG_SQL));
  const identity = () => f.db.execute(sql`SELECT oid::text,relfilenode::text FROM pg_class
    WHERE relnamespace='public'::regnamespace ORDER BY oid`);
  const seed = () => f.db.insert(storeOrderInvoice).values({uid:11,orderId:10,isPay:1,invoiceAmount:'10.00'}).returning();
  const grantBase = (role: string) => f.exec(`GRANT SELECT,INSERT,UPDATE,DELETE ON public.store_order_invoice TO "${role}";
    GRANT USAGE,SELECT ON SEQUENCE public.store_order_invoice_id_seq TO "${role}"`);
  const asRuntime = async (work: (peer: SequenceRunnerPeer & {role: string}) => Promise<void>) => {
    await f.withRuntimeRole!(async peer => { await grantBase(peer.role); await work(peer); });
  };
  it('matches reviewed PG16 fingerprints for fresh, v1 and v2 definitions', async () => {
    expect((await catalog()).find(r=>r.name==='store_order_invoice')).toMatchObject({fingerprint:expected.base,safe:true});
    await f.exec(INVOICE_HISTORY_V1_SQL);
    expect((await catalog()).filter(r=>r.present).map(r=>r.fingerprint).sort()).toEqual(
      [expected.capture,expected.protect,expected.capturedBase,expected.history].sort());
    await asRuntime(async peer => {
      expect(await inspectInvoiceEvidence(f.db,peer.role)).toMatchObject({state:'v1',runtimeReady:false});
      await runInvoiceEvidence(f.db,peer.role);
      expect((await catalog()).map(r=>r.fingerprint).sort()).toEqual(
        [expected.capture,expected.protect,expected.capturedBase,expected.history,expected.allocation].sort());
    });
  });
  it('installs fresh and repeats without changing populated data or object identities', async () => {
    await asRuntime(async peer => {
      expect(await inspectInvoiceEvidence(f.db,peer.role)).toEqual({state:'fresh',runtimeSafe:true,runtimeReady:false,preInstallHistoryUnknown:false});
      expect(await runInvoiceEvidence(f.db,peer.role)).toEqual({state:'v2',runtimeSafe:true,runtimeReady:true,preInstallHistoryUnknown:false});
      await seed();
      const before=await identity(), rows=await f.exec('SELECT * FROM public.store_order_invoice_evidence');
      await runInvoiceEvidence(f.db,peer.role); await runInvoiceEvidence(f.db,peer.role);
      expect(await identity()).toEqual(before);
      expect(await f.exec('SELECT * FROM public.store_order_invoice_evidence')).toEqual(rows);
    });
  });
  it('upgrades populated v1 without replacing history/functions/base or issuing fake baselines', async () => {
    await f.exec(INVOICE_HISTORY_V1_SQL); await seed();
    const before=await identity(), rows=await f.exec('SELECT * FROM public.store_order_invoice_evidence');
    await asRuntime(async peer => {
      await runInvoiceEvidence(f.db,peer.role);
      const after=await identity();
      expect(after.filter(r=>before.some(old=>old.oid===r.oid))).toEqual(before);
      expect(await f.exec('SELECT * FROM public.store_order_invoice_evidence')).toEqual(rows);
    });
  });
  it('preserves pre-install rows and reports unknown history; later delete captures unverified OLD', async () => {
    await seed(); const before=await f.db.select().from(storeOrderInvoice);
    await asRuntime(async peer => {
      expect(await runInvoiceEvidence(f.db,peer.role)).toMatchObject({preInstallHistoryUnknown:true,runtimeReady:true});
      expect(await f.db.select().from(storeOrderInvoice)).toEqual(before);
      expect(await f.exec('SELECT * FROM public.store_order_invoice_evidence')).toEqual([]);
      await peer.exec('DELETE FROM public.store_order_invoice');
      expect(await f.exec('SELECT kind FROM public.store_order_invoice_evidence')).toEqual([{kind:'unverified'}]);
      expect(await inspectInvoiceEvidence(f.db,peer.role)).toMatchObject({preInstallHistoryUnknown:true});
    });
  });
  it('captures issued-then-cleared history as a real LOGIN; RESET ROLE cannot regain maintenance', async () => {
    await asRuntime(async peer => {
      await runInvoiceEvidence(f.db,peer.role);
      await peer.db.insert(storeOrderInvoice).values({uid:11,orderId:10,isPay:1,invoiceAmount:'10.00'});
      await peer.exec("UPDATE public.store_order_invoice SET is_invoice=1,invoice_number='test-123'; UPDATE public.store_order_invoice SET is_invoice=-1,invoice_number=''; DELETE FROM public.store_order_invoice");
      expect(await peer.exec('SELECT kind FROM public.store_order_invoice_evidence ORDER BY kind')).toEqual([{kind:'created'},{kind:'issued'}]);
      for (const statement of [
        'INSERT INTO public.store_order_invoice_evidence SELECT * FROM public.store_order_invoice_evidence',
        'DELETE FROM public.store_order_invoice_evidence','TRUNCATE public.store_order_invoice',
        'UPDATE public.store_order_invoice_allocation SET reason=reason','DELETE FROM public.store_order_invoice_allocation',
        'TRUNCATE public.store_order_invoice_allocation','ALTER TABLE public.store_order_invoice DISABLE TRIGGER ALL',
        'SELECT public.capture_invoice_evidence()',"SET session_replication_role='replica'",'SET ROLE finance_test',
      ]) await expect(peer.exec(statement)).rejects.toMatchObject({code:'42501'});
      await expect(runInvoiceEvidence(peer.db,peer.role)).rejects.toThrow();
      await peer.exec('RESET ROLE');
      expect(await peer.exec('SELECT current_user=session_user AS same')).toEqual([{same:true}]);
    });
  });
  it('runs real invoice materialization after installation through a separate least-privilege LOGIN', async () => {
    const api=await import('drizzle-kit/api');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson({storeOrder}))).join('\n'));
    await f.db.insert(storeOrder).values({id:10,orderId:'installed-root',uid:11,paid:1,payType:'yue',payPrice:'10.00'});
    await asRuntime(async peer => {
      await runInvoiceEvidence(f.db,peer.role);
      await f.exec(`GRANT SELECT,INSERT,UPDATE ON public.store_order TO "${peer.role}"`);
      await peer.db.insert(storeOrderInvoice).values({uid:11,orderId:10,isPay:1,invoiceAmount:'10.00'});
      await withTx(createContainerFromDb(peer.db),async tx => {
        const [source]=await tx.select().from(storeOrder).where(eq(storeOrder.id,10)).for('update');
        const invoice=await prepareSplitInvoice(tx,source);
        await tx.insert(storeOrder).values([
          {...source,id:11,pid:10,orderId:'installed-a',unique:'installed-a',payPrice:'3.33'},
          {...source,id:12,pid:10,orderId:'installed-b',unique:'installed-b',payPrice:'6.67'},
        ]);
        await tx.update(storeOrder).set({pid:-1}).where(eq(storeOrder.id,10));
        await materializeSplitInvoice(tx,source,invoice,[11,12],'fulfillment',100);
      });
      expect((await peer.db.select().from(storeOrderInvoice).orderBy(storeOrderInvoice.id)).map(r=>[r.invoiceAmount,r.isDel]))
        .toEqual([['10.00',1],['3.33',0],['6.67',0]]);
      expect(await peer.exec('SELECT count(*)::int AS count FROM public.store_order_invoice_allocation')).toEqual([{count:1}]);
      expect(await peer.exec('SELECT count(*)::int AS count FROM public.store_order_invoice_evidence')).toEqual([{count:3}]);
      expect(await inspectInvoiceEvidence(f.db,peer.role)).toMatchObject({state:'v2',runtimeReady:true});
    });
  });
  it.each(['external','embedded'] as const)('accepts the actual complete %s base schema before standalone installation', async path => {
    const whole=await sequenceRunnerDatabase();
    try {
      if (path==='external') {
        for (const file of readdirSync('migrations').filter(n=>/^\d+.*\.sql$/.test(n)).sort())
          await whole.db.transaction(tx=>tx.execute(sql.raw(readFileSync(`migrations/${file}`,'utf8'))));
      } else {
        const report=await new MigrationService(createContainerFromDb(whole.db)).runAll();
        expect(report.errors).toEqual([]); expect(report.executed).toHaveLength(172);
        expect(report.executed.at(-1)).toBe('0171');
      }
      await whole.withRuntimeRole!(async peer => {
        await whole.exec(`GRANT SELECT,INSERT,UPDATE,DELETE ON public.store_order_invoice TO "${peer.role}";
          GRANT USAGE,SELECT ON SEQUENCE public.store_order_invoice_id_seq TO "${peer.role}"`);
        expect(await inspectInvoiceEvidence(whole.db,peer.role)).toMatchObject({state:'v2',runtimeReady:false});
        expect(await runInvoiceEvidence(whole.db,peer.role)).toMatchObject({state:'v2',runtimeReady:true});
        await runInvoiceEvidence(whole.db,peer.role);
      });
    } finally { await whole.close(); }
  },120000);
  it('executes the actual maintenance CLI with explicit target, install confirmation and sanitized output', async () => {
    const [identity]=await f.db.execute(sql`SELECT current_database() AS database`);
    if (typeof identity.database!=='string' || !/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(identity.database)) throw Error('Not owned fixture');
    const target=new URL(process.env.TEST_FINANCE_POSTGRES_URL!); target.pathname=`/${identity.database}`;
    await asRuntime(async peer => {
      const run=(args: string[],value=target.href) => spawnSync(process.execPath,
        ['node_modules/tsx/dist/cli.mjs','scripts/invoice-evidence-maintenance.ts',...args],
        {encoding:'utf8',windowsHide:true,timeout:45000,
          env:{...process.env,INVOICE_MAINTENANCE_DATABASE_URL:value}});
      const inspect=run(['inspect',identity.database as string,peer.role]);
      expect(inspect.error).toBeUndefined(); expect(inspect.status).toBe(2);
      expect(JSON.parse(inspect.stdout)).toMatchObject({mode:'inspect',state:'fresh',runtimeReady:false});
      const missing=run(['install',identity.database as string,peer.role]);
      expect(missing.status).not.toBe(0);
      expect(await inspectInvoiceEvidence(f.db,peer.role)).toMatchObject({state:'fresh'});
      const install=run(['install',identity.database as string,peer.role,'--confirm-install']);
      expect(install.error).toBeUndefined(); expect(install.status).toBe(0); expect(install.stderr).toBe('');
      expect(JSON.parse(install.stdout)).toMatchObject({mode:'install',state:'v2',runtimeReady:true});
      expect(run(['inspect','wrong-database',peer.role]).status).not.toBe(0);
      const absent=run(['inspect',identity.database as string,peer.role],'');
      expect(absent.status).not.toBe(0); expect(absent.stderr).toContain('no runtime URL fallback');
      await seed(); await f.exec('ALTER TABLE public.store_order_invoice DISABLE TRIGGER soi_capture_evidence');
      const failure=run(['install',identity.database as string,peer.role,'--confirm-install']);
      expect(failure.status).toBe(1); expect(failure.stdout).toBe('');
      expect(failure.stderr).toBe('Invoice maintenance failed; no automatic retry or privilege repair was attempted.\n');
      for (const result of [inspect,missing,install,absent,failure]) {
        expect(result.stdout+result.stderr).not.toContain(target.password);
        expect(result.stdout+result.stderr).not.toContain(target.href);
      }
    });
  },120000);
  const drift = [
    'ALTER TABLE public.store_order_invoice_evidence ALTER COLUMN snapshot DROP NOT NULL',
    'ALTER TABLE public.store_order_invoice_evidence DROP CONSTRAINT soie_snapshot_ck',
    'ALTER TABLE public.store_order_invoice_evidence ADD COLUMN unexpected text',
    'ALTER TABLE public.store_order_invoice_evidence ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE public.store_order_invoice_evidence DISABLE TRIGGER soie_no_rewrite',
    'ALTER TABLE public.store_order_invoice DISABLE TRIGGER soi_capture_evidence',
    'ALTER TABLE public.store_order_invoice_allocation DISABLE TRIGGER soia_no_truncate',
    'ALTER TABLE public.store_order_invoice_allocation SET UNLOGGED',
    'ALTER INDEX public.soia_source_history RENAME TO unexpected',
    'DROP INDEX public.soie_order_kind',
    'ALTER FUNCTION public.capture_invoice_evidence() SECURITY INVOKER',
    'ALTER FUNCTION public.capture_invoice_evidence() RESET search_path',
    "CREATE OR REPLACE FUNCTION public.protect_invoice_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN RETURN NEW; END $$",
    'CREATE FUNCTION public.capture_invoice_evidence(integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$',
    'GRANT INSERT ON public.store_order_invoice_evidence TO PUBLIC',
    'GRANT SELECT ON public.store_order_invoice_allocation TO PUBLIC',
    'GRANT EXECUTE ON FUNCTION public.capture_invoice_evidence() TO PUBLIC',
    'GRANT SELECT(snapshot) ON public.store_order_invoice_evidence TO PUBLIC',
    'CREATE RULE unexpected AS ON DELETE TO public.store_order_invoice_allocation DO INSTEAD NOTHING',
  ];
  it.each(drift)('rejects drift without repairing it: %s', async mutation => {
    await f.exec(INVOICE_EVIDENCE_SQL); await seed(); await f.exec(mutation);
    const before=await catalog(), ids=await identity();
    await asRuntime(async peer => {
      expect(await inspectInvoiceEvidence(f.db,peer.role)).toMatchObject({state:'drift'});
      await expect(runInvoiceEvidence(f.db,peer.role)).rejects.toThrow();
    });
    expect(await catalog()).toEqual(before); expect(await identity()).toEqual(ids);
  });
  it.each(['UPDATE','INSERT WITH GRANT OPTION'])('refuses unsafe allocation grants: %s', async privilege => {
    await asRuntime(async peer => {
      await runInvoiceEvidence(f.db,peer.role);
      await f.exec(privilege.includes('WITH') ? `GRANT INSERT ON public.store_order_invoice_allocation TO "${peer.role}" WITH GRANT OPTION`
        : `GRANT UPDATE ON public.store_order_invoice_allocation TO "${peer.role}"`);
      await expect(runInvoiceEvidence(f.db,peer.role)).rejects.toThrow();
    });
  });
  it('rolls back DDL and new grants if required base privileges are missing', async () => {
    await f.withRuntimeRole!(async peer => {
      await expect(runInvoiceEvidence(f.db,peer.role)).rejects.toThrow();
      expect(await inspectInvoiceEvidence(f.db,peer.role)).toMatchObject({state:'fresh'});
      await grantBase(peer.role); await f.exec(`REVOKE UPDATE ON public.store_order_invoice FROM "${peer.role}"`);
      await expect(runInvoiceEvidence(f.db,peer.role)).rejects.toThrow();
      expect(await inspectInvoiceEvidence(f.db,peer.role)).toMatchObject({state:'fresh'});
    });
  });
  it('rolls back partial DDL on an index-name collision without altering its owner table', async () => {
    await f.exec('CREATE TABLE public.unrelated(id integer PRIMARY KEY); ALTER INDEX public.unrelated_pkey RENAME TO soia_source_history');
    const before=await identity();
    await asRuntime(async peer => { await expect(runInvoiceEvidence(f.db,peer.role)).rejects.toThrow(); });
    expect(await identity()).toEqual(before);
  });
  it('rejects partial candidate installation rather than silently repairing it', async () => {
    await f.exec('CREATE TABLE public.store_order_invoice_evidence(invoice_id integer)');
    const before=await identity();
    await asRuntime(async peer => { await expect(runInvoiceEvidence(f.db,peer.role)).rejects.toThrow(); });
    expect(await identity()).toEqual(before);
  });
  it('rejects held base write locks and concurrent installers before creating objects', async () => {
    await asRuntime(async runtime => {
      for (const statement of ['LOCK TABLE public.store_order_invoice IN ROW EXCLUSIVE MODE','SELECT pg_advisory_xact_lock(731611,0)']) {
        await f.withPeer!(async peer => {
          await peer.exec(`BEGIN; ${statement}`);
          try { await expect(runInvoiceEvidence(f.db,runtime.role)).rejects.toThrow(); }
          finally { await peer.exec('ROLLBACK'); }
        });
        expect(await inspectInvoiceEvidence(f.db,runtime.role)).toMatchObject({state:'fresh'});
      }
    });
  });
  it('rejects role escalation, public schema CREATE and replication bypass', async () => {
    await asRuntime(async peer => {
      for (const [grant,revoke] of [
        [`GRANT finance_test TO "${peer.role}"`,`REVOKE finance_test FROM "${peer.role}"`],
        [`GRANT CREATE ON SCHEMA public TO "${peer.role}"`,`REVOKE CREATE ON SCHEMA public FROM "${peer.role}"`],
        [`GRANT SET ON PARAMETER session_replication_role TO "${peer.role}"`,`REVOKE SET ON PARAMETER session_replication_role FROM "${peer.role}"`],
      ]) {
        await f.exec(grant);
        try { await expect(runInvoiceEvidence(f.db,peer.role)).rejects.toThrow(); }
        finally { await f.exec(revoke); }
      }
      expect(await inspectInvoiceEvidence(f.db,peer.role)).toMatchObject({state:'fresh'});
    });
  });
  it('rejects bypass authority reachable via a NOINHERIT membership with SET ROLE', async () => {
    await asRuntime(async peer => {
      await f.withRuntimeRole!(async authority => {
        await f.exec(`GRANT SET ON PARAMETER session_replication_role TO "${authority.role}";
          GRANT "${authority.role}" TO "${peer.role}" WITH INHERIT FALSE, SET TRUE`);
        try {
          expect(await inspectInvoiceEvidence(f.db,peer.role)).toMatchObject({runtimeSafe:false});
          await expect(runInvoiceEvidence(f.db,peer.role)).rejects.toThrow();
        } finally {
          await f.exec(`REVOKE "${authority.role}" FROM "${peer.role}";
            REVOKE SET ON PARAMETER session_replication_role FROM "${authority.role}"`);
        }
      });
    });
  });
  it('preserves stricter session timeouts and search path after the maintenance transaction', async () => {
    await f.exec("SET statement_timeout=5000; SET lock_timeout=100; SET idle_in_transaction_session_timeout=500; SET search_path=pg_catalog,public");
    const settings=()=>f.db.execute(sql`SELECT name,setting FROM pg_settings WHERE name IN
      ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout','search_path','row_security') ORDER BY name`);
    const before=await settings();
    await asRuntime(async peer => { await runInvoiceEvidence(f.db,peer.role); });
    expect(await settings()).toEqual(before);
  });
  it('rejects enabled event triggers and wrong session mode without creating objects', async () => {
    await asRuntime(async peer => {
      await f.exec('CREATE FUNCTION public.ddl_hook() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$; CREATE EVENT TRIGGER ddl_hook ON ddl_command_start EXECUTE FUNCTION public.ddl_hook()');
      await expect(runInvoiceEvidence(f.db,peer.role)).rejects.toThrow();
      await f.exec('DROP EVENT TRIGGER ddl_hook');
      await f.exec("SET session_replication_role='replica'");
      try { await expect(runInvoiceEvidence(f.db,peer.role)).rejects.toThrow(); }
      finally { await f.exec("SET session_replication_role='origin'"); }
      expect(await inspectInvoiceEvidence(f.db,peer.role)).toMatchObject({state:'fresh'});
      await f.db.transaction(async tx => { await expect(runInvoiceEvidence(tx,peer.role)).rejects.toThrow('root database'); });
    });
  });
  it('uses only public objects despite temporary namesakes and rejects injected role names', async () => {
    await f.exec('CREATE TEMP TABLE store_order_invoice_evidence(marker integer); INSERT INTO pg_temp.store_order_invoice_evidence VALUES(23)');
    await asRuntime(async peer => {
      await expect(runInvoiceEvidence(f.db,`${peer.role}"; DROP TABLE public.store_order_invoice; --`)).rejects.toThrow('Invalid explicit');
      await runInvoiceEvidence(f.db,peer.role);
      expect(await f.exec('SELECT * FROM pg_temp.store_order_invoice_evidence')).toEqual([{marker:23}]);
    });
  });
});
