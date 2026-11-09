/** Explicit recharge-only refund approval storage. No startup DDL, role
 * creation, old-policy adoption, credential load or provider transport. */
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';
import { captureRechargeRefundScope } from '@/services/payment/RechargeRefundJournalCodec';
import { inspectRechargeRefundCatalog, assertRechargeRefundRuntimeTx, type RechargeRefundBinding,
 type RechargeRefundRuntimeRole } from './rechargeRefund';

type Query=Pick<DbClient,'execute'>;
export const RECHARGE_ROUTINE_REFUND_ACCOUNT_GATE=[731731,0] as const;
const table='recharge_routine_refund_account_policy';
const fn='recharge_routine_refund_account_immutable_v1';
const tag='recharge-routine-refund-account-v1:';
const guard=`BEGIN
 RAISE EXCEPTION 'Recharge refund account approvals are immutable' USING ERRCODE='42501';
END`;
export const RECHARGE_ROUTINE_REFUND_ACCOUNT_SCHEMA_SQL=`
CREATE TABLE public.recharge_routine_refund_account_policy (
 record_id uuid NOT NULL, account_id varchar(64) NOT NULL, revision integer NOT NULL,
 payload jsonb NOT NULL, created_at bigint NOT NULL, signature varchar(64) NOT NULL,
 CONSTRAINT crra_pk PRIMARY KEY(record_id), CONSTRAINT crra_revision_uq UNIQUE(account_id,revision),
 CONSTRAINT crra_account_ck CHECK(account_id ~ '^[a-f0-9]{64}$'),
 CONSTRAINT crra_revision_ck CHECK(revision BETWEEN 1 AND 64),
 CONSTRAINT crra_payload_ck CHECK(pg_catalog.jsonb_typeof(payload)='object' AND pg_catalog.octet_length(payload::text)<=16384),
 CONSTRAINT crra_created_ck CHECK(created_at BETWEEN 1 AND 2147483647),
 CONSTRAINT crra_signature_ck CHECK(signature ~ '^[a-f0-9]{64}$')
);
CREATE FUNCTION public.recharge_routine_refund_account_immutable_v1() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $crra$${guard}$crra$;
CREATE TRIGGER crra_immutable_rows BEFORE UPDATE OR DELETE ON public.recharge_routine_refund_account_policy
 FOR EACH ROW EXECUTE FUNCTION public.recharge_routine_refund_account_immutable_v1();
CREATE TRIGGER crra_immutable_truncate BEFORE TRUNCATE ON public.recharge_routine_refund_account_policy
 FOR EACH STATEMENT EXECUTE FUNCTION public.recharge_routine_refund_account_immutable_v1();
REVOKE ALL ON TABLE public.recharge_routine_refund_account_policy FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recharge_routine_refund_account_immutable_v1() FROM PUBLIC;
`;
const expectedConstraints={
 crra_pk:'PRIMARY KEY (record_id)',crra_revision_uq:'UNIQUE (account_id, revision)',
 crra_account_ck:"CHECK (((account_id)::text ~ '^[a-f0-9]{64}$'::text))",
 crra_revision_ck:'CHECK (((revision >= 1) AND (revision <= 64)))',
 crra_payload_ck:"CHECK (((jsonb_typeof(payload) = 'object'::text) AND (octet_length((payload)::text) <= 16384)))",
 crra_created_ck:'CHECK (((created_at >= 1) AND (created_at <= 2147483647)))',
 crra_signature_ck:"CHECK (((signature)::text ~ '^[a-f0-9]{64}$'::text))",
};
const expectedIndexes={
 crra_pk:'CREATE UNIQUE INDEX crra_pk ON public.recharge_routine_refund_account_policy USING btree (record_id)',
 crra_revision_uq:'CREATE UNIQUE INDEX crra_revision_uq ON public.recharge_routine_refund_account_policy USING btree (account_id, revision)',
};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const mapSame=(actual:unknown,expected:Record<string,string>)=>!!actual&&typeof actual==='object'
 &&Object.keys(actual).length===Object.keys(expected).length&&Object.entries(expected).every(([k,v])=>(actual as Record<string,unknown>)[k]===v);
const fail=(reason:string):never=>{throw new ServiceUnavailableException('充值退款账号批准存储未就绪：'+reason);};
const comment=(b:RechargeRefundBinding)=>tag+JSON.stringify(captureRechargeRefundScope(b));
export interface RechargeRoutineRefundAccountCatalog {
 readonly present:boolean; readonly ready:boolean; readonly binding:RechargeRefundBinding|null; readonly failures:readonly string[];
}
/** Identity comes from the complete independent recharge commissioning. New
 * table ACL grantees never supply identity or a missing source binding. */
export async function inspectRechargeRoutineRefundAccountCatalog(tx:Query):Promise<RechargeRoutineRefundAccountCatalog> {
 const objects=await tx.execute<{name:string}>(sql`SELECT 'relation:'||c.relname AS name FROM pg_catalog.pg_class c
  WHERE c.relnamespace='public'::regnamespace AND c.relname ~ '^(recharge_routine_refund_account|crra_)'
 UNION ALL SELECT 'function:'||p.proname FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname ~ '^(recharge_routine_refund_account|crra_)'
 UNION ALL SELECT 'type:'||t.typname FROM pg_catalog.pg_type t WHERE t.typnamespace='public'::regnamespace AND t.typname ~ '^(_?recharge_routine_refund_account|_?crra_)'
 UNION ALL SELECT 'constraint:'||k.conname FROM pg_catalog.pg_constraint k WHERE k.connamespace='public'::regnamespace AND k.conname ~ '^(recharge_routine_refund_account|crra_)'
 UNION ALL SELECT 'trigger:'||t.tgname FROM pg_catalog.pg_trigger t WHERE t.tgname ~ '^(recharge_routine_refund_account|crra_)'`);
 if(!objects.length)return{present:false,ready:false,binding:null,failures:[]};
 const failures:string[]=[],check=(key:string,ok:boolean)=>{if(!ok)failures.push(key);};
 const expected=['relation:'+table,'relation:crra_pk','relation:crra_revision_uq','function:'+fn,'type:'+table,'type:_'+table,
  ...Object.keys(expectedConstraints).map(k=>'constraint:'+k),'trigger:crra_immutable_rows','trigger:crra_immutable_truncate'].sort();
 check('namespace',same(objects.map(o=>o.name).sort(),expected));
 const source=await inspectRechargeRefundCatalog(tx),b=source.binding;
 check('recharge_binding',source.commissioned&&!!b);
 if(!b)return{present:true,ready:false,binding:null,failures};
 const [r]=await tx.execute<Record<string,unknown>>(sql`SELECT c.relowner::text AS owner,
 pg_catalog.obj_description(c.oid,'pg_class') AS comment,
 c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
 AND c.relnatts=6 AND c.relchecks=5 AND c.reloptions IS NULL AND c.relreplident='d' AND c.reltablespace=0
 AND c.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=c.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid=c.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attrdef WHERE adrelid=c.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=c.oid AND attnum>0
  AND (attisdropped OR atthasdef OR attidentity<>'' OR attgenerated<>'' OR attacl IS NOT NULL))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend WHERE classid='pg_catalog.pg_class'::regclass AND objid=c.oid AND deptype='e') AS safe,
 (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(attnum,attname,pg_catalog.format_type(atttypid,atttypmod),attnotnull,
  CASE WHEN attcollation=0 THEN NULL ELSE attcollation::regcollation::text END) ORDER BY attnum)
  FROM pg_catalog.pg_attribute WHERE attrelid=c.oid AND attnum>0) AS columns,
 (SELECT count(*)=7 AND bool_and(convalidated AND NOT condeferrable AND NOT condeferred AND conislocal
  AND coninhcount=0 AND conparentid=0 AND connamespace='public'::regnamespace AND contype IN('p','u','c'))
  FROM pg_catalog.pg_constraint WHERE conrelid=c.oid) AS constraint_safe,
 (SELECT jsonb_object_agg(conname,pg_catalog.pg_get_constraintdef(oid,false)) FROM pg_catalog.pg_constraint WHERE conrelid=c.oid) AS constraints,
 (SELECT jsonb_object_agg(ic.relname,pg_catalog.pg_get_indexdef(ic.oid)) FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid) AS indexes,
 (SELECT count(*)=2 AND bool_and(i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
  AND NOT i.indisexclusion AND NOT i.indisclustered AND NOT i.indisreplident AND NOT i.indnullsnotdistinct
  AND i.indexprs IS NULL AND i.indpred IS NULL AND i.indnatts=i.indnkeyatts
  AND ic.relowner=c.relowner AND ic.relnamespace=c.relnamespace AND ic.relkind='i' AND ic.relpersistence='p'
  AND ic.reloptions IS NULL AND ic.relacl IS NULL AND ic.reltablespace=0
  AND ic.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')
  AND ((ic.relname='crra_pk' AND i.indisprimary AND i.indisunique AND i.indkey::text='1' AND i.indoption::text='0'
    AND i.indclass::text=(SELECT oid::text FROM pg_catalog.pg_opclass WHERE opcname='uuid_ops' AND opcnamespace='pg_catalog'::regnamespace AND opcmethod=ic.relam) AND i.indcollation::text='0')
   OR(ic.relname='crra_revision_uq' AND NOT i.indisprimary AND i.indisunique AND i.indkey::text='2 3' AND i.indoption::text='0 0'
    AND i.indclass::text=(SELECT oid::text FROM pg_catalog.pg_opclass WHERE opcname='text_ops' AND opcnamespace='pg_catalog'::regnamespace AND opcmethod=ic.relam)||' '||
     (SELECT oid::text FROM pg_catalog.pg_opclass WHERE opcname='int4_ops' AND opcnamespace='pg_catalog'::regnamespace AND opcmethod=ic.relam)
    AND i.indcollation::text=(SELECT oid::text FROM pg_catalog.pg_collation WHERE collname='default' AND collnamespace='pg_catalog'::regnamespace)||' 0')))
  FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid) AS index_safe,
 (SELECT count(*)=2 AND bool_and(NOT t.tgisinternal AND t.tgenabled='O' AND t.tgnargs=0 AND t.tgqual IS NULL
  AND t.tgconstraint=0 AND t.tgfoid=f.oid AND t.tgattr::text='' AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
  AND ((t.tgname='crra_immutable_rows' AND t.tgtype=27) OR(t.tgname='crra_immutable_truncate' AND t.tgtype=34)))
  FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid) AS triggers,
 f.proowner=c.relowner AND f.prosrc=${guard} AND f.prorettype='pg_catalog.trigger'::regtype AND f.pronargs=0 AND f.proargtypes::text=''
 AND NOT f.prosecdef AND NOT f.proleakproof AND f.provolatile='v' AND f.prokind='f'
 AND f.proconfig=ARRAY['search_path=pg_catalog'] AND NOT f.proisstrict AND NOT f.proretset AND f.proparallel='u'
 AND f.procost=100 AND f.prorows=0 AND f.prosupport=0 AND f.provariadic=0 AND f.pronargdefaults=0
 AND f.proargdefaults IS NULL AND f.proallargtypes IS NULL AND f.proargmodes IS NULL AND f.proargnames IS NULL
 AND f.probin IS NULL AND f.prosqlbody IS NULL AND f.protrftypes IS NULL
 AND f.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql' AND lanpltrusted)
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgfoid=f.oid AND tgrelid<>c.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend WHERE classid='pg_catalog.pg_proc'::regclass AND objid=f.oid AND deptype='e')
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a
  WHERE a.grantee<>f.proowner OR a.grantor<>f.proowner) AS function_safe,
 NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
  WHERE a.grantor<>c.relowner OR(a.grantee<>c.relowner AND(a.grantee=0 OR a.is_grantable))) AS acl_safe,
 COALESCE((SELECT jsonb_agg(jsonb_build_array(a.grantee::text,a.privilege_type) ORDER BY a.grantee,a.privilege_type COLLATE "C")
  FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner),'[]'::jsonb) AS grants
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_proc f ON f.oid=pg_catalog.to_regprocedure('public.recharge_routine_refund_account_immutable_v1()')
 WHERE c.oid=pg_catalog.to_regclass('public.recharge_routine_refund_account_policy')`);
 if(!r)return{present:true,ready:false,binding:b,failures:[...failures,'objects']};
 for(const key of ['safe','constraint_safe','index_safe','triggers','function_safe','acl_safe'])check(key,r[key]===true);
 check('owner',r.owner===b.maintenanceOid);check('comment',r.comment===comment(b));
 check('columns',same(r.columns,[[1,'record_id','uuid',true,null],[2,'account_id','character varying(64)',true,'"default"'],
  [3,'revision','integer',true,null],[4,'payload','jsonb',true,null],[5,'created_at','bigint',true,null],[6,'signature','character varying(64)',true,'"default"']]));
 check('constraints',mapSame(r.constraints,expectedConstraints));check('indexes',mapSame(r.indexes,expectedIndexes));
 const grants=[b.adminOid,b.appOid,b.financialOid].sort((a,z)=>Number(a)-Number(z)).map(oid=>[oid,'SELECT']);
 check('grants',same(r.grants,grants));
 return{present:true,ready:failures.length===0,binding:b,failures};
}

async function bounds(tx:Query) {
 await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);await tx.execute(sql`SET LOCAL row_security TO off`);
 await tx.execute(sql`SET LOCAL standard_conforming_strings TO on`);
 await tx.execute(sql`SELECT
  pg_catalog.set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000),5000)::text||'ms',true),
  pg_catalog.set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000),1000)::text||'ms',true),
  pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true)`);
}
export async function assertRechargeRoutineRefundAccountMaintenanceTx(tx:Query,input:RechargeRefundBinding):Promise<RechargeRefundBinding> {
 const b=captureRechargeRefundScope(input);
 if(Object.hasOwn(tx,'$client'))return fail('transaction required');
 await bounds(tx);
 const [context]=await tx.execute<{safe:boolean}>(sql`SELECT current_user=session_user AND current_user=${b.maintenance}
  AND r.oid::text=${b.maintenanceOid} AND r.rolsuper AND r.rolcanlogin AND current_setting('role')='none'
  AND pg_catalog.current_database()=${b.database}
  AND(SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())=${b.databaseOid}
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid() AND usesysid=r.oid)
  AND current_setting('server_version_num')::integer/10000=16 AND current_setting('transaction_isolation')='read committed'
  AND current_setting('transaction_read_only')='off' AND current_setting('session_replication_role')='origin'
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS safe
  FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
 if(context?.safe!==true)return fail('direct maintenance LOGIN/context');
 for(const statement of [sql`SELECT pg_catalog.pg_try_advisory_xact_lock_shared(731729,0) AS held`,
  sql`SELECT pg_catalog.pg_try_advisory_xact_lock(731731,0) AS held`]) {
  const [gate]=await tx.execute<{held:boolean}>(statement);
  if(gate?.held!==true)return fail('maintenance gate busy');
 }
 const source=await inspectRechargeRefundCatalog(tx);
 if(!source.commissioned||!same(source.binding,b))return fail('exact reviewed recharge binding');
 return b;
}
/** Initial absence advances atomically to the whole commissioned catalog.
 * Existing exact successor is a zero-write replay. Partial/owner-only/drifted
 * namespaces are refused; the transaction never repairs or adopts them. */
export async function runRechargeRoutineRefundAccountInstallation(root:DbClient,input:RechargeRefundBinding) {
 const b=captureRechargeRefundScope(input),client=Object.getOwnPropertyDescriptor(root,'$client');
 if(!client||!('value'in client)||!client.value||typeof client.value.begin!=='function')return fail('root postgres database');
 return root.transaction(raw=>installRechargeRoutineRefundAccountInTransaction(raw as unknown as DbClient,b),{isolationLevel:'read committed',accessMode:'read write'});
}

export async function installRechargeRoutineRefundAccountInTransaction(tx:Query,input:RechargeRefundBinding) {
 const b=captureRechargeRefundScope(input);
  await assertRechargeRoutineRefundAccountMaintenanceTx(tx,b);
  const before=await inspectRechargeRoutineRefundAccountCatalog(tx);
  if(before.present){if(!before.ready)return fail('existing namespace drift');return Object.freeze({replayed:true,binding:b});}
  await tx.execute(sql.raw(RECHARGE_ROUTINE_REFUND_ACCOUNT_SCHEMA_SQL));
  await tx.execute(sql`COMMENT ON TABLE public.recharge_routine_refund_account_policy IS ${sql.raw("'"+comment(b).replaceAll("'","''")+"'")}`);
  for(const role of [b.admin,b.app,b.financial])await tx.execute(sql`GRANT SELECT ON TABLE public.recharge_routine_refund_account_policy TO ${sql.identifier(role)}`);
  const after=await inspectRechargeRoutineRefundAccountCatalog(tx);
  if(!after.ready)return fail('final catalog '+after.failures.join(','));
  await assertRechargeRoutineRefundAccountMaintenanceTx(tx,b);
  return Object.freeze({replayed:false,binding:b});
}

export async function assertRechargeRoutineRefundAccountRuntimeTx(tx:Query,role:RechargeRefundRuntimeRole,mode:'read'|'write'='write') {
 const b=await assertRechargeRefundRuntimeTx(tx,role,mode);
 const [gate]=await tx.execute<{held:boolean}>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock_shared(731731,0) AS held`);
 if(gate?.held!==true)return fail('account maintenance gate busy');
 const [resolution]=await tx.execute<{safe:boolean}>(sql`SELECT pg_catalog.to_regclass('recharge_routine_refund_account_policy')=
  pg_catalog.to_regclass('public.recharge_routine_refund_account_policy') AS safe`);
 const catalog=await inspectRechargeRoutineRefundAccountCatalog(tx);
 if(resolution?.safe!==true||!catalog.ready||!same(catalog.binding,b))return fail('runtime catalog');
 return b;
}
