import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { saveBargain } from '../src/services/activity/BargainAdminService';
import { bargainShippingFields } from '../src/services/activity/BargainAdminShippingService';
import { readBargainSkuOptions } from '../src/services/activity/BargainAdminSkuService';
import { shippingTemplates, storeBargain, storeProductDescription } from '../src/models/schema';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('admin shipping independent PG16 transactions',()=>{
 let f:Awaited<ReturnType<typeof createBargainSelectionFixture>>;
 beforeEach(async()=>{f=await createBargainSelectionFixture();},30_000);
 afterEach(async()=>{await f?.close();});
 const state=async()=>({...await f.snapshot(),sequences:undefined,descriptions:await f.db.select().from(storeProductDescription)});
 const input=async()=>({deliveryType:'1',freight:3,postage:'0.00',tempId:10,
  expected:bargainShippingFields((await f.db.select().from(storeBargain).where(eq(storeBargain.id,40)))[0])});
 it.each(['COMMIT','ROLLBACK'])('compares original rules after a proven activity wait and %s',async finish=>{
  const shipping=await input(); await withFinancePeers(f.db,async([holder,editor])=>{
   await holder.exec('BEGIN');await holder.db.update(storeBargain).set({deliveryType:'2'}).where(eq(storeBargain.id,40));
   const editing=outcome(saveBargain(createContainerFromDb(editor.db),{id:40,shipping,description:'<p>配送正文</p>'}));
   await waitForFinanceBlock(f.db,editor.pid,holder.pid);await holder.exec(finish);
   const result=await editing;expect(result.ok).toBe(finish==='ROLLBACK');
   if(!result.ok) expect(result.error.message).toContain('已变化');
  });
  const saved=await state();expect(saved.bargains[0].deliveryType).toBe(finish==='COMMIT'?'2':'1');
  expect(saved.descriptions).toHaveLength(finish==='COMMIT'?0:1);
 },15_000);
 it('fails fast on a locked template and rolls back without waiting in reverse lock order',async()=>{
  const shipping=await input(),before=await state();await withFinancePeers(f.db,async([holder,editor])=>{
   await holder.exec('BEGIN');await holder.exec('SELECT id FROM shipping_templates WHERE id=10 FOR UPDATE');
   const result=await outcome(saveBargain(createContainerFromDb(editor.db),{id:40,shipping,storeName:'不能写入'}));
   expect(result).toMatchObject({ok:false,error:{message:expect.stringContaining('模板正在更新')}});
   // Holder remains uncommitted: completion proves NOWAIT, not a release-triggered success.
   await holder.exec('ROLLBACK');
  });expect(await state()).toEqual(before);
 },15_000);
 it('rechecks a committed template retirement after waiting for the source product',async()=>{
  const shipping=await input(),before=await state();await withFinancePeers(f.db,async([holder,editor])=>{
   await holder.exec('BEGIN; SELECT id FROM store_product WHERE id=70 FOR UPDATE');
   const editing=outcome(saveBargain(createContainerFromDb(editor.db),{id:40,shipping,description:'<p>不能保存</p>'}));
   await waitForFinanceBlock(f.db,editor.pid,holder.pid);
   await holder.db.update(shippingTemplates).set({status:0}).where(eq(shippingTemplates.id,10));await holder.exec('COMMIT');
   expect(await editing).toMatchObject({ok:false,error:{message:expect.stringContaining('模板不可用')}});
  });expect(await state()).toEqual(before);
 },15_000);
 it('holds template SHARE until the entire save commits and reads coherent old/new shipping snapshots',async()=>{
  await f.exec(`CREATE FUNCTION qa_shipping_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(731636,40); RETURN NEW; END $$;
   CREATE TRIGGER qa_shipping_hold AFTER INSERT ON store_product_description FOR EACH ROW EXECUTE FUNCTION qa_shipping_hold()`);
  const shipping=await input();await withFinancePeers(f.db,async([holder,editor,templateWriter])=>{
   await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731636,40)');
   const editing=outcome(saveBargain(createContainerFromDb(editor.db),{id:40,shipping,description:'<p>运费保存</p>'}));
   await waitForFinanceBlock(f.db,editor.pid,holder.pid);
   expect((await readBargainSkuOptions(f.container,'70','40')).shipping.current).toEqual(shipping.expected);
   const retiring=outcome(templateWriter.db.update(shippingTemplates).set({status:0}).where(eq(shippingTemplates.id,10)));
   await waitForFinanceBlock(f.db,templateWriter.pid,editor.pid);await holder.exec('COMMIT');
   expect(await editing).toMatchObject({ok:true});expect(await retiring).toMatchObject({ok:true});
   const saved=await readBargainSkuOptions(f.container,'70','40');expect(saved.shipping.current).toMatchObject({deliveryType:'1',freight:3,tempId:10});
   expect(saved.shipping.templates).toEqual([]);
  });
 },15_000);
});
