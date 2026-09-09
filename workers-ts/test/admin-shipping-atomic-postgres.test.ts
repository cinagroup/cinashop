import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { eq,sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { shippingTemplates } from '../src/models/schema';
import { SupplierShippingTemplateService } from '../src/services/supplier/SupplierShippingTemplateService';
import { createAdminShippingFixture,postShipping,shippingRegion,shippingAdminApp } from './helpers/adminShippingFixture';
import { outcome,waitForFinanceBlock,withFinancePeers } from './helpers/financePeers';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('admin shipping writer independent PG16 boundaries',()=>{
 let f:Awaited<ReturnType<typeof createAdminShippingFixture>>;
 beforeEach(async()=>{f=await createAdminShippingFixture();},30_000);
 afterEach(async()=>{await f?.close();});
 const change={id:10,name:'完整新模板',type:3,status:1,regions:[shippingRegion('held','8.50')]};
 const barrier=()=>f.exec("CREATE FUNCTION qa_template_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.region_name='held' THEN PERFORM pg_advisory_xact_lock(731639,10); END IF; RETURN NEW; END $$; CREATE TRIGGER qa_template_hold BEFORE INSERT ON shipping_templates_region FOR EACH ROW EXECUTE FUNCTION qa_template_hold()");
 it('keeps old committed rows visible and holds parent SHARE readers until all new regions commit',async()=>{
  const before=await f.snapshot();await barrier();await withFinancePeers(f.db,async([holder,writer,reader])=>{
   await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731639,10)');const editing=postShipping(writer.db,change);
   await waitForFinanceBlock(f.db,writer.pid,holder.pid);expect(await f.snapshot()).toEqual(before);
   const reading=outcome(reader.exec('SELECT id FROM shipping_templates WHERE id=10 FOR SHARE'));
   await waitForFinanceBlock(f.db,reader.pid,writer.pid);await holder.exec('COMMIT');
   expect((await editing).status).toBe(200);expect(await reading).toMatchObject({ok:true});
  });const after=await f.snapshot();expect(after.templates[0]).toMatchObject({name:change.name,type:3,status:1});expect(after.regions).toHaveLength(1);expect(after.regions[0].firstPrice).toBe('8.50');
 },15_000);
 it('serializes a later partial admin edit without overwriting the first editors omitted fields or regions',async()=>{
  await barrier();await withFinancePeers(f.db,async([holder,first,second])=>{
   await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731639,10)');const a=postShipping(first.db,change);
   await waitForFinanceBlock(f.db,first.pid,holder.pid);const b=postShipping(second.db,{id:10,name:'后来改名'});
   await waitForFinanceBlock(f.db,second.pid,first.pid);await holder.exec('COMMIT');expect((await a).status).toBe(200);expect((await b).status).toBe(200);
  });const after=await f.snapshot();expect(after.templates[0]).toMatchObject({name:'后来改名',type:3,status:1});expect(after.regions[0].firstPrice).toBe('8.50');
 },15_000);
 it('serializes the actual supplier writer on the same parent boundary',async()=>{
  await f.db.update(shippingTemplates).set({ownerType:2,relationId:20}).where(eq(shippingTemplates.id,10));await barrier();
  await withFinancePeers(f.db,async([holder,admin,supplier])=>{
   await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731639,10)');const a=postShipping(admin.db,change);
   await waitForFinanceBlock(f.db,admin.pid,holder.pid);
   const b=outcome(new SupplierShippingTemplateService(createContainerFromDb(supplier.db)).save(20,10,{name:'供应商随后完整保存',type:2,appoint:0,no_delivery:0,sort:5,region_info:[{city_ids:[[0]],first:'1',first_price:'7',continue:'1',continue_price:'2'}],appoint_info:[],no_delivery_info:[]}));
   await waitForFinanceBlock(f.db,supplier.pid,admin.pid);await holder.exec('COMMIT');expect((await a).status).toBe(200);expect(await b).toMatchObject({ok:true,value:10});
  });const after=await f.snapshot();expect(after.templates[0]).toMatchObject({name:'供应商随后完整保存',ownerType:2,relationId:20,type:2});expect(after.regions).toHaveLength(1);expect(after.regions[0].firstPrice).toBe('7.00');expect(after.free).toHaveLength(0);expect(after.noDelivery).toHaveLength(0);
 },15_000);
 it('serializes actual admin deletion behind the complete save',async()=>{
  await barrier();await withFinancePeers(f.db,async([holder,writer,deleter])=>{
   await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731639,10)');const editing=postShipping(writer.db,change);
   await waitForFinanceBlock(f.db,writer.pid,holder.pid);const deleting=shippingAdminApp(deleter.db).request('/delete/10',{method:'DELETE'});
   await waitForFinanceBlock(f.db,deleter.pid,writer.pid);await holder.exec('COMMIT');expect((await editing).status).toBe(200);expect((await (await deleting).json() as {status:number}).status).toBe(200);
  });const after=await f.snapshot();expect(after.templates[0]).toMatchObject({isDel:1,name:change.name});expect(after.regions[0].firstPrice).toBe('8.50');
 },15_000);
 it('rechecks deletion after a verified parent lock wait without changing any rule rows',async()=>{
  const before=await f.snapshot();await withFinancePeers(f.db,async([deleter,writer])=>{
   await deleter.exec('BEGIN; UPDATE shipping_templates SET is_del=1 WHERE id=10');const editing=postShipping(writer.db,change);
   await waitForFinanceBlock(f.db,writer.pid,deleter.pid);await deleter.exec('COMMIT');expect((await editing).status).not.toBe(200);
  });expect(await f.snapshot()).toEqual({...before,templates:before.templates.map(t=>({...t,isDel:1}))});
 },15_000);
 it('does not block an unrelated template editor',async()=>{
  await f.db.insert(shippingTemplates).values({id:20,name:'独立模板'});await barrier();
  await withFinancePeers(f.db,async([holder,first,other])=>{
   await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731639,10)');const editing=postShipping(first.db,change);
   await waitForFinanceBlock(f.db,first.pid,holder.pid);expect((await postShipping(other.db,{id:20,name:'独立完成',regions:[shippingRegion()]})).status).toBe(200);
   await holder.exec('COMMIT');expect((await editing).status).toBe(200);
  });
 },15_000);
 it('preserves stricter timeouts, rolls back on lock timeout and restores session settings',async()=>{
  const before=await f.snapshot();await withFinancePeers(f.db,async([holder,writer])=>{
   await writer.exec("SET statement_timeout='3500ms'; SET lock_timeout='120ms'; SET idle_in_transaction_session_timeout='2500ms'");
   await holder.exec('BEGIN; SELECT id FROM shipping_templates WHERE id=10 FOR SHARE');
   const result=await postShipping(writer.db,change);expect(result.status).not.toBe(200);expect(result.msg).toContain('正在更新');await holder.exec('ROLLBACK');
   const [settings]=await writer.db.select({statement:sql<string>`current_setting('statement_timeout')`,lock:sql<string>`current_setting('lock_timeout')`,idle:sql<string>`current_setting('idle_in_transaction_session_timeout')`}).from(sql`(values(1)) p(n)`);
   expect(settings).toEqual({statement:'3500ms',lock:'120ms',idle:'2500ms'});
  });expect(await f.snapshot()).toEqual(before);
 },15_000);
});
