/** Owned catalog-only fixture. Existing actual five-role commissioning and
 * new notice setup are real; neither has been validated by this draft. No paid
 * recharge, provider result, hold, capture or notice row is produced in setup. */
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { assertRechargeRefundCaptureWritePrerequisitesTx } from '@/services/payment/RechargeRefundCaptureWritePrerequisites';
import { rechargeRefundNoticeStorageRuntimeFixture } from './rechargeRefundNoticeStorageRuntimeNative';

export async function rechargeCaptureWritePrerequisitesFixture(){
 const f=await rechargeRefundNoticeStorageRuntimeFixture();
 try{
  const [i]=await f.maintenanceDb.execute<{present:boolean}>(sql`SELECT pg_catalog.to_regclass('public.cf_event_key_uq') IS NOT NULL AS present`);
  if(!i)throw Error('Owned capture index prerequisite unavailable');
  // Same explicit known catalog-fixture stage as source26/27: absent only.
  // A present drifted index is never repaired; no runtime DDL or new GRANT.
  if(!i.present)await f.maintenanceDb.transaction(async tx=>{
   await tx.execute(sql`SET LOCAL statement_timeout='5000ms'`);await tx.execute(sql`SET LOCAL lock_timeout='1000ms'`);
   await tx.execute(sql`CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow USING btree(event_key)`);
  });
  for(const role of ['app','admin','financial','manager'] as const){
   const db=f.profilePeers[role].db;
   const settings=async()=>{const [r]=await db.execute<{statement:number;lock:number;idle:number}>(sql`SELECT
    (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='statement_timeout') AS statement,
    (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='lock_timeout') AS lock,
    (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout') AS idle`);return r;};
   const before=await settings();
   await db.execute(sql`SELECT pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',false),
    pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',false),
    pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',false)`);
   const after=await settings();
   if(!before||!after||after.statement!==Math.min(before.statement||5000,5000)||after.lock!==Math.min(before.lock||1000,1000)
    ||after.idle!==Math.min(before.idle||5000,5000))throw Error('Capture fixture LOGIN caps did not tighten exactly');
   console.info('RECHARGE_CAPTURE_CONTEXT '+JSON.stringify({role,before,after}));
  }
  const inspect=(role:'app'|'admin'|'financial'='admin',phase:'preflight'|'allocated'='preflight')=>
   f.profilePeers[role].db.transaction(tx=>assertRechargeRefundCaptureWritePrerequisitesTx(tx as unknown as DbClient,role,phase),
    {isolationLevel:'read committed',accessMode:'read write'});
  const ddl=(...commands:string[])=>f.withMaintenancePeer(async peer=>peer.transaction(async tx=>{
   await tx.execute(sql`SET LOCAL statement_timeout='5000ms'`);await tx.execute(sql`SET LOCAL lock_timeout='1000ms'`);
   await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5000ms'`);
   for(const command of commands)await tx.execute(sql.raw(command));
  }));
  async function dataSnapshot(){
   const [r]=await f.maintenanceDb.execute<{value:unknown}>(sql`SELECT jsonb_build_object(
    'wallet',(SELECT jsonb_agg(jsonb_build_array(uid,now_money::text,xmin::text) ORDER BY uid) FROM public."user"),
    'recharge',(SELECT jsonb_agg(jsonb_build_array(id,uid,price::text,give_price::text,refund_price::text,xmin::text) ORDER BY id) FROM public.user_recharge),
    'bills',(SELECT jsonb_agg(jsonb_build_array(id,uid,event_key,number::text,balance::text,xmin::text) ORDER BY id) FROM public.user_bill),
    'flow',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.capital_flow t),
    'outbox',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.store_order_outbox t),
    'operation',(SELECT jsonb_agg(jsonb_build_array(operation_id,signature,xmin::text) ORDER BY operation_id) FROM public.recharge_refund_operation),
    'state',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY operation_id) FROM public.recharge_refund_state t),
    'attempt',(SELECT jsonb_agg(jsonb_build_array(attempt_id,signature,xmin::text) ORDER BY attempt_id) FROM public.recharge_refund_attempt),
    'result',(SELECT jsonb_agg(jsonb_build_array(result_id,signature,xmin::text) ORDER BY result_id) FROM public.recharge_refund_result)) AS value`);
   return JSON.stringify(r.value);
  }
  async function snapshot(){
   const [r]=await f.maintenanceDb.execute<{value:unknown}>(sql`SELECT jsonb_build_object(
    'relations',(SELECT jsonb_agg(jsonb_build_array(c.oid::text,c.relname,c.relowner::text,c.relacl,c.reloptions,c.relchecks) ORDER BY c.relname)
     FROM pg_catalog.pg_class c WHERE c.oid IN('public.user_recharge'::regclass,'public.capital_flow'::regclass,'public.store_order_outbox'::regclass)),
    'columns',(SELECT jsonb_agg(jsonb_build_array(a.attrelid::text,a.attnum,a.attname,a.atttypid::text,a.atttypmod,a.attnotnull,a.attacl,
     a.attgenerated,a.attidentity,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attrelid,a.attnum) FROM pg_catalog.pg_attribute a
     LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
     WHERE a.attrelid IN('public.user_recharge'::regclass,'public.capital_flow'::regclass,'public.store_order_outbox'::regclass) AND a.attnum>0),
    'constraints',(SELECT jsonb_agg(jsonb_build_array(k.oid::text,k.xmin::text,k.conname,k.conkey,pg_get_constraintdef(k.oid,false)) ORDER BY k.oid)
     FROM pg_catalog.pg_constraint k WHERE k.conrelid IN('public.user_recharge'::regclass,'public.capital_flow'::regclass,'public.store_order_outbox'::regclass)),
    'indexes',(SELECT jsonb_agg(jsonb_build_array(c.oid::text,c.relname,c.relowner::text,c.relacl,to_jsonb(i),pg_get_indexdef(i.indexrelid)) ORDER BY c.relname)
     FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
     WHERE i.indrelid IN('public.user_recharge'::regclass,'public.capital_flow'::regclass,'public.store_order_outbox'::regclass)),
    'sequences',(SELECT jsonb_agg(jsonb_build_array(c.oid::text,c.relname,c.relowner::text,c.relacl,to_jsonb(s)) ORDER BY c.relname)
     FROM pg_catalog.pg_sequence s JOIN pg_catalog.pg_class c ON c.oid=s.seqrelid
     WHERE c.oid IN('public.user_recharge_id_seq'::regclass,'public.capital_flow_id_seq'::regclass,'public.store_order_outbox_id_seq'::regclass)),
    'values',jsonb_build_array((SELECT jsonb_build_array(last_value,is_called) FROM public.user_recharge_id_seq),
     (SELECT jsonb_build_array(last_value,is_called) FROM public.capital_flow_id_seq),(SELECT jsonb_build_array(last_value,is_called) FROM public.store_order_outbox_id_seq))) AS value`);
   return JSON.stringify({catalog:r.value,data:await dataSnapshot()});
  }
  return {...f,inspect,ddl,snapshot,dataSnapshot};
 }catch(error){await f.close();throw error;}
}
export type RechargeCaptureWritePrerequisitesFixture=Awaited<ReturnType<typeof rechargeCaptureWritePrerequisitesFixture>>;
