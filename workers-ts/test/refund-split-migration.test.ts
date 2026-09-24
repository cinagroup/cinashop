import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { checkoutPricingMigrationDatabase as sequenceRunnerDatabase } from './helpers/checkoutPricingMigrationDatabase';
import { storeOrderInvoice } from '../src/models/schema/order_auxiliary';
import { storeOrderRefundSplit, storeOrderFulfillmentBranch } from '../src/models/schema/order_refund_split';
import { REFUND_ORDER_SPLIT_TABLE_SQL, REFUND_ORDER_SPLIT_GUARD_SQL } from '../src/migrations/refundOrderSplit';
import { REFUND_SPLIT_CATALOG_SQL, REFUND_SPLIT_CATALOG_VERSIONS as shapes } from '../src/migrations/refundOrderSplitCatalog';
import { runInvoiceEvidenceSchema, runInvoiceEvidence } from '../src/migrations/runInvoiceEvidence';
import { runRefundOrderSplitSchema, inspectRefundOrderSplitSchema, runRefundOrderSplit, inspectRefundOrderSplit } from '../src/migrations/runRefundOrderSplit';
import { REFUND_SPLIT_INSTALLATION_SQL, REFUND_SPLIT_ORM_INSTALLATION_SQL } from '../src/migrations/refundOrderSplitInstallation';
import { MigrationService } from '../src/services/MigrationService';
import { createContainerFromDb } from '../src/lib/di';
import * as allModels from '../src/models/schema';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('refund split controlled PG16 installation',()=>{
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  const generated=async(models: Record<string,unknown>)=>{
    const api=await import('drizzle-kit/api');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson(models))).join('\n'));
  };
  beforeEach(async()=>{
    vi.stubGlobal('fetch',()=>{throw Error('External fetch forbidden');});f=await sequenceRunnerDatabase();
    await generated({storeOrderInvoice});await runInvoiceEvidenceSchema(f.db);
  },30000);
  afterEach(async()=>{try{await f?.close();}finally{vi.unstubAllGlobals();}},45000);
  const identities=()=>f.db.execute(sql`SELECT 'relation' AS kind,oid::text,relfilenode::text FROM pg_class WHERE relnamespace='public'::regnamespace
    UNION ALL SELECT 'function',oid::text,NULL FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY kind,oid`);
  const split={refundId:1,fingerprint:'a'.repeat(64),uid:11,supplierId:0,storeId:0,sourceOrderId:10,paymentOrderId:10,
    selectedOrderId:10,disposition:'whole',previousRefundId:0,returnedPointBillIds:'[]',earnedIncomeScope:'null',sourceSnapshot:'{}',partitions:'[]',addTime:1};
  const branch={id:'b'.repeat(32),sourceRefundId:1,sourceOrderId:10,paymentOrderId:10,childOrderId:11,uid:11,supplierId:0,storeId:0,
    coveredRefunds:'[]',materializedRefunds:'[]',returnedPointBillIds:'[]',partitions:'[{}]',addTime:1};
  const commissionInvoice=async(role: string)=>{
    await f.exec(`GRANT SELECT,INSERT,UPDATE,DELETE ON public.store_order_invoice TO "${role}";
      GRANT USAGE ON public.store_order_invoice_id_seq TO "${role}"`);
    await runInvoiceEvidence(f.db,role);
  };
  it.each(['sql','orm'])('canonical %s table and guard shapes',async path=>{
    if(path==='sql') await f.exec(REFUND_ORDER_SPLIT_TABLE_SQL);
    else await generated({storeOrderRefundSplit,storeOrderFulfillmentBranch});
    const bare=await f.db.execute(sql.raw(REFUND_SPLIT_CATALOG_SQL));
    expect(bare.filter(r=>r.present).map(r=>r.fingerprint).sort()).toEqual([shapes.bareSplit,shapes.bareBranch].sort());
    expect(await inspectRefundOrderSplitSchema(f.db)).toEqual({state:'orm-pending',invoiceProtectionReady:true});
    await f.exec(REFUND_ORDER_SPLIT_GUARD_SQL);
    const guarded=await f.db.execute(sql.raw(REFUND_SPLIT_CATALOG_SQL));
    expect(guarded.map(r=>r.fingerprint).sort()).toEqual([shapes.split,shapes.branch,shapes.protect].sort());
    expect(guarded.every(row=>row.present && row.owned && row.safe)).toBe(true);
  });
  it('installs additively and repeats without changing populated evidence, dependencies or identities',async()=>{
    expect(await inspectRefundOrderSplitSchema(f.db)).toEqual({state:'fresh',invoiceProtectionReady:true});
    const before=await identities();await runRefundOrderSplitSchema(f.db);
    expect((await identities()).filter(r=>before.some(old=>old.kind===r.kind && old.oid===r.oid))).toEqual(before);
    await f.db.insert(storeOrderRefundSplit).values(split);await f.db.insert(storeOrderFulfillmentBranch).values(branch);
    const after=await identities(),rows=await f.db.select().from(storeOrderRefundSplit);
    await runRefundOrderSplitSchema(f.db);await runRefundOrderSplitSchema(f.db,true);
    await f.db.transaction(tx=>tx.execute(sql.raw(REFUND_SPLIT_INSTALLATION_SQL)));
    expect(await identities()).toEqual(after);expect(await f.db.select().from(storeOrderRefundSplit)).toEqual(rows);
    for(const table of ['store_order_refund_split','store_order_fulfillment_branch'])
      for(const statement of [`UPDATE public.${table} SET uid=uid`,`DELETE FROM public.${table}`,`TRUNCATE public.${table}`])
        await expect(f.exec(statement)).rejects.toMatchObject({code:'42501'});
  });
  it('requires explicit completion for exact empty ORM ledgers',async()=>{
    await generated({storeOrderRefundSplit,storeOrderFulfillmentBranch});const before=await identities();
    await expect(runRefundOrderSplitSchema(f.db)).rejects.toThrow();
    await runRefundOrderSplitSchema(f.db,true);
    await f.db.transaction(tx=>tx.execute(sql.raw(REFUND_SPLIT_ORM_INSTALLATION_SQL)));
    expect(await inspectRefundOrderSplitSchema(f.db)).toEqual({state:'v1',invoiceProtectionReady:true});
    expect((await identities()).filter(r=>before.some(old=>old.kind===r.kind && old.oid===r.oid))).toEqual(before);
  });
  it.each(['split','branch'])('refuses populated bare ORM %s without changing it',async target=>{
    await generated({storeOrderRefundSplit,storeOrderFulfillmentBranch});
    if(target==='split') await f.db.insert(storeOrderRefundSplit).values(split);else await f.db.insert(storeOrderFulfillmentBranch).values(branch);
    const before=await identities();await expect(runRefundOrderSplitSchema(f.db,true)).rejects.toThrow();
    expect(await identities()).toEqual(before);expect((await inspectRefundOrderSplitSchema(f.db)).state).toBe('orm-pending');
  });
  const mutations=[
    'ALTER TABLE public.store_order_refund_split ALTER COLUMN source_snapshot DROP NOT NULL',
    'ALTER TABLE public.store_order_refund_split DROP CONSTRAINT sors_invoice_ck',
    'ALTER TABLE public.store_order_refund_split ADD COLUMN unexpected text',
    'ALTER TABLE public.store_order_refund_split ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE public.store_order_refund_split DISABLE TRIGGER sors_no_rewrite',
    'ALTER TABLE public.store_order_fulfillment_branch DISABLE TRIGGER sofb_no_truncate',
    'ALTER TABLE public.store_order_fulfillment_branch SET UNLOGGED',
    'ALTER INDEX public.sors_remaining_history RENAME TO unexpected',
    'DROP INDEX public.sofb_child_history',
    'ALTER FUNCTION public.protect_refund_order_split() SECURITY DEFINER',
    'ALTER FUNCTION public.protect_refund_order_split() RESET search_path',
    "CREATE OR REPLACE FUNCTION public.protect_refund_order_split() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RETURN NEW; END $$",
    'CREATE FUNCTION public.protect_refund_order_split(integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$',
    'GRANT SELECT ON public.store_order_refund_split TO PUBLIC',
    'GRANT EXECUTE ON FUNCTION public.protect_refund_order_split() TO PUBLIC',
    'GRANT SELECT(partitions) ON public.store_order_fulfillment_branch TO PUBLIC',
    'CREATE RULE unexpected AS ON DELETE TO public.store_order_refund_split DO INSTEAD NOTHING',
  ];
  it.each(mutations)('refuses drift and does not repair: %s',async mutation=>{
    await runRefundOrderSplitSchema(f.db);await f.exec(mutation);
    const before=await identities(),catalog=await f.db.execute(sql.raw(REFUND_SPLIT_CATALOG_SQL));
    expect((await inspectRefundOrderSplitSchema(f.db)).state).toBe('drift');
    await expect(runRefundOrderSplitSchema(f.db,true)).rejects.toThrow();
    expect(await identities()).toEqual(before);expect(await f.db.execute(sql.raw(REFUND_SPLIT_CATALOG_SQL))).toEqual(catalog);
  });
  it('does not install over partial/older candidate shapes or repair a collision',async()=>{
    await f.exec('CREATE TABLE public.store_order_refund_split(refund_id integer)');const before=await identities();
    await expect(runRefundOrderSplitSchema(f.db)).rejects.toThrow();expect(await identities()).toEqual(before);
  });
  it('rolls back both tables if a late guard name collides',async()=>{
    await f.exec('CREATE TABLE public.unrelated(id integer PRIMARY KEY); ALTER INDEX public.unrelated_pkey RENAME TO sofb_child_history');
    const before=await identities();await expect(runRefundOrderSplitSchema(f.db)).rejects.toThrow();
    expect(await identities()).toEqual(before);expect((await inspectRefundOrderSplitSchema(f.db)).state).toBe('fresh');
  });
  it('refuses missing or drifted invoice protection and cannot repair it',async()=>{
    await f.exec('ALTER TABLE public.store_order_invoice DISABLE TRIGGER soi_capture_evidence');const before=await identities();
    expect((await inspectRefundOrderSplitSchema(f.db)).invoiceProtectionReady).toBe(false);
    await expect(runRefundOrderSplitSchema(f.db)).rejects.toThrow();expect(await identities()).toEqual(before);
  });
  it('requires the common installation lock and every dependency/ledger table lock',async()=>{
    await f.exec(REFUND_ORDER_SPLIT_TABLE_SQL);
    for(const statement of ['SELECT pg_advisory_xact_lock(731611,0)',...['store_order_invoice','store_order_invoice_evidence',
      'store_order_invoice_allocation','store_order_refund_split','store_order_fulfillment_branch'].map(t=>`LOCK TABLE public.${t} IN ROW EXCLUSIVE MODE`)]) {
      await f.withPeer!(async peer=>{await peer.exec(`BEGIN; ${statement}`);
        try{await expect(runRefundOrderSplitSchema(f.db,true)).rejects.toThrow();}finally{await peer.exec('ROLLBACK');}});
      expect((await inspectRefundOrderSplitSchema(f.db)).state).toBe('orm-pending');
    }
  });
  it('rolls back new protection if inherited default function rights are unsafe',async()=>{
    await generated({storeOrderRefundSplit,storeOrderFulfillmentBranch});const before=await identities();
    await f.withRuntimeRole!(async peer=>{
      await f.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO "${peer.role}"`);
      try{await expect(runRefundOrderSplitSchema(f.db,true)).rejects.toThrow();expect(await identities()).toEqual(before);}
      finally{await f.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM "${peer.role}"`);}
    });
  });
  it('commissions a real LOGIN for read/append only; RESET ROLE does not regain maintenance',async()=>{
    await f.withRuntimeRole!(async peer=>{
      await commissionInvoice(peer.role);expect((await inspectRefundOrderSplit(f.db,peer.role)).runtimeReady).toBe(false);
      expect(await runRefundOrderSplit(f.db,peer.role)).toEqual({state:'v1',invoiceProtectionReady:true,runtimeSafe:true,runtimeReady:true});
      await peer.db.insert(storeOrderRefundSplit).values(split);await peer.db.insert(storeOrderFulfillmentBranch).values(branch);
      expect(await peer.db.select().from(storeOrderRefundSplit)).toHaveLength(1);expect(await peer.db.select().from(storeOrderFulfillmentBranch)).toHaveLength(1);
      for(const table of ['store_order_refund_split','store_order_fulfillment_branch'])
        for(const statement of [`UPDATE public.${table} SET uid=uid`,`DELETE FROM public.${table}`,`TRUNCATE public.${table}`,
          `ALTER TABLE public.${table} DISABLE TRIGGER ALL`,`DROP TABLE public.${table}`])
          await expect(peer.exec(statement)).rejects.toMatchObject({code:'42501'});
      for(const statement of ['SELECT public.protect_refund_order_split()',"SET session_replication_role='replica'",'SET ROLE finance_test'])
        await expect(peer.exec(statement)).rejects.toMatchObject({code:'42501'});
      await expect(runRefundOrderSplit(peer.db,peer.role)).rejects.toThrow();
      await peer.exec('RESET ROLE');expect(await peer.exec('SELECT current_user=session_user AS same')).toEqual([{same:true}]);
      await runRefundOrderSplit(f.db,peer.role);
    });
  });
  it('does not grant or install when invoice role prerequisites are incomplete',async()=>{
    await f.withRuntimeRole!(async peer=>{
      await expect(runRefundOrderSplit(f.db,peer.role)).rejects.toThrow();expect((await inspectRefundOrderSplitSchema(f.db)).state).toBe('fresh');
      await commissionInvoice(peer.role);await f.exec(`REVOKE UPDATE ON public.store_order_invoice FROM "${peer.role}"`);
      await expect(runRefundOrderSplit(f.db,peer.role)).rejects.toThrow();expect((await inspectRefundOrderSplitSchema(f.db)).state).toBe('fresh');
    });
  });
  it.each(['UPDATE','INSERT WITH GRANT OPTION'])('refuses unsafe existing ledger grants: %s',async privilege=>{
    await f.withRuntimeRole!(async peer=>{
      await commissionInvoice(peer.role);await runRefundOrderSplit(f.db,peer.role);
      await f.exec(privilege.includes('WITH') ? `GRANT INSERT ON public.store_order_refund_split TO "${peer.role}" WITH GRANT OPTION`
        : `GRANT UPDATE ON public.store_order_fulfillment_branch TO "${peer.role}"`);
      await expect(runRefundOrderSplit(f.db,peer.role)).rejects.toThrow();
    });
  });
  it('refuses inherited role authority even via NOINHERIT SET ROLE',async()=>{
    await f.withRuntimeRole!(async peer=>{
      await commissionInvoice(peer.role);
      await f.withRuntimeRole!(async authority=>{
        await f.exec(`GRANT SET ON PARAMETER session_replication_role TO "${authority.role}";
          GRANT "${authority.role}" TO "${peer.role}" WITH INHERIT FALSE, SET TRUE`);
        try{expect((await inspectRefundOrderSplit(f.db,peer.role)).runtimeSafe).toBe(false);await expect(runRefundOrderSplit(f.db,peer.role)).rejects.toThrow();}
        finally{await f.exec(`REVOKE "${authority.role}" FROM "${peer.role}"; REVOKE SET ON PARAMETER session_replication_role FROM "${authority.role}"`);}
      });
    });
  });
  it.each(['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ','SET TRANSACTION READ ONLY',"SET LOCAL session_replication_role='replica'"])
    ('raw protocol refuses incompatible transaction: %s',async statement=>{
      await expect(f.db.transaction(async tx=>{await tx.execute(sql.raw(statement));await tx.execute(sql.raw(REFUND_SPLIT_INSTALLATION_SQL));})).rejects.toThrow();
      expect((await inspectRefundOrderSplitSchema(f.db)).state).toBe('fresh');
    });
  it('uses a root transaction and restores stricter timeouts/search path',async()=>{
    await f.db.transaction(async tx=>{await expect(runRefundOrderSplitSchema(tx)).rejects.toThrow('root database');});
    await f.exec('SET statement_timeout=5000; SET lock_timeout=100; SET idle_in_transaction_session_timeout=500; SET search_path=pg_catalog,public');
    const settings=()=>f.db.execute(sql`SELECT name,setting FROM pg_settings WHERE name IN
      ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout','search_path','row_security') ORDER BY name`);
    const before=await settings();await runRefundOrderSplitSchema(f.db);expect(await settings()).toEqual(before);
  });
  it('refuses active DDL event triggers without adding objects',async()=>{
    await f.exec('CREATE FUNCTION public.ddl_hook() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$; CREATE EVENT TRIGGER ddl_hook ON ddl_command_start EXECUTE FUNCTION public.ddl_hook()');
    try{await expect(runRefundOrderSplitSchema(f.db)).rejects.toThrow();}finally{await f.exec('DROP EVENT TRIGGER ddl_hook');}
    expect((await inspectRefundOrderSplitSchema(f.db)).state).toBe('fresh');
  });
  it('uses public objects despite temporary shadows and rejects role injection',async()=>{
    await f.exec('CREATE TEMP TABLE store_order_refund_split(marker integer); INSERT INTO pg_temp.store_order_refund_split VALUES(23)');
    await expect(runRefundOrderSplit(f.db,'bad"; DROP TABLE public.store_order_invoice; --')).rejects.toThrow('Invalid explicit');
    await runRefundOrderSplitSchema(f.db);expect(await f.exec('SELECT * FROM pg_temp.store_order_refund_split')).toEqual([{marker:23}]);
  });
  it('executes the actual explicit CLI without exposing secrets or accepting implicit writes',async()=>{
    const [identity]=await f.db.execute(sql`SELECT current_database() AS database`);
    if(typeof identity.database!=='string' || !/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(identity.database)) throw Error('Not owned fixture');
    const database=identity.database,target=new URL(process.env.TEST_FINANCE_POSTGRES_URL!);target.pathname=`/${database}`;
    await f.withRuntimeRole!(async peer=>{
      await commissionInvoice(peer.role);
      const run=(args: string[],value=target.href)=>spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/refund-split-maintenance.ts',...args],
        {encoding:'utf8',windowsHide:true,timeout:45000,env:{...process.env,REFUND_SPLIT_MAINTENANCE_DATABASE_URL:value}});
      const inspect=run(['inspect',database,peer.role]);expect(inspect.status).toBe(2);expect(JSON.parse(inspect.stdout)).toMatchObject({state:'fresh',runtimeReady:false});
      const missing=run(['install',database,peer.role]);expect(missing.status).not.toBe(0);expect((await inspectRefundOrderSplitSchema(f.db)).state).toBe('fresh');
      const install=run(['install',database,peer.role,'--confirm-install']);expect(install.error).toBeUndefined();expect(install.status).toBe(0);
      expect(JSON.parse(install.stdout)).toMatchObject({state:'v1',runtimeReady:true});expect(install.stderr).toBe('');
      const wrong=run(['inspect','wrong-database',peer.role]);expect(wrong.status).not.toBe(0);
      const absent=run(['inspect',database,peer.role],'');expect(absent.status).not.toBe(0);expect(absent.stderr).toContain('no runtime URL fallback');
      await f.exec('ALTER TABLE public.store_order_fulfillment_branch DISABLE TRIGGER sofb_no_rewrite');
      const fail=run(['install',database,peer.role,'--confirm-install']);expect(fail.status).toBe(1);expect(fail.stdout).toBe('');
      expect(fail.stderr).toBe('Refund split maintenance failed; no automatic retry or evidence repair was attempted.\n');
      for(const result of [inspect,missing,install,wrong,absent,fail]){
        expect(result.stdout+result.stderr).not.toContain(target.password);expect(result.stdout+result.stderr).not.toContain(target.href);
      }
    });
  },120000);
  it('executes explicit empty ORM CLI completion and preserves both table identities',async()=>{
    await generated({storeOrderRefundSplit,storeOrderFulfillmentBranch});const before=await identities();
    const [identity]=await f.db.execute(sql`SELECT current_database() AS database`);
    if(typeof identity.database!=='string' || !/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(identity.database)) throw Error('Not owned fixture');
    const database=identity.database,target=new URL(process.env.TEST_FINANCE_POSTGRES_URL!);target.pathname=`/${database}`;
    await f.withRuntimeRole!(async peer=>{
      await commissionInvoice(peer.role);
      const result=spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/refund-split-maintenance.ts','complete-orm',database,peer.role,'--confirm-install'],
        {encoding:'utf8',windowsHide:true,timeout:45000,env:{...process.env,REFUND_SPLIT_MAINTENANCE_DATABASE_URL:target.href}});
      expect(result.error).toBeUndefined();expect(result.status).toBe(0);expect(JSON.parse(result.stdout)).toMatchObject({state:'v1',runtimeReady:true});
      expect((await identities()).filter(r=>before.some(old=>old.kind===r.kind && old.oid===r.oid))).toEqual(before);
    });
  },60000);
  it('registers identical external/embedded SQL and both complete schema exports',()=>{
    expect(readFileSync('migrations/0158_refund_order_split.sql','utf8').trim()).toBe(REFUND_SPLIT_INSTALLATION_SQL.trim());
    expect(new MigrationService(createContainerFromDb(f.db)).refundOrderSplitMigrationSqlForVerification()).toBe(REFUND_SPLIT_INSTALLATION_SQL);
    expect(allModels.storeOrderRefundSplit).toBe(storeOrderRefundSplit);expect(allModels.storeOrderFulfillmentBranch).toBe(storeOrderFulfillmentBranch);
  });
  it.each(['external','embedded','orm'])('complete %s construction has guarded refund evidence before runtime writes',async path=>{
    const whole=await sequenceRunnerDatabase();
    try {
      if(path==='external') {
        const files=readdirSync('migrations').filter(n=>/^\d+.*\.sql$/.test(n)).sort();expect(files.at(-1)).toBe('0165_assisted_order_list_index.sql');
        for(const file of files) await whole.db.transaction(tx=>tx.execute(sql.raw(readFileSync(`migrations/${file}`,'utf8'))));
      }else if(path==='embedded') {
        expect(await new MigrationService(createContainerFromDb(whole.db)).runAll()).toEqual({executed:Array.from({length: 172},(_,i)=>String(i).padStart(4,'0')),errors:[]});
      }else{
        const api=await import('drizzle-kit/api');await whole.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson(allModels))).join('\n'));
        await expect(runRefundOrderSplitSchema(whole.db,true)).rejects.toThrow();
        await runInvoiceEvidenceSchema(whole.db,true);
      }
      expect(await whole.exec("SELECT count(*)::int AS count FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p')")).toEqual([{count:279}]);
      expect(await inspectRefundOrderSplitSchema(whole.db)).toEqual({state:path==='orm'?'orm-pending':'v1',invoiceProtectionReady:true});
      if(path==='orm') await runRefundOrderSplitSchema(whole.db,true);
      await whole.db.insert(storeOrderRefundSplit).values(split);await whole.db.insert(storeOrderFulfillmentBranch).values(branch);
      const before=await whole.db.execute(sql.raw(REFUND_SPLIT_CATALOG_SQL));
      await runRefundOrderSplitSchema(whole.db);await runRefundOrderSplitSchema(whole.db);
      expect(await whole.db.execute(sql.raw(REFUND_SPLIT_CATALOG_SQL))).toEqual(before);
      expect(await whole.db.select().from(storeOrderRefundSplit)).toHaveLength(1);expect(await whole.db.select().from(storeOrderFulfillmentBranch)).toHaveLength(1);
      await expect(whole.exec('TRUNCATE public.store_order_refund_split')).rejects.toMatchObject({code:'42501'});
    }finally{await whole.close();}
  },120000);
});
