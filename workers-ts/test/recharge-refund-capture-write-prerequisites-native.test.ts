/** Actual catalog/LOGIN/write-lock acceptance only; no provider truth or
 * funds/receipt/notice row is authored. Explicit sequence allocations below
 * belong to test bodies, never to the prerequisite or hidden setup. */
import { sql } from 'drizzle-orm';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { rechargeRefundNoticeCommissionedTx } from '@/migrations/rechargeRefundNotice';
import { NOTICE_MAINTENANCE_BUDGET_SQL } from '@/migrations/paidNotice';
import { assertRechargeRefundCaptureWritePrerequisitesTx } from '@/services/payment/RechargeRefundCaptureWritePrerequisites';
import { rechargeCaptureWritePrerequisitesFixture,type RechargeCaptureWritePrerequisitesFixture } from './helpers/rechargeCaptureWritePrerequisitesNative';

const state=(error:unknown):string|null=>{
 const seen=new Set<object>();for(let n=0;n<7&&error&&typeof error==='object'&&!seen.has(error);n++){
  seen.add(error);const c=Object.getOwnPropertyDescriptor(error,'code');
  if(c){if(!('value'in c))return null;if(c.value!==undefined)return typeof c.value==='string'?c.value:null;}
  const cause=Object.getOwnPropertyDescriptor(error,'cause');if(!cause||!('value'in cause))return null;error=cause.value;
 }return null;
};
const triggerFunction="CREATE FUNCTION public.capture_write_probe_v1() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'";
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual recharge capture write prerequisites without money writes',()=>{
 let f:RechargeCaptureWritePrerequisitesFixture,setup:Promise<void>|undefined,pending:Promise<unknown>|undefined,busy=false;
 let network:ReturnType<typeof vi.spyOn<typeof globalThis,'fetch'>>;
 const start=<T>(run:()=>Promise<T>)=>{if(busy)throw Error('Previous capture catalog case pending');busy=true;
  const p=run().finally(()=>{busy=false;});pending=p;void p.catch(()=>undefined);return p;};
 beforeAll(async()=>{setup=(async()=>{network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No provider/network in capture catalog acceptance'));
  f=await rechargeCaptureWritePrerequisitesFixture();})();await setup;},240000);
 afterAll(async()=>{try{if(setup)await Promise.allSettled([setup]);if(pending)await Promise.allSettled([pending]);}
  finally{try{await f?.close();}finally{network?.mockRestore();}}},30000);
 const refuse=async(work:()=>Promise<unknown>,reason?:string)=>{const before=await f.snapshot();
  await expect(work()).rejects.toMatchObject({httpStatus:503,...(reason?{capturePrerequisite:reason}:{})});
  expect(await f.snapshot()).toBe(before);};
 const change=async(mutate:readonly string[],restore:readonly string[],reason?:string)=>{
  expect((await f.inspect()).scope).toEqual(f.binding);await f.ddl(...mutate);
  try{await refuse(()=>f.inspect(),reason);}finally{await f.ddl(...restore);}
  expect((await f.inspect()).scope).toEqual(f.binding);
 };

 for(const role of ['app','admin','financial'] as const)it('actual '+role+' preflight leaves all money/ledgers/catalog/sequence values unchanged',()=>start(async()=>{
  expect(await f.profilePeers[role].verify()).toBe(f.identities[role].pid);const before=await f.snapshot(),r=await f.inspect(role);
  expect(r.scope).toEqual(f.binding);expect(r.flowSequenceOid).toMatch(/^[1-9]\d*$/u);expect(r.outboxSequenceOid).toMatch(/^[1-9]\d*$/u);
  expect(await f.snapshot()).toBe(before);
 }),5000);
 for(const role of ['app','admin','financial'] as const)it('actual '+role+' allocated phase requires both real nextval locks and still writes no money row',()=>start(async()=>{
  const data=await f.dataSnapshot();await f.profilePeers[role].db.transaction(async actual=>{
   const tx=actual as unknown as DbClient;await assertRechargeRefundCaptureWritePrerequisitesTx(tx,role);
   const [ids]=await tx.execute<{flow:number;outbox:number}>(sql`SELECT pg_catalog.nextval('public.capital_flow_id_seq'::regclass)::integer AS flow,
    pg_catalog.nextval('public.store_order_outbox_id_seq'::regclass)::integer AS outbox`);
   expect(ids.flow).toBeGreaterThan(0);expect(ids.outbox).toBeGreaterThan(0);
   expect((await assertRechargeRefundCaptureWritePrerequisitesTx(tx,role,'allocated')).scope).toEqual(f.binding);
  });expect(await f.dataSnapshot()).toBe(data);
 }),5000);
 it('does not treat the allocated phase string as proof of either sequence lock',()=>start(async()=>{
  await refuse(()=>f.inspect('admin','allocated'),'allocated_ready');
 }),5000);
 it('rejects exactly-one allocated sequence instead of trusting a phase flag',()=>start(async()=>{
  const data=await f.dataSnapshot();await expect(f.profilePeers.admin.db.transaction(async actual=>{
   const tx=actual as unknown as DbClient;await assertRechargeRefundCaptureWritePrerequisitesTx(tx,'admin');
   await tx.execute(sql`SELECT pg_catalog.nextval('public.capital_flow_id_seq'::regclass)`);
   await assertRechargeRefundCaptureWritePrerequisitesTx(tx,'admin','allocated');
  })).rejects.toMatchObject({httpStatus:503,capturePrerequisite:'allocated_ready'});expect(await f.dataSnapshot()).toBe(data);
 }),5000);
 it('refuses root, owner execution, wrong actual role and Manager without changing money or catalog',()=>start(async()=>{
  await refuse(()=>assertRechargeRefundCaptureWritePrerequisitesTx(f.profilePeers.admin.db,'admin'),'transaction');
  await refuse(()=>f.maintenanceDb.transaction(async actual=>{const tx=actual as unknown as DbClient;
   await tx.execute(sql`SET LOCAL statement_timeout='5000ms'`);await tx.execute(sql`SET LOCAL lock_timeout='1000ms'`);
   await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5000ms'`);
   return assertRechargeRefundCaptureWritePrerequisitesTx(tx,'admin');
  }));
  for(const db of [f.profilePeers.financial.db,f.profilePeers.manager.db])
   await refuse(()=>db.transaction(tx=>assertRechargeRefundCaptureWritePrerequisitesTx(tx as unknown as DbClient,'admin')));
 }),5000);
 it('refuses read-only/RR mode and unbounded or substituted role contexts without resetting them',()=>start(async()=>{
  await refuse(()=>f.profilePeers.admin.db.transaction(tx=>assertRechargeRefundCaptureWritePrerequisitesTx(tx as unknown as DbClient,'admin'),
   {isolationLevel:'repeatable read',accessMode:'read only'}),'context');
  await refuse(()=>f.profilePeers.admin.db.transaction(async actual=>{const tx=actual as unknown as DbClient;
   await tx.execute(sql`SET LOCAL lock_timeout='0'`);return assertRechargeRefundCaptureWritePrerequisitesTx(tx,'admin');}),'context');
  await refuse(()=>f.profilePeers.admin.db.transaction(async actual=>{const tx=actual as unknown as DbClient;
   await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(f.binding.admin)}`);return assertRechargeRefundCaptureWritePrerequisitesTx(tx,'admin');}),'context');
  await refuse(()=>f.profilePeers.admin.db.transaction(async actual=>{const tx=actual as unknown as DbClient;
   await tx.execute(sql`SET LOCAL search_path=public,pg_catalog,pg_temp`);return assertRechargeRefundCaptureWritePrerequisitesTx(tx,'admin');}),'context');
 }),5000);

 for(const [name,mutate,restore,reason] of [
  ['extra recharge column',['ALTER TABLE public.user_recharge ADD COLUMN capture_unknown text'],['ALTER TABLE public.user_recharge DROP COLUMN capture_unknown'],'columns_ready'],
  ['generated extra outbox column',['ALTER TABLE public.store_order_outbox ADD COLUMN capture_unknown integer GENERATED ALWAYS AS (available_time+1) STORED'],['ALTER TABLE public.store_order_outbox DROP COLUMN capture_unknown'],'columns_ready'],
  ['recharge refund default',['ALTER TABLE public.user_recharge ALTER COLUMN refund_price SET DEFAULT 1.00'],['ALTER TABLE public.user_recharge ALTER COLUMN refund_price SET DEFAULT 0.00'],undefined],
  ['outbox status default',["ALTER TABLE public.store_order_outbox ALTER COLUMN status SET DEFAULT 'FAILED'"],["ALTER TABLE public.store_order_outbox ALTER COLUMN status SET DEFAULT 'PENDING'"],'columns_ready'],
  ['outbox lease token width',['ALTER TABLE public.store_order_outbox ALTER COLUMN lease_token TYPE varchar(37)'],['ALTER TABLE public.store_order_outbox ALTER COLUMN lease_token TYPE varchar(36)'],'columns_ready'],
  ['cash flow number capacity',['ALTER TABLE public.capital_flow ALTER COLUMN flow_id TYPE varchar(33)'],['ALTER TABLE public.capital_flow ALTER COLUMN flow_id TYPE varchar(32)'],undefined],
  ['unreviewed simple flow index',['CREATE INDEX capture_unknown ON public.capital_flow(uid)'],['DROP INDEX public.capture_unknown'],'indexes_ready'],
  ['unreviewed expression outbox index',['CREATE INDEX capture_unknown ON public.store_order_outbox(lower(event_key))'],['DROP INDEX public.capture_unknown'],'indexes_ready'],
  ['unreviewed partial recharge index',['CREATE INDEX capture_unknown ON public.user_recharge(refund_price) WHERE refund_price>0'],['DROP INDEX public.capture_unknown'],'indexes_ready'],
  ['missing known recharge index',['DROP INDEX public.ur_uid'],['CREATE INDEX ur_uid ON public.user_recharge(uid)'],'indexes_ready'],
  ['narrowed known outbox predicate',['DROP INDEX public.soob_dispatch_ready',"CREATE INDEX soob_dispatch_ready ON public.store_order_outbox(available_time,id) WHERE status='PENDING'"],['DROP INDEX public.soob_dispatch_ready',"CREATE INDEX soob_dispatch_ready ON public.store_order_outbox(available_time,id) WHERE status IN('PENDING','FAILED')"],'indexes_ready'],
  ['nondefault recharge unique opclass',['DROP INDEX public.ur_order_id_idx','CREATE UNIQUE INDEX ur_order_id_idx ON public.user_recharge(order_id varchar_pattern_ops)'],['DROP INDEX public.ur_order_id_idx','CREATE UNIQUE INDEX ur_order_id_idx ON public.user_recharge(order_id)'],'indexes_ready'],
  ['partial cash event unique index',['DROP INDEX public.cf_event_key_uq','CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow(event_key) WHERE event_key IS NOT NULL'],['DROP INDEX public.cf_event_key_uq','CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow(event_key)'],undefined],
  ['unreviewed INCLUDE',['DROP INDEX public.soob_aggregate','CREATE INDEX soob_aggregate ON public.store_order_outbox(aggregate_type,aggregate_id) INCLUDE(status)'],['DROP INDEX public.soob_aggregate','CREATE INDEX soob_aggregate ON public.store_order_outbox(aggregate_type,aggregate_id)'],'indexes_ready'],
  ['unreviewed outbox CHECK',['ALTER TABLE public.store_order_outbox ADD CONSTRAINT capture_unknown CHECK(id>0) NOT VALID'],['ALTER TABLE public.store_order_outbox DROP CONSTRAINT capture_unknown'],'constraints_ready'],
  ['unreviewed recharge CHECK',['ALTER TABLE public.user_recharge ADD CONSTRAINT capture_unknown CHECK(refund_price>=0) NOT VALID'],['ALTER TABLE public.user_recharge DROP CONSTRAINT capture_unknown'],'constraints_ready'],
  ['unvalidated known time CHECK',['ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_time_ck','ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_time_ck CHECK(available_time>=0 AND lease_until>=0) NOT VALID'],['ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_time_ck','ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_time_ck CHECK(available_time>=0 AND lease_until>=0)'],'constraints_ready'],
  ['reordered known time CHECK/conkey',['ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_time_ck','ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_time_ck CHECK(lease_until>=0 AND available_time>=0)'],['ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_time_ck','ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_time_ck CHECK(available_time>=0 AND lease_until>=0)'],'constraints_ready'],
  ['outbox outgoing FK',['ALTER TABLE public.store_order_outbox ADD CONSTRAINT capture_unknown FOREIGN KEY(aggregate_id) REFERENCES public."user"(uid) NOT VALID'],['ALTER TABLE public.store_order_outbox DROP CONSTRAINT capture_unknown'],'constraints_ready'],
  ['recharge SERIAL owner graph',['ALTER SEQUENCE public.user_recharge_id_seq OWNED BY NONE'],['ALTER SEQUENCE public.user_recharge_id_seq OWNED BY public.user_recharge.id'],'serial_ready'],
  ['outbox SERIAL cache',['ALTER SEQUENCE public.store_order_outbox_id_seq CACHE 2'],['ALTER SEQUENCE public.store_order_outbox_id_seq CACHE 1'],undefined],
 ] as const)it('refuses actual '+name+' without adopting or repairing drift',()=>start(()=>change(mutate,restore,reason)),5000);

 for(const table of ['user_recharge','store_order_outbox'])it('rejects an actual '+table+' write trigger while seven-field metadata remains ready',()=>start(async()=>{
  expect((await f.inspect()).scope).toEqual(f.binding);
  await f.ddl(triggerFunction,'REVOKE ALL ON FUNCTION public.capture_write_probe_v1() FROM PUBLIC',
   `CREATE TRIGGER capture_unknown BEFORE ${table==='user_recharge'?'UPDATE':'INSERT'} ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.capture_write_probe_v1()`);
  try{
   expect(await f.profilePeers.admin.db.transaction(tx=>rechargeRefundNoticeCommissionedTx(tx))).toBe(true);
   await refuse(()=>f.inspect(),'relations_ready');
  }finally{await f.ddl(`DROP TRIGGER capture_unknown ON public.${table}`,'DROP FUNCTION public.capture_write_probe_v1()');}
  expect((await f.inspect()).scope).toEqual(f.binding);
 }),5000);
 it('rejects a rewrite rule instead of assuming ordinary heap means no write effects',()=>start(async()=>{
  await change(['CREATE RULE capture_unknown AS ON INSERT TO public.store_order_outbox DO ALSO NOTIFY capture_catalog_probe'],
   ['DROP RULE capture_unknown ON public.store_order_outbox']);
 }),5000);
 it('prevents or detects a real pg_temp ORM shadow without granting TEMP',()=>start(async()=>{
  const data=await f.dataSnapshot();let outcome='';
  await f.profilePeers.admin.withPeer(async db=>{
   const [r]=await db.execute<{allowed:boolean}>(sql`SELECT pg_catalog.has_database_privilege(current_user,current_database(),'TEMP') AS allowed`);
   if(r.allowed){await expect(db.transaction(async actual=>{const tx=actual as unknown as DbClient;
    await tx.execute(sql.raw(NOTICE_MAINTENANCE_BUDGET_SQL));
    expect((await assertRechargeRefundCaptureWritePrerequisitesTx(tx,'admin')).scope).toEqual(f.binding);
    await tx.execute(sql`CREATE TEMP TABLE user_recharge(id integer) ON COMMIT DROP`);await tx.execute(sql`SET LOCAL search_path=pg_temp,public`);
    const [shadow]=await tx.execute<{actual:boolean}>(sql`SELECT pg_catalog.to_regclass('user_recharge')<>pg_catalog.to_regclass('public.user_recharge') AS actual`);
    expect(shadow.actual).toBe(true);
    await assertRechargeRefundCaptureWritePrerequisitesTx(tx,'admin');})).rejects.toMatchObject({httpStatus:503,capturePrerequisite:'context'});outcome='created-shadow-refused';}
   else{let error:unknown;try{await db.transaction(async tx=>{await tx.execute(sql.raw(NOTICE_MAINTENANCE_BUDGET_SQL));
    await tx.execute(sql`CREATE TEMP TABLE user_recharge(id integer) ON COMMIT DROP`);});}catch(e){error=e;}
    expect(state(error)).toBe('42501');outcome='temp-creation-forbidden';}
  });expect(await f.dataSnapshot()).toBe(data);console.info('RECHARGE_CAPTURE_TEMP '+outcome);
 }),5000);
 it('real table ROWEX prevents late CREATE TRIGGER, then a fresh TX refuses the committed drift',()=>start(async()=>{
  await f.ddl(triggerFunction,'REVOKE ALL ON FUNCTION public.capture_write_probe_v1() FROM PUBLIC');
  const create='CREATE TRIGGER capture_unknown BEFORE INSERT ON public.store_order_outbox FOR EACH ROW EXECUTE FUNCTION public.capture_write_probe_v1()';
  try{
   await f.profilePeers.admin.db.transaction(async actual=>{const tx=actual as unknown as DbClient;
    expect((await assertRechargeRefundCaptureWritePrerequisitesTx(tx,'admin')).scope).toEqual(f.binding);
    let error:unknown;try{await f.ddl(create);}catch(e){error=e;}expect(state(error)).toBe('55P03');
    expect((await assertRechargeRefundCaptureWritePrerequisitesTx(tx,'admin')).scope).toEqual(f.binding);
   });await f.ddl(create);await refuse(()=>f.inspect(),'relations_ready');
  }finally{await f.ddl('DROP TRIGGER IF EXISTS capture_unknown ON public.store_order_outbox','DROP FUNCTION public.capture_write_probe_v1()');}
 }),5000);
 it('real table ROWEX prevents late index replacement, then fresh committed drift is refused',()=>start(async()=>{
  const create="CREATE INDEX soob_dispatch_ready ON public.store_order_outbox(available_time,id) WHERE status IN('PENDING','FAILED')";
  let removed=false;try{
   await f.profilePeers.admin.db.transaction(async actual=>{const tx=actual as unknown as DbClient;
    await assertRechargeRefundCaptureWritePrerequisitesTx(tx,'admin');let error:unknown;
    try{await f.ddl('DROP INDEX public.soob_dispatch_ready');}catch(e){error=e;}expect(state(error)).toBe('55P03');
   });await f.ddl('DROP INDEX public.soob_dispatch_ready');removed=true;await refuse(()=>f.inspect(),'indexes_ready');
  }finally{if(removed)await f.ddl(create);}
 }),5000);
 for(const sequence of ['capital_flow','store_order_outbox'])it('actual '+sequence+' nextval lock prevents late SERIAL alteration',()=>start(async()=>{
  const data=await f.dataSnapshot();let changed=false;
  try{
   await f.profilePeers.admin.db.transaction(async actual=>{const tx=actual as unknown as DbClient;
    await assertRechargeRefundCaptureWritePrerequisitesTx(tx,'admin');
    await tx.execute(sql`SELECT pg_catalog.nextval('public.capital_flow_id_seq'::regclass),pg_catalog.nextval('public.store_order_outbox_id_seq'::regclass)`);
    await assertRechargeRefundCaptureWritePrerequisitesTx(tx,'admin','allocated');let error:unknown;
    try{await f.ddl(`ALTER SEQUENCE public.${sequence}_id_seq CACHE 2`);}catch(e){error=e;}
    expect(state(error)).toBe('55P03');
   });await f.ddl(`ALTER SEQUENCE public.${sequence}_id_seq CACHE 2`);changed=true;await refuse(()=>f.inspect());
  }finally{if(changed)await f.ddl(`ALTER SEQUENCE public.${sequence}_id_seq CACHE 1`);}
  expect(await f.dataSnapshot()).toBe(data);
 }),5000);
 it('creates no financial/notice rows, Queue messages or provider/network activity',()=>start(async()=>{
  expect(f.messages).toHaveLength(f.noticeQueueBaseline);expect(network).not.toHaveBeenCalled();
  const [r]=await f.profilePeers.admin.db.execute<{count:number}>(sql`SELECT
   (SELECT count(*) FROM public.recharge_refund_operation)+(SELECT count(*) FROM public.recharge_refund_result)
   +(SELECT count(*) FROM public.store_order_outbox WHERE event_type='recharge.refund.success.notice') AS count`);
  expect(Number(r.count)).toBe(0);
 }),5000);
});
