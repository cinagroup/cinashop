/** Explicit paired storage successor. No event producer, business adoption,
 * role grant, dispatch route or sender is installed. Metadata readiness is not
 * permission to insert an outbox row or move funds; the eventual writer must
 * prove its complete write footprint and independent notification authority. */
import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';
import { NOTICE_MAINTENANCE_BUDGET_SQL, RECHARGE_PAID_NOTICE_GENERATIONS,
  RECHARGE_REFUND_NOTICE_GENERATIONS, paidNoticeAddonUpgradeSql, paidNoticeEventGeneration } from './paidNotice';
import { classifyRoutineVirtualShippingSubjects, ROUTINE_VIRTUAL_SHIPPING_STRUCTURE_SQL } from './routineVirtualShippingSubjects';
import { RECHARGE_PAID_SUBJECT_DEFINITION } from './rechargePaidNoticeContract';
import { RECHARGE_REFUND_NOTICE_SUBJECT_CHECK_SQL, RECHARGE_REFUND_NOTICE_SUBJECT_DEFINITION } from './rechargeRefundNoticeContract';

type Query = Pick<DbClient, 'execute'>;
const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const oldDefinitions = RECHARGE_PAID_NOTICE_GENERATIONS.map(g => g.definition);
const newDefinitions = RECHARGE_REFUND_NOTICE_GENERATIONS.map(g => g.definition);

/** One actual statement; no facts object accepted from callers, sequence values
 * consumed, ready cache or assumptions from the TypeScript model. This proves
 * only the seven immutable physical notice columns plus the existing pair. */
export const RECHARGE_REFUND_NOTICE_STRUCTURE_SQL = `WITH
 pair AS MATERIALIZED (${ROUTINE_VIRTUAL_SHIPPING_STRUCTURE_SQL}),
 target AS MATERIALIZED (SELECT * FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass('public.store_order_outbox')),
 attrs AS MATERIALIZED (SELECT a.*,d.oid AS default_oid,pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS initial
  FROM target t JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum),
 expected(name,typ,required,initial) AS (VALUES
  ('id','integer',true,NULL::text),('event_key','character varying(128)',true,NULL::text),
  ('aggregate_type','character varying(32)',true,'''order''::character varying'),
  ('aggregate_id','integer',true,NULL::text),('event_type','character varying(64)',true,NULL::text),
  ('payload','jsonb',true,'''{}''::jsonb'),('add_time','integer',true,'0')),
 serial AS MATERIALIZED (SELECT a.attnum,a.default_oid,a.initial,t.oid AS table_oid,t.relowner AS table_owner,
  s.oid,s.relname,s.relowner,s.relkind,s.relpersistence,s.reloptions,q.*
  FROM target t JOIN attrs a ON a.attname='id'
  LEFT JOIN pg_catalog.pg_class s ON s.oid=pg_catalog.to_regclass('public.store_order_outbox_id_seq')
  LEFT JOIN pg_catalog.pg_sequence q ON q.seqrelid=s.oid),
 named_index AS MATERIALIZED (SELECT c.*,i.* FROM pg_catalog.pg_class c
  LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
  WHERE c.relnamespace='public'::regnamespace AND c.relname='soob_event_key_uq')
 SELECT pair.*,
 (SELECT count(*)=2 AND bool_and(pg_catalog.obj_description(k.oid,'pg_constraint') IS NULL
  OR pg_catalog.octet_length(pg_catalog.obj_description(k.oid,'pg_constraint'))<=4096)
  FROM pg_catalog.pg_constraint k WHERE (k.conrelid=pg_catalog.to_regclass('public.store_order_outbox') AND k.conname='soob_event_type_ck')
   OR(k.conrelid=pg_catalog.to_regclass('public.order_notification_delivery') AND k.conname='ond_subject_ck')) AS comment_budget,
 EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid=pg_catalog.to_regclass('public.order_notification_delivery')
  AND k.conname='ond_subject_ck' AND k.conparentid=0
  AND k.conkey=ARRAY(SELECT a.attnum FROM (VALUES(1,'subject_domain'),(2,'subject_id'),(3,'event_key'),
   (4,'withdrawal_id'),(5,'order_id'),(6,'channel'),(7,'notice_mark')) AS canonical_key(ordinal_position,column_name)
   LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=k.conrelid AND a.attnum>0 AND NOT a.attisdropped
    AND a.attname=canonical_key.column_name ORDER BY canonical_key.ordinal_position)::smallint[])
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid=pg_catalog.to_regclass('public.store_order_outbox')
  AND k.conname='soob_event_type_ck' AND k.conparentid=0) AS subject_closure,
 (SELECT count(*)=1 AND bool_and(t.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
   AND t.relreplident='d' AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=t.oid)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=t.oid)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=t.oid AND d.deptype='e')) FROM target t)
 AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN attrs a ON a.attname=e.name
  WHERE a.attnum IS NULL OR pg_catalog.format_type(a.atttypid,a.atttypmod)<>e.typ OR a.attnotnull<>e.required
   OR a.attgenerated<>'' OR a.attidentity<>''
   OR a.attcollation<>(SELECT typcollation FROM pg_catalog.pg_type WHERE oid=a.atttypid)
   OR (e.name<>'id' AND a.initial IS DISTINCT FROM e.initial))
 AND EXISTS(SELECT 1 FROM target t JOIN pg_catalog.pg_constraint k ON k.conrelid=t.oid
  WHERE k.contype='p' AND k.convalidated AND NOT k.condeferrable AND NOT k.condeferred
   AND k.conislocal AND k.coninhcount=0 AND k.conparentid=0
   AND k.conkey=ARRAY[(SELECT attnum FROM attrs WHERE attname='id')]::smallint[])
 AND (SELECT count(*)=1 AND bool_and(s.oid IS NOT NULL AND s.relowner=s.table_owner AND s.relkind='S'
   AND s.relpersistence='p' AND s.reloptions IS NULL AND s.seqtypid='pg_catalog.int4'::regtype
   AND s.seqstart=1 AND s.seqincrement=1 AND s.seqmin=1 AND s.seqmax=2147483647 AND s.seqcache=1 AND NOT s.seqcycle
   AND s.initial IN('nextval(''store_order_outbox_id_seq''::regclass)','nextval(''public.store_order_outbox_id_seq''::regclass)')
   AND pg_catalog.pg_get_serial_sequence('public.store_order_outbox','id')::regclass::oid=s.oid
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=s.oid AND d.deptype='e')
   AND (SELECT count(*)=1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=s.oid
    AND d.objsubid=0 AND d.refclassid='pg_catalog.pg_class'::regclass AND d.refobjid=s.table_oid AND d.refobjsubid=s.attnum AND d.deptype='a')
   AND (SELECT count(*)=1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=s.oid AND d.deptype IN('a','i'))
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_attrdef'::regclass AND d.objid=s.default_oid
    AND d.refclassid='pg_catalog.pg_class'::regclass AND d.refobjid=s.oid AND d.refobjsubid=0 AND d.deptype='n')
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_attrdef'::regclass AND d.objid=s.default_oid
    AND d.deptype='n' AND NOT(d.refclassid='pg_catalog.pg_class'::regclass AND d.refobjid=s.oid AND d.refobjsubid=0))) FROM serial s)
 AND (SELECT count(*)=1 AND bool_and(c.relkind='i' AND c.relpersistence='p' AND c.relowner=(SELECT relowner FROM target)
   AND c.reloptions IS NULL AND c.relacl IS NULL AND c.reltoastrelid=0
   AND c.indrelid=(SELECT oid FROM target) AND c.indisunique AND NOT c.indisprimary AND NOT c.indisexclusion
   AND c.indisvalid AND c.indisready AND c.indislive AND c.indimmediate AND NOT c.indnullsnotdistinct AND NOT c.indisreplident
   AND c.indexprs IS NULL AND c.indpred IS NULL AND c.indnkeyatts=1 AND c.indnatts=1
   AND c.indkey::text=(SELECT attnum::text FROM attrs WHERE attname='event_key')
   AND c.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')
   AND c.indclass[0]=(SELECT oid FROM pg_catalog.pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace
    AND opcname='text_ops' AND opcmethod=c.relam AND opcintype='pg_catalog.text'::regtype AND opcdefault AND opckeytype=0)
   AND c.indcollation[0]='pg_catalog."default"'::regcollation AND c.indoption::text='0'
   AND pg_catalog.pg_get_indexdef(c.oid)='CREATE UNIQUE INDEX soob_event_key_uq ON public.store_order_outbox USING btree (event_key)'
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conindid=c.oid)) FROM named_index c) AS projection_ready
 FROM pair`;

const complete = (name: string) => `${name}.safe IS TRUE AND ${name}.core IS TRUE AND ${name}.subject_safe IS TRUE
 AND ${name}.event_safe IS TRUE AND ${name}.subject_columns=2 AND ${name}.columns_ready IS TRUE
 AND ${name}.indexes=1 AND ${name}.index_ready IS TRUE AND ${name}.projection_ready IS TRUE AND ${name}.subject_closure IS TRUE AND ${name}.comment_budget IS TRUE`;
const resolutionSql = `DO $recharge_refund_resolution$
BEGIN
 IF pg_catalog.to_regclass('store_order_outbox') IS DISTINCT FROM pg_catalog.to_regclass('public.store_order_outbox')
  OR pg_catalog.to_regclass('order_notification_delivery') IS DISTINCT FROM pg_catalog.to_regclass('public.order_notification_delivery') THEN
  RAISE EXCEPTION 'Recharge refund notice ORM relation resolution drift';
 END IF;
END
$recharge_refund_resolution$;`;
const ownerPairSql = (activeOnly: boolean) => `${NOTICE_MAINTENANCE_BUDGET_SQL}
${resolutionSql}
SET LOCAL search_path TO pg_catalog, public, pg_temp;
DO $recharge_refund_pair$
DECLARE notice_catalog record;
BEGIN
 LOCK TABLE ONLY public.store_order_outbox IN ACCESS EXCLUSIVE MODE NOWAIT;
 LOCK TABLE ONLY public.order_notification_delivery IN ACCESS EXCLUSIVE MODE NOWAIT;
 SELECT * INTO notice_catalog FROM (${RECHARGE_REFUND_NOTICE_STRUCTURE_SQL}) q;
 IF NOT COALESCE(${complete('notice_catalog')},false)
  OR current_user<>session_user OR current_user IS DISTINCT FROM notice_catalog.maintenance
  OR pg_catalog.current_setting('role')<>'none'
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
   WHERE a.pid=pg_catalog.pg_backend_pid() AND r.rolname=current_user AND r.rolcanlogin AND r.rolsuper)
  OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
  OR pg_catalog.current_setting('transaction_read_only')<>'off'
  OR pg_catalog.current_setting('session_replication_role')<>'origin'
  OR NOT (${activeOnly ? '' : `(notice_catalog.subject_definition=${literal(RECHARGE_PAID_SUBJECT_DEFINITION)} AND notice_catalog.event_definition IN (${oldDefinitions.map(literal).join(',')})) OR `}
    (notice_catalog.subject_definition=${literal(RECHARGE_REFUND_NOTICE_SUBJECT_DEFINITION)} AND notice_catalog.event_definition IN (${newDefinitions.map(literal).join(',')}))) THEN
  RAISE EXCEPTION 'Recharge refund notice requires the exact paired direct-owner PG16 catalog';
 END IF;
 IF EXISTS(SELECT 1 FROM (SELECT * FROM public.store_order_outbox LIMIT 10001) t
  HAVING count(*)>10000 OR COALESCE(sum(pg_column_size(t)),0)>16777216 OR COALESCE(bool_or(pg_column_size(t)>1048576),false))
  OR EXISTS(SELECT 1 FROM (SELECT * FROM public.order_notification_delivery LIMIT 10001) t
  HAVING count(*)>10000 OR COALESCE(sum(pg_column_size(t)),0)>16777216 OR COALESCE(bool_or(pg_column_size(t)>1048576),false)) THEN
  RAISE EXCEPTION 'Recharge refund notice paired maintenance row budget exceeded';
 END IF;
END
$recharge_refund_pair$;
`;
const activePairSql = ownerPairSql(true);
/** Older wrappers enter only after seeing an exact new event generation, then
 * actually lock and reread the complete active pair. Dynamic imports keep the
 * existing constants' initialization graph acyclic. No caller-supplied proof. */
export async function assertRechargeRefundNoticeActivePairUnsafeTx(tx: Pick<postgres.TransactionSql, 'unsafe'>): Promise<void> {
  await tx.unsafe(activePairSql);
}
export async function assertRechargeRefundNoticeActivePairTx(tx: Query): Promise<void> {
  if (Object.hasOwn(tx, '$client')) throw new ServiceUnavailableException('充值退款通知维护检查需要实际拥有事务');
  await tx.execute(sql.raw(activePairSql));
}

export const RECHARGE_REFUND_NOTICE_SQL = `-- Storage only; no new notice rows, grants, Queue route or sender.
${ownerPairSql(false)}
${paidNoticeAddonUpgradeSql('recharge-refund', '', true, true, true)}
DO $recharge_refund_subject$
DECLARE d text; old_comment text; row_count integer; byte_count bigint; oversized boolean;
BEGIN
 SELECT pg_catalog.pg_get_constraintdef(oid,false),pg_catalog.obj_description(oid,'pg_constraint') INTO d,old_comment
  FROM pg_catalog.pg_constraint WHERE conrelid='public.order_notification_delivery'::regclass AND conname='ond_subject_ck';
 IF d=${literal(RECHARGE_REFUND_NOTICE_SUBJECT_DEFINITION)} THEN RETURN; END IF;
 IF d IS DISTINCT FROM ${literal(RECHARGE_PAID_SUBJECT_DEFINITION)} OR pg_catalog.octet_length(old_comment)>4096 THEN
  RAISE EXCEPTION 'Recharge refund notice subject predecessor drift';
 END IF;
 SELECT count(*)::integer,COALESCE(sum(pg_column_size(t)),0),COALESCE(bool_or(pg_column_size(t)>1048576),false)
  INTO row_count,byte_count,oversized FROM (SELECT * FROM public.order_notification_delivery LIMIT 10001) t;
 IF row_count>10000 OR byte_count>16777216 OR oversized THEN RAISE EXCEPTION 'Recharge refund notice delivery maintenance row budget exceeded'; END IF;
 ALTER TABLE public.order_notification_delivery DROP CONSTRAINT ond_subject_ck;
 ALTER TABLE public.order_notification_delivery ADD CONSTRAINT ond_subject_ck ${RECHARGE_REFUND_NOTICE_SUBJECT_CHECK_SQL};
 IF old_comment IS NOT NULL THEN EXECUTE pg_catalog.format('COMMENT ON CONSTRAINT ond_subject_ck ON public.order_notification_delivery IS %L',old_comment); END IF;
END
$recharge_refund_subject$;
${activePairSql}
`;

/** Metadata inspection only. Complete known predecessors are inactive;
 * partial/unknown pairs refuse. Existing economic/runtime guards separately
 * prove the actual writer's LOGIN, table/column/sequence ACL and write effects.
 * This must never gate retention/read of already verified provider history. */
export async function rechargeRefundNoticeCommissionedTx(tx: Query): Promise<boolean> {
  if (Object.hasOwn(tx, '$client')) throw new ServiceUnavailableException('充值退款通知检查需要实际拥有事务');
  await tx.execute(sql.raw(NOTICE_MAINTENANCE_BUDGET_SQL));
  const [resolution] = await tx.execute<{ empty: boolean; resolved: boolean }>(sql`SELECT
    pg_catalog.to_regclass('public.store_order_outbox') IS NULL AND pg_catalog.to_regclass('public.order_notification_delivery') IS NULL AS empty,
    pg_catalog.to_regclass('store_order_outbox')=pg_catalog.to_regclass('public.store_order_outbox')
     AND pg_catalog.to_regclass('order_notification_delivery')=pg_catalog.to_regclass('public.order_notification_delivery') AS resolved`);
  if (resolution?.empty === true) return false;
  const rows = await tx.execute<Record<string, unknown>>(sql.raw(RECHARGE_REFUND_NOTICE_STRUCTURE_SQL));
  const row = rows[0], generation = rows.length === 1 ? paidNoticeEventGeneration(row.event_definition) : null;
  const structure = classifyRoutineVirtualShippingSubjects(row);
  if (resolution?.resolved !== true || !generation || structure.failures.length !== 0 || row?.projection_ready !== true)
    throw new ServiceUnavailableException('充值退款成功通知数据库合同发生漂移');
  if (!generation.rechargeRefundNotice) return false;
  if (row.subject_definition === RECHARGE_REFUND_NOTICE_SUBJECT_DEFINITION && row.subject_closure === true && row.comment_budget === true && structure.ready) return true;
  throw new ServiceUnavailableException('充值退款成功通知数据库合同发生漂移');
}
/** Actual table fences before source/payment/wallet locks; still only metadata
 * readiness. It supplies no lifetime DDL proof for a later physical writer. */
export async function prepareRechargeRefundNoticeTx(tx: Query): Promise<boolean> {
  if (!await rechargeRefundNoticeCommissionedTx(tx)) return false;
  await tx.execute(sql`LOCK TABLE ONLY public.store_order_outbox IN ROW EXCLUSIVE MODE NOWAIT`);
  await tx.execute(sql`LOCK TABLE ONLY public.order_notification_delivery IN ACCESS SHARE MODE NOWAIT`);
  if (!await rechargeRefundNoticeCommissionedTx(tx)) throw new ServiceUnavailableException('充值退款通知维护期间发生变化');
  return true;
}
export async function runRechargeRefundNoticeUpgrade(db: Pick<DbClient, '$client'>): Promise<void> {
  if (!db.$client) throw Error('Recharge refund notice upgrade requires a root database');
  await db.$client.begin('isolation level read committed', async tx => { await tx.unsafe(RECHARGE_REFUND_NOTICE_SQL); });
}
