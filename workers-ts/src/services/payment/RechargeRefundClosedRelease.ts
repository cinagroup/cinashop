/** Narrow owning SQL author for the sole first POST's persisted CLOSED.
 * No HTTP, provider IO, query/callback recovery, success capture or notices.
 * Historical replay verifies its immutable bill/result chain independently of
 * later wallet/order/source projections, actor expiry and credential rotation. */
import { randomUUID } from 'node:crypto';
import { and, eq, or, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { Container, DbClient } from '@/lib/di';
import { user, userBill } from '@/models/schema';
import { assertRechargeRefundRuntimeTx, type RechargeRefundRuntimeRole } from '@/migrations/rechargeRefund';
import { ServiceUnavailableException } from '@/utils/errors';
import { readRechargePaidSettlementForRefundTx } from '@/services/order/RechargePaidNoticeSource';
import { assertRechargeRefundEconomicPrerequisitesTx } from './RechargeRefundEconomicPrerequisites';
import { assertRechargeRefundHoldBillTx, readRechargeRefundStateTx, type RechargeRefundStateRow } from './RechargeRefundAccounting';
import { readRechargeRefundFirstProviderResultTx, type RechargeRefundFirstProviderResult } from './RechargeRefundFirstProviderResult';
import { readRechargeRefundOperationHistoryTx } from './RechargeRefundOperationSource';
import { insertRechargeRefundEvidenceTx, lockRechargeRefundKeyTx,
 readRechargeRefundOperationByIdTx, type RechargeRefundRecord } from './RechargeRefundLedger';
import { parseRechargeRefundLocalReleaseResult, signRechargeRefundLocalReleaseResult,
 type RechargeRefundReleaseFacts } from './RechargeRefundLocalReleaseCodec';
import { rechargeRefundCents, rechargeRefundDecimal } from './RechargeRefundMoney';
import { lockStoreOrderPaymentBoundary } from './StoreOrderPaymentBoundary';
import { routineEvidenceCanonical } from './RoutineProviderObservation';
import { readRechargeRefundMixedProviderHistoryTx } from './RechargeRefundMixedProviderHistory';

type Signing = Pick<Env, 'APP_KEY'>;
const fail = (): never => { throw new ServiceUnavailableException('充值退款渠道关闭解冻需要人工核对，请保留原操作'); };
const uuid = (v: unknown): v is string => typeof v === 'string'
 && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const same = (a: unknown, b: unknown) => routineEvidenceCanonical(a) === routineEvidenceCanonical(b);
const historyInput = (h: RechargeRefundFirstProviderResult) => ({ operation: h.operation, attempt: h.attempt,
 providerResult: h.record, approval: h.approval });

/** Only local transaction budgets are tightened. A zero old timeout means
 * unbounded, never permission to leave a fresh or replay transaction unbounded. */
async function boundedContext(tx: DbClient) {
 await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
 await tx.execute(sql`SELECT pg_catalog.set_config('statement_timeout',
  LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
  pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
  pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
 const [r] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.current_setting('role')='none'
  AND current_user=session_user AND pg_catalog.current_setting('session_replication_role')='origin' AS ready`);
 if (r?.ready !== true) return fail();
}

async function finish<T>(tx: DbClient, value: T): Promise<T> {
 const [deadline] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds' AS ready`);
 if (deadline?.ready !== true) return fail();
 return value;
}

/** Exact canonical write footprint from user.ts/order.ts, 0144 CHECK state,
 * 0106/0173 partial indexes and the separately reviewed optional0176 gift index.
 * No regex/cast/parenthesis normalization or target-learned catalog is used. */
async function freshCatalog(tx: DbClient, role: RechargeRefundRuntimeRole) {
 await tx.execute(sql`LOCK TABLE ONLY public."user", ONLY public.user_bill IN ROW EXCLUSIVE MODE NOWAIT`);
 await tx.execute(sql`LOCK TABLE ONLY public.user_recharge, ONLY public.capital_flow, ONLY public.store_order_outbox IN ACCESS SHARE MODE NOWAIT`);
 const proof = await assertRechargeRefundEconomicPrerequisitesTx(tx, role, 'write');
 const [r] = await tx.execute<{ ready: boolean }>(sql`WITH
 expected_columns(table_name,name,typ,required) AS(VALUES
  ('user','uid','integer',true),
  ('user','account','character varying(32)',true),
  ('user','pwd','character varying(32)',true),
  ('user','real_name','character varying(25)',true),
  ('user','birthday','integer',true),
  ('user','card_id','character varying(20)',true),
  ('user','mark','character varying(255)',true),
  ('user','partner_id','integer',true),
  ('user','group_id','integer',true),
  ('user','nickname','character varying(60)',true),
  ('user','avatar','character varying(256)',true),
  ('user','phone','character varying(15)',true),
  ('user','add_time','integer',true),
  ('user','add_ip','character varying(45)',true),
  ('user','last_time','integer',true),
  ('user','last_ip','character varying(45)',true),
  ('user','now_money','numeric(12,2)',true),
  ('user','brokerage_price','numeric(12,2)',true),
  ('user','integral','integer',true),
  ('user','exp','numeric(12,2)',true),
  ('user','sign_num','integer',true),
  ('user','sign_remind','smallint',true),
  ('user','status','smallint',true),
  ('user','level','integer',true),
  ('user','agent_level','integer',true),
  ('user','spread_open','smallint',true),
  ('user','spread_uid','integer',true),
  ('user','spread_time','integer',true),
  ('user','spread_lottery','integer',true),
  ('user','work_uid','integer',true),
  ('user','work_userid','character varying(64)',true),
  ('user','user_type','character varying(32)',true),
  ('user','is_promoter','smallint',true),
  ('user','pay_count','integer',true),
  ('user','spread_count','integer',true),
  ('user','clean_time','integer',true),
  ('user','addres','character varying(255)',true),
  ('user','adminid','integer',true),
  ('user','login_type','character varying(36)',true),
  ('user','login_city','character varying(255)',true),
  ('user','record_phone','character varying(11)',true),
  ('user','is_money_level','smallint',true),
  ('user','is_ever_level','smallint',true),
  ('user','overdue_time','integer',true),
  ('user','uniqid','character varying(32)',true),
  ('user','bar_code','character varying(32)',true),
  ('user','rand_code','integer',true),
  ('user','sex','smallint',true),
  ('user','provincials','character varying(255)',true),
  ('user','province','integer',true),
  ('user','city','integer',true),
  ('user','area','integer',true),
  ('user','street','integer',true),
  ('user','is_del','smallint',true),
  ('user','delete_time','timestamp without time zone',false),
  ('user','extend_info','text',false),
  ('user','level_status','smallint',true),
  ('user','level_extend_info','text',false),
  ('user','is_first_order','smallint',true),
  ('user','is_newcomer','smallint',true),
  ('user','replace_order_num','character varying(32)',true),
  ('user','division_name','character varying(32)',true),
  ('user','division_type','integer',true),
  ('user','division_status','integer',true),
  ('user','division_id','integer',true),
  ('user','agent_id','integer',true),
  ('user','staff_id','integer',true),
  ('user','division_percent','integer',true),
  ('user','division_end_time','integer',true),
  ('user','division_change_time','integer',true),
  ('user','division_invite','integer',true),
  ('user_bill','id','integer',true),
  ('user_bill','uid','integer',true),
  ('user_bill','link_id','character varying(32)',true),
  ('user_bill','pm','smallint',true),
  ('user_bill','title','character varying(64)',true),
  ('user_bill','category','character varying(64)',true),
  ('user_bill','type','character varying(64)',true),
  ('user_bill','event_key','character varying(64)',true),
  ('user_bill','number','numeric(12,2)',true),
  ('user_bill','balance','numeric(12,2)',true),
  ('user_bill','mark','character varying(512)',true),
  ('user_bill','add_time','integer',true),
  ('user_bill','status','smallint',true),
  ('user_bill','take','smallint',true),
  ('user_bill','frozen_time','integer',true)),
 expected_constraints(table_name,name,kind,definition,column_names,validated) AS(VALUES
  ('user','user_pkey','p','PRIMARY KEY (uid)',ARRAY['uid']::text[],true),
  ('user_bill','user_bill_pkey','p','PRIMARY KEY (id)',ARRAY['id']::text[],true),
  ('user','user_division_type_ck','c','CHECK (((division_type >= 0) AND (division_type <= 3))) NOT VALID',ARRAY['division_type']::text[],false),
  ('user','user_division_status_ck','c','CHECK (((division_status >= 0) AND (division_status <= 1))) NOT VALID',ARRAY['division_status']::text[],false),
  ('user','user_division_percent_ck','c','CHECK (((division_percent >= 0) AND (division_percent <= 100))) NOT VALID',ARRAY['division_percent']::text[],false)),
 expected_indexes(table_name,name,column_names,definition,required,is_unique,is_primary) AS(VALUES
  ('user','user_pkey',ARRAY['uid']::text[],'CREATE UNIQUE INDEX user_pkey ON public."user" USING btree (uid)',true,true,true),
  ('user','user_account_idx',ARRAY['account']::text[],'CREATE INDEX user_account_idx ON public."user" USING btree (account)',true,false,false),
  ('user','spreaduid',ARRAY['spread_uid']::text[],'CREATE INDEX spreaduid ON public."user" USING btree (spread_uid)',true,false,false),
  ('user','level',ARRAY['level']::text[],'CREATE INDEX level ON public."user" USING btree (level)',true,false,false),
  ('user','user_status_idx',ARRAY['status']::text[],'CREATE INDEX user_status_idx ON public."user" USING btree (status)',true,false,false),
  ('user','work_uid',ARRAY['work_uid']::text[],'CREATE INDEX work_uid ON public."user" USING btree (work_uid)',true,false,false),
  ('user','is_promoter',ARRAY['is_promoter','phone']::text[],'CREATE INDEX is_promoter ON public."user" USING btree (is_promoter, phone)',true,false,false),
  ('user','user_phone_idx',ARRAY['phone']::text[],'CREATE INDEX user_phone_idx ON public."user" USING btree (phone)',true,false,false),
  ('user','user_delete_time_idx',ARRAY['delete_time']::text[],'CREATE INDEX user_delete_time_idx ON public."user" USING btree (delete_time)',true,false,false),
  ('user','add_time_delete_sex',ARRAY['add_time','delete_time','sex']::text[],'CREATE INDEX add_time_delete_sex ON public."user" USING btree (add_time, delete_time, sex)',true,false,false),
  ('user','user_division_parent',ARRAY['division_id','agent_id','staff_id']::text[],'CREATE INDEX user_division_parent ON public."user" USING btree (division_id, agent_id, staff_id)',true,false,false),
  ('user','user_division_role',ARRAY['division_type','division_status','division_end_time']::text[],'CREATE INDEX user_division_role ON public."user" USING btree (division_type, division_status, division_end_time)',true,false,false),
  ('user','user_active_phone_uq',ARRAY['phone']::text[],'CREATE UNIQUE INDEX user_active_phone_uq ON public."user" USING btree (phone) WHERE ((is_del = 0) AND (delete_time IS NULL) AND ((phone)::text <> ''''::text))',true,true,false),
  ('user','user_bar_code_uq',ARRAY['bar_code']::text[],'CREATE UNIQUE INDEX user_bar_code_uq ON public."user" USING btree (bar_code) WHERE ((bar_code)::text <> ''''::text)',true,true,false),
  ('user','user_division_invite',ARRAY['division_invite']::text[],'CREATE INDEX user_division_invite ON public."user" USING btree (division_invite) WHERE (division_invite <> 0)',true,false,false),
  ('user_bill','user_bill_pkey',ARRAY['id']::text[],'CREATE UNIQUE INDEX user_bill_pkey ON public.user_bill USING btree (id)',true,true,true),
  ('user_bill','ub_uid_idx',ARRAY['uid']::text[],'CREATE INDEX ub_uid_idx ON public.user_bill USING btree (uid)',true,false,false),
  ('user_bill','ub_status',ARRAY['status']::text[],'CREATE INDEX ub_status ON public.user_bill USING btree (status)',true,false,false),
  ('user_bill','ub_add_time',ARRAY['add_time']::text[],'CREATE INDEX ub_add_time ON public.user_bill USING btree (add_time)',true,false,false),
  ('user_bill','ub_pm',ARRAY['pm']::text[],'CREATE INDEX ub_pm ON public.user_bill USING btree (pm)',true,false,false),
  ('user_bill','ub_cat_type_link_idx',ARRAY['category','type','link_id']::text[],'CREATE INDEX ub_cat_type_link_idx ON public.user_bill USING btree (category, type, link_id)',true,false,false),
  ('user_bill','ub_event_key',ARRAY['event_key']::text[],'CREATE INDEX ub_event_key ON public.user_bill USING btree (event_key)',true,false,false),
  ('user_bill','ub_offline_integral_uq',ARRAY['uid','link_id']::text[],'CREATE UNIQUE INDEX ub_offline_integral_uq ON public.user_bill USING btree (uid, link_id) WHERE ((event_key)::text = ''offline_order_give_integral''::text)',true,true,false),
  ('user_bill','ub_order_reward_uq',ARRAY['uid','link_id','event_key']::text[],'CREATE UNIQUE INDEX ub_order_reward_uq ON public.user_bill USING btree (uid, link_id, event_key) WHERE ((event_key)::text = ANY ((ARRAY[''pay_give_integral''::character varying, ''order_give_integral''::character varying, ''order_give_exp''::character varying])::text[]))',true,true,false),
  ('user_bill','ub_out_request_uq',ARRAY['uid','link_id','event_key']::text[],'CREATE UNIQUE INDEX ub_out_request_uq ON public.user_bill USING btree (uid, link_id, event_key) WHERE (((event_key)::text = ANY ((ARRAY[''out_system_add_integral''::character varying, ''out_system_sub_integral''::character varying])::text[])) AND ((link_id)::text ~ ''^[0-9a-f]{32}$''::text))',true,true,false),
  ('user_bill','ub_order_promotion_gift_uq',ARRAY['uid','link_id','event_key']::text[],'CREATE UNIQUE INDEX ub_order_promotion_gift_uq ON public.user_bill USING btree (uid, link_id, event_key) WHERE ((event_key)::text = ''order_promotions_give_integral''::text)',false,true,false)),
 targets AS(SELECT c.oid,c.relname FROM pg_catalog.pg_class c
  WHERE c.oid IN('public.user'::regclass,'public.user_bill'::regclass)),
 actual_columns AS MATERIALIZED(SELECT t.relname AS table_name,a.* FROM targets t
  JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped),
 actual_constraints AS MATERIALIZED(SELECT t.relname AS table_name,k.* FROM targets t
  JOIN pg_catalog.pg_constraint k ON k.conrelid=t.oid),
 actual_indexes AS MATERIALIZED(SELECT t.relname AS table_name,i.*,c.relname AS name,c.relnamespace,c.relowner,
  c.relkind,c.relpersistence,c.reloptions,c.relacl,c.reltablespace,c.relam,m.amname
  FROM targets t JOIN pg_catalog.pg_index i ON i.indrelid=t.oid
  JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_am m ON m.oid=c.relam),
 known_user_fk AS MATERIALIZED(SELECT k.* FROM pg_catalog.pg_constraint k
  WHERE k.conrelid=pg_catalog.to_regclass('public.offline_order_admission') AND k.conname='ooa_user_fk'),
 ri_protocol AS MATERIALIZED(SELECT k.oid AS constraint_oid,k.conindid AS index_oid,p.event_type,p.referenced_side,
  CASE WHEN p.referenced_side THEN k.confrelid ELSE k.conrelid END AS own_relation,
  CASE WHEN p.referenced_side THEN k.conrelid ELSE k.confrelid END AS other_relation,
  f.oid AS function_oid,p.function_name,
  f.pronamespace='pg_catalog'::regnamespace AND f.proname=p.function_name AND f.prosrc=p.function_name
   AND f.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='internal') AND f.prokind='f'
   AND f.pronargs=0 AND f.proargtypes::text='' AND f.prorettype='pg_catalog.trigger'::regtype
   AND f.provolatile='v' AND f.proisstrict AND NOT f.proretset AND NOT f.prosecdef AND NOT f.proleakproof
   AND f.probin IS NULL AND f.prosqlbody IS NULL AND f.proconfig IS NULL AND f.prosupport=0 AS function_safe
  FROM known_user_fk k CROSS JOIN(VALUES(5,false,1644::oid,'RI_FKey_check_ins'),(17,false,1645::oid,'RI_FKey_check_upd'),
   (9,true,1648::oid,'RI_FKey_restrict_del'),(17,true,1655::oid,'RI_FKey_noaction_upd')) p(event_type,referenced_side,function_oid,function_name)
  JOIN pg_catalog.pg_proc f ON f.oid=p.function_oid)
 SELECT NOT EXISTS(SELECT 1 FROM expected_columns e FULL JOIN actual_columns a ON a.table_name=e.table_name AND a.attname=e.name
  WHERE e.name IS NULL OR a.attnum IS NULL OR a.attisdropped OR NOT a.attislocal OR a.attinhcount<>0
   OR pg_catalog.format_type(a.atttypid,a.atttypmod)<>e.typ OR a.attnotnull<>e.required
   OR a.attidentity<>'' OR a.attgenerated<>''
   OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_type p WHERE p.oid=a.atttypid AND p.typnamespace='pg_catalog'::regnamespace AND p.typtype='b')
   OR a.attcollation<>(SELECT typcollation FROM pg_catalog.pg_type WHERE oid=a.atttypid))
 AND NOT EXISTS(SELECT 1 FROM expected_constraints e FULL JOIN actual_constraints k ON k.table_name=e.table_name AND k.conname=e.name
  WHERE e.name IS NULL OR k.oid IS NULL OR k.contype::text<>e.kind OR k.convalidated<>e.validated OR k.condeferrable OR k.condeferred
   OR NOT k.conislocal OR k.coninhcount<>0 OR k.conparentid<>0 OR pg_catalog.pg_get_constraintdef(k.oid,false)<>e.definition
   OR ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(k.conkey) WITH ORDINALITY AS z(attnum,ordinal_position)
    JOIN pg_catalog.pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=z.attnum ORDER BY z.ordinal_position)<>e.column_names
   OR e.kind='p' AND NOT EXISTS(SELECT 1 FROM actual_indexes i WHERE i.indexrelid=k.conindid AND i.name=e.name AND i.indisprimary))
 AND NOT EXISTS(SELECT 1 FROM expected_indexes e FULL JOIN actual_indexes i ON i.table_name=e.table_name AND i.name=e.name
  WHERE e.name IS NULL OR i.indexrelid IS NULL AND e.required
   OR i.indexrelid IS NOT NULL AND (i.relowner<>${proof.scope.maintenanceOid}::oid OR i.relnamespace<>'public'::regnamespace
    OR i.relkind<>'i' OR i.relpersistence<>'p' OR i.reloptions IS NOT NULL OR i.relacl IS NOT NULL OR i.reltablespace<>0 OR i.amname<>'btree'
    OR NOT i.indisvalid OR NOT i.indisready OR NOT i.indislive OR NOT i.indimmediate OR i.indisexclusion OR i.indnullsnotdistinct
    OR i.indisreplident OR i.indisclustered OR i.indisunique<>e.is_unique OR i.indisprimary<>e.is_primary OR i.indexprs IS NOT NULL
    OR i.indnkeyatts<>i.indnatts OR i.indnatts<>pg_catalog.cardinality(e.column_names) OR pg_catalog.pg_get_indexdef(i.indexrelid)<>e.definition
    OR ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(i.indkey::smallint[]) WITH ORDINALITY AS z(attnum,ordinal_position)
     JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=z.attnum ORDER BY z.ordinal_position)<>e.column_names
    OR NOT e.is_primary AND EXISTS(SELECT 1 FROM actual_constraints k WHERE k.conindid=i.indexrelid)
    OR EXISTS(SELECT 1 FROM ROWS FROM(pg_catalog.unnest(i.indkey::smallint[]),pg_catalog.unnest(i.indclass::oid[]),
      pg_catalog.unnest(i.indcollation::oid[]),pg_catalog.unnest(i.indoption::smallint[])) AS z(attnum,opclass,index_collation,options)
     LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=z.attnum
     LEFT JOIN pg_catalog.pg_opclass o ON o.oid=z.opclass
     WHERE a.attnum IS NULL OR o.opcnamespace IS DISTINCT FROM 'pg_catalog'::regnamespace OR o.opcmethod IS DISTINCT FROM i.relam
      OR NOT o.opcdefault OR o.opcname IS DISTINCT FROM CASE a.atttypid
       WHEN 'pg_catalog.int4'::regtype THEN 'int4_ops' WHEN 'pg_catalog.int2'::regtype THEN 'int2_ops'
       WHEN 'pg_catalog.varchar'::regtype THEN 'text_ops' WHEN 'pg_catalog.numeric'::regtype THEN 'numeric_ops'
       WHEN 'pg_catalog.timestamp'::regtype THEN 'timestamp_ops' END
      OR z.index_collation<>a.attcollation OR z.options<>0)))
 -- Only INSERT triggers can execute for this bill writer. Legacy incoming
 -- RI and offline bill UPDATE/DELETE/TRUNCATE guards are not INSERT permits.
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid='public.user_bill'::regclass AND (g.tgtype::integer & 4)<>0)
 AND (SELECT count(*)=1 FROM known_user_fk)
 AND NOT EXISTS(SELECT 1 FROM known_user_fk k WHERE k.contype<>'f' OR k.contypid<>0 OR NOT k.connoinherit
  OR k.confrelid<>'public.user'::regclass OR NOT k.convalidated OR k.condeferrable OR k.condeferred
  OR NOT k.conislocal OR k.coninhcount<>0 OR k.conparentid<>0 OR k.confupdtype<>'a' OR k.confdeltype<>'r' OR k.confmatchtype<>'s'
  OR k.confdelsetcols IS NOT NULL OR k.conexclop IS NOT NULL OR k.conbin IS NOT NULL
  OR k.conkey IS DISTINCT FROM ARRAY[(SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=k.conrelid AND attname='uid' AND NOT attisdropped)]::smallint[]
  OR k.confkey IS DISTINCT FROM ARRAY[(SELECT attnum FROM actual_columns WHERE table_name='user' AND attname='uid')]::smallint[]
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname='uid'
   WHERE c.oid=k.conrelid AND c.relowner=${proof.scope.maintenanceOid}::oid AND c.relkind='r' AND c.relpersistence='p'
    AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND c.reloptions IS NULL
    AND a.attnum>0 AND NOT a.attisdropped AND a.atttypid='pg_catalog.int4'::regtype AND a.attnotnull AND a.attidentity='' AND a.attgenerated='')
  OR k.conindid IS DISTINCT FROM(SELECT indexrelid FROM actual_indexes WHERE table_name='user' AND name='user_pkey')
  OR k.conpfeqop IS DISTINCT FROM ARRAY[96::oid] OR k.conppeqop IS DISTINCT FROM ARRAY[96::oid] OR k.conffeqop IS DISTINCT FROM ARRAY[96::oid]
  OR (SELECT count(*) FROM pg_catalog.pg_trigger g WHERE g.tgconstraint=k.oid)<>4)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_operator o JOIN pg_catalog.pg_proc p ON p.oid=o.oprcode
  WHERE o.oid=96 AND o.oprnamespace='pg_catalog'::regnamespace AND o.oprname='=' AND o.oprleft='pg_catalog.int4'::regtype
   AND o.oprright='pg_catalog.int4'::regtype AND p.pronamespace='pg_catalog'::regnamespace AND p.proname='int4eq'
   AND p.prosrc='int4eq' AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='internal'))
 AND (SELECT count(*)=4 AND bool_and(function_safe) FROM ri_protocol)
 AND NOT EXISTS(SELECT 1 FROM ri_protocol p WHERE(SELECT count(*) FROM pg_catalog.pg_trigger g
  WHERE g.tgconstraint=p.constraint_oid AND g.tgrelid=p.own_relation AND g.tgconstrrelid=p.other_relation
   AND g.tgconstrindid=p.index_oid AND g.tgfoid=p.function_oid AND g.tgtype=p.event_type AND g.tgisinternal AND g.tgenabled='O'
   AND g.tgparentid=0 AND NOT g.tgdeferrable AND NOT g.tginitdeferred AND g.tgnargs=0 AND pg_catalog.octet_length(g.tgargs)=0
   AND g.tgattr::text='' AND g.tgqual IS NULL AND g.tgoldtable IS NULL AND g.tgnewtable IS NULL
   AND (SELECT count(*) FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_trigger'::regclass AND d.objid=g.oid
    AND d.refclassid='pg_catalog.pg_constraint'::regclass)=1
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_trigger'::regclass AND d.objid=g.oid
    AND d.objsubid=0 AND d.refclassid='pg_catalog.pg_constraint'::regclass AND d.refobjid=p.constraint_oid AND d.refobjsubid=0 AND d.deptype='i'))<>1)
 -- Actual UPDATE changes only now_money. The one closed builtin RI update
 -- checks the unchanged int4 PK and returns without a referenced-row query.
 -- Unknown user UPDATE row/statement/constraint triggers remain forbidden.
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid='public.user'::regclass AND (g.tgtype::integer & 16)<>0
  AND NOT EXISTS(SELECT 1 FROM ri_protocol p WHERE p.referenced_side AND p.event_type=17
   AND g.tgconstraint=p.constraint_oid AND g.tgfoid=p.function_oid AND g.tgconstrrelid=p.other_relation
   AND g.tgconstrindid=p.index_oid)) AS ready`);
 if (r?.ready !== true) return fail();
}

async function universe(tx:DbClient,env:Signing,role:RechargeRefundRuntimeRole,h:RechargeRefundFirstProviderResult,local?:RechargeRefundRecord){
 const physical=await readRechargeRefundMixedProviderHistoryTx(tx,env,role,h.operation.operation_id,local?.result_id);
 const u=physical.universe,q=u.requestQueryHistory;
 if(u.disposition!=='terminal_evidence'||q.totalAttempts!==1||!same(q.scope,h.scope)||!same(q.operation,h.operation)
  ||!same(q.first.attempt,h.attempt)||!same(q.firstApproval,h.approval)||!q.results.some(row=>same(row.record,h.record))
  ||!same(physical.local,local??null))return fail();
 const [conflict] = await tx.execute<{ found: boolean }>(sql`SELECT
  EXISTS(SELECT 1 FROM public.capital_flow WHERE event_key=${'recharge.refund:' + String(h.operation.operation_id)}
   OR flow_id=${String(h.operation.operation_id).replaceAll('-', '')})
  OR EXISTS(SELECT 1 FROM public.store_order_outbox WHERE event_key=${'recharge.refund.success.notice:' + String(h.operation.operation_id)}) AS found`);
 if (!conflict || conflict.found !== false) return fail();
}

async function physicalReleaseBill(tx: DbClient, facts: RechargeRefundReleaseFacts) {
 const bills = await tx.select().from(userBill).where(or(eq(userBill.id, facts.bill.id), eq(userBill.eventKey, facts.bill.eventKey))).limit(3);
 const b = bills[0], f = facts.bill;
 if (bills.length !== 1 || b.id !== f.id || b.uid !== f.uid || b.linkId !== f.linkId || b.eventKey !== f.eventKey
  || b.pm !== f.pm || b.category !== f.category || b.type !== f.type || b.title !== f.title
  || rechargeRefundCents(b.number) !== f.numberCents || rechargeRefundCents(b.balance, true) !== f.balanceCents
  || b.status !== f.status || b.take !== f.take || b.frozenTime !== f.frozenTime || b.addTime !== f.addTime || b.mark !== f.mark) return fail();
}

async function replay(tx: DbClient, env: Signing, role: RechargeRefundRuntimeRole, h: RechargeRefundFirstProviderResult, state: RechargeRefundStateRow) {
 if (state.status !== 'FAILED' || state.wallet_state !== 'released' || !uuid(state.last_result_id)) return fail();
 const rows = await tx.execute(sql`SELECT * FROM public.recharge_refund_result
  WHERE operation_id=${h.operation.operation_id}::uuid AND result_id=${state.last_result_id}::uuid LIMIT 2`);
 if (rows.length !== 1) return fail();
 const parsed = parseRechargeRefundLocalReleaseResult(env, h.scope, historyInput(h), rows[0]);
 await universe(tx, env, role, h, parsed.record);
 const hold = await assertRechargeRefundHoldBillTx(tx, h.operation);
 if (hold.billId !== parsed.facts.holdBillId || state.version !== parsed.facts.projection.afterVersion
  || state.attempt_count !== 1 || state.provider_refund_id !== h.observation.providerRefundId || state.lease_id !== null
  || state.lease_until !== null || state.next_query_at !== null || state.updated_at !== parsed.facts.releasedAt) return fail();
 await physicalReleaseBill(tx, parsed.facts);
 return Object.freeze({ operationId: String(h.operation.operation_id), providerResultId: String(h.record.result_id),
  localResultId: String(parsed.record.result_id), releaseBillId: parsed.facts.bill.id, released: true as const, replayed: true });
}

/** Internal actual role only. The caller supplies no actor, amount, balance,
 * cause row or prevalidated proof. All inputs are physically reread. */
export async function releaseRechargeRefundClosedFirstResult(container: Container, inputEnv: Signing,
 role: RechargeRefundRuntimeRole, operationId: unknown, providerResultId: unknown) {
 if (!Object.hasOwn(container.db, '$client') || !['app', 'admin', 'financial'].includes(role)
  || !uuid(operationId) || !uuid(providerResultId)) return fail();
 const env: Signing = { APP_KEY: inputEnv.APP_KEY };
 return container.db.transaction(async raw => {
  const tx = raw as unknown as DbClient;
  await boundedContext(tx);
  await assertRechargeRefundRuntimeTx(tx, role, 'write');
  const initial = await readRechargeRefundOperationByIdTx(tx, env, role, operationId, 'write');
  if (initial.admission !== 'reserved') return fail();
  // This SELECT does not mint a terminal proof or acquire a business row lock.
  // It merely routes already recorded history away from fresh economic gates.
  const prior = await tx.execute(sql`SELECT result_id FROM public.recharge_refund_result
   WHERE operation_id=${operationId}::uuid AND source='local_release' LIMIT 1`);
  if (!prior.length) await freshCatalog(tx, role);
  await lockRechargeRefundKeyTx(tx, Number(initial.admin_id), initial.request_key);
  const op = await readRechargeRefundOperationByIdTx(tx, env, role, operationId, 'write');
  if (!same(initial, op)) return fail();
  const h = await readRechargeRefundFirstProviderResultTx(tx, env, role, operationId, providerResultId, 'write');
  if (!same(op, h.operation) || h.observation.status !== 'CLOSED') return fail();
  const recorded = await tx.execute(sql`SELECT result_id FROM public.recharge_refund_result
   WHERE operation_id=${operationId}::uuid AND source='local_release' LIMIT 1`);
  if (recorded.length) return finish(tx, await replay(tx, env, role, h, await readRechargeRefundStateTx(tx, op, false)));
  if (prior.length) return fail();
  const [locked] = await tx.execute<{ id: number }>(sql`SELECT public.recharge_refund_lock_source_v1(${op.recharge_id}::integer) AS id`);
  if (locked?.id !== op.recharge_id) return fail();
  const names = await tx.execute<{ domain: string; id: number }>(sql`SELECT 'recharge' AS domain,id FROM public.user_recharge WHERE order_id=${op.order_no}
   UNION ALL SELECT 'store_order',id FROM public.store_order WHERE order_id=${op.order_no}
   UNION ALL SELECT 'membership',id FROM public.other_order WHERE order_id=${op.order_no} LIMIT 2`);
  if (names.length !== 1 || names[0].domain !== 'recharge' || names[0].id !== op.recharge_id) return fail();
  await lockStoreOrderPaymentBoundary(tx, String(op.order_no));
  const source = await readRechargeRefundOperationHistoryTx(tx, env, role, operationId, 'write');
  if (!same(source.pinned.operation, op)) return fail();
  const settled = await readRechargePaidSettlementForRefundTx(tx, env, source.pinned.business, role);
  if (!same(settled.event.payload, source.pinned.firstSettlement) || rechargeRefundCents(settled.order.refundPrice) !== 0) return fail();
  const wallets = await tx.select({ uid: user.uid, nowMoney: user.nowMoney, isDel: user.isDel, deleteTime: user.deleteTime }).from(user)
   .where(eq(user.uid, Number(op.buyer_uid))).limit(2).for('update', { noWait: true });
  const wallet = wallets[0];
  if (wallets.length !== 1 || wallet.uid !== op.buyer_uid || wallet.isDel !== 0 || wallet.deleteTime !== null) return fail();
  const state = await readRechargeRefundStateTx(tx, op), hold = await assertRechargeRefundHoldBillTx(tx, op);
  await universe(tx, env, role, h);
  if (hold.billId !== h.request.holdBillId || state.status !== 'SUBMITTING' || state.wallet_state !== 'held' || state.version !== 1
   || state.attempt_count !== 1 || state.lease_id !== h.request.leaseId || state.lease_until !== h.request.leaseUntil
   || state.next_query_at !== h.request.issuedAt + 60 || state.provider_refund_id !== null || state.last_result_id !== null
   || state.updated_at !== h.request.issuedAt) return fail();
  const existing = await tx.select({ id: userBill.id }).from(userBill)
   .where(eq(userBill.eventKey, 'recharge_refund_release:' + operationId)).limit(2);
  if (existing.length) return fail();
  const before = rechargeRefundCents(wallet.nowMoney, true), after = before + Number(op.debit_cents), balance = rechargeRefundDecimal(after);
  const [clock] = await tx.execute<{ now: string }>(sql`SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint AS now`);
  const now = Number(clock?.now);
  if (!Number.isSafeInteger(now) || now < Number(op.created_at) || now < state.updated_at || now < h.observation.observedAt - 1 || now > 2147483647) return fail();
  // This is the actual author's one bill-ID allocation, not a prerequisite
  // probe. nextval retains the sequence ROW EXCLUSIVE lock to TX end; ALTER
  // SEQUENCE/OWNED BY/CACHE must not race the final physical recheck. Rollback
  // may leave a normal sequence gap, never a credited wallet or bill.
  const [allocated] = await tx.execute<{ id: number }>(sql`SELECT pg_catalog.nextval('public.user_bill_id_seq'::regclass)::integer AS id`);
  if (!allocated || !Number.isInteger(allocated.id) || allocated.id < 1 || allocated.id > 2147483647) return fail();
  // Re-execute all actual catalog/ACL/write-footprint facts with wallet/state,
  // table DML locks and the actual allocated sequence lock already held.
  await freshCatalog(tx, role);
  const updated = await tx.update(user).set({ nowMoney: balance })
   .where(and(eq(user.uid, wallet.uid), eq(user.nowMoney, wallet.nowMoney))).returning({ uid: user.uid });
  if (updated.length !== 1) return fail();
  const bills = await tx.insert(userBill).values({ id: allocated.id, uid: wallet.uid, linkId: String(op.order_no),
   eventKey: 'recharge_refund_release:' + operationId, pm: 1, category: 'now_money', type: 'recharge_refund_release',
   title: '渠道关闭充值退款退回预留', number: rechargeRefundDecimal(Number(op.debit_cents)), balance, status: 1, take: 0,
   frozenTime: 0, addTime: now, mark: '渠道已确认关闭，退回原充值退款预留' }).returning();
  if (bills.length !== 1) return fail();
  const facts: RechargeRefundReleaseFacts = { format: 1, purpose: 'recharge-refund-closed-release-facts-v1', scope: h.scope,
   localResultId: randomUUID(), operation: { id: operationId, signature: String(op.signature), paymentSignature: String(op.payment_signature) },
   request: { attemptId: String(h.attempt.attempt_id), signature: String(h.attempt.signature), requestHash: String(h.attempt.request_hash) },
   provider: { resultId: providerResultId, signature: String(h.record.signature), refundId: h.observation.providerRefundId, observedAt: h.observation.observedAt },
   recharge: { id: Number(op.recharge_id), buyerUid: Number(op.buyer_uid), orderNo: String(op.order_no), transactionId: String(op.transaction_id),
    appId: h.request.approval.appId, merchantId: h.request.approval.merchantId, principalCents: Number(op.principal_cents), giftCents: Number(op.gift_cents),
    reclaimGift: Boolean(op.reclaim_gift), debitCents: Number(op.debit_cents), refundBeforeCents: 0, refundAfterCents: 0 },
   holdBillId: hold.billId, wallet: { beforeCents: before, afterCents: after },
   bill: { id: bills[0].id, uid: wallet.uid, linkId: String(op.order_no), eventKey: 'recharge_refund_release:' + operationId,
    pm: 1, category: 'now_money', type: 'recharge_refund_release', title: '渠道关闭充值退款退回预留', numberCents: Number(op.debit_cents),
    balanceCents: after, status: 1, take: 0, frozenTime: 0, addTime: now, mark: '渠道已确认关闭，退回原充值退款预留' },
   projection: { beforeVersion: state.version, afterVersion: state.version + 1 }, releasedAt: now };
  await physicalReleaseBill(tx, facts);
  const signed = signRechargeRefundLocalReleaseResult(env, h.scope, historyInput(h), facts), { signature: _signature, ...unsigned } = signed;
  const local = await insertRechargeRefundEvidenceTx(tx, env, role, 'recharge_refund_result', unsigned);
  if (local.signature !== signed.signature) return fail();
  const changed = await tx.execute(sql`UPDATE public.recharge_refund_state SET status='FAILED',wallet_state='released',version=2,
   lease_id=NULL,lease_until=NULL,next_query_at=NULL,provider_refund_id=${h.observation.providerRefundId},
   last_result_id=${local.result_id}::uuid,updated_at=${now}
   WHERE operation_id=${operationId}::uuid AND status='SUBMITTING' AND wallet_state='held' AND version=1 AND attempt_count=1
    AND lease_id=${h.request.leaseId}::uuid AND lease_until=${h.request.leaseUntil} AND next_query_at=${h.request.issuedAt + 60}
    AND provider_refund_id IS NULL AND last_result_id IS NULL AND updated_at=${state.updated_at} RETURNING operation_id`);
  if (changed.length !== 1 || changed[0].operation_id !== operationId) return fail();
  const verified = await replay(tx, env, role, h, await readRechargeRefundStateTx(tx, op, false));
  return finish(tx, Object.freeze({ ...verified, replayed: false }));
 }, { isolationLevel: 'read committed', accessMode: 'read write' });
}

/** Same exact physical write footprint for the separate query CLOSED author. */
export { freshCatalog as assertRechargeRefundReleaseWritePrerequisitesTx };
