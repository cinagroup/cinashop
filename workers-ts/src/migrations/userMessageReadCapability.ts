import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';

type Query=Pick<DbClient,'execute'>;
export const MESSAGE_READ_LOCK_NAMESPACE=731628;
export const USER_MESSAGE_READ_FUNCTION='cinashop_user_message_read_v1';
export const USER_MESSAGE_READ_SIGNATURE=`public.${USER_MESSAGE_READ_FUNCTION}(integer,integer[])`;
export interface UserMessageReadTarget {app:string;admin:string;maintenance:string;owner:string}

/** Fixed-scope receipt writer. The LOGIN is shared trusted application authority;
 * transaction-local actor context is supplied only after current JWT/password
 * validation by MessageCenterService, not by an HTTP field. This is not DB RLS
 * against a compromised application role able to issue arbitrary SQL. */
export function userMessageReadBody(app:string){
 pricingIdentifier(app);
 return `
DECLARE
 target_id integer;
 receipt_id integer;
 inserted_ids integer[] := ARRAY[]::integer[];
 updated_ids integer[] := ARRAY[]::integer[];
 changed_ids integer[];
 credential text;
BEGIN
 IF session_user <> '${app}' OR pg_catalog.current_setting('server_version_num')::integer/10000<>16
  OR (SELECT setting::bigint NOT BETWEEN 1 AND 5000 FROM pg_catalog.pg_settings WHERE name='statement_timeout')
  OR (SELECT setting::bigint NOT BETWEEN 1 AND 2000 FROM pg_catalog.pg_settings WHERE name='lock_timeout')
  OR pg_catalog.current_setting('session_replication_role') <> 'origin'
  OR pg_catalog.current_setting('transaction_isolation') <> 'read committed'
  OR pg_catalog.current_setting('transaction_read_only')::boolean
  OR p_uid IS NULL OR p_uid <= 0 OR p_ids IS NULL
  OR pg_catalog.cardinality(p_ids) > 100
  OR (pg_catalog.cardinality(p_ids)>0 AND pg_catalog.array_ndims(p_ids)<>1)
  OR EXISTS(SELECT 1 FROM pg_catalog.unnest(p_ids) x WHERE x IS NULL OR x<=0)
  OR p_ids IS DISTINCT FROM COALESCE((SELECT pg_catalog.array_agg(x ORDER BY x) FROM (SELECT DISTINCT x FROM pg_catalog.unnest(p_ids) x) s),ARRAY[]::integer[])
  OR pg_catalog.current_setting('cinashop.message_uid',true) IS DISTINCT FROM p_uid::text THEN
  RAISE EXCEPTION 'Message read requires a bound App transaction' USING ERRCODE='42501';
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(${MESSAGE_READ_LOCK_NAMESPACE},p_uid);
 SELECT pg_catalog.md5(pwd) INTO credential FROM public.user WHERE uid=p_uid AND status=1 AND is_del=0 AND delete_time IS NULL;
 IF NOT FOUND OR pg_catalog.current_setting('cinashop.message_auth',true) IS DISTINCT FROM credential THEN
  RAISE EXCEPTION 'Message account changed' USING ERRCODE='42501';
 END IF;
 IF (SELECT count(*) FROM public.system_message WHERE id=ANY(p_ids) AND status=1 AND is_del=0 AND type IN(0,1) AND look IN(0,1) AND user_id IN(0,p_uid))<>pg_catalog.cardinality(p_ids)
  OR EXISTS(SELECT 1 FROM public.user_message WHERE uid=p_uid AND message_id=ANY(p_ids) AND is_read NOT IN(0,1))
  OR (SELECT count(*) FROM public.user_message WHERE uid=p_uid AND message_id=ANY(p_ids))>1000 THEN
  RAISE EXCEPTION 'Message read targets require review' USING ERRCODE='23514';
 END IF;
 FOREACH target_id IN ARRAY p_ids LOOP
  -- Imported per-user look=1 remains read. A broadcast never changes globally.
  IF EXISTS(SELECT 1 FROM public.system_message WHERE id=target_id AND look=1)
   OR EXISTS(SELECT 1 FROM public.user_message WHERE uid=p_uid AND user_message.message_id=target_id AND is_read=1) THEN
   CONTINUE;
  END IF;
  IF EXISTS(SELECT 1 FROM public.user_message WHERE uid=p_uid AND user_message.message_id=target_id) THEN
   WITH changed AS (UPDATE public.user_message SET is_read=1 WHERE uid=p_uid AND user_message.message_id=target_id AND is_read=0 RETURNING id)
   SELECT pg_catalog.array_agg(id ORDER BY id) INTO changed_ids FROM changed;
   updated_ids := updated_ids || COALESCE(changed_ids,ARRAY[]::integer[]);
  ELSE
   -- Check existence under the UID lock BEFORE invoking the serial default.
   -- ON CONFLICT would consume a sequence even for an already-read page.
   INSERT INTO public.user_message(uid,message_id,is_read,add_time)
   VALUES(p_uid,target_id,1,pg_catalog.floor(EXTRACT(epoch FROM pg_catalog.clock_timestamp()))::integer)
   RETURNING id INTO receipt_id;
   inserted_ids := pg_catalog.array_append(inserted_ids,receipt_id);
  END IF;
 END LOOP;
 RETURN pg_catalog.jsonb_build_object('read_ids',p_ids,'inserted_receipt_ids',inserted_ids,'updated_receipt_ids',updated_ids);
END
`;
}

export interface UserMessageReadState {absent:boolean;ready:boolean;functionOid:string|null;definitionSafe:boolean;ownerSafe:boolean;aclSafe:boolean;tablesSafe:boolean}
export async function inspectUserMessageReadCapability(db:Query,appRole?:string):Promise<UserMessageReadState>{
 const app=appRole??String((await db.execute(sql`SELECT session_user AS role`))[0]?.role??'');pricingIdentifier(app);
 const rows=await db.execute(sql`SELECT p.oid::text AS oid,p.prosrc,p.prosecdef,p.provolatile,p.proparallel,p.prokind,
  p.prorettype='pg_catalog.jsonb'::regtype AND p.proargtypes='23 1007'::oidvector AND p.pronargs=2
   AND p.proargnames=ARRAY['p_uid','p_ids']::text[] AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AS signature,
  l.lanname='plpgsql' AND l.lanpltrusted AND NOT p.proleakproof AND NOT p.proisstrict AND NOT p.proretset
   AND p.provariadic=0 AND p.pronargdefaults=0 AND p.proargdefaults IS NULL AND p.prosupport=0
   AND p.probin IS NULL AND p.prosqlbody IS NULL AND p.procost=100 AND p.prorows=0 AS flags,
  p.proconfig,pg_catalog.pg_get_userbyid(p.proowner) AS owner
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
  WHERE p.pronamespace='public'::regnamespace AND p.proname=${USER_MESSAGE_READ_FUNCTION}`);
 const empty={absent:rows.length===0,ready:false,functionOid:null,definitionSafe:false,ownerSafe:false,aclSafe:false,tablesSafe:false};
 if(rows.length!==1)return empty;
 const row=rows[0]!,owner=String(row.owner),definitionSafe=row.prosrc===userMessageReadBody(app)&&row.prosecdef===true&&row.provolatile==='v'
  &&row.proparallel==='u'&&row.prokind==='f'&&row.signature===true&&row.flags===true&&JSON.stringify(row.proconfig)===JSON.stringify(['search_path=pg_catalog, pg_temp']);
 const [state]=await db.execute(sql`SELECT
  (SELECT count(*)=2 AND bool_and(a.privilege_type='EXECUTE' AND NOT a.is_grantable AND a.grantee IN(SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN(${app},${owner})))
   AND bool_or(a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${app})) AND bool_or(a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${owner}))
   FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a WHERE p.oid=${row.oid}::oid) AS acl,
  (SELECT NOT rolcanlogin AND NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usesysid=r.oid)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=r.oid)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner=r.oid)
   AND (SELECT count(*)=1 FROM pg_catalog.pg_proc WHERE proowner=r.oid)
   AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
   AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM') FROM pg_catalog.pg_roles r WHERE rolname=${owner}) AS owner_role,
  (SELECT rolcanlogin AND NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
   AND NOT pg_catalog.has_schema_privilege(r.oid,'public','CREATE') AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
   FROM pg_catalog.pg_roles r WHERE rolname=${app}) AS app_role,
  (SELECT count(*)=3 AND bool_and(c.relkind='r' AND c.relpersistence='p' AND NOT(c.relispartition OR c.relrowsecurity OR c.relforcerowsecurity)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
    AND (c.relname='user' OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal)))
   FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN('user','system_message','user_message')) AS tables,
  (SELECT array_agg(a.attname::text ORDER BY a.attnum)=ARRAY['id','uid','message_id','is_read','add_time']::text[]
    AND array_agg(a.atttypid::integer ORDER BY a.attnum)=ARRAY[23,23,23,21,23]::integer[] AND bool_and(a.attnotnull)
   FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.user_message'::regclass AND a.attnum>0 AND NOT a.attisdropped) AS columns,
  (SELECT array_agg(pg_catalog.pg_get_expr(d.adbin,d.adrelid) ORDER BY a.attnum)=ARRAY['nextval(''user_message_id_seq''::regclass)','0','0','0','0']::text[]
   FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.user_message'::regclass AND a.attnum>0 AND NOT a.attisdropped) AS defaults,
  (SELECT count(*)=1 AND bool_and(contype='p' AND conkey=ARRAY[1]::smallint[] AND convalidated AND NOT condeferrable AND NOT condeferred)
   FROM pg_catalog.pg_constraint WHERE conrelid='public.user_message'::regclass) AS constraints,
  (SELECT count(*)=2 AND bool_and(i.indisvalid AND i.indisready AND i.indislive AND i.indexprs IS NULL AND i.indpred IS NULL
   AND i.indnatts=i.indnkeyatts AND i.indoption::text !~ '[^0 ]' AND a.amname='btree'
   AND ((i.indisprimary AND i.indisunique AND i.indkey='1'::int2vector) OR (NOT i.indisprimary AND NOT i.indisunique AND i.indkey='2 3'::int2vector)))
   FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_am a ON a.oid=c.relam WHERE i.indrelid='public.user_message'::regclass) AS indexes,
  (pg_catalog.pg_get_serial_sequence('public.user_message','id')='public.user_message_id_seq' AND
   (SELECT count(*)=1 AND bool_and(c.relkind='S' AND c.relpersistence='p' AND s.seqtypid='pg_catalog.int4'::regtype
     AND s.seqstart=1 AND s.seqincrement=1 AND s.seqmin=1 AND s.seqmax=2147483647 AND s.seqcache=1 AND NOT s.seqcycle)
    FROM pg_catalog.pg_sequence s JOIN pg_catalog.pg_class c ON c.oid=s.seqrelid WHERE c.oid='public.user_message_id_seq'::regclass)) AS sequence,
  NOT pg_catalog.has_table_privilege(${app},'public.user_message','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT pg_catalog.has_any_column_privilege(${app},'public.user_message','INSERT,UPDATE,REFERENCES')
    AND NOT pg_catalog.has_sequence_privilege(${app},'public.user_message_id_seq','USAGE,SELECT,UPDATE') AS app_no_dml,
  (SELECT bool_and(pg_catalog.has_table_privilege(${owner},c.oid,p.privilege)=
     (p.privilege='SELECT' AND n.nspname='public' AND c.relname IN('user','system_message','user_message') OR p.privilege='INSERT' AND n.nspname='public' AND c.relname='user_message'))
    AND bool_and(NOT pg_catalog.has_table_privilege(${owner},c.oid,p.privilege||' WITH GRANT OPTION'))
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   CROSS JOIN (VALUES('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege)
   WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN('r','p','v','m','f')) AS owner_tables,
  (SELECT bool_and(pg_catalog.has_column_privilege(${owner},c.oid,a.attnum,p.privilege)=
      (n.nspname='public' AND (p.privilege='SELECT' AND c.relname IN('user','system_message','user_message')
       OR p.privilege='INSERT' AND c.relname='user_message' OR p.privilege='UPDATE' AND c.relname='user_message' AND a.attname='is_read')))
    AND bool_and(NOT pg_catalog.has_column_privilege(${owner},c.oid,a.attnum,p.privilege||' WITH GRANT OPTION'))
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
   CROSS JOIN (VALUES('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(privilege)
   WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN('r','p','v','m','f')) AS owner_columns,
  (SELECT bool_and(pg_catalog.has_sequence_privilege(${owner},c.oid,'USAGE')=(n.nspname='public' AND c.relname='user_message_id_seq'))
    AND bool_and(NOT pg_catalog.has_sequence_privilege(${owner},c.oid,'SELECT,UPDATE,USAGE WITH GRANT OPTION'))
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind='S') AS owner_sequences`);
 const ownerSafe=state?.owner_role===true&&owner!==app,aclSafe=state?.acl===true,
  tablesSafe=['app_role','tables','columns','defaults','constraints','indexes','sequence','app_no_dml','owner_tables','owner_columns','owner_sequences'].every(k=>state?.[k]===true);
 return {absent:false,ready:definitionSafe&&ownerSafe&&aclSafe&&tablesSafe,functionOid:String(row.oid),definitionSafe,ownerSafe,aclSafe,tablesSafe};
}

/** Explicit maintenance addon only. Existing App/Admin baseline ACLs stay fixed.
 * No runtime/startup/HTTP code installs or repairs this function or grants. */
export async function installUserMessageReadCapabilityInTransaction(tx:Query,target:UserMessageReadTarget){
 if(Object.hasOwn(tx,'$client'))throw Error('Message capability requires existing maintenance transaction');
 const identities=[target.app,target.admin,target.maintenance,target.owner];identities.forEach(pricingIdentifier);if(new Set(identities).size!==4)throw Error('Message capability identities must be distinct');
 await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),
  set_config('statement_timeout',least(nullif((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
  set_config('lock_timeout',least(nullif((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
  set_config('idle_in_transaction_session_timeout',least(nullif((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
 const [identity]=await tx.execute(sql`SELECT current_user=${target.maintenance} AND session_user=current_user
  AND pg_catalog.current_setting('server_version_num')::integer/10000=16 AND pg_catalog.current_setting('transaction_isolation')='read committed'
  AND NOT pg_catalog.current_setting('transaction_read_only')::boolean AND pg_catalog.current_setting('session_replication_role')='origin'
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
  AND (SELECT count(*)=2 AND bool_and(rolcanlogin AND NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)) FROM pg_catalog.pg_roles r WHERE rolname IN(${target.app},${target.admin})) AS supported,
  pg_catalog.pg_try_advisory_xact_lock(731626,12) AS locked`);
 if(identity?.supported!==true||identity.locked!==true)throw Error('Message capability requires explicit owned PG16 maintenance identities');
 const before=await inspectUserMessageReadCapability(tx,target.app);if(before.ready)return {applied:false,ready:true as const};
 if(!before.absent)throw Error('Message capability drift requires review');
 const [owner]=await tx.execute(sql`SELECT oid FROM pg_catalog.pg_roles r WHERE rolname=${target.owner} AND NOT rolcanlogin
  AND NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usesysid=r.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
  AND NOT pg_catalog.has_schema_privilege(r.oid,'public','CREATE') AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND CASE WHEN c.relkind='S' THEN pg_catalog.has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE')
    WHEN c.relkind IN('r','p','v','m','f') THEN pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') ELSE false END)`);
 if(!owner)throw Error('Message capability owner must be a fresh restricted NOLOGIN role');
 await tx.execute(sql.raw('LOCK TABLE ONLY public.user, ONLY public.system_message, ONLY public.user_message IN SHARE ROW EXCLUSIVE MODE NOWAIT'));
 if(!(await inspectUserMessageReadCapability(tx,target.app)).absent)throw Error('Message capability changed during installation');
 const own=pricingIdentifier(target.owner),app=pricingIdentifier(target.app);
 await tx.execute(sql.raw(`GRANT SELECT ON public.user,public.system_message,public.user_message TO ${own}`));
 await tx.execute(sql.raw(`GRANT INSERT ON public.user_message TO ${own}`));
 await tx.execute(sql.raw(`GRANT UPDATE(is_read) ON public.user_message TO ${own}`));
 await tx.execute(sql.raw(`GRANT USAGE ON SEQUENCE public.user_message_id_seq TO ${own}`));
 await tx.execute(sql.raw(`GRANT USAGE,CREATE ON SCHEMA public TO ${own}`));
 await tx.execute(sql.raw(`CREATE FUNCTION public.${USER_MESSAGE_READ_FUNCTION}(p_uid integer,p_ids integer[]) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $message_read$${userMessageReadBody(target.app)}$message_read$`));
 await tx.execute(sql.raw(`REVOKE ALL ON FUNCTION ${USER_MESSAGE_READ_SIGNATURE} FROM PUBLIC`));
 await tx.execute(sql.raw(`ALTER FUNCTION ${USER_MESSAGE_READ_SIGNATURE} OWNER TO ${own}`));
 await tx.execute(sql.raw(`REVOKE CREATE ON SCHEMA public FROM ${own}`));
 await tx.execute(sql.raw(`GRANT EXECUTE ON FUNCTION ${USER_MESSAGE_READ_SIGNATURE} TO ${app}`));
 const after=await inspectUserMessageReadCapability(tx,target.app);if(!after.ready)throw Error('Message capability final catalog verification failed: '+JSON.stringify(after));
 return {applied:true,ready:true as const};
}
export async function installUserMessageReadCapability(db:DbClient,target:UserMessageReadTarget){
 if(!Object.hasOwn(db,'$client'))throw Error('Message capability installer requires root maintenance connection');
 return db.transaction(tx=>installUserMessageReadCapabilityInTransaction(tx,target),{isolationLevel:'read committed',accessMode:'read write'});
}
export async function consumeUserMessages(tx:Query,uid:number,ids:number[]){
 const ordered=[...ids].sort((a,b)=>a-b);if(ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<1||id>2147483647))throw Error('Unbound message targets');
 const targets=ordered.length?sql`ARRAY[${sql.join(ordered.map(id=>sql`${id}`),sql`, `)}]::integer[]`:sql`ARRAY[]::integer[]`;
 const [row]=await tx.execute<{result:{read_ids:number[];inserted_receipt_ids:number[];updated_receipt_ids:number[]}}>(sql`SELECT public.cinashop_user_message_read_v1(${uid}::integer,${targets}) AS result`);
 if(!row?.result||JSON.stringify(Object.keys(row.result).sort())!==JSON.stringify(['inserted_receipt_ids','read_ids','updated_receipt_ids'])
  ||[row.result.read_ids,row.result.inserted_receipt_ids,row.result.updated_receipt_ids].some(values=>!Array.isArray(values)||values.length>1000||new Set(values).size!==values.length||values.some(id=>!Number.isSafeInteger(id)||id<1||id>2147483647))
  ||JSON.stringify(row.result.read_ids)!==JSON.stringify(ordered)||row.result.inserted_receipt_ids.some(id=>row.result.updated_receipt_ids.includes(id)))throw Error('Malformed message capability result');
 return row.result;
}
