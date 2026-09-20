SET LOCAL search_path=public,pg_temp;
SET LOCAL row_security=off;
SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),30000)::text||'ms',true),
  set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true);
DO $invoice_install$
DECLARE initial_state text; final_state text;
BEGIN
  IF current_setting('server_version_num')::integer/10000<>16
    OR current_setting('transaction_isolation')<>'read committed'
    OR current_setting('transaction_read_only')<>'off'
    OR current_setting('search_path')<>'public, pg_temp' OR current_schema()<>'public'
    OR current_setting('row_security')<>'off'
    OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
    OR (SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout') NOT BETWEEN 1 AND 30000
    OR (SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout') NOT BETWEEN 1 AND 1000
    OR (SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout') NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'Invoice schema installation requires bounded public PG16 read-write READ COMMITTED';
  END IF;
  IF NOT pg_try_advisory_xact_lock(731611,0) THEN RAISE EXCEPTION 'Invoice installation already running'; END IF;
  SELECT state INTO initial_state FROM (WITH catalog AS (
WITH relations AS (
  SELECT name,c.* FROM (VALUES ('store_order_invoice'),('store_order_invoice_evidence'),
    ('store_order_invoice_allocation')) names(name)
  LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public.'||name)
), relation_shapes AS (
  SELECT name,oid,relowner,
    relkind='r' AND relpersistence='p' AND NOT relispartition
    AND NOT relrowsecurity AND NOT relforcerowsecurity AND relreplident='d' AND reloptions IS NULL
    AND relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=r.oid OR inhparent=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=r.oid AND attnum>0 AND attisdropped)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(relacl,pg_catalog.acldefault('r',relowner))) a
      WHERE a.grantee<>relowner AND (a.grantee=0 OR a.is_grantable OR NOT (a.privilege_type=ANY(
        CASE name WHEN 'store_order_invoice' THEN ARRAY['SELECT','INSERT','UPDATE','DELETE']
        WHEN 'store_order_invoice_evidence' THEN ARRAY['SELECT'] ELSE ARRAY['SELECT','INSERT'] END))))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
      WHERE col.attrelid=r.oid AND a.grantee<>relowner) AS safe,
    pg_catalog.jsonb_build_object(
      'columns',(SELECT jsonb_agg(jsonb_build_array(a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
        pg_get_expr(d.adbin,d.adrelid),a.attidentity::text,a.attgenerated::text,
        CASE WHEN a.attcollation=0 THEN NULL ELSE cn.nspname||'.'||co.collname END) ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
        WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.contype::text,pg_get_constraintdef(k.oid,false),
        k.convalidated,k.condeferrable,k.condeferred,k.connoinherit,k.conislocal,k.coninhcount,k.conparentid::text)
        ORDER BY k.conname COLLATE "C") FROM pg_catalog.pg_constraint k WHERE k.conrelid=r.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_array(ic.relname,pg_get_indexdef(i.indexrelid),i.indisunique,i.indisprimary,
        i.indisvalid,i.indisready,i.indislive,i.indimmediate,i.indisexclusion,i.indnullsnotdistinct,i.indisreplident,
        i.indnatts,i.indnkeyatts,i.indkey::text,i.indoption::text,ic.reloptions,ic.relpersistence)
        ORDER BY ic.relname COLLATE "C") FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=r.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,pg_get_triggerdef(t.oid,false),t.tgenabled::text,t.tgisinternal)
        ORDER BY t.tgname COLLATE "C") FROM pg_catalog.pg_trigger t WHERE t.tgrelid=r.oid)
    ) AS shape
  FROM relations r
), functions AS (
  SELECT name,p.* FROM (VALUES('capture_invoice_evidence'),('protect_invoice_evidence')) names(name)
  LEFT JOIN pg_catalog.pg_proc p ON p.pronamespace='public'::regnamespace AND p.proname=name
), components AS (
  SELECT 'table' AS kind,name,oid,relowner AS owner,safe,shape FROM relation_shapes
  UNION ALL
  SELECT 'function',name,oid,proowner,
    prokind='f' AND pronargs=0 AND prorettype='trigger'::regtype AND NOT proretset
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(proacl,pg_catalog.acldefault('f',proowner))) a WHERE a.grantee<>proowner),
    jsonb_build_object('definition',CASE WHEN prokind='f' THEN pg_get_functiondef(oid) END,
      'support',prosupport::text,'binary',probin,'argtypes',proargtypes::text)
  FROM functions
)
SELECT kind,name,oid::text AS oid,oid IS NOT NULL AS present,
  owner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owned,safe,
  encode(sha256(convert_to(shape::text,'UTF8')),'hex') AS fingerprint
FROM components ORDER BY kind COLLATE "C",name COLLATE "C",oid
),
  snapshot AS (SELECT count(*) AS components,jsonb_object_agg(name,to_jsonb(catalog)) AS objects FROM catalog)
SELECT CASE WHEN components<>5 THEN 'drift'
  WHEN (objects->'capture_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c4935a11f9ce4219938899eb14fda907f1355249df4183524e4c2aff7c1059e8"}'::jsonb
    AND (objects->'store_order_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":false}'::jsonb THEN 'fresh'
  WHEN (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fa5ac803acadd40ea817c927c552a1e31e69e898620045f48a225a65ff7dc646"}'::jsonb AND (objects->'store_order_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b0948eea8f5f31e09e969cae8127ee52187c389205be0b9e5fc3b2439ff51451"}'::jsonb
  AND (objects->'capture_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"4118143bcefedacec3a6c83bea3094320e0165455a5fcd27f9f97b4c7c8e34c7"}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b2fe7d071ed75d2e734a2f40b8cf091219e7280de6bf5700af866306385b0056"}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":false}'::jsonb THEN 'v1'
  WHEN (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fa5ac803acadd40ea817c927c552a1e31e69e898620045f48a225a65ff7dc646"}'::jsonb AND (objects->'store_order_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b0948eea8f5f31e09e969cae8127ee52187c389205be0b9e5fc3b2439ff51451"}'::jsonb
  AND (objects->'capture_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"4118143bcefedacec3a6c83bea3094320e0165455a5fcd27f9f97b4c7c8e34c7"}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b2fe7d071ed75d2e734a2f40b8cf091219e7280de6bf5700af866306385b0056"}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c5da015774eb7f8fa42c4c5ab6e08c49a34491adea620f5ddde475da913606f9"}'::jsonb THEN 'v2'
  WHEN (objects->'capture_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c4935a11f9ce4219938899eb14fda907f1355249df4183524e4c2aff7c1059e8"}'::jsonb
    AND (objects->'store_order_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"1cef40804ed5cfeeb232718495b26a3b48e26925a72da258ac7391ebdbcb7572"}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ce4a3c7b55138db7dfdabc06ff6e86e692cab769ff092fea6e8cc9fe86dad810"}'::jsonb THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot) c;
  IF initial_state='drift' OR (initial_state='orm-pending' AND NOT false) THEN
    RAISE EXCEPTION 'Invoice catalog or ACL drift requires review or explicit empty ORM completion';
  END IF;
  LOCK TABLE public.store_order_invoice IN ACCESS EXCLUSIVE MODE NOWAIT;
  IF initial_state<>'fresh' THEN LOCK TABLE public.store_order_invoice_evidence IN ACCESS EXCLUSIVE MODE NOWAIT; END IF;
  IF initial_state IN ('v2','orm-pending') THEN LOCK TABLE public.store_order_invoice_allocation IN ACCESS EXCLUSIVE MODE NOWAIT; END IF;
  SELECT state INTO final_state FROM (WITH catalog AS (
WITH relations AS (
  SELECT name,c.* FROM (VALUES ('store_order_invoice'),('store_order_invoice_evidence'),
    ('store_order_invoice_allocation')) names(name)
  LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public.'||name)
), relation_shapes AS (
  SELECT name,oid,relowner,
    relkind='r' AND relpersistence='p' AND NOT relispartition
    AND NOT relrowsecurity AND NOT relforcerowsecurity AND relreplident='d' AND reloptions IS NULL
    AND relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=r.oid OR inhparent=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=r.oid AND attnum>0 AND attisdropped)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(relacl,pg_catalog.acldefault('r',relowner))) a
      WHERE a.grantee<>relowner AND (a.grantee=0 OR a.is_grantable OR NOT (a.privilege_type=ANY(
        CASE name WHEN 'store_order_invoice' THEN ARRAY['SELECT','INSERT','UPDATE','DELETE']
        WHEN 'store_order_invoice_evidence' THEN ARRAY['SELECT'] ELSE ARRAY['SELECT','INSERT'] END))))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
      WHERE col.attrelid=r.oid AND a.grantee<>relowner) AS safe,
    pg_catalog.jsonb_build_object(
      'columns',(SELECT jsonb_agg(jsonb_build_array(a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
        pg_get_expr(d.adbin,d.adrelid),a.attidentity::text,a.attgenerated::text,
        CASE WHEN a.attcollation=0 THEN NULL ELSE cn.nspname||'.'||co.collname END) ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
        WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.contype::text,pg_get_constraintdef(k.oid,false),
        k.convalidated,k.condeferrable,k.condeferred,k.connoinherit,k.conislocal,k.coninhcount,k.conparentid::text)
        ORDER BY k.conname COLLATE "C") FROM pg_catalog.pg_constraint k WHERE k.conrelid=r.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_array(ic.relname,pg_get_indexdef(i.indexrelid),i.indisunique,i.indisprimary,
        i.indisvalid,i.indisready,i.indislive,i.indimmediate,i.indisexclusion,i.indnullsnotdistinct,i.indisreplident,
        i.indnatts,i.indnkeyatts,i.indkey::text,i.indoption::text,ic.reloptions,ic.relpersistence)
        ORDER BY ic.relname COLLATE "C") FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=r.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,pg_get_triggerdef(t.oid,false),t.tgenabled::text,t.tgisinternal)
        ORDER BY t.tgname COLLATE "C") FROM pg_catalog.pg_trigger t WHERE t.tgrelid=r.oid)
    ) AS shape
  FROM relations r
), functions AS (
  SELECT name,p.* FROM (VALUES('capture_invoice_evidence'),('protect_invoice_evidence')) names(name)
  LEFT JOIN pg_catalog.pg_proc p ON p.pronamespace='public'::regnamespace AND p.proname=name
), components AS (
  SELECT 'table' AS kind,name,oid,relowner AS owner,safe,shape FROM relation_shapes
  UNION ALL
  SELECT 'function',name,oid,proowner,
    prokind='f' AND pronargs=0 AND prorettype='trigger'::regtype AND NOT proretset
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(proacl,pg_catalog.acldefault('f',proowner))) a WHERE a.grantee<>proowner),
    jsonb_build_object('definition',CASE WHEN prokind='f' THEN pg_get_functiondef(oid) END,
      'support',prosupport::text,'binary',probin,'argtypes',proargtypes::text)
  FROM functions
)
SELECT kind,name,oid::text AS oid,oid IS NOT NULL AS present,
  owner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owned,safe,
  encode(sha256(convert_to(shape::text,'UTF8')),'hex') AS fingerprint
FROM components ORDER BY kind COLLATE "C",name COLLATE "C",oid
),
  snapshot AS (SELECT count(*) AS components,jsonb_object_agg(name,to_jsonb(catalog)) AS objects FROM catalog)
SELECT CASE WHEN components<>5 THEN 'drift'
  WHEN (objects->'capture_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c4935a11f9ce4219938899eb14fda907f1355249df4183524e4c2aff7c1059e8"}'::jsonb
    AND (objects->'store_order_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":false}'::jsonb THEN 'fresh'
  WHEN (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fa5ac803acadd40ea817c927c552a1e31e69e898620045f48a225a65ff7dc646"}'::jsonb AND (objects->'store_order_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b0948eea8f5f31e09e969cae8127ee52187c389205be0b9e5fc3b2439ff51451"}'::jsonb
  AND (objects->'capture_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"4118143bcefedacec3a6c83bea3094320e0165455a5fcd27f9f97b4c7c8e34c7"}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b2fe7d071ed75d2e734a2f40b8cf091219e7280de6bf5700af866306385b0056"}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":false}'::jsonb THEN 'v1'
  WHEN (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fa5ac803acadd40ea817c927c552a1e31e69e898620045f48a225a65ff7dc646"}'::jsonb AND (objects->'store_order_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b0948eea8f5f31e09e969cae8127ee52187c389205be0b9e5fc3b2439ff51451"}'::jsonb
  AND (objects->'capture_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"4118143bcefedacec3a6c83bea3094320e0165455a5fcd27f9f97b4c7c8e34c7"}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b2fe7d071ed75d2e734a2f40b8cf091219e7280de6bf5700af866306385b0056"}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c5da015774eb7f8fa42c4c5ab6e08c49a34491adea620f5ddde475da913606f9"}'::jsonb THEN 'v2'
  WHEN (objects->'capture_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c4935a11f9ce4219938899eb14fda907f1355249df4183524e4c2aff7c1059e8"}'::jsonb
    AND (objects->'store_order_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"1cef40804ed5cfeeb232718495b26a3b48e26925a72da258ac7391ebdbcb7572"}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ce4a3c7b55138db7dfdabc06ff6e86e692cab769ff092fea6e8cc9fe86dad810"}'::jsonb THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot) c;
  IF initial_state IS DISTINCT FROM final_state THEN RAISE EXCEPTION 'Invoice catalog changed during locking'; END IF;
  IF initial_state='orm-pending' THEN
    IF EXISTS(SELECT 1 FROM public.store_order_invoice)
      OR EXISTS(SELECT 1 FROM public.store_order_invoice_evidence)
      OR EXISTS(SELECT 1 FROM public.store_order_invoice_allocation) THEN
      RAISE EXCEPTION 'Unprotected ORM invoice tables must be empty; no history repair is allowed';
    END IF;

CREATE FUNCTION protect_invoice_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Invoice evidence is append-only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER soie_no_rewrite BEFORE UPDATE OR DELETE ON store_order_invoice_evidence
  FOR EACH ROW EXECUTE FUNCTION protect_invoice_evidence();
CREATE TRIGGER soie_no_truncate BEFORE TRUNCATE ON store_order_invoice_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION protect_invoice_evidence();
CREATE TRIGGER soi_no_truncate BEFORE TRUNCATE ON store_order_invoice
  FOR EACH STATEMENT EXECUTE FUNCTION protect_invoice_evidence();
CREATE FUNCTION capture_invoice_evidence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  evidence regclass;
  prior jsonb;
  next_row jsonb;
  candidate jsonb;
  has_created boolean;
  captured boolean;
  written integer;
BEGIN
  IF TG_TABLE_NAME<>'store_order_invoice' OR TG_LEVEL<>'ROW' THEN
    RAISE EXCEPTION 'Unexpected invoice evidence source' USING ERRCODE='42501';
  END IF;
  evidence := format('%I.store_order_invoice_evidence', TG_TABLE_SCHEMA)::regclass;
  IF TG_OP<>'INSERT' THEN prior := to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN next_row := to_jsonb(NEW); END IF;
  IF TG_OP='UPDATE' AND (OLD.id,OLD.uid,OLD.order_id,OLD.category) IS DISTINCT FROM (NEW.id,NEW.uid,NEW.order_id,NEW.category) THEN
    RAISE EXCEPTION 'Invoice identity is immutable' USING ERRCODE='42501';
  END IF;
  IF TG_OP='INSERT' THEN
    EXECUTE format('INSERT INTO %s (invoice_id,kind,document_number,order_id,uid,snapshot)
      VALUES ($1,''created'','''',$2,$3,$4)', evidence)
      USING NEW.id, NEW.order_id, NEW.uid, jsonb_build_object('v',1,'invoice',next_row)::text;
    GET DIAGNOSTICS written = ROW_COUNT;
    IF written<>1 THEN RAISE EXCEPTION 'Invoice creation evidence was not captured'; END IF;
  ELSE
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE invoice_id=$1 AND kind=''created'')', evidence)
      INTO has_created USING OLD.id;
    IF NOT has_created THEN
      EXECUTE format('INSERT INTO %s (invoice_id,kind,document_number,order_id,uid,snapshot)
        VALUES ($1,''unverified'','''',$2,$3,$4) ON CONFLICT DO NOTHING', evidence)
        USING OLD.id, OLD.order_id, OLD.uid, jsonb_build_object('v',1,'invoice',prior)::text;
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE invoice_id=$1 AND kind=''unverified'')', evidence)
        INTO captured USING OLD.id;
      IF NOT captured THEN RAISE EXCEPTION 'Unverified invoice evidence was not captured'; END IF;
    END IF;
  END IF;
  -- Capture OLD first: an existing issued row must survive number clearing.
  -- Each reported number has its own immutable first-observed full snapshot.
  FOREACH candidate IN ARRAY ARRAY[prior,next_row] LOOP
    IF candidate IS NOT NULL AND ((candidate->>'is_invoice')::integer=1 OR candidate->>'invoice_number'<>'') THEN
      EXECUTE format('INSERT INTO %s (invoice_id,kind,document_number,order_id,uid,snapshot)
        VALUES ($1,''issued'',$2,$3,$4,$5) ON CONFLICT DO NOTHING', evidence)
        USING (candidate->>'id')::integer, candidate->>'invoice_number', (candidate->>'order_id')::integer,
          (candidate->>'uid')::integer, jsonb_build_object('v',1,'invoice',candidate)::text;
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE invoice_id=$1 AND kind=''issued'' AND document_number=$2)', evidence)
        INTO captured USING (candidate->>'id')::integer, candidate->>'invoice_number';
      IF NOT captured THEN RAISE EXCEPTION 'Invoice issuance evidence was not captured'; END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER soi_capture_evidence AFTER INSERT OR UPDATE OR DELETE ON store_order_invoice
  FOR EACH ROW EXECUTE FUNCTION capture_invoice_evidence();
REVOKE ALL ON store_order_invoice_evidence FROM PUBLIC;
REVOKE ALL ON FUNCTION capture_invoice_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION protect_invoice_evidence() FROM PUBLIC;


CREATE TRIGGER soia_no_rewrite BEFORE UPDATE OR DELETE ON store_order_invoice_allocation
  FOR EACH ROW EXECUTE FUNCTION protect_invoice_evidence();
CREATE TRIGGER soia_no_truncate BEFORE TRUNCATE ON store_order_invoice_allocation
  FOR EACH STATEMENT EXECUTE FUNCTION protect_invoice_evidence();
REVOKE ALL ON store_order_invoice_allocation FROM PUBLIC;

  ELSE
    IF initial_state='fresh' THEN

CREATE TABLE "store_order_invoice_evidence" (
  invoice_id integer NOT NULL,
  kind varchar(12) NOT NULL,
  document_number varchar(50) NOT NULL,
  order_id integer NOT NULL,
  uid integer NOT NULL,
  snapshot text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT soie_identity_pk PRIMARY KEY (invoice_id, kind, document_number),
  CONSTRAINT soie_identity_ck CHECK (invoice_id > 0 AND order_id > 0 AND uid > 0
    AND kind IN ('created','issued','unverified') AND (kind='issued' OR document_number='')),
  CONSTRAINT soie_snapshot_ck CHECK ((octet_length(snapshot) <= 16384 AND jsonb_typeof(snapshot::jsonb)='object'
    AND snapshot::jsonb @> '{"v":1}'::jsonb AND jsonb_typeof(snapshot::jsonb->'invoice')='object'
    AND (snapshot::jsonb->'invoice') ?& ARRAY['id','order_id','uid','category','is_invoice','invoice_number']
    AND (snapshot::jsonb->'invoice'->>'id')::integer=invoice_id
    AND (snapshot::jsonb->'invoice'->>'order_id')::integer=order_id
    AND (snapshot::jsonb->'invoice'->>'uid')::integer=uid
    AND jsonb_typeof(snapshot::jsonb->'invoice'->'is_invoice')='number'
    AND jsonb_typeof(snapshot::jsonb->'invoice'->'invoice_number')='string'
    AND (kind<>'issued' OR (document_number=snapshot::jsonb->'invoice'->>'invoice_number'
      AND ((snapshot::jsonb->'invoice'->>'is_invoice')::integer=1 OR document_number<>'')))) IS TRUE)
);
CREATE INDEX soie_order_kind ON store_order_invoice_evidence(order_id, kind);

CREATE FUNCTION protect_invoice_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Invoice evidence is append-only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER soie_no_rewrite BEFORE UPDATE OR DELETE ON store_order_invoice_evidence
  FOR EACH ROW EXECUTE FUNCTION protect_invoice_evidence();
CREATE TRIGGER soie_no_truncate BEFORE TRUNCATE ON store_order_invoice_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION protect_invoice_evidence();
CREATE TRIGGER soi_no_truncate BEFORE TRUNCATE ON store_order_invoice
  FOR EACH STATEMENT EXECUTE FUNCTION protect_invoice_evidence();
CREATE FUNCTION capture_invoice_evidence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  evidence regclass;
  prior jsonb;
  next_row jsonb;
  candidate jsonb;
  has_created boolean;
  captured boolean;
  written integer;
BEGIN
  IF TG_TABLE_NAME<>'store_order_invoice' OR TG_LEVEL<>'ROW' THEN
    RAISE EXCEPTION 'Unexpected invoice evidence source' USING ERRCODE='42501';
  END IF;
  evidence := format('%I.store_order_invoice_evidence', TG_TABLE_SCHEMA)::regclass;
  IF TG_OP<>'INSERT' THEN prior := to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN next_row := to_jsonb(NEW); END IF;
  IF TG_OP='UPDATE' AND (OLD.id,OLD.uid,OLD.order_id,OLD.category) IS DISTINCT FROM (NEW.id,NEW.uid,NEW.order_id,NEW.category) THEN
    RAISE EXCEPTION 'Invoice identity is immutable' USING ERRCODE='42501';
  END IF;
  IF TG_OP='INSERT' THEN
    EXECUTE format('INSERT INTO %s (invoice_id,kind,document_number,order_id,uid,snapshot)
      VALUES ($1,''created'','''',$2,$3,$4)', evidence)
      USING NEW.id, NEW.order_id, NEW.uid, jsonb_build_object('v',1,'invoice',next_row)::text;
    GET DIAGNOSTICS written = ROW_COUNT;
    IF written<>1 THEN RAISE EXCEPTION 'Invoice creation evidence was not captured'; END IF;
  ELSE
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE invoice_id=$1 AND kind=''created'')', evidence)
      INTO has_created USING OLD.id;
    IF NOT has_created THEN
      EXECUTE format('INSERT INTO %s (invoice_id,kind,document_number,order_id,uid,snapshot)
        VALUES ($1,''unverified'','''',$2,$3,$4) ON CONFLICT DO NOTHING', evidence)
        USING OLD.id, OLD.order_id, OLD.uid, jsonb_build_object('v',1,'invoice',prior)::text;
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE invoice_id=$1 AND kind=''unverified'')', evidence)
        INTO captured USING OLD.id;
      IF NOT captured THEN RAISE EXCEPTION 'Unverified invoice evidence was not captured'; END IF;
    END IF;
  END IF;
  -- Capture OLD first: an existing issued row must survive number clearing.
  -- Each reported number has its own immutable first-observed full snapshot.
  FOREACH candidate IN ARRAY ARRAY[prior,next_row] LOOP
    IF candidate IS NOT NULL AND ((candidate->>'is_invoice')::integer=1 OR candidate->>'invoice_number'<>'') THEN
      EXECUTE format('INSERT INTO %s (invoice_id,kind,document_number,order_id,uid,snapshot)
        VALUES ($1,''issued'',$2,$3,$4,$5) ON CONFLICT DO NOTHING', evidence)
        USING (candidate->>'id')::integer, candidate->>'invoice_number', (candidate->>'order_id')::integer,
          (candidate->>'uid')::integer, jsonb_build_object('v',1,'invoice',candidate)::text;
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE invoice_id=$1 AND kind=''issued'' AND document_number=$2)', evidence)
        INTO captured USING (candidate->>'id')::integer, candidate->>'invoice_number';
      IF NOT captured THEN RAISE EXCEPTION 'Invoice issuance evidence was not captured'; END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER soi_capture_evidence AFTER INSERT OR UPDATE OR DELETE ON store_order_invoice
  FOR EACH ROW EXECUTE FUNCTION capture_invoice_evidence();
REVOKE ALL ON store_order_invoice_evidence FROM PUBLIC;
REVOKE ALL ON FUNCTION capture_invoice_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION protect_invoice_evidence() FROM PUBLIC;

    END IF;
    IF initial_state<>'v2' THEN

CREATE TABLE "store_order_invoice_allocation" (
  id varchar(32) PRIMARY KEY,
  source_invoice_id integer NOT NULL,
  source_order_id integer NOT NULL,
  payment_order_id integer NOT NULL,
  uid integer NOT NULL,
  reason varchar(16) NOT NULL,
  source_snapshot text NOT NULL,
  targets text NOT NULL,
  add_time integer NOT NULL,
  CONSTRAINT soia_identity_ck CHECK (id ~ '^[0-9a-f]{32}$' AND source_invoice_id > 0
    AND source_order_id > 0 AND payment_order_id > 0 AND uid > 0 AND add_time > 0
    AND reason IN ('fulfillment','supplier')),
  CONSTRAINT soia_snapshot_ck CHECK ((octet_length(source_snapshot) <= 16384
    AND jsonb_typeof(source_snapshot::jsonb)='object'
    AND (source_snapshot::jsonb->>'id')::integer=source_invoice_id
    AND (source_snapshot::jsonb->>'orderId')::integer=source_order_id
    AND (source_snapshot::jsonb->>'uid')::integer=uid) IS TRUE),
  CONSTRAINT soia_targets_ck CHECK ((octet_length(targets) <= 65536
    AND jsonb_typeof(targets::jsonb)='array' AND jsonb_array_length(targets::jsonb) BETWEEN 2 AND 200) IS TRUE)
);
CREATE INDEX soia_source_history ON store_order_invoice_allocation(source_invoice_id, add_time);

CREATE TRIGGER soia_no_rewrite BEFORE UPDATE OR DELETE ON store_order_invoice_allocation
  FOR EACH ROW EXECUTE FUNCTION protect_invoice_evidence();
CREATE TRIGGER soia_no_truncate BEFORE TRUNCATE ON store_order_invoice_allocation
  FOR EACH STATEMENT EXECUTE FUNCTION protect_invoice_evidence();
REVOKE ALL ON store_order_invoice_allocation FROM PUBLIC;

    END IF;
  END IF;
  SELECT state INTO final_state FROM (WITH catalog AS (
WITH relations AS (
  SELECT name,c.* FROM (VALUES ('store_order_invoice'),('store_order_invoice_evidence'),
    ('store_order_invoice_allocation')) names(name)
  LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public.'||name)
), relation_shapes AS (
  SELECT name,oid,relowner,
    relkind='r' AND relpersistence='p' AND NOT relispartition
    AND NOT relrowsecurity AND NOT relforcerowsecurity AND relreplident='d' AND reloptions IS NULL
    AND relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=r.oid OR inhparent=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=r.oid AND attnum>0 AND attisdropped)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(relacl,pg_catalog.acldefault('r',relowner))) a
      WHERE a.grantee<>relowner AND (a.grantee=0 OR a.is_grantable OR NOT (a.privilege_type=ANY(
        CASE name WHEN 'store_order_invoice' THEN ARRAY['SELECT','INSERT','UPDATE','DELETE']
        WHEN 'store_order_invoice_evidence' THEN ARRAY['SELECT'] ELSE ARRAY['SELECT','INSERT'] END))))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
      WHERE col.attrelid=r.oid AND a.grantee<>relowner) AS safe,
    pg_catalog.jsonb_build_object(
      'columns',(SELECT jsonb_agg(jsonb_build_array(a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
        pg_get_expr(d.adbin,d.adrelid),a.attidentity::text,a.attgenerated::text,
        CASE WHEN a.attcollation=0 THEN NULL ELSE cn.nspname||'.'||co.collname END) ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
        WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.contype::text,pg_get_constraintdef(k.oid,false),
        k.convalidated,k.condeferrable,k.condeferred,k.connoinherit,k.conislocal,k.coninhcount,k.conparentid::text)
        ORDER BY k.conname COLLATE "C") FROM pg_catalog.pg_constraint k WHERE k.conrelid=r.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_array(ic.relname,pg_get_indexdef(i.indexrelid),i.indisunique,i.indisprimary,
        i.indisvalid,i.indisready,i.indislive,i.indimmediate,i.indisexclusion,i.indnullsnotdistinct,i.indisreplident,
        i.indnatts,i.indnkeyatts,i.indkey::text,i.indoption::text,ic.reloptions,ic.relpersistence)
        ORDER BY ic.relname COLLATE "C") FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=r.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,pg_get_triggerdef(t.oid,false),t.tgenabled::text,t.tgisinternal)
        ORDER BY t.tgname COLLATE "C") FROM pg_catalog.pg_trigger t WHERE t.tgrelid=r.oid)
    ) AS shape
  FROM relations r
), functions AS (
  SELECT name,p.* FROM (VALUES('capture_invoice_evidence'),('protect_invoice_evidence')) names(name)
  LEFT JOIN pg_catalog.pg_proc p ON p.pronamespace='public'::regnamespace AND p.proname=name
), components AS (
  SELECT 'table' AS kind,name,oid,relowner AS owner,safe,shape FROM relation_shapes
  UNION ALL
  SELECT 'function',name,oid,proowner,
    prokind='f' AND pronargs=0 AND prorettype='trigger'::regtype AND NOT proretset
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(proacl,pg_catalog.acldefault('f',proowner))) a WHERE a.grantee<>proowner),
    jsonb_build_object('definition',CASE WHEN prokind='f' THEN pg_get_functiondef(oid) END,
      'support',prosupport::text,'binary',probin,'argtypes',proargtypes::text)
  FROM functions
)
SELECT kind,name,oid::text AS oid,oid IS NOT NULL AS present,
  owner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owned,safe,
  encode(sha256(convert_to(shape::text,'UTF8')),'hex') AS fingerprint
FROM components ORDER BY kind COLLATE "C",name COLLATE "C",oid
),
  snapshot AS (SELECT count(*) AS components,jsonb_object_agg(name,to_jsonb(catalog)) AS objects FROM catalog)
SELECT CASE WHEN components<>5 THEN 'drift'
  WHEN (objects->'capture_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c4935a11f9ce4219938899eb14fda907f1355249df4183524e4c2aff7c1059e8"}'::jsonb
    AND (objects->'store_order_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":false}'::jsonb THEN 'fresh'
  WHEN (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fa5ac803acadd40ea817c927c552a1e31e69e898620045f48a225a65ff7dc646"}'::jsonb AND (objects->'store_order_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b0948eea8f5f31e09e969cae8127ee52187c389205be0b9e5fc3b2439ff51451"}'::jsonb
  AND (objects->'capture_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"4118143bcefedacec3a6c83bea3094320e0165455a5fcd27f9f97b4c7c8e34c7"}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b2fe7d071ed75d2e734a2f40b8cf091219e7280de6bf5700af866306385b0056"}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":false}'::jsonb THEN 'v1'
  WHEN (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fa5ac803acadd40ea817c927c552a1e31e69e898620045f48a225a65ff7dc646"}'::jsonb AND (objects->'store_order_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b0948eea8f5f31e09e969cae8127ee52187c389205be0b9e5fc3b2439ff51451"}'::jsonb
  AND (objects->'capture_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"4118143bcefedacec3a6c83bea3094320e0165455a5fcd27f9f97b4c7c8e34c7"}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b2fe7d071ed75d2e734a2f40b8cf091219e7280de6bf5700af866306385b0056"}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c5da015774eb7f8fa42c4c5ab6e08c49a34491adea620f5ddde475da913606f9"}'::jsonb THEN 'v2'
  WHEN (objects->'capture_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c4935a11f9ce4219938899eb14fda907f1355249df4183524e4c2aff7c1059e8"}'::jsonb
    AND (objects->'store_order_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"1cef40804ed5cfeeb232718495b26a3b48e26925a72da258ac7391ebdbcb7572"}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ce4a3c7b55138db7dfdabc06ff6e86e692cab769ff092fea6e8cc9fe86dad810"}'::jsonb THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot) c;
  IF final_state IS DISTINCT FROM 'v2' OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Invoice catalog or ACL verification failed after installation';
  END IF;
END
$invoice_install$;
