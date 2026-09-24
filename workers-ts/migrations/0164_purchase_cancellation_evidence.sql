SET LOCAL search_path=pg_catalog,public,pg_temp;
SET LOCAL row_security=off;
SET LOCAL default_tablespace='';
SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),30000)::text||'ms',true),
  set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true);
DO $purchase_cancellation_install$
DECLARE initial_state text; final_state text; sources_ready boolean;
BEGIN
  IF current_setting('server_version_num')::integer/10000<>16
    OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off'
    OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Purchase cancellation installation requires reviewed PG16 read-write READ COMMITTED';
  END IF;
  IF NOT pg_try_advisory_xact_lock(731611,0) THEN RAISE EXCEPTION 'Evidence installation already running'; END IF;
  SELECT state INTO initial_state FROM (WITH catalog AS (
WITH relations AS (
  SELECT c.* FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.store_order_purchase_cancellation')
), components AS (
  SELECT 'store_order_purchase_cancellation'::text AS name,r.oid,r.relowner AS owner,
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
      WHERE a.grantee<>p.proowner)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgfoid=p.oid AND NOT (
      (p.proname='begin_purchase_cancellation_v1' AND t.tgname='sopc_order_transition' AND t.tgrelid=to_regclass('public.store_order'))
      OR (p.proname='capture_purchase_cancellation_v1' AND t.tgname='sopc_capture' AND t.tgrelid=to_regclass('public.store_order_purchase_cancellation'))
      OR (p.proname='validate_purchase_cancellation_v1' AND t.tgname='sopc_validate' AND t.tgrelid=to_regclass('public.store_order_purchase_cancellation'))
      OR (p.proname='protect_purchase_cancellation_v1' AND t.tgname IN ('sopc_no_rewrite','sopc_no_truncate') AND t.tgrelid=to_regclass('public.store_order_purchase_cancellation')))),
    jsonb_build_object('definition',CASE WHEN p.prokind='f' THEN pg_get_functiondef(p.oid) END,
      'support',p.prosupport::text,'binary',p.probin,'argtypes',p.proargtypes::text),'pg_proc'::regclass
  FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
    AND p.proname IN ('begin_purchase_cancellation_v1','capture_purchase_cancellation_v1','validate_purchase_cancellation_v1','protect_purchase_cancellation_v1')
  UNION ALL
  SELECT 'sopc_order_transition',t.oid,c.relowner,NOT t.tgisinternal,
    jsonb_build_object('definition',pg_get_triggerdef(t.oid,false),'enabled',t.tgenabled::text,
      'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,'parent',t.tgparentid::text),'pg_trigger'::regclass
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    WHERE t.tgrelid=to_regclass('public.store_order') AND t.tgname='sopc_order_transition'
)
SELECT name,oid::text AS oid,owner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owned,
  safe AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid=c.catalog AND d.objid=c.oid
    AND d.deptype IN ('e','x')) AS safe,
  encode(sha256(convert_to(shape::text,'UTF8')),'hex') AS fingerprint
FROM components c ORDER BY name COLLATE "C",oid
),
  snapshot AS (SELECT count(*) AS n,jsonb_object_agg(name,to_jsonb(catalog)) AS objects FROM catalog)
SELECT CASE WHEN n=0 AND to_regclass('public.sopc_buyer_history') IS NULL
  AND to_regclass('public.store_order_purchase_cancellation_pkey') IS NULL THEN 'fresh'
  WHEN n=6 AND (objects->'store_order_purchase_cancellation') @> '{"owned":true,"safe":true,"fingerprint":"bd28aae90f21d33e47870f977d5de0d8be8ecf85c35dfe26eccdab9aa47f4729"}'::jsonb AND (objects->'begin_purchase_cancellation_v1') @> '{"owned":true,"safe":true,"fingerprint":"f8fa73642f10e09097b498fcd8719de20cb5a902783d95d757dab11e02918c19"}'::jsonb AND (objects->'capture_purchase_cancellation_v1') @> '{"owned":true,"safe":true,"fingerprint":"5212ccba912454c3cdcd3d53b0e8b6d1ee1272d0df10e01fec534815069c71e2"}'::jsonb AND (objects->'validate_purchase_cancellation_v1') @> '{"owned":true,"safe":true,"fingerprint":"62e5541fde33a9c6666dc7e382b6b4355777d7c39a82d172afc9288f5879edfc"}'::jsonb AND (objects->'protect_purchase_cancellation_v1') @> '{"owned":true,"safe":true,"fingerprint":"2666faef1c503cc067a096b147f3070874c2b885ab14a20422bbdb2a430277ec"}'::jsonb AND (objects->'sopc_order_transition') @> '{"owned":true,"safe":true,"fingerprint":"aba99ae49b039104eeb7c079426302ffc5bd25fd8baf1797a7eb65ae1723ce15"}'::jsonb THEN 'v1'
  WHEN n=1 AND (objects->'store_order_purchase_cancellation') @>
    '{"owned":true,"safe":true,"fingerprint":"fa732b88148e7dc49e486a235fa5875b47696317b84b78e6d416a3ba99ec547d"}'::jsonb
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL
      pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE c.oid=to_regclass('public.store_order_purchase_cancellation') AND a.grantee<>c.relowner) THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot) s;
  SELECT ready INTO sources_ready FROM (WITH origin AS (WITH catalog AS (
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
  ELSE 'drift' END AS state FROM snapshot),
  original_sources AS (WITH tables AS (
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
          AND opcname='int4_ops' AND opcmethod=ic.relam))) AS ready), tables AS (
    SELECT name,c.* FROM (VALUES ('store_order_status'),('user_bill')) names(name)
      LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public.'||name)
  ), expected AS (SELECT * FROM (VALUES ('store_order_status','id','integer'),
('store_order_status','oid','integer'),
('store_order_status','change_type','character varying(32)'),
('user_bill','id','integer'),
('user_bill','uid','integer'),
('user_bill','link_id','character varying(32)'),
('user_bill','category','character varying(64)'),
('user_bill','type','character varying(64)'),
('user_bill','event_key','character varying(64)'),
('user_bill','pm','smallint'),
('user_bill','number','numeric(12,2)'),
('user_bill','status','smallint')) e(tab,col,typ))
SELECT (SELECT state='v1' FROM origin) AND (SELECT ready FROM original_sources)
  AND NOT EXISTS(SELECT 1 FROM tables WHERE oid IS NULL OR relkind<>'r' OR relpersistence<>'p'
    OR relispartition OR relrowsecurity OR relforcerowsecurity
    OR relowner<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))
  AND NOT EXISTS(SELECT 1 FROM tables t JOIN pg_catalog.pg_inherits i ON i.inhrelid=t.oid OR i.inhparent=t.oid)
  AND NOT EXISTS(SELECT 1 FROM tables t JOIN pg_catalog.pg_rewrite r ON r.ev_class=t.oid)
  AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN tables t ON t.name=e.tab
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attname=e.col AND a.attnum>0 AND NOT a.attisdropped
    WHERE a.attnum IS NULL OR pg_catalog.format_type(a.atttypid,a.atttypmod)<>e.typ OR NOT a.attnotnull
      OR a.attgenerated<>'' OR a.attidentity<>'')
  AND NOT EXISTS(SELECT 1 FROM tables t WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=ic.relam
    JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[0]
    WHERE i.indrelid=t.oid AND a.attname='id' AND i.indisprimary AND i.indisunique AND i.indnatts=1
      AND i.indisvalid AND i.indisready AND i.indislive AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname='btree'
      AND i.indclass[0]=(SELECT oid FROM pg_catalog.pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace
        AND opcname='int4_ops' AND opcmethod=ic.relam)))
  AND NOT EXISTS(SELECT 1 FROM tables t WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=ic.relam
    WHERE i.indrelid=t.oid AND i.indisvalid AND i.indisready AND i.indislive
      AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname='btree'
      AND i.indnkeyatts>=CASE WHEN t.name='user_bill' THEN 3 ELSE 1 END
      AND NOT EXISTS(SELECT 1 FROM generate_series(0,CASE WHEN t.name='user_bill' THEN 2 ELSE 0 END) k(pos)
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[k.pos]
        WHERE a.attname IS DISTINCT FROM CASE WHEN t.name='store_order_status' THEN 'oid'
          WHEN k.pos=0 THEN 'category' WHEN k.pos=1 THEN 'type' ELSE 'link_id' END
          OR i.indcollation[k.pos]<>a.attcollation
          OR i.indclass[k.pos]<>(SELECT oid FROM pg_catalog.pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace
            AND opcname=CASE WHEN t.name='user_bill' THEN 'text_ops' ELSE 'int4_ops' END AND opcmethod=ic.relam)))) AS ready) s;
  IF initial_state='drift' OR NOT sources_ready OR (initial_state='orm-pending' AND NOT false) THEN
    RAISE EXCEPTION 'Purchase cancellation catalog/source drift or unprotected ORM table requires review';
  END IF;
  -- Take the mode required by CREATE TRIGGER up front, no waiting lock upgrade.
  LOCK TABLE ONLY public.store_order IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  LOCK TABLE ONLY public.store_order_cart_info IN SHARE MODE NOWAIT;
  LOCK TABLE ONLY public.store_order_purchase_origin IN SHARE MODE NOWAIT;
  LOCK TABLE ONLY public.store_order_status IN SHARE MODE NOWAIT;
  LOCK TABLE ONLY public.user_bill IN SHARE MODE NOWAIT;
  IF initial_state IN ('v1','orm-pending') THEN LOCK TABLE ONLY public.store_order_purchase_cancellation IN ACCESS EXCLUSIVE MODE NOWAIT; END IF;
  SELECT state INTO final_state FROM (WITH catalog AS (
WITH relations AS (
  SELECT c.* FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.store_order_purchase_cancellation')
), components AS (
  SELECT 'store_order_purchase_cancellation'::text AS name,r.oid,r.relowner AS owner,
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
      WHERE a.grantee<>p.proowner)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgfoid=p.oid AND NOT (
      (p.proname='begin_purchase_cancellation_v1' AND t.tgname='sopc_order_transition' AND t.tgrelid=to_regclass('public.store_order'))
      OR (p.proname='capture_purchase_cancellation_v1' AND t.tgname='sopc_capture' AND t.tgrelid=to_regclass('public.store_order_purchase_cancellation'))
      OR (p.proname='validate_purchase_cancellation_v1' AND t.tgname='sopc_validate' AND t.tgrelid=to_regclass('public.store_order_purchase_cancellation'))
      OR (p.proname='protect_purchase_cancellation_v1' AND t.tgname IN ('sopc_no_rewrite','sopc_no_truncate') AND t.tgrelid=to_regclass('public.store_order_purchase_cancellation')))),
    jsonb_build_object('definition',CASE WHEN p.prokind='f' THEN pg_get_functiondef(p.oid) END,
      'support',p.prosupport::text,'binary',p.probin,'argtypes',p.proargtypes::text),'pg_proc'::regclass
  FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
    AND p.proname IN ('begin_purchase_cancellation_v1','capture_purchase_cancellation_v1','validate_purchase_cancellation_v1','protect_purchase_cancellation_v1')
  UNION ALL
  SELECT 'sopc_order_transition',t.oid,c.relowner,NOT t.tgisinternal,
    jsonb_build_object('definition',pg_get_triggerdef(t.oid,false),'enabled',t.tgenabled::text,
      'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,'parent',t.tgparentid::text),'pg_trigger'::regclass
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    WHERE t.tgrelid=to_regclass('public.store_order') AND t.tgname='sopc_order_transition'
)
SELECT name,oid::text AS oid,owner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owned,
  safe AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid=c.catalog AND d.objid=c.oid
    AND d.deptype IN ('e','x')) AS safe,
  encode(sha256(convert_to(shape::text,'UTF8')),'hex') AS fingerprint
FROM components c ORDER BY name COLLATE "C",oid
),
  snapshot AS (SELECT count(*) AS n,jsonb_object_agg(name,to_jsonb(catalog)) AS objects FROM catalog)
SELECT CASE WHEN n=0 AND to_regclass('public.sopc_buyer_history') IS NULL
  AND to_regclass('public.store_order_purchase_cancellation_pkey') IS NULL THEN 'fresh'
  WHEN n=6 AND (objects->'store_order_purchase_cancellation') @> '{"owned":true,"safe":true,"fingerprint":"bd28aae90f21d33e47870f977d5de0d8be8ecf85c35dfe26eccdab9aa47f4729"}'::jsonb AND (objects->'begin_purchase_cancellation_v1') @> '{"owned":true,"safe":true,"fingerprint":"f8fa73642f10e09097b498fcd8719de20cb5a902783d95d757dab11e02918c19"}'::jsonb AND (objects->'capture_purchase_cancellation_v1') @> '{"owned":true,"safe":true,"fingerprint":"5212ccba912454c3cdcd3d53b0e8b6d1ee1272d0df10e01fec534815069c71e2"}'::jsonb AND (objects->'validate_purchase_cancellation_v1') @> '{"owned":true,"safe":true,"fingerprint":"62e5541fde33a9c6666dc7e382b6b4355777d7c39a82d172afc9288f5879edfc"}'::jsonb AND (objects->'protect_purchase_cancellation_v1') @> '{"owned":true,"safe":true,"fingerprint":"2666faef1c503cc067a096b147f3070874c2b885ab14a20422bbdb2a430277ec"}'::jsonb AND (objects->'sopc_order_transition') @> '{"owned":true,"safe":true,"fingerprint":"aba99ae49b039104eeb7c079426302ffc5bd25fd8baf1797a7eb65ae1723ce15"}'::jsonb THEN 'v1'
  WHEN n=1 AND (objects->'store_order_purchase_cancellation') @>
    '{"owned":true,"safe":true,"fingerprint":"fa732b88148e7dc49e486a235fa5875b47696317b84b78e6d416a3ba99ec547d"}'::jsonb
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL
      pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE c.oid=to_regclass('public.store_order_purchase_cancellation') AND a.grantee<>c.relowner) THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot) s;
  SELECT ready INTO sources_ready FROM (WITH origin AS (WITH catalog AS (
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
  ELSE 'drift' END AS state FROM snapshot),
  original_sources AS (WITH tables AS (
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
          AND opcname='int4_ops' AND opcmethod=ic.relam))) AS ready), tables AS (
    SELECT name,c.* FROM (VALUES ('store_order_status'),('user_bill')) names(name)
      LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public.'||name)
  ), expected AS (SELECT * FROM (VALUES ('store_order_status','id','integer'),
('store_order_status','oid','integer'),
('store_order_status','change_type','character varying(32)'),
('user_bill','id','integer'),
('user_bill','uid','integer'),
('user_bill','link_id','character varying(32)'),
('user_bill','category','character varying(64)'),
('user_bill','type','character varying(64)'),
('user_bill','event_key','character varying(64)'),
('user_bill','pm','smallint'),
('user_bill','number','numeric(12,2)'),
('user_bill','status','smallint')) e(tab,col,typ))
SELECT (SELECT state='v1' FROM origin) AND (SELECT ready FROM original_sources)
  AND NOT EXISTS(SELECT 1 FROM tables WHERE oid IS NULL OR relkind<>'r' OR relpersistence<>'p'
    OR relispartition OR relrowsecurity OR relforcerowsecurity
    OR relowner<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))
  AND NOT EXISTS(SELECT 1 FROM tables t JOIN pg_catalog.pg_inherits i ON i.inhrelid=t.oid OR i.inhparent=t.oid)
  AND NOT EXISTS(SELECT 1 FROM tables t JOIN pg_catalog.pg_rewrite r ON r.ev_class=t.oid)
  AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN tables t ON t.name=e.tab
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attname=e.col AND a.attnum>0 AND NOT a.attisdropped
    WHERE a.attnum IS NULL OR pg_catalog.format_type(a.atttypid,a.atttypmod)<>e.typ OR NOT a.attnotnull
      OR a.attgenerated<>'' OR a.attidentity<>'')
  AND NOT EXISTS(SELECT 1 FROM tables t WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=ic.relam
    JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[0]
    WHERE i.indrelid=t.oid AND a.attname='id' AND i.indisprimary AND i.indisunique AND i.indnatts=1
      AND i.indisvalid AND i.indisready AND i.indislive AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname='btree'
      AND i.indclass[0]=(SELECT oid FROM pg_catalog.pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace
        AND opcname='int4_ops' AND opcmethod=ic.relam)))
  AND NOT EXISTS(SELECT 1 FROM tables t WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=ic.relam
    WHERE i.indrelid=t.oid AND i.indisvalid AND i.indisready AND i.indislive
      AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname='btree'
      AND i.indnkeyatts>=CASE WHEN t.name='user_bill' THEN 3 ELSE 1 END
      AND NOT EXISTS(SELECT 1 FROM generate_series(0,CASE WHEN t.name='user_bill' THEN 2 ELSE 0 END) k(pos)
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[k.pos]
        WHERE a.attname IS DISTINCT FROM CASE WHEN t.name='store_order_status' THEN 'oid'
          WHEN k.pos=0 THEN 'category' WHEN k.pos=1 THEN 'type' ELSE 'link_id' END
          OR i.indcollation[k.pos]<>a.attcollation
          OR i.indclass[k.pos]<>(SELECT oid FROM pg_catalog.pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace
            AND opcname=CASE WHEN t.name='user_bill' THEN 'text_ops' ELSE 'int4_ops' END AND opcmethod=ic.relam)))) AS ready) s;
  IF final_state IS DISTINCT FROM initial_state OR NOT sources_ready THEN RAISE EXCEPTION 'Purchase cancellation catalog changed during locking'; END IF;
  IF initial_state='orm-pending' THEN
    IF EXISTS(SELECT 1 FROM public.store_order_purchase_cancellation) THEN
      RAISE EXCEPTION 'Unprotected ORM purchase cancellation table must be empty; no history repair is allowed';
    END IF;
-- Only a live unpaid->cancelled UPDATE can initiate capture. Existing cancelled
-- orders and orders without a trusted origin stay outside the evidence domain.
CREATE FUNCTION public.begin_purchase_cancellation_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'store_order'
    OR pg_trigger_depth() <> 1 THEN
    RAISE EXCEPTION 'Purchase cancellation requires a direct order transition' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.store_order_purchase_origin WHERE order_id=OLD.id) THEN RETURN NEW; END IF;
  IF OLD.id IS DISTINCT FROM NEW.id OR OLD.uid IS DISTINCT FROM NEW.uid
    OR OLD.type IS DISTINCT FROM NEW.type OR OLD.total_num IS DISTINCT FROM NEW.total_num
    OR OLD.use_integral IS DISTINCT FROM NEW.use_integral OR OLD.cart_id IS DISTINCT FROM NEW.cart_id
    OR OLD.paid <> 0 OR OLD.status <> 0 OR OLD.is_del <> 0 OR OLD.is_system_del <> 0
    OR OLD.pid <> 0 OR OLD.supplier_allocation_status NOT IN (0,1)
    OR OLD.refund_status <> 0 OR OLD.refund_type <> 0
    OR NEW.paid <> 0 OR NEW.status <> -2 OR NEW.is_del <> 1 OR NEW.is_system_del <> 0
    OR NEW.pid <> 0 OR NEW.supplier_allocation_status NOT IN (0,1)
    OR NEW.refund_status <> 0 OR NEW.refund_type <> 0 THEN
    RAISE EXCEPTION 'Purchase cancellation requires an unsplit unpaid root transition' USING ERRCODE='23514';
  END IF;
  INSERT INTO public.store_order_purchase_cancellation(order_id,buyer_id) VALUES (NEW.id,NEW.uid);
  RETURN NEW;
END $$;

CREATE FUNCTION public.capture_purchase_cancellation_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE origin record;
BEGIN
  IF TG_OP <> 'INSERT' OR TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'store_order_purchase_cancellation'
    OR pg_trigger_depth() <> 2 OR NEW.version IS NOT NULL OR NEW.order_type IS NOT NULL
    OR NEW.total_num IS NOT NULL OR NEW.restored_points IS NOT NULL OR NEW.lines IS NOT NULL
    OR NEW.origin_recorded_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Purchase cancellation cannot be inserted or backfilled directly' USING ERRCODE='23514';
  END IF;
  SELECT buyer_id,version,order_type,total_num,used_points,lines,recorded_at INTO origin
    FROM public.store_order_purchase_origin WHERE order_id=NEW.order_id;
  IF NOT FOUND OR origin.buyer_id IS DISTINCT FROM NEW.buyer_id OR origin.version <> 'purchase-origin-v1' THEN
    RAISE EXCEPTION 'Purchase cancellation requires trusted purchase origin' USING ERRCODE='23514';
  END IF;
  NEW.version := 'purchase-cancellation-v1'; NEW.order_type := origin.order_type;
  NEW.total_num := origin.total_num; NEW.restored_points := origin.used_points;
  NEW.lines := origin.lines; NEW.origin_recorded_at := origin.recorded_at; NEW.cancelled_at := clock_timestamp();
  RETURN NEW;
END $$;

-- Deferred validation runs after compensation and the cancel log, before COMMIT.
-- This proves the transition/evidence and points ledger agree. Inventory/cart/
-- coupon compensation remains the trusted atomic service's responsibility;
-- current stock/balance is not misrepresented as historical compensation proof.
CREATE FUNCTION public.validate_purchase_cancellation_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE parent record; item record; info jsonb; expected jsonb; bills record;
  rows integer := 0; bytes bigint := 0; claimed text[]; carts text[] := ARRAY[]::text[];
  log_count integer; deduction_count integer := 0; restoration_count integer := 0;
BEGIN
  IF TG_OP <> 'INSERT' OR TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'store_order_purchase_cancellation' THEN
    RAISE EXCEPTION 'Invalid purchase cancellation validation source' USING ERRCODE='23514';
  END IF;
  SELECT id,uid,type,pid,paid,status,is_del,is_system_del,supplier_allocation_status,
    refund_status,refund_type,total_num,use_integral,cart_id INTO parent
    FROM public.store_order WHERE id=NEW.order_id FOR UPDATE;
  IF NOT FOUND OR parent.uid IS DISTINCT FROM NEW.buyer_id OR parent.type IS DISTINCT FROM NEW.order_type
    OR parent.total_num IS DISTINCT FROM NEW.total_num OR parent.use_integral IS DISTINCT FROM NEW.restored_points
    OR parent.paid <> 0 OR parent.status <> -2 OR parent.is_del <> 1 OR parent.is_system_del <> 0
    OR parent.pid <> 0 OR parent.supplier_allocation_status NOT IN (0,1)
    OR parent.refund_status <> 0 OR parent.refund_type <> 0
    OR EXISTS(SELECT 1 FROM public.store_order WHERE pid=parent.id) THEN
    RAISE EXCEPTION 'Purchase cancellation final root does not match origin' USING ERRCODE='23514';
  END IF;
  IF parent.cart_id IS NULL OR length(parent.cart_id)>2199
    OR parent.cart_id !~ '^[1-9][0-9]{0,9}(,[1-9][0-9]{0,9}){0,199}$' THEN
    RAISE EXCEPTION 'Purchase cancellation cart identities invalid' USING ERRCODE='23514';
  END IF;
  claimed := string_to_array(parent.cart_id, ',');
  FOR item IN SELECT id,uid,cart_id,old_cart_id,product_id,sku_unique,cart_num,refund_num,
    split_status,split_surplus_num,surplus_num,is_writeoff,
    CASE WHEN octet_length(cart_info)<=65536 THEN cart_info ELSE NULL END AS snapshot
    FROM public.store_order_cart_info WHERE oid=parent.id ORDER BY id LIMIT 201 FOR UPDATE
  LOOP
    IF rows>=200 OR item.snapshot IS NULL OR item.uid IS DISTINCT FROM NEW.buyer_id
      OR item.old_cart_id <> '' OR item.refund_num <> 0 OR item.split_status <> 0
      OR item.split_surplus_num <> item.cart_num OR item.surplus_num <> item.cart_num OR item.is_writeoff <> 0
      OR item.cart_id=ANY(carts) OR NOT item.cart_id=ANY(claimed) THEN
      RAISE EXCEPTION 'Purchase cancellation line ownership or state invalid' USING ERRCODE='23514';
    END IF;
    bytes := bytes + octet_length(item.snapshot);
    IF bytes>8388608 THEN RAISE EXCEPTION 'Purchase cancellation snapshots too large' USING ERRCODE='23514'; END IF;
    info := item.snapshot::jsonb; expected := NEW.lines->rows;
    IF expected IS NULL OR jsonb_typeof(info) IS DISTINCT FROM 'object'
      OR info->>'financial_version' IS DISTINCT FROM 'checkout-line-finance-v1'
      OR info ? 'refund_order_generation'
      OR info->'id' IS DISTINCT FROM to_jsonb(item.cart_id)
      OR info->'cart_num' IS DISTINCT FROM to_jsonb(item.cart_num)
      OR info#>'{product,id}' IS DISTINCT FROM to_jsonb(item.product_id)
      OR info#>'{sku,id}' IS DISTINCT FROM expected->'skuId'
      OR NOT (info#>'{sku,unique}' IS NOT DISTINCT FROM to_jsonb(item.sku_unique)
        OR (parent.type IN (1,2,3) AND info#>'{activitySku,unique}' IS NOT DISTINCT FROM to_jsonb(item.sku_unique)))
      OR info->'use_integral' IS DISTINCT FROM to_jsonb(expected->>'usedPoints')
      OR expected->'rowId' IS DISTINCT FROM to_jsonb(item.id)
      OR expected->'cartId' IS DISTINCT FROM to_jsonb(item.cart_id)
      OR expected->'productId' IS DISTINCT FROM to_jsonb(item.product_id)
      OR expected->'skuUnique' IS DISTINCT FROM to_jsonb(item.sku_unique)
      OR expected->'quantity' IS DISTINCT FROM to_jsonb(item.cart_num) THEN
      RAISE EXCEPTION 'Purchase cancellation lines differ from original purchase' USING ERRCODE='23514';
    END IF;
    rows := rows+1; carts := array_append(carts,item.cart_id);
  END LOOP;
  IF rows<>jsonb_array_length(NEW.lines) OR rows<>cardinality(claimed) THEN
    RAISE EXCEPTION 'Purchase cancellation line coverage incomplete' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO log_count FROM (SELECT id FROM public.store_order_status
    WHERE oid=NEW.order_id AND change_type='cancel' LIMIT 2) s;
  IF log_count<>1 THEN RAISE EXCEPTION 'Purchase cancellation log missing or ambiguous' USING ERRCODE='23514'; END IF;
  -- Use the existing category/type/link index, not an unbounded all-user scan.
  FOR bills IN SELECT uid,pm,event_key,number,status FROM public.user_bill
    WHERE category='integral' AND type='deduction' AND link_id=NEW.order_id::text LIMIT 2
  LOOP
    deduction_count := deduction_count+1;
    IF bills.uid<>NEW.buyer_id OR bills.pm<>0 OR bills.event_key<>'order_integral_deduction'
      OR bills.status<>1 OR bills.number<>NEW.restored_points THEN
      RAISE EXCEPTION 'Purchase cancellation original points ledger inconsistent' USING ERRCODE='23514';
    END IF;
  END LOOP;
  FOR bills IN SELECT uid,pm,event_key,number,status FROM public.user_bill
    WHERE category='integral' AND type='order_cancel' AND link_id=NEW.order_id::text LIMIT 2
  LOOP
    restoration_count := restoration_count+1;
    IF bills.uid<>NEW.buyer_id OR bills.pm<>1 OR bills.event_key<>'order_cancel_integral_back'
      OR bills.status<>1 OR bills.number<>NEW.restored_points THEN
      RAISE EXCEPTION 'Purchase cancellation restored points ledger inconsistent' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF (NEW.restored_points>0 AND (deduction_count<>1 OR restoration_count<>1))
    OR (NEW.restored_points=0 AND (deduction_count<>0 OR restoration_count<>0)) THEN
    RAISE EXCEPTION 'Purchase cancellation points ledger missing or ambiguous' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.protect_purchase_cancellation_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Purchase cancellation evidence is append-only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER sopc_capture BEFORE INSERT ON public.store_order_purchase_cancellation
  FOR EACH ROW EXECUTE FUNCTION public.capture_purchase_cancellation_v1();
CREATE TRIGGER sopc_no_rewrite BEFORE UPDATE OR DELETE ON public.store_order_purchase_cancellation
  FOR EACH ROW EXECUTE FUNCTION public.protect_purchase_cancellation_v1();
CREATE TRIGGER sopc_no_truncate BEFORE TRUNCATE ON public.store_order_purchase_cancellation
  FOR EACH STATEMENT EXECUTE FUNCTION public.protect_purchase_cancellation_v1();
CREATE CONSTRAINT TRIGGER sopc_validate AFTER INSERT ON public.store_order_purchase_cancellation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_purchase_cancellation_v1();
CREATE TRIGGER sopc_order_transition AFTER UPDATE ON public.store_order
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status=-2)
  EXECUTE FUNCTION public.begin_purchase_cancellation_v1();
REVOKE ALL ON FUNCTION public.begin_purchase_cancellation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.capture_purchase_cancellation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_purchase_cancellation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_purchase_cancellation_v1() FROM PUBLIC;

  ELSIF initial_state='fresh' THEN

CREATE TABLE public.store_order_purchase_cancellation (
  order_id integer PRIMARY KEY CHECK (order_id > 0),
  buyer_id integer NOT NULL CHECK (buyer_id >= 0),
  version text NOT NULL CHECK (version = 'purchase-cancellation-v1'),
  order_type smallint NOT NULL CHECK (order_type BETWEEN 0 AND 8),
  total_num integer NOT NULL CHECK (total_num > 0),
  restored_points bigint NOT NULL CHECK (restored_points BETWEEN 0 AND 9999999999),
  lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'
    AND jsonb_array_length(lines) BETWEEN 1 AND 200 AND octet_length(lines::text) <= 131072),
  origin_recorded_at timestamptz NOT NULL,
  cancelled_at timestamptz NOT NULL
);
CREATE INDEX sopc_buyer_history ON public.store_order_purchase_cancellation(buyer_id, order_id);
REVOKE ALL ON public.store_order_purchase_cancellation FROM PUBLIC;

-- Only a live unpaid->cancelled UPDATE can initiate capture. Existing cancelled
-- orders and orders without a trusted origin stay outside the evidence domain.
CREATE FUNCTION public.begin_purchase_cancellation_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'store_order'
    OR pg_trigger_depth() <> 1 THEN
    RAISE EXCEPTION 'Purchase cancellation requires a direct order transition' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.store_order_purchase_origin WHERE order_id=OLD.id) THEN RETURN NEW; END IF;
  IF OLD.id IS DISTINCT FROM NEW.id OR OLD.uid IS DISTINCT FROM NEW.uid
    OR OLD.type IS DISTINCT FROM NEW.type OR OLD.total_num IS DISTINCT FROM NEW.total_num
    OR OLD.use_integral IS DISTINCT FROM NEW.use_integral OR OLD.cart_id IS DISTINCT FROM NEW.cart_id
    OR OLD.paid <> 0 OR OLD.status <> 0 OR OLD.is_del <> 0 OR OLD.is_system_del <> 0
    OR OLD.pid <> 0 OR OLD.supplier_allocation_status NOT IN (0,1)
    OR OLD.refund_status <> 0 OR OLD.refund_type <> 0
    OR NEW.paid <> 0 OR NEW.status <> -2 OR NEW.is_del <> 1 OR NEW.is_system_del <> 0
    OR NEW.pid <> 0 OR NEW.supplier_allocation_status NOT IN (0,1)
    OR NEW.refund_status <> 0 OR NEW.refund_type <> 0 THEN
    RAISE EXCEPTION 'Purchase cancellation requires an unsplit unpaid root transition' USING ERRCODE='23514';
  END IF;
  INSERT INTO public.store_order_purchase_cancellation(order_id,buyer_id) VALUES (NEW.id,NEW.uid);
  RETURN NEW;
END $$;

CREATE FUNCTION public.capture_purchase_cancellation_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE origin record;
BEGIN
  IF TG_OP <> 'INSERT' OR TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'store_order_purchase_cancellation'
    OR pg_trigger_depth() <> 2 OR NEW.version IS NOT NULL OR NEW.order_type IS NOT NULL
    OR NEW.total_num IS NOT NULL OR NEW.restored_points IS NOT NULL OR NEW.lines IS NOT NULL
    OR NEW.origin_recorded_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Purchase cancellation cannot be inserted or backfilled directly' USING ERRCODE='23514';
  END IF;
  SELECT buyer_id,version,order_type,total_num,used_points,lines,recorded_at INTO origin
    FROM public.store_order_purchase_origin WHERE order_id=NEW.order_id;
  IF NOT FOUND OR origin.buyer_id IS DISTINCT FROM NEW.buyer_id OR origin.version <> 'purchase-origin-v1' THEN
    RAISE EXCEPTION 'Purchase cancellation requires trusted purchase origin' USING ERRCODE='23514';
  END IF;
  NEW.version := 'purchase-cancellation-v1'; NEW.order_type := origin.order_type;
  NEW.total_num := origin.total_num; NEW.restored_points := origin.used_points;
  NEW.lines := origin.lines; NEW.origin_recorded_at := origin.recorded_at; NEW.cancelled_at := clock_timestamp();
  RETURN NEW;
END $$;

-- Deferred validation runs after compensation and the cancel log, before COMMIT.
-- This proves the transition/evidence and points ledger agree. Inventory/cart/
-- coupon compensation remains the trusted atomic service's responsibility;
-- current stock/balance is not misrepresented as historical compensation proof.
CREATE FUNCTION public.validate_purchase_cancellation_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE parent record; item record; info jsonb; expected jsonb; bills record;
  rows integer := 0; bytes bigint := 0; claimed text[]; carts text[] := ARRAY[]::text[];
  log_count integer; deduction_count integer := 0; restoration_count integer := 0;
BEGIN
  IF TG_OP <> 'INSERT' OR TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'store_order_purchase_cancellation' THEN
    RAISE EXCEPTION 'Invalid purchase cancellation validation source' USING ERRCODE='23514';
  END IF;
  SELECT id,uid,type,pid,paid,status,is_del,is_system_del,supplier_allocation_status,
    refund_status,refund_type,total_num,use_integral,cart_id INTO parent
    FROM public.store_order WHERE id=NEW.order_id FOR UPDATE;
  IF NOT FOUND OR parent.uid IS DISTINCT FROM NEW.buyer_id OR parent.type IS DISTINCT FROM NEW.order_type
    OR parent.total_num IS DISTINCT FROM NEW.total_num OR parent.use_integral IS DISTINCT FROM NEW.restored_points
    OR parent.paid <> 0 OR parent.status <> -2 OR parent.is_del <> 1 OR parent.is_system_del <> 0
    OR parent.pid <> 0 OR parent.supplier_allocation_status NOT IN (0,1)
    OR parent.refund_status <> 0 OR parent.refund_type <> 0
    OR EXISTS(SELECT 1 FROM public.store_order WHERE pid=parent.id) THEN
    RAISE EXCEPTION 'Purchase cancellation final root does not match origin' USING ERRCODE='23514';
  END IF;
  IF parent.cart_id IS NULL OR length(parent.cart_id)>2199
    OR parent.cart_id !~ '^[1-9][0-9]{0,9}(,[1-9][0-9]{0,9}){0,199}$' THEN
    RAISE EXCEPTION 'Purchase cancellation cart identities invalid' USING ERRCODE='23514';
  END IF;
  claimed := string_to_array(parent.cart_id, ',');
  FOR item IN SELECT id,uid,cart_id,old_cart_id,product_id,sku_unique,cart_num,refund_num,
    split_status,split_surplus_num,surplus_num,is_writeoff,
    CASE WHEN octet_length(cart_info)<=65536 THEN cart_info ELSE NULL END AS snapshot
    FROM public.store_order_cart_info WHERE oid=parent.id ORDER BY id LIMIT 201 FOR UPDATE
  LOOP
    IF rows>=200 OR item.snapshot IS NULL OR item.uid IS DISTINCT FROM NEW.buyer_id
      OR item.old_cart_id <> '' OR item.refund_num <> 0 OR item.split_status <> 0
      OR item.split_surplus_num <> item.cart_num OR item.surplus_num <> item.cart_num OR item.is_writeoff <> 0
      OR item.cart_id=ANY(carts) OR NOT item.cart_id=ANY(claimed) THEN
      RAISE EXCEPTION 'Purchase cancellation line ownership or state invalid' USING ERRCODE='23514';
    END IF;
    bytes := bytes + octet_length(item.snapshot);
    IF bytes>8388608 THEN RAISE EXCEPTION 'Purchase cancellation snapshots too large' USING ERRCODE='23514'; END IF;
    info := item.snapshot::jsonb; expected := NEW.lines->rows;
    IF expected IS NULL OR jsonb_typeof(info) IS DISTINCT FROM 'object'
      OR info->>'financial_version' IS DISTINCT FROM 'checkout-line-finance-v1'
      OR info ? 'refund_order_generation'
      OR info->'id' IS DISTINCT FROM to_jsonb(item.cart_id)
      OR info->'cart_num' IS DISTINCT FROM to_jsonb(item.cart_num)
      OR info#>'{product,id}' IS DISTINCT FROM to_jsonb(item.product_id)
      OR info#>'{sku,id}' IS DISTINCT FROM expected->'skuId'
      OR NOT (info#>'{sku,unique}' IS NOT DISTINCT FROM to_jsonb(item.sku_unique)
        OR (parent.type IN (1,2,3) AND info#>'{activitySku,unique}' IS NOT DISTINCT FROM to_jsonb(item.sku_unique)))
      OR info->'use_integral' IS DISTINCT FROM to_jsonb(expected->>'usedPoints')
      OR expected->'rowId' IS DISTINCT FROM to_jsonb(item.id)
      OR expected->'cartId' IS DISTINCT FROM to_jsonb(item.cart_id)
      OR expected->'productId' IS DISTINCT FROM to_jsonb(item.product_id)
      OR expected->'skuUnique' IS DISTINCT FROM to_jsonb(item.sku_unique)
      OR expected->'quantity' IS DISTINCT FROM to_jsonb(item.cart_num) THEN
      RAISE EXCEPTION 'Purchase cancellation lines differ from original purchase' USING ERRCODE='23514';
    END IF;
    rows := rows+1; carts := array_append(carts,item.cart_id);
  END LOOP;
  IF rows<>jsonb_array_length(NEW.lines) OR rows<>cardinality(claimed) THEN
    RAISE EXCEPTION 'Purchase cancellation line coverage incomplete' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO log_count FROM (SELECT id FROM public.store_order_status
    WHERE oid=NEW.order_id AND change_type='cancel' LIMIT 2) s;
  IF log_count<>1 THEN RAISE EXCEPTION 'Purchase cancellation log missing or ambiguous' USING ERRCODE='23514'; END IF;
  -- Use the existing category/type/link index, not an unbounded all-user scan.
  FOR bills IN SELECT uid,pm,event_key,number,status FROM public.user_bill
    WHERE category='integral' AND type='deduction' AND link_id=NEW.order_id::text LIMIT 2
  LOOP
    deduction_count := deduction_count+1;
    IF bills.uid<>NEW.buyer_id OR bills.pm<>0 OR bills.event_key<>'order_integral_deduction'
      OR bills.status<>1 OR bills.number<>NEW.restored_points THEN
      RAISE EXCEPTION 'Purchase cancellation original points ledger inconsistent' USING ERRCODE='23514';
    END IF;
  END LOOP;
  FOR bills IN SELECT uid,pm,event_key,number,status FROM public.user_bill
    WHERE category='integral' AND type='order_cancel' AND link_id=NEW.order_id::text LIMIT 2
  LOOP
    restoration_count := restoration_count+1;
    IF bills.uid<>NEW.buyer_id OR bills.pm<>1 OR bills.event_key<>'order_cancel_integral_back'
      OR bills.status<>1 OR bills.number<>NEW.restored_points THEN
      RAISE EXCEPTION 'Purchase cancellation restored points ledger inconsistent' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF (NEW.restored_points>0 AND (deduction_count<>1 OR restoration_count<>1))
    OR (NEW.restored_points=0 AND (deduction_count<>0 OR restoration_count<>0)) THEN
    RAISE EXCEPTION 'Purchase cancellation points ledger missing or ambiguous' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.protect_purchase_cancellation_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Purchase cancellation evidence is append-only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER sopc_capture BEFORE INSERT ON public.store_order_purchase_cancellation
  FOR EACH ROW EXECUTE FUNCTION public.capture_purchase_cancellation_v1();
CREATE TRIGGER sopc_no_rewrite BEFORE UPDATE OR DELETE ON public.store_order_purchase_cancellation
  FOR EACH ROW EXECUTE FUNCTION public.protect_purchase_cancellation_v1();
CREATE TRIGGER sopc_no_truncate BEFORE TRUNCATE ON public.store_order_purchase_cancellation
  FOR EACH STATEMENT EXECUTE FUNCTION public.protect_purchase_cancellation_v1();
CREATE CONSTRAINT TRIGGER sopc_validate AFTER INSERT ON public.store_order_purchase_cancellation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_purchase_cancellation_v1();
CREATE TRIGGER sopc_order_transition AFTER UPDATE ON public.store_order
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status=-2)
  EXECUTE FUNCTION public.begin_purchase_cancellation_v1();
REVOKE ALL ON FUNCTION public.begin_purchase_cancellation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.capture_purchase_cancellation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_purchase_cancellation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_purchase_cancellation_v1() FROM PUBLIC;

    IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL
      pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE c.oid='public.store_order_purchase_cancellation'::regclass AND a.grantee<>c.relowner) THEN
      RAISE EXCEPTION 'Purchase cancellation defaults must not expose new evidence';
    END IF;
  END IF;
  SELECT state INTO final_state FROM (WITH catalog AS (
WITH relations AS (
  SELECT c.* FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.store_order_purchase_cancellation')
), components AS (
  SELECT 'store_order_purchase_cancellation'::text AS name,r.oid,r.relowner AS owner,
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
      WHERE a.grantee<>p.proowner)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgfoid=p.oid AND NOT (
      (p.proname='begin_purchase_cancellation_v1' AND t.tgname='sopc_order_transition' AND t.tgrelid=to_regclass('public.store_order'))
      OR (p.proname='capture_purchase_cancellation_v1' AND t.tgname='sopc_capture' AND t.tgrelid=to_regclass('public.store_order_purchase_cancellation'))
      OR (p.proname='validate_purchase_cancellation_v1' AND t.tgname='sopc_validate' AND t.tgrelid=to_regclass('public.store_order_purchase_cancellation'))
      OR (p.proname='protect_purchase_cancellation_v1' AND t.tgname IN ('sopc_no_rewrite','sopc_no_truncate') AND t.tgrelid=to_regclass('public.store_order_purchase_cancellation')))),
    jsonb_build_object('definition',CASE WHEN p.prokind='f' THEN pg_get_functiondef(p.oid) END,
      'support',p.prosupport::text,'binary',p.probin,'argtypes',p.proargtypes::text),'pg_proc'::regclass
  FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
    AND p.proname IN ('begin_purchase_cancellation_v1','capture_purchase_cancellation_v1','validate_purchase_cancellation_v1','protect_purchase_cancellation_v1')
  UNION ALL
  SELECT 'sopc_order_transition',t.oid,c.relowner,NOT t.tgisinternal,
    jsonb_build_object('definition',pg_get_triggerdef(t.oid,false),'enabled',t.tgenabled::text,
      'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,'parent',t.tgparentid::text),'pg_trigger'::regclass
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    WHERE t.tgrelid=to_regclass('public.store_order') AND t.tgname='sopc_order_transition'
)
SELECT name,oid::text AS oid,owner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owned,
  safe AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid=c.catalog AND d.objid=c.oid
    AND d.deptype IN ('e','x')) AS safe,
  encode(sha256(convert_to(shape::text,'UTF8')),'hex') AS fingerprint
FROM components c ORDER BY name COLLATE "C",oid
),
  snapshot AS (SELECT count(*) AS n,jsonb_object_agg(name,to_jsonb(catalog)) AS objects FROM catalog)
SELECT CASE WHEN n=0 AND to_regclass('public.sopc_buyer_history') IS NULL
  AND to_regclass('public.store_order_purchase_cancellation_pkey') IS NULL THEN 'fresh'
  WHEN n=6 AND (objects->'store_order_purchase_cancellation') @> '{"owned":true,"safe":true,"fingerprint":"bd28aae90f21d33e47870f977d5de0d8be8ecf85c35dfe26eccdab9aa47f4729"}'::jsonb AND (objects->'begin_purchase_cancellation_v1') @> '{"owned":true,"safe":true,"fingerprint":"f8fa73642f10e09097b498fcd8719de20cb5a902783d95d757dab11e02918c19"}'::jsonb AND (objects->'capture_purchase_cancellation_v1') @> '{"owned":true,"safe":true,"fingerprint":"5212ccba912454c3cdcd3d53b0e8b6d1ee1272d0df10e01fec534815069c71e2"}'::jsonb AND (objects->'validate_purchase_cancellation_v1') @> '{"owned":true,"safe":true,"fingerprint":"62e5541fde33a9c6666dc7e382b6b4355777d7c39a82d172afc9288f5879edfc"}'::jsonb AND (objects->'protect_purchase_cancellation_v1') @> '{"owned":true,"safe":true,"fingerprint":"2666faef1c503cc067a096b147f3070874c2b885ab14a20422bbdb2a430277ec"}'::jsonb AND (objects->'sopc_order_transition') @> '{"owned":true,"safe":true,"fingerprint":"aba99ae49b039104eeb7c079426302ffc5bd25fd8baf1797a7eb65ae1723ce15"}'::jsonb THEN 'v1'
  WHEN n=1 AND (objects->'store_order_purchase_cancellation') @>
    '{"owned":true,"safe":true,"fingerprint":"fa732b88148e7dc49e486a235fa5875b47696317b84b78e6d416a3ba99ec547d"}'::jsonb
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL
      pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE c.oid=to_regclass('public.store_order_purchase_cancellation') AND a.grantee<>c.relowner) THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot) s;
  SELECT ready INTO sources_ready FROM (WITH origin AS (WITH catalog AS (
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
  ELSE 'drift' END AS state FROM snapshot),
  original_sources AS (WITH tables AS (
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
          AND opcname='int4_ops' AND opcmethod=ic.relam))) AS ready), tables AS (
    SELECT name,c.* FROM (VALUES ('store_order_status'),('user_bill')) names(name)
      LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public.'||name)
  ), expected AS (SELECT * FROM (VALUES ('store_order_status','id','integer'),
('store_order_status','oid','integer'),
('store_order_status','change_type','character varying(32)'),
('user_bill','id','integer'),
('user_bill','uid','integer'),
('user_bill','link_id','character varying(32)'),
('user_bill','category','character varying(64)'),
('user_bill','type','character varying(64)'),
('user_bill','event_key','character varying(64)'),
('user_bill','pm','smallint'),
('user_bill','number','numeric(12,2)'),
('user_bill','status','smallint')) e(tab,col,typ))
SELECT (SELECT state='v1' FROM origin) AND (SELECT ready FROM original_sources)
  AND NOT EXISTS(SELECT 1 FROM tables WHERE oid IS NULL OR relkind<>'r' OR relpersistence<>'p'
    OR relispartition OR relrowsecurity OR relforcerowsecurity
    OR relowner<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))
  AND NOT EXISTS(SELECT 1 FROM tables t JOIN pg_catalog.pg_inherits i ON i.inhrelid=t.oid OR i.inhparent=t.oid)
  AND NOT EXISTS(SELECT 1 FROM tables t JOIN pg_catalog.pg_rewrite r ON r.ev_class=t.oid)
  AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN tables t ON t.name=e.tab
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attname=e.col AND a.attnum>0 AND NOT a.attisdropped
    WHERE a.attnum IS NULL OR pg_catalog.format_type(a.atttypid,a.atttypmod)<>e.typ OR NOT a.attnotnull
      OR a.attgenerated<>'' OR a.attidentity<>'')
  AND NOT EXISTS(SELECT 1 FROM tables t WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=ic.relam
    JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[0]
    WHERE i.indrelid=t.oid AND a.attname='id' AND i.indisprimary AND i.indisunique AND i.indnatts=1
      AND i.indisvalid AND i.indisready AND i.indislive AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname='btree'
      AND i.indclass[0]=(SELECT oid FROM pg_catalog.pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace
        AND opcname='int4_ops' AND opcmethod=ic.relam)))
  AND NOT EXISTS(SELECT 1 FROM tables t WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=ic.relam
    WHERE i.indrelid=t.oid AND i.indisvalid AND i.indisready AND i.indislive
      AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname='btree'
      AND i.indnkeyatts>=CASE WHEN t.name='user_bill' THEN 3 ELSE 1 END
      AND NOT EXISTS(SELECT 1 FROM generate_series(0,CASE WHEN t.name='user_bill' THEN 2 ELSE 0 END) k(pos)
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[k.pos]
        WHERE a.attname IS DISTINCT FROM CASE WHEN t.name='store_order_status' THEN 'oid'
          WHEN k.pos=0 THEN 'category' WHEN k.pos=1 THEN 'type' ELSE 'link_id' END
          OR i.indcollation[k.pos]<>a.attcollation
          OR i.indclass[k.pos]<>(SELECT oid FROM pg_catalog.pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace
            AND opcname=CASE WHEN t.name='user_bill' THEN 'text_ops' ELSE 'int4_ops' END AND opcmethod=ic.relam)))) AS ready) s;
  IF final_state IS DISTINCT FROM 'v1' OR NOT sources_ready OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Purchase cancellation verification failed after installation';
  END IF;
END
$purchase_cancellation_install$;
