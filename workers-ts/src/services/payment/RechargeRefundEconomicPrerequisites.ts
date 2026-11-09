/** Read-only, fresh prerequisites for a future recharge money author. This
 * grants nothing, writes no business row and is not a historical-provider
 * retention/read gate, pure receipt parser dependency, or replacement for
 * complete runtime-profile acceptance. */
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { assertRechargeRefundRuntimeTx,type RechargeRefundRuntimeRole } from '@/migrations/rechargeRefund';
import { ServiceUnavailableException } from '@/utils/errors';

const fail=():never=>{throw new ServiceUnavailableException('充值退款资金目录或实际运行权限需要人工核对');};
const business=['user','user_recharge','user_bill','capital_flow','store_order_outbox'] as const;

/** Name resolution only, never authority to move funds. Kept independently
 * testable because the separate runtime guard may also refuse temp ownership.
 * Explicit public search_path does not suppress implicit pg_temp precedence. */
export async function assertRechargeRefundEconomicResolutionTx(tx:DbClient){
 if(Object.hasOwn(tx,'$client'))return fail();
 const [r]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.current_schema()='public'
  AND pg_catalog.current_setting('session_replication_role')='origin'
  AND NOT EXISTS(SELECT 1 FROM (VALUES ${sql.join(business.map(name=>sql`(${name})`),sql`,`)}) n(name)
   WHERE pg_catalog.to_regclass(n.name) IS DISTINCT FROM pg_catalog.to_regclass('public.'||n.name)
    OR pg_catalog.to_regclass('public.'||n.name) IS NULL) AS ready`);
 if(r?.ready!==true)return fail();
}

/** Actual LOGIN + owning-TX contract: read is RR/read-only and requires SELECT;
 * write is RC/read-write and additionally proves only the required existing
 * INSERT/column-UPDATE and owned-sequence USAGE. Neither mode installs/repairs
 * catalog objects or consumes a sequence. Every call actually rereads facts. */
export async function assertRechargeRefundEconomicPrerequisitesTx(tx:DbClient,role:RechargeRefundRuntimeRole,
 mode:'read'|'write'='write'){
 if(Object.hasOwn(tx,'$client')||!['app','admin','financial'].includes(role)||!['read','write'].includes(mode))return fail();
 // Validate, never reset/widen, before a potentially locking catalog read.
 // Pure provider-history retention/receipt decoding has no such dependency.
 const [context]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.current_setting('role')='none'
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_settings WHERE name='statement_timeout' AND setting::bigint BETWEEN 1 AND 5000)
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_settings WHERE name='lock_timeout' AND setting::bigint BETWEEN 1 AND 1000)
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout' AND setting::bigint BETWEEN 1 AND 5000) AS ready`);
 if(context?.ready!==true)return fail();
 const scope=await assertRechargeRefundRuntimeTx(tx,role,mode);
 await assertRechargeRefundEconomicResolutionTx(tx);
 const [r]=await tx.execute<{ready:boolean;flowOid:string;flowSequenceOid:string}>(sql`WITH
 targets AS MATERIALIZED(SELECT n.name,c.* FROM
  (VALUES ${sql.join(business.map(name=>sql`(${name})`),sql`,`)}) n(name)
  JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public.'||n.name)),
 actor AS(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user),
 money(table_name,column_name) AS(VALUES('user','now_money'),('user_recharge','price'),('user_recharge','give_price'),
  ('user_recharge','refund_price'),('user_bill','number'),('user_bill','balance')),
 flow AS(SELECT * FROM targets WHERE name='capital_flow'),
 expected(name,typ,required,defaults) AS(VALUES
  ('id','integer',true,NULL::text[]),('event_key','character varying(128)',false,ARRAY[]::text[]),
  ('flow_id','character varying(32)',true,ARRAY['''''::character varying']),
  ('order_id','character varying(50)',true,ARRAY['''''::character varying']),
  ('store_id','integer',true,ARRAY['0']),('uid','integer',true,ARRAY['0']),
  ('nickname','character varying(255)',true,ARRAY['''''::character varying']),
  ('phone','character varying(20)',true,ARRAY['''''::character varying']),
  ('price','numeric(12,2)',true,ARRAY['0.00']),
  ('trading_type','smallint',true,ARRAY['0','(0)::smallint','''0''::smallint']),
  ('pay_type','character varying(32)',true,ARRAY['''''::character varying']),
  ('mark','character varying(500)',true,ARRAY['''''::character varying']),
  ('add_time','integer',true,ARRAY['0'])),
 columns AS MATERIALIZED(SELECT a.*,pg_catalog.format_type(a.atttypid,a.atttypmod) AS typ,
  d.oid AS default_oid,pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS initial
  FROM flow f JOIN pg_catalog.pg_attribute a ON a.attrelid=f.oid AND a.attnum>0 AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum),
 serial_targets AS MATERIALIZED(SELECT t.name,t.oid AS table_oid,a.attnum,a.atttypid,a.attnotnull,a.attidentity,a.attgenerated,
  d.oid AS default_oid,pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS initial,
  s.oid AS sequence_oid,s.relname AS sequence_name,s.relowner,s.relkind,s.relpersistence,s.relacl,
  q.seqtypid,q.seqstart,q.seqincrement,q.seqmax,q.seqmin,q.seqcache,q.seqcycle
  FROM targets t JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attname='id' AND a.attnum>0 AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  LEFT JOIN pg_catalog.pg_class s ON s.oid=pg_catalog.to_regclass('public.'||t.name||'_id_seq')
  LEFT JOIN pg_catalog.pg_sequence q ON q.seqrelid=s.oid
  WHERE t.name IN('capital_flow','user_bill','store_order_outbox')),
 indexes AS MATERIALIZED(SELECT i.*,c.relname,c.relowner,c.relkind,c.relpersistence,c.reloptions,m.amname
  FROM flow f JOIN pg_catalog.pg_index i ON i.indrelid=f.oid
  JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_am m ON m.oid=c.relam),
 required(name,privilege,column_name) AS(VALUES
  ('capital_flow','INSERT',''),('user_bill','INSERT',''),('store_order_outbox','INSERT',''),
  ('user','UPDATE','now_money'),('user_recharge','UPDATE','refund_price'))
 SELECT (SELECT count(*)=5 AND bool_and(t.relowner=${scope.maintenanceOid}::oid
   AND t.relkind='r' AND t.relpersistence='p' AND NOT t.relispartition AND NOT t.relrowsecurity AND NOT t.relforcerowsecurity
   AND t.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap') AND t.reltype<>0 AND t.reloptions IS NULL AND t.relreplident='d'
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhparent=t.oid OR inhrelid=t.oid)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=t.oid)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=t.oid)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=t.oid AND d.deptype='e')) FROM targets t)
  AND NOT EXISTS(SELECT 1 FROM money m LEFT JOIN targets t ON t.name=m.table_name
   LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attname=m.column_name AND a.attnum>0 AND NOT a.attisdropped
   LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attnum IS NULL OR pg_catalog.format_type(a.atttypid,a.atttypmod)<>'numeric(12,2)' OR NOT a.attnotnull
    OR a.attgenerated<>'' OR a.attidentity<>'' OR pg_catalog.pg_get_expr(d.adbin,d.adrelid) IS DISTINCT FROM '0.00')
  AND (SELECT count(*)=13 FROM columns)
  AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN columns a ON a.attname=e.name
   WHERE a.attnum IS NULL OR a.typ<>e.typ OR a.attnotnull<>e.required OR a.attidentity<>'' OR a.attgenerated<>''
    OR a.attcollation<>(SELECT typcollation FROM pg_catalog.pg_type WHERE oid=a.atttypid)
    OR (e.defaults IS NOT NULL AND CASE WHEN pg_catalog.cardinality(e.defaults)=0 THEN a.default_oid IS NOT NULL
     ELSE a.initial IS NULL OR NOT(a.initial=ANY(e.defaults)) END))
  AND NOT EXISTS(SELECT 1 FROM flow f JOIN pg_catalog.pg_trigger g ON g.tgrelid=f.oid)
  AND (SELECT count(*)=1 AND bool_and(k.contype='p' AND k.convalidated AND NOT k.condeferrable AND NOT k.condeferred
    AND k.conislocal AND k.coninhcount=0 AND k.conparentid=0
    AND k.conkey=ARRAY[(SELECT attnum FROM columns WHERE attname='id')])
   FROM flow f JOIN pg_catalog.pg_constraint k ON k.conrelid=f.oid)
  AND NOT EXISTS(SELECT 1 FROM flow f JOIN pg_catalog.pg_constraint k ON k.confrelid=f.oid)
  AND EXISTS(SELECT 1 FROM indexes i WHERE i.relname='cf_event_key_uq' AND i.indisunique AND NOT i.indisprimary
   AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indkey::text=(SELECT attnum::text FROM columns WHERE attname='event_key')
   AND CASE WHEN i.amname='btree' THEN pg_catalog.pg_get_indexdef(i.indexrelid)=
    'CREATE UNIQUE INDEX cf_event_key_uq ON public.capital_flow USING btree (event_key)' ELSE false END
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conindid=i.indexrelid))
  AND EXISTS(SELECT 1 FROM indexes i WHERE i.indisprimary AND i.indisunique AND i.indnkeyatts=1 AND i.indnatts=1
   AND i.indkey::text=(SELECT attnum::text FROM columns WHERE attname='id'))
  AND NOT EXISTS(SELECT 1 FROM indexes i WHERE i.relowner<>${scope.maintenanceOid}::oid OR i.relkind<>'i' OR i.relpersistence<>'p'
   OR i.reloptions IS NOT NULL OR i.amname<>'btree' OR NOT i.indisvalid OR NOT i.indisready OR NOT i.indislive
   OR NOT i.indimmediate OR i.indisexclusion OR i.indnullsnotdistinct OR i.indisreplident
   OR i.indexprs IS NOT NULL OR i.indpred IS NOT NULL OR i.indnkeyatts<>i.indnatts
   OR i.indisunique AND NOT i.indisprimary AND i.relname<>'cf_event_key_uq'
   OR EXISTS(SELECT 1 FROM ROWS FROM (pg_catalog.unnest(i.indkey::smallint[]),pg_catalog.unnest(i.indclass::oid[]),
     pg_catalog.unnest(i.indcollation::oid[]),pg_catalog.unnest(i.indoption::smallint[])) AS z(attnum,opclass,index_collation,options) LEFT JOIN columns a ON a.attnum=z.attnum
    LEFT JOIN pg_catalog.pg_opclass o ON o.oid=z.opclass
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid=o.opcnamespace
    WHERE a.attnum IS NULL OR n.nspname IS DISTINCT FROM 'pg_catalog' OR o.opcmethod<>(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')
     OR o.opcname IS DISTINCT FROM CASE a.atttypid WHEN 'pg_catalog.int4'::regtype THEN 'int4_ops'
      WHEN 'pg_catalog.int2'::regtype THEN 'int2_ops' WHEN 'pg_catalog.numeric'::regtype THEN 'numeric_ops'
      WHEN 'pg_catalog.varchar'::regtype THEN 'text_ops' END
     OR z.index_collation<>a.attcollation OR z.options<>0))
  AND (SELECT count(*)=3 AND bool_and(s.atttypid='pg_catalog.int4'::regtype AND s.attnotnull AND s.attidentity='' AND s.attgenerated=''
   AND s.sequence_oid IS NOT NULL AND s.relowner=${scope.maintenanceOid}::oid AND s.relkind='S' AND s.relpersistence='p'
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=s.sequence_oid AND d.deptype='e')
   AND s.seqtypid='pg_catalog.int4'::regtype AND s.seqstart=1 AND s.seqincrement=1 AND s.seqmax=2147483647
   AND s.seqmin=1 AND s.seqcache=1 AND NOT s.seqcycle
   AND s.initial IN('nextval('''||s.sequence_name||'''::regclass)','nextval(''public.'||s.sequence_name||'''::regclass)')
   AND pg_catalog.pg_get_serial_sequence('public.'||s.name,'id')::regclass::oid=s.sequence_oid
   AND (SELECT count(*)=1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=s.sequence_oid
    AND d.objsubid=0 AND d.refclassid='pg_catalog.pg_class'::regclass AND d.refobjid=s.table_oid AND d.refobjsubid=s.attnum AND d.deptype='a')
   AND (SELECT count(*)=1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=s.sequence_oid AND d.deptype IN('a','i'))
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_attrdef'::regclass AND d.objid=s.default_oid
    AND d.refclassid='pg_catalog.pg_class'::regclass AND d.refobjid=s.sequence_oid AND d.refobjsubid=0 AND d.deptype='n')
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_attrdef'::regclass AND d.objid=s.default_oid
    AND d.deptype='n' AND NOT(d.refclassid='pg_catalog.pg_class'::regclass AND d.refobjid=s.sequence_oid AND d.refobjsubid=0))
   AND (${mode}='read' OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(s.relacl,pg_catalog.acldefault('s',s.relowner))) a
    WHERE a.grantee=(SELECT oid FROM actor) AND a.grantor=${scope.maintenanceOid}::oid AND a.privilege_type='USAGE' AND NOT a.is_grantable))) FROM serial_targets s)
  AND NOT EXISTS(SELECT 1 FROM targets t WHERE NOT EXISTS(SELECT 1 FROM
   pg_catalog.aclexplode(COALESCE(t.relacl,pg_catalog.acldefault('r',t.relowner))) a
   WHERE a.grantee=(SELECT oid FROM actor) AND a.grantor=${scope.maintenanceOid}::oid AND a.privilege_type='SELECT' AND NOT a.is_grantable))
  AND (${mode}='read' OR NOT EXISTS(SELECT 1 FROM required p JOIN targets t ON t.name=p.name
   WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(t.relacl,pg_catalog.acldefault('r',t.relowner))) a
    WHERE a.grantee=(SELECT oid FROM actor) AND a.grantor=${scope.maintenanceOid}::oid AND a.privilege_type=p.privilege AND NOT a.is_grantable)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute c CROSS JOIN LATERAL pg_catalog.aclexplode(c.attacl) a
     WHERE p.column_name<>'' AND c.attrelid=t.oid AND c.attname=p.column_name AND c.attnum>0 AND NOT c.attisdropped
      AND a.grantee=(SELECT oid FROM actor) AND a.grantor=${scope.maintenanceOid}::oid AND a.privilege_type=p.privilege AND NOT a.is_grantable))) AS ready,
  (SELECT oid::text FROM flow) AS "flowOid",(SELECT sequence_oid::text FROM serial_targets WHERE name='capital_flow') AS "flowSequenceOid"`);
 if(r?.ready!==true||!/^[1-9]\d*$/u.test(r.flowOid)||!/^[1-9]\d*$/u.test(r.flowSequenceOid))return fail();
 return Object.freeze({scope,capitalFlowOid:r.flowOid,capitalFlowSequenceOid:r.flowSequenceOid});
}
