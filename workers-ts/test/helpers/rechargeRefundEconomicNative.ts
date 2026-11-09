/** Owned catalog-only acceptance. All three runtime LOGINs and the complete
 * predecessor/successor come from the established formal fixture. The known
 * cf_event_key_uq fixture prerequisite is staged by owner, never repaired by a
 * runtime guard. No payment/provider/money/result/notice truth is produced. */
import { sql,type SQL } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import type { RechargeRefundRuntimeRole } from '@/migrations/rechargeRefund';
import { assertRechargeRefundEconomicPrerequisitesTx } from '@/services/payment/RechargeRefundEconomicPrerequisites';
import { rechargeRefundRuntimeProfileFixture } from './rechargeRefundRuntimeProfileNative';

export async function rechargeRefundEconomicNativeFixture(){
 const f=await rechargeRefundRuntimeProfileFixture();
 try{
  await f.commission();
  // The complete legacy factory has different connection defaults from the
  // standalone refund fixture (including disabled idle timeout). Tighten only
  // these actual test LOGIN sessions; the runtime guard never resets/widens
  // settings, and no stricter existing nonzero cap is increased here.
  for(const role of ['app','admin','financial','manager'] as const){
   const db=f.profilePeers[role].db;
   const context=async()=>{
    const [r]=await db.execute<{role:string;statement:number;lock:number;idle:number}>(sql`SELECT
     pg_catalog.current_setting('role') AS role,
     (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='statement_timeout') AS statement,
     (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='lock_timeout') AS lock,
     (SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout') AS idle`);
    if(!r)throw Error('Actual economic LOGIN context unavailable');return r;
   };
   const before=await context();
   await db.execute(sql`SELECT
    pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',false),
    pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',false),
    pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::integer FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',false)`);
   const after=await context();
   if(after.role!=='none'||after.statement!==Math.min(before.statement||5000,5000)
    ||after.lock!==Math.min(before.lock||1000,1000)||after.idle!==Math.min(before.idle||5000,5000))
    throw Error('Actual economic LOGIN context did not tighten exactly');
   console.info('RECHARGE_ECONOMIC_CONTEXT '+JSON.stringify({role,before,after}));
  }
  const ddl=(...statements:Array<string|SQL>)=>f.maintenanceDb.transaction(async actual=>{
   await actual.execute(sql`SET LOCAL lock_timeout='1000ms'`);
   await actual.execute(sql`SET LOCAL statement_timeout='5000ms'`);
   for(const statement of statements)await actual.execute(typeof statement==='string'?sql.raw(statement):statement);
  });
  const [index]=await f.maintenanceDb.execute<{present:boolean}>(sql`SELECT pg_catalog.to_regclass('public.cf_event_key_uq') IS NOT NULL AS present`);
  if(!index)throw Error('Owned cash-flow catalog unavailable');
  // A missing known model index is a fixture prerequisite, not authority to
  // repair a drifted existing object or evidence of a production upgrade.
  if(!index.present)await ddl('CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow USING btree(event_key)');
  const inspect=(role:RechargeRefundRuntimeRole,mode:'read'|'write'='write')=>
   f.profilePeers[role].db.transaction(tx=>assertRechargeRefundEconomicPrerequisitesTx(tx as unknown as DbClient,role,mode),
    {isolationLevel:mode==='read'?'repeatable read':'read committed',accessMode:mode==='read'?'read only':'read write'});
  return{...f,inspect,ddl,snapshot:()=>rechargeRefundEconomicSnapshot(f.maintenanceDb)};
 }catch(error){await f.close();throw error;}
}
export type RechargeRefundEconomicNativeFixture=Awaited<ReturnType<typeof rechargeRefundEconomicNativeFixture>>;

/** Focused catalog/business xmin/ACL/default/index/dependency evidence. The
 * owned snapshot additionally reads last_value/is_called of the three serial
 * sequences; the guarded runtime code never reads or advances those values. */
export async function rechargeRefundEconomicSnapshot(db:DbClient){
 const [row]=await db.execute<{value:unknown}>(sql`WITH target AS(SELECT c.oid FROM pg_catalog.pg_class c
  WHERE c.relnamespace='public'::regnamespace AND c.relname IN('user','user_recharge','user_bill','capital_flow','store_order_outbox')),
  classes AS(SELECT oid FROM target UNION SELECT indexrelid FROM pg_catalog.pg_index WHERE indrelid IN(SELECT oid FROM target)
   UNION SELECT c.oid FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace
    AND c.relname IN('capital_flow_id_seq','user_bill_id_seq','store_order_outbox_id_seq'))
  SELECT jsonb_build_object(
   'class',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(c),c.xmin::text) ORDER BY c.oid) FROM pg_catalog.pg_class c WHERE c.oid IN(SELECT oid FROM classes)),
   'column',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(a),a.xmin::text) ORDER BY a.attrelid,a.attnum) FROM pg_catalog.pg_attribute a WHERE a.attrelid IN(SELECT oid FROM classes)),
   'default',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(d),d.xmin::text) ORDER BY d.oid) FROM pg_catalog.pg_attrdef d WHERE d.adrelid IN(SELECT oid FROM target)),
   'index',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(i),i.xmin::text) ORDER BY i.indexrelid) FROM pg_catalog.pg_index i WHERE i.indrelid IN(SELECT oid FROM target)),
   'sequence_values',jsonb_build_array(
    (SELECT jsonb_build_array('capital_flow_id_seq',last_value::text,is_called) FROM public.capital_flow_id_seq),
    (SELECT jsonb_build_array('user_bill_id_seq',last_value::text,is_called) FROM public.user_bill_id_seq),
    (SELECT jsonb_build_array('store_order_outbox_id_seq',last_value::text,is_called) FROM public.store_order_outbox_id_seq)),
   'sequence',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(s),s.xmin::text) ORDER BY s.seqrelid) FROM pg_catalog.pg_sequence s WHERE s.seqrelid IN(SELECT oid FROM classes)),
   'constraint',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(k),k.xmin::text) ORDER BY k.oid) FROM pg_catalog.pg_constraint k WHERE k.conrelid IN(SELECT oid FROM target)),
   'trigger',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY t.oid) FROM pg_catalog.pg_trigger t WHERE t.tgrelid IN(SELECT oid FROM target)),
   'dependency',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype)
    FROM pg_catalog.pg_depend d WHERE d.objid IN(SELECT oid FROM classes) OR d.refobjid IN(SELECT oid FROM classes)),
   'flow',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),xmin::text) ORDER BY id) FROM public.capital_flow t),
   'wallet',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),xmin::text) ORDER BY uid) FROM public."user" t),
   'recharge',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),xmin::text) ORDER BY id) FROM public.user_recharge t),
   'bill',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),xmin::text) ORDER BY id) FROM public.user_bill t),
   'outbox',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),xmin::text) ORDER BY id) FROM public.store_order_outbox t),
   'operation',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),xmin::text) ORDER BY operation_id) FROM public.recharge_refund_operation t),
   'state',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),xmin::text) ORDER BY operation_id) FROM public.recharge_refund_state t),
   'attempt',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),xmin::text) ORDER BY attempt_id) FROM public.recharge_refund_attempt t),
   'result',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),xmin::text) ORDER BY result_id) FROM public.recharge_refund_result t)) AS value`);
 if(!row)throw Error('Owned economic snapshot unavailable');return JSON.stringify(row.value);
}
