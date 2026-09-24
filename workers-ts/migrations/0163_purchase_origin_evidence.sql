SET LOCAL search_path=pg_catalog,public,pg_temp;
SET LOCAL row_security=off;
SET LOCAL default_tablespace='';
SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),30000)::text||'ms',true),
  set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true);
DO $purchase_origin_install$
DECLARE initial_state text; final_state text; sources_ready boolean;
BEGIN
  IF current_setting('server_version_num')::integer/10000<>16
    OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off'
    OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Purchase origin installation requires reviewed PG16 read-write READ COMMITTED';
  END IF;
  IF NOT pg_try_advisory_xact_lock(731611,0) THEN RAISE EXCEPTION 'Evidence installation already running'; END IF;
  SELECT state INTO initial_state FROM (WITH catalog AS (
WITH relations AS (
  SELECT c.* FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.store_order_purchase_origin')
), components AS (
  SELECT 'store_order_purchase_origin'::text AS name,r.oid,r.relowner AS owner,
    r.relkind='r' AND r.relpersistence='p' AND NOT r.relispartition AND NOT r.relrowsecurity
    AND NOT r.relforcerowsecurity AND r.relreplident='d' AND r.reloptions IS NULL AND r.reltablespace=0
    AND r.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=r.oid OR inhparent=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=r.oid AND attnum>0 AND attisdropped)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(r.relacl,pg_catalog.acldefault('r',r.relowner))) a
      WHERE a.grantee<>r.relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
      WHERE col.attrelid=r.oid AND a.grantee<>r.relowner)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
      WHERE i.indrelid=r.oid AND (ic.relowner<>r.relowner OR ic.relacl IS NOT NULL OR ic.reltablespace<>0
        OR ic.relkind<>'i' OR ic.relispartition OR i.indisclustered)) AS safe,
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
    ) AS shape,'pg_class'::regclass AS catalog FROM relations r
  UNION ALL
  SELECT p.proname,p.oid,p.proowner,
    p.prokind='f' AND p.pronargs=0 AND p.prorettype='trigger'::regtype AND NOT p.proretset
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner),
    jsonb_build_object('definition',CASE WHEN p.prokind='f' THEN pg_get_functiondef(p.oid) END,
      'support',p.prosupport::text,'binary',p.probin,'argtypes',p.proargtypes::text),'pg_proc'::regclass
  FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
    AND p.proname IN ('capture_purchase_origin_v1','protect_purchase_origin_v1')
)
SELECT name,oid::text AS oid,owner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owned,
  safe AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid=c.catalog AND d.objid=c.oid
    AND d.deptype IN ('e','x')) AS safe,
  encode(sha256(convert_to(shape::text,'UTF8')),'hex') AS fingerprint
FROM components c ORDER BY name COLLATE "C",oid
),
  snapshot AS (SELECT count(*) AS n,jsonb_object_agg(name,to_jsonb(catalog)) AS objects FROM catalog)
SELECT CASE WHEN n=0 AND to_regclass('public.sopo_buyer_history') IS NULL
  AND to_regclass('public.store_order_purchase_origin_pkey') IS NULL THEN 'fresh'
  WHEN n=3 AND (objects->'store_order_purchase_origin') @> '{"owned":true,"safe":true,"fingerprint":"80624f4306e5068e29049378ed60fee74d9be400141683617dd64fc4a35aaa47"}'::jsonb AND (objects->'capture_purchase_origin_v1') @> '{"owned":true,"safe":true,"fingerprint":"20636b669b73811823258b6077253f10a927d26e408b4bdba0a535534a438da5"}'::jsonb AND (objects->'protect_purchase_origin_v1') @> '{"owned":true,"safe":true,"fingerprint":"d47c48808b41485c83f90f1e52f8e33d2358f4de73cf4b0dbe362319c5fe841a"}'::jsonb THEN 'v1'
  WHEN n=1 AND (objects->'store_order_purchase_origin') @>
    '{"owned":true,"safe":true,"fingerprint":"b57659ad3d188f54bc2554a3a6c9265b93d0dca084a2fd6d26367d84b73ef47f"}'::jsonb
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE c.oid=to_regclass('public.store_order_purchase_origin') AND a.grantee<>c.relowner) THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot) s;
  SELECT ready INTO sources_ready FROM (WITH tables AS (
  SELECT name,c.* FROM (VALUES ('store_order'),('store_order_cart_info')) names(name)
  LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public.'||name)
), expected AS (SELECT * FROM (VALUES ('store_order','id','integer',true),
('store_order','uid','integer',true),
('store_order','type','smallint',true),
('store_order','pid','integer',true),
('store_order','paid','smallint',true),
('store_order','status','smallint',true),
('store_order','is_del','smallint',true),
('store_order','is_system_del','smallint',true),
('store_order','supplier_allocation_status','smallint',true),
('store_order','refund_status','smallint',true),
('store_order','refund_type','smallint',true),
('store_order','total_num','integer',true),
('store_order','use_integral','numeric(12,2)',true),
('store_order','cart_id','text',false),
('store_order_cart_info','id','integer',true),
('store_order_cart_info','oid','integer',true),
('store_order_cart_info','uid','integer',true),
('store_order_cart_info','cart_id','character varying(50)',true),
('store_order_cart_info','old_cart_id','character varying(50)',true),
('store_order_cart_info','product_id','integer',true),
('store_order_cart_info','sku_unique','character varying(255)',true),
('store_order_cart_info','cart_num','integer',true),
('store_order_cart_info','refund_num','integer',true),
('store_order_cart_info','split_status','smallint',true),
('store_order_cart_info','split_surplus_num','integer',true),
('store_order_cart_info','surplus_num','integer',true),
('store_order_cart_info','is_writeoff','smallint',true),
('store_order_cart_info','cart_info','text',false)) e(tab,col,typ,nn))
SELECT NOT EXISTS(SELECT 1 FROM tables WHERE oid IS NULL OR relkind<>'r' OR relpersistence<>'p'
    OR relispartition OR relrowsecurity OR relforcerowsecurity
    OR relowner<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))
  AND NOT EXISTS(SELECT 1 FROM tables t JOIN pg_catalog.pg_inherits i ON i.inhrelid=t.oid OR i.inhparent=t.oid)
  AND NOT EXISTS(SELECT 1 FROM tables t JOIN pg_catalog.pg_rewrite r ON r.ev_class=t.oid)
  AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN tables t ON t.name=e.tab
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attname=e.col AND a.attnum>0 AND NOT a.attisdropped
    WHERE a.attnum IS NULL OR pg_catalog.format_type(a.atttypid,a.atttypmod)<>e.typ OR a.attnotnull<>e.nn
      OR a.attgenerated<>'' OR a.attidentity<>'')
  AND NOT EXISTS(SELECT 1 FROM tables t CROSS JOIN (VALUES ('id',true),('lookup',false)) k(col,pk)
    WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
      JOIN pg_catalog.pg_am am ON am.oid=ic.relam JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[0]
      WHERE i.indrelid=t.oid AND a.attname=CASE WHEN k.pk THEN 'id' WHEN t.name='store_order' THEN 'pid' ELSE 'oid' END
        AND i.indisvalid AND i.indisready AND i.indislive AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname='btree'
        AND (NOT k.pk OR (i.indisprimary AND i.indisunique AND i.indnatts=1))
        AND i.indclass[0]=(SELECT oid FROM pg_catalog.pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace
          AND opcname='int4_ops' AND opcmethod=ic.relam))) AS ready) s;
  IF initial_state='drift' OR NOT sources_ready OR (initial_state='orm-pending' AND NOT false) THEN
    RAISE EXCEPTION 'Purchase origin catalog/source drift or unprotected ORM table requires review';
  END IF;
  LOCK TABLE ONLY public.store_order IN SHARE MODE NOWAIT;
  LOCK TABLE ONLY public.store_order_cart_info IN SHARE MODE NOWAIT;
  IF initial_state IN ('v1','orm-pending') THEN LOCK TABLE ONLY public.store_order_purchase_origin IN ACCESS EXCLUSIVE MODE NOWAIT; END IF;
  SELECT state INTO final_state FROM (WITH catalog AS (
WITH relations AS (
  SELECT c.* FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.store_order_purchase_origin')
), components AS (
  SELECT 'store_order_purchase_origin'::text AS name,r.oid,r.relowner AS owner,
    r.relkind='r' AND r.relpersistence='p' AND NOT r.relispartition AND NOT r.relrowsecurity
    AND NOT r.relforcerowsecurity AND r.relreplident='d' AND r.reloptions IS NULL AND r.reltablespace=0
    AND r.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=r.oid OR inhparent=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=r.oid AND attnum>0 AND attisdropped)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(r.relacl,pg_catalog.acldefault('r',r.relowner))) a
      WHERE a.grantee<>r.relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
      WHERE col.attrelid=r.oid AND a.grantee<>r.relowner)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
      WHERE i.indrelid=r.oid AND (ic.relowner<>r.relowner OR ic.relacl IS NOT NULL OR ic.reltablespace<>0
        OR ic.relkind<>'i' OR ic.relispartition OR i.indisclustered)) AS safe,
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
    ) AS shape,'pg_class'::regclass AS catalog FROM relations r
  UNION ALL
  SELECT p.proname,p.oid,p.proowner,
    p.prokind='f' AND p.pronargs=0 AND p.prorettype='trigger'::regtype AND NOT p.proretset
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner),
    jsonb_build_object('definition',CASE WHEN p.prokind='f' THEN pg_get_functiondef(p.oid) END,
      'support',p.prosupport::text,'binary',p.probin,'argtypes',p.proargtypes::text),'pg_proc'::regclass
  FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
    AND p.proname IN ('capture_purchase_origin_v1','protect_purchase_origin_v1')
)
SELECT name,oid::text AS oid,owner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owned,
  safe AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid=c.catalog AND d.objid=c.oid
    AND d.deptype IN ('e','x')) AS safe,
  encode(sha256(convert_to(shape::text,'UTF8')),'hex') AS fingerprint
FROM components c ORDER BY name COLLATE "C",oid
),
  snapshot AS (SELECT count(*) AS n,jsonb_object_agg(name,to_jsonb(catalog)) AS objects FROM catalog)
SELECT CASE WHEN n=0 AND to_regclass('public.sopo_buyer_history') IS NULL
  AND to_regclass('public.store_order_purchase_origin_pkey') IS NULL THEN 'fresh'
  WHEN n=3 AND (objects->'store_order_purchase_origin') @> '{"owned":true,"safe":true,"fingerprint":"80624f4306e5068e29049378ed60fee74d9be400141683617dd64fc4a35aaa47"}'::jsonb AND (objects->'capture_purchase_origin_v1') @> '{"owned":true,"safe":true,"fingerprint":"20636b669b73811823258b6077253f10a927d26e408b4bdba0a535534a438da5"}'::jsonb AND (objects->'protect_purchase_origin_v1') @> '{"owned":true,"safe":true,"fingerprint":"d47c48808b41485c83f90f1e52f8e33d2358f4de73cf4b0dbe362319c5fe841a"}'::jsonb THEN 'v1'
  WHEN n=1 AND (objects->'store_order_purchase_origin') @>
    '{"owned":true,"safe":true,"fingerprint":"b57659ad3d188f54bc2554a3a6c9265b93d0dca084a2fd6d26367d84b73ef47f"}'::jsonb
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE c.oid=to_regclass('public.store_order_purchase_origin') AND a.grantee<>c.relowner) THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot) s;
  SELECT ready INTO sources_ready FROM (WITH tables AS (
  SELECT name,c.* FROM (VALUES ('store_order'),('store_order_cart_info')) names(name)
  LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public.'||name)
), expected AS (SELECT * FROM (VALUES ('store_order','id','integer',true),
('store_order','uid','integer',true),
('store_order','type','smallint',true),
('store_order','pid','integer',true),
('store_order','paid','smallint',true),
('store_order','status','smallint',true),
('store_order','is_del','smallint',true),
('store_order','is_system_del','smallint',true),
('store_order','supplier_allocation_status','smallint',true),
('store_order','refund_status','smallint',true),
('store_order','refund_type','smallint',true),
('store_order','total_num','integer',true),
('store_order','use_integral','numeric(12,2)',true),
('store_order','cart_id','text',false),
('store_order_cart_info','id','integer',true),
('store_order_cart_info','oid','integer',true),
('store_order_cart_info','uid','integer',true),
('store_order_cart_info','cart_id','character varying(50)',true),
('store_order_cart_info','old_cart_id','character varying(50)',true),
('store_order_cart_info','product_id','integer',true),
('store_order_cart_info','sku_unique','character varying(255)',true),
('store_order_cart_info','cart_num','integer',true),
('store_order_cart_info','refund_num','integer',true),
('store_order_cart_info','split_status','smallint',true),
('store_order_cart_info','split_surplus_num','integer',true),
('store_order_cart_info','surplus_num','integer',true),
('store_order_cart_info','is_writeoff','smallint',true),
('store_order_cart_info','cart_info','text',false)) e(tab,col,typ,nn))
SELECT NOT EXISTS(SELECT 1 FROM tables WHERE oid IS NULL OR relkind<>'r' OR relpersistence<>'p'
    OR relispartition OR relrowsecurity OR relforcerowsecurity
    OR relowner<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))
  AND NOT EXISTS(SELECT 1 FROM tables t JOIN pg_catalog.pg_inherits i ON i.inhrelid=t.oid OR i.inhparent=t.oid)
  AND NOT EXISTS(SELECT 1 FROM tables t JOIN pg_catalog.pg_rewrite r ON r.ev_class=t.oid)
  AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN tables t ON t.name=e.tab
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attname=e.col AND a.attnum>0 AND NOT a.attisdropped
    WHERE a.attnum IS NULL OR pg_catalog.format_type(a.atttypid,a.atttypmod)<>e.typ OR a.attnotnull<>e.nn
      OR a.attgenerated<>'' OR a.attidentity<>'')
  AND NOT EXISTS(SELECT 1 FROM tables t CROSS JOIN (VALUES ('id',true),('lookup',false)) k(col,pk)
    WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
      JOIN pg_catalog.pg_am am ON am.oid=ic.relam JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[0]
      WHERE i.indrelid=t.oid AND a.attname=CASE WHEN k.pk THEN 'id' WHEN t.name='store_order' THEN 'pid' ELSE 'oid' END
        AND i.indisvalid AND i.indisready AND i.indislive AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname='btree'
        AND (NOT k.pk OR (i.indisprimary AND i.indisunique AND i.indnatts=1))
        AND i.indclass[0]=(SELECT oid FROM pg_catalog.pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace
          AND opcname='int4_ops' AND opcmethod=ic.relam))) AS ready) s;
  IF final_state IS DISTINCT FROM initial_state OR NOT sources_ready THEN RAISE EXCEPTION 'Purchase origin catalog changed during locking'; END IF;
  IF initial_state='orm-pending' THEN
    IF EXISTS(SELECT 1 FROM public.store_order_purchase_origin) THEN
      RAISE EXCEPTION 'Unprotected ORM purchase origin table must be empty; no history repair is allowed';
    END IF;
CREATE FUNCTION public.capture_purchase_origin_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  parent record; item record; info jsonb; items jsonb := '[]'::jsonb;
  carts text[] := ARRAY[]::text[]; claimed text[];
  quantity bigint := 0; points bigint := 0; bytes bigint := 0;
BEGIN
  IF TG_OP <> 'INSERT' OR TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'store_order_purchase_origin'
    OR NEW.version IS NOT NULL OR NEW.order_type IS NOT NULL OR NEW.total_num IS NOT NULL
    OR NEW.used_points IS NOT NULL OR NEW.lines IS NOT NULL OR NEW.recorded_at IS NOT NULL THEN
    RAISE EXCEPTION 'Purchase origin accepts only order and buyer identity' USING ERRCODE='23514';
  END IF;
  SELECT id, uid, type, pid, paid, status, is_del, is_system_del, supplier_allocation_status,
    refund_status, refund_type, total_num, use_integral, cart_id INTO parent
  FROM public.store_order WHERE id=NEW.order_id FOR UPDATE;
  IF NOT FOUND OR parent.uid IS DISTINCT FROM NEW.buyer_id OR parent.pid <> 0 OR parent.paid <> 0
    OR parent.status <> 0 OR parent.is_del <> 0 OR parent.is_system_del <> 0
    OR parent.supplier_allocation_status NOT IN (0,1) OR parent.refund_status <> 0 OR parent.refund_type <> 0
    OR parent.use_integral < 0 OR parent.use_integral <> trunc(parent.use_integral)
    OR EXISTS(SELECT 1 FROM public.store_order WHERE pid=parent.id) THEN
    RAISE EXCEPTION 'Purchase origin requires an unsplit active unpaid root' USING ERRCODE='23514';
  END IF;
  IF parent.cart_id IS NULL OR length(parent.cart_id) > 2199 OR parent.cart_id !~ '^[1-9][0-9]{0,9}(,[1-9][0-9]{0,9}){0,199}$' THEN
    RAISE EXCEPTION 'Purchase origin cart identities invalid' USING ERRCODE='23514';
  END IF;
  claimed := string_to_array(parent.cart_id, ',');
  FOR item IN SELECT id, oid, uid, cart_id, old_cart_id, product_id, sku_unique, cart_num,
    refund_num, split_status, split_surplus_num, surplus_num, is_writeoff,
    CASE WHEN octet_length(cart_info) <= 65536 THEN cart_info ELSE NULL END AS snapshot
    FROM public.store_order_cart_info WHERE oid=parent.id ORDER BY id LIMIT 201 FOR UPDATE
  LOOP
    IF cardinality(carts) >= 200 OR item.uid IS DISTINCT FROM parent.uid OR item.product_id <= 0
      OR item.cart_id !~ '^[1-9][0-9]{0,9}$' OR item.cart_id::bigint > 2147483647
      OR item.cart_id=ANY(carts) OR NOT item.cart_id=ANY(claimed) OR item.old_cart_id <> ''
      OR item.cart_num NOT BETWEEN 1 AND 32767 OR item.refund_num <> 0 OR item.split_status <> 0
      OR item.split_surplus_num <> item.cart_num OR item.surplus_num <> item.cart_num OR item.is_writeoff <> 0
      OR item.snapshot IS NULL THEN
      RAISE EXCEPTION 'Purchase origin line ownership or quantity invalid' USING ERRCODE='23514';
    END IF;
    bytes := bytes + octet_length(item.snapshot);
    IF bytes > 8388608 THEN RAISE EXCEPTION 'Purchase origin snapshots too large' USING ERRCODE='23514'; END IF;
    info := item.snapshot::jsonb;
    IF jsonb_typeof(info) IS DISTINCT FROM 'object'
      OR info->>'financial_version' IS DISTINCT FROM 'checkout-line-finance-v1'
      OR info->'id' IS DISTINCT FROM to_jsonb(item.cart_id)
      OR info->'cart_num' IS DISTINCT FROM to_jsonb(item.cart_num)
      OR info#>'{product,id}' IS DISTINCT FROM to_jsonb(item.product_id)
      OR info ? 'refund_order_generation'
      OR jsonb_typeof(info#>'{sku,id}') IS DISTINCT FROM 'number'
      OR COALESCE(info#>>'{sku,id}', '') !~ '^[1-9][0-9]{0,9}$'
      OR COALESCE(info#>>'{sku,id}', '0')::numeric > 2147483647
      OR NOT (info#>'{sku,unique}' IS NOT DISTINCT FROM to_jsonb(item.sku_unique)
        OR (parent.type IN (1,2,3) AND info#>'{activitySku,unique}' IS NOT DISTINCT FROM to_jsonb(item.sku_unique)))
      OR jsonb_typeof(info->'use_integral') IS DISTINCT FROM 'string'
      OR COALESCE(info->>'use_integral','') !~ '^(0|[1-9][0-9]{0,9})$' THEN
      RAISE EXCEPTION 'Purchase origin requires coherent modern checkout evidence' USING ERRCODE='23514';
    END IF;
    carts := array_append(carts,item.cart_id);
    quantity := quantity + item.cart_num; points := points + (info->>'use_integral')::bigint;
    items := items || jsonb_build_array(jsonb_build_object('rowId',item.id,'cartId',item.cart_id,
      'productId',item.product_id,'skuId',(info#>>'{sku,id}')::integer,'skuUnique',item.sku_unique,
      'quantity',item.cart_num,'usedPoints',(info->>'use_integral')::bigint));
  END LOOP;
  IF cardinality(carts)=0 OR cardinality(carts)<>cardinality(claimed)
    OR quantity<>parent.total_num OR points<>parent.use_integral THEN
    RAISE EXCEPTION 'Purchase origin totals do not match checkout' USING ERRCODE='23514';
  END IF;
  NEW.version := 'purchase-origin-v1'; NEW.order_type := parent.type;
  NEW.total_num := quantity; NEW.used_points := points; NEW.lines := items; NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE FUNCTION public.protect_purchase_origin_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Purchase origin evidence is append-only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER sopo_capture BEFORE INSERT ON public.store_order_purchase_origin
  FOR EACH ROW EXECUTE FUNCTION public.capture_purchase_origin_v1();
CREATE TRIGGER sopo_no_rewrite BEFORE UPDATE OR DELETE ON public.store_order_purchase_origin
  FOR EACH ROW EXECUTE FUNCTION public.protect_purchase_origin_v1();
CREATE TRIGGER sopo_no_truncate BEFORE TRUNCATE ON public.store_order_purchase_origin
  FOR EACH STATEMENT EXECUTE FUNCTION public.protect_purchase_origin_v1();
REVOKE ALL ON FUNCTION public.capture_purchase_origin_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_purchase_origin_v1() FROM PUBLIC;

  ELSIF initial_state='fresh' THEN
-- Raw definition reference, not a standalone installer; use the guarded 0163 protocol.
-- Install in a caller-owned maintenance transaction on reviewed PostgreSQL 16.
-- Runtime gets SELECT,INSERT on this table only; triggers are SECURITY INVOKER.
-- No historical backfill or cancellation/quota release is performed here.
CREATE TABLE public.store_order_purchase_origin (
  order_id integer PRIMARY KEY CHECK (order_id > 0),
  buyer_id integer NOT NULL CHECK (buyer_id >= 0),
  version text NOT NULL CHECK (version = 'purchase-origin-v1'),
  order_type smallint NOT NULL CHECK (order_type BETWEEN 0 AND 8),
  total_num integer NOT NULL CHECK (total_num > 0),
  used_points bigint NOT NULL CHECK (used_points >= 0),
  lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'
    AND jsonb_array_length(lines) BETWEEN 1 AND 200 AND octet_length(lines::text) <= 131072),
  recorded_at timestamptz NOT NULL
);
CREATE INDEX sopo_buyer_history ON public.store_order_purchase_origin(buyer_id, order_id);
REVOKE ALL ON public.store_order_purchase_origin FROM PUBLIC;

CREATE FUNCTION public.capture_purchase_origin_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  parent record; item record; info jsonb; items jsonb := '[]'::jsonb;
  carts text[] := ARRAY[]::text[]; claimed text[];
  quantity bigint := 0; points bigint := 0; bytes bigint := 0;
BEGIN
  IF TG_OP <> 'INSERT' OR TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'store_order_purchase_origin'
    OR NEW.version IS NOT NULL OR NEW.order_type IS NOT NULL OR NEW.total_num IS NOT NULL
    OR NEW.used_points IS NOT NULL OR NEW.lines IS NOT NULL OR NEW.recorded_at IS NOT NULL THEN
    RAISE EXCEPTION 'Purchase origin accepts only order and buyer identity' USING ERRCODE='23514';
  END IF;
  SELECT id, uid, type, pid, paid, status, is_del, is_system_del, supplier_allocation_status,
    refund_status, refund_type, total_num, use_integral, cart_id INTO parent
  FROM public.store_order WHERE id=NEW.order_id FOR UPDATE;
  IF NOT FOUND OR parent.uid IS DISTINCT FROM NEW.buyer_id OR parent.pid <> 0 OR parent.paid <> 0
    OR parent.status <> 0 OR parent.is_del <> 0 OR parent.is_system_del <> 0
    OR parent.supplier_allocation_status NOT IN (0,1) OR parent.refund_status <> 0 OR parent.refund_type <> 0
    OR parent.use_integral < 0 OR parent.use_integral <> trunc(parent.use_integral)
    OR EXISTS(SELECT 1 FROM public.store_order WHERE pid=parent.id) THEN
    RAISE EXCEPTION 'Purchase origin requires an unsplit active unpaid root' USING ERRCODE='23514';
  END IF;
  IF parent.cart_id IS NULL OR length(parent.cart_id) > 2199 OR parent.cart_id !~ '^[1-9][0-9]{0,9}(,[1-9][0-9]{0,9}){0,199}$' THEN
    RAISE EXCEPTION 'Purchase origin cart identities invalid' USING ERRCODE='23514';
  END IF;
  claimed := string_to_array(parent.cart_id, ',');
  FOR item IN SELECT id, oid, uid, cart_id, old_cart_id, product_id, sku_unique, cart_num,
    refund_num, split_status, split_surplus_num, surplus_num, is_writeoff,
    CASE WHEN octet_length(cart_info) <= 65536 THEN cart_info ELSE NULL END AS snapshot
    FROM public.store_order_cart_info WHERE oid=parent.id ORDER BY id LIMIT 201 FOR UPDATE
  LOOP
    IF cardinality(carts) >= 200 OR item.uid IS DISTINCT FROM parent.uid OR item.product_id <= 0
      OR item.cart_id !~ '^[1-9][0-9]{0,9}$' OR item.cart_id::bigint > 2147483647
      OR item.cart_id=ANY(carts) OR NOT item.cart_id=ANY(claimed) OR item.old_cart_id <> ''
      OR item.cart_num NOT BETWEEN 1 AND 32767 OR item.refund_num <> 0 OR item.split_status <> 0
      OR item.split_surplus_num <> item.cart_num OR item.surplus_num <> item.cart_num OR item.is_writeoff <> 0
      OR item.snapshot IS NULL THEN
      RAISE EXCEPTION 'Purchase origin line ownership or quantity invalid' USING ERRCODE='23514';
    END IF;
    bytes := bytes + octet_length(item.snapshot);
    IF bytes > 8388608 THEN RAISE EXCEPTION 'Purchase origin snapshots too large' USING ERRCODE='23514'; END IF;
    info := item.snapshot::jsonb;
    IF jsonb_typeof(info) IS DISTINCT FROM 'object'
      OR info->>'financial_version' IS DISTINCT FROM 'checkout-line-finance-v1'
      OR info->'id' IS DISTINCT FROM to_jsonb(item.cart_id)
      OR info->'cart_num' IS DISTINCT FROM to_jsonb(item.cart_num)
      OR info#>'{product,id}' IS DISTINCT FROM to_jsonb(item.product_id)
      OR info ? 'refund_order_generation'
      OR jsonb_typeof(info#>'{sku,id}') IS DISTINCT FROM 'number'
      OR COALESCE(info#>>'{sku,id}', '') !~ '^[1-9][0-9]{0,9}$'
      OR COALESCE(info#>>'{sku,id}', '0')::numeric > 2147483647
      OR NOT (info#>'{sku,unique}' IS NOT DISTINCT FROM to_jsonb(item.sku_unique)
        OR (parent.type IN (1,2,3) AND info#>'{activitySku,unique}' IS NOT DISTINCT FROM to_jsonb(item.sku_unique)))
      OR jsonb_typeof(info->'use_integral') IS DISTINCT FROM 'string'
      OR COALESCE(info->>'use_integral','') !~ '^(0|[1-9][0-9]{0,9})$' THEN
      RAISE EXCEPTION 'Purchase origin requires coherent modern checkout evidence' USING ERRCODE='23514';
    END IF;
    carts := array_append(carts,item.cart_id);
    quantity := quantity + item.cart_num; points := points + (info->>'use_integral')::bigint;
    items := items || jsonb_build_array(jsonb_build_object('rowId',item.id,'cartId',item.cart_id,
      'productId',item.product_id,'skuId',(info#>>'{sku,id}')::integer,'skuUnique',item.sku_unique,
      'quantity',item.cart_num,'usedPoints',(info->>'use_integral')::bigint));
  END LOOP;
  IF cardinality(carts)=0 OR cardinality(carts)<>cardinality(claimed)
    OR quantity<>parent.total_num OR points<>parent.use_integral THEN
    RAISE EXCEPTION 'Purchase origin totals do not match checkout' USING ERRCODE='23514';
  END IF;
  NEW.version := 'purchase-origin-v1'; NEW.order_type := parent.type;
  NEW.total_num := quantity; NEW.used_points := points; NEW.lines := items; NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE FUNCTION public.protect_purchase_origin_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Purchase origin evidence is append-only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER sopo_capture BEFORE INSERT ON public.store_order_purchase_origin
  FOR EACH ROW EXECUTE FUNCTION public.capture_purchase_origin_v1();
CREATE TRIGGER sopo_no_rewrite BEFORE UPDATE OR DELETE ON public.store_order_purchase_origin
  FOR EACH ROW EXECUTE FUNCTION public.protect_purchase_origin_v1();
CREATE TRIGGER sopo_no_truncate BEFORE TRUNCATE ON public.store_order_purchase_origin
  FOR EACH STATEMENT EXECUTE FUNCTION public.protect_purchase_origin_v1();
REVOKE ALL ON FUNCTION public.capture_purchase_origin_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_purchase_origin_v1() FROM PUBLIC;

  END IF;
  SELECT state INTO final_state FROM (WITH catalog AS (
WITH relations AS (
  SELECT c.* FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.store_order_purchase_origin')
), components AS (
  SELECT 'store_order_purchase_origin'::text AS name,r.oid,r.relowner AS owner,
    r.relkind='r' AND r.relpersistence='p' AND NOT r.relispartition AND NOT r.relrowsecurity
    AND NOT r.relforcerowsecurity AND r.relreplident='d' AND r.reloptions IS NULL AND r.reltablespace=0
    AND r.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=r.oid OR inhparent=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=r.oid AND attnum>0 AND attisdropped)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(r.relacl,pg_catalog.acldefault('r',r.relowner))) a
      WHERE a.grantee<>r.relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
      WHERE col.attrelid=r.oid AND a.grantee<>r.relowner)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
      WHERE i.indrelid=r.oid AND (ic.relowner<>r.relowner OR ic.relacl IS NOT NULL OR ic.reltablespace<>0
        OR ic.relkind<>'i' OR ic.relispartition OR i.indisclustered)) AS safe,
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
    ) AS shape,'pg_class'::regclass AS catalog FROM relations r
  UNION ALL
  SELECT p.proname,p.oid,p.proowner,
    p.prokind='f' AND p.pronargs=0 AND p.prorettype='trigger'::regtype AND NOT p.proretset
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner),
    jsonb_build_object('definition',CASE WHEN p.prokind='f' THEN pg_get_functiondef(p.oid) END,
      'support',p.prosupport::text,'binary',p.probin,'argtypes',p.proargtypes::text),'pg_proc'::regclass
  FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
    AND p.proname IN ('capture_purchase_origin_v1','protect_purchase_origin_v1')
)
SELECT name,oid::text AS oid,owner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owned,
  safe AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid=c.catalog AND d.objid=c.oid
    AND d.deptype IN ('e','x')) AS safe,
  encode(sha256(convert_to(shape::text,'UTF8')),'hex') AS fingerprint
FROM components c ORDER BY name COLLATE "C",oid
),
  snapshot AS (SELECT count(*) AS n,jsonb_object_agg(name,to_jsonb(catalog)) AS objects FROM catalog)
SELECT CASE WHEN n=0 AND to_regclass('public.sopo_buyer_history') IS NULL
  AND to_regclass('public.store_order_purchase_origin_pkey') IS NULL THEN 'fresh'
  WHEN n=3 AND (objects->'store_order_purchase_origin') @> '{"owned":true,"safe":true,"fingerprint":"80624f4306e5068e29049378ed60fee74d9be400141683617dd64fc4a35aaa47"}'::jsonb AND (objects->'capture_purchase_origin_v1') @> '{"owned":true,"safe":true,"fingerprint":"20636b669b73811823258b6077253f10a927d26e408b4bdba0a535534a438da5"}'::jsonb AND (objects->'protect_purchase_origin_v1') @> '{"owned":true,"safe":true,"fingerprint":"d47c48808b41485c83f90f1e52f8e33d2358f4de73cf4b0dbe362319c5fe841a"}'::jsonb THEN 'v1'
  WHEN n=1 AND (objects->'store_order_purchase_origin') @>
    '{"owned":true,"safe":true,"fingerprint":"b57659ad3d188f54bc2554a3a6c9265b93d0dca084a2fd6d26367d84b73ef47f"}'::jsonb
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE c.oid=to_regclass('public.store_order_purchase_origin') AND a.grantee<>c.relowner) THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot) s;
  SELECT ready INTO sources_ready FROM (WITH tables AS (
  SELECT name,c.* FROM (VALUES ('store_order'),('store_order_cart_info')) names(name)
  LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public.'||name)
), expected AS (SELECT * FROM (VALUES ('store_order','id','integer',true),
('store_order','uid','integer',true),
('store_order','type','smallint',true),
('store_order','pid','integer',true),
('store_order','paid','smallint',true),
('store_order','status','smallint',true),
('store_order','is_del','smallint',true),
('store_order','is_system_del','smallint',true),
('store_order','supplier_allocation_status','smallint',true),
('store_order','refund_status','smallint',true),
('store_order','refund_type','smallint',true),
('store_order','total_num','integer',true),
('store_order','use_integral','numeric(12,2)',true),
('store_order','cart_id','text',false),
('store_order_cart_info','id','integer',true),
('store_order_cart_info','oid','integer',true),
('store_order_cart_info','uid','integer',true),
('store_order_cart_info','cart_id','character varying(50)',true),
('store_order_cart_info','old_cart_id','character varying(50)',true),
('store_order_cart_info','product_id','integer',true),
('store_order_cart_info','sku_unique','character varying(255)',true),
('store_order_cart_info','cart_num','integer',true),
('store_order_cart_info','refund_num','integer',true),
('store_order_cart_info','split_status','smallint',true),
('store_order_cart_info','split_surplus_num','integer',true),
('store_order_cart_info','surplus_num','integer',true),
('store_order_cart_info','is_writeoff','smallint',true),
('store_order_cart_info','cart_info','text',false)) e(tab,col,typ,nn))
SELECT NOT EXISTS(SELECT 1 FROM tables WHERE oid IS NULL OR relkind<>'r' OR relpersistence<>'p'
    OR relispartition OR relrowsecurity OR relforcerowsecurity
    OR relowner<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))
  AND NOT EXISTS(SELECT 1 FROM tables t JOIN pg_catalog.pg_inherits i ON i.inhrelid=t.oid OR i.inhparent=t.oid)
  AND NOT EXISTS(SELECT 1 FROM tables t JOIN pg_catalog.pg_rewrite r ON r.ev_class=t.oid)
  AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN tables t ON t.name=e.tab
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attname=e.col AND a.attnum>0 AND NOT a.attisdropped
    WHERE a.attnum IS NULL OR pg_catalog.format_type(a.atttypid,a.atttypmod)<>e.typ OR a.attnotnull<>e.nn
      OR a.attgenerated<>'' OR a.attidentity<>'')
  AND NOT EXISTS(SELECT 1 FROM tables t CROSS JOIN (VALUES ('id',true),('lookup',false)) k(col,pk)
    WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
      JOIN pg_catalog.pg_am am ON am.oid=ic.relam JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[0]
      WHERE i.indrelid=t.oid AND a.attname=CASE WHEN k.pk THEN 'id' WHEN t.name='store_order' THEN 'pid' ELSE 'oid' END
        AND i.indisvalid AND i.indisready AND i.indislive AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname='btree'
        AND (NOT k.pk OR (i.indisprimary AND i.indisunique AND i.indnatts=1))
        AND i.indclass[0]=(SELECT oid FROM pg_catalog.pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace
          AND opcname='int4_ops' AND opcmethod=ic.relam))) AS ready) s;
  IF final_state IS DISTINCT FROM 'v1' OR NOT sources_ready OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Purchase origin verification failed after installation';
  END IF;
END
$purchase_origin_install$;
