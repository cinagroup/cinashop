import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';

export const PRODUCT_VIDEO_GC_GUARD = `DECLARE
  now_seconds bigint;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'Product video GC scopes cannot be added or removed' USING ERRCODE='42501';
  END IF;
  IF NEW.scope IS DISTINCT FROM OLD.scope OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'Product video GC scope and time are immutable or monotone' USING ERRCODE='42501';
  END IF;
  now_seconds := floor(extract(epoch FROM clock_timestamp()))::bigint;
  IF (NEW.cursor,NEW.maximum,NEW.cycle,NEW.last_completed_at)
      IS NOT DISTINCT FROM (OLD.cursor,OLD.maximum,OLD.cycle,OLD.last_completed_at)
    AND NEW.lease_token IS NOT NULL AND NEW.lease_token IS DISTINCT FROM OLD.lease_token
    AND (OLD.lease_token IS NULL OR OLD.lease_until<=now_seconds)
    AND NEW.lease_until>now_seconds AND NEW.lease_until<=now_seconds+120 THEN
    RETURN NEW;
  END IF;
  IF OLD.maximum IS NULL AND OLD.cursor IS NULL AND NEW.maximum IS NOT NULL AND NEW.cursor IS NULL
    AND OLD.lease_token IS NOT NULL AND NEW.lease_token=OLD.lease_token AND NEW.lease_until=OLD.lease_until
    AND NEW.cycle=OLD.cycle AND NEW.last_completed_at=OLD.last_completed_at THEN
    RETURN NEW;
  END IF;
  IF OLD.lease_token IS NOT NULL AND NEW.lease_token IS NULL AND NEW.lease_until=0 AND (
    (NEW.cursor,NEW.maximum,NEW.cycle,NEW.last_completed_at)
      IS NOT DISTINCT FROM (OLD.cursor,OLD.maximum,OLD.cycle,OLD.last_completed_at)
    OR (OLD.maximum IS NOT NULL AND NEW.maximum=OLD.maximum AND NEW.cycle=OLD.cycle
      AND NEW.last_completed_at=OLD.last_completed_at AND NEW.cursor IS NOT NULL
      AND (OLD.cursor IS NULL OR NEW.cursor>OLD.cursor) AND NEW.cursor<=OLD.maximum)
    OR (NEW.cursor IS NULL AND NEW.maximum IS NULL AND NEW.cycle::bigint=OLD.cycle::bigint+1
      AND NEW.last_completed_at>=OLD.last_completed_at AND NEW.last_completed_at>0)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Product video GC update is not an allowed lease transition' USING ERRCODE='42501';
END`;
/** Independent PG16 addon. Owner seeds the only two scopes before enabling the guard. */
export const PRODUCT_VIDEO_GC_SQL = `CREATE TABLE public.product_video_gc_state_v1 (
  scope varchar(16) NOT NULL,
  cursor uuid,
  maximum uuid,
  cycle integer NOT NULL,
  lease_token uuid,
  lease_until integer NOT NULL,
  last_completed_at integer NOT NULL,
  updated_at integer NOT NULL,
  CONSTRAINT pvgc_pk PRIMARY KEY(scope),
  CONSTRAINT pvgc_scope_ck CHECK (scope IN ('admin','supplier')),
  CONSTRAINT pvgc_numeric_ck CHECK (cycle>=0 AND lease_until>=0 AND last_completed_at>=0 AND updated_at>=0),
  CONSTRAINT pvgc_cursor_ck CHECK (cursor IS NULL OR (maximum IS NOT NULL AND cursor<=maximum)),
  CONSTRAINT pvgc_lease_ck CHECK ((lease_token IS NULL)=(lease_until=0))
);
INSERT INTO public.product_video_gc_state_v1
  (scope,cursor,maximum,cycle,lease_token,lease_until,last_completed_at,updated_at)
  VALUES ('admin',NULL,NULL,0,NULL,0,0,0),('supplier',NULL,NULL,0,NULL,0,0,0);
CREATE FUNCTION public.product_video_gc_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $pvgc$${PRODUCT_VIDEO_GC_GUARD}$pvgc$;
REVOKE ALL ON FUNCTION public.product_video_gc_guard_v1() FROM PUBLIC;
CREATE TRIGGER pvgc_rows BEFORE INSERT OR UPDATE OR DELETE ON public.product_video_gc_state_v1
FOR EACH ROW EXECUTE FUNCTION public.product_video_gc_guard_v1();
CREATE TRIGGER pvgc_truncate BEFORE TRUNCATE ON public.product_video_gc_state_v1
FOR EACH STATEMENT EXECUTE FUNCTION public.product_video_gc_guard_v1();
REVOKE ALL ON TABLE public.product_video_gc_state_v1 FROM PUBLIC;
`;
// Canonical PG16 CHECK/PK definitions, observed in the owned native fixture.
export const PRODUCT_VIDEO_GC_CONSTRAINTS_SHA256 = 'c1cafbee7cb15b8ebadbe4c69a953e31198c181db50ddaee5c5b9d18953ab27f';
const columns = [
  ['scope','character varying(16)',true,'"default"'],['cursor','uuid',false,null],['maximum','uuid',false,null],
  ['cycle','integer',true,null],['lease_token','uuid',false,null],['lease_until','integer',true,null],
  ['last_completed_at','integer',true,null],['updated_at','integer',true,null],
];
export async function inspectProductVideoGc(tx: Pick<DbClient,'execute'>) {
  const [row] = await tx.execute(sql`SELECT
    c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND c.relnatts=8 AND c.relchecks=4 AND c.reloptions IS NULL AND c.relreplident='d'
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
    (SELECT count(*)=5 AND bool_and(convalidated AND NOT condeferrable AND NOT condeferred AND conislocal AND coninhcount=0 AND conparentid=0)
      FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype IN ('p','u','c')) AS constraint_count,
    (SELECT encode(sha256(convert_to(jsonb_object_agg(conname,pg_get_constraintdef(oid,false) ORDER BY conname)::text,'UTF8')),'hex')
      FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype IN ('p','u','c')) AS constraints_hash,
    (SELECT count(*)=1 AND bool_and(indisprimary AND indisunique AND indisvalid AND indisready AND indislive AND indimmediate
      AND NOT indisexclusion AND indexprs IS NULL AND indpred IS NULL AND indnatts=1 AND indnkeyatts=1
      AND indoption::text='0' AND NOT indnullsnotdistinct AND indkey::text='1'
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_class i WHERE i.oid=indexrelid AND i.relkind='i'
        AND i.relpersistence='p' AND i.reloptions IS NULL AND i.relowner=c.relowner
        AND i.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree'))
      AND indcollation::text=(SELECT oid::text FROM pg_catalog.pg_collation WHERE collname='default' AND collnamespace='pg_catalog'::regnamespace)
      AND indclass::text=(SELECT oid::text FROM pg_catalog.pg_opclass
        WHERE opcname='text_ops' AND opcnamespace='pg_catalog'::regnamespace AND opcmethod=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')))
      FROM pg_catalog.pg_index WHERE indrelid=c.oid) AS indexes,
    (SELECT count(*)=2 AND bool_and(NOT t.tgisinternal AND t.tgenabled='O' AND t.tgnargs=0 AND t.tgqual IS NULL
      AND t.tgconstraint=0 AND t.tgfoid=f.oid AND t.tgattr::text='' AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
      AND ((t.tgname='pvgc_rows' AND t.tgtype=31) OR (t.tgname='pvgc_truncate' AND t.tgtype=34)))
      FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid) AS triggers,
    f.proowner=c.relowner AND f.prosrc=${PRODUCT_VIDEO_GC_GUARD} AND f.prorettype='pg_catalog.trigger'::regtype AND f.pronargs=0
      AND NOT f.prosecdef AND NOT f.proleakproof AND f.provolatile='v' AND f.prokind='f' AND f.proconfig=ARRAY['search_path=pg_catalog']
      AND NOT f.proisstrict AND NOT f.proretset AND f.proparallel='u' AND f.prosupport=0 AND f.provariadic=0
      AND f.pronargdefaults=0 AND f.proargdefaults IS NULL AND f.proallargtypes IS NULL AND f.proargmodes IS NULL AND f.proargnames IS NULL
      AND f.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a WHERE a.grantee<>f.proowner) AS function,
    NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE a.grantee<>c.relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','UPDATE')))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
        WHERE col.attrelid=c.oid AND a.grantee<>c.relowner)
      AND has_table_privilege(current_user,c.oid,'SELECT') AND has_table_privilege(current_user,c.oid,'UPDATE')
      AND (c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) OR NOT has_table_privilege(current_user,c.oid,'INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS privileges,
    (SELECT count(*)=2 AND bool_and(scope IN ('admin','supplier')) FROM public.product_video_gc_state_v1) AS scopes
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_proc f ON f.oid=to_regprocedure('public.product_video_gc_guard_v1()')
    WHERE c.oid=to_regclass('public.product_video_gc_state_v1')`);
  return row;
}
export async function assertProductVideoGcReady(tx: Pick<DbClient,'execute'>) {
  try {
    await tx.execute(sql`SELECT scope FROM public.product_video_gc_state_v1 LIMIT 0`);
    const state=await inspectProductVideoGc(tx);
    if (!state || ['safe','constraint_count','indexes','triggers','function','privileges','scopes'].some(key=>state[key]!==true)
      || state.constraints_hash!==PRODUCT_VIDEO_GC_CONSTRAINTS_SHA256
      || JSON.stringify(state.columns)!==JSON.stringify(columns.map((column,index)=>[...column,index+1,false,'','',false])))
      throw Error('Product video GC catalog drift');
  } catch(cause) { throw Object.assign(new ServiceUnavailableException('商品视频清理状态或运行权限尚未就绪'),{cause}); }
}
export async function installProductVideoGc(tx: Pick<DbClient,'execute'>, runtimeRole?: string) {
  if (Object.hasOwn(tx,'$client') || runtimeRole!==undefined&&!/^[a-z][a-z0-9_]{0,62}$/.test(runtimeRole)) throw Error('Explicit video GC maintenance transaction/identity required');
  const [gate]=await tx.execute(sql`SELECT current_user AS identity,current_user=session_user AND current_schema()='public'
    AND current_setting('server_version_num')::integer/10000=16 AND current_setting('transaction_isolation')='read committed'
    AND NOT current_setting('transaction_read_only')::boolean AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AND pg_try_advisory_xact_lock(731627,11) AS supported,
    to_regclass('public.product_video_gc_state_v1') IS NOT NULL AS table_exists,
    to_regprocedure('public.product_video_gc_guard_v1()') IS NOT NULL AS function_exists`);
  if(gate?.supported!==true)throw Error('Video GC installation requires explicit PG16 owner maintenance');
  if(runtimeRole){const [role]=await tx.execute(sql`SELECT NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls AS safe FROM pg_catalog.pg_roles WHERE rolname=${runtimeRole}`);
    if(role?.safe!==true||runtimeRole===gate.identity)throw Error('Video GC runtime must be a separate restricted identity');}
  if(gate.table_exists||gate.function_exists){
    if(!gate.table_exists||!gate.function_exists)throw Error('Partial video GC catalog requires review');
    await tx.execute(sql`LOCK TABLE ONLY public.product_video_gc_state_v1 IN ACCESS EXCLUSIVE MODE NOWAIT`);
    await assertProductVideoGcReady(tx);
  }else{
    await tx.execute(sql.raw(PRODUCT_VIDEO_GC_SQL));
    if(runtimeRole)await tx.execute(sql.raw(`GRANT SELECT,UPDATE ON TABLE public.product_video_gc_state_v1 TO "${runtimeRole}"`));
    await assertProductVideoGcReady(tx);
  }
  if(runtimeRole){const [grant]=await tx.execute(sql`SELECT has_table_privilege(${runtimeRole},'public.product_video_gc_state_v1','SELECT')
    AND has_table_privilege(${runtimeRole},'public.product_video_gc_state_v1','UPDATE')
    AND NOT has_table_privilege(${runtimeRole},'public.product_video_gc_state_v1','INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS ready`);
    if(grant?.ready!==true)throw Error('Video GC runtime grants require review');}
  return {applied:!gate.table_exists};
}
