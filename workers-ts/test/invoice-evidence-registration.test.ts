import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sql } from 'drizzle-orm';
import { checkoutPricingMigrationDatabase as sequenceRunnerDatabase } from './helpers/checkoutPricingMigrationDatabase';
import { storeOrderInvoice } from '../src/models/schema/order_auxiliary';
import { storeOrderInvoiceEvidence } from '../src/models/schema/invoice_evidence';
import { storeOrderInvoiceAllocation } from '../src/models/schema/invoice_allocation';
import { INVOICE_EVIDENCE_CATALOG_SQL } from '../src/migrations/invoiceEvidenceCatalog';
import { INVOICE_HISTORY_TABLE_SQL, INVOICE_ALLOCATION_TABLE_SQL } from '../src/migrations/invoiceEvidence';
import { runInvoiceEvidenceSchema, inspectInvoiceEvidenceSchema } from '../src/migrations/runInvoiceEvidence';
import { INVOICE_EVIDENCE_INSTALLATION_SQL, INVOICE_EVIDENCE_ORM_INSTALLATION_SQL } from '../src/migrations/invoiceEvidenceInstallation';
import * as allModels from '../src/models/schema';
import { MigrationService } from '../src/services/MigrationService';
import { createContainerFromDb } from '../src/lib/di';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('registered invoice evidence PG16 construction paths',()=>{
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  beforeEach(async()=>{vi.stubGlobal('fetch',()=>{throw Error('External fetch forbidden');});f=await sequenceRunnerDatabase();},30000);
  afterEach(async()=>{try{await f?.close();}finally{vi.unstubAllGlobals();}},45000);
  const generated=async(models: Record<string,unknown>)=>{
    const api=await import('drizzle-kit/api');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson(models))).join('\n'));
  };
  const bare=()=>generated({storeOrderInvoice,storeOrderInvoiceEvidence,storeOrderInvoiceAllocation});
  const identities=()=>f.db.execute(sql`SELECT 'relation' AS kind,oid::text,relfilenode::text AS file FROM pg_class WHERE relnamespace='public'::regnamespace
    UNION ALL SELECT 'function',oid::text,NULL FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY kind,oid`);
  it.each(['sql','orm'] as const)('bare %s definitions have the same canonical table contract',async path=>{
    const api=await import('drizzle-kit/api');
    const models=path==='orm' ? {storeOrderInvoice,storeOrderInvoiceEvidence,storeOrderInvoiceAllocation} : {storeOrderInvoice};
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson(models))).join('\n'));
    if(path==='sql') await f.exec(INVOICE_HISTORY_TABLE_SQL+INVOICE_ALLOCATION_TABLE_SQL);
    const rows=await f.db.execute(sql.raw(INVOICE_EVIDENCE_CATALOG_SQL));
    expect(rows.filter(r=>r.present)).toHaveLength(3);
    expect(await inspectInvoiceEvidenceSchema(f.db)).toBe('orm-pending');
    await expect(runInvoiceEvidenceSchema(f.db)).rejects.toThrow();
    await runInvoiceEvidenceSchema(f.db,true);
    expect(await inspectInvoiceEvidenceSchema(f.db)).toBe('v2');
    await runInvoiceEvidenceSchema(f.db); await runInvoiceEvidenceSchema(f.db,true);
  });
  it('registers identical numbered external and embedded SQL without an ORM waiver or runtime role',()=>{
    const raw=readFileSync('migrations/0157_invoice_evidence.sql','utf8');
    expect(raw.trim()).toBe(INVOICE_EVIDENCE_INSTALLATION_SQL.trim());
    expect(new MigrationService(createContainerFromDb(f.db)).invoiceEvidenceMigrationSqlForVerification()).toBe(INVOICE_EVIDENCE_INSTALLATION_SQL);
    expect(allModels.storeOrderInvoiceEvidence).toBe(storeOrderInvoiceEvidence);
    expect(allModels.storeOrderInvoiceAllocation).toBe(storeOrderInvoiceAllocation);
  });
  it.each(['external','embedded','orm'] as const)('complete %s construction proves protection before runtime commissioning',async path=>{
    if(path==='external') {
      const files=readdirSync('migrations').filter(n=>/^\d+.*\.sql$/.test(n)).sort();
      expect(files.at(-1)).toBe('0165_assisted_order_list_index.sql');
      for(const file of files) await f.db.transaction(tx=>tx.execute(sql.raw(readFileSync(`migrations/${file}`,'utf8'))));
    } else if(path==='embedded') {
      expect(await new MigrationService(createContainerFromDb(f.db)).runAll()).toEqual({executed:Array.from({length: 172},(_,i)=>String(i).padStart(4,'0')),errors:[]});
    } else await generated(allModels);
    expect(await f.exec("SELECT count(*)::int AS count FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p')")).toEqual([{count:279}]);
    expect(await inspectInvoiceEvidenceSchema(f.db)).toBe(path==='orm'?'orm-pending':'v2');
    if(path==='orm') await runInvoiceEvidenceSchema(f.db,true);
    await f.db.insert(storeOrderInvoice).values({uid:11,orderId:10,isPay:1,invoiceAmount:'10.00'});
    await f.exec("UPDATE public.store_order_invoice SET is_invoice=1,invoice_number='test-123'; UPDATE public.store_order_invoice SET is_invoice=-1,invoice_number=''");
    const before=await identities(), evidence=await f.db.select().from(storeOrderInvoiceEvidence);
    expect(evidence.map(r=>r.kind).sort()).toEqual(['created','issued']);
    await runInvoiceEvidenceSchema(f.db);await runInvoiceEvidenceSchema(f.db);
    await f.db.transaction(tx=>tx.execute(sql.raw(readFileSync('migrations/0157_invoice_evidence.sql','utf8'))));
    expect(await identities()).toEqual(before);expect(await f.db.select().from(storeOrderInvoiceEvidence)).toEqual(evidence);
    await expect(f.exec('DELETE FROM public.store_order_invoice_evidence')).rejects.toMatchObject({code:'42501'});
  },120000);
  it.each(['base','history','allocation'])('refuses populated unprotected ORM %s without rewriting rows or installing functions',async target=>{
    await bare();
    if(target==='base') await f.db.insert(storeOrderInvoice).values({uid:11,orderId:10});
    if(target==='history') await f.db.insert(storeOrderInvoiceEvidence).values({invoiceId:1,kind:'created',documentNumber:'',orderId:10,uid:11,
      snapshot:JSON.stringify({v:1,invoice:{id:1,order_id:10,uid:11,category:'order',is_invoice:0,invoice_number:''}})});
    if(target==='allocation') await f.db.insert(storeOrderInvoiceAllocation).values({id:'a'.repeat(32),sourceInvoiceId:1,sourceOrderId:10,paymentOrderId:10,uid:11,
      reason:'fulfillment',sourceSnapshot:'{"id":1,"orderId":10,"uid":11}',targets:'[{},{}]',addTime:1});
    const before=await identities();
    await expect(runInvoiceEvidenceSchema(f.db,true)).rejects.toThrow();
    expect(await identities()).toEqual(before);expect(await inspectInvoiceEvidenceSchema(f.db)).toBe('orm-pending');
  });
  it.each([
    'ALTER TABLE public.store_order_invoice_evidence DROP CONSTRAINT soie_snapshot_ck',
    'ALTER TABLE public.store_order_invoice_allocation ALTER COLUMN targets DROP NOT NULL',
    'GRANT INSERT ON public.store_order_invoice_evidence TO PUBLIC',
    'CREATE FUNCTION public.protect_invoice_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
  ])('explicit ORM completion cannot repair catalog or ACL drift: %s',async mutation=>{
    await bare(); await f.exec(mutation);const before=await identities();
    await expect(runInvoiceEvidenceSchema(f.db,true)).rejects.toThrow(); expect(await identities()).toEqual(before);
  });
  it('refuses new inherited function EXECUTE rights and rolls back all ORM protection additions',async()=>{
    await bare(); const before=await identities();
    await f.withRuntimeRole!(async peer=>{
      await f.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO "${peer.role}"`);
      await expect(runInvoiceEvidenceSchema(f.db,true)).rejects.toThrow();
      expect(await identities()).toEqual(before); expect(await inspectInvoiceEvidenceSchema(f.db)).toBe('orm-pending');
      await f.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM "${peer.role}"`);
    });
  });
  it('requires base/history/allocation locks even for ORM completion',async()=>{
    await bare();
    for(const table of ['store_order_invoice','store_order_invoice_evidence','store_order_invoice_allocation']) {
      await f.withPeer!(async peer=>{
        await peer.exec(`BEGIN; LOCK TABLE public.${table} IN ROW EXCLUSIVE MODE`);
        try{await expect(runInvoiceEvidenceSchema(f.db,true)).rejects.toThrow();}finally{await peer.exec('ROLLBACK');}
      });
      expect(await inspectInvoiceEvidenceSchema(f.db)).toBe('orm-pending');
    }
  });
  it.each(['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',"SET LOCAL session_replication_role='replica'"])
    ('raw numbered SQL rejects incompatible transaction state: %s',async setup=>{
      await generated({storeOrderInvoice});
      await expect(f.db.transaction(async tx=>{await tx.execute(sql.raw(setup));await tx.execute(sql.raw(INVOICE_EVIDENCE_INSTALLATION_SQL));})).rejects.toThrow();
      expect(await inspectInvoiceEvidenceSchema(f.db)).toBe('fresh');
    });
  it('raw ORM protocol refuses read-only transactions and nested root calls',async()=>{
    await bare();
    await expect(f.db.transaction(tx=>tx.execute(sql.raw(INVOICE_EVIDENCE_ORM_INSTALLATION_SQL)),{accessMode:'read only'})).rejects.toThrow();
    await f.db.transaction(async tx=>{await expect(runInvoiceEvidenceSchema(tx,true)).rejects.toThrow('root database');});
    expect(await inspectInvoiceEvidenceSchema(f.db)).toBe('orm-pending');
  });
  it('the explicit ORM CLI completes only the selected empty schema and commissions the separate LOGIN',async()=>{
    await bare();const [identity]=await f.db.execute(sql`SELECT current_database() AS database`);
    if(typeof identity.database!=='string' || !/^cinashop_kefu_runner_[a-f0-9]{32}$/.test(identity.database)) throw Error('Not owned fixture');
    const database=identity.database,target=new URL(process.env.TEST_FINANCE_POSTGRES_URL!);target.pathname=`/${database}`;
    await f.withRuntimeRole!(async peer=>{
      await f.exec(`GRANT SELECT,INSERT,UPDATE,DELETE ON public.store_order_invoice TO "${peer.role}"; GRANT USAGE ON public.store_order_invoice_id_seq TO "${peer.role}"`);
      const result=spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/invoice-evidence-maintenance.ts','complete-orm',database,peer.role,'--confirm-install'],
        {encoding:'utf8',windowsHide:true,timeout:45000,env:{...process.env,INVOICE_MAINTENANCE_DATABASE_URL:target.href}});
      expect(result.error).toBeUndefined();expect(result.status).toBe(0);expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({mode:'complete-orm',state:'v2',runtimeReady:true});
      await peer.db.insert(storeOrderInvoice).values({uid:11,orderId:10,isPay:1,invoiceAmount:'10.00'});
      expect(await peer.db.select().from(storeOrderInvoiceEvidence)).toHaveLength(1);
    });
  },60000);
});
