/** Actual existing five-LOGIN profiles and formal schema-only predecessors.
 * Setup commissions schemas/roles only; no payment, hold, provider truth or new
 * notice row is produced. Setup is not evidence that the independent complete
 * maintenance author meets its still-unresolved five-second case budget. */
import { sql } from 'drizzle-orm';
import { runRoutineIdentityOwnershipUpgrade } from '@/migrations/runRoutineIdentityOwnershipUpgrade';
import { runRoutineShippingUpgrade } from '@/migrations/runRoutineShippingUpgrade';
import { runRoutineSubscriptionUpgrade } from '@/migrations/runRoutineSubscriptionUpgrade';
import { runAdminWechatAppUpgrade } from '@/migrations/runAdminWechatAppUpgrade';
import { runRoutineSubscriptionDeliveryUpgrade } from '@/migrations/runRoutineSubscriptionDeliveryUpgrade';
import { runRoutineVirtualShippingSubjectsUpgrade } from '@/migrations/runRoutineVirtualShippingSubjectsUpgrade';
import { runPaidNoticeUpgrade } from '@/migrations/paidNotice';
import { runMembershipPaidNoticeUpgrade } from '@/migrations/membershipPaidNotice';
import { runRechargePaidNoticeUpgrade } from '@/migrations/rechargePaidNotice';
import { runRechargeRefundNoticeUpgrade } from '@/migrations/rechargeRefundNotice';
import { rechargeRefundRuntimeProfileFixture } from './rechargeRefundRuntimeProfileNative';

export async function rechargeRefundNoticeStorageRuntimeFixture() {
 const f=await rechargeRefundRuntimeProfileFixture();
 try {
  // Same established producer-schema order as the genuine author fixture;
  // no business source producer is invoked by this catalog-only helper.
  await runRoutineIdentityOwnershipUpgrade(f.maintenanceDb,f.target,f.beforePeers,f.appReaders);
  await runRoutineShippingUpgrade(f.maintenanceDb,f.target,f.beforePeers,f.appReaders);
  await runRoutineSubscriptionUpgrade(f.maintenanceDb,f.target,f.beforePeers,f.appReaders);
  await runAdminWechatAppUpgrade(f.maintenanceDb,f.target,f.beforePeers,f.appReaders);
  await runRoutineSubscriptionDeliveryUpgrade(f.maintenanceDb,f.target,f.beforePeers,f.appReaders);
  await runRoutineVirtualShippingSubjectsUpgrade(f.maintenanceDb,f.target,f.beforePeers,f.appReaders);
  await runPaidNoticeUpgrade(f.maintenanceDb);await runMembershipPaidNoticeUpgrade(f.maintenanceDb);
  await runRechargePaidNoticeUpgrade(f.maintenanceDb);
  const commissioned=await f.commission();
  if(!commissioned.applied)throw Error('Fresh complete recharge profile predecessor must advance');
  const noticeQueueBaseline=f.messages.length;
  await runRechargeRefundNoticeUpgrade(f.maintenanceDb);
  if(f.messages.length!==noticeQueueBaseline)throw Error('Schema-only notice commissioning emitted a Queue message');
  const noticeSnapshot=async()=>{
   const [r]=await f.maintenanceDb.execute<{value:unknown}>(sql`SELECT jsonb_build_object(
    'tables',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.oid::text,c.relowner::text,c.relacl,c.relchecks) ORDER BY c.relname)
     FROM pg_catalog.pg_class c WHERE c.oid IN('public.store_order_outbox'::regclass,'public.order_notification_delivery'::regclass)),
    'columns',(SELECT jsonb_agg(jsonb_build_array(a.attrelid::text,a.attnum,a.attname,a.atttypid::text,a.atttypmod,a.attnotnull,
     a.attacl,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attrelid,a.attnum) FROM pg_catalog.pg_attribute a
     LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
     WHERE a.attrelid IN('public.store_order_outbox'::regclass,'public.order_notification_delivery'::regclass) AND a.attnum>0),
    'checks',(SELECT jsonb_agg(jsonb_build_array(k.oid::text,k.xmin::text,k.conname,pg_get_constraintdef(k.oid,false),obj_description(k.oid,'pg_constraint')) ORDER BY k.oid)
     FROM pg_catalog.pg_constraint k WHERE k.conrelid IN('public.store_order_outbox'::regclass,'public.order_notification_delivery'::regclass)),
    'outbox',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.store_order_outbox t),
    'delivery',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY id) FROM public.order_notification_delivery t),
    'outbox_sequence',(SELECT jsonb_build_array(last_value,is_called) FROM public.store_order_outbox_id_seq),
    'delivery_sequence',(SELECT jsonb_build_array(last_value,is_called) FROM public.order_notification_delivery_id_seq)) AS value`);
   return JSON.stringify(r.value);
  };
  // All direct owner transactions above have committed. The existing restricted
  // NOLOGIN definer owner is never used as a session; real audits still execute
  // their live pg_stat_activity/auth-membership predicates without substitution.
  return {...f,noticeSnapshot,noticeQueueBaseline};
 }catch(error){await f.close();throw error;}
}
export type RechargeRefundNoticeStorageRuntimeFixture=Awaited<ReturnType<typeof rechargeRefundNoticeStorageRuntimeFixture>>;
