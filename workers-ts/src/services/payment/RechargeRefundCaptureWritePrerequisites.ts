/** Fresh catalog/ACL/write-footprint prerequisite only. No provider/history
 * proof, capture receipt, financial write, notice row or reusable authority is
 * minted. Never call this guard merely to retain/read external provider truth. */
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { assertRechargeRefundRuntimeTx,type RechargeRefundRuntimeRole } from '@/migrations/rechargeRefund';
import { prepareRechargeRefundNoticeTx } from '@/migrations/rechargeRefundNotice';
import { RECHARGE_REFUND_NOTICE_GENERATIONS } from '@/migrations/paidNotice';
import { ServiceUnavailableException } from '@/utils/errors';
import { assertRechargeRefundEconomicPrerequisitesTx,assertRechargeRefundEconomicResolutionTx } from './RechargeRefundEconomicPrerequisites';

const fail=(reason:string):never=>{throw Object.assign(new ServiceUnavailableException('充值退款成功结算写入目录需要人工核对'),{capturePrerequisite:reason});};
const literal=(s:string)=>"'"+s.replaceAll("'","''")+"'";
const strings=(s:readonly string[])=>'ARRAY['+s.map(literal).join(',')+']::text[]';
// Explicit source-derived inventory; no regex/cast/parenthesis normalization,
// target-learned facts, caller-provided ready object or cross-await memo.
const columns:readonly (readonly [string,string,string,boolean,readonly string[]|null])[] = [
 ["user_recharge", "id", "integer", true, null],
 ["user_recharge", "store_id", "integer", true, ["0"]],
 ["user_recharge", "uid", "integer", true, ["0"]],
 ["user_recharge", "staff_id", "integer", true, ["0"]],
 ["user_recharge", "order_id", "character varying(32)", true, ["''::character varying"]],
 ["user_recharge", "trade_no", "character varying(100)", true, ["''::character varying"]],
 ["user_recharge", "price", "numeric(12,2)", true, ["0.00"]],
 ["user_recharge", "give_price", "numeric(12,2)", true, ["0.00"]],
 ["user_recharge", "recharge_type", "character varying(32)", true, ["''::character varying"]],
 ["user_recharge", "auth_code", "character varying(50)", true, ["''::character varying"]],
 ["user_recharge", "paid", "smallint", true, ["0", "(0)::smallint", "'0'::smallint"]],
 ["user_recharge", "pay_time", "integer", true, ["0"]],
 ["user_recharge", "add_time", "integer", true, ["0"]],
 ["user_recharge", "refund_price", "numeric(12,2)", true, ["0.00"]],
 ["user_recharge", "channel_type", "character varying(255)", true, ["''::character varying"]],
 ["user_recharge", "remarks", "character varying(255)", true, ["''::character varying"]],
 ["capital_flow", "id", "integer", true, null],
 ["capital_flow", "event_key", "character varying(128)", false, []],
 ["capital_flow", "flow_id", "character varying(32)", true, ["''::character varying"]],
 ["capital_flow", "order_id", "character varying(50)", true, ["''::character varying"]],
 ["capital_flow", "store_id", "integer", true, ["0"]],
 ["capital_flow", "uid", "integer", true, ["0"]],
 ["capital_flow", "nickname", "character varying(255)", true, ["''::character varying"]],
 ["capital_flow", "phone", "character varying(20)", true, ["''::character varying"]],
 ["capital_flow", "price", "numeric(12,2)", true, ["0.00"]],
 ["capital_flow", "trading_type", "smallint", true, ["0", "(0)::smallint", "'0'::smallint"]],
 ["capital_flow", "pay_type", "character varying(32)", true, ["''::character varying"]],
 ["capital_flow", "mark", "character varying(500)", true, ["''::character varying"]],
 ["capital_flow", "add_time", "integer", true, ["0"]],
 ["store_order_outbox", "id", "integer", true, null],
 ["store_order_outbox", "event_key", "character varying(128)", true, []],
 ["store_order_outbox", "aggregate_type", "character varying(32)", true, ["'order'::character varying"]],
 ["store_order_outbox", "aggregate_id", "integer", true, []],
 ["store_order_outbox", "event_type", "character varying(64)", true, []],
 ["store_order_outbox", "payload", "jsonb", true, ["'{}'::jsonb"]],
 ["store_order_outbox", "status", "character varying(16)", true, ["'PENDING'::character varying"]],
 ["store_order_outbox", "dispatch_count", "integer", true, ["0"]],
 ["store_order_outbox", "attempt_count", "integer", true, ["0"]],
 ["store_order_outbox", "replay_count", "integer", true, ["0"]],
 ["store_order_outbox", "available_time", "integer", true, ["0"]],
 ["store_order_outbox", "lease_until", "integer", true, ["0"]],
 ["store_order_outbox", "lease_token", "character varying(36)", true, ["''::character varying"]],
 ["store_order_outbox", "last_error", "character varying(1000)", true, ["''::character varying"]],
 ["store_order_outbox", "enqueued_time", "integer", true, ["0"]],
 ["store_order_outbox", "processed_time", "integer", true, ["0"]],
 ["store_order_outbox", "add_time", "integer", true, ["0"]],
 ["store_order_outbox", "update_time", "integer", true, ["0"]]
];
const indexes:readonly (readonly [string,string,readonly string[],string,boolean,boolean])[] = [
 ["user_recharge", "user_recharge_pkey", ["id"], "CREATE UNIQUE INDEX user_recharge_pkey ON public.user_recharge USING btree (id)", true, true],
 ["capital_flow", "capital_flow_pkey", ["id"], "CREATE UNIQUE INDEX capital_flow_pkey ON public.capital_flow USING btree (id)", true, true],
 ["store_order_outbox", "store_order_outbox_pkey", ["id"], "CREATE UNIQUE INDEX store_order_outbox_pkey ON public.store_order_outbox USING btree (id)", true, true],
 ["user_recharge", "ur_order_id_idx", ["order_id"], "CREATE UNIQUE INDEX ur_order_id_idx ON public.user_recharge USING btree (order_id)", true, false],
 ["user_recharge", "ur_order_id_lookup", ["order_id"], "CREATE INDEX ur_order_id_lookup ON public.user_recharge USING btree (order_id)", false, false],
 ["user_recharge", "ur_uid", ["uid"], "CREATE INDEX ur_uid ON public.user_recharge USING btree (uid)", false, false],
 ["user_recharge", "ur_uid_paid_time", ["uid", "paid", "add_time", "id"], "CREATE INDEX ur_uid_paid_time ON public.user_recharge USING btree (uid, paid, add_time, id)", false, false],
 ["capital_flow", "cf_event_key_uq", ["event_key"], "CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow USING btree (event_key)", true, false],
 ["capital_flow", "cf_flow_id", ["flow_id"], "CREATE INDEX cf_flow_id ON public.capital_flow USING btree (flow_id)", false, false],
 ["capital_flow", "cf_order_id", ["order_id"], "CREATE INDEX cf_order_id ON public.capital_flow USING btree (order_id)", false, false],
 ["capital_flow", "cf_uid_type_time", ["uid", "trading_type", "add_time", "id"], "CREATE INDEX cf_uid_type_time ON public.capital_flow USING btree (uid, trading_type, add_time, id)", false, false],
 ["capital_flow", "cf_type_time", ["trading_type", "add_time", "id"], "CREATE INDEX cf_type_time ON public.capital_flow USING btree (trading_type, add_time, id)", false, false],
 ["capital_flow", "cf_store_time", ["store_id", "add_time", "id"], "CREATE INDEX cf_store_time ON public.capital_flow USING btree (store_id, add_time, id)", false, false],
 ["store_order_outbox", "soob_event_key_uq", ["event_key"], "CREATE UNIQUE INDEX soob_event_key_uq ON public.store_order_outbox USING btree (event_key)", true, false],
 ["store_order_outbox", "soob_aggregate", ["aggregate_type", "aggregate_id"], "CREATE INDEX soob_aggregate ON public.store_order_outbox USING btree (aggregate_type, aggregate_id)", false, false],
 ["store_order_outbox", "soob_dispatch_ready", ["available_time", "id"], "CREATE INDEX soob_dispatch_ready ON public.store_order_outbox USING btree (available_time, id) WHERE ((status)::text = ANY ((ARRAY['PENDING'::character varying, 'FAILED'::character varying])::text[]))", false, false],
 ["store_order_outbox", "soob_expired_lease", ["lease_until", "id"], "CREATE INDEX soob_expired_lease ON public.store_order_outbox USING btree (lease_until, id) WHERE ((status)::text = ANY ((ARRAY['ENQUEUING'::character varying, 'ENQUEUED'::character varying, 'PROCESSING'::character varying])::text[]))", false, false]
];
const constraints:readonly (readonly [string,string,string,readonly string[]|null,readonly string[]])[] = [
 ["user_recharge", "user_recharge_pkey", "p", ["PRIMARY KEY (id)"], ["id"]],
 ["capital_flow", "capital_flow_pkey", "p", ["PRIMARY KEY (id)"], ["id"]],
 ["store_order_outbox", "store_order_outbox_pkey", "p", ["PRIMARY KEY (id)"], ["id"]],
 ["store_order_outbox", "soob_event_type_ck", "c", null, ["event_type"]],
 ["store_order_outbox", "soob_status_ck", "c", ["CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'ENQUEUING'::character varying, 'ENQUEUED'::character varying, 'PROCESSING'::character varying, 'COMPLETED'::character varying, 'FAILED'::character varying, 'DEAD'::character varying])::text[])))"], ["status"]],
 ["store_order_outbox", "soob_count_ck", "c", ["CHECK (((dispatch_count >= 0) AND (attempt_count >= 0) AND (replay_count >= 0)))"], ["dispatch_count", "attempt_count", "replay_count"]],
 ["store_order_outbox", "soob_time_ck", "c", ["CHECK (((available_time >= 0) AND (lease_until >= 0)))"], ["available_time", "lease_until"]]
];
const columnRows=columns.map(([t,n,typ,required,defaults])=>`(${literal(t)},${literal(n)},${literal(typ)},${required},${defaults===null?'NULL::text[]':strings(defaults)})`).join(',');
const indexRows=indexes.map(([t,n,names,definition,unique,primary])=>`(${literal(t)},${literal(n)},${strings(names)},${literal(definition)},${unique},${primary})`).join(',');
const constraintRows=constraints.map(([t,n,kind,definitions,names])=>`(${literal(t)},${literal(n)},${literal(kind)},${strings(definitions??RECHARGE_REFUND_NOTICE_GENERATIONS.map(g=>g.definition))},${strings(names)})`).join(',');

/** `allocated` only requests an EXTRA actual pg_locks proof. It is not evidence
 * in its own right. The caller still allocates two IDs itself with fixed real
 * nextval calls, then reruns every actual fact in this same owning transaction.
 * This function never consumes a sequence, writes a row or grants a privilege. */
export async function assertRechargeRefundCaptureWritePrerequisitesTx(tx:DbClient,role:RechargeRefundRuntimeRole,
 phase:'preflight'|'allocated'='preflight') {
 if(Object.hasOwn(tx,'$client')||!['app','admin','financial'].includes(role)||!['preflight','allocated'].includes(phase))return fail('transaction');
 const [context]=await tx.execute<{ready:boolean}>(sql`SELECT current_user=session_user
  AND pg_catalog.current_setting('role')='none' AND pg_catalog.current_schema()='public'
  AND (pg_catalog.current_schemas(true))[1]='pg_catalog'
  AND pg_catalog.current_setting('transaction_isolation')='read committed'
  AND pg_catalog.current_setting('transaction_read_only')='off' AND pg_catalog.current_setting('session_replication_role')='origin'
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_settings WHERE name='statement_timeout' AND setting::bigint BETWEEN 1 AND 5000)
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_settings WHERE name='lock_timeout' AND setting::bigint BETWEEN 1 AND 1000)
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout' AND setting::bigint BETWEEN 1 AND 5000) AS ready`);
 if(context?.ready!==true)return fail('context');
 await assertRechargeRefundRuntimeTx(tx,role,'write');
 await assertRechargeRefundEconomicResolutionTx(tx);
 // Fixed table order before admin/key/source/payment/wallet/state row locks.
 // If an actual column-only role cannot take ROW EXCLUSIVE, refuse; never use
 // dummy UPDATE (which could execute an unknown statement trigger) or GRANT.
 if(!await prepareRechargeRefundNoticeTx(tx))return fail('notice_inactive');
 await tx.execute(sql`LOCK TABLE ONLY public.user_recharge IN ROW EXCLUSIVE MODE NOWAIT`);
 await tx.execute(sql`LOCK TABLE ONLY public.capital_flow IN ROW EXCLUSIVE MODE NOWAIT`);
 const proof=await assertRechargeRefundEconomicPrerequisitesTx(tx,role,'write');
 const rows=await tx.execute<{columns_ready:boolean;constraints_ready:boolean;indexes_ready:boolean;relations_ready:boolean;
  serial_ready:boolean;locks_ready:boolean;allocated_ready:boolean;flow_sequence_oid:string;outbox_sequence_oid:string}>(sql`WITH
 expected_columns(table_name,name,typ,required,defaults) AS(VALUES ${sql.raw(columnRows)}),
 expected_constraints(table_name,name,kind,definitions,column_names) AS(VALUES ${sql.raw(constraintRows)}),
 expected_indexes(table_name,name,column_names,definition,is_unique,is_primary) AS(VALUES ${sql.raw(indexRows)}),
 targets AS MATERIALIZED(SELECT c.* FROM pg_catalog.pg_class c WHERE c.oid IN
  (pg_catalog.to_regclass('public.user_recharge'),pg_catalog.to_regclass('public.capital_flow'),pg_catalog.to_regclass('public.store_order_outbox'))),
 attrs AS MATERIALIZED(SELECT t.relname AS table_name,a.*,d.oid AS default_oid,pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS initial
  FROM targets t JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum),
 actual_constraints AS MATERIALIZED(SELECT t.relname AS table_name,k.* FROM targets t JOIN pg_catalog.pg_constraint k ON k.conrelid=t.oid),
 actual_indexes AS MATERIALIZED(SELECT t.relname AS table_name,i.*,c.relname AS name,c.relnamespace,c.relowner,c.relkind,
  c.relpersistence,c.reloptions,c.relacl,c.reltablespace,c.relam,m.amname FROM targets t
  JOIN pg_catalog.pg_index i ON i.indrelid=t.oid JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_am m ON m.oid=c.relam),
 serial_facts AS MATERIALIZED(SELECT t.relname AS table_name,t.oid AS table_oid,t.relowner AS table_owner,a.attnum,a.default_oid,a.initial,
  s.oid AS sequence_oid,s.relname AS sequence_name,s.relowner,s.relkind,s.relpersistence,s.reloptions,
  q.seqtypid,q.seqstart,q.seqincrement,q.seqmin,q.seqmax,q.seqcache,q.seqcycle
  FROM targets t JOIN attrs a ON a.attrelid=t.oid AND a.attname='id'
  LEFT JOIN pg_catalog.pg_class s ON s.oid=pg_catalog.to_regclass('public.'||t.relname||'_id_seq')
  LEFT JOIN pg_catalog.pg_sequence q ON q.seqrelid=s.oid)
 SELECT NOT EXISTS(SELECT 1 FROM expected_columns e FULL JOIN attrs a ON a.table_name=e.table_name AND a.attname=e.name
  WHERE e.name IS NULL OR a.attnum IS NULL OR NOT a.attislocal OR a.attinhcount<>0
   OR pg_catalog.format_type(a.atttypid,a.atttypmod)<>e.typ OR a.attnotnull<>e.required OR a.attidentity<>'' OR a.attgenerated<>''
   OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_type p WHERE p.oid=a.atttypid AND p.typnamespace='pg_catalog'::regnamespace AND p.typtype='b')
   OR a.attcollation<>(SELECT typcollation FROM pg_catalog.pg_type WHERE oid=a.atttypid)
   OR(e.defaults IS NOT NULL AND CASE WHEN pg_catalog.cardinality(e.defaults)=0 THEN a.default_oid IS NOT NULL
    ELSE a.initial IS NULL OR NOT(a.initial=ANY(e.defaults)) END)) AS columns_ready,
 NOT EXISTS(SELECT 1 FROM expected_constraints e FULL JOIN actual_constraints k ON k.table_name=e.table_name AND k.conname=e.name
  WHERE e.name IS NULL OR k.oid IS NULL OR k.contype::text<>e.kind OR NOT k.convalidated OR k.condeferrable OR k.condeferred
   OR NOT k.conislocal OR k.coninhcount<>0 OR k.conparentid<>0 OR(e.kind='c' AND k.connoinherit)
   OR NOT(pg_catalog.pg_get_constraintdef(k.oid,false)=ANY(e.definitions))
   OR ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(k.conkey) WITH ORDINALITY AS z(attnum,ordinal_position)
    JOIN pg_catalog.pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=z.attnum ORDER BY z.ordinal_position)<>e.column_names
   OR e.kind='p' AND NOT EXISTS(SELECT 1 FROM actual_indexes i WHERE i.indexrelid=k.conindid AND i.name=e.name AND i.indisprimary)) AS constraints_ready,
 NOT EXISTS(SELECT 1 FROM expected_indexes e FULL JOIN actual_indexes i ON i.table_name=e.table_name AND i.name=e.name
  WHERE e.name IS NULL OR i.indexrelid IS NULL OR i.relowner<>${proof.scope.maintenanceOid}::oid OR i.relnamespace<>'public'::regnamespace
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
      WHEN 'pg_catalog.varchar'::regtype THEN 'text_ops' WHEN 'pg_catalog.numeric'::regtype THEN 'numeric_ops' END
     OR z.index_collation IS DISTINCT FROM a.attcollation OR z.options<>0)) AS indexes_ready,
 (SELECT count(*)=3 AND bool_and(t.relowner=${proof.scope.maintenanceOid}::oid AND t.relkind='r' AND t.relpersistence='p'
  AND NOT t.relispartition AND NOT t.relrowsecurity AND NOT t.relforcerowsecurity AND t.reloptions IS NULL AND t.relreplident='d'
  AND t.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhparent=t.oid OR inhrelid=t.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=t.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=t.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=t.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid=t.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=t.oid AND d.deptype='e')) FROM targets t) AS relations_ready,
 (SELECT count(*)=3 AND bool_and(s.sequence_oid IS NOT NULL AND s.relowner=s.table_owner AND s.relkind='S' AND s.relpersistence='p' AND s.reloptions IS NULL
  AND s.seqtypid='pg_catalog.int4'::regtype AND s.seqstart=1 AND s.seqincrement=1 AND s.seqmin=1 AND s.seqmax=2147483647 AND s.seqcache=1 AND NOT s.seqcycle
  AND s.initial IN('nextval('''||s.sequence_name||'''::regclass)','nextval(''public.'||s.sequence_name||'''::regclass)')
  AND pg_catalog.pg_get_serial_sequence('public.'||s.table_name,'id')::regclass::oid=s.sequence_oid
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=s.sequence_oid AND d.deptype='e')
  AND (SELECT count(*)=1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=s.sequence_oid
   AND d.objsubid=0 AND d.refclassid='pg_catalog.pg_class'::regclass AND d.refobjid=s.table_oid AND d.refobjsubid=s.attnum AND d.deptype='a')
  AND (SELECT count(*)=1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=s.sequence_oid AND d.deptype IN('a','i'))
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_attrdef'::regclass AND d.objid=s.default_oid
   AND d.refclassid='pg_catalog.pg_class'::regclass AND d.refobjid=s.sequence_oid AND d.refobjsubid=0 AND d.deptype='n')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_attrdef'::regclass AND d.objid=s.default_oid
   AND d.deptype='n' AND NOT(d.refclassid='pg_catalog.pg_class'::regclass AND d.refobjid=s.sequence_oid AND d.refobjsubid=0))) FROM serial_facts s) AS serial_ready,
 (SELECT count(*)=3 AND bool_and(EXISTS(SELECT 1 FROM pg_catalog.pg_locks l WHERE l.pid=pg_catalog.pg_backend_pid()
  AND l.locktype='relation' AND l.database=${proof.scope.databaseOid}::oid AND l.relation=t.oid AND l.mode='RowExclusiveLock' AND l.granted)) FROM targets t) AS locks_ready,
 ${phase}='preflight' OR(SELECT count(*)=2 AND bool_and(EXISTS(SELECT 1 FROM pg_catalog.pg_locks l WHERE l.pid=pg_catalog.pg_backend_pid()
  AND l.locktype='relation' AND l.database=${proof.scope.databaseOid}::oid AND l.relation=s.sequence_oid AND l.mode='RowExclusiveLock' AND l.granted))
  FROM serial_facts s WHERE s.table_name IN('capital_flow','store_order_outbox')) AS allocated_ready,
 (SELECT sequence_oid::text FROM serial_facts WHERE table_name='capital_flow') AS flow_sequence_oid,
 (SELECT sequence_oid::text FROM serial_facts WHERE table_name='store_order_outbox') AS outbox_sequence_oid`);
 const r=rows[0];if(rows.length!==1||!r)return fail('catalog_rows');
 for(const key of ['columns_ready','constraints_ready','indexes_ready','relations_ready','serial_ready','locks_ready','allocated_ready'] as const)
  if(r[key]!==true)return fail(key);
 if(!/^[1-9]\d*$/u.test(r.flow_sequence_oid)||! /^[1-9]\d*$/u.test(r.outbox_sequence_oid))return fail('sequence_oids');
 return Object.freeze({scope:proof.scope,flowSequenceOid:r.flow_sequence_oid,outboxSequenceOid:r.outbox_sequence_oid});
}
