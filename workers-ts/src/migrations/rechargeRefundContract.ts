/** Recharge-only refund storage. No goods-refund identifiers or runtime DDL. */
export const RECHARGE_REFUND_GATE = [731729, 0] as const;
export const RECHARGE_REFUND_STORAGE_COMMENT = 'recharge-refund-storage-v1';
export const RECHARGE_REFUND_BINDING_VERSION = 'recharge-refund-runtime-v1';
export const RECHARGE_REFUND_MAX_CENTS = 999999999999;
export const RECHARGE_REFUND_STATE_UPDATE_COLUMNS = ['status','wallet_state','version','lease_id','lease_until',
  'provider_refund_id','attempt_count','next_query_at','last_result_id','updated_at'] as const;
export const RECHARGE_REFUND_STATES = ['RESERVED','SUBMITTING','PROCESSING','UNKNOWN','SUCCEEDED','FAILED'] as const;
export type RechargeRefundState = typeof RECHARGE_REFUND_STATES[number];
export type RechargeRefundRuntimeRole = 'app'|'admin'|'financial';
export interface RechargeRefundNames { maintenance:string; app:string; admin:string; financial:string; manager:string }
export interface RechargeRefundBinding extends RechargeRefundNames { database:string; databaseOid:string;
  maintenanceOid:string;appOid:string;adminOid:string;financialOid:string;managerOid:string }

type Column = readonly [string,string,boolean];
type Constraint = {name:string;kind:'p'|'u'|'f';columns:string[];target?:string;references?:string[]};
type Index = {name:string;columns:string[];unique:boolean;primary?:boolean;constraint?:string;predicate?:string};
export interface RechargeRefundTable {name:string;prefix:string;columns:readonly Column[];constraints:Constraint[];indexes:Index[]}
const key=(name:string,kind:'p'|'u',columns:string[]):Constraint=>({name,kind,columns});
const foreign=(name:string,columns:string[],target:string,references:string[]):Constraint=>({name,kind:'f',columns,target,references});
const index=(name:string,columns:string[],unique=false,predicate?:string):Index=>({name,columns,unique,...(predicate?{predicate}:{})});
function table(name:string,prefix:string,columns:readonly Column[],constraints:Constraint[],extra:Index[]=[]):RechargeRefundTable {
  return {name,prefix,columns,constraints,indexes:[...constraints.filter(c=>c.kind!=='f').map(c=>({name:c.name,
    columns:c.columns,unique:true,primary:c.kind==='p',constraint:c.name})),...extra]};
}
export const RECHARGE_REFUND_TABLES:readonly RechargeRefundTable[] = [
 table('recharge_refund_operation','rcro',[
  ['operation_id','uuid',true],['admin_id','integer',true],['request_key','uuid',true],['request_hash','text',true],
  ['recharge_id','integer',true],['buyer_uid','integer',false],['order_no','text',false],['provider','text',false],
  ['payment_profile','text',false],['transaction_id','text',false],['payment_source','jsonb',false],['payment_signature','text',false],
  ['principal_cents','bigint',false],['gift_cents','bigint',false],['reclaim_gift','boolean',false],['debit_cents','bigint',false],
  ['wallet_before','bigint',false],['wallet_after','bigint',false],['admission','text',true],['out_refund_no','text',false],
  ['created_at','bigint',true],['signature','text',true]],
  [key('rcro_pk','p',['operation_id']),key('rcro_admin_key_uq','u',['admin_id','request_key']),
   key('rcro_number_uq','u',['out_refund_no']),key('rcro_state_identity_uq','u',['operation_id','recharge_id','admission'])],
  [index('rcro_recharge_history',['recharge_id','created_at','operation_id'])]),
 table('recharge_refund_attempt','rcra',[
  ['attempt_id','uuid',true],['operation_id','uuid',true],['ordinal','integer',true],['kind','text',true],
  ['lease_id','uuid',true],['request_hash','text',true],['payload','jsonb',true],['created_at','bigint',true],['signature','text',true]],
  [key('rcra_pk','p',['attempt_id']),key('rcra_ordinal_uq','u',['operation_id','ordinal']),
   key('rcra_result_identity_uq','u',['operation_id','attempt_id','kind']),
   foreign('rcra_operation_fk',['operation_id'],'recharge_refund_operation',['operation_id'])],
  [index('rcra_single_request_uq',['operation_id'],true,"(kind = 'request'::text)")]),
 table('recharge_refund_result','rcrr',[
  ['result_id','uuid',true],['operation_id','uuid',true],['attempt_id','uuid',false],['source','text',true],
  ['source_id','text',true],['status','text',true],['evidence','jsonb',true],['signature','text',true],
  ['created_at','bigint',true],['caused_by_result_id','uuid',false]],
  [key('rcrr_pk','p',['result_id']),key('rcrr_operation_result_uq','u',['operation_id','result_id']),
   key('rcrr_source_uq','u',['source','source_id']),key('rcrr_attempt_uq','u',['attempt_id']),
   foreign('rcrr_operation_fk',['operation_id'],'recharge_refund_operation',['operation_id']),
   foreign('rcrr_attempt_fk',['operation_id','attempt_id','source'],'recharge_refund_attempt',['operation_id','attempt_id','kind']),
   foreign('rcrr_cause_fk',['operation_id','caused_by_result_id'],'recharge_refund_result',['operation_id','result_id'])],
  [index('rcrr_operation_history',['operation_id','created_at','result_id'])]),
 table('recharge_refund_state','rcrs',[
  ['operation_id','uuid',true],['recharge_id','integer',true],['admission','text',true],['status','text',true],
  ['wallet_state','text',true],['version','integer',true],['lease_id','uuid',false],['lease_until','bigint',false],
  ['provider_refund_id','text',false],['attempt_count','integer',true],['next_query_at','bigint',false],
  ['last_result_id','uuid',false],['created_at','bigint',true],['updated_at','bigint',true]],
  [key('rcrs_pk','p',['operation_id']),
   foreign('rcrs_operation_fk',['operation_id','recharge_id','admission'],'recharge_refund_operation',['operation_id','recharge_id','admission']),
   foreign('rcrs_last_result_fk',['operation_id','last_result_id'],'recharge_refund_result',['operation_id','result_id'])],
  [index('rcrs_effective_recharge_uq',['recharge_id'],true,"(wallet_state <> 'released'::text)"),
   index('rcrs_due',['status','next_query_at','operation_id'])]),
];
export const RECHARGE_REFUND_RUNTIME_TABLE_PRIVILEGES = {
 admin:{recharge_refund_operation:['SELECT','INSERT'],recharge_refund_state:['SELECT','INSERT'],recharge_refund_attempt:['SELECT','INSERT'],recharge_refund_result:['SELECT','INSERT']},
 app:{recharge_refund_operation:['SELECT'],recharge_refund_state:['SELECT'],recharge_refund_attempt:['SELECT','INSERT'],recharge_refund_result:['SELECT','INSERT']},
 financial:{recharge_refund_operation:['SELECT'],recharge_refund_state:['SELECT'],recharge_refund_attempt:['SELECT','INSERT'],recharge_refund_result:['SELECT','INSERT']},
} as const;

const uuid="^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$";
const hex="^[a-f0-9]{64}$";
const v=(n:number)=>`($2->>${n})`;
const n=(i:number)=>`${v(i)}::bigint`;
const u=(i:number)=>`${v(i)} ~ '${uuid}'`;
const h=(i:number)=>`${v(i)} ~ '${hex}'`;
const object=(i:number)=>`jsonb_typeof($2->${i})='object' AND octet_length(($2->${i})::text)<=16384`;
const text=(i:number,max:number)=>`char_length(${v(i)}) BETWEEN 1 AND ${max} AND ${v(i)} !~ '[\u0001-\u001f\u007f]'`;
const optionalUuid=(i:number)=>`($2->${i}='null'::jsonb OR ${u(i)})`;
const optionalTime=(i:number)=>`($2->${i}='null'::jsonb OR ${n(i)}>0)`;
/** Typed table arguments enter as one explicit ordered array. The SQL helper is
 * pure; it validates storage, never authenticates an HMAC or authorizes money. */
export const RECHARGE_REFUND_VALID_BODY = `
SELECT COALESCE(CASE $1
 WHEN 'operation' THEN jsonb_array_length($2)=22 AND ${u(0)} AND ${n(1)}>0 AND ${u(2)} AND ${h(3)}
  AND ${n(4)}>0 AND ${n(20)}>0 AND ${h(21)} AND CASE WHEN ${v(18)}='abandoned' THEN
    NOT EXISTS(SELECT 1 FROM generate_series(5,17) AS indexes(i) WHERE $2->i<>'null'::jsonb) AND $2->19='null'::jsonb
  ELSE ${n(5)}>0 AND ${text(6,32)}
  AND ((${v(7)} IN('wechat','alipay') AND ${v(8)} ~ '^[a-z][a-z0-9_-]{0,31}$' AND ${text(9,100)} AND ${object(10)} AND ${h(11)})
    OR (${v(18)}='rejected_insufficient' AND NOT EXISTS(SELECT 1 FROM generate_series(7,11) AS indexes(i) WHERE $2->i<>'null'::jsonb)))
  AND ${n(12)} BETWEEN 1 AND 999999999999 AND ${n(13)} BETWEEN 0 AND 999999999999
  AND ${n(15)} BETWEEN 1 AND 1999999999998 AND jsonb_typeof($2->14)='boolean'
  AND ${n(15)}=${n(12)}+CASE WHEN ${v(14)}::boolean THEN ${n(13)} ELSE 0 END
  AND ${n(16)} BETWEEN -999999999999 AND 999999999999 AND ${n(17)} BETWEEN -999999999999 AND 999999999999
  AND ((${v(18)}='reserved' AND ${n(16)}>=${n(15)} AND ${n(17)}=${n(16)}-${n(15)} AND ${v(19)}='CNSCR'||replace(${v(0)},'-',''))
    OR (${v(18)}='rejected_insufficient' AND ${n(16)}<${n(15)} AND ${n(17)}=${n(16)} AND $2->19='null'::jsonb)) END
 WHEN 'attempt' THEN jsonb_array_length($2)=9 AND ${u(0)} AND ${u(1)} AND ${n(2)}>0
  AND ((${v(3)}='request' AND ${n(2)}=1) OR (${v(3)}='query' AND ${n(2)}>1))
  AND ${u(4)} AND ${h(5)} AND ${object(6)} AND ${n(7)}>0 AND ${h(8)}
 WHEN 'result' THEN jsonb_array_length($2)=10 AND ${u(0)} AND ${u(1)} AND ${optionalUuid(2)}
  AND ${v(3)} IN('request','query','callback','local_cancel','local_settlement','local_release')
  AND ${v(4)} ~ '^[A-Za-z0-9._:-]{1,128}$' AND ${v(5)} IN('SUCCESS','PROCESSING','CLOSED','ABNORMAL','FAILED','UNKNOWN','NOT_FOUND')
  AND ${object(6)} AND ${h(7)} AND ${n(8)}>0 AND ${optionalUuid(9)} AND ($2->9='null'::jsonb OR $2->9<>$2->0)
  AND ((${v(3)} IN('request','query') AND $2->2<>'null'::jsonb AND $2->9='null'::jsonb)
    OR (${v(3)}='callback' AND $2->2='null'::jsonb AND $2->9='null'::jsonb)
    OR (${v(3)}='local_cancel' AND $2->2='null'::jsonb AND $2->9='null'::jsonb AND ${v(5)}='CLOSED')
    OR (${v(3)} IN('local_settlement','local_release') AND $2->2='null'::jsonb AND $2->9<>'null'::jsonb AND ${v(5)}='SUCCESS'))
 WHEN 'state' THEN jsonb_array_length($2)=14 AND ${u(0)} AND ${n(1)}>0 AND ${v(2)}='reserved'
  AND ${v(3)} IN('RESERVED','SUBMITTING','PROCESSING','UNKNOWN','SUCCEEDED','FAILED') AND ${n(5)}>=0
  AND ((${v(3)}='SUCCEEDED' AND ${v(4)}='captured') OR (${v(3)}='FAILED' AND ${v(4)}='released')
    OR (${v(3)} IN('RESERVED','SUBMITTING','PROCESSING','UNKNOWN') AND ${v(4)}='held'))
  AND ${optionalUuid(6)} AND ${optionalTime(7)} AND (($2->6='null'::jsonb)=($2->7='null'::jsonb))
  AND ($2->8='null'::jsonb OR ${text(8,128)}) AND ${n(9)}>=0 AND ${optionalTime(10)} AND ${optionalUuid(11)}
  AND ${n(12)}>0 AND ${n(13)}>=${n(12)}
  AND (${v(3)} NOT IN('SUCCEEDED','FAILED','RESERVED') OR ($2->6='null'::jsonb AND $2->10='null'::jsonb))
  AND (${v(3)}<>'SUBMITTING' OR $2->6<>'null'::jsonb)
 ELSE false END,false)
`;
export const RECHARGE_REFUND_GUARD_BODY = `BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') OR (TG_TABLE_NAME<>'recharge_refund_state' AND TG_OP='UPDATE') THEN
  RAISE EXCEPTION 'Recharge refund evidence is immutable' USING ERRCODE='42501';
 END IF;
 -- Record-field expressions are planned only inside the matching relation and
 -- operation branch. Boolean AND does not protect NEW/OLD field resolution.
 IF TG_TABLE_NAME='recharge_refund_state' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.status<>'RESERVED' OR NEW.wallet_state<>'held' OR NEW.version<>0 OR NEW.attempt_count<>0
    OR NEW.lease_id IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.provider_refund_id IS NOT NULL
    OR NEW.next_query_at IS NOT NULL OR NEW.last_result_id IS NOT NULL OR NEW.updated_at<>NEW.created_at THEN
    RAISE EXCEPTION 'Recharge refund initial state is invalid' USING ERRCODE='23514';
   END IF;
  ELSIF TG_OP='UPDATE' THEN
   IF (NEW.operation_id,NEW.recharge_id,NEW.admission,NEW.created_at) IS DISTINCT FROM
      (OLD.operation_id,OLD.recharge_id,OLD.admission,OLD.created_at)
    OR OLD.status IN('SUCCEEDED','FAILED') OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at
    OR NEW.attempt_count<OLD.attempt_count OR NEW.attempt_count>OLD.attempt_count+1
    OR NOT ((OLD.status='RESERVED' AND ((NEW.status='SUBMITTING' AND OLD.attempt_count=0 AND NEW.attempt_count=1)
      OR (NEW.status='FAILED' AND OLD.attempt_count=0 AND NEW.attempt_count=0)))
     OR (OLD.status='SUBMITTING' AND NEW.status IN('PROCESSING','UNKNOWN','SUCCEEDED','FAILED'))
     OR (OLD.status IN('PROCESSING','UNKNOWN') AND NEW.status IN('PROCESSING','UNKNOWN','SUCCEEDED','FAILED'))) THEN
    RAISE EXCEPTION 'Recharge refund state transition is invalid' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END`;
const lockSourceRoleKeys = ['maintenance','app','admin','financial','manager'] as const;
const lockSourceBindingKeys = ['version','database','databaseOid',...lockSourceRoleKeys.flatMap(role=>[role,role+'Oid'])];
const lockSourceRuntimeAcl:Array<[string,string,string,string,string]> = [];
for(const role of ['admin','app','financial'] as const) {
 for(const [name,privileges] of Object.entries(RECHARGE_REFUND_RUNTIME_TABLE_PRIVILEGES[role]))
  for(const privilege of privileges)lockSourceRuntimeAcl.push(['table',name,'',role,privilege]);
 for(const column of RECHARGE_REFUND_STATE_UPDATE_COLUMNS)
  lockSourceRuntimeAcl.push(['column','recharge_refund_state',column,role,'UPDATE']);
 for(const name of ['recharge_refund_valid_v1','recharge_refund_lock_source_v1'])
  lockSourceRuntimeAcl.push(['function',name,'',role,'EXECUTE']);
}
const lockSourceLiteral=(value:string)=>"'"+value.replaceAll("'","''")+"'";
const lockSourceAclValues=lockSourceRuntimeAcl.map(row=>'('+row.map(lockSourceLiteral).join(',')+')').join(',\n');
/** Deliberately independent of the full catalog query: including that query here
 * would recursively include this exact body. The caller additionally checks the
 * complete catalog while sharing this same maintenance gate. Direct execution
 * still validates the actual login, binding, owners and exact namespace ACLs. */
export const RECHARGE_REFUND_LOCK_SOURCE_BODY = `DECLARE
 b pg_catalog.jsonb; comment_text pg_catalog.text; owner_oid pg_catalog.oid; login_oid pg_catalog.oid; locked_id pg_catalog.int4; acl_ok pg_catalog.bool;
BEGIN
 IF $1 IS NULL OR $1<1 THEN
  RAISE EXCEPTION 'Invalid recharge refund source identity' USING ERRCODE='22023';
 END IF;
 IF current_setting('server_version_num')::pg_catalog.int4/10000<>16
  OR current_setting('role')<>'none'
  OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off'
  OR current_setting('session_replication_role')<>'origin'
  OR (SELECT setting::pg_catalog.int8 NOT BETWEEN 1 AND 5000 FROM pg_catalog.pg_settings WHERE name='statement_timeout')
  OR (SELECT setting::pg_catalog.int8 NOT BETWEEN 1 AND 1000 FROM pg_catalog.pg_settings WHERE name='lock_timeout')
  OR (SELECT setting::pg_catalog.int8 NOT BETWEEN 1 AND 5000 FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout') THEN
  RAISE EXCEPTION 'Recharge refund source lock requires a direct bounded PG16 READ COMMITTED write transaction' USING ERRCODE='42501';
 END IF;
 SELECT r.oid INTO owner_oid FROM pg_catalog.pg_roles r WHERE r.rolname=current_user AND r.rolsuper AND r.rolcanlogin;
 SELECT r.oid INTO login_oid FROM pg_catalog.pg_roles r WHERE r.rolname=session_user;
 IF owner_oid IS NULL OR login_oid IS NULL OR owner_oid=login_oid
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid() AND a.usesysid=login_oid) THEN
  RAISE EXCEPTION 'Recharge refund source lock owner/login is invalid' USING ERRCODE='42501';
 END IF;
 IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(731729,0) THEN
  RAISE EXCEPTION 'Recharge refund source maintenance is in progress' USING ERRCODE='55P03';
 END IF;
 SELECT pg_catalog.obj_description(c.oid,'pg_class') INTO comment_text
  FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.recharge_refund_operation') AND c.relowner=owner_oid;
 IF comment_text IS NULL OR octet_length(comment_text)>4096 OR comment_text='recharge-refund-storage-v1' THEN
  RAISE EXCEPTION 'Recharge refund source lock is not explicitly commissioned' USING ERRCODE='42501';
 END IF;
 b:=comment_text::pg_catalog.jsonb;
 IF jsonb_typeof(b) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'Recharge refund source binding is invalid' USING ERRCODE='42501';
 END IF;
 IF NOT (b ?& ARRAY[${lockSourceBindingKeys.map(lockSourceLiteral).join(',')}]::pg_catalog.text[])
  OR b-ARRAY[${lockSourceBindingKeys.map(lockSourceLiteral).join(',')}]::pg_catalog.text[]<>'{}'::pg_catalog.jsonb
  OR EXISTS(SELECT 1 FROM jsonb_each(b) e WHERE jsonb_typeof(e.value)<>'string')
  OR b->>'version'<>'recharge-refund-runtime-v1'
  OR b->>'database'<>current_database()
  OR b->>'databaseOid' IS DISTINCT FROM (SELECT d.oid::pg_catalog.text FROM pg_catalog.pg_database d WHERE d.datname=current_database())
  OR b->>'maintenance'<>current_user OR b->>'maintenanceOid'<>owner_oid::pg_catalog.text
  OR NOT EXISTS(SELECT 1 FROM (VALUES ${lockSourceRoleKeys.map(role=>'('+lockSourceLiteral(role)+')').join(',')}) k(role_key)
    WHERE k.role_key IN('admin','app','financial') AND b->>k.role_key=session_user AND b->>(k.role_key||'Oid')=login_oid::pg_catalog.text)
  OR (SELECT count(*)<>5 OR count(DISTINCT r.oid)<>5
    OR NOT bool_and(r.oid IS NOT NULL AND r.oid::pg_catalog.text=b->>(k.role_key||'Oid') AND r.rolcanlogin
      AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE')
      AND pg_catalog.has_database_privilege(r.oid,current_database(),'CONNECT')
      AND CASE WHEN k.role_key='maintenance' THEN r.rolsuper AND r.oid=owner_oid
       ELSE NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid=r.oid OR m.member=r.oid)
        AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET')
        AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM')
        AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend d
          WHERE d.refclassid='pg_catalog.pg_authid'::pg_catalog.regclass AND d.refobjid=r.oid AND d.deptype='o') END)
    FROM (VALUES ${lockSourceRoleKeys.map(role=>'('+lockSourceLiteral(role)+')').join(',')}) k(role_key) LEFT JOIN pg_catalog.pg_roles r ON r.rolname=b->>k.role_key) THEN
  RAISE EXCEPTION 'Recharge refund source binding/login has drifted' USING ERRCODE='42501';
 END IF;
 IF (SELECT count(*)<>7 OR bool_or(c.relowner<>owner_oid OR c.relkind<>'r' OR c.relpersistence<>'p'
     OR c.relispartition OR c.relrowsecurity OR c.relforcerowsecurity)
    FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::pg_catalog.regnamespace
    AND c.relname IN('store_order','user_recharge','other_order',${RECHARGE_REFUND_TABLES.map(t=>lockSourceLiteral(t.name)).join(',')}))
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc f
    WHERE f.oid=pg_catalog.to_regprocedure('public.recharge_refund_lock_source_v1(integer)')
    AND f.proowner=owner_oid AND f.prosecdef AND f.proconfig=ARRAY['search_path=pg_catalog']::pg_catalog.text[]
    AND f.proargtypes='23'::pg_catalog.oidvector AND f.prorettype='pg_catalog.int4'::pg_catalog.regtype
    AND f.prolang=(SELECT l.oid FROM pg_catalog.pg_language l WHERE l.lanname='plpgsql'))
  OR (SELECT count(*)<>3 OR bool_or(f.proowner<>owner_oid)
    FROM pg_catalog.pg_proc f WHERE f.pronamespace='public'::pg_catalog.regnamespace
     AND f.proname IN('recharge_refund_valid_v1','recharge_refund_guard_v1','recharge_refund_lock_source_v1')) THEN
  RAISE EXCEPTION 'Recharge refund source lock object ownership has drifted' USING ERRCODE='42501';
 END IF;
 WITH tt AS (SELECT c.* FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::pg_catalog.regnamespace AND c.relname IN(${RECHARGE_REFUND_TABLES.map(t=>lockSourceLiteral(t.name)).join(',')})),
 ff AS (SELECT f.* FROM pg_catalog.pg_proc f WHERE f.pronamespace='public'::pg_catalog.regnamespace
  AND f.proname IN('recharge_refund_valid_v1','recharge_refund_guard_v1','recharge_refund_lock_source_v1')),
 actual_acl(scope,object_name,column_name,grantee,grantor,privilege,grantable) AS (
  SELECT 'table',t.relname::pg_catalog.text,''::pg_catalog.text,a.grantee::pg_catalog.text,a.grantor::pg_catalog.text,a.privilege_type,a.is_grantable
   FROM tt t CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(t.relacl,pg_catalog.acldefault('r',t.relowner))) a
  UNION ALL SELECT 'column',t.relname::pg_catalog.text,c.attname::pg_catalog.text,a.grantee::pg_catalog.text,a.grantor::pg_catalog.text,a.privilege_type,a.is_grantable
   FROM tt t JOIN pg_catalog.pg_attribute c ON c.attrelid=t.oid AND c.attnum>0 CROSS JOIN LATERAL pg_catalog.aclexplode(c.attacl) a
  UNION ALL SELECT 'function',f.proname::pg_catalog.text,''::pg_catalog.text,a.grantee::pg_catalog.text,a.grantor::pg_catalog.text,a.privilege_type,a.is_grantable
   FROM ff f CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a),
 owner_acl(scope,object_name,column_name,grantee,grantor,privilege,grantable) AS (
  SELECT 'table',t.relname::pg_catalog.text,''::pg_catalog.text,t.relowner::pg_catalog.text,t.relowner::pg_catalog.text,p.privilege,false
   FROM tt t CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(privilege)
  UNION ALL SELECT 'function',f.proname::pg_catalog.text,''::pg_catalog.text,f.proowner::pg_catalog.text,f.proowner::pg_catalog.text,'EXECUTE',false FROM ff f),
 runtime_acl(scope,object_name,column_name,grantee,grantor,privilege,grantable) AS (
  SELECT x.scope,x.object_name,x.column_name,r.oid::pg_catalog.text,owner_oid::pg_catalog.text,x.privilege,false
   FROM (VALUES ${lockSourceAclValues}) x(scope,object_name,column_name,role_key,privilege)
   JOIN pg_catalog.pg_roles r ON r.rolname=b->>x.role_key AND r.oid::pg_catalog.text=b->>(x.role_key||'Oid'))
 SELECT (SELECT jsonb_agg(to_jsonb(a) ORDER BY scope,object_name,column_name,grantee,grantor,privilege,grantable) FROM actual_acl a)
  IS NOT DISTINCT FROM
  (SELECT jsonb_agg(to_jsonb(a) ORDER BY scope,object_name,column_name,grantee,grantor,privilege,grantable)
   FROM (SELECT * FROM owner_acl UNION ALL SELECT * FROM runtime_acl) a) INTO acl_ok;
 IF acl_ok IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Recharge refund source lock runtime ACLs have drifted' USING ERRCODE='42501';
 END IF;
 LOCK TABLE ONLY public.store_order,ONLY public.user_recharge,ONLY public.other_order IN SHARE MODE NOWAIT;
 SELECT r.id INTO locked_id FROM public.user_recharge r WHERE r.id=$1 FOR UPDATE NOWAIT;
 RETURN locked_id;
END`;

const constraintSql=(c:Constraint)=>`CONSTRAINT ${c.name} ${c.kind==='p'?'PRIMARY KEY':c.kind==='u'?'UNIQUE':'FOREIGN KEY'} (${c.columns.join(',')})`+
 (c.kind==='f'?` REFERENCES public.${c.target} (${c.references!.join(',')})`:'');
export const RECHARGE_REFUND_SCHEMA_SQL = `
CREATE FUNCTION public.recharge_refund_valid_v1(text,jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path=pg_catalog
AS $rcr_valid$${RECHARGE_REFUND_VALID_BODY}$rcr_valid$;
REVOKE ALL ON FUNCTION public.recharge_refund_valid_v1(text,jsonb) FROM PUBLIC;
CREATE FUNCTION public.recharge_refund_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog
AS $rcr_guard$${RECHARGE_REFUND_GUARD_BODY}$rcr_guard$;
REVOKE ALL ON FUNCTION public.recharge_refund_guard_v1() FROM PUBLIC;
CREATE FUNCTION public.recharge_refund_lock_source_v1(integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $rcr_lock$${RECHARGE_REFUND_LOCK_SOURCE_BODY}$rcr_lock$;
REVOKE ALL ON FUNCTION public.recharge_refund_lock_source_v1(integer) FROM PUBLIC;
${RECHARGE_REFUND_TABLES.map(t=>`CREATE TABLE public.${t.name} (
${t.columns.map(([name,type,required])=>` ${name} ${type}${required?' NOT NULL':''}`).join(',\n')},
 ${t.constraints.map(constraintSql).join(',\n ')},
 CONSTRAINT ${t.prefix}_valid_ck CHECK(public.recharge_refund_valid_v1('${t.name.replace('recharge_refund_','')}',pg_catalog.jsonb_build_array(${t.columns.map(c=>c[0]).join(',')})))
);
${t.indexes.filter(i=>!i.constraint).map(i=>`CREATE ${i.unique?'UNIQUE ':''}INDEX ${i.name} ON public.${t.name} (${i.columns.join(',')})${i.predicate?' WHERE '+i.predicate:''};`).join('\n')}
CREATE TRIGGER ${t.prefix}_guard_rows BEFORE INSERT OR UPDATE OR DELETE ON public.${t.name}
 FOR EACH ROW EXECUTE FUNCTION public.recharge_refund_guard_v1();
CREATE TRIGGER ${t.prefix}_guard_truncate BEFORE TRUNCATE ON public.${t.name}
 FOR EACH STATEMENT EXECUTE FUNCTION public.recharge_refund_guard_v1();`).join('\n')}
COMMENT ON TABLE public.recharge_refund_operation IS '${RECHARGE_REFUND_STORAGE_COMMENT}';
`;
