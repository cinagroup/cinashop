/** Catalog specimens, not authored recharge payments or provider authority. */
import { sql } from 'drizzle-orm';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { orderNotificationDelivery,storeOrderOutbox } from '@/models/schema';
import { PAID_NOTICE_GENERATIONS,MEMBERSHIP_PAID_NOTICE_GENERATIONS,paidNoticeEventGeneration,runPaidNoticeUpgrade } from '@/migrations/paidNotice';
import { RECHARGE_PAID_NOTICE_SQL,runRechargePaidNoticeUpgrade,rechargePaidNoticeCommissionedTx,prepareRechargePaidNoticeTx } from '@/migrations/rechargePaidNotice';
import {runMembershipPaidNoticeUpgrade} from '@/migrations/membershipPaidNotice';
import {MEMBERSHIP_PAID_SUBJECT_CHECK_SQL} from '@/migrations/membershipPaidNoticeContract';
import { RECHARGE_PAID_EVENTS,RECHARGE_PAID_SUBJECT_CHECK_SQL,RECHARGE_PAID_SUBJECT_DEFINITION } from '@/migrations/rechargePaidNoticeContract';
import { routineVirtualShippingSubjectsInstallSql,  ROUTINE_VIRTUAL_SHIPPING_OLD_SUBJECT,inspectRoutineVirtualShippingSubjectsStructure } from '@/migrations/routineVirtualShippingSubjects';
import { runRefundSuccessNoticeUpgrade } from '@/migrations/refundSuccessNotice';
import { runWriteoffNoticeUpgrade } from '@/migrations/writeoffNotice';
import { runSupplierOrderPriceRevision,assertSupplierOrderPriceRevisionReady } from '@/migrations/supplierOrderPriceRevision';
import { financePostgres } from './helpers/financePostgres';
import { withFinancePeers } from './helpers/financePeers';
import { rechargeSubscriptionTransientSqlState } from '@/services/wechat/RoutineSubscriptionRechargeEvidenceCodec';
const clause=(events:readonly string[])=>`CHECK(event_type IN(${events.map(e=>"'"+e+"'").join(',')}))`;
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('paired PG16 recharge notification commissioning',()=>{
  let f:Awaited<ReturnType<typeof financePostgres>>;
  const predecessors=MEMBERSHIP_PAID_NOTICE_GENERATIONS;
  const events=(values:readonly string[])=>f.exec(`ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_event_type_ck;ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck ${clause(values)}`);
  const subject=(check:string)=>f.exec(`ALTER TABLE public.order_notification_delivery DROP CONSTRAINT ond_subject_ck;ALTER TABLE public.order_notification_delivery ADD CONSTRAINT ond_subject_ck ${check}`);
  const catalog=()=>f.db.execute<{relation:string;oid:string;definition:string;comment:string|null}>(sql`SELECT conrelid::regclass::text AS relation,oid::text,
    pg_get_constraintdef(oid,false) AS definition,obj_description(oid,'pg_constraint') AS comment FROM pg_constraint
    WHERE (conrelid='public.store_order_outbox'::regclass AND conname='soob_event_type_ck')
      OR (conrelid='public.order_notification_delivery'::regclass AND conname='ond_subject_ck') ORDER BY relation`);
  const facts=async()=>({outbox:await f.db.select().from(storeOrderOutbox),delivery:await f.db.select().from(orderNotificationDelivery),
    outboxSeq:await f.exec('SELECT last_value,is_called FROM public.store_order_outbox_id_seq'),
    deliverySeq:await f.exec('SELECT last_value,is_called FROM public.order_notification_delivery_id_seq'),
    metadata:await f.db.execute<{relation:string;oid:string;owner:string;acl:string|null;columnAcl:unknown}>(sql`SELECT c.relname AS relation,
      c.oid::text AS oid,c.relowner::text AS owner,c.relacl::text AS acl,
      (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'acl',a.attacl::text) ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS "columnAcl"
      FROM pg_catalog.pg_class c WHERE c.oid IN('public.store_order_outbox'::regclass,'public.order_notification_delivery'::regclass,
        'public.store_order_outbox_id_seq'::regclass,'public.order_notification_delivery_id_seq'::regclass) ORDER BY c.relname`)});
  const proveEventPhaseThenRollback=async()=>{
    const subjectPhase=RECHARGE_PAID_NOTICE_SQL.indexOf('DO $recharge_paid_subject$');
    expect(subjectPhase).toBeGreaterThan(0);
    const rollback=new Error('catalog specimen event phase rollback');
    await expect(f.db.transaction(async tx=>{
      await tx.execute(sql.raw(RECHARGE_PAID_NOTICE_SQL.slice(0,subjectPhase)));
      const [event]=await tx.execute<{definition:string}>(sql`SELECT pg_get_constraintdef(oid,false) AS definition
        FROM pg_catalog.pg_constraint WHERE conrelid='public.store_order_outbox'::regclass AND conname='soob_event_type_ck'`);
      expect(paidNoticeEventGeneration(event.definition)?.recharge).toBe(true);
      throw rollback;
    })).rejects.toBe(rollback);
  };
  beforeAll(async()=>{f=await financePostgres([storeOrderOutbox,orderNotificationDelivery],{namespace:'public'});
    // financePostgres intentionally creates columns/PKs only; install the real
    // structural predecessor explicitly before the virtual subject installer.
    await f.exec(`ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck ${clause(PAID_NOTICE_GENERATIONS[0].events)};
      ALTER TABLE public.order_notification_delivery ADD CONSTRAINT ond_subject_ck ${ROUTINE_VIRTUAL_SHIPPING_OLD_SUBJECT}`);
    await f.exec(routineVirtualShippingSubjectsInstallSql(false));await runMembershipPaidNoticeUpgrade(f.db);},30000);
  afterAll(async()=>{await f?.close();},30000);
  beforeEach(async()=>{await f.reset();await subject(MEMBERSHIP_PAID_SUBJECT_CHECK_SQL);await events(predecessors[0].events);
    const [outbox]=await f.db.insert(storeOrderOutbox).values({eventKey:'owned-structure-only',eventType:'order.paid',aggregateId:11,payload:{orderId:11,orderNo:'structural-only'}}).returning({id:storeOrderOutbox.id});
    // A retained ordinary catalog specimen, never payment or send authority.
    await f.db.insert(orderNotificationDelivery).values({outboxId:outbox.id,eventKey:'order.delivery.notice:11',orderId:11,userId:22,
      noticeMark:'order_deliver_success',channel:'sms',payload:{kind:'sms',params:{order_id:'structural-only'}},status:'SKIPPED',lastError:'structural_specimen_only'});});
  it.each(predecessors)('adds recharge to exact $price/$paid/$addons and preserves data/sequences/comments/OID on replay',async g=>{
    await events(g.events);const before=await facts();
    expect(before.delivery).toHaveLength(1);expect(before.metadata).toHaveLength(4);
    await f.exec("COMMENT ON CONSTRAINT soob_event_type_ck ON public.store_order_outbox IS 'source comment';COMMENT ON CONSTRAINT ond_subject_ck ON public.order_notification_delivery IS 'delivery comment'");
    expect(await rechargePaidNoticeCommissionedTx(f.db)).toBe(false);
    await runRechargePaidNoticeUpgrade(f.db);const installed=await catalog();
    const event=installed.find(r=>r.relation==='store_order_outbox')!,delivery=installed.find(r=>r.relation==='order_notification_delivery')!;
    expect(paidNoticeEventGeneration(event.definition)).toMatchObject({...g,recharge:true,events:[...g.events,...RECHARGE_PAID_EVENTS],definition:expect.any(String)});
    expect(delivery.definition).toBe(RECHARGE_PAID_SUBJECT_DEFINITION);expect(delivery.comment).toBe('delivery comment');expect(event.comment).toBe('source comment');
    expect(await rechargePaidNoticeCommissionedTx(f.db)).toBe(true);
    expect(await inspectRoutineVirtualShippingSubjectsStructure(f.db)).toMatchObject({ready:true,failures:[]});
    expect(await facts()).toEqual(before);
    await runRechargePaidNoticeUpgrade(f.db);expect(await catalog()).toEqual(installed);expect(await facts()).toEqual(before);
  });
  it('preserves recharge through real old addon installers in both refund/writeoff orders',async()=>{
    for(const first of ['refund','writeoff']){
      await subject(MEMBERSHIP_PAID_SUBJECT_CHECK_SQL);await events(predecessors[0].events);await runRechargePaidNoticeUpgrade(f.db);
      const rechargeInstalled=await catalog(),rechargeFacts=await facts();
      await runMembershipPaidNoticeUpgrade(f.db);expect(await catalog()).toEqual(rechargeInstalled);expect(await facts()).toEqual(rechargeFacts);
      if(first==='refund'){await runRefundSuccessNoticeUpgrade(f.db);await runWriteoffNoticeUpgrade(f.db);}
      else{await runWriteoffNoticeUpgrade(f.db);await runRefundSuccessNoticeUpgrade(f.db);}
      await runPaidNoticeUpgrade(f.db);await runSupplierOrderPriceRevision(f.db);await assertSupplierOrderPriceRevisionReady(f.db);
      const installed=await catalog();expect(paidNoticeEventGeneration(installed.find(r=>r.relation==='store_order_outbox')!.definition)).toMatchObject({membership:true,recharge:true,paid:true,price:true});
      expect(await rechargePaidNoticeCommissionedTx(f.db)).toBe(true);
      await runRefundSuccessNoticeUpgrade(f.db);await runWriteoffNoticeUpgrade(f.db);await runPaidNoticeUpgrade(f.db);await runSupplierOrderPriceRevision(f.db);await runMembershipPaidNoticeUpgrade(f.db);
      expect(await catalog()).toEqual(installed);
    }
  });
  it('rejects NULL and ordinary/withdrawal aliases for recharge notice keys while preserving all permitted subjects',async()=>{
    await runRechargePaidNoticeUpgrade(f.db);
    const retained=await f.db.select().from(orderNotificationDelivery);expect(retained).toHaveLength(1);
    const outboxId=retained[0].outboxId;
    const base={domain:'recharge' as string|null,subject:11 as number|null,order:null as number|null,withdrawal:null as number|null,
      eventKey:'recharge.pay.success.notice:11',mark:'recharge_success',channel:'sms'};
    const insert=(r:typeof base)=>f.db.transaction(async tx=>tx.execute(sql`INSERT INTO public.order_notification_delivery
      (outbox_id,event_key,order_id,withdrawal_id,subject_domain,subject_id,user_id,notice_mark,channel,payload,status)
      VALUES(${outboxId},${r.eventKey},${r.order},${r.withdrawal},${r.domain},${r.subject},22,${r.mark},${r.channel},
        ${JSON.stringify({kind:r.channel})}::text::jsonb,'SKIPPED')`));
    for(const patch of [{domain:null},{subject:null},{subject:0},{domain:'membership'},{order:11},{withdrawal:11},
      {eventKey:'recharge.pay.success.notice:12'},{eventKey:'recharge.pay.success.notice:01'},
      {mark:'paid_virtual_shipping'},{channel:'wechat_shipping'},
      {domain:null,subject:null,order:11},{domain:null,subject:null,withdrawal:11}]){
      let failure:unknown;try{await insert({...base,...patch});}catch(error){failure=error;}
      const states:unknown[]=[];for(let depth=0;depth<6&&failure&&typeof failure==='object';depth++){
        const e=failure as {code?:unknown;cause?:unknown};states.push(e.code);failure=e.cause;
      }
      expect(states).toContain('23514');
      expect(await f.db.select().from(orderNotificationDelivery)).toEqual(retained);
    }
    // These are owner-authored structural specimens, not payment/source proof.
    for(const channel of ['sms','wechat_official','wechat_routine'])await insert({...base,channel});
    await insert({...base,domain:null,subject:null,order:11,eventKey:'order.pay.success.notice:11'});
    await insert({...base,domain:'membership',eventKey:'membership.pay.success.notice:11',mark:'order_pay_success'});
    await insert({...base,domain:null,subject:null,withdrawal:11,eventKey:'withdrawal.approved.notice:11'});
    for(const domain of ['recharge','membership'])await insert({...base,domain,channel:'wechat_shipping',mark:'paid_virtual_shipping',eventKey:domain+'.paid.shipping:11'});
    expect(await f.db.select().from(orderNotificationDelivery)).toHaveLength(retained.length+8);
  });
  it('rejects each half-installed pair without silently disabling new settlement authors',async()=>{
    for(const half of ['events','subject']){
      await subject(MEMBERSHIP_PAID_SUBJECT_CHECK_SQL);await events(predecessors[0].events);
      if(half==='events')await events([...predecessors[0].events,...RECHARGE_PAID_EVENTS]);else await subject(RECHARGE_PAID_SUBJECT_CHECK_SQL);
      const before=await catalog();await expect(rechargePaidNoticeCommissionedTx(f.db)).rejects.toMatchObject({httpStatus:503});
      await expect(runRechargePaidNoticeUpgrade(f.db)).rejects.toThrow();expect(await catalog()).toEqual(before);
    }
  });
  it('rejects unsafe index drift while preserving both constraints',async()=>{
    await f.exec('DROP INDEX public.ond_virtual_subject');const before=await catalog();
    try{await expect(rechargePaidNoticeCommissionedTx(f.db)).rejects.toMatchObject({httpStatus:503});await expect(runRechargePaidNoticeUpgrade(f.db)).rejects.toThrow();expect(await catalog()).toEqual(before);}
    finally{await f.exec('CREATE INDEX ond_virtual_subject ON public.order_notification_delivery USING btree(subject_domain,subject_id,id) WHERE subject_domain IS NOT NULL');}
  });
  it('rejects an unknown event CHECK and a shadow relation without adoption',async()=>{
    await f.exec("ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_event_type_ck;ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK(event_type<>'')");
    const before=await catalog();await expect(runRechargePaidNoticeUpgrade(f.db)).rejects.toThrow();expect(await catalog()).toEqual(before);
    await events(predecessors[0].events);await runRechargePaidNoticeUpgrade(f.db);
    await expect(f.db.transaction(async tx=>{await tx.execute(sql`CREATE TEMP TABLE store_order_outbox(id integer) ON COMMIT DROP`);
      await tx.execute(sql`SET LOCAL search_path=pg_temp,public`);await rechargePaidNoticeCommissionedTx(tx);})).rejects.toMatchObject({httpStatus:503});
  });
  it('bounds the first runtime catalog read under a held relation lock',async()=>{
    for(const relation of ['store_order_outbox','order_notification_delivery'])await withFinancePeers(f.db,async([peer])=>{
      await peer.db.transaction(async tx=>{await tx.execute(sql.raw(`LOCK TABLE public.${relation} IN ACCESS EXCLUSIVE MODE`));const started=Date.now();
        let failure:unknown;try{await f.db.transaction(async inner=>prepareRechargePaidNoticeTx(inner));}catch(error){failure=error;}
        expect(rechargeSubscriptionTransientSqlState(failure)).toBe('55P03');
        expect(Date.now()-started).toBeLessThan(2500);});});
  });
  it('retains caller budgets stricter than the shared runtime limit',async()=>{
    await f.db.transaction(async tx=>{await tx.execute(sql`SET LOCAL statement_timeout='4s'`);await tx.execute(sql`SET LOCAL lock_timeout='200ms'`);
      await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='3s'`);
      expect(await rechargePaidNoticeCommissionedTx(tx)).toBe(false);
      const [r]=await tx.execute<{statement:string;lock:string;idle:string}>(sql`SELECT current_setting('statement_timeout') AS statement,
        current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle`);
      expect(r).toEqual({statement:'4s',lock:'200ms',idle:'3s'});});
  });
  it('rolls back the upgraded event constraint when a retained delivery exceeds the row byte budget',async()=>{
    await f.exec(`UPDATE public.order_notification_delivery SET payload=jsonb_build_object('kind','sms','params',jsonb_build_object('structural',
      (SELECT string_agg(md5(n::text),'' ORDER BY n) FROM generate_series(1,65537)n))) WHERE event_key='order.delivery.notice:11'`);
    const [size]=await f.db.execute<{payloadLarge:boolean;rowLarge:boolean}>(sql`SELECT octet_length(payload::text)>1048576 AS "payloadLarge",
      pg_column_size(t)>1048576 AS "rowLarge" FROM (SELECT * FROM public.order_notification_delivery LIMIT 10001) t WHERE event_key='order.delivery.notice:11'`);
    expect(size).toEqual({payloadLarge:true,rowLarge:true});
    const beforeCatalog=await catalog(),beforeFacts=await facts();
    await proveEventPhaseThenRollback();expect(await catalog()).toEqual(beforeCatalog);expect(await facts()).toEqual(beforeFacts);
    await expect(runRechargePaidNoticeUpgrade(f.db)).rejects.toThrow('Recharge notice delivery maintenance row budget exceeded');
    expect(await catalog()).toEqual(beforeCatalog);expect(await facts()).toEqual(beforeFacts);
  });
  it('rolls back the upgraded event constraint when the retained subject comment exceeds its byte budget',async()=>{
    await f.exec("COMMENT ON CONSTRAINT ond_subject_ck ON public.order_notification_delivery IS '"+'c'.repeat(4097)+"'");
    const beforeCatalog=await catalog(),beforeFacts=await facts();
    expect(beforeCatalog.find(r=>r.relation==='order_notification_delivery')!.comment).toHaveLength(4097);
    await proveEventPhaseThenRollback();expect(await catalog()).toEqual(beforeCatalog);expect(await facts()).toEqual(beforeFacts);
    await expect(runRechargePaidNoticeUpgrade(f.db)).rejects.toThrow('Recharge notice subject predecessor drift');
    expect(await catalog()).toEqual(beforeCatalog);expect(await facts()).toEqual(beforeFacts);
  });
  it('refuses the fixed row budget and a transaction handle as maintenance root',async()=>{
    await f.exec("INSERT INTO public.store_order_outbox(event_key,event_type,aggregate_id,payload) SELECT 'owned-overflow:'||n,'order.paid',n,'{}'::jsonb FROM generate_series(1,10000)n");
    const before=await catalog();await expect(runRechargePaidNoticeUpgrade(f.db)).rejects.toThrow('budget');expect(await catalog()).toEqual(before);
    await f.db.transaction(async tx=>{await expect(runRechargePaidNoticeUpgrade(tx as unknown as typeof f.db)).rejects.toThrow('root database');});
    expect(RECHARGE_PAID_NOTICE_SQL).not.toMatch(/\bGRANT\b/u);
  });
});
