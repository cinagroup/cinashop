import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { auditShippingLifecycleBaseline } from '../src/migrations/auditShippingLifecycleBaseline';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';

const refs=['store_product','store_seckill','store_bargain','store_combination','store_integral','store_discounts_products'] as const;
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('shipping stored-reference baseline on isolated full ORM PG16',()=>{
 let f:Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
 beforeAll(async()=>{f=await sequenceRunnerDatabase();const api=await import('drizzle-kit/api'),models=await import('../src/models/schema');
  await f.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson(models))).join('\n'));
  await f.exec("INSERT INTO store_order(id,order_id,pay_postage) VALUES(999,'shipping-baseline-historical','12.34')");
 },120000);
 afterAll(async()=>{await f?.close();},45000);
 beforeEach(async()=>{
  await f.exec(`TRUNCATE ${refs.join(',')},shipping_templates RESTART IDENTITY CASCADE`);
  await f.exec("INSERT INTO shipping_templates(id,name) VALUES(1,'default'),(10,'private-name-never-output'); INSERT INTO store_product(id,temp_id,freight) VALUES(100,0,1)");
 });
 const audit=()=>auditShippingLifecycleBaseline(f.db);
 const bind=(table:typeof refs[number],template=10)=>f.exec(table==='store_product'
  ?`UPDATE store_product SET temp_id=${template},freight=3 WHERE id=100`
  :`INSERT INTO ${table}(id,product_id,temp_id${table==='store_discounts_products'?'':',freight'}) VALUES(50,100,${template}${table==='store_discounts_products'?'':',3'})`);
 const state=()=>f.query(`SELECT jsonb_build_object(${[...refs,'shipping_templates','store_order'].map(t=>`'${t}',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM ${t} r)`).join(',')},'sequences',
  (SELECT jsonb_agg(to_jsonb(s) ORDER BY sequencename) FROM pg_sequences s WHERE schemaname='public')) AS snapshot`);
 it('returns all six empty/unbound counts, never claims installation or future protection, and preserves every row/sequence',async()=>{
  const before=await state(),result=await audit();
  expect((await f.query("SELECT order_id,pay_postage FROM store_order WHERE id=999")).rows)
   .toEqual([{order_id:'shipping-baseline-historical',pay_postage:'12.34'}]);
  expect(result).toMatchObject({baselineReady:true,dataChecked:true,readOnly:true,protocolCatalogVerified:false,installationAuthorized:false,futureWritesProtected:false});
  expect(result.catalog).toHaveLength(7);expect(result.tables).toHaveLength(6);
  expect(result.tables.reduce((n,r)=>n+r.references,0)).toBe(0);expect(await state()).toEqual(before);
  expect(JSON.stringify(result)).not.toContain('private-name-never-output');expect(JSON.stringify(result)).not.toContain('shipping-baseline-historical');
 });
 it.each(refs)('accepts a valid retained %s binding',async table=>{
  await bind(table);const before=await state(),result=await audit();
  expect(result.baselineReady).toBe(true);expect(result.tables.find(r=>r.table===table)).toMatchObject({references:1,invalidReferences:0});
  expect(await state()).toEqual(before);
 });
 it.each(refs)('rejects a missing template stored by %s without repairing rows',async table=>{
  await bind(table,999);const before=await state(),result=await audit();
  expect(result.baselineReady).toBe(false);expect(result.tables.find(r=>r.table===table)).toMatchObject({missingTemplate:1,invalidReferences:1});
  expect(await state()).toEqual(before);
 });
 it.each(['deleted','disabled','owner','negative','source-missing','source-owner'] as const)('reports %s precisely, including a retired bargain',async kind=>{
  await bind('store_bargain');await f.exec('UPDATE store_bargain SET is_del=1,status=0');
  if(kind==='deleted')await f.exec('UPDATE shipping_templates SET is_del=1 WHERE id=10');
  if(kind==='disabled')await f.exec('UPDATE shipping_templates SET status=0 WHERE id=10');
  if(kind==='owner')await f.exec('UPDATE shipping_templates SET owner_type=2,relation_id=20 WHERE id=10');
  if(kind==='negative')await f.exec('UPDATE store_bargain SET temp_id=-1,freight=1');
  if(kind==='source-missing')await f.exec('UPDATE store_bargain SET product_id=999');
  if(kind==='source-owner')await f.exec('UPDATE store_product SET type=0,relation_id=77 WHERE id=100');
  const before=await state(),result=await audit();expect(result.baselineReady).toBe(false);
  const field={deleted:'unavailableTemplate',disabled:'unavailableTemplate',owner:'ownerMismatch',negative:'negativeTemplateId','source-missing':'missingSource','source-owner':'invalidSourceOwner'}[kind];
  expect(result.tables.find(r=>r.table==='store_bargain')).toMatchObject({[field]:1,invalidReferences:1});expect(await state()).toEqual(before);
 });
 it('counts implicit default separately, while package zero is unbound and positive references remain references with free freight',async()=>{
  await bind('store_bargain',0);await bind('store_discounts_products',0);
  await f.exec('UPDATE store_product SET temp_id=10,freight=1 WHERE id=100');
  let result=await audit();expect(result.baselineReady).toBe(true);
  expect(result.tables.find(r=>r.table==='store_bargain')).toMatchObject({references:1,implicitDefault:1});
  expect(result.tables.find(r=>r.table==='store_discounts_products')).toMatchObject({references:0,implicitDefault:0});
  expect(result.tables.find(r=>r.table==='store_product')).toMatchObject({references:1,implicitDefault:0});
  await f.exec('DELETE FROM shipping_templates WHERE id=1');result=await audit();expect(result.baselineReady).toBe(false);
  expect(result.tables.find(r=>r.table==='store_bargain')).toMatchObject({missingTemplate:1});
 });
 it.each(['missing-table','nullable','wrong-type','missing-pk'] as const)('fails catalog %s before reading rows',async kind=>{
  const statements={
   'missing-table':['ALTER TABLE store_bargain RENAME TO qa_old_bargain','ALTER TABLE qa_old_bargain RENAME TO store_bargain'],
   nullable:['ALTER TABLE store_bargain ALTER COLUMN temp_id DROP NOT NULL','ALTER TABLE store_bargain ALTER COLUMN temp_id SET NOT NULL'],
   'wrong-type':['ALTER TABLE store_bargain ALTER COLUMN temp_id TYPE bigint','ALTER TABLE store_bargain ALTER COLUMN temp_id TYPE integer'],
   'missing-pk':['ALTER TABLE store_bargain DROP CONSTRAINT store_bargain_pkey','ALTER TABLE store_bargain ADD PRIMARY KEY(id)'],
  }[kind];
  await f.exec(statements[0]);try{const result=await audit();expect(result).toMatchObject({baselineReady:false,dataChecked:false,tables:[]});
   expect(result.catalog.find(r=>r.table==='store_bargain')?.compatible).toBe(false);
  }finally{await f.exec(statements[1]);}
 });
 it('uses a genuine SELECT-only LOGIN and refuses RLS-hidden references rather than reporting zero',async()=>{
  await bind('store_bargain',999);const before=await state();
  await f.withRuntimeRole!(async runtime=>{
   await f.exec(`GRANT SELECT ON ${refs.join(',')},shipping_templates TO "${runtime.role}"`);
   expect((await auditShippingLifecycleBaseline(runtime.db)).baselineReady).toBe(false);
   await f.exec('ALTER TABLE store_bargain ENABLE ROW LEVEL SECURITY; CREATE POLICY qa_hide_baseline ON store_bargain USING(false)');
   try{await expect(auditShippingLifecycleBaseline(runtime.db)).rejects.toMatchObject({cause:{code:'42501'}});}
   finally{await f.exec('DROP POLICY qa_hide_baseline ON store_bargain; ALTER TABLE store_bargain DISABLE ROW LEVEL SECURITY');}
   await f.exec(`REVOKE SELECT ON shipping_templates FROM "${runtime.role}"`);
   await expect(auditShippingLifecycleBaseline(runtime.db)).rejects.toMatchObject({cause:{code:'42501'}});
  });expect(await state()).toEqual(before);
 });
 it('ignores search-path shadows, preserves stricter settings and rejects nested transactions',async()=>{
  await bind('store_bargain',999);
  await f.withPeer!(async peer=>{
   await peer.exec("CREATE TEMP TABLE shipping_templates(id integer); SET search_path=pg_temp,public; SET statement_timeout='4000ms'; SET lock_timeout='500ms'; SET idle_in_transaction_session_timeout='3500ms'");
   expect((await auditShippingLifecycleBaseline(peer.db)).baselineReady).toBe(false);
   expect(await peer.exec("SELECT current_setting('statement_timeout') s,current_setting('lock_timeout') l,current_setting('idle_in_transaction_session_timeout') i,current_setting('search_path') p"))
    .toMatchObject([{s:'4s',l:'500ms',i:'3500ms',p:'pg_temp, public'}]);
  });
  await f.db.transaction(async tx=>{await expect(auditShippingLifecycleBaseline(tx)).rejects.toThrow('root database');await tx.execute(sql`SELECT 1`);});
 });
});
