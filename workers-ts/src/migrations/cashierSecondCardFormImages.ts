/** Explicit PG16 maintenance protocol for customer cashier form images. */
export const CASHIER_SECOND_CARD_FORM_IMAGES_MAINTENANCE_LOCK_KEY = 731698;
export const CASHIER_SECOND_CARD_FORM_IMAGE_TABLES = ['cashier_second_card_form_session_v1', 'cashier_second_card_form_upload_v1'] as const;
export const CASHIER_SECOND_CARD_FORM_IMAGE_FUNCTIONS = [
  'cashier_second_card_form_json_valid_v1(text, integer, text)',
  'cashier_second_card_form_session_guard_v1()',
  'cashier_second_card_form_upload_guard_v1()',
] as const;
export const CASHIER_SECOND_CARD_FORM_SESSION_UPDATE_COLUMNS = ['state', 'cancelled_at', 'frozen_request_hash', 'frozen_input_json',
  'order_id', 'order_no', 'snapshot_json', 'snapshot_hash', 'collection_json', 'collection_hash'] as const;
export const CASHIER_SECOND_CARD_FORM_UPLOAD_UPDATE_COLUMNS = ['state', 'attachment_id', 'stored_at'] as const;
const sha = (value: string) => `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(${value},'UTF8')),'hex')`;
const uuid = (value: string) => `${value}::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`;
const immutable = (columns: readonly string[]) => `pg_catalog.to_jsonb(NEW)-ARRAY[${columns.map(v => `'${v}'`).join(',')}]::text[]
    IS DISTINCT FROM pg_catalog.to_jsonb(OLD)-ARRAY[${columns.map(v => `'${v}'`).join(',')}]::text[]`;
export const CASHIER_SECOND_CARD_FORM_JSON_BODY = `BEGIN
  IF $1 IS NULL OR $2 IS NULL OR $3 IS NULL OR $2 NOT BETWEEN 1 AND 1048576 OR $3 NOT IN ('object','array')
    OR pg_catalog.octet_length($1)>$2 THEN RETURN false; END IF;
  RETURN pg_catalog.jsonb_typeof($1::jsonb)=$3;
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END`;
export const CASHIER_SECOND_CARD_FORM_SESSION_GUARD_BODY = `BEGIN
  IF TG_TABLE_SCHEMA<>'public' OR TG_TABLE_NAME<>'cashier_second_card_form_session_v1'
    OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP NOT IN('INSERT','UPDATE','DELETE') THEN
    RAISE EXCEPTION 'Cashier form session trigger context changed' USING ERRCODE='42501';
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Cashier form sessions cannot be deleted' USING ERRCODE='42501'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'active' THEN RAISE EXCEPTION 'Cashier form sessions start active' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF ${immutable(CASHIER_SECOND_CARD_FORM_SESSION_UPDATE_COLUMNS)} THEN
    RAISE EXCEPTION 'Cashier form session identity is immutable' USING ERRCODE='42501';
  END IF;
  IF OLD.state='active' AND NEW.state IN('cancelled','frozen') THEN RETURN NEW; END IF;
  IF OLD.state='frozen' AND NEW.state='consumed'
    AND NEW.frozen_request_hash IS NOT DISTINCT FROM OLD.frozen_request_hash
    AND NEW.frozen_input_json IS NOT DISTINCT FROM OLD.frozen_input_json THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Cashier form session transition is invalid' USING ERRCODE='42501';
END`;
export const CASHIER_SECOND_CARD_FORM_UPLOAD_GUARD_BODY = `BEGIN
  IF TG_TABLE_SCHEMA<>'public' OR TG_TABLE_NAME<>'cashier_second_card_form_upload_v1'
    OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP NOT IN('INSERT','UPDATE','DELETE') THEN
    RAISE EXCEPTION 'Cashier form upload trigger context changed' USING ERRCODE='42501';
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Cashier form uploads cannot be deleted' USING ERRCODE='42501'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'reserved' THEN RAISE EXCEPTION 'Cashier form uploads start reserved' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF ${immutable(CASHIER_SECOND_CARD_FORM_UPLOAD_UPDATE_COLUMNS)} THEN
    RAISE EXCEPTION 'Cashier form upload identity is immutable' USING ERRCODE='42501';
  END IF;
  IF OLD.state='reserved' AND NEW.state='stored' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Cashier form upload transition is invalid' USING ERRCODE='42501';
END`;
export const CASHIER_SECOND_CARD_FORM_IMAGES_SQL = `
 CREATE FUNCTION public.cashier_second_card_form_json_valid_v1(text,integer,text) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp
 AS $csfi_json$${CASHIER_SECOND_CARD_FORM_JSON_BODY}$csfi_json$;
 CREATE FUNCTION public.cashier_second_card_form_session_guard_v1() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp
 AS $csfi_session$${CASHIER_SECOND_CARD_FORM_SESSION_GUARD_BODY}$csfi_session$;
 CREATE FUNCTION public.cashier_second_card_form_upload_guard_v1() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp
 AS $csfi_upload$${CASHIER_SECOND_CARD_FORM_UPLOAD_GUARD_BODY}$csfi_upload$;
 ${CASHIER_SECOND_CARD_FORM_IMAGE_FUNCTIONS.map(fn => `REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC;`).join('\n ')}
 CREATE TABLE public.cashier_second_card_form_session_v1(
 actor_uid integer NOT NULL,service_id integer NOT NULL,scope_key varchar(64) NOT NULL,
 request_key uuid NOT NULL,request_hash varchar(64) NOT NULL,intent_json text NOT NULL,
 system_form_id integer NOT NULL,template_json text NOT NULL,scope_digest varchar(43) NOT NULL,
 state varchar(12) NOT NULL DEFAULT 'active',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 cancelled_at timestamptz,frozen_request_hash varchar(64),frozen_input_json text,
 order_id integer,order_no varchar(32),snapshot_json text,snapshot_hash varchar(64),collection_json text,collection_hash varchar(64),
 CONSTRAINT cscfs_pk PRIMARY KEY(actor_uid,request_key),CONSTRAINT cscfs_order_uq UNIQUE(order_id),
 CONSTRAINT cscfs_identity_ck CHECK(actor_uid>0 AND service_id>0 AND system_form_id>0
   AND scope_key ~ '^[a-f0-9]{64}$' AND scope_digest ~ '^[A-Za-z0-9_-]{43}$' AND ${uuid('request_key')}),
 CONSTRAINT cscfs_intent_ck CHECK(request_hash ~ '^[a-f0-9]{64}$'
   AND public.cashier_second_card_form_json_valid_v1(intent_json,65536,'object') AND request_hash=${sha('intent_json')}
   AND public.cashier_second_card_form_json_valid_v1(template_json,65536,'object')),
 CONSTRAINT cscfs_state_ck CHECK(
   (state IN('active','cancelled') AND frozen_request_hash IS NULL AND frozen_input_json IS NULL
    AND order_id IS NULL AND order_no IS NULL AND snapshot_json IS NULL AND snapshot_hash IS NULL AND collection_json IS NULL AND collection_hash IS NULL
    AND ((state='active' AND cancelled_at IS NULL) OR (state='cancelled' AND cancelled_at IS NOT NULL AND cancelled_at>=created_at)))
   OR (state IN('frozen','consumed') AND cancelled_at IS NULL AND frozen_request_hash IS NOT NULL AND frozen_input_json IS NOT NULL
    AND frozen_request_hash ~ '^[a-f0-9]{64}$' AND public.cashier_second_card_form_json_valid_v1(frozen_input_json,262144,'object')
    AND frozen_request_hash=${sha('frozen_input_json')}
    AND ((state='frozen' AND order_id IS NULL AND order_no IS NULL AND snapshot_json IS NULL AND snapshot_hash IS NULL AND collection_json IS NULL AND collection_hash IS NULL)
     OR (state='consumed' AND order_id IS NOT NULL AND order_id>0 AND order_no IS NOT NULL AND order_no ~ '^[A-Za-z0-9_-]{1,32}$'
      AND snapshot_json IS NOT NULL AND snapshot_hash IS NOT NULL AND collection_json IS NOT NULL AND collection_hash IS NOT NULL
      AND snapshot_hash ~ '^[a-f0-9]{64}$' AND collection_hash ~ '^[a-f0-9]{64}$'
      AND public.cashier_second_card_form_json_valid_v1(snapshot_json,1048576,'array') AND snapshot_hash=${sha('snapshot_json')}
      AND public.cashier_second_card_form_json_valid_v1(collection_json,1048576,'array') AND collection_hash=${sha('collection_json')}))))
 );
 CREATE INDEX cscfs_actor_history ON public.cashier_second_card_form_session_v1(actor_uid,created_at,request_key);
 CREATE TABLE public.cashier_second_card_form_upload_v1(
 actor_uid integer NOT NULL,service_id integer NOT NULL,session_key uuid NOT NULL,request_key uuid NOT NULL,
 request_hash varchar(64) NOT NULL,intent_json text NOT NULL,field_id text NOT NULL,sha256 varchar(64) NOT NULL,
 size integer NOT NULL,mime varchar(16) NOT NULL,scope_digest varchar(43) NOT NULL,object_key varchar(100) NOT NULL,
 state varchar(8) NOT NULL DEFAULT 'reserved',attachment_id integer,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),stored_at timestamptz,
 CONSTRAINT cscfu_pk PRIMARY KEY(actor_uid,request_key),CONSTRAINT cscfu_attachment_uq UNIQUE(attachment_id),CONSTRAINT cscfu_object_uq UNIQUE(object_key),
 CONSTRAINT cscfu_session_fk FOREIGN KEY(actor_uid,session_key) REFERENCES public.cashier_second_card_form_session_v1(actor_uid,request_key),
 CONSTRAINT cscfu_identity_ck CHECK(actor_uid>0 AND service_id>0 AND ${uuid('request_key')} AND ${uuid('session_key')}
   AND scope_digest ~ '^[A-Za-z0-9_-]{43}$' AND pg_catalog.char_length(field_id) BETWEEN 1 AND 255 AND field_id !~ '[\\x01-\\x1f\\x7f]'),
 CONSTRAINT cscfu_intent_ck CHECK(request_hash ~ '^[a-f0-9]{64}$' AND public.cashier_second_card_form_json_valid_v1(intent_json,65536,'object')
   AND request_hash=${sha('intent_json')} AND sha256 ~ '^[a-f0-9]{64}$' AND size BETWEEN 1 AND 10485760
   AND mime IN('image/jpeg','image/png','image/webp','image/gif')),
 CONSTRAINT cscfu_object_ck CHECK(object_key='attachments/cc/'||scope_digest||'/'||pg_catalog.replace(request_key::text,'-','')
   ||CASE mime WHEN 'image/jpeg' THEN '.jpg' WHEN 'image/png' THEN '.png' WHEN 'image/webp' THEN '.webp' WHEN 'image/gif' THEN '.gif' END),
 CONSTRAINT cscfu_state_ck CHECK((state='reserved' AND attachment_id IS NULL AND stored_at IS NULL)
   OR (state='stored' AND attachment_id IS NOT NULL AND attachment_id>0 AND stored_at IS NOT NULL AND stored_at>=created_at))
 );
 CREATE INDEX cscfu_session_history ON public.cashier_second_card_form_upload_v1(actor_uid,session_key,created_at,request_key);
 CREATE TRIGGER cashier_second_card_form_session_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON public.cashier_second_card_form_session_v1
 FOR EACH ROW EXECUTE FUNCTION public.cashier_second_card_form_session_guard_v1();
 CREATE TRIGGER cashier_second_card_form_upload_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON public.cashier_second_card_form_upload_v1
 FOR EACH ROW EXECUTE FUNCTION public.cashier_second_card_form_upload_guard_v1();
`;
export const CASHIER_SECOND_CARD_FORM_IMAGES_INSTALLATION_SQL = `
 SET LOCAL search_path=public,pg_temp; SET LOCAL row_security=off;
 DO $csfi_install$ BEGIN
 IF pg_catalog.current_setting('server_version_num')::integer/10000<>16 OR pg_catalog.current_setting('transaction_read_only')<>'off'
 OR pg_catalog.current_setting('transaction_isolation')<>'read committed' OR pg_catalog.current_setting('session_replication_role')<>'origin'
 OR current_user<>session_user OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
 WHERE a.pid=pg_catalog.pg_backend_pid() AND r.rolname=current_user)
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') THEN
 RAISE EXCEPTION 'Cashier form image installation requires reviewed PG16 owner transaction'; END IF;
 IF NOT pg_catalog.pg_try_advisory_xact_lock(${CASHIER_SECOND_CARD_FORM_IMAGES_MAINTENANCE_LOCK_KEY},0) THEN
 RAISE EXCEPTION 'Cashier form image installation already running'; END IF;
 IF ${CASHIER_SECOND_CARD_FORM_IMAGE_TABLES.map(table => `to_regclass('public.${table}') IS NOT NULL`).join(' OR ')}
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN(${CASHIER_SECOND_CARD_FORM_IMAGE_FUNCTIONS.map(fn => `'${fn.slice(0, fn.indexOf('('))}'`).join(',')})) THEN
 RAISE EXCEPTION 'Existing cashier form image protocol requires exact catalog review, no reinstall'; END IF;
 END $csfi_install$;
 ${CASHIER_SECOND_CARD_FORM_IMAGES_SQL}
`;
