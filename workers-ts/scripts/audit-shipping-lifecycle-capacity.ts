import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { URL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { sequenceRunnerDatabase, validateSequenceRunnerTestUrl } from '../test/helpers/kefuSequenceRunnerDatabase';
import { runShippingLifecycle } from '../src/migrations/runShippingLifecycle';
import { SHIPPING_LIFECYCLE_CANDIDATE_SQL } from '../src/migrations/shippingLifecycleProtocol';
import { createContainerFromDb } from '../src/lib/di';
import { retireShippingTemplate } from '../src/services/product/ShippingTemplateLifecycleService';
import { SHIPPING_REFERENCE_EXPRESSION_SQL, SHIPPING_PACKAGE_REFERENCE_EXPRESSION_SQL } from '../src/lib/shippingReferenceExpression';
import { inspectShippingLifecycleProtocol } from '../src/migrations/inspectShippingLifecycleProtocol';
import { shippingReferenceStatement } from '../test/helpers/shippingReferenceStatement';
import { shippingLifecycleNestedPlans } from '../test/helpers/shippingLifecycleNestedPlans';
import { SHIPPING_LIFECYCLE_INDEXES } from '../src/migrations/shippingLifecycleIndexes';
import { inspectShippingLifecycleIndexes, runShippingLifecycleIndexes } from '../src/migrations/runShippingLifecycleIndexes';

// Fixed bounded synthetic experiment. No production fallback, caller SQL, user
// data, new roles or mutation of the shared control database. Formal index
// upgrade is exercised only within the helper-owned throwaway database.
const tables=['store_product','store_seckill','store_bargain','store_combination','store_integral','store_discounts_products'] as const;
const size=50_000;
const expression=(table:string)=>table==='store_discounts_products'
  ? SHIPPING_PACKAGE_REFERENCE_EXPRESSION_SQL
  : SHIPPING_REFERENCE_EXPRESSION_SQL;
type PlanNode={Plans?:PlanNode[];'Node Type':string;'Relation Name'?:string;'Index Name'?:string;
  'Actual Rows'?:number;'Rows Removed by Filter'?:number;'Shared Hit Blocks'?:number;'Shared Read Blocks'?:number};
type Explain={Plan:PlanNode;'Execution Time':number;'Planning Time':number};
const flatten=(node:PlanNode):PlanNode[]=>[node,...(node.Plans??[]).flatMap(flatten)];

async function main(){
  assert.equal(process.argv.length,2,'No arguments accepted');
  validateSequenceRunnerTestUrl(process.env.TEST_FINANCE_POSTGRES_URL??'');
  const f=await sequenceRunnerDatabase();
  try {
    const sourceHashes=Object.fromEntries(['../src/lib/shippingReferenceExpression.ts',
      '../src/services/product/ShippingTemplateLifecycleService.ts','../src/migrations/shippingLifecycleProtocol.ts',
      '../migrations/0152_shipping_lifecycle.sql','../test/helpers/shippingReferenceStatement.ts',
      '../migrations/0153_shipping_lifecycle_indexes.sql','../src/migrations/shippingLifecycleIndexes.ts',
      '../src/migrations/shippingLifecycleIndexInstallation.ts','../src/migrations/runShippingLifecycleIndexes.ts',
      '../src/models/schema/product.ts','../src/models/schema/activity.ts','../src/models/schema/discounts.ts',
      '../test/helpers/shippingLifecycleNestedPlans.ts','./audit-shipping-lifecycle-capacity.ts'].map(path=>[path,createHash('sha256').update(readFileSync(new URL(path,import.meta.url))).digest('hex')]));
    const api=await import('drizzle-kit/api'),models=await import('../src/models/schema');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson(models))).join('\n'));
    assert.equal((await inspectShippingLifecycleIndexes(f.db)).complete,true,'Full ORM must include the formal indexes');
    // Simulate the pre-index upgrade shape only in this newly created fixture.
    for(const spec of SHIPPING_LIFECYCLE_INDEXES) await f.exec(`DROP INDEX public.${spec.name}`);
    await f.exec(`INSERT INTO public.shipping_templates(id,name) VALUES(1,'default'),(10,'common'),(11,'unreferenced'),(12,'rare');
      INSERT INTO public.store_order(id,order_id,pay_postage,cart_id) VALUES(999,'capacity-history','12.34','[77]')`);
    for(const table of tables){
      const packageTable=table==='store_discounts_products',product=table==='store_product';
      await f.exec(`INSERT INTO public.${table}(id,temp_id${product?'':',product_id'}${packageTable?'':',freight'})
        SELECT n,CASE WHEN n=${size} THEN 12 WHEN n%20 IN(0,1) THEN 0 ELSE 10 END
        ${product?'':',n'}${packageTable?'':',CASE WHEN n%20=0 THEN 1 ELSE 3 END'} FROM generate_series(1,${size}) n`);
      await f.exec(`ANALYZE public.${table}`);
    }
    const installStart=performance.now();
    assert.deepEqual(await runShippingLifecycle(f.db),{applied:true});
    const installMs=performance.now()-installStart;
    const fingerprint=async()=>{
      const rows=[];
      for(const table of [...tables,'shipping_templates','store_order']) rows.push({table,...(await f.query(
        `SELECT count(*)::integer AS count,md5(string_agg(md5(to_jsonb(t)::text),'' ORDER BY id)) AS digest FROM public.${table} t`)).rows[0] as object});
      return rows;
    };
    const before=await fingerprint();
    const explain=async(statement:string)=>{
      const rows=(await f.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${statement}`)).rows as unknown as {'QUERY PLAN':Explain[]}[];
      const report=rows[0]['QUERY PLAN'][0];
      return {statement,fullPlan:report,executionMs:report['Execution Time'],planningMs:report['Planning Time'],
        hits:report.Plan['Shared Hit Blocks']??0,reads:report.Plan['Shared Read Blocks']??0,
        scans:flatten(report.Plan).filter(p=>p['Relation Name']||p['Index Name']).map(p=>({
          type:p['Node Type'],table:p['Relation Name'],index:p['Index Name'],rows:p['Actual Rows'],removed:p['Rows Removed by Filter']??0}))};
    };
    const plans=async()=>{
      const results=[];
      for(const table of tables) for(const id of [11,12,1]){
        const freight=table==='store_discounts_products'?'2':'freight';
        const predicate=table==='store_discounts_products'?`temp_id=${id}`:`(temp_id=${id} OR (temp_id<=0 AND freight NOT IN(1,2) AND ${id}=1))`;
        results.push({table,id,
          legacyFunction:await explain(`SELECT EXISTS(SELECT 1 FROM public.${table} WHERE public.shipping_lifecycle_ref(temp_id,${freight})=${id})`),
          legacyApplication:await explain(`SELECT EXISTS(SELECT 1 FROM public.${table} WHERE ${predicate})`),
          currentExpression:await explain(`SELECT EXISTS(SELECT 1 FROM public.${table} WHERE (${expression(table)})=${id})`)});
      }
      return results;
    };
    const sourceQuery=SHIPPING_LIFECYCLE_CANDIDATE_SQL.match(/FOR dependent IN (SELECT DISTINCT refs\.ref FROM \([^]*?ORDER BY refs\.ref) LOOP/)?.[1];
    assert.ok(sourceQuery,'Expected actual source-ownership query');
    const sourcePlan=()=>explain(sourceQuery.replaceAll('OLD.id',String(size)));
    const retirement=async()=>{
      const results=[];
      for(const kind of ['database','application']){
        const samples=[];
        for(let i=0;i<3;i++){
          const start=performance.now();
          if(kind==='application') await retireShippingTemplate(createContainerFromDb(f.db),11);
          else await f.db.transaction(async tx=>{
            await tx.execute(sql.raw("SET LOCAL statement_timeout='5000ms'"));
            await tx.execute(sql.raw('UPDATE public.shipping_templates SET is_del=1 WHERE id=11'));
          });
          samples.push(performance.now()-start);
          await f.exec('UPDATE public.shipping_templates SET is_del=0,status=1 WHERE id=11');
        }
        results.push({kind,samplesMs:samples});
      }
      return results;
    };
    const applicationPlans=async()=>Promise.all([11,12,1].map(async id=>({id,...await explain(await shippingReferenceStatement(id))})));
    const writeCost=async()=>{
      const samples: {table:string;sample:number;operation:string;fullPlan:unknown}[]=[];
      // Real indexed writes with the unchanged lifecycle triggers enabled. Each
      // table/sample is a fresh transaction and rolls back all inserted rows.
      await f.withPeer!(async peer=>{
        for(const table of tables) for(let sample=0;sample<3;sample++){
          const product=table==='store_product',packageTable=table==='store_discounts_products';
          await peer.exec('BEGIN');
          try {
            const statements=[
              ['insert',`INSERT INTO public.${table}(id,temp_id${product?'':',product_id'}${packageTable?'':',freight'}) SELECT n,10${product?'':',1'}${packageTable?'':',3'} FROM generate_series(${size+1},${size+100}) n`],
              ['update',`UPDATE public.${table} SET temp_id=12 WHERE id BETWEEN ${size+1} AND ${size+100}`],
              ['delete',`DELETE FROM public.${table} WHERE id BETWEEN ${size+1} AND ${size+100}`],
            ];
            for(const [operation,statement] of statements){
              const rows=await peer.exec(`EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) ${statement}`);
              samples.push({table,sample,operation,fullPlan:rows[0]['QUERY PLAN']});
            }
          } finally {await peer.exec('ROLLBACK');}
        }
      });
      return {rowsPerStatement:100,samplesPerTable:3,protocolEnabled:true,allTransactionsRolledBack:true,samples};
    };
    assert.equal((await inspectShippingLifecycleProtocol(f.db)).state,'complete');
    const baseline={plans:await plans(),application:await applicationPlans(),source:await sourcePlan(),retirement:await retirement(),writeCost:await writeCost()};
    assert.deepEqual(await fingerprint(),before,'Baseline timing changed business rows');
    const indexBuildStart=performance.now();
    await runShippingLifecycleIndexes(f.db);
    assert.equal((await inspectShippingLifecycleIndexes(f.db)).complete,true);
    for(const table of tables) await f.exec(`ANALYZE public.${table}`);
    const indexBuildMs=performance.now()-indexBuildStart;
    const indexed={plans:await plans(),application:await applicationPlans(),source:await sourcePlan(),retirement:await retirement(),writeCost:await writeCost()};
    const nested=await shippingLifecycleNestedPlans(f);
    assert.equal((await inspectShippingLifecycleProtocol(f.db)).state,'complete','Index upgrade must not replace the installed protocol');
    await assert.rejects(f.exec('UPDATE public.shipping_templates SET is_del=1 WHERE id=12'),{code:'23503'});
    assert.deepEqual(await fingerprint(),before,'Formal index experiment changed business rows');
    const selectiveScans=indexed.plans.filter(p=>p.id!==1).flatMap(p=>p.currentExpression.scans);
    assert.ok(selectiveScans.every(p=>p.type!=='Seq Scan'),'Formal selective check still scans the whole table');
    assert.ok(indexed.application.filter(p=>p.id!==1).flatMap(p=>p.scans).every(p=>p.type!=='Seq Scan'),'Actual application selective query still scans the whole table');
    return {scope:'isolated shipping lifecycle 300000-reference performance experiment',engine:'PG16',rowsPerTable:size,
      capturedAt:new Date().toISOString(),sourceHashes,fingerprints:before,
      totalReferences:size*tables.length,installMs,indexBuildMs,baseline,indexed,nested,exactProtocolPreserved:true,
      rowsPreserved:true,referencedRetirementStillRejected:true,forcedPlannerSettings:false,
      registeredIndexCount:10,registeredCapacityMigration:true,productionChanged:false,fullCapacityAcceptance:false};
  } finally { await f.close(); }
}
main().then(report=>{
  // Full JSON plans exceed terminal capture limits. Generate a unique report,
  // never overwrite an existing artifact, and emit only a bounded summary.
  const path=join(tmpdir(),`cinashop-shipping-capacity-${randomUUID()}.json`);
  const body=JSON.stringify({...report,cleanupConfirmed:true},null,2)+'\n';
  writeFileSync(path,body,{flag:'wx'});
  console.log(JSON.stringify({reportPath:path,reportSha256:createHash('sha256').update(body).digest('hex'),
    capturedAt:report.capturedAt,totalReferences:report.totalReferences,installMs:report.installMs,indexBuildMs:report.indexBuildMs,
    baselineRetirement:report.baseline.retirement,indexedRetirement:report.indexed.retirement,
    sourceBeforeMs:report.baseline.source.executionMs,sourceAfterMs:report.indexed.source.executionMs,
    rowsPreserved:report.rowsPreserved,exactProtocolPreserved:report.exactProtocolPreserved,cleanupConfirmed:true}));
}).catch(error=>{
  console.error(error instanceof Error?error.message:'Isolated shipping capacity experiment failed');process.exitCode=1;
});
