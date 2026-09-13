import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Container, DbClient } from '../src/lib/di';
import { MigrationService } from '../src/services/MigrationService';
import { runShippingLifecycle } from '../src/migrations/runShippingLifecycle';
import { SHIPPING_LIFECYCLE_CANDIDATE_SQL } from '../src/migrations/shippingLifecycleProtocol';
import { inspectShippingLifecycleProtocol } from '../src/migrations/inspectShippingLifecycleProtocol';
import { withShippingLifecycleWriteBarrier } from '../src/migrations/withShippingLifecycleWriteBarrier';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';

const targets = ['shipping_templates','store_product','store_seckill','store_bargain',
  'store_combination','store_integral','store_discounts_products'] as const;
type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
const fileSql = readFileSync('migrations/0152_shipping_lifecycle.sql','utf8');
const orm = async (f: Fixture) => {
  const api = await import('drizzle-kit/api'), models = await import('../src/models/schema');
  await f.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson(models))).join('\n'));
};
const otherTriggers = `SELECT c.relname AS table_name,t.tgname,t.tgisinternal,t.tgenabled,
  t.oid AS trigger_oid,p.oid AS function_oid,pg_get_triggerdef(t.oid,false) AS definition,
  p.prosrc AS body,p.proname AS function_name FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
  JOIN pg_namespace pn ON pn.oid=p.pronamespace WHERE n.nspname='public'
  AND c.relname IN (${targets.map(t=>`'${t}'`).join(',')})
  AND NOT starts_with(t.tgname,'shipping_lifecycle_')
  AND NOT (pn.nspname='public' AND starts_with(p.proname,'shipping_lifecycle_'))
  ORDER BY c.relname,t.tgname`;

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('shipping interaction baseline on actual complete construction paths', () => {
  it.each(['external','embedded','orm'])('verifies the absence of other target-table triggers in %s', async path => {
    const f=await sequenceRunnerDatabase();
    try {
      if (path==='external') {
        for(const name of readdirSync('migrations').filter(n=>/^\d{4}.*\.sql$/.test(n)).sort()) {
          await f.db.transaction(async tx=>{ await tx.execute(sql.raw('SET LOCAL search_path=public,pg_temp'));
            await tx.execute(sql.raw(readFileSync(`migrations/${name}`,'utf8'))); });
        }
      } else if(path==='embedded') {
        expect(await new MigrationService({db:f.db} as Container).runAll()).toEqual({
          executed:Array.from({length:159},(_,i)=>String(i).padStart(4,'0')),errors:[]});
      } else await orm(f);
      expect((await f.query(otherTriggers)).rows).toEqual([]);
      expect(await runShippingLifecycle(f.db)).toEqual({applied:path==='orm'});
      expect(await runShippingLifecycle(f.db)).toEqual({applied:false});
      expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('complete');
    } finally { await f.close(); }
  },120000);
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('shipping interaction refusals on owned full ORM PG16',()=>{
  let f:Fixture;
  beforeAll(async()=>{ f=await sequenceRunnerDatabase(); await orm(f); },120000);
  afterAll(async()=>{ await f?.close(); },45000);
  beforeEach(async()=>{
    // Exact test fixtures, only inside the helper-created random database.
    for(const table of [...targets,'store_order']) await f.exec(`DROP TRIGGER IF EXISTS qa_shipping_side_effect ON public.${table}`);
    await f.exec(`ALTER TABLE public.store_product DROP CONSTRAINT IF EXISTS qa_shipping_cascade;
      DROP FUNCTION IF EXISTS public.qa_shipping_side_effect();
      DROP FUNCTION IF EXISTS public.shipping_lifecycle_child() CASCADE;
      DROP FUNCTION IF EXISTS public.shipping_lifecycle_parent() CASCADE;
      DROP FUNCTION IF EXISTS public.shipping_lifecycle_no_truncate() CASCADE;
      DROP FUNCTION IF EXISTS public.shipping_lifecycle_bind(integer,integer,integer);
      DROP FUNCTION IF EXISTS public.shipping_lifecycle_ref(integer,integer);
      DELETE FROM public.store_product; DELETE FROM public.shipping_templates; DELETE FROM public.store_order;
      INSERT INTO public.shipping_templates(id,name) VALUES(1,'default'),(10,'bound'),(11,'unbound');
      INSERT INTO public.store_product(id,temp_id,freight) VALUES(1,10,3);
      INSERT INTO public.store_order(id,order_id,pay_postage,cart_id) VALUES(999,'trigger-interaction-history','12.34','[77]')`);
  });
  const snapshot=()=>f.query(`SELECT jsonb_build_object(
    'templates',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.shipping_templates t),
    'products',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.store_product p),
    'orders',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM public.store_order o),
    'triggers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY oid) FROM pg_trigger t WHERE tgrelid IN
      (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')),
    'functions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY oid) FROM pg_proc p WHERE pronamespace='public'::regnamespace)) AS state`);
  const install=(route:string)=>route==='runner'?runShippingLifecycle(f.db):f.db.transaction(async tx=>{
    await tx.execute(sql.raw(fileSql));
  },{isolationLevel:'read committed',accessMode:'read write'});
  const sideEffect=async(table:string,timing='BEFORE',level='ROW')=>{
    await f.exec(`CREATE FUNCTION public.qa_shipping_side_effect() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE public.store_order SET pay_postage='99.99' WHERE id=999; RETURN NEW; END $$;
      CREATE TRIGGER qa_shipping_side_effect ${timing} UPDATE ON public.${table}
      FOR EACH ${level} EXECUTE FUNCTION public.qa_shipping_side_effect()`);
  };
  const cascade=(kind:string)=>f.exec(`ALTER TABLE public.store_product ADD CONSTRAINT qa_shipping_cascade
    FOREIGN KEY(temp_id) REFERENCES public.shipping_templates(id) ${kind}`);
  const refused=async(route:string)=>{
    const before=await snapshot();
    if(route==='runner') await expect(install(route)).rejects.toThrow('Shipping installation environment requires review');
    else await expect(install(route)).rejects.toMatchObject({cause:{message:'Shipping installation environment requires review'}});
    expect(await snapshot()).toEqual(before);
    expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('absent');
    expect((await f.query("SELECT relation FROM pg_locks WHERE pid=pg_backend_pid() AND mode='ShareRowExclusiveLock'")).rows).toEqual([]);
  };

  it('rechecks a relation trigger enabled by a peer after preflight but before the table locks',async()=>{
    await sideEffect('shipping_templates');
    await f.exec('ALTER TABLE public.shipping_templates DISABLE TRIGGER qa_shipping_side_effect');
    await f.withPeer!(async peer=>{
      let intercepted=false;
      const root=new Proxy(f.db,{get(target,key,receiver){
        if(key==='transaction') return ((callback,config)=>target.transaction(async tx=>{
          const observed=new Proxy(tx,{get(inner,field,innerReceiver){
            if(field==='execute') return async(statement:Parameters<typeof tx.execute>[0])=>{
              const command=typeof statement==='string'?statement:new PgDialect().sqlToQuery(statement.getSQL()).sql;
              if(command.trimStart().startsWith('LOCK TABLE ONLY')) {
                intercepted=true;
                await peer.exec('ALTER TABLE public.shipping_templates ENABLE TRIGGER qa_shipping_side_effect');
              }
              return inner.execute(statement);
            };
            return Reflect.get(inner,field,innerReceiver);
          }});
          return callback(observed);
        },config)) satisfies DbClient['transaction'];
        return Reflect.get(target,key,receiver);
      }});
      const callback=vi.fn(async()=>{});
      await expect(withShippingLifecycleWriteBarrier(root,callback)).rejects.toThrow('installation environment requires review');
      expect(intercepted).toBe(true); expect(callback).not.toHaveBeenCalled();
      expect((await f.query(otherTriggers)).rows).toMatchObject([{tgenabled:'O'}]);
      expect((await f.query('SELECT pay_postage FROM public.store_order WHERE id=999')).rows).toEqual([{pay_postage:'12.34'}]);
      expect((await f.query("SELECT relation FROM pg_locks WHERE pid=pg_backend_pid() AND mode='ShareRowExclusiveLock'")).rows).toEqual([]);
    });
  });
  it('the acquired relation barrier blocks a peer enabling a disabled interaction',async()=>{
    await sideEffect('shipping_templates');
    await f.exec('ALTER TABLE public.shipping_templates DISABLE TRIGGER qa_shipping_side_effect');
    await f.withPeer!(async peer=>{
      await peer.exec("SET lock_timeout='100ms'");
      await withShippingLifecycleWriteBarrier(f.db,async tx=>{
        await expect(peer.exec('ALTER TABLE public.shipping_templates ENABLE TRIGGER qa_shipping_side_effect'))
          .rejects.toMatchObject({code:'55P03'});
        // The root client's only connection belongs to this transaction. Read
        // through tx rather than queueing a root query behind ourselves.
        expect(Array.from(await tx.execute(sql.raw(otherTriggers)))).toMatchObject([{tgenabled:'D'}]);
      });
    });
  });

  // These intentionally bypass the installer ONLY in an owned test DB. They
  // demonstrate why a complete shipping-only catalog is insufficient evidence.
  it.each(['BEFORE','AFTER'])('demonstrates a %s row trigger rewriting history despite a complete protocol',async timing=>{
    await sideEffect('shipping_templates',timing);
    await f.exec(SHIPPING_LIFECYCLE_CANDIDATE_SQL);
    await f.exec('UPDATE public.shipping_templates SET status=0 WHERE id=11');
    expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('complete');
    expect((await f.query('SELECT pay_postage FROM public.store_order WHERE id=999')).rows).toEqual([{pay_postage:'99.99'}]);
  });
  it.each(['ON DELETE CASCADE','ON DELETE SET DEFAULT','ON UPDATE CASCADE'])('demonstrates %s changing retained references before the parent AFTER check',async kind=>{
    // SET DEFAULT must satisfy the added FK too; otherwise RI itself refuses
    // the write before the shipping counterexample is reached.
    if(kind==='ON DELETE SET DEFAULT') await f.exec("INSERT INTO public.shipping_templates(id,name) VALUES(0,'zero-FK-target')");
    await cascade(kind); await f.exec(SHIPPING_LIFECYCLE_CANDIDATE_SQL);
    if(kind==='ON UPDATE CASCADE') await f.exec('UPDATE public.shipping_templates SET id=12 WHERE id=10');
    else await f.exec('DELETE FROM public.shipping_templates WHERE id=10');
    expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('complete');
    expect((await f.query('SELECT temp_id FROM public.store_product WHERE id=1')).rows).toEqual(
      kind==='ON DELETE CASCADE'?[]:[{temp_id:kind==='ON UPDATE CASCADE'?12:0}]);
  });

  describe.each(['runner','file'])('%s installation',route=>{
    it.each(targets)('refuses an enabled non-protocol row trigger on %s without changing anything',async table=>{
      await sideEffect(table); await refused(route);
    });
    it.each(['AFTER','BEFORE'])('refuses %s statement triggers too',async timing=>{
      await sideEffect('shipping_templates',timing,'STATEMENT'); await refused(route);
    });
    it.each(['ENABLE REPLICA','ENABLE ALWAYS'])('does not waive %s non-protocol triggers',async mode=>{
      await sideEffect('shipping_templates');
      await f.exec(`ALTER TABLE public.shipping_templates ${mode} TRIGGER qa_shipping_side_effect`);
      await refused(route);
    });
    it.each(['ON DELETE CASCADE','ON DELETE SET DEFAULT','ON UPDATE CASCADE'])('does not waive internal %s triggers',async kind=>{
      await cascade(kind); await refused(route);
      expect((await f.query(otherTriggers)).rows.some(t=>(t as {tgisinternal:boolean}).tgisinternal===true)).toBe(true);
    });
    it('rejects a new interaction even when its own protocol is already complete',async()=>{
      await install(route); await sideEffect('shipping_templates'); const before=await snapshot();
      if(route==='runner') await expect(install(route)).rejects.toThrow('Shipping installation environment requires review');
      else await expect(install(route)).rejects.toMatchObject({cause:{message:'Shipping installation environment requires review'}});
      expect(await snapshot()).toEqual(before);
      expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('complete');
    });
    it('preserves a disabled trigger and its definition, without enabling it',async()=>{
      await sideEffect('shipping_templates'); await f.exec('ALTER TABLE public.shipping_templates DISABLE TRIGGER qa_shipping_side_effect');
      const before=await f.query(otherTriggers); await install(route); await install(route);
      expect(await f.query(otherTriggers)).toEqual(before);
      await f.exec('UPDATE public.shipping_templates SET status=0 WHERE id=11');
      expect((await f.query('SELECT pay_postage FROM public.store_order WHERE id=999')).rows).toEqual([{pay_postage:'12.34'}]);
    });
    it('does not claim a global ban on unrelated-table triggers',async()=>{
      await sideEffect('store_order');
      const objects=()=>f.query(`SELECT t.oid,pg_get_triggerdef(t.oid,false) AS definition,p.prosrc
        FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgname='qa_shipping_side_effect'`);
      const before=await objects(); await install(route);
      expect((await f.query(otherTriggers)).rows).toEqual([]);
      // No DML is sent to the unrelated table; the installer must not invoke it.
      expect((await f.query('SELECT pay_postage FROM public.store_order WHERE id=999')).rows).toEqual([{pay_postage:'12.34'}]);
      expect(await objects()).toEqual(before);
    });
  });
});
