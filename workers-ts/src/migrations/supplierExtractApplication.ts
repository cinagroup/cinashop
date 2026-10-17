/** Independent0197 addon: never part of shared ORM/startup/role bootstrap.
 * Payload and immutable-row rules live in one byte-pinned INVOKER trigger;
 * physical PK/UNIQUE/FK, all columns, indexes, triggers and ACLs are inspected. */
import {sql} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {ServiceUnavailableException} from '@/utils/errors';
export const SUPPLIER_EXTRACT_APPLICATION_GUARD=`BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Supplier extract application evidence is immutable' USING ERRCODE='42501';
  END IF;
  IF (NEW.actor_id > 0 AND NEW.supplier_id > 0 AND NEW.created_at > 0
    AND NEW.operation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND ((NEW.state='not_applied' AND NEW.extract_id IS NULL AND NEW.request_hash='' AND NEW.source_hash='' AND NEW.result_hash=''
      AND NEW.intent IS NULL AND NEW.source IS NULL AND NEW.result IS NULL)
    OR (NEW.state='committed' AND NEW.extract_id>0 AND NEW.request_hash ~ '^[a-f0-9]{64}$'
      AND NEW.source_hash ~ '^[a-f0-9]{64}$' AND NEW.result_hash ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(NEW.intent)='object' AND octet_length(NEW.intent::text)<=16384
      AND jsonb_typeof(NEW.source)='object' AND octet_length(NEW.source::text)<=65536
      AND jsonb_typeof(NEW.result)='object' AND octet_length(NEW.result::text)<=65536
      AND NEW.intent->>'version'='supplier-extract-application-intent-v1'
      AND NEW.intent->>'operation_id'=NEW.operation_id::text
      AND NEW.intent->'actor_id'=to_jsonb(NEW.actor_id) AND NEW.intent->'supplier_id'=to_jsonb(NEW.supplier_id)
      AND NEW.source->>'version'='supplier-extract-application-source-v1' AND NEW.source->'supplier_id'=to_jsonb(NEW.supplier_id)
      AND NEW.result->'id'=to_jsonb(NEW.extract_id) AND NEW.result->'status'='0'::jsonb AND NEW.result->'pay_status'='0'::jsonb
      AND NEW.result->'add_time'=to_jsonb(NEW.created_at)))) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Invalid supplier extract application evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END`;
export const SUPPLIER_EXTRACT_APPLICATION_SQL=`CREATE TABLE public.supplier_extract_application_operation_v1 (
 operation_id uuid NOT NULL, actor_id integer NOT NULL, supplier_id integer NOT NULL,
 extract_id integer, state text NOT NULL, request_hash varchar(64) NOT NULL,
 intent jsonb, source jsonb, source_hash varchar(64) NOT NULL, result jsonb, result_hash varchar(64) NOT NULL, created_at integer NOT NULL,
 CONSTRAINT seao_pk PRIMARY KEY(operation_id),
 CONSTRAINT seao_extract_uq UNIQUE(extract_id),
 CONSTRAINT seao_extract_fk FOREIGN KEY(extract_id) REFERENCES public.supplier_extract(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE FUNCTION public.supplier_extract_application_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $seao$${SUPPLIER_EXTRACT_APPLICATION_GUARD}$seao$;
REVOKE ALL ON FUNCTION public.supplier_extract_application_guard_v1() FROM PUBLIC;
CREATE TRIGGER seao_insert BEFORE INSERT ON public.supplier_extract_application_operation_v1 FOR EACH ROW EXECUTE FUNCTION public.supplier_extract_application_guard_v1();
CREATE TRIGGER seao_rows BEFORE UPDATE OR DELETE ON public.supplier_extract_application_operation_v1 FOR EACH ROW EXECUTE FUNCTION public.supplier_extract_application_guard_v1();
CREATE TRIGGER seao_truncate BEFORE TRUNCATE ON public.supplier_extract_application_operation_v1 FOR EACH STATEMENT EXECUTE FUNCTION public.supplier_extract_application_guard_v1();
REVOKE ALL ON TABLE public.supplier_extract_application_operation_v1 FROM PUBLIC;
`;
const columns=[['operation_id','uuid',true],['actor_id','integer',true],['supplier_id','integer',true],['extract_id','integer',false],['state','text',true],['request_hash','character varying(64)',true],['intent','jsonb',false],['source','jsonb',false],['source_hash','character varying(64)',true],['result','jsonb',false],['result_hash','character varying(64)',true],['created_at','integer',true]];
export async function inspectSupplierExtractApplication(tx:Pick<DbClient,'execute'>,mode:'read'|'write'='read') {
 const[row]=await tx.execute(sql`SELECT current_user=session_user AND current_schema()='public'
  AND current_setting('server_version_num')::integer/10000=16 AND current_setting('session_replication_role')='origin'
  AND NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') AS environment,
 c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
  AND c.relnatts=12 AND c.relchecks=0 AND c.reloptions IS NULL AND c.relreplident='d' AND c.reltablespace=0
  AND c.relam=(SELECT oid FROM pg_am WHERE amname='heap') AND EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=c.relowner AND r.rolsuper)
  AND NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=c.oid) AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE confrelid=c.oid) AS relation,
 (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum)
  FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND NOT a.atthasdef AND a.attidentity='' AND a.attgenerated=''
   AND (a.attcollation=0 OR a.attcollation='pg_catalog.default'::regcollation)) AS columns,
 (SELECT count(*)=3 AND bool_and(k.convalidated AND NOT k.condeferrable AND NOT k.condeferred AND k.conislocal
  AND k.coninhcount=0 AND k.conparentid=0 AND ((k.conname='seao_pk' AND k.contype='p' AND k.conkey=ARRAY[1]::smallint[])
   OR(k.conname='seao_extract_uq' AND k.contype='u' AND k.conkey=ARRAY[4]::smallint[])
   OR(k.conname='seao_extract_fk' AND k.contype='f' AND k.conkey=ARRAY[4]::smallint[] AND k.confrelid=to_regclass('public.supplier_extract')
    AND k.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=to_regclass('public.supplier_extract') AND attname='id')]::smallint[]
    AND k.confupdtype='r' AND k.confdeltype='r' AND k.confmatchtype='s'))) FROM pg_constraint k WHERE k.conrelid=c.oid) AS constraints,
 (SELECT count(*)=2 AND bool_and(i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
  AND NOT i.indisexclusion AND NOT i.indnullsnotdistinct AND i.indnatts=1 AND i.indnkeyatts=1 AND i.indexprs IS NULL AND i.indpred IS NULL
  AND i.indoption::text='0' AND i.indcollation::text='0' AND x.relkind='i' AND x.relnamespace=c.relnamespace AND x.relowner=c.relowner
  AND x.reloptions IS NULL AND x.relam=(SELECT oid FROM pg_am WHERE amname='btree')
  AND ((x.relname='seao_pk' AND i.indisprimary AND i.indkey::text='1' AND i.indclass::text=(SELECT oid::text FROM pg_opclass WHERE opcname='uuid_ops' AND opcnamespace='pg_catalog'::regnamespace AND opcmethod=x.relam))
   OR(x.relname='seao_extract_uq' AND NOT i.indisprimary AND i.indkey::text='4' AND i.indclass::text=(SELECT oid::text FROM pg_opclass WHERE opcname='int4_ops' AND opcnamespace='pg_catalog'::regnamespace AND opcmethod=x.relam))))
  FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid WHERE i.indrelid=c.oid) AS indexes,
 (SELECT count(*)=5 AND count(*) FILTER(WHERE NOT t.tgisinternal)=3 AND bool_and(t.tgenabled='O' AND(t.tgisinternal OR(t.tgenabled='O'
  AND t.tgnargs=0 AND t.tgqual IS NULL AND t.tgconstraint=0 AND t.tgfoid=f.oid AND t.tgattr::text='' AND octet_length(t.tgargs)=0
  AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL AND ((t.tgname='seao_insert' AND t.tgtype=7)
   OR(t.tgname='seao_rows' AND t.tgtype=27) OR(t.tgname='seao_truncate' AND t.tgtype=34)))))
  FROM pg_trigger t WHERE t.tgrelid=c.oid) AS triggers,
 f.proowner=c.relowner AND f.prosrc=${SUPPLIER_EXTRACT_APPLICATION_GUARD} AND f.prorettype='pg_catalog.trigger'::regtype AND f.pronargs=0
  AND NOT f.prosecdef AND NOT f.proleakproof AND f.provolatile='v' AND f.prokind='f' AND NOT f.proisstrict AND NOT f.proretset
  AND f.proparallel='u' AND f.prosupport=0 AND f.provariadic=0 AND f.pronargdefaults=0 AND f.proargdefaults IS NULL
  AND f.proallargtypes IS NULL AND f.proargmodes IS NULL AND f.proargnames IS NULL AND f.procost=100 AND f.prorows=0
  AND f.probin IS NULL AND f.prosqlbody IS NULL AND f.protrftypes IS NULL AND f.proconfig=ARRAY['search_path=pg_catalog']
  AND f.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  AND (SELECT count(*)=1 FROM pg_proc WHERE pronamespace=f.pronamespace AND proname=f.proname)
  AND (SELECT count(*)=3 FROM pg_trigger WHERE tgfoid=f.oid)
  AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a WHERE a.grantee<>f.proowner) AS function,
 NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner
  AND(a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN('SELECT','INSERT')))
  AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) p WHERE a.attrelid=c.oid AND p.grantee<>c.relowner)
  AND has_table_privilege(current_user,c.oid,'SELECT') AND (${mode==='read'} OR has_table_privilege(current_user,c.oid,'INSERT'))
  AND(c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) OR NOT has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS privileges
 FROM pg_class c JOIN pg_proc f ON f.oid=to_regprocedure('public.supplier_extract_application_guard_v1()') WHERE c.oid=to_regclass('public.supplier_extract_application_operation_v1')`);
 return row;
}
export async function assertSupplierExtractApplicationReady(tx:Pick<DbClient,'execute'>,mode:'read'|'write'='read') {
 try {
  const[preflight]=await tx.execute(sql`SELECT c.relkind='r' AND has_table_privilege(current_user,c.oid,'SELECT') AS readable FROM pg_class c WHERE c.oid=to_regclass('public.supplier_extract_application_operation_v1')`);
  if(preflight?.readable!==true)throw Error('Missing SELECT or independent application catalog');
  await tx.execute(sql`SELECT operation_id FROM public.supplier_extract_application_operation_v1 LIMIT 0`);
  const state=await inspectSupplierExtractApplication(tx,mode);
  if(!state||['environment','relation','constraints','indexes','triggers','function','privileges'].some(key=>state[key]!==true)||JSON.stringify(state.columns)!==JSON.stringify(columns))throw Error('Application catalog drift');
 }catch(cause){throw Object.assign(new ServiceUnavailableException('提现原操作目录或运行权限尚未就绪'),{cause});}
}
export async function installSupplierExtractApplication(tx:Pick<DbClient,'execute'>,options:{runtimeRole?:string}={}) {
 if(Object.hasOwn(tx,'$client'))throw Error('0197 installation requires an existing owner maintenance transaction');
 const role=options.runtimeRole;if(role!==undefined&&!/^[a-z][a-z0-9_]{0,62}$/.test(role))throw Error('Invalid0197 runtime role');
 const[gate]=await tx.execute(sql`SELECT current_user=session_user AND current_schema()='public' AND current_setting('server_version_num')::integer/10000=16
  AND current_setting('transaction_isolation')='read committed' AND NOT current_setting('transaction_read_only')::boolean
  AND current_setting('session_replication_role')='origin' AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper)
  AND NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') AND pg_try_advisory_xact_lock(731627,21) AS supported,
  to_regclass('public.supplier_extract_application_operation_v1') IS NOT NULL AS table_exists,
  to_regprocedure('public.supplier_extract_application_guard_v1()') IS NOT NULL AS function_exists`);
 if(gate?.supported!==true)throw Error('0197 requires explicit PG16 maintenance');
 if(role){const[safe]=await tx.execute(sql`SELECT NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
  AND rolname<>current_user AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid)
  AND NOT has_schema_privilege(oid,'public','CREATE') AS safe FROM pg_roles WHERE rolname=${role}`);if(safe?.safe!==true)throw Error('0197 runtime must be independent restricted LOGIN');}
 if(gate.table_exists||gate.function_exists){if(!gate.table_exists||!gate.function_exists)throw Error('Partial0197 catalog requires review');await tx.execute(sql`LOCK TABLE ONLY public.supplier_extract_application_operation_v1 IN ACCESS EXCLUSIVE MODE NOWAIT`);await assertSupplierExtractApplicationReady(tx,'write');}
 else {await tx.execute(sql.raw(SUPPLIER_EXTRACT_APPLICATION_SQL));if(role)await tx.execute(sql.raw(`GRANT SELECT,INSERT ON TABLE public.supplier_extract_application_operation_v1 TO "${role}"`));await assertSupplierExtractApplicationReady(tx,'write');}
 if(role){const[rights]=await tx.execute(sql`SELECT has_table_privilege(${role},'public.supplier_extract_application_operation_v1','SELECT') AND has_table_privilege(${role},'public.supplier_extract_application_operation_v1','INSERT')
  AND NOT has_table_privilege(${role},'public.supplier_extract_application_operation_v1','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS ready`);if(rights?.ready!==true)throw Error('0197 runtime grants require review; existing catalog is never silently regranted');}
 return{applied:!gate.table_exists};
}
