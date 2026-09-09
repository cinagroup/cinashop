import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createContainerFromDb,withTx,type DbClient } from '../src/lib/di';
import { StoreOrderCreateService,type CreateOrderParams } from '../src/services/order/StoreOrderCreateService';
import { saveAdminShippingTemplate } from '../src/services/admin/AdminShippingTemplateService';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { storeOrderCartInfo,storeOrderStatus,printDocument } from '../src/models/schema';
import { outcome,waitForFinanceBlock,withFinancePeers } from './helpers/financePeers';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('shipping snapshot independent PostgreSQL boundaries',()=>{
 let f:Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
 const params:CreateOrderParams={uid:11,key:'template_pg',cartIds:[1],shippingType:1,addressId:11,cityId:101,province:'本地省',userAddress:'隔离地址',realName:'隔离',userPhone:'00000000000',userIp:'127.0.0.1'};
 beforeEach(async()=>{f=await createPcCheckoutQuoteFixture([storeOrderCartInfo,storeOrderStatus,printDocument]);for(const key of Object.keys(f.config))f.config[key]='0';},30_000);
 afterEach(async()=>{await f?.close();});
 const quote=(db:DbClient)=>new StoreOrderCreateService(createContainerFromDb(db),f.env).quoteOrder(params);
 const create=(db:DbClient)=>StoreOrderCreateService.createWithRuntime(createContainerFromDb(db),{CONFIG_KV:f.env.CONFIG_KV,nextOrderId:async()=>params.key},params);
 const edit=(db:DbClient)=>saveAdminShippingTemplate(createContainerFromDb(db),{id:10,regions:[{region_id:101,region_name:'held',first:'2',first_price:'9',continue:'1',continue_price:'1'}]});
 it('keeps a single-statement quote snapshot when a whole template commits during the parent read',async()=>{
  await f.exec("ALTER TABLE shipping_templates RENAME TO qa_shipping_templates; CREATE FUNCTION qa_snapshot_type(n smallint) RETURNS smallint LANGUAGE plpgsql VOLATILE AS $$ BEGIN PERFORM pg_advisory_xact_lock(731640,10); RETURN n; END $$; CREATE VIEW shipping_templates AS SELECT id,owner_type,relation_id,qa_snapshot_type(type) AS type,appoint,no_delivery,status,is_del FROM qa_shipping_templates");
  await withFinancePeers(f.db,async([holder,reader,editor])=>{
   await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731640,10)');const reading=quote(reader.db);
   await waitForFinanceBlock(f.db,reader.pid,holder.pid);
   await editor.exec("BEGIN; UPDATE qa_shipping_templates SET type=3; UPDATE shipping_templates_region SET first_price=9; COMMIT");
   await holder.exec('COMMIT');expect((await reading).payPostageCents).toBe(600);
  });expect((await quote(f.db)).payPostageCents).toBe(900);
 },15_000);
 it('reads committed old rates but refuses actual creation while admin child replacement is uncommitted',async()=>{
  const before=await f.snapshot();await f.exec("CREATE FUNCTION qa_template_write_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(731640,11); RETURN NEW; END $$; CREATE TRIGGER qa_template_write_hold BEFORE INSERT ON shipping_templates_region FOR EACH ROW EXECUTE FUNCTION qa_template_write_hold()");
  await withFinancePeers(f.db,async([holder,editor,buyer])=>{
   await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731640,11)');const editing=outcome(edit(editor.db));
   await waitForFinanceBlock(f.db,editor.pid,holder.pid);expect((await quote(buyer.db)).payPostageCents).toBe(600);
   expect(await outcome(create(buyer.db))).toMatchObject({ok:false,error:{message:expect.stringContaining('正在更新')}});
   expect(await f.snapshot()).toEqual(before);await holder.exec('COMMIT');expect(await editing).toMatchObject({ok:true});
  });
 },15_000);
 it.each(['admin','retire','city'] as const)('holds actual order validation locks until commit against a later %s writer',async kind=>{
  await withFinancePeers(f.db,async([holder,buyer,editor])=>{
   await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731640,12)');
   const buying=outcome(withTx(createContainerFromDb(buyer.db),async tx=>{const result=await create(tx);await tx.execute(sql`SELECT pg_advisory_xact_lock(731640,12)`);return result;}));
   await waitForFinanceBlock(f.db,buyer.pid,holder.pid);
   const editing=kind==='admin'?outcome(edit(editor.db)):outcome(editor.exec(kind==='retire'?"UPDATE shipping_templates SET is_del=1 WHERE id=10":"UPDATE city_area SET path='/102/' WHERE id=101"));
   await waitForFinanceBlock(f.db,editor.pid,buyer.pid);await holder.exec('COMMIT');expect(await buying).toMatchObject({ok:true});expect(await editing).toMatchObject({ok:true});
  });expect((await f.snapshot()).orders[0]).toMatchObject({payPostage:'6.00',payPrice:'26.00'});
 },15_000);
 it('fails without waiting on a city editor and rolls back the full order',async()=>{
  const before=await f.snapshot();await withFinancePeers(f.db,async([holder,buyer])=>{
   await holder.exec("BEGIN; UPDATE city_area SET path='/102/' WHERE id=101");
   expect(await outcome(create(buyer.db))).toMatchObject({ok:false,error:{message:expect.stringContaining('正在更新')}});await holder.exec('ROLLBACK');
  });expect(await f.snapshot()).toEqual(before);
 },15_000);
 it('allows nested repeatable-read quote but refuses stale-snapshot creation without changing caller isolation',async()=>{
  await withFinancePeers(f.db,async([peer])=>{
   await withTx(createContainerFromDb(peer.db),async tx=>{await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
    expect((await quote(tx)).payPostageCents).toBe(600);await expect(create(tx)).rejects.toThrow('READ COMMITTED');
    const [settings]=await tx.select({value:sql<string>`current_setting('transaction_isolation')`}).from(sql`(VALUES(1)) q(n)`);expect(settings.value).toBe('repeatable read');
   });
  });expect((await f.snapshot()).orders).toHaveLength(0);
 },15_000);
 it('preserves stricter statement and lock timeouts and restores them after commit',async()=>{
  await withFinancePeers(f.db,async([peer])=>{
   await peer.exec("SET statement_timeout='3500ms'; SET lock_timeout='120ms'; SET idle_in_transaction_session_timeout='2500ms'");await create(peer.db);
   const [settings]=await peer.db.select({statement:sql<string>`current_setting('statement_timeout')`,lock:sql<string>`current_setting('lock_timeout')`,idle:sql<string>`current_setting('idle_in_transaction_session_timeout')`}).from(sql`(VALUES(1)) q(n)`);
   expect(settings).toEqual({statement:'3500ms',lock:'120ms',idle:'2500ms'});
  });
 },15_000);
});
