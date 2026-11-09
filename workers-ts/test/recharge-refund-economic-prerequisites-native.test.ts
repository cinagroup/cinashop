/** Actual LOGIN/catalog drift acceptance only; this is not a money author or
 * evidence that whole-profile maintenance meets the independent5s budget. */
import { sql } from 'drizzle-orm';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import type { DbClient } from '@/lib/di';
import { assertRechargeRefundEconomicPrerequisitesTx,assertRechargeRefundEconomicResolutionTx } from '@/services/payment/RechargeRefundEconomicPrerequisites';
import { rechargeRefundEconomicNativeFixture,type RechargeRefundEconomicNativeFixture } from './helpers/rechargeRefundEconomicNative';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual recharge economic catalog prerequisites without money writes',()=>{
 let f:RechargeRefundEconomicNativeFixture,setup:Promise<void>|undefined,pending:Promise<unknown>|undefined,busy=false;
 const start=<T>(run:()=>Promise<T>)=>{
  if(busy)throw Error('Previous economic catalog case still pending');busy=true;
  const work=run().finally(()=>{busy=false;});pending=work;void work.catch(()=>undefined);return work;
 };
 beforeAll(async()=>{setup=(async()=>{f=await rechargeRefundEconomicNativeFixture();})();await setup;},180000);
 afterAll(async()=>{try{if(setup)await Promise.allSettled([setup]);if(pending)await Promise.allSettled([pending]);}finally{await f?.close();}},30000);
 const refuse=async(run:()=>Promise<unknown>)=>{
  const before=await f.snapshot();await expect(run()).rejects.toMatchObject({httpStatus:503});expect(await f.snapshot()).toBe(before);
 };
 const change=async(mutate:string,restore:string,run:()=>Promise<unknown>=()=>f.inspect('admin'))=>{
  expect((await f.inspect('admin')).scope).toEqual(f.binding);
  await f.ddl(...mutate.split(';'));try{await refuse(run);}finally{await f.ddl(...restore.split(';'));}
  expect((await f.inspect('admin')).scope).toEqual(f.binding);
 };

 const sqlState=(error:unknown)=>{
  let current=error;
  for(let depth=0;depth<8&&current&&typeof current==='object';depth++){
   const e=current as {code?:unknown;cause?:unknown};if(typeof e.code==='string')return e.code;current=e.cause;
  }
  return undefined;
 };
 const late=async(label:'event-index'|'serial-owner',mutate:readonly string[],restore:readonly string[])=>{
  const before=await f.snapshot();let blocked=false,attempted=false;
  try{
   await f.profilePeers.admin.db.transaction(async actual=>{
    const tx=actual as unknown as DbClient;await assertRechargeRefundEconomicPrerequisitesTx(tx,'admin');
    attempted=true;
    try{await f.ddl(...mutate);}catch(error){if(sqlState(error)!=='55P03')throw error;blocked=true;}
    if(blocked){
     expect(await f.snapshot()).toBe(before);
     expect((await assertRechargeRefundEconomicPrerequisitesTx(tx,'admin')).scope).toEqual(f.binding);
    }else await refuse(()=>assertRechargeRefundEconomicPrerequisitesTx(tx,'admin'));
   });
   if(blocked){await f.ddl(...mutate);await refuse(()=>f.inspect('admin'));}
   console.info('RECHARGE_ECONOMIC_LATE_DDL '+label+':'+(blocked?'blocked-then-new-tx-refused':'same-rc-refused'));
  }finally{if(attempted)await f.ddl(...restore);}
 };

 for(const role of ['app','admin','financial'] as const)for(const mode of ['read','write'] as const)
  it('proves actual '+role+' '+mode+' context and leaves catalog/sequence values/money/ledgers byte-for-byte unchanged',()=>start(async()=>{
   const before=await f.snapshot(),r=await f.inspect(role,mode);
   expect(r.scope).toEqual(f.binding);expect(r.capitalFlowOid).toMatch(/^[1-9]\d*$/u);expect(r.capitalFlowSequenceOid).toMatch(/^[1-9]\d*$/u);
   expect(await f.snapshot()).toBe(before);
  }),5000);

 it('rejects a root DbClient before treating it as an owning transaction',()=>start(async()=>{
  await refuse(()=>assertRechargeRefundEconomicPrerequisitesTx(f.profilePeers.admin.db,'admin'));
 }),5000);
 it('rejects owner execution, a wrong actual runtime role and Manager',()=>start(async()=>{
  for(const [db,role] of [[f.maintenanceDb,'admin'],[f.profilePeers.financial.db,'admin'],[f.profilePeers.manager.db,'admin']] as const)
   await refuse(()=>db.transaction(tx=>assertRechargeRefundEconomicPrerequisitesTx(tx as unknown as DbClient,role)));
 }),5000);
 it('enforces both transaction modes without silently widening a read to a write',()=>start(async()=>{
  await refuse(()=>f.profilePeers.admin.db.transaction(tx=>assertRechargeRefundEconomicPrerequisitesTx(tx as unknown as DbClient,'admin','write'),
   {isolationLevel:'repeatable read',accessMode:'read only'}));
  await refuse(()=>f.profilePeers.admin.db.transaction(tx=>assertRechargeRefundEconomicPrerequisitesTx(tx as unknown as DbClient,'admin','read'),
   {isolationLevel:'read committed',accessMode:'read write'}));
 }),5000);

 it('refuses same-identity SET ROLE and an unbounded lock context without resetting either',()=>start(async()=>{
  await refuse(()=>f.profilePeers.admin.db.transaction(async actual=>{
   const tx=actual as unknown as DbClient;await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(f.binding.admin)}`);
   return assertRechargeRefundEconomicPrerequisitesTx(tx,'admin');
  }));
  await refuse(()=>f.profilePeers.admin.db.transaction(async actual=>{
   const tx=actual as unknown as DbClient;await tx.execute(sql`SET LOCAL lock_timeout='0'`);
   return assertRechargeRefundEconomicPrerequisitesTx(tx,'admin');
  }));
 }),5000);

 it('refuses a missing event unique index without installing it',()=>start(async()=>{
  await change('DROP INDEX public.cf_event_key_uq','CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow(event_key)');
 }),5000);
 it('refuses a same-name nonunique event index instead of repairing it',()=>start(async()=>{
  await change('DROP INDEX public.cf_event_key_uq;CREATE INDEX cf_event_key_uq ON public.capital_flow(event_key)',
   'DROP INDEX public.cf_event_key_uq;CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow(event_key)');
 }),5000);
 it('refuses a same-name INCLUDE index',()=>start(async()=>{
  await change('DROP INDEX public.cf_event_key_uq;CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow(event_key) INCLUDE(id)',
   'DROP INDEX public.cf_event_key_uq;CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow(event_key)');
 }),5000);
 it('refuses a same-name event index using a nondefault operator class',()=>start(async()=>{
  await change('DROP INDEX public.cf_event_key_uq;CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow(event_key varchar_pattern_ops)',
   'DROP INDEX public.cf_event_key_uq;CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow(event_key)');
 }),5000);
 it('proves real lock protection or same-RC freshness for a late partial-index replacement',()=>start(async()=>{
  await late('event-index',['DROP INDEX public.cf_event_key_uq',
   'CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow(event_key) WHERE event_key IS NOT NULL'],
   ['DROP INDEX public.cf_event_key_uq','CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow(event_key)']);
 }),5000);
 it('refuses numeric scale drift',()=>start(async()=>{
  await change('ALTER TABLE public.capital_flow ALTER COLUMN price TYPE numeric(12,3)',
   'ALTER TABLE public.capital_flow ALTER COLUMN price TYPE numeric(12,2)');
 }),5000);
 it('refuses a changed constant default',()=>start(async()=>{
  await change('ALTER TABLE public.capital_flow ALTER COLUMN price SET DEFAULT 1.00',
   'ALTER TABLE public.capital_flow ALTER COLUMN price SET DEFAULT 0.00');
 }),5000);
 it('refuses an unreviewed added column',()=>start(async()=>{
  await change('ALTER TABLE public.capital_flow ADD COLUMN economic_unreviewed text',
   'ALTER TABLE public.capital_flow DROP COLUMN economic_unreviewed');
 }),5000);
 it('refuses RLS even on an otherwise empty physical cash-flow table',()=>start(async()=>{
  await change('ALTER TABLE public.capital_flow ENABLE ROW LEVEL SECURITY','ALTER TABLE public.capital_flow DISABLE ROW LEVEL SECURITY');
 }),5000);
 it('refuses a new trigger even when its body appears harmless',()=>start(async()=>{
  await f.ddl('CREATE FUNCTION public.economic_probe_trigger() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW;END$$');
  try{await change('CREATE TRIGGER economic_probe BEFORE INSERT ON public.capital_flow FOR EACH ROW EXECUTE FUNCTION public.economic_probe_trigger()',
   'DROP TRIGGER economic_probe ON public.capital_flow');}finally{await f.ddl('DROP FUNCTION public.economic_probe_trigger()');}
 }),5000);
 it('refuses an INSERT rewrite rule instead of following it',()=>start(async()=>{
  await change('CREATE RULE economic_probe_rule AS ON INSERT TO public.capital_flow DO INSTEAD NOTHING',
   'DROP RULE economic_probe_rule ON public.capital_flow');
 }),5000);
 it('refuses a cash-flow owner different from the bound maintenance role',()=>start(async()=>{
  await f.ddl(sql`ALTER TABLE public.capital_flow OWNER TO ${sql.identifier(f.binding.manager)}`);
  try{await refuse(()=>f.inspect('admin'));}finally{await f.ddl(sql`ALTER TABLE public.capital_flow OWNER TO ${sql.identifier(f.binding.maintenance)}`);}
 }),5000);
 it('refuses a serial default redirected to another actual sequence',()=>start(async()=>{
  await change("ALTER TABLE public.capital_flow ALTER COLUMN id SET DEFAULT nextval('public.user_bill_id_seq'::regclass)",
   "ALTER TABLE public.capital_flow ALTER COLUMN id SET DEFAULT nextval('public.capital_flow_id_seq'::regclass)");
 }),5000);
 it('proves real lock protection or same-RC freshness for late serial ownership drift',()=>start(async()=>{
  await late('serial-owner',['ALTER SEQUENCE public.capital_flow_id_seq OWNED BY NONE'],
   ['ALTER SEQUENCE public.capital_flow_id_seq OWNED BY public.capital_flow.id']);
 }),5000);
 it('refuses a changed owned sequence generation contract',()=>start(async()=>{
  await change('ALTER SEQUENCE public.capital_flow_id_seq CACHE 2','ALTER SEQUENCE public.capital_flow_id_seq CACHE 1');
 }),5000);
 it('rereads a late direct sequence USAGE revocation in the same actual RC transaction',()=>start(async()=>{
  try{
   await f.profilePeers.admin.db.transaction(async actual=>{
    const tx=actual as unknown as DbClient;await assertRechargeRefundEconomicPrerequisitesTx(tx,'admin');
    await f.ddl(sql`REVOKE USAGE ON SEQUENCE public.capital_flow_id_seq FROM ${sql.identifier(f.binding.admin)}`);
    await refuse(()=>assertRechargeRefundEconomicPrerequisitesTx(tx,'admin'));
   });
  }finally{await f.ddl(sql`GRANT USAGE ON SEQUENCE public.capital_flow_id_seq TO ${sql.identifier(f.binding.admin)}`);}
 }),5000);
 for(const sequence of ['capital_flow_id_seq','user_bill_id_seq','store_order_outbox_id_seq'] as const)
  it('requires actual nondelegable '+sequence+' USAGE for a write but retains read-only catalog inspection',()=>start(async()=>{
   await f.ddl(sql`REVOKE USAGE ON SEQUENCE public.${sql.identifier(sequence)} FROM ${sql.identifier(f.binding.admin)}`);
   try{
    await refuse(()=>f.inspect('admin','write'));expect((await f.inspect('admin','read')).scope).toEqual(f.binding);
   }finally{await f.ddl(sql`GRANT USAGE ON SEQUENCE public.${sql.identifier(sequence)} TO ${sql.identifier(f.binding.admin)}`);}
  }),5000);
 it('requires actual capital-flow INSERT only for write mode and does not grant it on error',()=>start(async()=>{
  await f.ddl(sql`REVOKE INSERT ON TABLE public.capital_flow FROM ${sql.identifier(f.binding.admin)}`);
  try{await refuse(()=>f.inspect('admin'));expect((await f.inspect('admin','read')).scope).toEqual(f.binding);}
  finally{await f.ddl(sql`GRANT INSERT ON TABLE public.capital_flow TO ${sql.identifier(f.binding.admin)}`);}
 }),5000);

 for(const name of ['user','user_recharge','user_bill','capital_flow','store_order_outbox'] as const)
  it('refuses actual late implicit pg_temp '+name+' resolution while current_schema remains public',()=>start(async()=>{
   const peer=f.profilePeers.admin;
   // No TEMP grant is added to make this pass. This owned fixture's existing
   // permission must suffice; otherwise keep the real failure for review.
   await peer.db.transaction(async actual=>{
    const tx=actual as unknown as DbClient;await assertRechargeRefundEconomicPrerequisitesTx(tx,'admin');
    await tx.execute(sql`CREATE TEMP TABLE ${sql.identifier(name)}(id integer) ON COMMIT DROP`);
    await tx.execute(sql`SET LOCAL search_path=public`);
    const [r]=await tx.execute<{schema:string;shadow:boolean}>(sql`SELECT pg_catalog.current_schema() AS schema,
     pg_catalog.to_regclass(${name})=pg_catalog.to_regclass(${'pg_temp.'+name}) AS shadow`);
    expect(r).toEqual({schema:'public',shadow:true});
    const before=await f.snapshot();await expect(assertRechargeRefundEconomicResolutionTx(tx)).rejects.toMatchObject({httpStatus:503});
    // The main guard may additionally refuse the runtime-owned temp relation.
    await expect(assertRechargeRefundEconomicPrerequisitesTx(tx,'admin')).rejects.toMatchObject({httpStatus:503});
    expect(await f.snapshot()).toBe(before);
   });
  }),5000);
});
