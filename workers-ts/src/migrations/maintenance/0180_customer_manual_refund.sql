-- Candidate 0180: explicit reviewed owner-only PG16 installation.
-- Not registered in MigrationService.runAll; historical 178 migrations remain intact.
-- Stage 1: install the fixed cashier promotion row-lock guard and run
-- customerManualRefundPromotionGrantSql for reviewed SELECT/INSERT, sequence USAGE
-- and catalog-checked UPDATE(id), BEFORE this candidate creates its definer owner ACL.
-- Stage 2: installCustomerManualRefund(db, constrainedNologinPromotionOwner), which
-- first verifies the exact original financial catalog, installs this owner SQL,
-- then assigns the fixed definer to a separate NOLOGIN nonsuperuser with SELECT
-- on actual proof/order/refund tables and DELETE only on store_order_promotions.
-- Stage 3: customerManualRefundRuntimeGrantSql supplies append/read and routine EXECUTE.
-- Runtime never receives table DELETE, ownership or ledger mutation; readiness
-- checks exact catalogs, full original promotion guard, independent LOGIN and ACL.
-- No production installation here; these stages require separate reviewed maintenance.

-- Guest upgrade: complete coherent legacy invoice v2 + split v1 only; four
-- buyer identity CHECK bounds become >=0, with fixed full-table guest pins.
-- Protected functions, triggers, ACLs and original published migrations remain.
-- Pending guest pins deliberately fail the exact postcheck and roll back.
SET LOCAL search_path=public,pg_temp;
SET LOCAL row_security=off;
SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),30000)::text||'ms',true),
  set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true);
DO $cmfr_guest_identity$
DECLARE initial_profile text; locked_profile text;
BEGIN
 IF current_setting('server_version_num')::integer/10000<>16 OR current_setting('transaction_isolation')<>'read committed'
 OR current_setting('transaction_read_only')<>'off' OR current_setting('search_path')<>'public, pg_temp' OR current_schema()<>'public'
 OR current_setting('row_security')<>'off' OR current_setting('session_replication_role')<>'origin' OR current_user<>session_user
 OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
 OR (SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout') NOT BETWEEN 1 AND 30000
 OR (SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout') NOT BETWEEN 1 AND 1000
 OR (SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout') NOT BETWEEN 1 AND 5000
 THEN RAISE EXCEPTION 'Guest refund identity upgrade requires bounded reviewed PG16 owner maintenance';END IF;
 IF NOT pg_try_advisory_xact_lock(731611,0) THEN RAISE EXCEPTION 'Guest refund evidence maintenance busy';END IF;
 SELECT profile INTO initial_profile FROM (SELECT i.state AS invoice,r.state AS split,CASE WHEN i.state='v2' AND r.state='v1' THEN 'legacy' WHEN i.state='v3' AND r.state='v2' THEN 'guest' ELSE 'drift' END AS profile FROM (WITH catalog AS (
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
SELECT CASE WHEN components<>5 THEN 'drift' WHEN (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fa5ac803acadd40ea817c927c552a1e31e69e898620045f48a225a65ff7dc646"}'::jsonb AND (objects->'capture_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"4118143bcefedacec3a6c83bea3094320e0165455a5fcd27f9f97b4c7c8e34c7"}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b2fe7d071ed75d2e734a2f40b8cf091219e7280de6bf5700af866306385b0056"}'::jsonb AND (objects->'store_order_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"f0aac4be250c1e1800b50e4b274d629be0156048ca8383d25a2c90d41cb9f71c"}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"aba9ff86c3f88283979765a86e0d39e8df53dde31926a1585c95e6e7c6a66395"}'::jsonb THEN 'v3'
  WHEN (objects->'capture_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c4935a11f9ce4219938899eb14fda907f1355249df4183524e4c2aff7c1059e8"}'::jsonb
    AND (objects->'store_order_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":false}'::jsonb THEN 'fresh'
  WHEN (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fa5ac803acadd40ea817c927c552a1e31e69e898620045f48a225a65ff7dc646"}'::jsonb AND (objects->'store_order_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b0948eea8f5f31e09e969cae8127ee52187c389205be0b9e5fc3b2439ff51451"}'::jsonb
  AND (objects->'capture_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"4118143bcefedacec3a6c83bea3094320e0165455a5fcd27f9f97b4c7c8e34c7"}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b2fe7d071ed75d2e734a2f40b8cf091219e7280de6bf5700af866306385b0056"}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":false}'::jsonb THEN 'v1'
  WHEN (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fa5ac803acadd40ea817c927c552a1e31e69e898620045f48a225a65ff7dc646"}'::jsonb AND (objects->'store_order_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b0948eea8f5f31e09e969cae8127ee52187c389205be0b9e5fc3b2439ff51451"}'::jsonb
  AND (objects->'capture_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"4118143bcefedacec3a6c83bea3094320e0165455a5fcd27f9f97b4c7c8e34c7"}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b2fe7d071ed75d2e734a2f40b8cf091219e7280de6bf5700af866306385b0056"}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c5da015774eb7f8fa42c4c5ab6e08c49a34491adea620f5ddde475da913606f9"}'::jsonb THEN 'v2'
  WHEN (objects->'capture_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c4935a11f9ce4219938899eb14fda907f1355249df4183524e4c2aff7c1059e8"}'::jsonb
    AND (objects->'store_order_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"1cef40804ed5cfeeb232718495b26a3b48e26925a72da258ac7391ebdbcb7572"}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ce4a3c7b55138db7dfdabc06ff6e86e692cab769ff092fea6e8cc9fe86dad810"}'::jsonb THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot) i CROSS JOIN (WITH catalog AS (
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
SELECT CASE WHEN components<>3 THEN 'drift' WHEN (objects->'protect_refund_order_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c514fe34f9887575b9b8e3dcb162a3ef437bb1d95a545a28aef6578c450b3b38"}'::jsonb AND (objects->'store_order_refund_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"6d8d309a74d565d2389ce69d0573c3992589c9ff2ee8b15d72b0982ca90f5667"}'::jsonb AND (objects->'store_order_fulfillment_branch') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ed0a0a41327ab4ac75ffd73ef8939e90548acc80a836ccc0d8ac8f349e09321d"}'::jsonb THEN 'v2'
  WHEN (objects->'store_order_refund_split') @> '{"present":false}'::jsonb AND (objects->'store_order_fulfillment_branch') @> '{"present":false}'::jsonb
    AND (objects->'protect_refund_order_split') @> '{"present":false}'::jsonb THEN 'fresh'
  WHEN (objects->'store_order_refund_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"896ba119f78638caa9db3cd9b52d0023dd21bce0dbef91fc67406767aab40ef4"}'::jsonb AND (objects->'store_order_fulfillment_branch') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"52b82ca8221ca45b7700eb3db940cc036dddd956142e3c6716e79dbc58f6bb9c"}'::jsonb
    AND (objects->'protect_refund_order_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c514fe34f9887575b9b8e3dcb162a3ef437bb1d95a545a28aef6578c450b3b38"}'::jsonb THEN 'v1'
  WHEN (objects->'store_order_refund_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"6e243dbfc5ad50b83b1b8f4ad35ac6160162fc726b42421252d3edf7b38dfcfd"}'::jsonb AND (objects->'store_order_fulfillment_branch') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"8e43b49efa6a271d648ae00547f0b33de26f37450d3263ff035edde131ec4927"}'::jsonb
    AND (objects->'protect_refund_order_split') @> '{"present":false}'::jsonb THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot) r) c;
 IF initial_profile NOT IN('legacy','guest') OR initial_profile IS NULL THEN RAISE EXCEPTION 'Guest refund upgrade requires exact coherent invoice/refund catalog';END IF;
 LOCK TABLE public.store_order_invoice IN ACCESS EXCLUSIVE MODE NOWAIT;
 LOCK TABLE public.store_order_invoice_evidence IN ACCESS EXCLUSIVE MODE NOWAIT;
 LOCK TABLE public.store_order_invoice_allocation IN ACCESS EXCLUSIVE MODE NOWAIT;
 LOCK TABLE public.store_order_refund_split IN ACCESS EXCLUSIVE MODE NOWAIT;
 LOCK TABLE public.store_order_fulfillment_branch IN ACCESS EXCLUSIVE MODE NOWAIT;
 SELECT profile INTO locked_profile FROM (SELECT i.state AS invoice,r.state AS split,CASE WHEN i.state='v2' AND r.state='v1' THEN 'legacy' WHEN i.state='v3' AND r.state='v2' THEN 'guest' ELSE 'drift' END AS profile FROM (WITH catalog AS (
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
SELECT CASE WHEN components<>5 THEN 'drift' WHEN (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fa5ac803acadd40ea817c927c552a1e31e69e898620045f48a225a65ff7dc646"}'::jsonb AND (objects->'capture_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"4118143bcefedacec3a6c83bea3094320e0165455a5fcd27f9f97b4c7c8e34c7"}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b2fe7d071ed75d2e734a2f40b8cf091219e7280de6bf5700af866306385b0056"}'::jsonb AND (objects->'store_order_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"f0aac4be250c1e1800b50e4b274d629be0156048ca8383d25a2c90d41cb9f71c"}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"aba9ff86c3f88283979765a86e0d39e8df53dde31926a1585c95e6e7c6a66395"}'::jsonb THEN 'v3'
  WHEN (objects->'capture_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c4935a11f9ce4219938899eb14fda907f1355249df4183524e4c2aff7c1059e8"}'::jsonb
    AND (objects->'store_order_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":false}'::jsonb THEN 'fresh'
  WHEN (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fa5ac803acadd40ea817c927c552a1e31e69e898620045f48a225a65ff7dc646"}'::jsonb AND (objects->'store_order_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b0948eea8f5f31e09e969cae8127ee52187c389205be0b9e5fc3b2439ff51451"}'::jsonb
  AND (objects->'capture_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"4118143bcefedacec3a6c83bea3094320e0165455a5fcd27f9f97b4c7c8e34c7"}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b2fe7d071ed75d2e734a2f40b8cf091219e7280de6bf5700af866306385b0056"}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":false}'::jsonb THEN 'v1'
  WHEN (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fa5ac803acadd40ea817c927c552a1e31e69e898620045f48a225a65ff7dc646"}'::jsonb AND (objects->'store_order_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b0948eea8f5f31e09e969cae8127ee52187c389205be0b9e5fc3b2439ff51451"}'::jsonb
  AND (objects->'capture_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"4118143bcefedacec3a6c83bea3094320e0165455a5fcd27f9f97b4c7c8e34c7"}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b2fe7d071ed75d2e734a2f40b8cf091219e7280de6bf5700af866306385b0056"}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c5da015774eb7f8fa42c4c5ab6e08c49a34491adea620f5ddde475da913606f9"}'::jsonb THEN 'v2'
  WHEN (objects->'capture_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c4935a11f9ce4219938899eb14fda907f1355249df4183524e4c2aff7c1059e8"}'::jsonb
    AND (objects->'store_order_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"1cef40804ed5cfeeb232718495b26a3b48e26925a72da258ac7391ebdbcb7572"}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ce4a3c7b55138db7dfdabc06ff6e86e692cab769ff092fea6e8cc9fe86dad810"}'::jsonb THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot) i CROSS JOIN (WITH catalog AS (
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
SELECT CASE WHEN components<>3 THEN 'drift' WHEN (objects->'protect_refund_order_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c514fe34f9887575b9b8e3dcb162a3ef437bb1d95a545a28aef6578c450b3b38"}'::jsonb AND (objects->'store_order_refund_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"6d8d309a74d565d2389ce69d0573c3992589c9ff2ee8b15d72b0982ca90f5667"}'::jsonb AND (objects->'store_order_fulfillment_branch') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ed0a0a41327ab4ac75ffd73ef8939e90548acc80a836ccc0d8ac8f349e09321d"}'::jsonb THEN 'v2'
  WHEN (objects->'store_order_refund_split') @> '{"present":false}'::jsonb AND (objects->'store_order_fulfillment_branch') @> '{"present":false}'::jsonb
    AND (objects->'protect_refund_order_split') @> '{"present":false}'::jsonb THEN 'fresh'
  WHEN (objects->'store_order_refund_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"896ba119f78638caa9db3cd9b52d0023dd21bce0dbef91fc67406767aab40ef4"}'::jsonb AND (objects->'store_order_fulfillment_branch') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"52b82ca8221ca45b7700eb3db940cc036dddd956142e3c6716e79dbc58f6bb9c"}'::jsonb
    AND (objects->'protect_refund_order_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c514fe34f9887575b9b8e3dcb162a3ef437bb1d95a545a28aef6578c450b3b38"}'::jsonb THEN 'v1'
  WHEN (objects->'store_order_refund_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"6e243dbfc5ad50b83b1b8f4ad35ac6160162fc726b42421252d3edf7b38dfcfd"}'::jsonb AND (objects->'store_order_fulfillment_branch') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"8e43b49efa6a271d648ae00547f0b33de26f37450d3263ff035edde131ec4927"}'::jsonb
    AND (objects->'protect_refund_order_split') @> '{"present":false}'::jsonb THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot) r) c;
 IF locked_profile IS DISTINCT FROM initial_profile THEN RAISE EXCEPTION 'Guest refund catalog changed while locking';END IF;
 IF initial_profile='legacy' THEN
 ALTER TABLE public.store_order_invoice_evidence DROP CONSTRAINT soie_identity_ck,ADD CONSTRAINT soie_identity_ck CHECK (invoice_id > 0 AND order_id > 0 AND uid >= 0
    AND kind IN ('created','issued','unverified') AND (kind='issued' OR document_number=''));
ALTER TABLE public.store_order_invoice_allocation DROP CONSTRAINT soia_identity_ck,ADD CONSTRAINT soia_identity_ck CHECK (id ~ '^[0-9a-f]{32}$' AND source_invoice_id > 0
    AND source_order_id > 0 AND payment_order_id > 0 AND uid >= 0 AND add_time > 0
    AND reason IN ('fulfillment','supplier'));
ALTER TABLE public.store_order_refund_split DROP CONSTRAINT sors_identity_ck,ADD CONSTRAINT sors_identity_ck CHECK (refund_id > 0 AND uid >= 0 AND supplier_id >= 0 AND store_id >= 0
    AND source_order_id > 0 AND payment_order_id > 0 AND selected_order_id > 0 AND add_time > 0);
ALTER TABLE public.store_order_fulfillment_branch DROP CONSTRAINT sofb_identity_ck,ADD CONSTRAINT sofb_identity_ck CHECK (id ~ '^[0-9a-f]{32}$' AND source_order_id > 0 AND payment_order_id > 0
    AND child_order_id > 0 AND uid >= 0 AND supplier_id >= 0 AND store_id >= 0 AND add_time > 0
    AND source_refund_id >= 0 AND (source_refund_id > 0 OR source_branch_id IS NOT NULL)
    AND (source_branch_id IS NULL OR (source_branch_id ~ '^[0-9a-f]{32}$' AND source_branch_id <> id)));
 END IF;
END $cmfr_guest_identity$;

DO $cmfr_guest_postcheck$ BEGIN
 IF (SELECT profile FROM (SELECT i.state AS invoice,r.state AS split,CASE WHEN i.state='v2' AND r.state='v1' THEN 'legacy' WHEN i.state='v3' AND r.state='v2' THEN 'guest' ELSE 'drift' END AS profile FROM (WITH catalog AS (
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
SELECT CASE WHEN components<>5 THEN 'drift' WHEN (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fa5ac803acadd40ea817c927c552a1e31e69e898620045f48a225a65ff7dc646"}'::jsonb AND (objects->'capture_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"4118143bcefedacec3a6c83bea3094320e0165455a5fcd27f9f97b4c7c8e34c7"}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b2fe7d071ed75d2e734a2f40b8cf091219e7280de6bf5700af866306385b0056"}'::jsonb AND (objects->'store_order_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"f0aac4be250c1e1800b50e4b274d629be0156048ca8383d25a2c90d41cb9f71c"}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"aba9ff86c3f88283979765a86e0d39e8df53dde31926a1585c95e6e7c6a66395"}'::jsonb THEN 'v3'
  WHEN (objects->'capture_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c4935a11f9ce4219938899eb14fda907f1355249df4183524e4c2aff7c1059e8"}'::jsonb
    AND (objects->'store_order_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":false}'::jsonb THEN 'fresh'
  WHEN (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fa5ac803acadd40ea817c927c552a1e31e69e898620045f48a225a65ff7dc646"}'::jsonb AND (objects->'store_order_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b0948eea8f5f31e09e969cae8127ee52187c389205be0b9e5fc3b2439ff51451"}'::jsonb
  AND (objects->'capture_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"4118143bcefedacec3a6c83bea3094320e0165455a5fcd27f9f97b4c7c8e34c7"}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b2fe7d071ed75d2e734a2f40b8cf091219e7280de6bf5700af866306385b0056"}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":false}'::jsonb THEN 'v1'
  WHEN (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fa5ac803acadd40ea817c927c552a1e31e69e898620045f48a225a65ff7dc646"}'::jsonb AND (objects->'store_order_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b0948eea8f5f31e09e969cae8127ee52187c389205be0b9e5fc3b2439ff51451"}'::jsonb
  AND (objects->'capture_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"4118143bcefedacec3a6c83bea3094320e0165455a5fcd27f9f97b4c7c8e34c7"}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b2fe7d071ed75d2e734a2f40b8cf091219e7280de6bf5700af866306385b0056"}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c5da015774eb7f8fa42c4c5ab6e08c49a34491adea620f5ddde475da913606f9"}'::jsonb THEN 'v2'
  WHEN (objects->'capture_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'protect_invoice_evidence') @> '{"present":false}'::jsonb AND (objects->'store_order_invoice') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c4935a11f9ce4219938899eb14fda907f1355249df4183524e4c2aff7c1059e8"}'::jsonb
    AND (objects->'store_order_invoice_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"1cef40804ed5cfeeb232718495b26a3b48e26925a72da258ac7391ebdbcb7572"}'::jsonb AND (objects->'store_order_invoice_allocation') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ce4a3c7b55138db7dfdabc06ff6e86e692cab769ff092fea6e8cc9fe86dad810"}'::jsonb THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot) i CROSS JOIN (WITH catalog AS (
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
SELECT CASE WHEN components<>3 THEN 'drift' WHEN (objects->'protect_refund_order_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c514fe34f9887575b9b8e3dcb162a3ef437bb1d95a545a28aef6578c450b3b38"}'::jsonb AND (objects->'store_order_refund_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"6d8d309a74d565d2389ce69d0573c3992589c9ff2ee8b15d72b0982ca90f5667"}'::jsonb AND (objects->'store_order_fulfillment_branch') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ed0a0a41327ab4ac75ffd73ef8939e90548acc80a836ccc0d8ac8f349e09321d"}'::jsonb THEN 'v2'
  WHEN (objects->'store_order_refund_split') @> '{"present":false}'::jsonb AND (objects->'store_order_fulfillment_branch') @> '{"present":false}'::jsonb
    AND (objects->'protect_refund_order_split') @> '{"present":false}'::jsonb THEN 'fresh'
  WHEN (objects->'store_order_refund_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"896ba119f78638caa9db3cd9b52d0023dd21bce0dbef91fc67406767aab40ef4"}'::jsonb AND (objects->'store_order_fulfillment_branch') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"52b82ca8221ca45b7700eb3db940cc036dddd956142e3c6716e79dbc58f6bb9c"}'::jsonb
    AND (objects->'protect_refund_order_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c514fe34f9887575b9b8e3dcb162a3ef437bb1d95a545a28aef6578c450b3b38"}'::jsonb THEN 'v1'
  WHEN (objects->'store_order_refund_split') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"6e243dbfc5ad50b83b1b8f4ad35ac6160162fc726b42421252d3edf7b38dfcfd"}'::jsonb AND (objects->'store_order_fulfillment_branch') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"8e43b49efa6a271d648ae00547f0b33de26f37450d3263ff035edde131ec4927"}'::jsonb
    AND (objects->'protect_refund_order_split') @> '{"present":false}'::jsonb THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot) r) c) IS DISTINCT FROM 'guest'
 THEN RAISE EXCEPTION 'Guest refund full catalog postcheck uncommissioned or incompatible';END IF;
END $cmfr_guest_postcheck$;

SET LOCAL search_path=public,pg_temp;SET LOCAL row_security=off;
DO $cmfr_install$ BEGIN
 IF current_setting('server_version_num')::int/10000<>16 OR current_setting('transaction_read_only')<>'off'
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('session_replication_role')<>'origin'
 OR current_user<>session_user OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
 OR NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid=to_regclass('public.customer_financial_operation_request') AND r.rolname=current_user)
 THEN RAISE EXCEPTION 'Manual refund installation requires reviewed PG16 financial owner transaction'; END IF;
 IF NOT pg_try_advisory_xact_lock(731711,0) THEN RAISE EXCEPTION 'Manual refund installation already running'; END IF;
 IF to_regclass('public.customer_financial_manual_refund_v1') IS NOT NULL THEN RAISE EXCEPTION 'Existing manual refund protocol requires exact catalog review'; END IF;
END $cmfr_install$;

CREATE OR REPLACE FUNCTION public.customer_financial_intent_valid_v1(text,jsonb) RETURNS boolean
 LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp
 AS $customer_financial_intent$
 SELECT COALESCE(CASE WHEN pg_catalog.jsonb_typeof($2) IS DISTINCT FROM 'object' THEN false
 WHEN NOT ((CASE WHEN pg_catalog.jsonb_typeof($2) IS DISTINCT FROM 'object' THEN false ELSE $2 ?& ARRAY['version','scope_key','order_id','expected_order_revision','expected_financial_revision','payload']::text[] AND ($2)-ARRAY['version','scope_key','order_id','expected_order_revision','expected_financial_revision','payload']::text[]='{}'::jsonb END)) THEN false
 WHEN $2->'version' IS DISTINCT FROM '"customer-work-financial-operation-v1"'::jsonb
 OR NOT (pg_catalog.jsonb_typeof($2->'scope_key')='string' AND ($2->'scope_key' #>> '{}') ~ '^[a-f0-9]{64}$' AND (CASE WHEN pg_catalog.jsonb_typeof($2->'order_id') IS DISTINCT FROM 'number' THEN false WHEN ($2->'order_id' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($2->'order_id' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) AND pg_catalog.jsonb_typeof($2->'expected_order_revision')='string' AND ($2->'expected_order_revision' #>> '{}') ~ '^[a-f0-9]{64}$' AND pg_catalog.jsonb_typeof($2->'expected_financial_revision')='string' AND ($2->'expected_financial_revision' #>> '{}') ~ '^[a-f0-9]{64}$')
 OR pg_catalog.jsonb_typeof($2->'payload') IS DISTINCT FROM 'object' THEN false
 ELSE CASE $1
 WHEN 'change_price' THEN (CASE WHEN pg_catalog.jsonb_typeof($2->'payload') IS DISTINCT FROM 'object' THEN false ELSE $2->'payload' ?& ARRAY['price']::text[] AND ($2->'payload')-ARRAY['price']::text[]='{}'::jsonb END) AND pg_catalog.jsonb_typeof($2->'payload'->'price')='string' AND ($2->'payload'->'price' #>> '{}') ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$'
 WHEN 'confirm_offline' THEN $2->'payload'='{}'::jsonb
 WHEN 'refund_create' THEN (CASE WHEN pg_catalog.jsonb_typeof($2->'payload') IS DISTINCT FROM 'object' THEN false ELSE $2->'payload' ?& ARRAY['mode','items','quoted_price','refund_price','quote_fingerprint','reason']::text[] AND ($2->'payload')-ARRAY['mode','items','quoted_price','refund_price','quote_fingerprint','reason']::text[]='{}'::jsonb END)
   AND $2->'payload'->'mode' IN ('"remaining"'::jsonb,'"items"'::jsonb) AND (CASE WHEN pg_catalog.jsonb_typeof($2->'payload'->'items') IS DISTINCT FROM 'array' THEN false ELSE pg_catalog.jsonb_array_length($2->'payload'->'items')<=100 AND NOT EXISTS(SELECT 1 FROM (SELECT value,pg_catalog.lag(value->'cart_row_id') OVER(ORDER BY ordinality) AS previous FROM pg_catalog.jsonb_array_elements($2->'payload'->'items') WITH ORDINALITY) item WHERE NOT((CASE WHEN pg_catalog.jsonb_typeof(value) IS DISTINCT FROM 'object' THEN false ELSE value ?& ARRAY['cart_row_id','cart_num']::text[] AND (value)-ARRAY['cart_row_id','cart_num']::text[]='{}'::jsonb END) AND (CASE WHEN pg_catalog.jsonb_typeof(value->'cart_row_id') IS DISTINCT FROM 'number' THEN false WHEN (value->'cart_row_id' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE (value->'cart_row_id' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) AND (CASE WHEN pg_catalog.jsonb_typeof(value->'cart_num') IS DISTINCT FROM 'number' THEN false WHEN (value->'cart_num' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE (value->'cart_num' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END)) OR (previous IS NOT NULL AND (NOT (CASE WHEN pg_catalog.jsonb_typeof(previous) IS DISTINCT FROM 'number' THEN false WHEN (previous #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE (previous #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) OR (CASE WHEN (CASE WHEN pg_catalog.jsonb_typeof(previous) IS DISTINCT FROM 'number' THEN false WHEN (previous #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE (previous #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) THEN (previous #>> '{}')::numeric ELSE NULL END)>=(CASE WHEN (CASE WHEN pg_catalog.jsonb_typeof(value->'cart_row_id') IS DISTINCT FROM 'number' THEN false WHEN (value->'cart_row_id' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE (value->'cart_row_id' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) THEN (value->'cart_row_id' #>> '{}')::numeric ELSE NULL END)))) END)
   AND (CASE WHEN pg_catalog.jsonb_typeof($2->'payload'->'items') IS DISTINCT FROM 'array' THEN false ELSE CASE WHEN $2->'payload'->'mode'='"remaining"'::jsonb THEN pg_catalog.jsonb_array_length($2->'payload'->'items')=0 ELSE pg_catalog.jsonb_array_length($2->'payload'->'items') BETWEEN 1 AND 100 END END)
   AND (CASE WHEN pg_catalog.jsonb_typeof($2->'payload'->'quoted_price')='string' AND ($2->'payload'->'quoted_price' #>> '{}') ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' AND pg_catalog.jsonb_typeof($2->'payload'->'refund_price')='string' AND ($2->'payload'->'refund_price' #>> '{}') ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN ($2->'payload'->>'refund_price')::numeric<=($2->'payload'->>'quoted_price')::numeric ELSE false END)
   AND pg_catalog.jsonb_typeof($2->'payload'->'quote_fingerprint')='string' AND ($2->'payload'->'quote_fingerprint' #>> '{}') ~ '^[a-f0-9]{64}$' AND pg_catalog.jsonb_typeof($2->'payload'->'reason')='string' AND pg_catalog.char_length($2->'payload'->'reason' #>> '{}') BETWEEN 1 AND 255 AND ($2->'payload'->'reason' #>> '{}') !~ '[-]' AND pg_catalog.btrim($2->'payload'->'reason' #>> '{}','	
                  　﻿')=($2->'payload'->'reason' #>> '{}')
 WHEN 'refund_return' THEN (CASE WHEN pg_catalog.jsonb_typeof($2->'payload') IS DISTINCT FROM 'object' THEN false ELSE $2->'payload' ?& ARRAY['refund_id','refund_no','expected_refund_revision','review_fingerprint','decision']::text[] AND ($2->'payload')-ARRAY['refund_id','refund_no','expected_refund_revision','review_fingerprint','decision']::text[]='{}'::jsonb END) AND (CASE WHEN pg_catalog.jsonb_typeof($2->'payload'->'refund_id') IS DISTINCT FROM 'number' THEN false WHEN ($2->'payload'->'refund_id' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($2->'payload'->'refund_id' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) AND pg_catalog.jsonb_typeof($2->'payload'->'refund_no')='string' AND pg_catalog.char_length($2->'payload'->'refund_no' #>> '{}') BETWEEN 1 AND 50 AND ($2->'payload'->'refund_no' #>> '{}') !~ '[-]' AND pg_catalog.btrim($2->'payload'->'refund_no' #>> '{}','	
                  　﻿')=($2->'payload'->'refund_no' #>> '{}') AND pg_catalog.jsonb_typeof($2->'payload'->'expected_refund_revision')='string' AND ($2->'payload'->'expected_refund_revision' #>> '{}') ~ '^[a-f0-9]{64}$' AND pg_catalog.jsonb_typeof($2->'payload'->'review_fingerprint')='string' AND ($2->'payload'->'review_fingerprint' #>> '{}') ~ '^[a-f0-9]{64}$' AND (CASE WHEN pg_catalog.jsonb_typeof($2->'payload'->'decision') IS DISTINCT FROM 'object' THEN false ELSE $2->'payload'->'decision' ?& ARRAY['apply_type','refund_type','received']::text[] AND ($2->'payload'->'decision')-ARRAY['apply_type','refund_type','received']::text[]='{}'::jsonb END) AND $2->'payload'->'decision'->'apply_type' IN ('0'::jsonb,'1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb) AND $2->'payload'->'decision'->'refund_type' IN ('0'::jsonb,'1'::jsonb,'2'::jsonb,'4'::jsonb,'5'::jsonb) AND pg_catalog.jsonb_typeof($2->'payload'->'decision'->'received')='boolean'
   AND $2->'payload'->'decision'->'apply_type' IN ('2'::jsonb,'3'::jsonb) AND $2->'payload'->'decision'->'refund_type' IN ('0'::jsonb,'1'::jsonb,'2'::jsonb)
 WHEN 'refund_refuse' THEN (CASE WHEN pg_catalog.jsonb_typeof($2->'payload') IS DISTINCT FROM 'object' THEN false ELSE $2->'payload' ?& ARRAY['refund_id','refund_no','expected_refund_revision','review_fingerprint','decision','reason']::text[] AND ($2->'payload')-ARRAY['refund_id','refund_no','expected_refund_revision','review_fingerprint','decision','reason']::text[]='{}'::jsonb END) AND (CASE WHEN pg_catalog.jsonb_typeof($2->'payload'->'refund_id') IS DISTINCT FROM 'number' THEN false WHEN ($2->'payload'->'refund_id' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($2->'payload'->'refund_id' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) AND pg_catalog.jsonb_typeof($2->'payload'->'refund_no')='string' AND pg_catalog.char_length($2->'payload'->'refund_no' #>> '{}') BETWEEN 1 AND 50 AND ($2->'payload'->'refund_no' #>> '{}') !~ '[-]' AND pg_catalog.btrim($2->'payload'->'refund_no' #>> '{}','	
                  　﻿')=($2->'payload'->'refund_no' #>> '{}') AND pg_catalog.jsonb_typeof($2->'payload'->'expected_refund_revision')='string' AND ($2->'payload'->'expected_refund_revision' #>> '{}') ~ '^[a-f0-9]{64}$' AND pg_catalog.jsonb_typeof($2->'payload'->'review_fingerprint')='string' AND ($2->'payload'->'review_fingerprint' #>> '{}') ~ '^[a-f0-9]{64}$' AND (CASE WHEN pg_catalog.jsonb_typeof($2->'payload'->'decision') IS DISTINCT FROM 'object' THEN false ELSE $2->'payload'->'decision' ?& ARRAY['apply_type','refund_type','received']::text[] AND ($2->'payload'->'decision')-ARRAY['apply_type','refund_type','received']::text[]='{}'::jsonb END) AND $2->'payload'->'decision'->'apply_type' IN ('0'::jsonb,'1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb) AND $2->'payload'->'decision'->'refund_type' IN ('0'::jsonb,'1'::jsonb,'2'::jsonb,'4'::jsonb,'5'::jsonb) AND pg_catalog.jsonb_typeof($2->'payload'->'decision'->'received')='boolean' AND pg_catalog.jsonb_typeof($2->'payload'->'reason')='string' AND pg_catalog.char_length($2->'payload'->'reason' #>> '{}') BETWEEN 1 AND 255 AND ($2->'payload'->'reason' #>> '{}') !~ '[-]' AND pg_catalog.btrim($2->'payload'->'reason' #>> '{}','	
                  　﻿')=($2->'payload'->'reason' #>> '{}')
 WHEN 'refund_execute' THEN (CASE WHEN pg_catalog.jsonb_typeof($2->'payload') IS DISTINCT FROM 'object' THEN false ELSE $2->'payload' ?& ARRAY['refund_id','refund_no','expected_refund_revision','review_fingerprint','decision','refund_price']::text[] AND ($2->'payload')-ARRAY['refund_id','refund_no','expected_refund_revision','review_fingerprint','decision','refund_price']::text[]='{}'::jsonb END) AND (CASE WHEN pg_catalog.jsonb_typeof($2->'payload'->'refund_id') IS DISTINCT FROM 'number' THEN false WHEN ($2->'payload'->'refund_id' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($2->'payload'->'refund_id' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) AND pg_catalog.jsonb_typeof($2->'payload'->'refund_no')='string' AND pg_catalog.char_length($2->'payload'->'refund_no' #>> '{}') BETWEEN 1 AND 50 AND ($2->'payload'->'refund_no' #>> '{}') !~ '[-]' AND pg_catalog.btrim($2->'payload'->'refund_no' #>> '{}','	
                  　﻿')=($2->'payload'->'refund_no' #>> '{}') AND pg_catalog.jsonb_typeof($2->'payload'->'expected_refund_revision')='string' AND ($2->'payload'->'expected_refund_revision' #>> '{}') ~ '^[a-f0-9]{64}$' AND pg_catalog.jsonb_typeof($2->'payload'->'review_fingerprint')='string' AND ($2->'payload'->'review_fingerprint' #>> '{}') ~ '^[a-f0-9]{64}$' AND ((CASE WHEN pg_catalog.jsonb_typeof($2->'payload'->'decision') IS DISTINCT FROM 'object' THEN false ELSE $2->'payload'->'decision' ?& ARRAY['apply_type','refund_type','received']::text[] AND ($2->'payload'->'decision')-ARRAY['apply_type','refund_type','received']::text[]='{}'::jsonb END) OR ((CASE WHEN pg_catalog.jsonb_typeof($2->'payload'->'decision') IS DISTINCT FROM 'object' THEN false ELSE $2->'payload'->'decision' ?& ARRAY['apply_type','refund_type','received','cash_returned']::text[] AND ($2->'payload'->'decision')-ARRAY['apply_type','refund_type','received','cash_returned']::text[]='{}'::jsonb END) AND $2->'payload'->'decision'->'cash_returned'='true'::jsonb AND $2->'payload'->>'refund_price'<>'0.00')) AND $2->'payload'->'decision'->'apply_type' IN ('0'::jsonb,'1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb) AND $2->'payload'->'decision'->'refund_type' IN ('0'::jsonb,'1'::jsonb,'2'::jsonb,'4'::jsonb,'5'::jsonb) AND pg_catalog.jsonb_typeof($2->'payload'->'decision'->'received')='boolean' AND pg_catalog.jsonb_typeof($2->'payload'->'refund_price')='string' AND ($2->'payload'->'refund_price' #>> '{}') ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$'
   AND $2->'payload'->'decision'->'apply_type' IN ('1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb)
   AND (CASE WHEN $2->'payload'->'decision'->'apply_type' IN ('2'::jsonb,'3'::jsonb) THEN $2->'payload'->'decision'->'received'='true'::jsonb AND (($2->'payload'->'decision'->'apply_type'='2'::jsonb AND $2->'payload'->'decision'->'refund_type'='5'::jsonb) OR ($2->'payload'->'decision'->'apply_type'='3'::jsonb AND $2->'payload'->'decision'->'refund_type' IN ('4'::jsonb,'5'::jsonb))) ELSE true END)
 WHEN 'refund_remark' THEN (CASE WHEN pg_catalog.jsonb_typeof($2->'payload') IS DISTINCT FROM 'object' THEN false ELSE $2->'payload' ?& ARRAY['refund_id','refund_no','expected_refund_revision','review_fingerprint','remark']::text[] AND ($2->'payload')-ARRAY['refund_id','refund_no','expected_refund_revision','review_fingerprint','remark']::text[]='{}'::jsonb END) AND (CASE WHEN pg_catalog.jsonb_typeof($2->'payload'->'refund_id') IS DISTINCT FROM 'number' THEN false WHEN ($2->'payload'->'refund_id' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($2->'payload'->'refund_id' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) AND pg_catalog.jsonb_typeof($2->'payload'->'refund_no')='string' AND pg_catalog.char_length($2->'payload'->'refund_no' #>> '{}') BETWEEN 1 AND 50 AND ($2->'payload'->'refund_no' #>> '{}') !~ '[-]' AND pg_catalog.btrim($2->'payload'->'refund_no' #>> '{}','	
                  　﻿')=($2->'payload'->'refund_no' #>> '{}') AND pg_catalog.jsonb_typeof($2->'payload'->'expected_refund_revision')='string' AND ($2->'payload'->'expected_refund_revision' #>> '{}') ~ '^[a-f0-9]{64}$' AND pg_catalog.jsonb_typeof($2->'payload'->'review_fingerprint')='string' AND ($2->'payload'->'review_fingerprint' #>> '{}') ~ '^[a-f0-9]{64}$' AND pg_catalog.jsonb_typeof($2->'payload'->'remark')='string' AND pg_catalog.char_length($2->'payload'->'remark' #>> '{}') BETWEEN 1 AND 255 AND ($2->'payload'->'remark' #>> '{}') !~ '[-]' AND pg_catalog.btrim($2->'payload'->'remark' #>> '{}','	
                  　﻿')=($2->'payload'->'remark' #>> '{}')
 ELSE false END END,false)
$customer_financial_intent$;
CREATE OR REPLACE FUNCTION public.customer_financial_evidence_valid_v1(text,text,jsonb,jsonb) RETURNS boolean
 LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp
 AS $customer_financial_evidence$
 SELECT COALESCE(CASE WHEN NOT public.customer_financial_intent_valid_v1($1,$3) THEN false
 WHEN pg_catalog.jsonb_typeof($4) IS DISTINCT FROM 'object' THEN false
 WHEN $3->'payload'->'decision'->'cash_returned'='true'::jsonb AND $2<>'cash-settled' THEN false
 WHEN $2='abandoned' THEN $4='{}'::jsonb
 WHEN $2='rollback-rejected' THEN (CASE WHEN pg_catalog.jsonb_typeof($4) IS DISTINCT FROM 'object' THEN false ELSE $4 ?& ARRAY['code']::text[] AND ($4)-ARRAY['code']::text[]='{}'::jsonb END) AND pg_catalog.jsonb_typeof($4->'code')='string' AND pg_catalog.char_length($4->'code' #>> '{}') BETWEEN 1 AND 128 AND ($4->'code' #>> '{}') !~ '[-]' AND pg_catalog.btrim($4->'code' #>> '{}','	
                  　﻿')=($4->'code' #>> '{}')
 ELSE CASE $1
 WHEN 'change_price' THEN $2='price-changed' AND (CASE WHEN pg_catalog.jsonb_typeof($4) IS DISTINCT FROM 'object' THEN false ELSE $4 ?& ARRAY['changed','verified']::text[] AND ($4)-ARRAY['changed','verified']::text[]='{}'::jsonb END) AND (CASE WHEN pg_catalog.jsonb_typeof($4->'changed') IS DISTINCT FROM 'number' THEN false WHEN ($4->'changed' #>> '{}') !~ '^(0|[1-9][0-9]{0,9})$' THEN false ELSE ($4->'changed' #>> '{}')::numeric BETWEEN 0 AND 1 END) AND $4->'verified'='true'::jsonb
 WHEN 'confirm_offline' THEN $2='offline-paid' AND (CASE WHEN pg_catalog.jsonb_typeof($4) IS DISTINCT FROM 'object' THEN false ELSE $4 ?& ARRAY['outbox_id','verified']::text[] AND ($4)-ARRAY['outbox_id','verified']::text[]='{}'::jsonb END) AND (CASE WHEN pg_catalog.jsonb_typeof($4->'outbox_id') IS DISTINCT FROM 'number' THEN false WHEN ($4->'outbox_id' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($4->'outbox_id' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) AND $4->'verified'='true'::jsonb
 WHEN 'refund_create' THEN $2='refund-created' AND (CASE WHEN pg_catalog.jsonb_typeof($4) IS DISTINCT FROM 'object' THEN false ELSE $4 ?& ARRAY['refund_id','refund_no','verified']::text[] AND ($4)-ARRAY['refund_id','refund_no','verified']::text[]='{}'::jsonb END) AND (CASE WHEN pg_catalog.jsonb_typeof($4->'refund_id') IS DISTINCT FROM 'number' THEN false WHEN ($4->'refund_id' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($4->'refund_id' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) AND pg_catalog.jsonb_typeof($4->'refund_no')='string' AND pg_catalog.char_length($4->'refund_no' #>> '{}') BETWEEN 1 AND 32 AND ($4->'refund_no' #>> '{}') !~ '[-]' AND pg_catalog.btrim($4->'refund_no' #>> '{}','	
                  　﻿')=($4->'refund_no' #>> '{}') AND $4->'verified'='true'::jsonb
 WHEN 'refund_return' THEN $2='return-approved' AND (CASE WHEN pg_catalog.jsonb_typeof($4) IS DISTINCT FROM 'object' THEN false ELSE $4 ?& ARRAY['refund_id','changed','verified']::text[] AND ($4)-ARRAY['refund_id','changed','verified']::text[]='{}'::jsonb END) AND (CASE WHEN pg_catalog.jsonb_typeof($4->'refund_id') IS DISTINCT FROM 'number' THEN false WHEN ($4->'refund_id' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($4->'refund_id' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) AND $4->'refund_id'=$3->'payload'->'refund_id' AND (CASE WHEN pg_catalog.jsonb_typeof($4->'changed') IS DISTINCT FROM 'number' THEN false WHEN ($4->'changed' #>> '{}') !~ '^(0|[1-9][0-9]{0,9})$' THEN false ELSE ($4->'changed' #>> '{}')::numeric BETWEEN 0 AND 1 END) AND $4->'verified'='true'::jsonb
 WHEN 'refund_refuse' THEN $2='refused' AND (CASE WHEN pg_catalog.jsonb_typeof($4) IS DISTINCT FROM 'object' THEN false ELSE $4 ?& ARRAY['refund_id','verified']::text[] AND ($4)-ARRAY['refund_id','verified']::text[]='{}'::jsonb END) AND (CASE WHEN pg_catalog.jsonb_typeof($4->'refund_id') IS DISTINCT FROM 'number' THEN false WHEN ($4->'refund_id' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($4->'refund_id' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) AND $4->'refund_id'=$3->'payload'->'refund_id' AND $4->'verified'='true'::jsonb
 WHEN 'refund_execute' THEN CASE WHEN $2='balance-settled' THEN (CASE WHEN pg_catalog.jsonb_typeof($4) IS DISTINCT FROM 'object' THEN false ELSE $4 ?& ARRAY['refund_id','verified']::text[] AND ($4)-ARRAY['refund_id','verified']::text[]='{}'::jsonb END) AND (CASE WHEN pg_catalog.jsonb_typeof($4->'refund_id') IS DISTINCT FROM 'number' THEN false WHEN ($4->'refund_id' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($4->'refund_id' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) AND $4->'refund_id'=$3->'payload'->'refund_id' AND $4->'verified'='true'::jsonb

   WHEN $2='zero-settled' THEN (CASE WHEN pg_catalog.jsonb_typeof($4) IS DISTINCT FROM 'object' THEN false ELSE $4 ?& ARRAY['refund_id','verified']::text[] AND ($4)-ARRAY['refund_id','verified']::text[]='{}'::jsonb END) AND $4->'refund_id'=$3->'payload'->'refund_id' AND (CASE WHEN jsonb_typeof($4->'refund_id') IS DISTINCT FROM 'number' OR ($4->'refund_id'#>>'{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($4->'refund_id'#>>'{}')::numeric BETWEEN 1 AND 2147483647 END) AND $4->'verified'='true'::jsonb AND $3->'payload'->>'refund_price'='0.00' AND NOT($3->'payload'->'decision' ? 'cash_returned')
   WHEN $2='cash-settled' THEN (CASE WHEN pg_catalog.jsonb_typeof($4) IS DISTINCT FROM 'object' THEN false ELSE $4 ?& ARRAY['refund_id','refund_no','payment_order_id','uid','store_id','supplier_id','pay_type','amount','cash_returned','manual_proof_hash','verified']::text[] AND ($4)-ARRAY['refund_id','refund_no','payment_order_id','uid','store_id','supplier_id','pay_type','amount','cash_returned','manual_proof_hash','verified']::text[]='{}'::jsonb END) AND $4->'refund_id'=$3->'payload'->'refund_id' AND (CASE WHEN jsonb_typeof($4->'refund_id') IS DISTINCT FROM 'number' OR ($4->'refund_id'#>>'{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($4->'refund_id'#>>'{}')::numeric BETWEEN 1 AND 2147483647 END)
    AND $4->'refund_no'=$3->'payload'->'refund_no' AND (CASE WHEN jsonb_typeof($4->'payment_order_id') IS DISTINCT FROM 'number' OR ($4->'payment_order_id'#>>'{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($4->'payment_order_id'#>>'{}')::numeric BETWEEN 1 AND 2147483647 END) AND (CASE WHEN jsonb_typeof($4->'uid') IS DISTINCT FROM 'number' OR ($4->'uid'#>>'{}') !~ '^(0|[1-9][0-9]{0,9})$' THEN false ELSE ($4->'uid'#>>'{}')::numeric BETWEEN 0 AND 2147483647 END) AND (CASE WHEN jsonb_typeof($4->'store_id') IS DISTINCT FROM 'number' OR ($4->'store_id'#>>'{}') !~ '^(0|[1-9][0-9]{0,9})$' THEN false ELSE ($4->'store_id'#>>'{}')::numeric BETWEEN 0 AND 2147483647 END) AND (CASE WHEN jsonb_typeof($4->'supplier_id') IS DISTINCT FROM 'number' OR ($4->'supplier_id'#>>'{}') !~ '^(0|[1-9][0-9]{0,9})$' THEN false ELSE ($4->'supplier_id'#>>'{}')::numeric BETWEEN 0 AND 2147483647 END)
    AND $4->'pay_type' IN('"cash"'::jsonb,'"offline"'::jsonb) AND $4->'amount'=$3->'payload'->'refund_price' AND $4->>'amount'<>'0.00'
    AND $4->'cash_returned'='true'::jsonb AND $3->'payload'->'decision'->'cash_returned'='true'::jsonb
    AND jsonb_typeof($4->'manual_proof_hash')='string' AND $4->>'manual_proof_hash' ~ '^[a-f0-9]{64}$' AND $4->'verified'='true'::jsonb
   WHEN $2='provider-admitted' THEN (CASE WHEN pg_catalog.jsonb_typeof($4) IS DISTINCT FROM 'object' THEN false ELSE $4 ?& ARRAY['refund_id','refund_no','payment_order_id','uid','store_id','supplier_id','provider','out_refund_no','request_amount','total_amount','verified']::text[] AND ($4)-ARRAY['refund_id','refund_no','payment_order_id','uid','store_id','supplier_id','provider','out_refund_no','request_amount','total_amount','verified']::text[]='{}'::jsonb END) AND (CASE WHEN pg_catalog.jsonb_typeof($4->'refund_id') IS DISTINCT FROM 'number' THEN false WHEN ($4->'refund_id' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($4->'refund_id' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) AND $4->'refund_id'=$3->'payload'->'refund_id' AND $4->'refund_no'=$3->'payload'->'refund_no'
   AND (CASE WHEN pg_catalog.jsonb_typeof($4->'payment_order_id') IS DISTINCT FROM 'number' THEN false WHEN ($4->'payment_order_id' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($4->'payment_order_id' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) AND (CASE WHEN pg_catalog.jsonb_typeof($4->'uid') IS DISTINCT FROM 'number' THEN false WHEN ($4->'uid' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($4->'uid' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) AND (CASE WHEN pg_catalog.jsonb_typeof($4->'store_id') IS DISTINCT FROM 'number' THEN false WHEN ($4->'store_id' #>> '{}') !~ '^(0|[1-9][0-9]{0,9})$' THEN false ELSE ($4->'store_id' #>> '{}')::numeric BETWEEN 0 AND 2147483647 END) AND (CASE WHEN pg_catalog.jsonb_typeof($4->'supplier_id') IS DISTINCT FROM 'number' THEN false WHEN ($4->'supplier_id' #>> '{}') !~ '^(0|[1-9][0-9]{0,9})$' THEN false ELSE ($4->'supplier_id' #>> '{}')::numeric BETWEEN 0 AND 2147483647 END)
   AND $4->'provider' IN ('"wechat"'::jsonb,'"alipay"'::jsonb)
   AND $4->'out_refund_no'=pg_catalog.to_jsonb('CNSR'||($4->>'refund_id'))
   AND (CASE WHEN pg_catalog.jsonb_typeof($4->'request_amount') IS DISTINCT FROM 'number' THEN false WHEN ($4->'request_amount' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($4->'request_amount' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) AND (CASE WHEN pg_catalog.jsonb_typeof($4->'total_amount') IS DISTINCT FROM 'number' THEN false WHEN ($4->'total_amount' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($4->'total_amount' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END)
   AND (CASE WHEN (CASE WHEN pg_catalog.jsonb_typeof($4->'request_amount') IS DISTINCT FROM 'number' THEN false WHEN ($4->'request_amount' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($4->'request_amount' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) THEN ($4->'request_amount' #>> '{}')::numeric ELSE NULL END)<=(CASE WHEN (CASE WHEN pg_catalog.jsonb_typeof($4->'total_amount') IS DISTINCT FROM 'number' THEN false WHEN ($4->'total_amount' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($4->'total_amount' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) THEN ($4->'total_amount' #>> '{}')::numeric ELSE NULL END)
   AND (CASE WHEN pg_catalog.jsonb_typeof($3->'payload'->'refund_price')='string' AND ($3->'payload'->'refund_price' #>> '{}') ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$' THEN (CASE WHEN (CASE WHEN pg_catalog.jsonb_typeof($4->'request_amount') IS DISTINCT FROM 'number' THEN false WHEN ($4->'request_amount' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($4->'request_amount' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) THEN ($4->'request_amount' #>> '{}')::numeric ELSE NULL END)=(($3->'payload'->>'refund_price')::numeric*100) ELSE false END) AND $4->'verified'='true'::jsonb
   ELSE false END
 WHEN 'refund_remark' THEN $2='refund-remark-saved' AND (CASE WHEN pg_catalog.jsonb_typeof($4) IS DISTINCT FROM 'object' THEN false ELSE $4 ?& ARRAY['refund_id','changed','verified']::text[] AND ($4)-ARRAY['refund_id','changed','verified']::text[]='{}'::jsonb END) AND (CASE WHEN pg_catalog.jsonb_typeof($4->'refund_id') IS DISTINCT FROM 'number' THEN false WHEN ($4->'refund_id' #>> '{}') !~ '^[1-9][0-9]{0,9}$' THEN false ELSE ($4->'refund_id' #>> '{}')::numeric BETWEEN 1 AND 2147483647 END) AND $4->'refund_id'=$3->'payload'->'refund_id' AND (CASE WHEN pg_catalog.jsonb_typeof($4->'changed') IS DISTINCT FROM 'number' THEN false WHEN ($4->'changed' #>> '{}') !~ '^(0|[1-9][0-9]{0,9})$' THEN false ELSE ($4->'changed' #>> '{}')::numeric BETWEEN 0 AND 1 END) AND $4->'verified'='true'::jsonb
 ELSE false END END,false)
$customer_financial_evidence$;
CREATE TABLE public.customer_financial_manual_refund_v1(
 refund_id integer NOT NULL,actor_uid integer NOT NULL,request_key uuid NOT NULL,request_hash varchar(64) NOT NULL,
 service_id integer NOT NULL,order_id integer NOT NULL,payment_order_id integer NOT NULL,buyer_uid integer NOT NULL,
 store_id integer NOT NULL,supplier_id integer NOT NULL,pay_type varchar(8) NOT NULL,amount varchar(20) NOT NULL,
 settlement varchar(4) NOT NULL,cash_returned boolean NOT NULL,intent jsonb NOT NULL,intent_json text NOT NULL,
 source jsonb NOT NULL,source_json text NOT NULL,source_hash varchar(64) NOT NULL,
 proof jsonb NOT NULL,proof_json text NOT NULL,proof_hash varchar(64) NOT NULL,
 transaction_id bigint NOT NULL DEFAULT txid_current(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT cmfr_pk PRIMARY KEY(refund_id),CONSTRAINT cmfr_request_uq UNIQUE(actor_uid,request_key),
 CONSTRAINT cmfr_identity_ck CHECK(refund_id>0 AND actor_uid>0 AND service_id>0 AND order_id>0 AND payment_order_id>0 AND buyer_uid>=0 AND store_id>=0 AND supplier_id>=0),
 CONSTRAINT cmfr_key_ck CHECK(request_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CONSTRAINT cmfr_hash_ck CHECK(request_hash ~ '^[a-f0-9]{64}$' AND source_hash ~ '^[a-f0-9]{64}$' AND proof_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT cmfr_settlement_ck CHECK(pay_type IN('cash','offline') AND amount ~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$'
  AND ((settlement='cash' AND cash_returned AND amount<>'0.00') OR (settlement='zero' AND NOT cash_returned AND amount='0.00'))),
 CONSTRAINT cmfr_intent_ck CHECK((public.customer_financial_intent_valid_v1('refund_execute',intent)
  AND intent->'order_id'=to_jsonb(order_id) AND intent->'payload'->'refund_id'=to_jsonb(refund_id)
  AND intent->'payload'->'refund_price'=to_jsonb(amount)
  AND ((cash_returned AND intent->'payload'->'decision'->'cash_returned'='true'::jsonb)
    OR (NOT cash_returned AND NOT(intent->'payload'->'decision' ? 'cash_returned')))) IS TRUE),
 CONSTRAINT cmfr_bytes_ck CHECK((octet_length(intent_json)<=262144 AND octet_length(source_json)<=16777216 AND octet_length(proof_json)<=16384
  AND intent_json::jsonb->'input'=intent AND intent_json::jsonb->'actor_uid'=to_jsonb(actor_uid)
  AND intent_json::jsonb->>'kind'='refund_execute' AND intent_json::jsonb->>'version'='customer-work-financial-operation-v1'
  AND source_json::jsonb=source AND proof_json::jsonb=proof
  AND request_hash=encode(sha256(convert_to(intent_json,'UTF8')),'hex')
  AND source_hash=encode(sha256(convert_to(source_json,'UTF8')),'hex')
  AND proof_hash=encode(sha256(convert_to(proof_json,'UTF8')),'hex')) IS TRUE),
 CONSTRAINT cmfr_source_ck CHECK((jsonb_typeof(source)='object' AND source->>'version'='customer-manual-refund-source-v1'
  AND jsonb_typeof(source->'carts')='array' AND jsonb_typeof(source->'promotion_rows')='array' AND source->'order'->'id'=to_jsonb(order_id)
  AND source->'order'->'uid'=to_jsonb(buyer_uid) AND source->'payment'->'root_id'=to_jsonb(payment_order_id)
  AND source->'payment'->'pay_type'=to_jsonb(pay_type)) IS TRUE),
 CONSTRAINT cmfr_proof_ck CHECK((jsonb_typeof(proof)='object' AND proof->>'version'='customer-manual-refund-proof-v1'
  AND proof->'refund_id'=to_jsonb(refund_id) AND proof->'actor_uid'=to_jsonb(actor_uid) AND proof->'request_key'=to_jsonb(request_key::text)
  AND proof->'request_hash'=to_jsonb(request_hash) AND proof->'service_id'=to_jsonb(service_id)
  AND proof->'order_id'=to_jsonb(order_id) AND proof->'payment_order_id'=to_jsonb(payment_order_id)
  AND proof->'buyer_uid'=to_jsonb(buyer_uid) AND proof->'store_id'=to_jsonb(store_id) AND proof->'supplier_id'=to_jsonb(supplier_id)
  AND proof->'pay_type'=to_jsonb(pay_type) AND proof->'amount'=to_jsonb(amount) AND proof->'settlement'=to_jsonb(settlement)
  AND proof->'cash_returned'=to_jsonb(cash_returned) AND proof->'source_hash'=to_jsonb(source_hash)) IS TRUE)
);
CREATE INDEX cmfr_actor_history ON public.customer_financial_manual_refund_v1(actor_uid,created_at,request_key);
REVOKE ALL ON public.customer_financial_manual_refund_v1 FROM PUBLIC;
CREATE FUNCTION public.customer_manual_refund_promotion_delete_v1(integer,integer) RETURNS integer
 LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path=pg_catalog,pg_temp
 AS $cmfr_promotion$
DECLARE saved public.customer_financial_manual_refund_v1%ROWTYPE;actual jsonb;deleted integer;
BEGIN
 IF current_user=session_user OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=session_user AND rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls)
 THEN RAISE EXCEPTION 'Manual promotion deletion requires independent ordinary LOGIN';END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(63841,$1);
 PERFORM pg_catalog.pg_advisory_xact_lock(63842,$2);
 SELECT * INTO STRICT saved FROM public.customer_financial_manual_refund_v1 WHERE refund_id=$1 AND order_id=$2;
 IF saved.transaction_id<>pg_catalog.txid_current() OR EXISTS(SELECT 1 FROM public.store_order_refund_split WHERE refund_id=$1)
 OR EXISTS(SELECT 1 FROM public.customer_financial_operation_request WHERE actor_uid=saved.actor_uid AND request_key=saved.request_key)
 OR NOT EXISTS(SELECT 1 FROM public.store_order_refund r JOIN public.store_order o ON o.id=r.store_order_id
 WHERE r.id=$1 AND o.id=$2 AND r.refund_type=6 AND r.refunded_price=r.refund_price AND r.refund_price::text=saved.amount
 AND r.is_cancel=0 AND r.is_del=0 AND o.paid=1 AND o.uid=saved.buyer_uid AND r.uid=o.uid
 AND o.store_id=saved.store_id AND r.store_id=o.store_id AND o.supplier_id=saved.supplier_id AND r.supplier_id=o.supplier_id
 AND o.pay_type=saved.pay_type AND CASE WHEN o.pid>0 THEN o.pid ELSE o.id END=saved.payment_order_id)
 THEN RAISE EXCEPTION 'Manual promotion deletion lacks same transaction physical refund proof';END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'oid',p.oid,'uid',p.uid,'promotions_id',p.promotions_id,'product_id',p.product_id,'promotions_price',p.promotions_price::text,'add_time',p.add_time) ORDER BY p.id),'[]'::jsonb)
 INTO actual FROM public.store_order_promotions p WHERE p.oid=$2;
 IF jsonb_array_length(actual)>200 OR actual IS DISTINCT FROM saved.source->'promotion_rows'
 OR EXISTS(SELECT 1 FROM public.store_order_promotions WHERE oid=$2 AND uid<>saved.buyer_uid)
 THEN RAISE EXCEPTION 'Manual promotion original rows changed';END IF;
 DELETE FROM public.store_order_promotions WHERE oid=$2;
 GET DIAGNOSTICS deleted=ROW_COUNT;RETURN deleted;
END $cmfr_promotion$;
REVOKE ALL ON FUNCTION public.customer_manual_refund_promotion_delete_v1(integer,integer) FROM PUBLIC;

