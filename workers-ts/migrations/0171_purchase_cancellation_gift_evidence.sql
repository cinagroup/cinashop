SET LOCAL search_path=pg_catalog,public,pg_temp;
SET LOCAL row_security=off;
SET LOCAL default_tablespace='';
SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),30000)::text||'ms',true),
  set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true);
DO $purchase_cancellation_gift_forward$
DECLARE initial_state text; final_state text; sources_ready boolean;
BEGIN
  IF current_setting('server_version_num')::integer/10000<>16
    OR current_setting('transaction_isolation')<>'read committed'
    OR current_setting('transaction_read_only')<>'off'
    OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Purchase cancellation gift forward requires reviewed PG16 read-write READ COMMITTED';
  END IF;
  IF NOT pg_try_advisory_xact_lock(731611,0) THEN
    RAISE EXCEPTION 'Purchase evidence maintenance already running';
  END IF;
  SELECT state INTO initial_state FROM (WITH legacy AS (WITH catalog AS (
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
  ELSE 'drift' END AS state FROM snapshot),
  catalog AS (
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
  snapshot AS (SELECT count(*) AS n,jsonb_object_agg(name,to_jsonb(catalog)) AS objects FROM catalog),
  validator AS (SELECT p.prosrc,p.prokind,p.pronargs,p.prorettype,p.proretset,
      p.prosecdef,p.proleakproof,p.provolatile,p.proparallel,p.proisstrict,
      p.proconfig,p.prolang,p.proowner
    FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.validate_purchase_cancellation_v1()'))
SELECT CASE WHEN legacy.state='v1' THEN 'v1'
  WHEN snapshot.n=6 AND (objects->'store_order_purchase_cancellation') @> '{"owned":true,"safe":true,"fingerprint":"bd28aae90f21d33e47870f977d5de0d8be8ecf85c35dfe26eccdab9aa47f4729"}'::jsonb AND (objects->'begin_purchase_cancellation_v1') @> '{"owned":true,"safe":true,"fingerprint":"f8fa73642f10e09097b498fcd8719de20cb5a902783d95d757dab11e02918c19"}'::jsonb AND (objects->'capture_purchase_cancellation_v1') @> '{"owned":true,"safe":true,"fingerprint":"5212ccba912454c3cdcd3d53b0e8b6d1ee1272d0df10e01fec534815069c71e2"}'::jsonb AND (objects->'protect_purchase_cancellation_v1') @> '{"owned":true,"safe":true,"fingerprint":"2666faef1c503cc067a096b147f3070874c2b885ab14a20422bbdb2a430277ec"}'::jsonb AND (objects->'sopc_order_transition') @> '{"owned":true,"safe":true,"fingerprint":"aba99ae49b039104eeb7c079426302ffc5bd25fd8baf1797a7eb65ae1723ce15"}'::jsonb
    AND (snapshot.objects->'validate_purchase_cancellation_v1') @> '{"owned":true,"safe":true}'::jsonb
    AND EXISTS(SELECT 1 FROM validator v WHERE v.prosrc='
DECLARE parent record; item record; info jsonb; expected jsonb; bills record;
  campaign jsonb; gift jsonb; marker jsonb; intent jsonb; expected_gift jsonb;
  gift_map jsonb := ''{}''::jsonb; gift_key text; eligible jsonb; eligible_id text;
  rows integer := 0; purchased_rows integer := 0; gift_rows integer := 0;
  gift_count integer := 0; gift_total bigint := 0; bytes bigint := 0;
  claimed text[]; purchased_claimed text[] := ARRAY[]::text[];
  carts text[] := ARRAY[]::text[]; gift_seen text[] := ARRAY[]::text[];
  log_count integer; deduction_count integer := 0; restoration_count integer := 0;
BEGIN
  IF TG_OP <> ''INSERT'' OR TG_TABLE_SCHEMA <> ''public'' OR TG_TABLE_NAME <> ''store_order_purchase_cancellation'' THEN
    RAISE EXCEPTION ''Invalid purchase cancellation validation source'' USING ERRCODE=''23514'';
  END IF;
  SELECT id,uid,type,pid,paid,status,is_del,is_system_del,supplier_allocation_status,
    refund_status,refund_type,total_num,use_integral,cart_id,promotions_give INTO parent
    FROM public.store_order WHERE id=NEW.order_id FOR UPDATE;
  IF NOT FOUND OR parent.uid IS DISTINCT FROM NEW.buyer_id OR parent.type IS DISTINCT FROM NEW.order_type
    OR parent.use_integral IS DISTINCT FROM NEW.restored_points
    OR parent.paid <> 0 OR parent.status <> -2 OR parent.is_del <> 1 OR parent.is_system_del <> 0
    OR parent.pid <> 0 OR parent.supplier_allocation_status NOT IN (0,1)
    OR parent.refund_status <> 0 OR parent.refund_type <> 0
    OR EXISTS(SELECT 1 FROM public.store_order WHERE pid=parent.id) THEN
    RAISE EXCEPTION ''Purchase cancellation final root does not match origin'' USING ERRCODE=''23514'';
  END IF;
  IF parent.cart_id IS NULL OR length(parent.cart_id)>2199
    OR parent.cart_id !~ ''^[1-9][0-9]{0,9}(,[1-9][0-9]{0,9}){0,199}$'' THEN
    RAISE EXCEPTION ''Purchase cancellation cart identities invalid'' USING ERRCODE=''23514'';
  END IF;
  claimed := string_to_array(parent.cart_id, '','');
  IF cardinality(claimed) <> (SELECT count(DISTINCT value) FROM unnest(claimed) AS value) THEN
    RAISE EXCEPTION ''Purchase cancellation cart identities repeat'' USING ERRCODE=''23514'';
  END IF;
  FOR expected IN SELECT value FROM jsonb_array_elements(NEW.lines) LOOP
    IF jsonb_typeof(expected->''cartId'') IS DISTINCT FROM ''string''
      OR (expected->>''cartId'') !~ ''^[1-9][0-9]{0,9}$''
      OR (expected->>''cartId'')::bigint>2147483647
      OR NOT (expected->>''cartId'')=ANY(claimed)
      OR (expected->>''cartId'')=ANY(purchased_claimed) THEN
      RAISE EXCEPTION ''Purchase cancellation origin cart identities invalid'' USING ERRCODE=''23514'';
    END IF;
    purchased_claimed := array_append(purchased_claimed,expected->>''cartId'');
  END LOOP;
  IF parent.promotions_give IS NOT NULL AND parent.promotions_give NOT IN ('''',''null'') THEN
    IF octet_length(parent.promotions_give)>65536 THEN
      RAISE EXCEPTION ''Purchase cancellation gift intent too large'' USING ERRCODE=''23514'';
    END IF;
    intent := parent.promotions_give::jsonb;
    IF jsonb_typeof(intent)=''object'' AND intent->>''version''=''order-promotion-gifts-v1'' THEN
      IF jsonb_typeof(intent->''promotions'') IS DISTINCT FROM ''array''
        OR jsonb_array_length(intent->''promotions'') NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION ''Purchase cancellation gift intent invalid'' USING ERRCODE=''23514'';
      END IF;
      FOR campaign IN SELECT value FROM jsonb_array_elements(intent->''promotions'') LOOP
        IF jsonb_typeof(campaign) IS DISTINCT FROM ''object''
          OR jsonb_typeof(campaign->''products'') IS DISTINCT FROM ''array''
          OR jsonb_typeof(campaign->''eligible_cart_ids'') IS DISTINCT FROM ''array''
          OR jsonb_array_length(campaign->''products'')>100
          OR jsonb_array_length(campaign->''eligible_cart_ids'') NOT BETWEEN 1 AND 200
          OR (campaign->>''id'') !~ ''^[1-9][0-9]{0,9}$''
          OR (campaign->>''tier_id'') !~ ''^[1-9][0-9]{0,9}$'' THEN
          RAISE EXCEPTION ''Purchase cancellation gift campaign invalid'' USING ERRCODE=''23514'';
        END IF;
        FOR eligible IN SELECT value FROM jsonb_array_elements(campaign->''eligible_cart_ids'') LOOP
          eligible_id := eligible #>> ''{}'';
          IF jsonb_typeof(eligible)<>''string'' OR NOT eligible_id=ANY(purchased_claimed) THEN
            RAISE EXCEPTION ''Purchase cancellation gift eligibility differs from purchase'' USING ERRCODE=''23514'';
          END IF;
        END LOOP;
        FOR gift IN SELECT value FROM jsonb_array_elements(campaign->''products'') LOOP
          gift_key := gift->>''cart_id'';
          IF jsonb_typeof(gift) IS DISTINCT FROM ''object''
            OR jsonb_typeof(gift->''cart_id'') IS DISTINCT FROM ''string''
            OR gift_key IS NULL OR gift_key !~ ''^[1-9][0-9]{0,9}$''
            OR gift_key::bigint>2147483647
            OR gift_map ? gift_key OR gift_key=ANY(purchased_claimed)
            OR NOT gift_key=ANY(claimed)
            OR (gift->>''product_id'') !~ ''^[1-9][0-9]{0,9}$''
            OR (gift->>''sku_id'') !~ ''^[1-9][0-9]{0,9}$''
            OR (gift->>''aux_id'') !~ ''^[1-9][0-9]{0,9}$''
            OR (gift->>''quantity'') !~ ''^[1-9][0-9]{0,9}$''
            OR jsonb_typeof(gift->''unique'')<>''string''
            OR length(gift->>''unique'') NOT BETWEEN 1 AND 8 THEN
            RAISE EXCEPTION ''Purchase cancellation gift identity invalid'' USING ERRCODE=''23514'';
          END IF;
          gift_count := gift_count+1;
          gift_total := gift_total+(gift->>''quantity'')::bigint;
          IF gift_count>200-cardinality(claimed) OR gift_total>2147483647 THEN
            RAISE EXCEPTION ''Purchase cancellation gift quantity exceeds bounds'' USING ERRCODE=''23514'';
          END IF;
          gift_map := gift_map||jsonb_build_object(gift_key,jsonb_build_object(
            ''root_id'',(campaign->>''id'')::integer,''tier_id'',(campaign->>''tier_id'')::integer,
            ''aux_id'',(gift->>''aux_id'')::integer,''product_id'',(gift->>''product_id'')::integer,
            ''sku_id'',(gift->>''sku_id'')::integer,''unique'',gift->>''unique'',
            ''quantity'',(gift->>''quantity'')::integer));
        END LOOP;
      END LOOP;
    END IF;
  END IF;
  IF parent.total_num IS DISTINCT FROM NEW.total_num+gift_total THEN
    RAISE EXCEPTION ''Purchase cancellation physical quantity differs from origin and gifts'' USING ERRCODE=''23514'';
  END IF;
  FOR item IN SELECT id,uid,cart_id,old_cart_id,product_id,sku_unique,cart_num,refund_num,
    split_status,split_surplus_num,surplus_num,is_writeoff,is_gift,product_type,
    settle_price,write_times,write_surplus_times,promotions_id,
    CASE WHEN octet_length(cart_info)<=65536 THEN cart_info ELSE NULL END AS snapshot
    FROM public.store_order_cart_info WHERE oid=parent.id ORDER BY id LIMIT 201 FOR UPDATE
  LOOP
    IF rows>=200 OR item.snapshot IS NULL OR item.uid IS DISTINCT FROM NEW.buyer_id
      OR item.old_cart_id <> '''' OR item.refund_num <> 0 OR item.split_status <> 0
      OR item.split_surplus_num <> item.cart_num OR item.surplus_num <> item.cart_num OR item.is_writeoff <> 0
      OR item.cart_id=ANY(carts) OR item.is_gift NOT IN (0,1) THEN
      RAISE EXCEPTION ''Purchase cancellation line ownership or state invalid'' USING ERRCODE=''23514'';
    END IF;
    bytes := bytes + octet_length(item.snapshot);
    IF bytes>8388608 THEN RAISE EXCEPTION ''Purchase cancellation snapshots too large'' USING ERRCODE=''23514''; END IF;
    info := item.snapshot::jsonb;
    IF jsonb_typeof(info) IS DISTINCT FROM ''object''
      OR info->>''financial_version'' IS DISTINCT FROM ''checkout-line-finance-v1''
      OR info ? ''refund_order_generation'' OR info->''id'' IS DISTINCT FROM to_jsonb(item.cart_id)
      OR info->''cart_num'' IS DISTINCT FROM to_jsonb(item.cart_num)
      OR info#>''{product,id}'' IS DISTINCT FROM to_jsonb(item.product_id) THEN
      RAISE EXCEPTION ''Purchase cancellation snapshot identity invalid'' USING ERRCODE=''23514'';
    END IF;
    IF item.is_gift=0 THEN
      expected := NEW.lines->purchased_rows;
      IF NOT item.cart_id=ANY(purchased_claimed) OR expected IS NULL OR info ? ''promotion_gift''
        OR info#>''{sku,id}'' IS DISTINCT FROM expected->''skuId''
        OR NOT (info#>''{sku,unique}'' IS NOT DISTINCT FROM to_jsonb(item.sku_unique)
          OR (parent.type IN (1,2,3) AND info#>''{activitySku,unique}'' IS NOT DISTINCT FROM to_jsonb(item.sku_unique)))
        OR info->''use_integral'' IS DISTINCT FROM to_jsonb(expected->>''usedPoints'')
        OR expected->''rowId'' IS DISTINCT FROM to_jsonb(item.id)
        OR expected->''cartId'' IS DISTINCT FROM to_jsonb(item.cart_id)
        OR expected->''productId'' IS DISTINCT FROM to_jsonb(item.product_id)
        OR expected->''skuUnique'' IS DISTINCT FROM to_jsonb(item.sku_unique)
        OR expected->''quantity'' IS DISTINCT FROM to_jsonb(item.cart_num) THEN
        RAISE EXCEPTION ''Purchase cancellation lines differ from original purchase'' USING ERRCODE=''23514'';
      END IF;
      purchased_rows := purchased_rows+1;
    ELSE
      expected_gift := gift_map->item.cart_id;
      marker := info->''promotion_gift'';
      IF expected_gift IS NULL OR item.cart_id=ANY(gift_seen)
        OR item.product_id IS DISTINCT FROM (expected_gift->>''product_id'')::integer
        OR item.sku_unique IS DISTINCT FROM expected_gift->>''unique''
        OR item.cart_num IS DISTINCT FROM (expected_gift->>''quantity'')::integer
        OR info#>''{sku,id}'' IS DISTINCT FROM expected_gift->''sku_id''
        OR info#>''{sku,unique}'' IS DISTINCT FROM expected_gift->''unique''
        OR marker IS DISTINCT FROM jsonb_build_object(''version'',''order-promotion-gifts-v1'',
          ''root_id'',(expected_gift->>''root_id'')::integer,
          ''tier_id'',(expected_gift->>''tier_id'')::integer,
          ''aux_id'',(expected_gift->>''aux_id'')::integer)
        OR item.promotions_id IS DISTINCT FROM expected_gift->>''root_id''
        OR item.product_type<>0 OR item.settle_price<>0
        OR item.write_times<>item.cart_num OR item.write_surplus_times<>item.cart_num
        OR info->>''use_integral'' IS DISTINCT FROM ''0'' OR info->''integral'' IS DISTINCT FROM ''0''::jsonb
        OR info#>>''{sku,price}'' IS DISTINCT FROM ''0.00''
        OR info->>''gain_integral'' IS DISTINCT FROM ''0''
        OR EXISTS(SELECT 1 FROM jsonb_each_text(info) kv WHERE kv.key=ANY(ARRAY[
          ''sum_price'',''vip_truePrice'',''member_postage_price'',''member_coupon_price'',
          ''raw_postage_price'',''postage_price'',''coupon_price'',''integral_price'',
          ''first_order_price'',''sum_true_price'',''promotions_true_price'',''costPrice'',
          ''one_brokerage'',''two_brokerage'',''division_staff_brokerage'',
          ''division_agent_brokerage'',''division_brokerage'']) AND kv.value<>''0.00'')
        OR (SELECT count(*) FROM jsonb_each_text(info) kv WHERE kv.key=ANY(ARRAY[
          ''sum_price'',''vip_truePrice'',''member_postage_price'',''member_coupon_price'',
          ''raw_postage_price'',''postage_price'',''coupon_price'',''integral_price'',
          ''first_order_price'',''sum_true_price'',''promotions_true_price'',''costPrice'',
          ''one_brokerage'',''two_brokerage'',''division_staff_brokerage'',
          ''division_agent_brokerage'',''division_brokerage'']))<>17 THEN
        RAISE EXCEPTION ''Purchase cancellation gift row differs from strict intent'' USING ERRCODE=''23514'';
      END IF;
      gift_seen := array_append(gift_seen,item.cart_id);
      gift_rows := gift_rows+1;
    END IF;
    rows := rows+1; carts := array_append(carts,item.cart_id);
  END LOOP;
  IF purchased_rows<>jsonb_array_length(NEW.lines) OR purchased_rows<>cardinality(purchased_claimed)
    OR gift_rows<>gift_count OR rows<>purchased_rows+gift_rows
    OR cardinality(claimed)<>purchased_rows+gift_rows THEN
    RAISE EXCEPTION ''Purchase cancellation line coverage incomplete'' USING ERRCODE=''23514'';
  END IF;
  SELECT count(*) INTO log_count FROM (SELECT id FROM public.store_order_status
    WHERE oid=NEW.order_id AND change_type=''cancel'' LIMIT 2) s;
  IF log_count<>1 THEN RAISE EXCEPTION ''Purchase cancellation log missing or ambiguous'' USING ERRCODE=''23514''; END IF;
  FOR bills IN SELECT uid,pm,event_key,number,status FROM public.user_bill
    WHERE category=''integral'' AND type=''deduction'' AND link_id=NEW.order_id::text LIMIT 2
  LOOP
    deduction_count := deduction_count+1;
    IF bills.uid<>NEW.buyer_id OR bills.pm<>0 OR bills.event_key<>''order_integral_deduction''
      OR bills.status<>1 OR bills.number<>NEW.restored_points THEN
      RAISE EXCEPTION ''Purchase cancellation original points ledger inconsistent'' USING ERRCODE=''23514'';
    END IF;
  END LOOP;
  FOR bills IN SELECT uid,pm,event_key,number,status FROM public.user_bill
    WHERE category=''integral'' AND type=''order_cancel'' AND link_id=NEW.order_id::text LIMIT 2
  LOOP
    restoration_count := restoration_count+1;
    IF bills.uid<>NEW.buyer_id OR bills.pm<>1 OR bills.event_key<>''order_cancel_integral_back''
      OR bills.status<>1 OR bills.number<>NEW.restored_points THEN
      RAISE EXCEPTION ''Purchase cancellation restored points ledger inconsistent'' USING ERRCODE=''23514'';
    END IF;
  END LOOP;
  IF (NEW.restored_points>0 AND (deduction_count<>1 OR restoration_count<>1))
    OR (NEW.restored_points=0 AND (deduction_count<>0 OR restoration_count<>0)) THEN
    RAISE EXCEPTION ''Purchase cancellation points ledger missing or ambiguous'' USING ERRCODE=''23514'';
  END IF;
  RETURN NEW;
END '
      AND v.prokind='f' AND v.pronargs=0 AND v.prorettype='trigger'::regtype AND NOT v.proretset
      AND NOT v.prosecdef AND NOT v.proleakproof AND v.provolatile='v' AND v.proparallel='u'
      AND NOT v.proisstrict AND v.proconfig=ARRAY['search_path=pg_catalog']::text[]
      AND v.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
      AND v.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)) THEN 'gift-v1'
  ELSE legacy.state END AS state FROM legacy CROSS JOIN snapshot) s;
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
  IF initial_state NOT IN ('v1','gift-v1') OR NOT sources_ready THEN
    RAISE EXCEPTION 'Purchase cancellation gift forward requires exact prior evidence and sources';
  END IF;
  LOCK TABLE ONLY public.store_order IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  LOCK TABLE ONLY public.store_order_cart_info IN SHARE MODE NOWAIT;
  LOCK TABLE ONLY public.store_order_purchase_origin IN SHARE MODE NOWAIT;
  LOCK TABLE ONLY public.store_order_status IN SHARE MODE NOWAIT;
  LOCK TABLE ONLY public.user_bill IN SHARE MODE NOWAIT;
  LOCK TABLE ONLY public.store_order_purchase_cancellation IN ACCESS EXCLUSIVE MODE NOWAIT;
  SELECT state INTO final_state FROM (WITH legacy AS (WITH catalog AS (
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
  ELSE 'drift' END AS state FROM snapshot),
  catalog AS (
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
  snapshot AS (SELECT count(*) AS n,jsonb_object_agg(name,to_jsonb(catalog)) AS objects FROM catalog),
  validator AS (SELECT p.prosrc,p.prokind,p.pronargs,p.prorettype,p.proretset,
      p.prosecdef,p.proleakproof,p.provolatile,p.proparallel,p.proisstrict,
      p.proconfig,p.prolang,p.proowner
    FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.validate_purchase_cancellation_v1()'))
SELECT CASE WHEN legacy.state='v1' THEN 'v1'
  WHEN snapshot.n=6 AND (objects->'store_order_purchase_cancellation') @> '{"owned":true,"safe":true,"fingerprint":"bd28aae90f21d33e47870f977d5de0d8be8ecf85c35dfe26eccdab9aa47f4729"}'::jsonb AND (objects->'begin_purchase_cancellation_v1') @> '{"owned":true,"safe":true,"fingerprint":"f8fa73642f10e09097b498fcd8719de20cb5a902783d95d757dab11e02918c19"}'::jsonb AND (objects->'capture_purchase_cancellation_v1') @> '{"owned":true,"safe":true,"fingerprint":"5212ccba912454c3cdcd3d53b0e8b6d1ee1272d0df10e01fec534815069c71e2"}'::jsonb AND (objects->'protect_purchase_cancellation_v1') @> '{"owned":true,"safe":true,"fingerprint":"2666faef1c503cc067a096b147f3070874c2b885ab14a20422bbdb2a430277ec"}'::jsonb AND (objects->'sopc_order_transition') @> '{"owned":true,"safe":true,"fingerprint":"aba99ae49b039104eeb7c079426302ffc5bd25fd8baf1797a7eb65ae1723ce15"}'::jsonb
    AND (snapshot.objects->'validate_purchase_cancellation_v1') @> '{"owned":true,"safe":true}'::jsonb
    AND EXISTS(SELECT 1 FROM validator v WHERE v.prosrc='
DECLARE parent record; item record; info jsonb; expected jsonb; bills record;
  campaign jsonb; gift jsonb; marker jsonb; intent jsonb; expected_gift jsonb;
  gift_map jsonb := ''{}''::jsonb; gift_key text; eligible jsonb; eligible_id text;
  rows integer := 0; purchased_rows integer := 0; gift_rows integer := 0;
  gift_count integer := 0; gift_total bigint := 0; bytes bigint := 0;
  claimed text[]; purchased_claimed text[] := ARRAY[]::text[];
  carts text[] := ARRAY[]::text[]; gift_seen text[] := ARRAY[]::text[];
  log_count integer; deduction_count integer := 0; restoration_count integer := 0;
BEGIN
  IF TG_OP <> ''INSERT'' OR TG_TABLE_SCHEMA <> ''public'' OR TG_TABLE_NAME <> ''store_order_purchase_cancellation'' THEN
    RAISE EXCEPTION ''Invalid purchase cancellation validation source'' USING ERRCODE=''23514'';
  END IF;
  SELECT id,uid,type,pid,paid,status,is_del,is_system_del,supplier_allocation_status,
    refund_status,refund_type,total_num,use_integral,cart_id,promotions_give INTO parent
    FROM public.store_order WHERE id=NEW.order_id FOR UPDATE;
  IF NOT FOUND OR parent.uid IS DISTINCT FROM NEW.buyer_id OR parent.type IS DISTINCT FROM NEW.order_type
    OR parent.use_integral IS DISTINCT FROM NEW.restored_points
    OR parent.paid <> 0 OR parent.status <> -2 OR parent.is_del <> 1 OR parent.is_system_del <> 0
    OR parent.pid <> 0 OR parent.supplier_allocation_status NOT IN (0,1)
    OR parent.refund_status <> 0 OR parent.refund_type <> 0
    OR EXISTS(SELECT 1 FROM public.store_order WHERE pid=parent.id) THEN
    RAISE EXCEPTION ''Purchase cancellation final root does not match origin'' USING ERRCODE=''23514'';
  END IF;
  IF parent.cart_id IS NULL OR length(parent.cart_id)>2199
    OR parent.cart_id !~ ''^[1-9][0-9]{0,9}(,[1-9][0-9]{0,9}){0,199}$'' THEN
    RAISE EXCEPTION ''Purchase cancellation cart identities invalid'' USING ERRCODE=''23514'';
  END IF;
  claimed := string_to_array(parent.cart_id, '','');
  IF cardinality(claimed) <> (SELECT count(DISTINCT value) FROM unnest(claimed) AS value) THEN
    RAISE EXCEPTION ''Purchase cancellation cart identities repeat'' USING ERRCODE=''23514'';
  END IF;
  FOR expected IN SELECT value FROM jsonb_array_elements(NEW.lines) LOOP
    IF jsonb_typeof(expected->''cartId'') IS DISTINCT FROM ''string''
      OR (expected->>''cartId'') !~ ''^[1-9][0-9]{0,9}$''
      OR (expected->>''cartId'')::bigint>2147483647
      OR NOT (expected->>''cartId'')=ANY(claimed)
      OR (expected->>''cartId'')=ANY(purchased_claimed) THEN
      RAISE EXCEPTION ''Purchase cancellation origin cart identities invalid'' USING ERRCODE=''23514'';
    END IF;
    purchased_claimed := array_append(purchased_claimed,expected->>''cartId'');
  END LOOP;
  IF parent.promotions_give IS NOT NULL AND parent.promotions_give NOT IN ('''',''null'') THEN
    IF octet_length(parent.promotions_give)>65536 THEN
      RAISE EXCEPTION ''Purchase cancellation gift intent too large'' USING ERRCODE=''23514'';
    END IF;
    intent := parent.promotions_give::jsonb;
    IF jsonb_typeof(intent)=''object'' AND intent->>''version''=''order-promotion-gifts-v1'' THEN
      IF jsonb_typeof(intent->''promotions'') IS DISTINCT FROM ''array''
        OR jsonb_array_length(intent->''promotions'') NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION ''Purchase cancellation gift intent invalid'' USING ERRCODE=''23514'';
      END IF;
      FOR campaign IN SELECT value FROM jsonb_array_elements(intent->''promotions'') LOOP
        IF jsonb_typeof(campaign) IS DISTINCT FROM ''object''
          OR jsonb_typeof(campaign->''products'') IS DISTINCT FROM ''array''
          OR jsonb_typeof(campaign->''eligible_cart_ids'') IS DISTINCT FROM ''array''
          OR jsonb_array_length(campaign->''products'')>100
          OR jsonb_array_length(campaign->''eligible_cart_ids'') NOT BETWEEN 1 AND 200
          OR (campaign->>''id'') !~ ''^[1-9][0-9]{0,9}$''
          OR (campaign->>''tier_id'') !~ ''^[1-9][0-9]{0,9}$'' THEN
          RAISE EXCEPTION ''Purchase cancellation gift campaign invalid'' USING ERRCODE=''23514'';
        END IF;
        FOR eligible IN SELECT value FROM jsonb_array_elements(campaign->''eligible_cart_ids'') LOOP
          eligible_id := eligible #>> ''{}'';
          IF jsonb_typeof(eligible)<>''string'' OR NOT eligible_id=ANY(purchased_claimed) THEN
            RAISE EXCEPTION ''Purchase cancellation gift eligibility differs from purchase'' USING ERRCODE=''23514'';
          END IF;
        END LOOP;
        FOR gift IN SELECT value FROM jsonb_array_elements(campaign->''products'') LOOP
          gift_key := gift->>''cart_id'';
          IF jsonb_typeof(gift) IS DISTINCT FROM ''object''
            OR jsonb_typeof(gift->''cart_id'') IS DISTINCT FROM ''string''
            OR gift_key IS NULL OR gift_key !~ ''^[1-9][0-9]{0,9}$''
            OR gift_key::bigint>2147483647
            OR gift_map ? gift_key OR gift_key=ANY(purchased_claimed)
            OR NOT gift_key=ANY(claimed)
            OR (gift->>''product_id'') !~ ''^[1-9][0-9]{0,9}$''
            OR (gift->>''sku_id'') !~ ''^[1-9][0-9]{0,9}$''
            OR (gift->>''aux_id'') !~ ''^[1-9][0-9]{0,9}$''
            OR (gift->>''quantity'') !~ ''^[1-9][0-9]{0,9}$''
            OR jsonb_typeof(gift->''unique'')<>''string''
            OR length(gift->>''unique'') NOT BETWEEN 1 AND 8 THEN
            RAISE EXCEPTION ''Purchase cancellation gift identity invalid'' USING ERRCODE=''23514'';
          END IF;
          gift_count := gift_count+1;
          gift_total := gift_total+(gift->>''quantity'')::bigint;
          IF gift_count>200-cardinality(claimed) OR gift_total>2147483647 THEN
            RAISE EXCEPTION ''Purchase cancellation gift quantity exceeds bounds'' USING ERRCODE=''23514'';
          END IF;
          gift_map := gift_map||jsonb_build_object(gift_key,jsonb_build_object(
            ''root_id'',(campaign->>''id'')::integer,''tier_id'',(campaign->>''tier_id'')::integer,
            ''aux_id'',(gift->>''aux_id'')::integer,''product_id'',(gift->>''product_id'')::integer,
            ''sku_id'',(gift->>''sku_id'')::integer,''unique'',gift->>''unique'',
            ''quantity'',(gift->>''quantity'')::integer));
        END LOOP;
      END LOOP;
    END IF;
  END IF;
  IF parent.total_num IS DISTINCT FROM NEW.total_num+gift_total THEN
    RAISE EXCEPTION ''Purchase cancellation physical quantity differs from origin and gifts'' USING ERRCODE=''23514'';
  END IF;
  FOR item IN SELECT id,uid,cart_id,old_cart_id,product_id,sku_unique,cart_num,refund_num,
    split_status,split_surplus_num,surplus_num,is_writeoff,is_gift,product_type,
    settle_price,write_times,write_surplus_times,promotions_id,
    CASE WHEN octet_length(cart_info)<=65536 THEN cart_info ELSE NULL END AS snapshot
    FROM public.store_order_cart_info WHERE oid=parent.id ORDER BY id LIMIT 201 FOR UPDATE
  LOOP
    IF rows>=200 OR item.snapshot IS NULL OR item.uid IS DISTINCT FROM NEW.buyer_id
      OR item.old_cart_id <> '''' OR item.refund_num <> 0 OR item.split_status <> 0
      OR item.split_surplus_num <> item.cart_num OR item.surplus_num <> item.cart_num OR item.is_writeoff <> 0
      OR item.cart_id=ANY(carts) OR item.is_gift NOT IN (0,1) THEN
      RAISE EXCEPTION ''Purchase cancellation line ownership or state invalid'' USING ERRCODE=''23514'';
    END IF;
    bytes := bytes + octet_length(item.snapshot);
    IF bytes>8388608 THEN RAISE EXCEPTION ''Purchase cancellation snapshots too large'' USING ERRCODE=''23514''; END IF;
    info := item.snapshot::jsonb;
    IF jsonb_typeof(info) IS DISTINCT FROM ''object''
      OR info->>''financial_version'' IS DISTINCT FROM ''checkout-line-finance-v1''
      OR info ? ''refund_order_generation'' OR info->''id'' IS DISTINCT FROM to_jsonb(item.cart_id)
      OR info->''cart_num'' IS DISTINCT FROM to_jsonb(item.cart_num)
      OR info#>''{product,id}'' IS DISTINCT FROM to_jsonb(item.product_id) THEN
      RAISE EXCEPTION ''Purchase cancellation snapshot identity invalid'' USING ERRCODE=''23514'';
    END IF;
    IF item.is_gift=0 THEN
      expected := NEW.lines->purchased_rows;
      IF NOT item.cart_id=ANY(purchased_claimed) OR expected IS NULL OR info ? ''promotion_gift''
        OR info#>''{sku,id}'' IS DISTINCT FROM expected->''skuId''
        OR NOT (info#>''{sku,unique}'' IS NOT DISTINCT FROM to_jsonb(item.sku_unique)
          OR (parent.type IN (1,2,3) AND info#>''{activitySku,unique}'' IS NOT DISTINCT FROM to_jsonb(item.sku_unique)))
        OR info->''use_integral'' IS DISTINCT FROM to_jsonb(expected->>''usedPoints'')
        OR expected->''rowId'' IS DISTINCT FROM to_jsonb(item.id)
        OR expected->''cartId'' IS DISTINCT FROM to_jsonb(item.cart_id)
        OR expected->''productId'' IS DISTINCT FROM to_jsonb(item.product_id)
        OR expected->''skuUnique'' IS DISTINCT FROM to_jsonb(item.sku_unique)
        OR expected->''quantity'' IS DISTINCT FROM to_jsonb(item.cart_num) THEN
        RAISE EXCEPTION ''Purchase cancellation lines differ from original purchase'' USING ERRCODE=''23514'';
      END IF;
      purchased_rows := purchased_rows+1;
    ELSE
      expected_gift := gift_map->item.cart_id;
      marker := info->''promotion_gift'';
      IF expected_gift IS NULL OR item.cart_id=ANY(gift_seen)
        OR item.product_id IS DISTINCT FROM (expected_gift->>''product_id'')::integer
        OR item.sku_unique IS DISTINCT FROM expected_gift->>''unique''
        OR item.cart_num IS DISTINCT FROM (expected_gift->>''quantity'')::integer
        OR info#>''{sku,id}'' IS DISTINCT FROM expected_gift->''sku_id''
        OR info#>''{sku,unique}'' IS DISTINCT FROM expected_gift->''unique''
        OR marker IS DISTINCT FROM jsonb_build_object(''version'',''order-promotion-gifts-v1'',
          ''root_id'',(expected_gift->>''root_id'')::integer,
          ''tier_id'',(expected_gift->>''tier_id'')::integer,
          ''aux_id'',(expected_gift->>''aux_id'')::integer)
        OR item.promotions_id IS DISTINCT FROM expected_gift->>''root_id''
        OR item.product_type<>0 OR item.settle_price<>0
        OR item.write_times<>item.cart_num OR item.write_surplus_times<>item.cart_num
        OR info->>''use_integral'' IS DISTINCT FROM ''0'' OR info->''integral'' IS DISTINCT FROM ''0''::jsonb
        OR info#>>''{sku,price}'' IS DISTINCT FROM ''0.00''
        OR info->>''gain_integral'' IS DISTINCT FROM ''0''
        OR EXISTS(SELECT 1 FROM jsonb_each_text(info) kv WHERE kv.key=ANY(ARRAY[
          ''sum_price'',''vip_truePrice'',''member_postage_price'',''member_coupon_price'',
          ''raw_postage_price'',''postage_price'',''coupon_price'',''integral_price'',
          ''first_order_price'',''sum_true_price'',''promotions_true_price'',''costPrice'',
          ''one_brokerage'',''two_brokerage'',''division_staff_brokerage'',
          ''division_agent_brokerage'',''division_brokerage'']) AND kv.value<>''0.00'')
        OR (SELECT count(*) FROM jsonb_each_text(info) kv WHERE kv.key=ANY(ARRAY[
          ''sum_price'',''vip_truePrice'',''member_postage_price'',''member_coupon_price'',
          ''raw_postage_price'',''postage_price'',''coupon_price'',''integral_price'',
          ''first_order_price'',''sum_true_price'',''promotions_true_price'',''costPrice'',
          ''one_brokerage'',''two_brokerage'',''division_staff_brokerage'',
          ''division_agent_brokerage'',''division_brokerage'']))<>17 THEN
        RAISE EXCEPTION ''Purchase cancellation gift row differs from strict intent'' USING ERRCODE=''23514'';
      END IF;
      gift_seen := array_append(gift_seen,item.cart_id);
      gift_rows := gift_rows+1;
    END IF;
    rows := rows+1; carts := array_append(carts,item.cart_id);
  END LOOP;
  IF purchased_rows<>jsonb_array_length(NEW.lines) OR purchased_rows<>cardinality(purchased_claimed)
    OR gift_rows<>gift_count OR rows<>purchased_rows+gift_rows
    OR cardinality(claimed)<>purchased_rows+gift_rows THEN
    RAISE EXCEPTION ''Purchase cancellation line coverage incomplete'' USING ERRCODE=''23514'';
  END IF;
  SELECT count(*) INTO log_count FROM (SELECT id FROM public.store_order_status
    WHERE oid=NEW.order_id AND change_type=''cancel'' LIMIT 2) s;
  IF log_count<>1 THEN RAISE EXCEPTION ''Purchase cancellation log missing or ambiguous'' USING ERRCODE=''23514''; END IF;
  FOR bills IN SELECT uid,pm,event_key,number,status FROM public.user_bill
    WHERE category=''integral'' AND type=''deduction'' AND link_id=NEW.order_id::text LIMIT 2
  LOOP
    deduction_count := deduction_count+1;
    IF bills.uid<>NEW.buyer_id OR bills.pm<>0 OR bills.event_key<>''order_integral_deduction''
      OR bills.status<>1 OR bills.number<>NEW.restored_points THEN
      RAISE EXCEPTION ''Purchase cancellation original points ledger inconsistent'' USING ERRCODE=''23514'';
    END IF;
  END LOOP;
  FOR bills IN SELECT uid,pm,event_key,number,status FROM public.user_bill
    WHERE category=''integral'' AND type=''order_cancel'' AND link_id=NEW.order_id::text LIMIT 2
  LOOP
    restoration_count := restoration_count+1;
    IF bills.uid<>NEW.buyer_id OR bills.pm<>1 OR bills.event_key<>''order_cancel_integral_back''
      OR bills.status<>1 OR bills.number<>NEW.restored_points THEN
      RAISE EXCEPTION ''Purchase cancellation restored points ledger inconsistent'' USING ERRCODE=''23514'';
    END IF;
  END LOOP;
  IF (NEW.restored_points>0 AND (deduction_count<>1 OR restoration_count<>1))
    OR (NEW.restored_points=0 AND (deduction_count<>0 OR restoration_count<>0)) THEN
    RAISE EXCEPTION ''Purchase cancellation points ledger missing or ambiguous'' USING ERRCODE=''23514'';
  END IF;
  RETURN NEW;
END '
      AND v.prokind='f' AND v.pronargs=0 AND v.prorettype='trigger'::regtype AND NOT v.proretset
      AND NOT v.prosecdef AND NOT v.proleakproof AND v.provolatile='v' AND v.proparallel='u'
      AND NOT v.proisstrict AND v.proconfig=ARRAY['search_path=pg_catalog']::text[]
      AND v.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
      AND v.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)) THEN 'gift-v1'
  ELSE legacy.state END AS state FROM legacy CROSS JOIN snapshot) s;
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
  IF final_state IS DISTINCT FROM initial_state OR NOT sources_ready THEN
    RAISE EXCEPTION 'Purchase cancellation gift catalog changed during locking';
  END IF;
  IF initial_state='v1' THEN
    EXECUTE $gift_validate$CREATE OR REPLACE FUNCTION public.validate_purchase_cancellation_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE parent record; item record; info jsonb; expected jsonb; bills record;
  campaign jsonb; gift jsonb; marker jsonb; intent jsonb; expected_gift jsonb;
  gift_map jsonb := '{}'::jsonb; gift_key text; eligible jsonb; eligible_id text;
  rows integer := 0; purchased_rows integer := 0; gift_rows integer := 0;
  gift_count integer := 0; gift_total bigint := 0; bytes bigint := 0;
  claimed text[]; purchased_claimed text[] := ARRAY[]::text[];
  carts text[] := ARRAY[]::text[]; gift_seen text[] := ARRAY[]::text[];
  log_count integer; deduction_count integer := 0; restoration_count integer := 0;
BEGIN
  IF TG_OP <> 'INSERT' OR TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'store_order_purchase_cancellation' THEN
    RAISE EXCEPTION 'Invalid purchase cancellation validation source' USING ERRCODE='23514';
  END IF;
  SELECT id,uid,type,pid,paid,status,is_del,is_system_del,supplier_allocation_status,
    refund_status,refund_type,total_num,use_integral,cart_id,promotions_give INTO parent
    FROM public.store_order WHERE id=NEW.order_id FOR UPDATE;
  IF NOT FOUND OR parent.uid IS DISTINCT FROM NEW.buyer_id OR parent.type IS DISTINCT FROM NEW.order_type
    OR parent.use_integral IS DISTINCT FROM NEW.restored_points
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
  IF cardinality(claimed) <> (SELECT count(DISTINCT value) FROM unnest(claimed) AS value) THEN
    RAISE EXCEPTION 'Purchase cancellation cart identities repeat' USING ERRCODE='23514';
  END IF;
  FOR expected IN SELECT value FROM jsonb_array_elements(NEW.lines) LOOP
    IF jsonb_typeof(expected->'cartId') IS DISTINCT FROM 'string'
      OR (expected->>'cartId') !~ '^[1-9][0-9]{0,9}$'
      OR (expected->>'cartId')::bigint>2147483647
      OR NOT (expected->>'cartId')=ANY(claimed)
      OR (expected->>'cartId')=ANY(purchased_claimed) THEN
      RAISE EXCEPTION 'Purchase cancellation origin cart identities invalid' USING ERRCODE='23514';
    END IF;
    purchased_claimed := array_append(purchased_claimed,expected->>'cartId');
  END LOOP;
  IF parent.promotions_give IS NOT NULL AND parent.promotions_give NOT IN ('','null') THEN
    IF octet_length(parent.promotions_give)>65536 THEN
      RAISE EXCEPTION 'Purchase cancellation gift intent too large' USING ERRCODE='23514';
    END IF;
    intent := parent.promotions_give::jsonb;
    IF jsonb_typeof(intent)='object' AND intent->>'version'='order-promotion-gifts-v1' THEN
      IF jsonb_typeof(intent->'promotions') IS DISTINCT FROM 'array'
        OR jsonb_array_length(intent->'promotions') NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'Purchase cancellation gift intent invalid' USING ERRCODE='23514';
      END IF;
      FOR campaign IN SELECT value FROM jsonb_array_elements(intent->'promotions') LOOP
        IF jsonb_typeof(campaign) IS DISTINCT FROM 'object'
          OR jsonb_typeof(campaign->'products') IS DISTINCT FROM 'array'
          OR jsonb_typeof(campaign->'eligible_cart_ids') IS DISTINCT FROM 'array'
          OR jsonb_array_length(campaign->'products')>100
          OR jsonb_array_length(campaign->'eligible_cart_ids') NOT BETWEEN 1 AND 200
          OR (campaign->>'id') !~ '^[1-9][0-9]{0,9}$'
          OR (campaign->>'tier_id') !~ '^[1-9][0-9]{0,9}$' THEN
          RAISE EXCEPTION 'Purchase cancellation gift campaign invalid' USING ERRCODE='23514';
        END IF;
        FOR eligible IN SELECT value FROM jsonb_array_elements(campaign->'eligible_cart_ids') LOOP
          eligible_id := eligible #>> '{}';
          IF jsonb_typeof(eligible)<>'string' OR NOT eligible_id=ANY(purchased_claimed) THEN
            RAISE EXCEPTION 'Purchase cancellation gift eligibility differs from purchase' USING ERRCODE='23514';
          END IF;
        END LOOP;
        FOR gift IN SELECT value FROM jsonb_array_elements(campaign->'products') LOOP
          gift_key := gift->>'cart_id';
          IF jsonb_typeof(gift) IS DISTINCT FROM 'object'
            OR jsonb_typeof(gift->'cart_id') IS DISTINCT FROM 'string'
            OR gift_key IS NULL OR gift_key !~ '^[1-9][0-9]{0,9}$'
            OR gift_key::bigint>2147483647
            OR gift_map ? gift_key OR gift_key=ANY(purchased_claimed)
            OR NOT gift_key=ANY(claimed)
            OR (gift->>'product_id') !~ '^[1-9][0-9]{0,9}$'
            OR (gift->>'sku_id') !~ '^[1-9][0-9]{0,9}$'
            OR (gift->>'aux_id') !~ '^[1-9][0-9]{0,9}$'
            OR (gift->>'quantity') !~ '^[1-9][0-9]{0,9}$'
            OR jsonb_typeof(gift->'unique')<>'string'
            OR length(gift->>'unique') NOT BETWEEN 1 AND 8 THEN
            RAISE EXCEPTION 'Purchase cancellation gift identity invalid' USING ERRCODE='23514';
          END IF;
          gift_count := gift_count+1;
          gift_total := gift_total+(gift->>'quantity')::bigint;
          IF gift_count>200-cardinality(claimed) OR gift_total>2147483647 THEN
            RAISE EXCEPTION 'Purchase cancellation gift quantity exceeds bounds' USING ERRCODE='23514';
          END IF;
          gift_map := gift_map||jsonb_build_object(gift_key,jsonb_build_object(
            'root_id',(campaign->>'id')::integer,'tier_id',(campaign->>'tier_id')::integer,
            'aux_id',(gift->>'aux_id')::integer,'product_id',(gift->>'product_id')::integer,
            'sku_id',(gift->>'sku_id')::integer,'unique',gift->>'unique',
            'quantity',(gift->>'quantity')::integer));
        END LOOP;
      END LOOP;
    END IF;
  END IF;
  IF parent.total_num IS DISTINCT FROM NEW.total_num+gift_total THEN
    RAISE EXCEPTION 'Purchase cancellation physical quantity differs from origin and gifts' USING ERRCODE='23514';
  END IF;
  FOR item IN SELECT id,uid,cart_id,old_cart_id,product_id,sku_unique,cart_num,refund_num,
    split_status,split_surplus_num,surplus_num,is_writeoff,is_gift,product_type,
    settle_price,write_times,write_surplus_times,promotions_id,
    CASE WHEN octet_length(cart_info)<=65536 THEN cart_info ELSE NULL END AS snapshot
    FROM public.store_order_cart_info WHERE oid=parent.id ORDER BY id LIMIT 201 FOR UPDATE
  LOOP
    IF rows>=200 OR item.snapshot IS NULL OR item.uid IS DISTINCT FROM NEW.buyer_id
      OR item.old_cart_id <> '' OR item.refund_num <> 0 OR item.split_status <> 0
      OR item.split_surplus_num <> item.cart_num OR item.surplus_num <> item.cart_num OR item.is_writeoff <> 0
      OR item.cart_id=ANY(carts) OR item.is_gift NOT IN (0,1) THEN
      RAISE EXCEPTION 'Purchase cancellation line ownership or state invalid' USING ERRCODE='23514';
    END IF;
    bytes := bytes + octet_length(item.snapshot);
    IF bytes>8388608 THEN RAISE EXCEPTION 'Purchase cancellation snapshots too large' USING ERRCODE='23514'; END IF;
    info := item.snapshot::jsonb;
    IF jsonb_typeof(info) IS DISTINCT FROM 'object'
      OR info->>'financial_version' IS DISTINCT FROM 'checkout-line-finance-v1'
      OR info ? 'refund_order_generation' OR info->'id' IS DISTINCT FROM to_jsonb(item.cart_id)
      OR info->'cart_num' IS DISTINCT FROM to_jsonb(item.cart_num)
      OR info#>'{product,id}' IS DISTINCT FROM to_jsonb(item.product_id) THEN
      RAISE EXCEPTION 'Purchase cancellation snapshot identity invalid' USING ERRCODE='23514';
    END IF;
    IF item.is_gift=0 THEN
      expected := NEW.lines->purchased_rows;
      IF NOT item.cart_id=ANY(purchased_claimed) OR expected IS NULL OR info ? 'promotion_gift'
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
      purchased_rows := purchased_rows+1;
    ELSE
      expected_gift := gift_map->item.cart_id;
      marker := info->'promotion_gift';
      IF expected_gift IS NULL OR item.cart_id=ANY(gift_seen)
        OR item.product_id IS DISTINCT FROM (expected_gift->>'product_id')::integer
        OR item.sku_unique IS DISTINCT FROM expected_gift->>'unique'
        OR item.cart_num IS DISTINCT FROM (expected_gift->>'quantity')::integer
        OR info#>'{sku,id}' IS DISTINCT FROM expected_gift->'sku_id'
        OR info#>'{sku,unique}' IS DISTINCT FROM expected_gift->'unique'
        OR marker IS DISTINCT FROM jsonb_build_object('version','order-promotion-gifts-v1',
          'root_id',(expected_gift->>'root_id')::integer,
          'tier_id',(expected_gift->>'tier_id')::integer,
          'aux_id',(expected_gift->>'aux_id')::integer)
        OR item.promotions_id IS DISTINCT FROM expected_gift->>'root_id'
        OR item.product_type<>0 OR item.settle_price<>0
        OR item.write_times<>item.cart_num OR item.write_surplus_times<>item.cart_num
        OR info->>'use_integral' IS DISTINCT FROM '0' OR info->'integral' IS DISTINCT FROM '0'::jsonb
        OR info#>>'{sku,price}' IS DISTINCT FROM '0.00'
        OR info->>'gain_integral' IS DISTINCT FROM '0'
        OR EXISTS(SELECT 1 FROM jsonb_each_text(info) kv WHERE kv.key=ANY(ARRAY[
          'sum_price','vip_truePrice','member_postage_price','member_coupon_price',
          'raw_postage_price','postage_price','coupon_price','integral_price',
          'first_order_price','sum_true_price','promotions_true_price','costPrice',
          'one_brokerage','two_brokerage','division_staff_brokerage',
          'division_agent_brokerage','division_brokerage']) AND kv.value<>'0.00')
        OR (SELECT count(*) FROM jsonb_each_text(info) kv WHERE kv.key=ANY(ARRAY[
          'sum_price','vip_truePrice','member_postage_price','member_coupon_price',
          'raw_postage_price','postage_price','coupon_price','integral_price',
          'first_order_price','sum_true_price','promotions_true_price','costPrice',
          'one_brokerage','two_brokerage','division_staff_brokerage',
          'division_agent_brokerage','division_brokerage']))<>17 THEN
        RAISE EXCEPTION 'Purchase cancellation gift row differs from strict intent' USING ERRCODE='23514';
      END IF;
      gift_seen := array_append(gift_seen,item.cart_id);
      gift_rows := gift_rows+1;
    END IF;
    rows := rows+1; carts := array_append(carts,item.cart_id);
  END LOOP;
  IF purchased_rows<>jsonb_array_length(NEW.lines) OR purchased_rows<>cardinality(purchased_claimed)
    OR gift_rows<>gift_count OR rows<>purchased_rows+gift_rows
    OR cardinality(claimed)<>purchased_rows+gift_rows THEN
    RAISE EXCEPTION 'Purchase cancellation line coverage incomplete' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO log_count FROM (SELECT id FROM public.store_order_status
    WHERE oid=NEW.order_id AND change_type='cancel' LIMIT 2) s;
  IF log_count<>1 THEN RAISE EXCEPTION 'Purchase cancellation log missing or ambiguous' USING ERRCODE='23514'; END IF;
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
END $$;$gift_validate$;
  END IF;
  SELECT state INTO final_state FROM (WITH legacy AS (WITH catalog AS (
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
  ELSE 'drift' END AS state FROM snapshot),
  catalog AS (
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
  snapshot AS (SELECT count(*) AS n,jsonb_object_agg(name,to_jsonb(catalog)) AS objects FROM catalog),
  validator AS (SELECT p.prosrc,p.prokind,p.pronargs,p.prorettype,p.proretset,
      p.prosecdef,p.proleakproof,p.provolatile,p.proparallel,p.proisstrict,
      p.proconfig,p.prolang,p.proowner
    FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.validate_purchase_cancellation_v1()'))
SELECT CASE WHEN legacy.state='v1' THEN 'v1'
  WHEN snapshot.n=6 AND (objects->'store_order_purchase_cancellation') @> '{"owned":true,"safe":true,"fingerprint":"bd28aae90f21d33e47870f977d5de0d8be8ecf85c35dfe26eccdab9aa47f4729"}'::jsonb AND (objects->'begin_purchase_cancellation_v1') @> '{"owned":true,"safe":true,"fingerprint":"f8fa73642f10e09097b498fcd8719de20cb5a902783d95d757dab11e02918c19"}'::jsonb AND (objects->'capture_purchase_cancellation_v1') @> '{"owned":true,"safe":true,"fingerprint":"5212ccba912454c3cdcd3d53b0e8b6d1ee1272d0df10e01fec534815069c71e2"}'::jsonb AND (objects->'protect_purchase_cancellation_v1') @> '{"owned":true,"safe":true,"fingerprint":"2666faef1c503cc067a096b147f3070874c2b885ab14a20422bbdb2a430277ec"}'::jsonb AND (objects->'sopc_order_transition') @> '{"owned":true,"safe":true,"fingerprint":"aba99ae49b039104eeb7c079426302ffc5bd25fd8baf1797a7eb65ae1723ce15"}'::jsonb
    AND (snapshot.objects->'validate_purchase_cancellation_v1') @> '{"owned":true,"safe":true}'::jsonb
    AND EXISTS(SELECT 1 FROM validator v WHERE v.prosrc='
DECLARE parent record; item record; info jsonb; expected jsonb; bills record;
  campaign jsonb; gift jsonb; marker jsonb; intent jsonb; expected_gift jsonb;
  gift_map jsonb := ''{}''::jsonb; gift_key text; eligible jsonb; eligible_id text;
  rows integer := 0; purchased_rows integer := 0; gift_rows integer := 0;
  gift_count integer := 0; gift_total bigint := 0; bytes bigint := 0;
  claimed text[]; purchased_claimed text[] := ARRAY[]::text[];
  carts text[] := ARRAY[]::text[]; gift_seen text[] := ARRAY[]::text[];
  log_count integer; deduction_count integer := 0; restoration_count integer := 0;
BEGIN
  IF TG_OP <> ''INSERT'' OR TG_TABLE_SCHEMA <> ''public'' OR TG_TABLE_NAME <> ''store_order_purchase_cancellation'' THEN
    RAISE EXCEPTION ''Invalid purchase cancellation validation source'' USING ERRCODE=''23514'';
  END IF;
  SELECT id,uid,type,pid,paid,status,is_del,is_system_del,supplier_allocation_status,
    refund_status,refund_type,total_num,use_integral,cart_id,promotions_give INTO parent
    FROM public.store_order WHERE id=NEW.order_id FOR UPDATE;
  IF NOT FOUND OR parent.uid IS DISTINCT FROM NEW.buyer_id OR parent.type IS DISTINCT FROM NEW.order_type
    OR parent.use_integral IS DISTINCT FROM NEW.restored_points
    OR parent.paid <> 0 OR parent.status <> -2 OR parent.is_del <> 1 OR parent.is_system_del <> 0
    OR parent.pid <> 0 OR parent.supplier_allocation_status NOT IN (0,1)
    OR parent.refund_status <> 0 OR parent.refund_type <> 0
    OR EXISTS(SELECT 1 FROM public.store_order WHERE pid=parent.id) THEN
    RAISE EXCEPTION ''Purchase cancellation final root does not match origin'' USING ERRCODE=''23514'';
  END IF;
  IF parent.cart_id IS NULL OR length(parent.cart_id)>2199
    OR parent.cart_id !~ ''^[1-9][0-9]{0,9}(,[1-9][0-9]{0,9}){0,199}$'' THEN
    RAISE EXCEPTION ''Purchase cancellation cart identities invalid'' USING ERRCODE=''23514'';
  END IF;
  claimed := string_to_array(parent.cart_id, '','');
  IF cardinality(claimed) <> (SELECT count(DISTINCT value) FROM unnest(claimed) AS value) THEN
    RAISE EXCEPTION ''Purchase cancellation cart identities repeat'' USING ERRCODE=''23514'';
  END IF;
  FOR expected IN SELECT value FROM jsonb_array_elements(NEW.lines) LOOP
    IF jsonb_typeof(expected->''cartId'') IS DISTINCT FROM ''string''
      OR (expected->>''cartId'') !~ ''^[1-9][0-9]{0,9}$''
      OR (expected->>''cartId'')::bigint>2147483647
      OR NOT (expected->>''cartId'')=ANY(claimed)
      OR (expected->>''cartId'')=ANY(purchased_claimed) THEN
      RAISE EXCEPTION ''Purchase cancellation origin cart identities invalid'' USING ERRCODE=''23514'';
    END IF;
    purchased_claimed := array_append(purchased_claimed,expected->>''cartId'');
  END LOOP;
  IF parent.promotions_give IS NOT NULL AND parent.promotions_give NOT IN ('''',''null'') THEN
    IF octet_length(parent.promotions_give)>65536 THEN
      RAISE EXCEPTION ''Purchase cancellation gift intent too large'' USING ERRCODE=''23514'';
    END IF;
    intent := parent.promotions_give::jsonb;
    IF jsonb_typeof(intent)=''object'' AND intent->>''version''=''order-promotion-gifts-v1'' THEN
      IF jsonb_typeof(intent->''promotions'') IS DISTINCT FROM ''array''
        OR jsonb_array_length(intent->''promotions'') NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION ''Purchase cancellation gift intent invalid'' USING ERRCODE=''23514'';
      END IF;
      FOR campaign IN SELECT value FROM jsonb_array_elements(intent->''promotions'') LOOP
        IF jsonb_typeof(campaign) IS DISTINCT FROM ''object''
          OR jsonb_typeof(campaign->''products'') IS DISTINCT FROM ''array''
          OR jsonb_typeof(campaign->''eligible_cart_ids'') IS DISTINCT FROM ''array''
          OR jsonb_array_length(campaign->''products'')>100
          OR jsonb_array_length(campaign->''eligible_cart_ids'') NOT BETWEEN 1 AND 200
          OR (campaign->>''id'') !~ ''^[1-9][0-9]{0,9}$''
          OR (campaign->>''tier_id'') !~ ''^[1-9][0-9]{0,9}$'' THEN
          RAISE EXCEPTION ''Purchase cancellation gift campaign invalid'' USING ERRCODE=''23514'';
        END IF;
        FOR eligible IN SELECT value FROM jsonb_array_elements(campaign->''eligible_cart_ids'') LOOP
          eligible_id := eligible #>> ''{}'';
          IF jsonb_typeof(eligible)<>''string'' OR NOT eligible_id=ANY(purchased_claimed) THEN
            RAISE EXCEPTION ''Purchase cancellation gift eligibility differs from purchase'' USING ERRCODE=''23514'';
          END IF;
        END LOOP;
        FOR gift IN SELECT value FROM jsonb_array_elements(campaign->''products'') LOOP
          gift_key := gift->>''cart_id'';
          IF jsonb_typeof(gift) IS DISTINCT FROM ''object''
            OR jsonb_typeof(gift->''cart_id'') IS DISTINCT FROM ''string''
            OR gift_key IS NULL OR gift_key !~ ''^[1-9][0-9]{0,9}$''
            OR gift_key::bigint>2147483647
            OR gift_map ? gift_key OR gift_key=ANY(purchased_claimed)
            OR NOT gift_key=ANY(claimed)
            OR (gift->>''product_id'') !~ ''^[1-9][0-9]{0,9}$''
            OR (gift->>''sku_id'') !~ ''^[1-9][0-9]{0,9}$''
            OR (gift->>''aux_id'') !~ ''^[1-9][0-9]{0,9}$''
            OR (gift->>''quantity'') !~ ''^[1-9][0-9]{0,9}$''
            OR jsonb_typeof(gift->''unique'')<>''string''
            OR length(gift->>''unique'') NOT BETWEEN 1 AND 8 THEN
            RAISE EXCEPTION ''Purchase cancellation gift identity invalid'' USING ERRCODE=''23514'';
          END IF;
          gift_count := gift_count+1;
          gift_total := gift_total+(gift->>''quantity'')::bigint;
          IF gift_count>200-cardinality(claimed) OR gift_total>2147483647 THEN
            RAISE EXCEPTION ''Purchase cancellation gift quantity exceeds bounds'' USING ERRCODE=''23514'';
          END IF;
          gift_map := gift_map||jsonb_build_object(gift_key,jsonb_build_object(
            ''root_id'',(campaign->>''id'')::integer,''tier_id'',(campaign->>''tier_id'')::integer,
            ''aux_id'',(gift->>''aux_id'')::integer,''product_id'',(gift->>''product_id'')::integer,
            ''sku_id'',(gift->>''sku_id'')::integer,''unique'',gift->>''unique'',
            ''quantity'',(gift->>''quantity'')::integer));
        END LOOP;
      END LOOP;
    END IF;
  END IF;
  IF parent.total_num IS DISTINCT FROM NEW.total_num+gift_total THEN
    RAISE EXCEPTION ''Purchase cancellation physical quantity differs from origin and gifts'' USING ERRCODE=''23514'';
  END IF;
  FOR item IN SELECT id,uid,cart_id,old_cart_id,product_id,sku_unique,cart_num,refund_num,
    split_status,split_surplus_num,surplus_num,is_writeoff,is_gift,product_type,
    settle_price,write_times,write_surplus_times,promotions_id,
    CASE WHEN octet_length(cart_info)<=65536 THEN cart_info ELSE NULL END AS snapshot
    FROM public.store_order_cart_info WHERE oid=parent.id ORDER BY id LIMIT 201 FOR UPDATE
  LOOP
    IF rows>=200 OR item.snapshot IS NULL OR item.uid IS DISTINCT FROM NEW.buyer_id
      OR item.old_cart_id <> '''' OR item.refund_num <> 0 OR item.split_status <> 0
      OR item.split_surplus_num <> item.cart_num OR item.surplus_num <> item.cart_num OR item.is_writeoff <> 0
      OR item.cart_id=ANY(carts) OR item.is_gift NOT IN (0,1) THEN
      RAISE EXCEPTION ''Purchase cancellation line ownership or state invalid'' USING ERRCODE=''23514'';
    END IF;
    bytes := bytes + octet_length(item.snapshot);
    IF bytes>8388608 THEN RAISE EXCEPTION ''Purchase cancellation snapshots too large'' USING ERRCODE=''23514''; END IF;
    info := item.snapshot::jsonb;
    IF jsonb_typeof(info) IS DISTINCT FROM ''object''
      OR info->>''financial_version'' IS DISTINCT FROM ''checkout-line-finance-v1''
      OR info ? ''refund_order_generation'' OR info->''id'' IS DISTINCT FROM to_jsonb(item.cart_id)
      OR info->''cart_num'' IS DISTINCT FROM to_jsonb(item.cart_num)
      OR info#>''{product,id}'' IS DISTINCT FROM to_jsonb(item.product_id) THEN
      RAISE EXCEPTION ''Purchase cancellation snapshot identity invalid'' USING ERRCODE=''23514'';
    END IF;
    IF item.is_gift=0 THEN
      expected := NEW.lines->purchased_rows;
      IF NOT item.cart_id=ANY(purchased_claimed) OR expected IS NULL OR info ? ''promotion_gift''
        OR info#>''{sku,id}'' IS DISTINCT FROM expected->''skuId''
        OR NOT (info#>''{sku,unique}'' IS NOT DISTINCT FROM to_jsonb(item.sku_unique)
          OR (parent.type IN (1,2,3) AND info#>''{activitySku,unique}'' IS NOT DISTINCT FROM to_jsonb(item.sku_unique)))
        OR info->''use_integral'' IS DISTINCT FROM to_jsonb(expected->>''usedPoints'')
        OR expected->''rowId'' IS DISTINCT FROM to_jsonb(item.id)
        OR expected->''cartId'' IS DISTINCT FROM to_jsonb(item.cart_id)
        OR expected->''productId'' IS DISTINCT FROM to_jsonb(item.product_id)
        OR expected->''skuUnique'' IS DISTINCT FROM to_jsonb(item.sku_unique)
        OR expected->''quantity'' IS DISTINCT FROM to_jsonb(item.cart_num) THEN
        RAISE EXCEPTION ''Purchase cancellation lines differ from original purchase'' USING ERRCODE=''23514'';
      END IF;
      purchased_rows := purchased_rows+1;
    ELSE
      expected_gift := gift_map->item.cart_id;
      marker := info->''promotion_gift'';
      IF expected_gift IS NULL OR item.cart_id=ANY(gift_seen)
        OR item.product_id IS DISTINCT FROM (expected_gift->>''product_id'')::integer
        OR item.sku_unique IS DISTINCT FROM expected_gift->>''unique''
        OR item.cart_num IS DISTINCT FROM (expected_gift->>''quantity'')::integer
        OR info#>''{sku,id}'' IS DISTINCT FROM expected_gift->''sku_id''
        OR info#>''{sku,unique}'' IS DISTINCT FROM expected_gift->''unique''
        OR marker IS DISTINCT FROM jsonb_build_object(''version'',''order-promotion-gifts-v1'',
          ''root_id'',(expected_gift->>''root_id'')::integer,
          ''tier_id'',(expected_gift->>''tier_id'')::integer,
          ''aux_id'',(expected_gift->>''aux_id'')::integer)
        OR item.promotions_id IS DISTINCT FROM expected_gift->>''root_id''
        OR item.product_type<>0 OR item.settle_price<>0
        OR item.write_times<>item.cart_num OR item.write_surplus_times<>item.cart_num
        OR info->>''use_integral'' IS DISTINCT FROM ''0'' OR info->''integral'' IS DISTINCT FROM ''0''::jsonb
        OR info#>>''{sku,price}'' IS DISTINCT FROM ''0.00''
        OR info->>''gain_integral'' IS DISTINCT FROM ''0''
        OR EXISTS(SELECT 1 FROM jsonb_each_text(info) kv WHERE kv.key=ANY(ARRAY[
          ''sum_price'',''vip_truePrice'',''member_postage_price'',''member_coupon_price'',
          ''raw_postage_price'',''postage_price'',''coupon_price'',''integral_price'',
          ''first_order_price'',''sum_true_price'',''promotions_true_price'',''costPrice'',
          ''one_brokerage'',''two_brokerage'',''division_staff_brokerage'',
          ''division_agent_brokerage'',''division_brokerage'']) AND kv.value<>''0.00'')
        OR (SELECT count(*) FROM jsonb_each_text(info) kv WHERE kv.key=ANY(ARRAY[
          ''sum_price'',''vip_truePrice'',''member_postage_price'',''member_coupon_price'',
          ''raw_postage_price'',''postage_price'',''coupon_price'',''integral_price'',
          ''first_order_price'',''sum_true_price'',''promotions_true_price'',''costPrice'',
          ''one_brokerage'',''two_brokerage'',''division_staff_brokerage'',
          ''division_agent_brokerage'',''division_brokerage'']))<>17 THEN
        RAISE EXCEPTION ''Purchase cancellation gift row differs from strict intent'' USING ERRCODE=''23514'';
      END IF;
      gift_seen := array_append(gift_seen,item.cart_id);
      gift_rows := gift_rows+1;
    END IF;
    rows := rows+1; carts := array_append(carts,item.cart_id);
  END LOOP;
  IF purchased_rows<>jsonb_array_length(NEW.lines) OR purchased_rows<>cardinality(purchased_claimed)
    OR gift_rows<>gift_count OR rows<>purchased_rows+gift_rows
    OR cardinality(claimed)<>purchased_rows+gift_rows THEN
    RAISE EXCEPTION ''Purchase cancellation line coverage incomplete'' USING ERRCODE=''23514'';
  END IF;
  SELECT count(*) INTO log_count FROM (SELECT id FROM public.store_order_status
    WHERE oid=NEW.order_id AND change_type=''cancel'' LIMIT 2) s;
  IF log_count<>1 THEN RAISE EXCEPTION ''Purchase cancellation log missing or ambiguous'' USING ERRCODE=''23514''; END IF;
  FOR bills IN SELECT uid,pm,event_key,number,status FROM public.user_bill
    WHERE category=''integral'' AND type=''deduction'' AND link_id=NEW.order_id::text LIMIT 2
  LOOP
    deduction_count := deduction_count+1;
    IF bills.uid<>NEW.buyer_id OR bills.pm<>0 OR bills.event_key<>''order_integral_deduction''
      OR bills.status<>1 OR bills.number<>NEW.restored_points THEN
      RAISE EXCEPTION ''Purchase cancellation original points ledger inconsistent'' USING ERRCODE=''23514'';
    END IF;
  END LOOP;
  FOR bills IN SELECT uid,pm,event_key,number,status FROM public.user_bill
    WHERE category=''integral'' AND type=''order_cancel'' AND link_id=NEW.order_id::text LIMIT 2
  LOOP
    restoration_count := restoration_count+1;
    IF bills.uid<>NEW.buyer_id OR bills.pm<>1 OR bills.event_key<>''order_cancel_integral_back''
      OR bills.status<>1 OR bills.number<>NEW.restored_points THEN
      RAISE EXCEPTION ''Purchase cancellation restored points ledger inconsistent'' USING ERRCODE=''23514'';
    END IF;
  END LOOP;
  IF (NEW.restored_points>0 AND (deduction_count<>1 OR restoration_count<>1))
    OR (NEW.restored_points=0 AND (deduction_count<>0 OR restoration_count<>0)) THEN
    RAISE EXCEPTION ''Purchase cancellation points ledger missing or ambiguous'' USING ERRCODE=''23514'';
  END IF;
  RETURN NEW;
END '
      AND v.prokind='f' AND v.pronargs=0 AND v.prorettype='trigger'::regtype AND NOT v.proretset
      AND NOT v.prosecdef AND NOT v.proleakproof AND v.provolatile='v' AND v.proparallel='u'
      AND NOT v.proisstrict AND v.proconfig=ARRAY['search_path=pg_catalog']::text[]
      AND v.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
      AND v.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)) THEN 'gift-v1'
  ELSE legacy.state END AS state FROM legacy CROSS JOIN snapshot) s;
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
  IF final_state IS DISTINCT FROM 'gift-v1' OR NOT sources_ready
    OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Purchase cancellation gift forward verification failed';
  END IF;
END
$purchase_cancellation_gift_forward$;
