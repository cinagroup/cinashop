/** Structural PG16 specimens only; these are not authored payment facts. */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { storeOrderOutbox } from '@/models/schema';
import { PAID_NOTICE_GENERATIONS, PAID_NOTICE_EVENT, runPaidNoticeUpgrade, paidNoticeCommissionedTx, paidNoticeEventGeneration,
  NOTICE_MAINTENANCE_BUDGET_SQL } from '@/migrations/paidNotice';
import { runWriteoffNoticeUpgrade, writeoffNoticeCommissionedTx } from '@/migrations/writeoffNotice';
import { runRefundSuccessNoticeUpgrade, refundSuccessNoticeCommissionedTx } from '@/migrations/refundSuccessNotice';
import { runSupplierOrderPriceRevision, installSupplierOrderPriceRevision, assertSupplierOrderPriceRevisionReady } from '@/migrations/supplierOrderPriceRevision';
import { financePostgres } from './helpers/financePostgres';
import { withFinancePeers } from './helpers/financePeers';
const clause=(events:readonly string[])=>`CHECK(event_type IN(${events.map(e=>"'"+e+"'").join(',')}))`;
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('PG16 explicit paid buyer notice commissioning',()=>{
  let f:Awaited<ReturnType<typeof financePostgres>>;
  beforeAll(async()=>{f=await financePostgres([storeOrderOutbox],{namespace:'public'});},30000);
  afterAll(async()=>{await f?.close();},30000);
  const set=(events:readonly string[])=>f.exec(`ALTER TABLE public.store_order_outbox DROP CONSTRAINT IF EXISTS soob_event_type_ck;ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck ${clause(events)}`);
  const catalog=()=>f.db.execute<{oid:string;definition:string;comment:string|null}>(sql`SELECT oid::text,pg_get_constraintdef(oid,false) AS definition,
    obj_description(oid,'pg_constraint') AS comment FROM pg_constraint WHERE conrelid='public.store_order_outbox'::regclass AND conname='soob_event_type_ck'`);
  const facts=async()=>({rows:await f.db.select().from(storeOrderOutbox),sequence:await f.exec('SELECT last_value,is_called FROM public.store_order_outbox_id_seq')});
  beforeEach(async()=>{
    await f.reset();await set(PAID_NOTICE_GENERATIONS[0].events);
    await f.db.insert(storeOrderOutbox).values({eventKey:'structural-owned',eventType:'order.paid',aggregateId:11,payload:{orderId:11,orderNo:'structural-specimen'}});
  });
  it.each(PAID_NOTICE_GENERATIONS.filter(g=>!g.paid))('adds only paid notice to $price/$virtual/$addons and preserves all rows/sequence/comment/OID on replay',async g=>{
    await set(g.events);await f.exec("COMMENT ON CONSTRAINT soob_event_type_ck ON public.store_order_outbox IS 'owned comment '' preserved'");
    const before=await facts();expect(await paidNoticeCommissionedTx(f.db)).toBe(false);
    await runPaidNoticeUpgrade(f.db);const installed=await catalog();
    expect(paidNoticeEventGeneration(installed[0].definition)).toMatchObject({price:g.price,virtual:g.virtual,paid:true,addons:g.addons,events:[...g.events,PAID_NOTICE_EVENT]});
    expect(installed[0].comment).toBe("owned comment ' preserved");
    expect(await paidNoticeCommissionedTx(f.db)).toBe(true);
    expect(await writeoffNoticeCommissionedTx(f.db)).toBe(g.addons.includes('order.writeoff.notice'));
    expect(await refundSuccessNoticeCommissionedTx(f.db)).toBe(g.addons.includes('order.refund.success.notice'));
    await runPaidNoticeUpgrade(f.db);expect(await catalog()).toEqual(installed);expect(await facts()).toEqual(before);
  });
  it('preserves paid activation through later writeoff, refund and price installers in both independent addon orders',async()=>{
    for(const first of ['writeoff','refund']){
      await set(PAID_NOTICE_GENERATIONS[0].events);await runPaidNoticeUpgrade(f.db);
      if(first==='writeoff'){await runWriteoffNoticeUpgrade(f.db);await runRefundSuccessNoticeUpgrade(f.db);}
      else{await runRefundSuccessNoticeUpgrade(f.db);await runWriteoffNoticeUpgrade(f.db);}
      await runSupplierOrderPriceRevision(f.db);await assertSupplierOrderPriceRevisionReady(f.db);
      const g=paidNoticeEventGeneration((await catalog())[0].definition)!;
      expect(g).toMatchObject({paid:true,price:true,virtual:false});
      expect(g.addons).toEqual(first==='writeoff'?['order.writeoff.notice','order.refund.success.notice']:['order.refund.success.notice','order.writeoff.notice']);
      const before=await catalog();await runWriteoffNoticeUpgrade(f.db);await runRefundSuccessNoticeUpgrade(f.db);await runSupplierOrderPriceRevision(f.db);
      expect(await catalog()).toEqual(before);
    }
  });
  it.each(["CHECK(event_type<>'')","CHECK(event_type IN('order.paid')) NOT VALID",''])('rejects unknown, invalid or missing catalogs without adopting rows: %s',async clause=>{
    await f.exec('ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_event_type_ck');
    if(clause)await f.exec('ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck '+clause);
    const before=await facts(),structure=await catalog();await expect(runPaidNoticeUpgrade(f.db)).rejects.toThrow();
    expect(await catalog()).toEqual(structure);expect(await facts()).toEqual(before);
  });
  it('rejects a comment exceeding the fixed maintenance budget without replacement',async()=>{
    await f.exec("COMMENT ON CONSTRAINT soob_event_type_ck ON public.store_order_outbox IS '"+'x'.repeat(4097)+"'");
    const before=await catalog();await expect(runPaidNoticeUpgrade(f.db)).rejects.toThrow('comment budget');expect(await catalog()).toEqual(before);
  });
  it('rejects actual RLS/column drift without rewriting the original event constraint',async()=>{
    const before=await catalog();
    await f.exec('ALTER TABLE public.store_order_outbox ENABLE ROW LEVEL SECURITY');
    try{await expect(runPaidNoticeUpgrade(f.db)).rejects.toThrow();expect(await catalog()).toEqual(before);}
    finally{await f.exec('ALTER TABLE public.store_order_outbox DISABLE ROW LEVEL SECURITY');}
    await f.exec('ALTER TABLE public.store_order_outbox ALTER COLUMN event_type TYPE varchar(65)');
    // The fixture's own ALTER TYPE can rewrite the stored CHECK expression.
    // Compare against that actual drift, not against bytes before fixture DDL.
    const drifted=await catalog();
    try{await expect(runPaidNoticeUpgrade(f.db)).rejects.toThrow();expect(await catalog()).toEqual(drifted);}
    finally{await f.exec('ALTER TABLE public.store_order_outbox ALTER COLUMN event_type TYPE varchar(64)');}
  });
  it('refuses a held relation lock and succeeds after safe release',async()=>{
    const before=await catalog();
    await withFinancePeers(f.db,async([peer])=>{await peer.db.transaction(async tx=>{
      await tx.execute(sql`LOCK TABLE public.store_order_outbox IN ACCESS EXCLUSIVE MODE`);
      await expect(runPaidNoticeUpgrade(f.db)).rejects.toThrow();
    });});
    expect(await catalog()).toEqual(before);await runPaidNoticeUpgrade(f.db);expect(await paidNoticeCommissionedTx(f.db)).toBe(true);
  });
  it.each([
    {name:'writeoff',run:runWriteoffNoticeUpgrade},
    {name:'refund',run:runRefundSuccessNoticeUpgrade},
    {name:'price',run:runSupplierOrderPriceRevision},
  ])('bounds the first $name routing read under a held relation lock and preserves stricter maintenance budgets',async({name,run})=>{
    await runPaidNoticeUpgrade(f.db);const before=await catalog(),rows=await facts();
    await withFinancePeers(f.db,async([holder,caller])=>{
      await holder.db.transaction(async held=>{
        await held.execute(sql`LOCK TABLE public.store_order_outbox IN ACCESS EXCLUSIVE MODE`);
        const refuses=async(work:()=>Promise<void>)=>{
          const started=performance.now(),failure:unknown=await work().then(()=>null,error=>error);
          expect(failure).toBeInstanceOf(Error);
          const codes:unknown[]=[];let error=failure;
          while(error&&typeof error==='object'&&codes.length<8){const row=error as {code?:unknown;cause?:unknown};codes.push(row.code);error=row.cause;}
          expect(codes).toContain('55P03');expect(performance.now()-started).toBeLessThan(2000);
        };
        await refuses(()=>run(caller.db));
        if(name==='price')await refuses(()=>caller.db.transaction(tx=>installSupplierOrderPriceRevision(tx)));
      });
    });
    expect(await catalog()).toEqual(before);expect(await facts()).toEqual(rows);
    await run(f.db);const installed=await catalog(),generation=paidNoticeEventGeneration(installed[0].definition);
    expect(generation).toMatchObject({paid:true,virtual:false,price:name==='price',
      addons:name==='price'?[]:[name==='writeoff'?'order.writeoff.notice':'order.refund.success.notice']});
    expect(await facts()).toEqual(rows);await run(f.db);expect(await catalog()).toEqual(installed);
    if(name==='price')await f.db.transaction(async tx=>{
      await tx.execute(sql`SET LOCAL statement_timeout='4000ms';SET LOCAL lock_timeout='200ms';SET LOCAL idle_in_transaction_session_timeout='3000ms'`);
      const context=()=>tx.execute<{statement:string;lock:string;idle:string;path:string;role:string;login:string;isolation:string}>(sql`SELECT
        pg_catalog.current_setting('statement_timeout') AS statement,pg_catalog.current_setting('lock_timeout') AS lock,
        pg_catalog.current_setting('idle_in_transaction_session_timeout') AS idle,pg_catalog.current_setting('search_path') AS path,
        current_user AS role,session_user AS login,pg_catalog.current_setting('transaction_isolation') AS isolation`);
      const stricter=await context();await tx.execute(sql.raw(NOTICE_MAINTENANCE_BUDGET_SQL));expect(await context()).toEqual(stricter);
      await installSupplierOrderPriceRevision(tx);
      const [after]=await context();expect(after).toMatchObject({statement:stricter[0].statement,lock:stricter[0].lock,idle:stricter[0].idle,
        role:stricter[0].role,login:stricter[0].login,isolation:stricter[0].isolation});
    });
    expect(await catalog()).toEqual(installed);expect(await facts()).toEqual(rows);
  });
  it('rejects actual bounded row overflow without installing a paid generation',async()=>{
    await f.exec("INSERT INTO public.store_order_outbox(event_key,event_type,aggregate_id,payload) SELECT 'owned-overflow:'||n,'order.paid',n,'{}'::jsonb FROM generate_series(1,10000)n");
    const before=await catalog();await expect(runPaidNoticeUpgrade(f.db)).rejects.toThrow('row budget');expect(await catalog()).toEqual(before);
    expect(await paidNoticeCommissionedTx(f.db)).toBe(false);
  });
  it('refuses the actual owner upgrade on a non-root transaction handle',async()=>{
    await f.db.transaction(async tx=>{await expect(runPaidNoticeUpgrade(tx as unknown as typeof f.db)).rejects.toThrow('root database');});
  });
});
