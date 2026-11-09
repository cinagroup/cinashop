/** Genuine original-account payment/provider fixture. The one missing known
 * model index is staged only by owner during catalog setup; no runtime repair,
 * new grant, preseeded provider truth or hidden business setup is performed. */
import { sql } from 'drizzle-orm';
import { runRechargeRefundNoticeUpgrade } from '@/migrations/rechargeRefundNotice';
import { releaseRechargeRefundClosedFirstResult } from '@/services/payment/RechargeRefundClosedRelease';
import { rechargeFirstProviderHistoryFixture } from './rechargeFirstProviderHistoryNative';

export async function rechargeClosedReleaseNativeFixture(values: Map<string, unknown>) {
 const f = await rechargeFirstProviderHistoryFixture(values);
 try {
  const [index] = await f.maintenanceDb.execute<{ present: boolean }>(sql`SELECT pg_catalog.to_regclass('public.cf_event_key_uq') IS NOT NULL AS present`);
  if (!index) throw Error('Owned cash-flow catalog unavailable');
  if (!index.present) await f.maintenanceDb.transaction(async tx => {
   await tx.execute(sql`SET LOCAL statement_timeout='5000ms'`);await tx.execute(sql`SET LOCAL lock_timeout='1000ms'`);
   await tx.execute(sql`CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow USING btree(event_key)`);
  });
  // A present but drifted index is never repaired here; the real guard refuses.
  // Schema-only successor compatibility: all original genuine32 case bodies
  // now run with the formally installed new pair; no notice/business producer
  // is moved into setup and no new runnable event is created here.
  await runRechargeRefundNoticeUpgrade(f.maintenanceDb);
  const release = (operationId: unknown, resultId: unknown, role: 'app'|'admin'|'financial' = 'admin') =>
   releaseRechargeRefundClosedFirstResult({ ...f.adminContainer, db: f.profilePeers[role].db }, f.env, role, operationId, resultId);
  async function economicSnapshot(order: Parameters<typeof f.snapshot>[0]) {
   const business = JSON.parse(await f.snapshot(order)) as Record<string, unknown>;
   const [row] = await f.maintenanceDb.execute<{ flow: unknown; outbox: unknown }>(sql`SELECT
    (SELECT COALESCE(jsonb_agg(to_jsonb(t)||jsonb_build_object('_xmin',xmin::text) ORDER BY id),'[]'::jsonb)
     FROM public.capital_flow t WHERE order_id=${order.orderId}) AS flow,
    (SELECT COALESCE(jsonb_agg(to_jsonb(t)||jsonb_build_object('_xmin',xmin::text) ORDER BY id),'[]'::jsonb)
     FROM public.store_order_outbox t WHERE aggregate_type='recharge' AND aggregate_id=${order.id}) AS outbox`);
   return JSON.stringify({ ...business, flow: row.flow, outbox: row.outbox });
  }
  async function writeFootprintDiagnostic() {
   const indexes=await f.maintenanceDb.execute(sql`SELECT t.relname AS table_name,c.relname AS name,pg_catalog.pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_class t ON t.oid=i.indrelid
    WHERE t.oid IN('public.user'::regclass,'public.user_bill'::regclass)
    AND c.relname IN('user_pkey','user_account_idx','spreaduid','level','user_status_idx','work_uid','is_promoter','user_phone_idx',
     'user_delete_time_idx','add_time_delete_sex','user_division_parent','user_division_role','user_active_phone_uq','user_bar_code_uq',
     'user_division_invite','user_bill_pkey','ub_uid_idx','ub_status','ub_add_time','ub_pm','ub_cat_type_link_idx','ub_event_key',
     'ub_offline_integral_uq','ub_order_reward_uq','ub_out_request_uq','ub_order_promotion_gift_uq') ORDER BY t.relname,c.relname LIMIT 26`);
   const checks=await f.maintenanceDb.execute(sql`SELECT c.relname AS table_name,k.conname AS name,pg_catalog.pg_get_constraintdef(k.oid,false) AS definition
    FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
    WHERE c.oid IN('public.user'::regclass,'public.user_bill'::regclass) AND k.conname IN('user_pkey','user_bill_pkey',
     'user_division_percent_ck','user_division_status_ck','user_division_type_ck') ORDER BY c.relname,k.conname LIMIT 5`);
   const triggers=await f.maintenanceDb.execute(sql`SELECT g.tgname,g.tgtype,g.tgenabled,g.tgisinternal,k.conname,p.proname
    FROM pg_catalog.pg_trigger g LEFT JOIN pg_catalog.pg_constraint k ON k.oid=g.tgconstraint
    JOIN pg_catalog.pg_proc p ON p.oid=g.tgfoid WHERE g.tgrelid IN('public.user'::regclass,'public.user_bill'::regclass)
    AND (k.conname IN('ooa_user_fk','offline_order_balance_integral_bill_id_fkey','offline_order_external_payment_integral_bill_id_fkey')
     OR g.tgname IN('oob_bill_guard','oob_bill_truncate','ooep_bill_guard','ooep_bill_truncate')) ORDER BY g.tgrelid,g.oid LIMIT 24`);
   // Known owned catalog names only; never row data, SQL parameters or key material.
   return JSON.stringify({indexes,checks,triggers}).slice(0,16384);
  }
  return { ...f, release, economicSnapshot, writeFootprintDiagnostic };
 } catch (error) { await f.close();throw error; }
}
export type RechargeClosedReleaseNativeFixture = Awaited<ReturnType<typeof rechargeClosedReleaseNativeFixture>>;
