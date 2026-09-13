import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Container, DbClient } from '../src/lib/di';
import { withShippingLifecycleWriteBarrier } from '../src/migrations/withShippingLifecycleWriteBarrier';
import { MigrationService } from '../src/services/MigrationService';
import { runShippingLifecycle } from '../src/migrations/runShippingLifecycle';
import { runShippingLifecycleIndexes } from '../src/migrations/runShippingLifecycleIndexes';
import { SHIPPING_LIFECYCLE_CANDIDATE_SQL } from '../src/migrations/shippingLifecycleProtocol';
import { inspectShippingLifecycleProtocol } from '../src/migrations/inspectShippingLifecycleProtocol';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';

const targets=['shipping_templates','store_product','store_seckill','store_bargain','store_combination','store_integral','store_discounts_products'];
type Fixture=Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
const model=async(f:Fixture)=>{
  const api=await import('drizzle-kit/api'),models=await import('../src/models/schema');
  await f.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson(models))).join('\n'));
};
const rules=`SELECT r.oid,r.rulename,r.ev_enabled,pg_get_ruledef(r.oid) AS definition,c.relname
  FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' ORDER BY c.relname,r.rulename`;

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('rewrite rules on full isolated shipping PG16 schema',()=>{
  let f:Fixture;
  beforeAll(async()=>{f=await sequenceRunnerDatabase();await model(f);},120000);
  afterAll(async()=>{await f?.close();},45000);
  beforeEach(async()=>{
    for(const table of [...targets,'store_order']) await f.exec(`DROP RULE IF EXISTS qa_shipping_rule ON public.${table}`);
    await f.exec(`DROP FUNCTION IF EXISTS public.shipping_lifecycle_child() CASCADE;
      DROP FUNCTION IF EXISTS public.shipping_lifecycle_parent() CASCADE;
      DROP FUNCTION IF EXISTS public.shipping_lifecycle_no_truncate() CASCADE;
      DROP FUNCTION IF EXISTS public.shipping_lifecycle_bind(integer,integer,integer);
      DROP FUNCTION IF EXISTS public.shipping_lifecycle_ref(integer,integer);
      DELETE FROM public.store_product; DELETE FROM public.shipping_templates; DELETE FROM public.store_order;
      INSERT INTO public.shipping_templates(id,name) VALUES(1,'default'),(10,'retained'),(11,'absent');
      INSERT INTO public.store_product(id,temp_id,freight) VALUES(1,10,3);
      INSERT INTO public.store_order(id,order_id,pay_postage) VALUES(999,'rule-history','12.34')`);
  });
  const historyRule=(table:string)=>f.exec(`CREATE RULE qa_shipping_rule AS ON UPDATE TO public.${table}
    DO ALSO UPDATE public.store_order SET pay_postage='99.99' WHERE id=999`);
  const snapshot=async()=>({rules:await f.query(rules),
    data:await f.query(`SELECT jsonb_build_object(
      'orders',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.store_order t),
      'parents',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.shipping_templates t),
      'products',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.store_product t),
      'functions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY oid) FROM pg_proc p WHERE pronamespace='public'::regnamespace),
      'indexes',(SELECT jsonb_agg(to_jsonb(c) ORDER BY oid) FROM pg_class c WHERE relnamespace='public'::regnamespace AND relkind='i')) AS state`)});
  const install=(route:string)=>route==='protocol-runner'?runShippingLifecycle(f.db):route==='index-runner'?runShippingLifecycleIndexes(f.db)
    : f.db.transaction(async tx=>{await tx.execute(sql.raw(readFileSync(`migrations/${route==='protocol-file'?'0152_shipping_lifecycle.sql':'0153_shipping_lifecycle_indexes.sql'}`,'utf8')));},
      {isolationLevel:'read committed',accessMode:'read write'});
  const prepare=async(route:string)=>{if(route.startsWith('index'))await runShippingLifecycle(f.db);};

  it('rejects a peer enabling a rule between initial inspection and relation locks',async()=>{
    await historyRule('shipping_templates');await f.exec('ALTER TABLE public.shipping_templates DISABLE RULE qa_shipping_rule');
    await f.withPeer!(async peer=>{
      let intercepted=false;
      const root=new Proxy(f.db,{get(target,key,receiver){
        if(key==='transaction') return ((callback,config)=>target.transaction(async tx=>{
          const observed=new Proxy(tx,{get(inner,field,innerReceiver){
            if(field==='execute') return async(statement:Parameters<typeof tx.execute>[0])=>{
              const command=typeof statement==='string'?statement:new PgDialect().sqlToQuery(statement.getSQL()).sql;
              if(command.trimStart().startsWith('LOCK TABLE ONLY')) {
                intercepted=true;await peer.exec('ALTER TABLE public.shipping_templates ENABLE RULE qa_shipping_rule');
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
      await expect(withShippingLifecycleWriteBarrier(root,callback)).rejects.toThrow('environment requires review');
      expect(intercepted).toBe(true);expect(callback).not.toHaveBeenCalled();
      expect((await f.query(rules)).rows).toMatchObject([{ev_enabled:'O'}]);
      expect((await f.query("SELECT relation FROM pg_locks WHERE pid=pg_backend_pid() AND mode='ShareRowExclusiveLock'")).rows).toEqual([]);
      expect((await f.query('SELECT pay_postage FROM public.store_order WHERE id=999')).rows).toEqual([{pay_postage:'12.34'}]);
    });
  });
  it('blocks peer rule enabling while the relation barrier is held',async()=>{
    await historyRule('shipping_templates');await f.exec('ALTER TABLE public.shipping_templates DISABLE RULE qa_shipping_rule');
    await f.withPeer!(async peer=>{
      await peer.exec("SET lock_timeout='100ms'");
      await withShippingLifecycleWriteBarrier(f.db,async tx=>{
        await expect(peer.exec('ALTER TABLE public.shipping_templates ENABLE RULE qa_shipping_rule')).rejects.toMatchObject({code:'55P03'});
        expect(Array.from(await tx.execute(sql.raw(rules)))).toMatchObject([{ev_enabled:'D'}]);
      });
    });
  });

  it('demonstrates a rule changing historical postage despite a complete bare trigger protocol',async()=>{
    await f.exec(SHIPPING_LIFECYCLE_CANDIDATE_SQL);await historyRule('shipping_templates');
    expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('complete');
    await f.exec('UPDATE public.shipping_templates SET is_del=1 WHERE id=11');
    expect((await f.query('SELECT pay_postage FROM public.store_order WHERE id=999')).rows).toEqual([{pay_postage:'99.99'}]);
    expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('complete');
  });
  it('demonstrates a rule deleting a retained reference before the parent trigger sees it',async()=>{
    await f.exec(SHIPPING_LIFECYCLE_CANDIDATE_SQL);
    await f.exec('CREATE RULE qa_shipping_rule AS ON DELETE TO public.shipping_templates DO ALSO DELETE FROM public.store_product WHERE temp_id=OLD.id');
    await f.exec('DELETE FROM public.shipping_templates WHERE id=10');
    expect((await f.query('SELECT id FROM public.store_product')).rows).toEqual([]);
    expect((await f.query('SELECT id FROM public.shipping_templates WHERE id=10')).rows).toEqual([]);
    expect((await inspectShippingLifecycleProtocol(f.db)).state).toBe('complete');
  });
  for(const route of ['protocol-file','protocol-runner','index-file','index-runner']) describe(route,()=>{
    it.each(targets)('refuses an enabled rule on %s without changing it, protocol, indexes or rows',async table=>{
      await prepare(route);await historyRule(table);const before=await snapshot();
      await expect(install(route)).rejects.toThrow('environment requires review');
      expect(await snapshot()).toEqual(before);
    });
    it.each(['REPLICA','ALWAYS'])('does not waive an ENABLE %s rule',async mode=>{
      await prepare(route);await historyRule('shipping_templates');
      await f.exec(`ALTER TABLE public.shipping_templates ENABLE ${mode} RULE qa_shipping_rule`);
      const before=await snapshot();await expect(install(route)).rejects.toThrow('environment requires review');expect(await snapshot()).toEqual(before);
    });
    it('preserves a disabled rule without enabling or rewriting it',async()=>{
      await prepare(route);await historyRule('shipping_templates');await f.exec('ALTER TABLE public.shipping_templates DISABLE RULE qa_shipping_rule');
      const before=await f.query(rules);await install(route);expect(await f.query(rules)).toEqual(before);
    });
    it('refuses new rule interactions even for an otherwise complete repeated installation',async()=>{
      await prepare(route);await install(route);await historyRule('shipping_templates');
      const before=await snapshot();await expect(install(route)).rejects.toThrow('environment requires review');expect(await snapshot()).toEqual(before);
    });
    it('does not ban unrelated table rules',async()=>{
      await prepare(route);await f.exec('CREATE RULE qa_shipping_rule AS ON UPDATE TO public.store_order DO ALSO SELECT 1');
      const before=await f.query(rules);await install(route);expect(await f.query(rules)).toEqual(before);
    });
  });
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('rule absence on actual complete construction paths',()=>{
  it.each(['external','embedded','orm'])('checks all seven tables on %s before relying on rule rejection',async path=>{
    const f=await sequenceRunnerDatabase();
    try {
      if(path==='external') for(const name of readdirSync('migrations').filter(n=>/^\d{4}.*\.sql$/.test(n)).sort())
        await f.db.transaction(async tx=>{await tx.execute(sql.raw('SET LOCAL search_path=public,pg_temp'));await tx.execute(sql.raw(readFileSync(`migrations/${name}`,'utf8')));});
      else if(path==='embedded') expect((await new MigrationService({db:f.db} as Container).runAll()).errors).toEqual([]);
      else await model(f);
      expect(((await f.query(rules)).rows as {relname:string}[]).filter(r=>targets.includes(r.relname))).toEqual([]);
    } finally {await f.close();}
  },120000);
});
