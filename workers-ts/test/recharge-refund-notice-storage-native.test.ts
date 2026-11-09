/** Actual PG16 catalog specimens only. No paid recharge, provider result,
 * refund capture, runnable new notice or message authority is fabricated. */
import { sql } from 'drizzle-orm';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { storeOrderOutbox,orderNotificationDelivery } from '@/models/schema';
import { PAID_NOTICE_GENERATIONS,RECHARGE_PAID_NOTICE_GENERATIONS,RECHARGE_REFUND_NOTICE_GENERATIONS,
 paidNoticeEventGeneration,runPaidNoticeUpgrade } from '@/migrations/paidNotice';
import { runMembershipPaidNoticeUpgrade,membershipPaidNoticeCommissionedTx } from '@/migrations/membershipPaidNotice';
import { runRechargePaidNoticeUpgrade,rechargePaidNoticeCommissionedTx } from '@/migrations/rechargePaidNotice';
import { RECHARGE_PAID_SUBJECT_CHECK_SQL } from '@/migrations/rechargePaidNoticeContract';
import { RECHARGE_REFUND_NOTICE_EVENT,RECHARGE_REFUND_NOTICE_MARK,RECHARGE_REFUND_NOTICE_KEY_PREFIX,
 RECHARGE_REFUND_NOTICE_SUBJECT_CHECK_SQL,RECHARGE_REFUND_NOTICE_SUBJECT_DEFINITION } from '@/migrations/rechargeRefundNoticeContract';
import { RECHARGE_REFUND_NOTICE_SQL,rechargeRefundNoticeCommissionedTx,prepareRechargeRefundNoticeTx,
 runRechargeRefundNoticeUpgrade,assertRechargeRefundNoticeActivePairTx } from '@/migrations/rechargeRefundNotice';
import { routineVirtualShippingSubjectsInstallSql,ROUTINE_VIRTUAL_SHIPPING_OLD_SUBJECT,
 inspectRoutineVirtualShippingSubjectsStructure } from '@/migrations/routineVirtualShippingSubjects';
import { runWriteoffNoticeUpgrade,writeoffNoticeCommissionedTx } from '@/migrations/writeoffNotice';
import { runRefundSuccessNoticeUpgrade,refundSuccessNoticeCommissionedTx } from '@/migrations/refundSuccessNotice';
import { runSupplierOrderPriceRevision,installSupplierOrderPriceRevision,assertSupplierOrderPriceRevisionReady } from '@/migrations/supplierOrderPriceRevision';
import { rechargeSubscriptionTransientSqlState } from '@/services/wechat/RoutineSubscriptionRechargeEvidenceCodec';
import { financePostgres } from './helpers/financePostgres';
import { withFinancePeers } from './helpers/financePeers';

const constraintSqlState=(error:unknown):string|null=>{
 const seen=new Set<object>();for(let n=0;n<6&&error&&typeof error==='object'&&!seen.has(error);n++){
  seen.add(error);const code=Object.getOwnPropertyDescriptor(error,'code');
  if(code){if(!('value'in code))return null;if(code.value!==undefined)return typeof code.value==='string'&&/^[0-9A-Z]{5}$/u.test(code.value)?code.value:null;}
  const cause=Object.getOwnPropertyDescriptor(error,'cause');if(!cause||!('value'in cause))return null;error=cause.value;
 }return null;
};
const clause=(events:readonly string[])=>`CHECK(event_type IN(${events.map(e=>"'"+e+"'").join(',')}))`;
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('paired recharge refund notice storage catalog',()=>{
 let f:Awaited<ReturnType<typeof financePostgres>>,setup:Promise<void>|undefined,pending:Promise<unknown>|undefined,busy=false;
 const start=<T>(run:()=>Promise<T>)=>{if(busy)throw Error('Previous notice storage case pending');busy=true;
  const p=run().finally(()=>{busy=false;});pending=p;void p.catch(()=>undefined);return p;};
 const inspect=()=>f.db.transaction(tx=>rechargeRefundNoticeCommissionedTx(tx));
 const events=(values:readonly string[])=>f.exec(`ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_event_type_ck;
  ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck ${clause(values)}`);
 const subject=(check:string)=>f.exec(`ALTER TABLE public.order_notification_delivery DROP CONSTRAINT ond_subject_ck;
  ALTER TABLE public.order_notification_delivery ADD CONSTRAINT ond_subject_ck ${check}`);
 const catalog=()=>f.db.execute<{relation:string;oid:string;xmin:string;definition:string;comment:string|null}>(sql`SELECT
  conrelid::regclass::text AS relation,oid::text,xmin::text,pg_catalog.pg_get_constraintdef(oid,false) AS definition,
  pg_catalog.obj_description(oid,'pg_constraint') AS comment FROM pg_catalog.pg_constraint
  WHERE (conrelid='public.store_order_outbox'::regclass AND conname='soob_event_type_ck')
   OR (conrelid='public.order_notification_delivery'::regclass AND conname='ond_subject_ck') ORDER BY relation`);
 const facts=async()=>({
  rows:await f.db.execute(sql`SELECT * FROM (SELECT 'outbox' AS kind,to_jsonb(t) AS row,xmin::text FROM public.store_order_outbox t
   UNION ALL SELECT 'delivery',to_jsonb(t),xmin::text FROM public.order_notification_delivery t) q ORDER BY kind,(row->>'id')::integer`),
  sequence:await f.exec("SELECT 'outbox' AS kind,last_value,is_called FROM public.store_order_outbox_id_seq UNION ALL SELECT 'delivery',last_value,is_called FROM public.order_notification_delivery_id_seq ORDER BY kind"),
  metadata:await f.db.execute(sql`SELECT c.oid::text,c.relname,c.relowner::text,c.relacl::text,
   (SELECT jsonb_agg(jsonb_build_array(a.attnum,a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attacl,
    pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0) AS columns
   FROM pg_catalog.pg_class c WHERE c.oid IN('public.store_order_outbox'::regclass,'public.order_notification_delivery'::regclass,
    'public.store_order_outbox_id_seq'::regclass,'public.order_notification_delivery_id_seq'::regclass) ORDER BY c.relname`)});
 const refuse=async()=>{const before=await catalog();await expect(inspect()).rejects.toMatchObject({httpStatus:503});
  await expect(runRechargeRefundNoticeUpgrade(f.db)).rejects.toThrow();expect(await catalog()).toEqual(before);};
 const changed=async(mutate:string,restore:string)=>{expect(await inspect()).toBe(false);
  await f.exec(mutate);try{await refuse();}finally{await f.exec(restore);}expect(await inspect()).toBe(false);};
 beforeAll(async()=>{setup=(async()=>{
  f=await financePostgres([storeOrderOutbox,orderNotificationDelivery],{namespace:'public'});
  // This fixture intentionally creates columns/PK only. Install the exact known
  // index and structural predecessor, not a production repair or whole profile.
  await f.exec(`ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck ${clause(PAID_NOTICE_GENERATIONS[0].events)};
   CREATE UNIQUE INDEX soob_event_key_uq ON public.store_order_outbox(event_key);
   ALTER TABLE public.order_notification_delivery ADD CONSTRAINT ond_subject_ck ${ROUTINE_VIRTUAL_SHIPPING_OLD_SUBJECT}`);
  await f.exec(routineVirtualShippingSubjectsInstallSql(false));
  await runMembershipPaidNoticeUpgrade(f.db);await runRechargePaidNoticeUpgrade(f.db);
 })();await setup;},30000);
 afterAll(async()=>{try{if(setup)await Promise.allSettled([setup]);if(pending)await Promise.allSettled([pending]);}finally{await f?.close();}},30000);
 beforeEach(async()=>{if(busy)throw Error('Previous notice storage case still running');await f.reset();
  await subject(RECHARGE_PAID_SUBJECT_CHECK_SQL);await events(RECHARGE_PAID_NOTICE_GENERATIONS[0].events);
  const [outbox]=await f.db.insert(storeOrderOutbox).values({eventKey:'owned-structure-only',eventType:'order.paid',aggregateId:11,
   payload:{orderId:11,orderNo:'catalog specimen'},status:'COMPLETED'}).returning({id:storeOrderOutbox.id});
  await f.db.insert(orderNotificationDelivery).values({outboxId:outbox.id,eventKey:'order.delivery.notice:11',orderId:11,userId:22,
   noticeMark:'order_deliver_success',channel:'sms',payload:{kind:'sms',params:{}},status:'SKIPPED',lastError:'catalog_specimen_only'});
 });

 it.each(RECHARGE_PAID_NOTICE_GENERATIONS)('advances exact $price/$paid/$addons; preserves rows, sequence, ACL, comments and zero-write replay',g=>start(async()=>{
  await events(g.events);await f.exec("COMMENT ON CONSTRAINT soob_event_type_ck ON public.store_order_outbox IS 'owned event comment';COMMENT ON CONSTRAINT ond_subject_ck ON public.order_notification_delivery IS 'owned subject comment'");
  const before=await facts();expect(await inspect()).toBe(false);
  await runRechargeRefundNoticeUpgrade(f.db);const installed=await catalog();
  expect(installed.find(r=>r.relation==='store_order_outbox')?.definition).toBe(RECHARGE_REFUND_NOTICE_GENERATIONS[RECHARGE_PAID_NOTICE_GENERATIONS.indexOf(g)].definition);
  expect(installed.find(r=>r.relation==='order_notification_delivery')).toMatchObject({definition:RECHARGE_REFUND_NOTICE_SUBJECT_DEFINITION,comment:'owned subject comment'});
  expect(installed.find(r=>r.relation==='store_order_outbox')?.comment).toBe('owned event comment');
  expect(await inspect()).toBe(true);expect(await inspectRoutineVirtualShippingSubjectsStructure(f.db)).toMatchObject({ready:true,failures:[]});
  expect(await facts()).toEqual(before);await runRechargeRefundNoticeUpgrade(f.db);expect(await catalog()).toEqual(installed);expect(await facts()).toEqual(before);
 }),5000);

 for(const [name,upgrade] of [
  ['paid',()=>runPaidNoticeUpgrade(f.db)],['membership',()=>runMembershipPaidNoticeUpgrade(f.db)],
  ['recharge',()=>runRechargePaidNoticeUpgrade(f.db)],['goods-refund',()=>runRefundSuccessNoticeUpgrade(f.db)],
  ['writeoff',()=>runWriteoffNoticeUpgrade(f.db)],['price-root',()=>runSupplierOrderPriceRevision(f.db)],
  ['price-caller-tx',()=>f.db.transaction(tx=>installSupplierOrderPriceRevision(tx))],
 ] as const)it('actual old '+name+' tool preserves the complete successor on replay',()=>start(async()=>{
  await events(RECHARGE_PAID_NOTICE_GENERATIONS.find(g=>g.price&&g.paid&&g.addons.length===2)!.events);
  await runRechargeRefundNoticeUpgrade(f.db);const before=await catalog(),data=await facts();
  await upgrade();expect(await catalog()).toEqual(before);expect(await facts()).toEqual(data);
  expect(await inspect()).toBe(true);
 }),5000);
 for(const first of ['refund','writeoff'])it('old addon first '+first+' keeps precise tail order and all prior gates',()=>start(async()=>{
  await runRechargeRefundNoticeUpgrade(f.db);
  if(first==='refund'){await runRefundSuccessNoticeUpgrade(f.db);await runWriteoffNoticeUpgrade(f.db);}
  else{await runWriteoffNoticeUpgrade(f.db);await runRefundSuccessNoticeUpgrade(f.db);}
  await runPaidNoticeUpgrade(f.db);await runSupplierOrderPriceRevision(f.db);
  const installed=await catalog(),g=paidNoticeEventGeneration(installed.find(r=>r.relation==='store_order_outbox')?.definition);
  expect(g).toMatchObject({price:true,paid:true,membership:true,recharge:true,rechargeRefundNotice:true,
   addons:first==='refund'?['order.refund.success.notice','order.writeoff.notice']:['order.writeoff.notice','order.refund.success.notice']});
  expect(g?.events.at(-1)).toBe(RECHARGE_REFUND_NOTICE_EVENT);
  expect(await membershipPaidNoticeCommissionedTx(f.db)).toBe(true);expect(await rechargePaidNoticeCommissionedTx(f.db)).toBe(true);
  expect(await refundSuccessNoticeCommissionedTx(f.db)).toBe(true);expect(await writeoffNoticeCommissionedTx(f.db)).toBe(true);
  await assertSupplierOrderPriceRevisionReady(f.db);
 }),5000);

 for(const half of ['event','subject'])it('refuses '+half+'-only commissioning and all new old-wrapper routes without repair',()=>start(async()=>{
  if(half==='event')await events(RECHARGE_REFUND_NOTICE_GENERATIONS[0].events);else await subject(RECHARGE_REFUND_NOTICE_SUBJECT_CHECK_SQL);
  await refuse();const before=await catalog();
  for(const run of half==='event' ? [runPaidNoticeUpgrade,runMembershipPaidNoticeUpgrade,runRechargePaidNoticeUpgrade,runRefundSuccessNoticeUpgrade,runWriteoffNoticeUpgrade,runSupplierOrderPriceRevision]
   : [runMembershipPaidNoticeUpgrade,runRechargePaidNoticeUpgrade,runSupplierOrderPriceRevision])
   await expect(run(f.db)).rejects.toThrow();
  expect(await catalog()).toEqual(before);
 }),5000);

 const normalKey=RECHARGE_REFUND_NOTICE_KEY_PREFIX+'12345678-1234-4234-8234-123456789abc';
 const base={domain:'recharge' as string|null,subject:11 as number|null,order:null as number|null,withdrawal:null as number|null,
  key:normalKey,mark:RECHARGE_REFUND_NOTICE_MARK,channel:'sms'};
 const insert=(r:typeof base)=>f.db.transaction(tx=>tx.execute(sql`INSERT INTO public.order_notification_delivery
  (outbox_id,event_key,order_id,withdrawal_id,subject_domain,subject_id,user_id,notice_mark,channel,payload,status)
  VALUES(1,${r.key},${r.order},${r.withdrawal},${r.domain},${r.subject},22,${r.mark},${r.channel},'{}'::jsonb,'SKIPPED')`));
 for(const [name,patch] of [
  ['null-domain',{domain:null}],['null-subject',{subject:null}],['zero',{subject:0}],['negative',{subject:-1}],['membership',{domain:'membership'}],
  ['order',{order:11}],['withdrawal',{withdrawal:11}],['legacy-order-alias',{domain:null,subject:null,order:11}],
  ['legacy-withdrawal-alias',{domain:null,subject:null,withdrawal:11}],['wrong-mark',{mark:'recharge_success'}],
  ['official',{channel:'wechat_official'}],['shipping',{channel:'wechat_shipping'}],
  ['upper-uuid',{key:RECHARGE_REFUND_NOTICE_KEY_PREFIX+normalKey.slice(RECHARGE_REFUND_NOTICE_KEY_PREFIX.length).toUpperCase()}],['non-v4',{key:normalKey.replace('-4234-','-5234-')}],
  ['bad-variant',{key:normalKey.replace('-8234-','-7234-')}],['truncated',{key:normalKey.slice(0,-1)}],
  ['suffix',{key:normalKey+'a'}],['newline',{key:normalKey+'\n'}],['numeric-key',{key:RECHARGE_REFUND_NOTICE_KEY_PREFIX+'11'}],
 ] as const)it('subject rejects '+name+' without row adoption',()=>start(async()=>{
  await runRechargeRefundNoticeUpgrade(f.db);const retained=await f.db.select().from(orderNotificationDelivery);
  let failure:unknown;try{await insert({...base,...patch});}catch(error){failure=error;}
  expect(constraintSqlState(failure)).toBe('23514');expect(await f.db.select().from(orderNotificationDelivery)).toEqual(retained);
  // A rejected INSERT may consume serial IDs. Inspectors themselves are covered
  // separately; no false assertion that rollback rewinds a PostgreSQL sequence.
 }),5000);
 it('preserves old subjects and permits only new sms/routine structural specimens',()=>start(async()=>{
  await runRechargeRefundNoticeUpgrade(f.db);
  for(const channel of ['sms','wechat_routine'])await insert({...base,channel});
  await insert({...base,domain:null,subject:null,order:11,key:'order.delivery.notice:11',mark:'order_deliver_success'});
  await insert({...base,key:'recharge.pay.success.notice:11',mark:'recharge_success',channel:'wechat_official'});
  await insert({...base,domain:'membership',key:'membership.pay.success.notice:11',mark:'order_pay_success'});
  await insert({...base,channel:'wechat_shipping',key:'recharge.paid.shipping:11',mark:'paid_virtual_shipping'});
  expect(await f.db.select().from(orderNotificationDelivery)).toHaveLength(7);
 }),5000);

 for(const [name,mutation,restore] of [
  ['unique missing','DROP INDEX public.soob_event_key_uq','CREATE UNIQUE INDEX soob_event_key_uq ON public.store_order_outbox(event_key)'],
  ['unique partial','DROP INDEX public.soob_event_key_uq;CREATE UNIQUE INDEX soob_event_key_uq ON public.store_order_outbox(event_key) WHERE event_key IS NOT NULL','DROP INDEX public.soob_event_key_uq;CREATE UNIQUE INDEX soob_event_key_uq ON public.store_order_outbox(event_key)'],
  ['unique nondefault opclass','DROP INDEX public.soob_event_key_uq;CREATE UNIQUE INDEX soob_event_key_uq ON public.store_order_outbox(event_key varchar_pattern_ops)','DROP INDEX public.soob_event_key_uq;CREATE UNIQUE INDEX soob_event_key_uq ON public.store_order_outbox(event_key)'],
  ['serial default','ALTER TABLE public.store_order_outbox ALTER COLUMN id SET DEFAULT 1',"ALTER TABLE public.store_order_outbox ALTER COLUMN id SET DEFAULT nextval('public.store_order_outbox_id_seq'::regclass)"],
  ['serial owned by','ALTER SEQUENCE public.store_order_outbox_id_seq OWNED BY NONE','ALTER SEQUENCE public.store_order_outbox_id_seq OWNED BY public.store_order_outbox.id'],
  ['serial cache','ALTER SEQUENCE public.store_order_outbox_id_seq CACHE 2','ALTER SEQUENCE public.store_order_outbox_id_seq CACHE 1'],
  ['payload default',"ALTER TABLE public.store_order_outbox ALTER COLUMN payload SET DEFAULT '[1]'::jsonb","ALTER TABLE public.store_order_outbox ALTER COLUMN payload SET DEFAULT '{}'::jsonb"],
  ['aggregate type','ALTER TABLE public.store_order_outbox ALTER COLUMN aggregate_type TYPE varchar(33)','ALTER TABLE public.store_order_outbox ALTER COLUMN aggregate_type TYPE varchar(32)'],
 ] as const)it('rejects actual '+name+' drift and does not repair it',()=>start(()=>changed(mutation,restore)),5000);
 for(const relation of ['store_order_outbox','order_notification_delivery'])it('refuses oversized '+relation+' comment even on exact replay',()=>start(async()=>{
  await runRechargeRefundNoticeUpgrade(f.db);const constraint=relation==='store_order_outbox'?'soob_event_type_ck':'ond_subject_ck';
  await f.exec(`COMMENT ON CONSTRAINT ${constraint} ON public.${relation} IS '${'c'.repeat(4097)}'`);
  try{await refuse();const before=await catalog();await expect(runPaidNoticeUpgrade(f.db)).rejects.toThrow();expect(await catalog()).toEqual(before);}
  finally{await f.exec(`COMMENT ON CONSTRAINT ${constraint} ON public.${relation} IS NULL`);}
 }),5000);
 it('refuses unknown event definition and unvalidated subject without repairing either',()=>start(async()=>{
  await events([...RECHARGE_PAID_NOTICE_GENERATIONS[0].events,'unreviewed.event']);await refuse();
  await events(RECHARGE_PAID_NOTICE_GENERATIONS[0].events);
  await f.exec(`ALTER TABLE public.order_notification_delivery DROP CONSTRAINT ond_subject_ck;
   ALTER TABLE public.order_notification_delivery ADD CONSTRAINT ond_subject_ck ${RECHARGE_PAID_SUBJECT_CHECK_SQL} NOT VALID`);await refuse();
 }),5000);
 it('refuses actual pg_temp ORM shadow, transaction root misuse and SET ROLE',()=>start(async()=>{
  const before=await catalog();
  await expect(rechargeRefundNoticeCommissionedTx(f.db)).rejects.toMatchObject({httpStatus:503});
  await expect(prepareRechargeRefundNoticeTx(f.db)).rejects.toMatchObject({httpStatus:503});
  await expect(assertRechargeRefundNoticeActivePairTx(f.db)).rejects.toMatchObject({httpStatus:503});
  await expect(f.db.transaction(async tx=>{await tx.execute(sql`CREATE TEMP TABLE store_order_outbox(id integer) ON COMMIT DROP`);
   await tx.execute(sql`SET LOCAL search_path=pg_temp,public`);await rechargeRefundNoticeCommissionedTx(tx);})).rejects.toMatchObject({httpStatus:503});
  await expect(f.db.transaction(async tx=>{await tx.execute(sql`SET LOCAL ROLE finance_test`);await tx.execute(sql.raw(RECHARGE_REFUND_NOTICE_SQL));})).rejects.toThrow();
  await f.db.transaction(async tx=>{await expect(runRechargeRefundNoticeUpgrade(tx as unknown as typeof f.db)).rejects.toThrow('root database');});
  expect(await catalog()).toEqual(before);
 }),5000);
 for(const relation of ['store_order_outbox','order_notification_delivery'])it('bounds active owner/runtime wait on '+relation,()=>start(async()=>{
  await runRechargeRefundNoticeUpgrade(f.db);
  await withFinancePeers(f.db,async([peer])=>peer.db.transaction(async tx=>{
   await tx.execute(sql.raw(`LOCK TABLE ONLY public.${relation} IN ACCESS EXCLUSIVE MODE`));const began=Date.now();
   let failure:unknown;try{await runRechargeRefundNoticeUpgrade(f.db);}catch(error){failure=error;}
   expect(rechargeSubscriptionTransientSqlState(failure)).toBe('55P03');
   failure=undefined;try{await f.db.transaction(inner=>prepareRechargeRefundNoticeTx(inner));}catch(error){failure=error;}
   expect(rechargeSubscriptionTransientSqlState(failure)).toBe('55P03');expect(Date.now()-began).toBeLessThan(3000);
  }));
 }),5000);
 it('preserves stricter caller budgets and never consumes serial values while inspecting',()=>start(async()=>{
  const before=await facts();await f.db.transaction(async tx=>{
   await tx.execute(sql`SET LOCAL statement_timeout='4s'`);await tx.execute(sql`SET LOCAL lock_timeout='200ms'`);
   await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='3s'`);expect(await rechargeRefundNoticeCommissionedTx(tx)).toBe(false);
   const [r]=await tx.execute(sql`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle`);
   expect(r).toEqual({statement:'4s',lock:'200ms',idle:'3s'});
  });expect(await facts()).toEqual(before);
 }),5000);
 it('rolls back the actually installed first CHECK when a retained neutral subject fails the new closed branch',()=>start(async()=>{
  // Legal old neutral subject but reserved new key. This is an owner catalog
  // contradiction specimen, not an authored refund or provider truth.
  await f.exec(`UPDATE public.order_notification_delivery SET event_key='${normalKey}' WHERE id=1`);
  const before=await catalog(),data=await facts(),split=RECHARGE_REFUND_NOTICE_SQL.indexOf('DO $recharge_refund_subject$');
  expect(split).toBeGreaterThan(0);const rollback=Error('observed first CHECK then deliberate rollback');
  await expect(f.db.transaction(async tx=>{await tx.execute(sql.raw(RECHARGE_REFUND_NOTICE_SQL.slice(0,split)));
   const [r]=await tx.execute<{definition:string}>(sql`SELECT pg_get_constraintdef(oid,false) AS definition FROM pg_catalog.pg_constraint
    WHERE conrelid='public.store_order_outbox'::regclass AND conname='soob_event_type_ck'`);
   expect(paidNoticeEventGeneration(r.definition)?.rechargeRefundNotice).toBe(true);throw rollback;
  })).rejects.toBe(rollback);expect(await catalog()).toEqual(before);
  let failure:unknown;try{await runRechargeRefundNoticeUpgrade(f.db);}catch(error){failure=error;}
  expect(constraintSqlState(failure)).toBe('23514');expect(await catalog()).toEqual(before);expect(await facts()).toEqual(data);
 }),5000);
});
