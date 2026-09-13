import { readFileSync, readdirSync } from 'node:fs';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Container, DbClient } from '../src/lib/di';
import { MigrationService } from '../src/services/MigrationService';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { runShippingLifecycle } from '../src/migrations/runShippingLifecycle';
import { inspectShippingLifecycleIndexes, runShippingLifecycleIndexes } from '../src/migrations/runShippingLifecycleIndexes';
import { SHIPPING_LIFECYCLE_INDEXES } from '../src/migrations/shippingLifecycleIndexes';
import { SHIPPING_LIFECYCLE_INDEX_INSTALLATION_SQL } from '../src/migrations/shippingLifecycleIndexInstallation';

const file = readFileSync('migrations/0153_shipping_lifecycle_indexes.sql','utf8');
type Owned = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
const model = async (f: Owned) => {
  const api=await import('drizzle-kit/api'),models=await import('../src/models/schema');
  await f.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson(models))).join('\n'));
};
const remove = async (f: Owned) => {
  for(const spec of SHIPPING_LIFECYCLE_INDEXES) await f.exec(`DROP INDEX IF EXISTS public.${spec.name}`);
};
const raw = (db: DbClient, statement=file) => db.transaction(async tx => { await tx.execute(sql.raw(statement)); },
  {isolationLevel:'read committed',accessMode:'read write'});
const data = (f: Owned) => f.query(`SELECT jsonb_build_object(
  'products',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.store_product p),
  'templates',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.shipping_templates p),
  'orders',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.store_order p),
  'sequences',(SELECT jsonb_agg(to_jsonb(p) ORDER BY sequencename) FROM pg_sequences p WHERE schemaname='public'),
  'reused',(SELECT jsonb_build_object('oid',c.oid,'definition',pg_get_indexdef(c.oid)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='sdp_product_discount')) AS state`);
const catalog = (f: Owned) => f.query(`SELECT c.oid,c.relname,pg_get_indexdef(c.oid) AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN (${SHIPPING_LIFECYCLE_INDEXES.map(s=>`'${s.name}'`).join(',')}) ORDER BY c.relname`);

it('mirrors external 0153 exactly and rejects non-root input before SQL', async () => {
  expect(file.trim()).toBe(SHIPPING_LIFECYCLE_INDEX_INSTALLATION_SQL.trim());
  expect(new MigrationService({} as Container).shippingLifecycleIndexMigrationSqlForVerification()).toBe(SHIPPING_LIFECYCLE_INDEX_INSTALLATION_SQL);
  await expect(runShippingLifecycleIndexes({transaction:()=>{throw new Error('unexpected SQL');}})).rejects.toThrow('root database');
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('shipping index full PG16 construction', () => {
  it.each(['external','embedded','orm-upgrade'])('matches all ten definitions on %s and preserves repeated install OIDs/data', async path => {
    const f=await sequenceRunnerDatabase();
    try {
      if(path==='external') for(const name of readdirSync('migrations').filter(n=>/^\d{4}.*\.sql$/.test(n)).sort())
        await f.db.transaction(async tx=>{await tx.execute(sql.raw('SET LOCAL search_path=public,pg_temp'));await tx.execute(sql.raw(readFileSync(`migrations/${name}`,'utf8')));});
      else if(path==='embedded') expect(await new MigrationService({db:f.db} as Container).runAll()).toEqual({executed:Array.from({length:160},(_,i)=>String(i).padStart(4,'0')),errors:[]});
      else {await model(f);await runShippingLifecycle(f.db);}
      expect((await inspectShippingLifecycleIndexes(f.db)).complete).toBe(true);
      await f.exec("INSERT INTO shipping_templates(id,name) VALUES(1,'default'),(10,'referenced'); INSERT INTO store_product(id,temp_id,freight) VALUES(1,10,3); INSERT INTO store_order(id,order_id,pay_postage) VALUES(999,'index-history','12.34')");
      const before=await data(f),indexes=await catalog(f);
      await runShippingLifecycleIndexes(f.db); await raw(f.db);
      expect(await data(f)).toEqual(before);expect(await catalog(f)).toEqual(indexes);
      if(path==='orm-upgrade') {
        await remove(f);expect((await inspectShippingLifecycleIndexes(f.db)).present).toBe(0);
        await runShippingLifecycleIndexes(f.db);expect((await inspectShippingLifecycleIndexes(f.db)).complete).toBe(true);
        expect(await data(f)).toEqual(before);
      }
    } finally {await f.close();}
  },120000);
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('shipping index guarded installation on owned full ORM PG16', () => {
  let f: Owned;
  beforeAll(async()=>{f=await sequenceRunnerDatabase();await model(f);
    await f.exec("INSERT INTO shipping_templates(id,name) VALUES(1,'default'),(10,'retained'); INSERT INTO store_product(id,temp_id,freight) VALUES(1,10,3); INSERT INTO store_order(id,order_id,pay_postage) VALUES(999,'index-retained-history','12.34')");
    await runShippingLifecycle(f.db);
  },120000);
  afterAll(async()=>{await f?.close();},45000);
  beforeEach(async()=>{await remove(f);});

  for(const path of ['file','standalone']) describe(path,()=>{
    const install=()=>path==='file'?raw(f.db):runShippingLifecycleIndexes(f.db);
    it('adds missing indexes and preserves a compatible existing subset plus the package source index',async()=>{
      await f.exec(SHIPPING_LIFECYCLE_INDEXES[0].ddl);
      const before=await data(f),prior=await catalog(f);
      await install();expect((await inspectShippingLifecycleIndexes(f.db)).complete).toBe(true);
      expect((await catalog(f)).rows).toEqual(expect.arrayContaining(prior.rows));expect(await data(f)).toEqual(before);
    });
    it.each([
      ['wrong expression','CREATE INDEX sp_shipping_ref ON store_product(temp_id)'],
      ['partial','CREATE INDEX sp_shipping_ref ON store_product(temp_id) WHERE is_del=0'],
      ['unique','CREATE UNIQUE INDEX sp_shipping_ref ON store_product(temp_id)'],
      ['include','CREATE INDEX sp_shipping_ref ON store_product(temp_id) INCLUDE(id)'],
      ['descending','CREATE INDEX sp_shipping_ref ON store_product(temp_id DESC)'],
      ['wrong access method','CREATE INDEX sp_shipping_ref ON store_product USING hash(temp_id)'],
      ['wrong table','CREATE INDEX sp_shipping_ref ON store_seckill(temp_id)'],
    ])('rejects %s without repairing or creating missing indexes',async(_,ddl)=>{
      await f.exec(ddl);const before=await catalog(f),rows=await data(f);
      await expect(install()).rejects.toThrow('Shipping lifecycle index definition drift');
      expect(await catalog(f)).toEqual(before);expect(await data(f)).toEqual(rows);
    });
    it('rejects a missing reused package source index instead of recreating it',async()=>{
      await f.exec('DROP INDEX public.sdp_product_discount');
      try{await expect(install()).rejects.toThrow('package source index');expect((await inspectShippingLifecycleIndexes(f.db)).present).toBe(0);}
      finally{await f.exec('CREATE INDEX sdp_product_discount ON public.store_discounts_products(product_id,discount_id)');}
    });
    it('rejects a renamed protocol function and never repairs it implicitly',async()=>{
      await f.exec('ALTER FUNCTION public.shipping_lifecycle_parent() RENAME TO qa_saved_shipping_parent');
      try{await expect(install()).rejects.toThrow('complete exact lifecycle protocol');expect((await inspectShippingLifecycleIndexes(f.db)).present).toBe(0);}
      finally{await f.exec('ALTER FUNCTION public.qa_saved_shipping_parent() RENAME TO shipping_lifecycle_parent');}
    });
    it('rejects enabled relation side effects even for repeated complete indexes',async()=>{
      await install();const before=await catalog(f);
      await f.exec("CREATE FUNCTION public.qa_index_side_effect() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'; CREATE TRIGGER qa_index_side_effect BEFORE UPDATE ON public.store_product FOR EACH ROW EXECUTE FUNCTION public.qa_index_side_effect()");
      try{await expect(install()).rejects.toThrow('environment requires review');expect(await catalog(f)).toEqual(before);}
      finally{await f.exec('DROP TRIGGER qa_index_side_effect ON public.store_product; DROP FUNCTION public.qa_index_side_effect()');}
    });
    it.each(['indisvalid','indisready','indislive','indimmediate'])('rejects a false %s catalog flag without repairing it',async flag=>{
      await f.exec(SHIPPING_LIFECYCLE_INDEXES[0].ddl);
      // Only this helper-owned throwaway database; always restore the catalog
      // flag before cleanup so normal DROP INDEX remains safe and predictable.
      await f.exec(`UPDATE pg_catalog.pg_index SET ${flag}=false WHERE indexrelid='public.sp_shipping_ref'::regclass`);
      try {
        expect((await inspectShippingLifecycleIndexes(f.db)).drift).toBe(true);
        await expect(install()).rejects.toThrow('Shipping lifecycle index definition drift');
        expect((await inspectShippingLifecycleIndexes(f.db)).present).toBe(1);
        expect((await f.query(`SELECT ${flag} AS flag FROM pg_catalog.pg_index WHERE indexrelid='public.sp_shipping_ref'::regclass`)).rows).toEqual([{flag:false}]);
      } finally {await f.exec(`UPDATE pg_catalog.pg_index SET ${flag}=true WHERE indexrelid='public.sp_shipping_ref'::regclass`);}
    });
    it('rejects a view occupying a managed name without removing it',async()=>{
      await f.exec('CREATE VIEW public.sp_shipping_ref AS SELECT 1 AS retained');
      try {
        await expect(install()).rejects.toThrow('Shipping lifecycle index definition drift');
        expect((await f.query('SELECT retained FROM public.sp_shipping_ref')).rows).toEqual([{retained:1}]);
      } finally {await f.exec('DROP VIEW public.sp_shipping_ref');}
    });
  });

  it.each(['shipping_templates','store_bargain','store_combination','store_discounts_products','store_integral','store_product','store_seckill'])('refuses an existing %s writer and releases partial acquired locks',async table=>{
    await f.withPeer!(async peer=>{
      await peer.exec(`BEGIN; LOCK TABLE public.${table} IN ROW EXCLUSIVE MODE`);
      try{await expect(runShippingLifecycleIndexes(f.db)).rejects.toMatchObject({cause:{code:'55P03'}});}
      finally{await peer.exec('ROLLBACK');}
      await peer.exec('BEGIN; LOCK TABLE public.shipping_templates,public.store_bargain,public.store_combination,public.store_discounts_products,public.store_integral,public.store_product,public.store_seckill IN ROW EXCLUSIVE MODE NOWAIT; ROLLBACK');
    });
    expect((await inspectShippingLifecycleIndexes(f.db)).present).toBe(0);
  });
  it('rolls back every partial creation on a middle DDL failure',async()=>{
    const before=await data(f);
    const injected=file.replace('EXECUTE item.ddl;',"EXECUTE item.ddl; IF item.name='sint_shipping_source' THEN RAISE EXCEPTION 'injected index DDL failure'; END IF;");
    expect(injected).not.toBe(file);await expect(raw(f.db,injected)).rejects.toThrow('injected index DDL failure');
    expect((await inspectShippingLifecycleIndexes(f.db)).present).toBe(0);expect(await data(f)).toEqual(before);
  });
  it('rolls back all creations when final exact verification finds drift',async()=>{
    const injected=file.replace('  -- All creations',"  ALTER INDEX public.sp_shipping_ref SET (fillfactor=80);\n  -- All creations");
    expect(injected).not.toBe(file);await expect(raw(f.db,injected)).rejects.toThrow('differ after installation');
    expect((await inspectShippingLifecycleIndexes(f.db)).present).toBe(0);
  });
  it('cannot install as a real SELECT-only LOGIN',async()=>{
    await f.withRuntimeRole!(async runtime=>{
      await f.exec(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${runtime.role}"`);
      await expect(runShippingLifecycleIndexes(runtime.db)).rejects.toThrow();
    });
    expect((await inspectShippingLifecycleIndexes(f.db)).present).toBe(0);
  });
  it('refuses a repeatable-read raw installation before index creation',async()=>{
    await expect(f.db.transaction(async tx=>{await tx.execute(sql.raw(file));},
      {isolationLevel:'repeatable read',accessMode:'read write'})).rejects.toThrow('PostgreSQL 16 read-write READ COMMITTED');
    expect((await inspectShippingLifecycleIndexes(f.db)).present).toBe(0);
  });
  it('preserves a stricter caller deadline and rolls back timed-out DDL',async()=>{
    await f.withPeer!(async peer=>{
      await peer.exec("SET statement_timeout='100ms'");
      const injected=file.replace('  -- All creations',"  PERFORM pg_sleep(0.2);\n  -- All creations");
      expect(injected).not.toBe(file);
      await expect(raw(peer.db,injected)).rejects.toMatchObject({cause:{code:'57014'}});
      expect(await peer.exec('SHOW statement_timeout')).toEqual(expect.arrayContaining([{statement_timeout:'100ms'}]));
    });
    expect((await inspectShippingLifecycleIndexes(f.db)).present).toBe(0);
  });
});
