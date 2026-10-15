import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';

export const PRODUCT_VIDEO_UPLOAD_GUARD = `BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.state <> 'active' THEN
    RAISE EXCEPTION 'Product video upload facts cannot be removed or reopened' USING ERRCODE='42501';
  END IF;
  IF (NEW.upload_id,NEW.actor_id,NEW.request_hash,NEW.intent,NEW.object_key,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM (OLD.upload_id,OLD.actor_id,OLD.request_hash,OLD.intent,OLD.object_key,OLD.created_at,OLD.expires_at)
    OR NEW.state NOT IN ('active','cancelled','committed') OR NEW.updated_at<OLD.updated_at
    OR NOT (NEW.parts @> OLD.parts) OR NOT (NEW.confirmed @> OLD.confirmed) THEN
    RAISE EXCEPTION 'Product video upload identity and confirmed parts are immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END`;
/** Independent PG16 addon; neither HTTP nor the historical bootstrap installs it. */
export const PRODUCT_VIDEO_UPLOAD_SQL = `CREATE TABLE public.admin_product_video_upload_v1 (
  upload_id uuid NOT NULL,
  actor_id integer NOT NULL,
  request_hash varchar(64) NOT NULL,
  intent jsonb,
  object_key varchar(180),
  state varchar(16) NOT NULL,
  parts jsonb NOT NULL,
  confirmed jsonb NOT NULL,
  attachment_id integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  expires_at integer NOT NULL,
  CONSTRAINT apvu_pk PRIMARY KEY(upload_id),
  CONSTRAINT apvu_object_uq UNIQUE(object_key),
  CONSTRAINT apvu_identity_ck CHECK (actor_id>0 AND created_at>0 AND updated_at>=created_at
    AND expires_at::bigint=created_at::bigint+43200
    AND upload_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT apvu_parts_ck CHECK (jsonb_typeof(parts)='object'
    AND jsonb_array_length(jsonb_path_query_array(parts,'$.keyvalue()'))<=100 AND octet_length(parts::text)<=16384),
  CONSTRAINT apvu_confirmed_ck CHECK (jsonb_typeof(confirmed)='array' AND jsonb_array_length(confirmed)<=100),
  CONSTRAINT apvu_state_ck CHECK ((
    (state='cancelled' AND attachment_id IS NULL AND (
      (intent IS NULL AND object_key IS NULL AND request_hash='' AND parts='{}'::jsonb AND confirmed='[]'::jsonb)
      OR (jsonb_typeof(intent)='object' AND request_hash ~ '^[0-9a-f]{64}$' AND object_key IS NOT NULL)))
    OR (state IN ('active','committed') AND jsonb_typeof(intent)='object'
      AND request_hash ~ '^[0-9a-f]{64}$' AND object_key IS NOT NULL
      AND ((state='active' AND attachment_id IS NULL) OR (state='committed' AND attachment_id>0)))) IS TRUE),
  CONSTRAINT apvu_object_ck CHECK (object_key IS NULL OR object_key ~ '^attachments/admin/1/[0-9]{4}/[0-9]{2}/[a-f0-9-]{36}\\.mp4$')
);
CREATE FUNCTION public.admin_product_video_upload_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $apvu$${PRODUCT_VIDEO_UPLOAD_GUARD}$apvu$;
REVOKE ALL ON FUNCTION public.admin_product_video_upload_guard_v1() FROM PUBLIC;
CREATE TRIGGER apvu_rows BEFORE UPDATE OR DELETE ON public.admin_product_video_upload_v1
FOR EACH ROW EXECUTE FUNCTION public.admin_product_video_upload_guard_v1();
CREATE TRIGGER apvu_truncate BEFORE TRUNCATE ON public.admin_product_video_upload_v1
FOR EACH STATEMENT EXECUTE FUNCTION public.admin_product_video_upload_guard_v1();
REVOKE ALL ON TABLE public.admin_product_video_upload_v1 FROM PUBLIC;
`;
// Canonical PG16 CHECK/PK/UNIQUE definitions, observed in the owned native fixture.
export const PRODUCT_VIDEO_UPLOAD_CONSTRAINTS_SHA256 = 'ffd1cfba40b684be1c57d304841983d3179cea5ea160c01b05840c7efb68109a';
const columns = [
  ['upload_id','uuid',true,null],['actor_id','integer',true,null],['request_hash','character varying(64)',true,'"default"'],
  ['intent','jsonb',false,null],['object_key','character varying(180)',false,'"default"'],['state','character varying(16)',true,'"default"'],
  ['parts','jsonb',true,null],['confirmed','jsonb',true,null],['attachment_id','integer',false,null],['created_at','integer',true,null],
  ['updated_at','integer',true,null],['expires_at','integer',true,null],
];
export async function inspectProductVideoUpload(tx: Pick<DbClient,'execute'>) {
  const [row] = await tx.execute(sql`SELECT
    c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND c.relnatts=12 AND c.relchecks=5 AND c.reloptions IS NULL AND c.relreplident='d'
      AND c.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid=c.relowner AND rolsuper)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype NOT IN ('p','u','c','n')) AS safe,
    (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
       CASE WHEN a.attcollation=0 THEN NULL ELSE a.attcollation::regcollation::text END,
       a.attnum,a.atthasdef,a.attidentity,a.attgenerated,a.attisdropped) ORDER BY a.attnum)
       FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0) AS columns,
    (SELECT count(*)=7 AND bool_and(convalidated AND NOT condeferrable AND NOT condeferred AND conislocal AND coninhcount=0 AND conparentid=0)
      FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype IN ('p','u','c')) AS constraint_count,
    (SELECT encode(sha256(convert_to(jsonb_object_agg(conname,pg_get_constraintdef(oid,false) ORDER BY conname)::text,'UTF8')),'hex')
      FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype IN ('p','u','c')) AS constraints_hash,
    (SELECT count(*)=2 AND bool_and(indisunique AND indisvalid AND indisready AND indislive AND indimmediate
      AND NOT indisexclusion AND indexprs IS NULL AND indpred IS NULL AND indnatts=1 AND indnkeyatts=1
      AND indoption::text='0' AND NOT indnullsnotdistinct
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_class i WHERE i.oid=indexrelid AND i.relkind='i'
        AND i.relpersistence='p' AND i.reloptions IS NULL AND i.relowner=c.relowner
        AND i.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree'))
      AND ((indisprimary AND indkey::text='1' AND indcollation::text='0' AND indclass::text=(SELECT oid::text FROM pg_catalog.pg_opclass
        WHERE opcname='uuid_ops' AND opcnamespace='pg_catalog'::regnamespace AND opcmethod=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')))
       OR (NOT indisprimary AND indkey::text='5'
        AND indcollation::text=(SELECT oid::text FROM pg_catalog.pg_collation WHERE collname='default' AND collnamespace='pg_catalog'::regnamespace)
        AND indclass::text=(SELECT oid::text FROM pg_catalog.pg_opclass
        WHERE opcname='text_ops' AND opcnamespace='pg_catalog'::regnamespace AND opcmethod=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')))))
      FROM pg_catalog.pg_index WHERE indrelid=c.oid) AS indexes,
    (SELECT count(*)=2 AND bool_and(NOT t.tgisinternal AND t.tgenabled='O' AND t.tgnargs=0 AND t.tgqual IS NULL
      AND t.tgconstraint=0 AND t.tgfoid=f.oid AND t.tgattr::text='' AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
      AND ((t.tgname='apvu_rows' AND t.tgtype=27) OR (t.tgname='apvu_truncate' AND t.tgtype=34)))
      FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid) AS triggers,
    f.proowner=c.relowner AND f.prosrc=${PRODUCT_VIDEO_UPLOAD_GUARD} AND f.prorettype='pg_catalog.trigger'::regtype AND f.pronargs=0
      AND NOT f.prosecdef AND NOT f.proleakproof AND f.provolatile='v' AND f.prokind='f' AND f.proconfig=ARRAY['search_path=pg_catalog']
      AND NOT f.proisstrict AND NOT f.proretset AND f.proparallel='u' AND f.prosupport=0 AND f.provariadic=0
      AND f.pronargdefaults=0 AND f.proargdefaults IS NULL AND f.proallargtypes IS NULL AND f.proargmodes IS NULL AND f.proargnames IS NULL
      AND f.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a WHERE a.grantee<>f.proowner) AS function,
    NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE a.grantee<>c.relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT','UPDATE')))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
        WHERE col.attrelid=c.oid AND a.grantee<>c.relowner)
      AND has_table_privilege(current_user,c.oid,'SELECT') AND has_table_privilege(current_user,c.oid,'INSERT') AND has_table_privilege(current_user,c.oid,'UPDATE')
      AND (c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) OR NOT has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS privileges
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_proc f ON f.oid=to_regprocedure('public.admin_product_video_upload_guard_v1()')
    WHERE c.oid=to_regclass('public.admin_product_video_upload_v1')`);
  return row;
}
export async function assertProductVideoUploadReady(tx: Pick<DbClient,'execute'>) {
  try {
    await tx.execute(sql`SELECT upload_id FROM public.admin_product_video_upload_v1 LIMIT 0`);
    const state=await inspectProductVideoUpload(tx);
    if (!state || ['safe','constraint_count','indexes','triggers','function','privileges'].some(key=>state[key]!==true)
      || state.constraints_hash!==PRODUCT_VIDEO_UPLOAD_CONSTRAINTS_SHA256
      || JSON.stringify(state.columns)!==JSON.stringify(columns.map((column,index)=>[...column,index+1,false,'','',false])))
      throw Error('Product video upload catalog drift');
  } catch(cause) { throw Object.assign(new ServiceUnavailableException('商品视频上传会话或运行权限尚未就绪'),{cause}); }
}
export async function installProductVideoUpload(tx: Pick<DbClient,'execute'>, runtimeRole?: string) {
  if (Object.hasOwn(tx,'$client') || runtimeRole!==undefined&&!/^[a-z][a-z0-9_]{0,62}$/.test(runtimeRole)) throw Error('Explicit video maintenance transaction/identity required');
  const [gate]=await tx.execute(sql`SELECT current_user AS identity,current_user=session_user AND current_schema()='public'
    AND current_setting('server_version_num')::integer/10000=16 AND current_setting('transaction_isolation')='read committed'
    AND NOT current_setting('transaction_read_only')::boolean AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AND pg_try_advisory_xact_lock(731626,10) AS supported,
    to_regclass('public.admin_product_video_upload_v1') IS NOT NULL AS table_exists,
    to_regprocedure('public.admin_product_video_upload_guard_v1()') IS NOT NULL AS function_exists`);
  if(gate?.supported!==true)throw Error('Video installation requires explicit PG16 owner maintenance');
  if(runtimeRole){const [role]=await tx.execute(sql`SELECT NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls AS safe FROM pg_catalog.pg_roles WHERE rolname=${runtimeRole}`);
    if(role?.safe!==true||runtimeRole===gate.identity)throw Error('Video runtime must be a separate restricted identity');}
  if(gate.table_exists||gate.function_exists){
    if(!gate.table_exists||!gate.function_exists)throw Error('Partial video upload catalog requires review');
    await tx.execute(sql`LOCK TABLE ONLY public.admin_product_video_upload_v1 IN ACCESS EXCLUSIVE MODE NOWAIT`);
    await assertProductVideoUploadReady(tx);
  }else{
    await tx.execute(sql.raw(PRODUCT_VIDEO_UPLOAD_SQL));
    if(runtimeRole)await tx.execute(sql.raw(`GRANT SELECT,INSERT,UPDATE ON TABLE public.admin_product_video_upload_v1 TO "${runtimeRole}"`));
    await assertProductVideoUploadReady(tx);
  }
  if(runtimeRole){const [grant]=await tx.execute(sql`SELECT has_table_privilege(${runtimeRole},'public.admin_product_video_upload_v1','SELECT')
    AND has_table_privilege(${runtimeRole},'public.admin_product_video_upload_v1','INSERT') AND has_table_privilege(${runtimeRole},'public.admin_product_video_upload_v1','UPDATE')
    AND NOT has_table_privilege(${runtimeRole},'public.admin_product_video_upload_v1','DELETE,TRUNCATE,REFERENCES,TRIGGER') AS ready`);
    if(grant?.ready!==true)throw Error('Video runtime grants require review');}
  return {applied:!gate.table_exists};
}
