-- Independent owner-only manual red-note candidate; NOT a generic migration.
-- No automatic installation, tax-provider claim, historical backfill, or runtime grants.
BEGIN;
SET LOCAL search_path=public,pg_temp;
SET LOCAL row_security=off;
SELECT set_config('statement_timeout','30000ms',true),set_config('lock_timeout','1000ms',true),set_config('idle_in_transaction_session_timeout','5000ms',true);
DO $manual_red_install$
DECLARE matched integer;objects jsonb;bare_objects jsonb;
BEGIN
 IF current_schema()<>'public' OR current_setting('server_version_num')::integer/10000<>16 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' OR current_setting('session_replication_role')<>'origin' OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') OR NOT pg_try_advisory_xact_lock(731611,0) THEN RAISE EXCEPTION 'Manual red-note candidate requires reviewed bounded PG16 owner transaction'; END IF;
 LOCK TABLE public.store_order_invoice,public.store_order_invoice_evidence,public.store_order_invoice_allocation,public.store_order_refund_split,public.store_order_fulfillment_branch IN ACCESS EXCLUSIVE MODE NOWAIT;
 SELECT count(*) INTO matched FROM (SELECT * FROM (
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
) i UNION ALL SELECT * FROM (
WITH relations AS (
  SELECT name,c.* FROM (VALUES ('store_order_refund_split'),('store_order_fulfillment_branch')) names(name)
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
      WHERE a.grantee<>relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')))
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
  SELECT name,p.* FROM (VALUES('protect_refund_order_split')) names(name)
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
) s) c JOIN (VALUES ('store_order_invoice','fa5ac803acadd40ea817c927c552a1e31e69e898620045f48a225a65ff7dc646'),('store_order_invoice_evidence','f0aac4be250c1e1800b50e4b274d629be0156048ca8383d25a2c90d41cb9f71c'),('store_order_invoice_allocation','aba9ff86c3f88283979765a86e0d39e8df53dde31926a1585c95e6e7c6a66395'),('capture_invoice_evidence','4118143bcefedacec3a6c83bea3094320e0165455a5fcd27f9f97b4c7c8e34c7'),('protect_invoice_evidence','b2fe7d071ed75d2e734a2f40b8cf091219e7280de6bf5700af866306385b0056'),('store_order_refund_split','6d8d309a74d565d2389ce69d0573c3992589c9ff2ee8b15d72b0982ca90f5667'),('store_order_fulfillment_branch','ed0a0a41327ab4ac75ffd73ef8939e90548acc80a836ccc0d8ac8f349e09321d'),('protect_refund_order_split','c514fe34f9887575b9b8e3dcb162a3ef437bb1d95a545a28aef6578c450b3b38')) expected(name,pin) USING(name) WHERE c.present AND c.owned AND c.safe AND c.fingerprint=expected.pin;
 IF matched<>8 THEN RAISE EXCEPTION 'Complete original guest entity catalog and financial owner required'; END IF;
 SELECT count(*) INTO matched FROM (
WITH relations AS (
  SELECT name,c.* FROM (VALUES ('store_order_invoice_manual_red_note'),('store_order_invoice_manual_red_review')) names(name)
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
        ARRAY['SELECT','INSERT']))))
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
  SELECT name,p.* FROM (VALUES('guard_invoice_manual_red_note'),('protect_invoice_manual_red_note')) names(name)
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
) c JOIN (VALUES ('store_order_invoice_manual_red_note','4168138287be01716ae83f5b0f6266abdfc03c5067d6f576c38535ecb57955eb'),('store_order_invoice_manual_red_review','580d6ee69807673ccbdff91b315ffb413cffae4e3ace8695c982e1528eb26705'),('guard_invoice_manual_red_note','fad3b659fa4bb261f8ca210d12e61e2995325028cebd049135c2bb63cdccfab7'),('protect_invoice_manual_red_note','82c16a73576786a61ee003ed8ecaf897194c9559f4da22b697b323fd8378c965')) expected(name,pin) USING(name) WHERE c.present AND c.owned AND c.safe AND c.fingerprint=expected.pin;
 IF matched=4 THEN RETURN; END IF;
 IF to_regclass('public.store_order_invoice_manual_red_note') IS NOT NULL OR to_regclass('public.store_order_invoice_manual_red_review') IS NOT NULL OR to_regprocedure('public.guard_invoice_manual_red_note()') IS NOT NULL OR to_regprocedure('public.protect_invoice_manual_red_note()') IS NOT NULL THEN RAISE EXCEPTION 'Manual red-note candidate only installs fresh absent objects; ORM completion uses explicit inspected runner'; END IF;
 EXECUTE $red_note_tables$
CREATE TABLE public.store_order_invoice_manual_red_note (
 id varchar(36) PRIMARY KEY, invoice_id integer NOT NULL, source_order_id integer NOT NULL, payment_order_id integer NOT NULL,
 uid integer NOT NULL, actor_id integer NOT NULL, request_hash varchar(64) NOT NULL, record_hash varchar(64) NOT NULL,
 record_json text NOT NULL, created_time integer NOT NULL,
 CONSTRAINT soimrn_identity_ck CHECK (id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND invoice_id>0 AND source_order_id>0 AND payment_order_id>0 AND uid>=0 AND actor_id>0 AND created_time>0),
 CONSTRAINT soimrn_hash_ck CHECK (request_hash ~ '^[a-f0-9]{64}$' AND record_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT soimrn_json_ck CHECK (octet_length(record_json)<=65536 AND jsonb_typeof(record_json::jsonb)='object' AND record_json::jsonb @> '{"version":"invoice-manual-red-note-v1","currency":"CNY"}'::jsonb)
);
CREATE INDEX soimrn_invoice ON public.store_order_invoice_manual_red_note(invoice_id,created_time);
CREATE TABLE public.store_order_invoice_manual_red_review (
 id varchar(36) PRIMARY KEY, record_id varchar(36) NOT NULL, invoice_id integer NOT NULL, source_order_id integer NOT NULL, payment_order_id integer NOT NULL,
 uid integer NOT NULL, actor_id integer NOT NULL, decision varchar(7) NOT NULL, original_document_number varchar(50) NOT NULL,red_document_number varchar(20) NOT NULL,
 request_hash varchar(64) NOT NULL,record_hash varchar(64) NOT NULL,review_hash varchar(64) NOT NULL,review_json text NOT NULL,created_time integer NOT NULL,
 CONSTRAINT soimrr_identity_ck CHECK (id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND record_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND invoice_id>0 AND source_order_id>0 AND payment_order_id>0 AND uid>=0 AND actor_id>0 AND created_time>0 AND decision IN ('confirm','reject') AND btrim(original_document_number)<>'' AND original_document_number !~ '[[:cntrl:]]' AND red_document_number ~ '^[0-9]{8,20}$'),
 CONSTRAINT soimrr_hash_ck CHECK (request_hash ~ '^[a-f0-9]{64}$' AND record_hash ~ '^[a-f0-9]{64}$' AND review_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT soimrr_json_ck CHECK (octet_length(review_json)<=4096 AND jsonb_typeof(review_json::jsonb)='object' AND review_json::jsonb @> '{"version":"invoice-manual-red-review-v1","manual_checked":true}'::jsonb)
);
CREATE UNIQUE INDEX soimrr_record_uq ON public.store_order_invoice_manual_red_review(record_id);
CREATE UNIQUE INDEX soimrr_confirmed_origin_uq ON public.store_order_invoice_manual_red_review(invoice_id,original_document_number) WHERE decision='confirm';
CREATE UNIQUE INDEX soimrr_confirmed_red_uq ON public.store_order_invoice_manual_red_review(red_document_number) WHERE decision='confirm';
$red_note_tables$;
 SELECT jsonb_agg(to_jsonb(c)) INTO bare_objects FROM (
WITH relations AS (
  SELECT name,c.* FROM (VALUES ('store_order_invoice_manual_red_note'),('store_order_invoice_manual_red_review')) names(name)
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
        ARRAY['SELECT','INSERT']))))
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
  SELECT name,p.* FROM (VALUES('guard_invoice_manual_red_note'),('protect_invoice_manual_red_note')) names(name)
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
) c;
 EXECUTE $red_note_protection$
CREATE FUNCTION public.protect_invoice_manual_red_note() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Manual red-note evidence is append-only' USING ERRCODE='42501'; END $$;
CREATE FUNCTION public.guard_invoice_manual_red_note() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE p jsonb; captured jsonb; r public.store_order_invoice_manual_red_note%ROWTYPE; e public.store_order_invoice_evidence%ROWTYPE;
 s public.store_order%ROWTYPE; root public.store_order%ROWTYPE; keys text[];
BEGIN
 IF TG_TABLE_SCHEMA<>'public' OR TG_LEVEL<>'ROW' OR TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Unexpected manual invoice source' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(731702,hashtext(NEW.id));
 IF TG_TABLE_NAME='store_order_invoice_manual_red_note' THEN
  p:=NEW.record_json::jsonb;keys:=ARRAY['version','request_id','actor_id','invoice_id','source_order_id','payment_order_id','uid','currency','original','red','platform','payment','source','created_time'];
  IF NOT ((p ?& keys AND p-keys='{}'::jsonb AND p->>'version'='invoice-manual-red-note-v1' AND p->>'currency'='CNY'
   AND p @> jsonb_build_object('request_id',NEW.id,'actor_id',NEW.actor_id,'invoice_id',NEW.invoice_id,'source_order_id',NEW.source_order_id,'payment_order_id',NEW.payment_order_id,'uid',NEW.uid,'created_time',NEW.created_time)
   AND p->>'request_id'=NEW.id AND (p->>'actor_id')::integer=NEW.actor_id AND (p->>'invoice_id')::integer=NEW.invoice_id
   AND (p->>'source_order_id')::integer=NEW.source_order_id AND (p->>'payment_order_id')::integer=NEW.payment_order_id AND (p->>'uid')::integer=NEW.uid AND (p->>'created_time')::integer=NEW.created_time
   AND NEW.record_hash=encode(sha256(convert_to(NEW.record_json,'UTF8')),'hex')
   AND p->'original' ?& ARRAY['document_number','snapshot_hash','amount','snapshot'] AND (p->'original')-ARRAY['document_number','snapshot_hash','amount','snapshot']='{}'::jsonb
   AND p->'red' ?& ARRAY['document_number','amount'] AND (p->'red')-ARRAY['document_number','amount']='{}'::jsonb
   AND p->'platform' ?& ARRAY['kind','content','content_hash'] AND (p->'platform')-ARRAY['kind','content','content_hash']='{}'::jsonb
   AND jsonb_typeof(p->'original'->'document_number')='string' AND char_length(p->'original'->>'document_number') BETWEEN 1 AND 50
   AND btrim(p->'original'->>'document_number')<>'' AND p->'original'->>'document_number' !~ '[[:cntrl:]]'
   AND jsonb_typeof(p->'red'->'document_number')='string' AND p->'red'->>'document_number' ~ '^[0-9]{8,20}$'
   AND p->'original'->>'document_number'<>p->'red'->>'document_number'
   AND jsonb_typeof(p->'original'->'snapshot')='string' AND jsonb_typeof(p->'original'->'snapshot_hash')='string'
   AND jsonb_typeof(p->'original'->'amount')='string' AND jsonb_typeof(p->'red'->'amount')='string'
   AND p->'original'->>'amount' ~ '^(0|[1-9][0-9]{0,9})\.[0-9]{2}$' AND p->'red'->>'amount'=p->'original'->>'amount'
   AND p->'platform'->>'kind'='manual-tax-platform' AND octet_length(p->'platform'->>'content') BETWEEN 1 AND 4096
   AND jsonb_typeof(p->'platform'->'content')='string' AND jsonb_typeof(p->'platform'->'content_hash')='string'
   AND p->'platform'->>'content_hash'=encode(sha256(convert_to(p->'platform'->>'content','UTF8')),'hex')) IS TRUE) THEN RAISE EXCEPTION 'Manual red-note payload inconsistent' USING ERRCODE='23514'; END IF;
  SELECT * INTO e FROM public.store_order_invoice_evidence WHERE invoice_id=NEW.invoice_id AND kind='issued' AND document_number=p->'original'->>'document_number';
  SELECT * INTO s FROM public.store_order WHERE id=NEW.source_order_id;
  SELECT * INTO root FROM public.store_order WHERE id=NEW.payment_order_id;
  IF NOT ((e.invoice_id=NEW.invoice_id AND e.order_id=NEW.source_order_id AND e.uid=NEW.uid AND e.snapshot=p->'original'->>'snapshot'
   AND encode(sha256(convert_to(e.snapshot,'UTF8')),'hex')=p->'original'->>'snapshot_hash'
   AND e.snapshot::jsonb->'invoice'->>'invoice_amount'=p->'original'->>'amount'
   AND e.snapshot::jsonb->'invoice' @> jsonb_build_object('id',NEW.invoice_id,'order_id',NEW.source_order_id,'uid',NEW.uid,'category','order','is_pay',1,'invoice_number',p->'original'->>'document_number')
   AND s.uid=NEW.uid AND root.uid=NEW.uid AND s.paid=1 AND root.paid=1 AND s.pay_type=root.pay_type AND s.is_del=0 AND s.is_system_del=0 AND root.is_del=0 AND root.is_system_del=0
   AND NEW.payment_order_id=CASE WHEN s.pid>0 THEN s.pid ELSE s.id END
   AND NOT EXISTS(SELECT 1 FROM public.store_order_invoice_evidence WHERE order_id IN(s.id,root.id) AND kind='unverified')
   AND p->'source'=jsonb_build_object('id',s.id,'order_number',s.order_id,'uid',s.uid,'pid',s.pid,'paid',s.paid,'pay_type',s.pay_type,'pay_time',s.pay_time,'store_id',s.store_id,'supplier_id',s.supplier_id)
   AND p->'payment'=jsonb_build_object('id',root.id,'order_number',root.order_id,'uid',root.uid,'pid',root.pid,'paid',root.paid,'pay_type',root.pay_type,'pay_time',root.pay_time,'store_id',root.store_id,'supplier_id',root.supplier_id)
   AND NEW.request_hash=encode(sha256(convert_to('["invoice-manual-red-record-intent-v1",'||NEW.invoice_id::text||','||NEW.actor_id::text||','||to_json(p->'original'->>'document_number')::text||','||to_json(p->'original'->>'snapshot_hash')::text||','||to_json(p->'original'->>'amount')::text||',"CNY",'||to_json(p->'red'->>'document_number')::text||','||to_json(p->'red'->>'amount')::text||','||to_json(p->'platform'->>'content')::text||']','UTF8')),'hex')
   AND NOT EXISTS(SELECT 1 FROM public.store_order_invoice_manual_red_review WHERE id=NEW.id)) IS TRUE) THEN RAISE EXCEPTION 'Original issued invoice identity missing' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='store_order_invoice_manual_red_review' THEN
  p:=NEW.review_json::jsonb;keys:=ARRAY['version','request_id','record_id','record_hash','actor_id','invoice_id','source_order_id','payment_order_id','uid','original_document_number','red_document_number','decision','manual_checked','review_note','created_time'];
  SELECT * INTO r FROM public.store_order_invoice_manual_red_note WHERE id=NEW.record_id;
  IF NOT ((p ?& keys AND p-keys='{}'::jsonb AND p->>'version'='invoice-manual-red-review-v1' AND p->'manual_checked'='true'::jsonb
   AND p @> jsonb_build_object('request_id',NEW.id,'record_id',NEW.record_id,'record_hash',NEW.record_hash,'actor_id',NEW.actor_id,'invoice_id',NEW.invoice_id,'source_order_id',NEW.source_order_id,'payment_order_id',NEW.payment_order_id,'uid',NEW.uid,'created_time',NEW.created_time)
   AND p->>'request_id'=NEW.id AND p->>'record_id'=NEW.record_id AND p->>'record_hash'=NEW.record_hash AND p->>'decision'=NEW.decision
   AND p->>'original_document_number'=NEW.original_document_number AND p->>'red_document_number'=NEW.red_document_number
   AND (p->>'actor_id')::integer=NEW.actor_id AND (p->>'invoice_id')::integer=NEW.invoice_id AND (p->>'source_order_id')::integer=NEW.source_order_id
   AND (p->>'payment_order_id')::integer=NEW.payment_order_id AND (p->>'uid')::integer=NEW.uid AND (p->>'created_time')::integer=NEW.created_time
   AND octet_length(p->>'review_note') BETWEEN 1 AND 1024 AND NEW.review_hash=encode(sha256(convert_to(NEW.review_json,'UTF8')),'hex')
   AND jsonb_typeof(p->'review_note')='string'
   AND r.id=NEW.record_id AND r.invoice_id=NEW.invoice_id AND r.source_order_id=NEW.source_order_id AND r.payment_order_id=NEW.payment_order_id AND r.uid=NEW.uid AND r.record_hash=NEW.record_hash
   AND r.record_json::jsonb->'original'->>'document_number'=NEW.original_document_number AND r.record_json::jsonb->'red'->>'document_number'=NEW.red_document_number
   AND NEW.request_hash=encode(sha256(convert_to('["invoice-manual-red-review-intent-v1",'||NEW.invoice_id::text||','||to_json(NEW.record_id)::text||','||NEW.actor_id::text||','||to_json(NEW.record_hash)::text||','||to_json(NEW.decision)::text||',true,'||to_json(p->>'review_note')::text||']','UTF8')),'hex')
   AND NOT EXISTS(SELECT 1 FROM public.store_order_invoice_manual_red_note WHERE id=NEW.id)) IS TRUE) THEN RAISE EXCEPTION 'Manual red-review payload inconsistent' USING ERRCODE='23514'; END IF;
  captured:=r.record_json::jsonb;
  SELECT * INTO e FROM public.store_order_invoice_evidence WHERE invoice_id=r.invoice_id AND kind='issued' AND document_number=NEW.original_document_number;
  SELECT * INTO root FROM public.store_order WHERE id=r.payment_order_id FOR UPDATE;
  SELECT * INTO s FROM public.store_order WHERE id=r.source_order_id FOR UPDATE;
  IF NOT ((e.invoice_id=r.invoice_id AND e.order_id=r.source_order_id AND e.uid=r.uid AND e.snapshot=captured->'original'->>'snapshot'
   AND encode(sha256(convert_to(e.snapshot,'UTF8')),'hex')=captured->'original'->>'snapshot_hash'
   AND e.snapshot::jsonb->'invoice'->>'invoice_amount'=captured->'original'->>'amount'
   AND s.uid=r.uid AND root.uid=r.uid AND s.paid=1 AND root.paid=1 AND s.pay_type=root.pay_type
   AND s.is_del=0 AND s.is_system_del=0 AND root.is_del=0 AND root.is_system_del=0
   AND r.payment_order_id=CASE WHEN s.pid>0 THEN s.pid ELSE s.id END
   AND NOT EXISTS(SELECT 1 FROM public.store_order_invoice_evidence WHERE order_id IN(s.id,root.id) AND kind='unverified')
   AND (captured->'source')-ARRAY['pid']=jsonb_build_object('id',s.id,'order_number',s.order_id,'uid',s.uid,'paid',s.paid,'pay_type',s.pay_type,'pay_time',s.pay_time,'store_id',s.store_id,'supplier_id',s.supplier_id)
   AND (captured->'payment')-ARRAY['pid']=jsonb_build_object('id',root.id,'order_number',root.order_id,'uid',root.uid,'paid',root.paid,'pay_type',root.pay_type,'pay_time',root.pay_time,'store_id',root.store_id,'supplier_id',root.supplier_id)) IS TRUE)
   THEN RAISE EXCEPTION 'Manual red-review original source changed' USING ERRCODE='23514'; END IF;
 ELSE RAISE EXCEPTION 'Unexpected manual invoice table' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER soimrn_insert_guard BEFORE INSERT ON public.store_order_invoice_manual_red_note FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_manual_red_note();
CREATE TRIGGER soimrn_no_rewrite BEFORE UPDATE OR DELETE ON public.store_order_invoice_manual_red_note FOR EACH ROW EXECUTE FUNCTION public.protect_invoice_manual_red_note();
CREATE TRIGGER soimrn_no_truncate BEFORE TRUNCATE ON public.store_order_invoice_manual_red_note FOR EACH STATEMENT EXECUTE FUNCTION public.protect_invoice_manual_red_note();
CREATE TRIGGER soimrr_insert_guard BEFORE INSERT ON public.store_order_invoice_manual_red_review FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_manual_red_note();
CREATE TRIGGER soimrr_no_rewrite BEFORE UPDATE OR DELETE ON public.store_order_invoice_manual_red_review FOR EACH ROW EXECUTE FUNCTION public.protect_invoice_manual_red_note();
CREATE TRIGGER soimrr_no_truncate BEFORE TRUNCATE ON public.store_order_invoice_manual_red_review FOR EACH STATEMENT EXECUTE FUNCTION public.protect_invoice_manual_red_note();
REVOKE ALL ON public.store_order_invoice_manual_red_note,public.store_order_invoice_manual_red_review FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_invoice_manual_red_note(),public.protect_invoice_manual_red_note() FROM PUBLIC;
$red_note_protection$;
 SELECT jsonb_agg(to_jsonb(c)) INTO objects FROM (
WITH relations AS (
  SELECT name,c.* FROM (VALUES ('store_order_invoice_manual_red_note'),('store_order_invoice_manual_red_review')) names(name)
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
        ARRAY['SELECT','INSERT']))))
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
  SELECT name,p.* FROM (VALUES('guard_invoice_manual_red_note'),('protect_invoice_manual_red_note')) names(name)
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
) c;
 SELECT count(*) INTO matched FROM (
WITH relations AS (
  SELECT name,c.* FROM (VALUES ('store_order_invoice_manual_red_note'),('store_order_invoice_manual_red_review')) names(name)
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
        ARRAY['SELECT','INSERT']))))
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
  SELECT name,p.* FROM (VALUES('guard_invoice_manual_red_note'),('protect_invoice_manual_red_note')) names(name)
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
) c JOIN (VALUES ('store_order_invoice_manual_red_note','4168138287be01716ae83f5b0f6266abdfc03c5067d6f576c38535ecb57955eb'),('store_order_invoice_manual_red_review','580d6ee69807673ccbdff91b315ffb413cffae4e3ace8695c982e1528eb26705'),('guard_invoice_manual_red_note','fad3b659fa4bb261f8ca210d12e61e2995325028cebd049135c2bb63cdccfab7'),('protect_invoice_manual_red_note','82c16a73576786a61ee003ed8ecaf897194c9559f4da22b697b323fd8378c965')) expected(name,pin) USING(name) WHERE c.present AND c.owned AND c.safe AND c.fingerprint=expected.pin;
 IF matched<>4 THEN RAISE NOTICE 'INVOICE_MANUAL_RED_NOTE_COMMISSION %',jsonb_build_object('bare',bare_objects,'complete',objects);RAISE EXCEPTION 'Manual red-note fixed catalog pins required; no business readiness'; END IF;
END $manual_red_install$;
COMMIT;
