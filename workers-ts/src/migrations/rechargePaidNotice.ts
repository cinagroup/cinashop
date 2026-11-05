/** Explicit recharge settlement/notice commissioning on installed domain
 * subjects. No business adoption, role grants or automatic runtime DDL. */
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';
import { RECHARGE_PAID_NOTICE_GENERATIONS, MEMBERSHIP_PAID_NOTICE_GENERATIONS, paidNoticeEventGeneration,
  paidNoticeAddonUpgradeSql, NOTICE_MAINTENANCE_BUDGET_SQL } from './paidNotice';
import { classifyRoutineVirtualShippingSubjects, ROUTINE_VIRTUAL_SHIPPING_STRUCTURE_SQL } from './routineVirtualShippingSubjects';
import {MEMBERSHIP_PAID_SUBJECT_DEFINITION} from './membershipPaidNoticeContract';
import { RECHARGE_PAID_SUBJECT_CHECK_SQL, RECHARGE_PAID_SUBJECT_DEFINITION } from './rechargePaidNoticeContract';
export { RECHARGE_PAID_NOTICE_EVENT, RECHARGE_SETTLED_EVENT } from './rechargePaidNoticeContract';
const literal = (s: string) => "'"+s.replaceAll("'","''")+"'";
const oldDefinitions = MEMBERSHIP_PAID_NOTICE_GENERATIONS.map(g=>g.definition);
const newDefinitions = RECHARGE_PAID_NOTICE_GENERATIONS.map(g=>g.definition);
export const RECHARGE_PAID_NOTICE_SQL = `-- Explicit paired recharge event and delivery successor. No business DML or grants.
SET LOCAL search_path TO pg_catalog, public, pg_temp;
${NOTICE_MAINTENANCE_BUDGET_SQL}
DO $recharge_paid_predecessor$
DECLARE recharge_catalog record;
BEGIN
 LOCK TABLE ONLY public.store_order_outbox IN ACCESS EXCLUSIVE MODE NOWAIT;
 LOCK TABLE ONLY public.order_notification_delivery IN ACCESS EXCLUSIVE MODE NOWAIT;
 SELECT * INTO recharge_catalog FROM (${ROUTINE_VIRTUAL_SHIPPING_STRUCTURE_SQL}) q;
 IF recharge_catalog.safe IS DISTINCT FROM true OR recharge_catalog.core IS DISTINCT FROM true OR recharge_catalog.subject_safe IS DISTINCT FROM true
  OR recharge_catalog.event_safe IS DISTINCT FROM true OR recharge_catalog.subject_columns<>2 OR recharge_catalog.columns_ready IS DISTINCT FROM true
  OR recharge_catalog.indexes<>1 OR recharge_catalog.index_ready IS DISTINCT FROM true
  OR current_user<>session_user OR current_user IS DISTINCT FROM recharge_catalog.maintenance
  OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
  OR pg_catalog.current_setting('transaction_read_only')<>'off'
  OR pg_catalog.current_setting('session_replication_role')<>'origin'
  OR NOT ((recharge_catalog.subject_definition=${literal(MEMBERSHIP_PAID_SUBJECT_DEFINITION)} AND recharge_catalog.event_definition IN (${oldDefinitions.map(literal).join(',')}))
    OR (recharge_catalog.subject_definition=${literal(RECHARGE_PAID_SUBJECT_DEFINITION)} AND recharge_catalog.event_definition IN (${newDefinitions.map(literal).join(',')}))) THEN
   RAISE EXCEPTION 'Recharge notice requires the exact paired direct-owner PG16 predecessor';
 END IF;
END
$recharge_paid_predecessor$;
${paidNoticeAddonUpgradeSql('recharge','',true,true)}
DO $recharge_paid_subject$
DECLARE d text; old_comment text; row_count integer; byte_count bigint; oversized boolean;
BEGIN
 SELECT pg_catalog.pg_get_constraintdef(oid,false),pg_catalog.obj_description(oid,'pg_constraint') INTO d,old_comment
  FROM pg_catalog.pg_constraint WHERE conrelid='public.order_notification_delivery'::regclass AND conname='ond_subject_ck';
 IF d=${literal(RECHARGE_PAID_SUBJECT_DEFINITION)} THEN RETURN; END IF;
 IF d IS DISTINCT FROM ${literal(MEMBERSHIP_PAID_SUBJECT_DEFINITION)} OR pg_catalog.octet_length(old_comment)>4096 THEN
  RAISE EXCEPTION 'Recharge notice subject predecessor drift';
 END IF;
 SELECT count(*)::integer,COALESCE(sum(pg_column_size(t)),0),COALESCE(bool_or(pg_column_size(t)>1048576),false)
  INTO row_count,byte_count,oversized FROM (SELECT * FROM public.order_notification_delivery LIMIT 10001) t;
 IF row_count>10000 OR byte_count>16777216 OR oversized THEN RAISE EXCEPTION 'Recharge notice delivery maintenance row budget exceeded'; END IF;
 ALTER TABLE public.order_notification_delivery DROP CONSTRAINT ond_subject_ck;
 ALTER TABLE public.order_notification_delivery ADD CONSTRAINT ond_subject_ck ${RECHARGE_PAID_SUBJECT_CHECK_SQL};
 IF old_comment IS NOT NULL THEN EXECUTE pg_catalog.format('COMMENT ON CONSTRAINT ond_subject_ck ON public.order_notification_delivery IS %L',old_comment); END IF;
END
$recharge_paid_subject$;
`;
export async function rechargePaidNoticeCommissionedTx(tx:Pick<DbClient,'execute'>):Promise<boolean> {
  await tx.execute(sql.raw(NOTICE_MAINTENANCE_BUDGET_SQL));
  const [resolution] = await tx.execute<{empty:boolean;resolved:boolean}>(sql`SELECT
    pg_catalog.to_regclass('public.store_order_outbox') IS NULL AND pg_catalog.to_regclass('public.order_notification_delivery') IS NULL AS empty,
    pg_catalog.to_regclass('store_order_outbox')=pg_catalog.to_regclass('public.store_order_outbox')
      AND pg_catalog.to_regclass('order_notification_delivery')=pg_catalog.to_regclass('public.order_notification_delivery') AS resolved`);
  if (resolution?.empty === true) return false;
  const rows = await tx.execute<Record<string,unknown>>(sql.raw(ROUTINE_VIRTUAL_SHIPPING_STRUCTURE_SQL));
  if (rows.length !== 1) throw new ServiceUnavailableException('充值付款通知数据库合同发生漂移');
  const row = rows[0], generation = paidNoticeEventGeneration(row.event_definition);
  const structure = classifyRoutineVirtualShippingSubjects(row);
  if (generation && !generation.recharge && resolution?.resolved === true && structure.failures.length === 0) return false;
  if (generation?.recharge && row.subject_definition === RECHARGE_PAID_SUBJECT_DEFINITION
    && resolution?.resolved === true && structure.ready) return true;
  throw new ServiceUnavailableException('充值付款通知数据库合同发生漂移');
}
/** Take the table fences before user/order/financial locks. An inactive known
 * predecessor stays silent; active drift never silently loses a new notice. */
export async function prepareRechargePaidNoticeTx(tx:Pick<DbClient,'execute'>):Promise<boolean> {
  const enabled = await rechargePaidNoticeCommissionedTx(tx);
  if (!enabled) return false;
  await tx.execute(sql`LOCK TABLE public.store_order_outbox IN ROW EXCLUSIVE MODE NOWAIT`);
  await tx.execute(sql`LOCK TABLE public.order_notification_delivery IN ACCESS SHARE MODE NOWAIT`);
  if (!await rechargePaidNoticeCommissionedTx(tx)) throw new ServiceUnavailableException('充值付款通知维护期间发生变化');
  return true;
}
export async function runRechargePaidNoticeUpgrade(db:Pick<DbClient,'$client'>):Promise<void> {
  if (!db.$client) throw Error('Recharge notice upgrade requires a root database');
  await db.$client.begin('isolation level read committed',async tx=>{await tx.unsafe(RECHARGE_PAID_NOTICE_SQL);});
}
