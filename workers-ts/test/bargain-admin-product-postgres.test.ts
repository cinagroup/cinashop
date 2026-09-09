import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { saveBargain } from '../src/services/activity/BargainAdminService';
import { storeBargain, storeProduct } from '../src/models/schema';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { outcome, waitForFinanceBlock, waitForFinanceClock, withFinancePeers } from './helpers/financePeers';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('bargain source product on independent PG16 backends', () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  beforeEach(async () => { f=await createBargainSelectionFixture(); }, 30_000);
  afterEach(async () => { await f?.close(); });
  const snapshot=async()=>({...await f.snapshot(),sequences:undefined});
  const rejected=async(work:ReturnType<typeof outcome>,message:string)=>{
    const result=await work;expect(result.ok).toBe(false);if(!result.ok)expect(result.error.message).toContain(message);
  };
  it.each([
    ['is_vip_product=1','SVIP'],['is_presale_product=1','预售'],['is_del=1','不可用'],['is_verify=0','不可用'],
  ])('rechecks source eligibility after a verified wait for %s', async (mutation,message)=>{
    await withFinancePeers(f.db,async ([writer,editor])=>{
      await writer.exec(`BEGIN; UPDATE store_product SET ${mutation} WHERE id=70`);
      const before=await snapshot();
      const editing=outcome(saveBargain(createContainerFromDb(editor.db),{id:40,storeName:'迟到修改'}));
      await waitForFinanceBlock(f.db,editor.pid,writer.pid);await writer.exec('COMMIT');
      await rejected(editing,message);
      const after=await snapshot();expect(after.bargains).toEqual(before.bargains);expect(after.participations).toEqual(before.participations);expect(after.helps).toEqual(before.helps);
    });
  },15_000);
  it('holds source SHARE through the actual activity write, so a later source writer waits',async()=>{
    await f.exec(`CREATE FUNCTION qa_product_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock(731632,40); RETURN NEW; END $$;
      CREATE TRIGGER qa_product_hold AFTER UPDATE OF store_name ON store_bargain FOR EACH ROW EXECUTE FUNCTION qa_product_hold()`);
    await withFinancePeers(f.db,async ([blocker,editor,writer])=>{
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731632,40)');
      const editing=outcome(saveBargain(createContainerFromDb(editor.db),{id:40,storeName:'先保存'}));
      await waitForFinanceBlock(f.db,editor.pid,blocker.pid);
      const changing=outcome(writer.exec('UPDATE store_product SET is_presale_product=1 WHERE id=70'));
      await waitForFinanceBlock(f.db,writer.pid,editor.pid);await blocker.exec('COMMIT');
      expect(await editing).toMatchObject({ok:true,value:40});expect(await changing).toMatchObject({ok:true});
    });
    const before=await snapshot();await expect(saveBargain(f.container,{id:40,storeName:'下一次拒绝'})).rejects.toThrow('预售');expect(await snapshot()).toEqual(before);
  },15_000);
  it('inherits the committed metadata after a verified wait without replaying source inventory',async()=>{
    await withFinancePeers(f.db,async ([writer,editor])=>{
      await writer.exec("BEGIN; UPDATE store_product SET type=2,relation_id=8,system_form_id=9,stock=17 WHERE id=70");
      const editing=outcome(saveBargain(createContainerFromDb(editor.db),{id:40,storeName:'新的来源'}));
      await waitForFinanceBlock(f.db,editor.pid,writer.pid);await writer.exec('COMMIT');expect(await editing).toMatchObject({ok:true});
    });
    expect((await snapshot()).bargains[0]).toMatchObject({type:2,relationId:8,systemFormId:9,stock:8,quota:8,price:'10.00'});
    const [product]=await f.db.select().from(storeProduct).where(eq(storeProduct.id,70));expect(product.stock).toBe(17);
  },15_000);
  it('allows two activity editors to share the same source lock without serializing each other',async()=>{
    await f.db.insert(storeBargain).values({id:41,productId:70,storeName:'另一活动',price:'10.00',minPrice:'2.00',people:2,startTime:f.startTime,stopTime:f.stopTime});
    await f.exec(`CREATE FUNCTION qa_product_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id=40 THEN PERFORM pg_advisory_xact_lock(731632,40); END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_product_hold AFTER UPDATE OF store_name ON store_bargain FOR EACH ROW EXECUTE FUNCTION qa_product_hold()`);
    await withFinancePeers(f.db,async ([blocker,first,second])=>{
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731632,40)');
      const editing=outcome(saveBargain(createContainerFromDb(first.db),{id:40,storeName:'第一个'}));await waitForFinanceBlock(f.db,first.pid,blocker.pid);
      await expect(saveBargain(createContainerFromDb(second.db),{id:41,storeName:'第二个'})).resolves.toBe(41);
      await waitForFinanceBlock(f.db,first.pid,blocker.pid);await blocker.exec('COMMIT');expect(await editing).toMatchObject({ok:true});
    });
  },15_000);
  it('preserves a stricter product lock timeout, rolls back and can retry after release',async()=>{
    const before=await snapshot();
    await withFinancePeers(f.db,async ([writer,editor])=>{
      await editor.exec("SET lock_timeout='500ms'; SET statement_timeout='1500ms'; SET idle_in_transaction_session_timeout='1200ms'");
      const settings=()=>editor.exec("SELECT current_setting('lock_timeout'),current_setting('statement_timeout'),current_setting('idle_in_transaction_session_timeout')");
      const original=await settings();await writer.exec('BEGIN; SELECT id FROM store_product WHERE id=70 FOR UPDATE');
      const editing=outcome(saveBargain(createContainerFromDb(editor.db),{id:40,storeName:'超时'}));await waitForFinanceBlock(f.db,editor.pid,writer.pid);
      const result=await editing;expect(result.ok).toBe(false);if(!result.ok){let cause=result.error;while(cause.cause)cause=cause.cause;expect(cause).toMatchObject({code:'55P03'});}
      expect(await snapshot()).toEqual(before);expect(await settings()).toEqual(original);
      await writer.exec('COMMIT');await expect(saveBargain(createContainerFromDb(editor.db),{id:40,storeName:'重试'})).resolves.toBe(40);expect(await settings()).toEqual(original);
    });
  },15_000);
  it('rechecks the old deadline after waiting on the source product even when the edit extends it',async()=>{
    await withFinancePeers(f.db,async ([writer,editor])=>{
      const [row]=await f.db.update(storeBargain).set({stopTime:sql`(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 second'`}).where(eq(storeBargain.id,40)).returning({stop:storeBargain.stopTime});
      const before=await snapshot();await writer.exec('BEGIN; SELECT id FROM store_product WHERE id=70 FOR UPDATE');
      const editing=outcome(saveBargain(createContainerFromDb(editor.db),{id:40,stopTime:f.stopTime.toISOString()}));
      await waitForFinanceBlock(f.db,editor.pid,writer.pid);await waitForFinanceClock(f.db,row.stop!.getTime());await writer.exec('COMMIT');
      await rejected(editing,'活动已结束');expect(await snapshot()).toEqual(before);
    });
  },15_000);
});
