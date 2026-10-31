import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { WECHAT_ROUTINE_INSERT_METADATA } from '@/services/admin/AdminWechatRoutineMetadata';
import { ADMIN_WECHAT_ROUTINE_STORED_TEXT_FUNCTION } from './adminWechatRoutineStoredText';

export const ADMIN_WECHAT_ROUTINE_WRITE_FUNCTION = 'cinashop_admin_wechat_routine_write_v1';
export const ADMIN_WECHAT_ROUTINE_WRITE_SIGNATURE = `public.${ADMIN_WECHAT_ROUTINE_WRITE_FUNCTION}(uuid,integer,text,text,text,text,jsonb)`;
export const ADMIN_WECHAT_ROUTINE_CONFIG_GUARD_FUNCTION = 'cinashop_wechat_routine_config_guard_v1';
export const ADMIN_WECHAT_ROUTINE_CONFIG_GUARD_SIGNATURE = `public.${ADMIN_WECHAT_ROUTINE_CONFIG_GUARD_FUNCTION}()`;
export const ADMIN_WECHAT_ROUTINE_REQUEST_GATE = 731668;
const keys = ['routine_appId', 'routine_appsecret', 'routine_name', 'routine_contact_type', 'store_user_avatar'] as const;
const keyArray = `ARRAY[${keys.map(key => `'${key}'`).join(',')}]::text[]`;

/** Immutable installation identities, never HTTP fields or transaction GUCs.
 * The maintenance installer must capture actual OIDs under its commissioning
 * lock and audit the complete role/object/ACL profiles before publishing them.
 */
export interface AdminWechatRoutineWriteBinding {
  database: string; databaseOid: number;
  admin: string; adminOid: number;
  writer: string; writerOid: number;
}

function identity(binding: AdminWechatRoutineWriteBinding): string {
  for (const value of [binding.database, binding.admin, binding.writer]) pricingIdentifier(value);
  for (const value of [binding.databaseOid, binding.adminOid, binding.writerOid]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 4294967295) throw Error('Routine capability requires actual PostgreSQL OIDs');
  }
  if (binding.admin === binding.writer || binding.adminOid === binding.writerOid) throw Error('Routine writer must be independent of Admin');
  return `pg_catalog.current_database()='${binding.database}'
    AND (SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())=${binding.databaseOid}::oid
    AND session_user='${binding.admin}'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=session_user AND r.oid=${binding.adminOid}::oid
      AND r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid))
    AND current_user='${binding.writer}'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=current_user AND r.oid=${binding.writerOid}::oid
      AND NOT(r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid))`;
}

/** Complete selected source, including every platform shadow, metadata and
 * xmin. This private DB digest is never an HTTP revision or a credential stamp.
 * The service will HMAC it with its actor binding; APP_KEY never enters SQL.
 */
export const ADMIN_WECHAT_ROUTINE_SOURCE_SQL = `SELECT COALESCE(
  pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c)||pg_catalog.jsonb_build_object('version',c.xmin::text)
    ORDER BY c.sort DESC,c.id DESC),'[]'::jsonb)
  FROM public.system_config c WHERE c.is_store=0 AND c.menu_name=ANY(${keyArray})`;

const digest = (expression: string) => `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((${expression})::text,'UTF8')),'hex')`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
function metadataJson(): string {
  const map = Object.fromEntries(keys.map(key => {
    const m = WECHAT_ROUTINE_INSERT_METADATA[key];
    return [key, { type: m.type, input_type: m.inputType, config_tab_id: m.configTabId,
      parameter: m.parameter, upload_type: m.uploadType, required: m.required,
      width: m.width, high: m.high, info: m.info, desc: m.desc, sort: m.sort, status: m.status }];
  }));
  return `${literal(JSON.stringify(map))}::jsonb`;
}

/** Both OLD and NEW participate even outside the platform realm. A rename,
 * realm move, metadata edit, shadow edit, deletion or TRUNCATE cannot evade the
 * boundary. Possessing an advisory lock or setting a GUC grants no authority.
 */
export function adminWechatRoutineConfigGuardBody(binding: AdminWechatRoutineWriteBinding): string {
  const bound = identity(binding);
  return `
DECLARE
  protected boolean;
  expected jsonb;
BEGIN
  IF TG_OP='TRUNCATE' THEN
    RAISE EXCEPTION 'Routine configuration cannot be truncated' USING ERRCODE='42501';
  END IF;
  IF TG_OP='INSERT' THEN protected:=NEW.menu_name=ANY(${keyArray});
  ELSIF TG_OP='DELETE' THEN protected:=OLD.menu_name=ANY(${keyArray});
  ELSE protected:=OLD.menu_name=ANY(${keyArray}) OR NEW.menu_name=ANY(${keyArray}); END IF;
  IF current_user='${binding.writer}' OR protected THEN
    IF NOT (${bound}) OR NOT protected OR TG_OP='DELETE' THEN
      RAISE EXCEPTION 'Routine configuration requires its bounded writer' USING ERRCODE='42501';
    END IF;
    IF NEW.is_store<>0 OR NOT NEW.menu_name=ANY(${keyArray}) THEN
      RAISE EXCEPTION 'Routine configuration requires its bounded writer' USING ERRCODE='42501';
    END IF;
    IF TG_OP='UPDATE' AND (pg_catalog.to_jsonb(NEW)-'value') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD)-'value') THEN
      RAISE EXCEPTION 'Routine configuration metadata is immutable to runtime writers' USING ERRCODE='42501';
    END IF;
    IF TG_OP='INSERT' THEN
      expected := (${metadataJson()})->NEW.menu_name;
      IF (pg_catalog.to_jsonb(NEW)-ARRAY['id','menu_name','value','is_store']) IS DISTINCT FROM expected
        OR EXISTS(SELECT 1 FROM public.system_config WHERE is_store=0 AND menu_name=NEW.menu_name) THEN
        RAISE EXCEPTION 'Routine missing-row metadata or source changed' USING ERRCODE='42501';
      END IF;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
`;
}

/** Atomic low-level protocol, not an HTTP actor authenticator or an installer.
 * Only this function's NOLOGIN owner may write the five settings and receipt.
 * Node validates the current JWT/staff/permissions and HMAC source revision in
 * the same caller transaction. SQL independently compares complete source and
 * derives both before/after facts and payload identity; it never accepts a
 * caller's claimed post-state, arbitrary receipt JSON or APP_KEY.
 *
 * Account ownership commissioning remains absent: material AppID changes fail
 * closed here, including first adoption. This is not the completed account
 * switch implementation and must not be published as a ready author endpoint.
 */
export function adminWechatRoutineWriteBody(binding: AdminWechatRoutineWriteBinding): string {
  const bound = identity(binding);
  return `
DECLARE
  prior public.admin_wechat_routine_operation%ROWTYPE;
  selected public.system_config%ROWTYPE;
  source jsonb;
  before_source text;
  after_source text;
  payload text;
  field jsonb;
  k text;
  action text;
  raw text;
  material bytea;
  previous_material bytea;
  row_count integer;
  changed text[] := ARRAY[]::text[];
  changes jsonb := '{}'::jsonb;
  metadata jsonb := ${metadataJson()};
  m jsonb;
  found_row boolean;
BEGIN
  IF NOT (${bound}) OR pg_catalog.current_setting('server_version_num')::integer/10000<>16
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR pg_catalog.current_setting('transaction_read_only')<>'off'
    OR pg_catalog.current_setting('session_replication_role')<>'origin'
    OR (SELECT setting::bigint NOT BETWEEN 1 AND 5000 FROM pg_catalog.pg_settings WHERE name='statement_timeout')
    OR (SELECT setting::bigint NOT BETWEEN 1 AND 2000 FROM pg_catalog.pg_settings WHERE name='lock_timeout') THEN
    RAISE EXCEPTION 'Routine author requires its bound ordinary transaction' USING ERRCODE='42501';
  END IF;
  IF p_id IS NULL OR p_id::text !~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    OR p_actor IS NULL OR p_actor<=0 OR p_operation IS NULL OR p_operation NOT IN('save','resolve')
    OR p_revision IS NULL OR p_revision !~ '^[a-f0-9]{64}$'
    OR p_expected_source IS NULL OR p_expected_source !~ '^[a-f0-9]{64}$'
    OR p_actor_binding IS NULL OR p_actor_binding !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Invalid Routine operation identity' USING ERRCODE='23514';
  END IF;
  IF p_operation='save' THEN
    IF pg_catalog.jsonb_typeof(p_fields) IS DISTINCT FROM 'object'
      OR NOT p_fields ?& ${keyArray} OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(p_fields))<>5 THEN
      RAISE EXCEPTION 'Routine intents must contain exactly five fields' USING ERRCODE='23514';
    END IF;
    FOREACH k IN ARRAY ${keyArray} LOOP
      field:=p_fields->k; action:=field->>'action';
      IF pg_catalog.jsonb_typeof(field) IS DISTINCT FROM 'object'
        OR pg_catalog.jsonb_typeof(field->'action') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'Invalid Routine intent' USING ERRCODE='23514';
      END IF;
      IF action='keep' OR action='clear' AND k='routine_appsecret' THEN
        IF (SELECT count(*) FROM pg_catalog.jsonb_object_keys(field))<>1 THEN
          RAISE EXCEPTION 'Routine keep/clear cannot carry a value' USING ERRCODE='23514';
        END IF;
        IF action='clear' THEN changes:=changes||pg_catalog.jsonb_build_object(k,'""'::text); END IF;
      ELSIF action='replace' THEN
        IF NOT field ?& ARRAY['action','raw'] OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(field))<>2
          OR pg_catalog.jsonb_typeof(field->'raw') IS DISTINCT FROM 'string' THEN
          RAISE EXCEPTION 'Routine replacement requires only its serialized value' USING ERRCODE='23514';
        END IF;
        raw:=field->>'raw';
        IF k IN('routine_contact_type','store_user_avatar') THEN
          IF raw NOT IN('0','1') THEN RAISE EXCEPTION 'Invalid Routine radio' USING ERRCODE='23514'; END IF;
        ELSE
          material:=public.${ADMIN_WECHAT_ROUTINE_STORED_TEXT_FUNCTION}(raw);
          IF pg_catalog.left(raw,1)<>'"' OR material IS NULL OR k='routine_appsecret' AND pg_catalog.octet_length(material)=0 THEN
            RAISE EXCEPTION 'Invalid Routine serialized text' USING ERRCODE='23514';
          END IF;
        END IF;
        changes:=changes||pg_catalog.jsonb_build_object(k,raw);
      ELSE RAISE EXCEPTION 'Unsupported Routine intent' USING ERRCODE='23514';
      END IF;
    END LOOP;
  ELSIF p_fields IS NOT NULL THEN
    RAISE EXCEPTION 'Routine resolve cannot carry settings' USING ERRCODE='23514';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(731667,0)
    OR NOT pg_catalog.pg_try_advisory_xact_lock(${ADMIN_WECHAT_ROUTINE_REQUEST_GATE},pg_catalog.hashtext(p_id::text)) THEN
    RAISE EXCEPTION 'Routine operation maintenance or request is busy' USING ERRCODE='55P03';
  END IF;
  SELECT * INTO prior FROM public.admin_wechat_routine_operation WHERE operation_id=p_id;
  IF FOUND THEN
    IF prior.actor_id<>p_actor THEN RAISE EXCEPTION 'Routine operation belongs to another actor' USING ERRCODE='42501'; END IF;
    IF p_operation='save' AND prior.state='committed' THEN
      payload:=${digest("pg_catalog.jsonb_build_array(p_actor,p_revision,p_expected_source,p_fields)")};
      IF prior.payload_hash<>payload THEN RAISE EXCEPTION 'Routine UUID already has another payload' USING ERRCODE='40001'; END IF;
    END IF;
    RETURN pg_catalog.to_jsonb(prior)||pg_catalog.jsonb_build_object('replayed',true);
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(731666,0) THEN
    RAISE EXCEPTION 'Routine credentials are in use' USING ERRCODE='55P03';
  END IF;
  SELECT count(*) INTO row_count FROM (SELECT id FROM public.system_config
    WHERE is_store=0 AND menu_name=ANY(${keyArray}) LIMIT 65) s;
  IF row_count>64 THEN RAISE EXCEPTION 'Routine source row budget exceeded' USING ERRCODE='54000'; END IF;
  source:=(${ADMIN_WECHAT_ROUTINE_SOURCE_SQL});
  IF pg_catalog.octet_length(source::text)>1048576 THEN
    RAISE EXCEPTION 'Routine complete source byte budget exceeded' USING ERRCODE='54000';
  END IF;
  before_source:=${digest('source')};
  IF before_source<>p_expected_source THEN RAISE EXCEPTION 'Routine complete source changed' USING ERRCODE='40001'; END IF;
  IF p_operation='save' THEN
    payload:=${digest("pg_catalog.jsonb_build_array(p_actor,p_revision,p_expected_source,p_fields)")};
    -- Validate the ownership barrier before the first write of any field.
    IF changes ? 'routine_appId' THEN
      SELECT * INTO selected FROM public.system_config WHERE is_store=0 AND menu_name='routine_appId' ORDER BY sort DESC,id DESC LIMIT 1;
      previous_material:=CASE WHEN FOUND THEN public.${ADMIN_WECHAT_ROUTINE_STORED_TEXT_FUNCTION}(selected.value) ELSE ''::bytea END;
      material:=public.${ADMIN_WECHAT_ROUTINE_STORED_TEXT_FUNCTION}(changes->>'routine_appId');
      IF previous_material IS NULL OR previous_material IS DISTINCT FROM material THEN
        RAISE EXCEPTION 'Routine AppID ownership maintenance is not commissioned' USING ERRCODE='42501';
      END IF;
    END IF;
    FOREACH k IN ARRAY ${keyArray} LOOP
      IF NOT changes ? k THEN CONTINUE; END IF;
      raw:=changes->>k;
      SELECT * INTO selected FROM public.system_config WHERE is_store=0 AND menu_name=k ORDER BY sort DESC,id DESC LIMIT 1;
      found_row:=FOUND;
      IF found_row AND selected.value IS NOT DISTINCT FROM raw THEN CONTINUE; END IF;
      IF found_row THEN
        UPDATE public.system_config SET value=raw WHERE id=selected.id;
      ELSE
        IF row_count>=64 THEN RAISE EXCEPTION 'Routine source row budget exceeded' USING ERRCODE='54000'; END IF;
        m:=metadata->k;
        INSERT INTO public.system_config(is_store,menu_name,type,input_type,config_tab_id,parameter,upload_type,required,width,high,value,info,"desc",sort,status)
          VALUES(0,k,m->>'type',m->>'input_type',(m->>'config_tab_id')::integer,m->>'parameter',(m->>'upload_type')::smallint,
            m->>'required',(m->>'width')::integer,(m->>'high')::integer,raw,m->>'info',m->>'desc',(m->>'sort')::integer,(m->>'status')::smallint);
        row_count:=row_count+1;
      END IF;
      changed:=pg_catalog.array_append(changed,k);
    END LOOP;
  ELSE payload:=${digest("pg_catalog.jsonb_build_array('resolve'::text,p_actor,p_revision,p_expected_source)")};
  END IF;
  source:=(${ADMIN_WECHAT_ROUTINE_SOURCE_SQL});
  IF pg_catalog.octet_length(source::text)>1048576 THEN
    RAISE EXCEPTION 'Routine complete source byte budget exceeded' USING ERRCODE='54000';
  END IF;
  after_source:=${digest('source')};
  INSERT INTO public.admin_wechat_routine_operation(operation_id,actor_id,operation,format_version,payload_hash,revision,state,result,created_at)
    VALUES(p_id,p_actor,p_operation,1,payload,p_revision,CASE WHEN p_operation='save' THEN 'committed' ELSE 'not_applied' END,
      pg_catalog.jsonb_build_object('format',1,'actor_binding',p_actor_binding,'before_source',before_source,
        'after_source',after_source,'changed_keys',changed),pg_catalog.floor(EXTRACT(epoch FROM pg_catalog.clock_timestamp()))::bigint)
    RETURNING * INTO prior;
  RETURN pg_catalog.to_jsonb(prior)||pg_catalog.jsonb_build_object('replayed',false);
END
`;
}

/** DDL builder only; it deliberately performs no runtime/request-time DDL.
 * A formal maintenance installer must also commission the helper, exact role
 * privileges, immutable receipt and full guard/function catalog atomically.
 */
export function adminWechatRoutineWriteSql(binding: AdminWechatRoutineWriteBinding): string {
  return `CREATE FUNCTION ${ADMIN_WECHAT_ROUTINE_WRITE_SIGNATURE.replace('(uuid,integer,text,text,text,text,jsonb)',
    '(p_id uuid,p_actor integer,p_operation text,p_revision text,p_expected_source text,p_actor_binding text,p_fields jsonb)')}
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $routine_write$${adminWechatRoutineWriteBody(binding)}$routine_write$;
REVOKE ALL ON FUNCTION ${ADMIN_WECHAT_ROUTINE_WRITE_SIGNATURE} FROM PUBLIC;
CREATE FUNCTION ${ADMIN_WECHAT_ROUTINE_CONFIG_GUARD_SIGNATURE} RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $routine_guard$${adminWechatRoutineConfigGuardBody(binding)}$routine_guard$;
REVOKE ALL ON FUNCTION ${ADMIN_WECHAT_ROUTINE_CONFIG_GUARD_SIGNATURE} FROM PUBLIC;
CREATE TRIGGER routine_config_rows BEFORE INSERT OR UPDATE OR DELETE ON public.system_config FOR EACH ROW EXECUTE FUNCTION ${ADMIN_WECHAT_ROUTINE_CONFIG_GUARD_SIGNATURE};
CREATE TRIGGER routine_config_truncate BEFORE TRUNCATE ON public.system_config FOR EACH STATEMENT EXECUTE FUNCTION ${ADMIN_WECHAT_ROUTINE_CONFIG_GUARD_SIGNATURE};`;
}
