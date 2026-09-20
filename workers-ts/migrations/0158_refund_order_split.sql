SET LOCAL search_path=public,pg_temp;
SET LOCAL row_security=off;
SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),30000)::text||'ms',true),
  set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true);
DO $refund_split_install$
DECLARE initial_state text; final_state text; invoice_state text;
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
    RAISE EXCEPTION 'Refund split installation requires bounded public PG16 read-write READ COMMITTED';
  END IF;
  -- Same installation lock and invoice-table order as the dependency installer.
  IF NOT pg_try_advisory_xact_lock(731611,0) THEN RAISE EXCEPTION 'Evidence installation already running'; END IF;
  SELECT state INTO invoice_state FROM (WITH catalog AS (
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
  IF invoice_state IS DISTINCT FROM 'v2' THEN RAISE EXCEPTION 'Complete invoice protection is required before refund split installation'; END IF;
  SELECT state INTO initial_state FROM (WITH catalog AS (
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
),
  snapshot AS (SELECT count(*) AS components,jsonb_object_agg(name,to_jsonb(catalog)) AS objects FROM catalog)
SELECT CASE WHEN components<>3 THEN 'drift'
  WHEN (objects->'store_order_refund_split') @> '{"present":false}'::jsonb AND (objects->'store_order_fulfillment_branch') @> '{"present":false}'::jsonb
    AND (objects->'protect_refund_order_split') @> '{"present":false}'::jsonb THEN 'fresh'
  WHEN (objects->'store_order_refund_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"896ba119f78638caa9db3cd9b52d0023dd21bce0dbef91fc67406767aab40ef4"}'::jsonb AND (objects->'store_order_fulfillment_branch') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"52b82ca8221ca45b7700eb3db940cc036dddd956142e3c6716e79dbc58f6bb9c"}'::jsonb
    AND (objects->'protect_refund_order_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c514fe34f9887575b9b8e3dcb162a3ef437bb1d95a545a28aef6578c450b3b38"}'::jsonb THEN 'v1'
  WHEN (objects->'store_order_refund_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"6e243dbfc5ad50b83b1b8f4ad35ac6160162fc726b42421252d3edf7b38dfcfd"}'::jsonb AND (objects->'store_order_fulfillment_branch') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"8e43b49efa6a271d648ae00547f0b33de26f37450d3263ff035edde131ec4927"}'::jsonb
    AND (objects->'protect_refund_order_split') @> '{"present":false}'::jsonb THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot) c;
  IF initial_state='drift' OR (initial_state='orm-pending' AND NOT false) THEN
    RAISE EXCEPTION 'Refund split catalog or ACL drift requires review or explicit empty ORM completion';
  END IF;
  LOCK TABLE public.store_order_invoice IN ACCESS EXCLUSIVE MODE NOWAIT;
  LOCK TABLE public.store_order_invoice_evidence IN ACCESS EXCLUSIVE MODE NOWAIT;
  LOCK TABLE public.store_order_invoice_allocation IN ACCESS EXCLUSIVE MODE NOWAIT;
  IF initial_state<>'fresh' THEN
    LOCK TABLE public.store_order_refund_split IN ACCESS EXCLUSIVE MODE NOWAIT;
    LOCK TABLE public.store_order_fulfillment_branch IN ACCESS EXCLUSIVE MODE NOWAIT;
  END IF;
  SELECT state INTO invoice_state FROM (WITH catalog AS (
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
  SELECT state INTO final_state FROM (WITH catalog AS (
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
),
  snapshot AS (SELECT count(*) AS components,jsonb_object_agg(name,to_jsonb(catalog)) AS objects FROM catalog)
SELECT CASE WHEN components<>3 THEN 'drift'
  WHEN (objects->'store_order_refund_split') @> '{"present":false}'::jsonb AND (objects->'store_order_fulfillment_branch') @> '{"present":false}'::jsonb
    AND (objects->'protect_refund_order_split') @> '{"present":false}'::jsonb THEN 'fresh'
  WHEN (objects->'store_order_refund_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"896ba119f78638caa9db3cd9b52d0023dd21bce0dbef91fc67406767aab40ef4"}'::jsonb AND (objects->'store_order_fulfillment_branch') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"52b82ca8221ca45b7700eb3db940cc036dddd956142e3c6716e79dbc58f6bb9c"}'::jsonb
    AND (objects->'protect_refund_order_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c514fe34f9887575b9b8e3dcb162a3ef437bb1d95a545a28aef6578c450b3b38"}'::jsonb THEN 'v1'
  WHEN (objects->'store_order_refund_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"6e243dbfc5ad50b83b1b8f4ad35ac6160162fc726b42421252d3edf7b38dfcfd"}'::jsonb AND (objects->'store_order_fulfillment_branch') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"8e43b49efa6a271d648ae00547f0b33de26f37450d3263ff035edde131ec4927"}'::jsonb
    AND (objects->'protect_refund_order_split') @> '{"present":false}'::jsonb THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot) c;
  IF invoice_state IS DISTINCT FROM 'v2' OR initial_state IS DISTINCT FROM final_state THEN
    RAISE EXCEPTION 'Evidence catalog changed during locking';
  END IF;
  IF initial_state='orm-pending' THEN
    IF EXISTS(SELECT 1 FROM public.store_order_refund_split) OR EXISTS(SELECT 1 FROM public.store_order_fulfillment_branch) THEN
      RAISE EXCEPTION 'Unprotected ORM refund ledgers must be empty; no evidence repair is allowed';
    END IF;
  ELSIF initial_state='fresh' THEN

CREATE TABLE "store_order_refund_split" (
  refund_id integer PRIMARY KEY,
  fingerprint varchar(64) NOT NULL,
  uid integer NOT NULL,
  supplier_id integer NOT NULL,
  store_id integer NOT NULL,
  source_order_id integer NOT NULL,
  payment_order_id integer NOT NULL,
  selected_order_id integer NOT NULL,
  remaining_order_id integer,
  disposition varchar(16) NOT NULL,
  previous_refund_id integer NOT NULL,
  base_branch_id varchar(32),
  returned_point_bill_ids text NOT NULL,
  earned_income_scope text NOT NULL,
  invoice_allocation text NOT NULL DEFAULT 'null',
  source_snapshot text NOT NULL,
  partitions text NOT NULL,
  add_time integer NOT NULL,
  CONSTRAINT sors_identity_ck CHECK (refund_id > 0 AND uid > 0 AND supplier_id >= 0 AND store_id >= 0
    AND source_order_id > 0 AND payment_order_id > 0 AND selected_order_id > 0 AND add_time > 0),
  CONSTRAINT sors_fingerprint_ck CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sors_branch_ck CHECK (base_branch_id IS NULL OR base_branch_id ~ '^[0-9a-f]{32}$'),
  CONSTRAINT sors_generation_ck CHECK (previous_refund_id >= 0 AND previous_refund_id < refund_id
    AND octet_length(returned_point_bill_ids) <= 16384 AND jsonb_typeof(returned_point_bill_ids::jsonb)='array'
    AND jsonb_array_length(returned_point_bill_ids::jsonb) <= 1024),
  CONSTRAINT sors_income_ck CHECK (octet_length(earned_income_scope) <= 2048 AND jsonb_typeof(earned_income_scope::jsonb) IN ('object', 'null')),
  CONSTRAINT sors_invoice_ck CHECK (octet_length(invoice_allocation) <= 16384 AND jsonb_typeof(invoice_allocation::jsonb) IN ('object', 'null')),
  CONSTRAINT sors_disposition_ck CHECK ((disposition='whole' AND remaining_order_id IS NULL AND selected_order_id=source_order_id)
    OR (disposition='split' AND remaining_order_id IS NOT NULL AND remaining_order_id > 0 AND selected_order_id <> source_order_id AND selected_order_id <> remaining_order_id)),
  CONSTRAINT sors_snapshot_ck CHECK (octet_length(source_snapshot) <= 16777216 AND jsonb_typeof(source_snapshot::jsonb)='object'
    AND octet_length(partitions) <= 131072 AND jsonb_typeof(partitions::jsonb)='array')
);
CREATE INDEX sors_source_history ON store_order_refund_split(source_order_id, refund_id);
CREATE INDEX sors_payment_history ON store_order_refund_split(payment_order_id, refund_id);
CREATE INDEX sors_remaining_history ON store_order_refund_split(remaining_order_id, refund_id) WHERE remaining_order_id IS NOT NULL;
CREATE TABLE "store_order_fulfillment_branch" (
  id varchar(32) PRIMARY KEY,
  source_branch_id varchar(32),
  source_refund_id integer NOT NULL,
  source_order_id integer NOT NULL,
  payment_order_id integer NOT NULL,
  child_order_id integer NOT NULL,
  uid integer NOT NULL,
  supplier_id integer NOT NULL,
  store_id integer NOT NULL,
  covered_refunds text NOT NULL,
  materialized_refunds text NOT NULL,
  returned_point_bill_ids text NOT NULL,
  partitions text NOT NULL,
  add_time integer NOT NULL,
  CONSTRAINT sofb_identity_ck CHECK (id ~ '^[0-9a-f]{32}$' AND source_order_id > 0 AND payment_order_id > 0
    AND child_order_id > 0 AND uid > 0 AND supplier_id >= 0 AND store_id >= 0 AND add_time > 0
    AND source_refund_id >= 0 AND (source_refund_id > 0 OR source_branch_id IS NOT NULL)
    AND (source_branch_id IS NULL OR (source_branch_id ~ '^[0-9a-f]{32}$' AND source_branch_id <> id))),
  CONSTRAINT sofb_history_ck CHECK (octet_length(covered_refunds) <= 32768 AND jsonb_typeof(covered_refunds::jsonb)='array'
    AND jsonb_array_length(covered_refunds::jsonb) <= 201
    AND octet_length(materialized_refunds) <= 32768 AND jsonb_typeof(materialized_refunds::jsonb)='array'
    AND jsonb_array_length(materialized_refunds::jsonb) <= 201),
  CONSTRAINT sofb_bills_ck CHECK (octet_length(returned_point_bill_ids) <= 16384 AND jsonb_typeof(returned_point_bill_ids::jsonb)='array'
    AND jsonb_array_length(returned_point_bill_ids::jsonb) <= 1024),
  CONSTRAINT sofb_partitions_ck CHECK (octet_length(partitions) <= 32768 AND jsonb_typeof(partitions::jsonb)='array'
    AND jsonb_array_length(partitions::jsonb) BETWEEN 1 AND 200)
);
CREATE INDEX sofb_child_history ON store_order_fulfillment_branch(child_order_id, add_time);

  END IF;
  IF initial_state<>'v1' THEN

CREATE FUNCTION protect_refund_order_split() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Refund materialization evidence is append-only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER sors_no_rewrite BEFORE UPDATE OR DELETE ON store_order_refund_split FOR EACH ROW EXECUTE FUNCTION protect_refund_order_split();
CREATE TRIGGER sors_no_truncate BEFORE TRUNCATE ON store_order_refund_split FOR EACH STATEMENT EXECUTE FUNCTION protect_refund_order_split();
CREATE TRIGGER sofb_no_rewrite BEFORE UPDATE OR DELETE ON store_order_fulfillment_branch FOR EACH ROW EXECUTE FUNCTION protect_refund_order_split();
CREATE TRIGGER sofb_no_truncate BEFORE TRUNCATE ON store_order_fulfillment_branch FOR EACH STATEMENT EXECUTE FUNCTION protect_refund_order_split();
REVOKE ALL ON FUNCTION protect_refund_order_split() FROM PUBLIC;

  END IF;
  SELECT state INTO final_state FROM (WITH catalog AS (
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
),
  snapshot AS (SELECT count(*) AS components,jsonb_object_agg(name,to_jsonb(catalog)) AS objects FROM catalog)
SELECT CASE WHEN components<>3 THEN 'drift'
  WHEN (objects->'store_order_refund_split') @> '{"present":false}'::jsonb AND (objects->'store_order_fulfillment_branch') @> '{"present":false}'::jsonb
    AND (objects->'protect_refund_order_split') @> '{"present":false}'::jsonb THEN 'fresh'
  WHEN (objects->'store_order_refund_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"896ba119f78638caa9db3cd9b52d0023dd21bce0dbef91fc67406767aab40ef4"}'::jsonb AND (objects->'store_order_fulfillment_branch') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"52b82ca8221ca45b7700eb3db940cc036dddd956142e3c6716e79dbc58f6bb9c"}'::jsonb
    AND (objects->'protect_refund_order_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c514fe34f9887575b9b8e3dcb162a3ef437bb1d95a545a28aef6578c450b3b38"}'::jsonb THEN 'v1'
  WHEN (objects->'store_order_refund_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"6e243dbfc5ad50b83b1b8f4ad35ac6160162fc726b42421252d3edf7b38dfcfd"}'::jsonb AND (objects->'store_order_fulfillment_branch') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"8e43b49efa6a271d648ae00547f0b33de26f37450d3263ff035edde131ec4927"}'::jsonb
    AND (objects->'protect_refund_order_split') @> '{"present":false}'::jsonb THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot) c;
  SELECT state INTO invoice_state FROM (WITH catalog AS (
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
  IF final_state IS DISTINCT FROM 'v1' OR invoice_state IS DISTINCT FROM 'v2'
    OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Evidence catalog or ACL verification failed after refund split installation';
  END IF;
END
$refund_split_install$;
