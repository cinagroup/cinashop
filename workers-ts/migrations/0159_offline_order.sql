SET LOCAL search_path=public,pg_temp;
SET LOCAL row_security=off;
SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),30000)::text||'ms',true),
  set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true);
DO $offline_install$
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
    RAISE EXCEPTION 'Offline installation requires bounded public PG16 read-write READ COMMITTED';
  END IF;
  IF NOT pg_try_advisory_xact_lock(731611,0) THEN RAISE EXCEPTION 'Evidence installation already running'; END IF;
  SELECT state INTO initial_state FROM (WITH catalog AS (
WITH relations AS (
  SELECT name,c.*,name IN ('offline_order_admission','offline_order_payment_selection','offline_order_balance','offline_order_query_evidence','offline_order_callback_binding','offline_order_external_payment','offline_order_payment_dispatch') AS ledger
  FROM (VALUES ('member_right'),('system_config'),('payment_callback_event'),('payment_reconciliation_case'),('other_order'),('user'),('wechat_user'),('user_money'),('user_bill'),('store_order_economize'),('offline_order_admission'),('offline_order_payment_selection'),('offline_order_balance'),('offline_order_query_evidence'),('offline_order_callback_binding'),('offline_order_external_payment'),('offline_order_payment_dispatch')) names(name)
  LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public."'||name||'"')
), tables AS (
  SELECT name,oid,relowner AS owner,
    relkind='r' AND relpersistence='p' AND NOT relispartition
    AND NOT relrowsecurity AND NOT relforcerowsecurity AND relreplident='d' AND reloptions IS NULL
    AND relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=r.oid OR inhparent=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=r.oid AND attnum>0 AND attisdropped)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=r.oid AND tgisinternal AND tgenabled<>'O')
    AND (NOT ledger OR (
      NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(relacl,pg_catalog.acldefault('r',relowner))) a
        WHERE a.grantee<>relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
        WHERE col.attrelid=r.oid AND a.grantee<>relowner AND
          (a.grantee=0 OR a.is_grantable OR name<>'offline_order_payment_dispatch'
            OR col.attname NOT IN ('state','ticket_payload','ticket_hash','finished_at','display_until') OR a.privilege_type<>'UPDATE'))
    )) AS safe,
    jsonb_build_object(
      'columns',(SELECT jsonb_agg(jsonb_build_array(CASE WHEN r.ledger THEN a.attnum END,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
        pg_get_expr(d.adbin,d.adrelid),a.attidentity::text,a.attgenerated::text,
        CASE WHEN a.attcollation=0 THEN NULL ELSE cn.nspname||'.'||co.collname END)
        ORDER BY CASE WHEN r.ledger THEN a.attnum END,a.attname COLLATE "C")
        FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
        WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.contype::text,pg_get_constraintdef(k.oid,false),
        k.convalidated,k.condeferrable,k.condeferred,k.connoinherit,k.conislocal,k.coninhcount,k.conparentid::text)
        ORDER BY k.conname COLLATE "C") FROM pg_catalog.pg_constraint k WHERE k.conrelid=r.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_array(ic.relname,pg_get_indexdef(i.indexrelid),i.indisunique,i.indisprimary,
        i.indisvalid,i.indisready,i.indislive,i.indimmediate,i.indisexclusion,i.indnullsnotdistinct,i.indisreplident,
        i.indnatts,i.indnkeyatts,CASE WHEN r.ledger THEN i.indkey::text END,i.indoption::text,ic.reloptions,ic.relpersistence)
        ORDER BY ic.relname COLLATE "C") FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=r.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,pg_get_triggerdef(t.oid,false),t.tgenabled::text)
        ORDER BY t.tgname COLLATE "C") FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
        WHERE t.tgrelid=r.oid AND NOT t.tgisinternal AND (r.ledger OR p.proname IN ('ooa_lock_pricing','ooa_guard','oops_guard','oops_wallet_commit','oob_guard','ooqe_guard','oocb_guard','ooep_guard','ooep_paid_commit','oopd_guard')
          OR t.tgname ~ '^(ooa|oops|oob|ooqe|oocb|ooep|oopd)_'))
    ) AS shape
  FROM relations r
), functions AS (
  SELECT name,p.* FROM (VALUES ('ooa_lock_pricing'),('ooa_guard'),('oops_guard'),('oops_wallet_commit'),('oob_guard'),('ooqe_guard'),('oocb_guard'),('ooep_guard'),('ooep_paid_commit'),('oopd_guard')) names(name)
  LEFT JOIN pg_catalog.pg_proc p ON p.pronamespace='public'::regnamespace AND p.proname=name
), components AS (
  SELECT 'table' AS kind,name,oid,owner,safe,shape FROM tables
  UNION ALL
  SELECT 'function',name,oid,proowner,
    prokind='f' AND pronargs=0 AND NOT proretset
    AND prorettype=CASE WHEN name='ooa_lock_pricing' THEN 'void'::regtype ELSE 'trigger'::regtype END
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(proacl,pg_catalog.acldefault('f',proowner))) a
      WHERE a.grantee<>proowner AND (name<>'ooa_lock_pricing' OR a.grantee=0 OR a.is_grantable OR a.privilege_type<>'EXECUTE')),
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
SELECT CASE WHEN components<>27 THEN 'drift'
  WHEN (objects->'member_right') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ffed4c38d3893a186f8614d982dd397e0990cf9b068e696b1fd7afe7d5cbb331"}'::jsonb AND (objects->'other_order') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"1756e4e38c754862d1c76faac3e4ebbcf105484e09bddcabffc27e26dfbf820b"}'::jsonb AND (objects->'payment_callback_event') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"977bf01c7e6aa9af22a11bcc13321cf8ea6496fc53f13bab1bf3e10620f255e1"}'::jsonb AND (objects->'payment_reconciliation_case') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fe607b08a5f66a653a673aa0ca8626a38d0e3482f4d7fccc618bf64f524ab959"}'::jsonb AND (objects->'store_order_economize') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"2383680a0cd0cd12c917c3b5214d4da6ad9facf5bc81f8c3f745656cc02b106c"}'::jsonb AND (objects->'system_config') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"10becbd6bf8ae6ed41dba14e474fc8529df4116c61e84365b60c50d11e1b4336"}'::jsonb AND (objects->'user') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"9d8390088ef56e1c24f25b892d34cf73a403774e701a0831d189799c9bb33f7b"}'::jsonb AND (objects->'user_bill') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"20a4ab84699fafe290e741577d22751bda9bda056c90ac9dcdc15f1b4560b434"}'::jsonb AND (objects->'user_money') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"17f28481406ae65e3b6143ed87215cfa75c892050e1814f882e79687dac8fcf2"}'::jsonb AND (objects->'wechat_user') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fb68f9c18236ea7f757726df87997cab1387479b6ee7690fef6ce38e6adba926"}'::jsonb AND (objects->'offline_order_admission') @> '{"present":false}'::jsonb AND (objects->'offline_order_payment_selection') @> '{"present":false}'::jsonb AND (objects->'offline_order_balance') @> '{"present":false}'::jsonb AND (objects->'offline_order_query_evidence') @> '{"present":false}'::jsonb AND (objects->'offline_order_callback_binding') @> '{"present":false}'::jsonb AND (objects->'offline_order_external_payment') @> '{"present":false}'::jsonb AND (objects->'offline_order_payment_dispatch') @> '{"present":false}'::jsonb AND (objects->'ooa_lock_pricing') @> '{"present":false}'::jsonb AND (objects->'ooa_guard') @> '{"present":false}'::jsonb AND (objects->'oops_guard') @> '{"present":false}'::jsonb AND (objects->'oops_wallet_commit') @> '{"present":false}'::jsonb AND (objects->'oob_guard') @> '{"present":false}'::jsonb AND (objects->'ooqe_guard') @> '{"present":false}'::jsonb AND (objects->'oocb_guard') @> '{"present":false}'::jsonb AND (objects->'ooep_guard') @> '{"present":false}'::jsonb AND (objects->'ooep_paid_commit') @> '{"present":false}'::jsonb AND (objects->'oopd_guard') @> '{"present":false}'::jsonb THEN 'fresh'
  WHEN (objects->'ooa_guard') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c80995492c819e825a4c6a2d8ce5f8bde530395a3b9d514d8cbbdbc41e46f113"}'::jsonb AND (objects->'ooa_lock_pricing') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"769c62a6fd1a877cc65936b35cb4dccc410ab56d2e4fe49811eacd678b17f1e4"}'::jsonb AND (objects->'oob_guard') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"3fb3bd3d42e4c192cac8b9c1932b51f5fe64dfc33af5f748f2dd7d7ee2e099cc"}'::jsonb AND (objects->'oocb_guard') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"3f1da24b0ba0029d08f55b6c8dcda2dc5ee2d40b53cea0a4495cbc1084e8fe1d"}'::jsonb AND (objects->'ooep_guard') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"4306e4f1925b75b89453fda45b8d702c3416a28edd4162b1a34344b79385885f"}'::jsonb AND (objects->'ooep_paid_commit') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"8022926f11369fa0ea4cd831457583e01f01880c815e7b72b373ba5558788cda"}'::jsonb AND (objects->'oopd_guard') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"e4b7fa82b42e02657d7a1506302a1d745ac93a9502d3100267913ed80b81700d"}'::jsonb AND (objects->'oops_guard') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"67439718137fdeb553f6a6cad68ee902c70d5951584c81fe1d59f83d0349ff3b"}'::jsonb AND (objects->'oops_wallet_commit') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b5573ef82f4949c37bba0eca8ea30dde4ea08498fe98549611fa533689836e34"}'::jsonb AND (objects->'ooqe_guard') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ad94dd2742c99be1d7bbbe153ec796c5f8961b36bd2530850f2c3d99eb9724c8"}'::jsonb AND (objects->'member_right') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ffed4c38d3893a186f8614d982dd397e0990cf9b068e696b1fd7afe7d5cbb331"}'::jsonb AND (objects->'offline_order_admission') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ca8934a5ce2de0e3be7f4e44f7e319bbd403446afce3fcf0ef4b1f183d129dc5"}'::jsonb AND (objects->'offline_order_balance') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fcb99e1c7e771beae2d0e12f7ea0aef4503bb9388c517ab10922528661233e04"}'::jsonb AND (objects->'offline_order_callback_binding') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c7bb72246c2b570eb59a6bab216c8407f99fd4bf07c0068dca4d93f1a00950fb"}'::jsonb AND (objects->'offline_order_external_payment') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"9af3b51fb27fb019819792631101f8ea0220fbddfbc28b32b307e7872d658fad"}'::jsonb AND (objects->'offline_order_payment_dispatch') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"652aa0cacb3623929f786b02e68298291e547118ce3579d944b03f4fafc0f8c2"}'::jsonb AND (objects->'offline_order_payment_selection') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"2c1f93e917c14b3c0a369be6d613ccc33672c40e57ea461a799b4fab4dbd0f75"}'::jsonb AND (objects->'offline_order_query_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"a12ec8ef9b7a9ca4c32f42616190edb6c20fb8f1665b450c16ab8bd474e33e6e"}'::jsonb AND (objects->'other_order') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"92e3fdeb757cffb0b460329157b265a8be401559655b96f0e94238119ac79d5f"}'::jsonb AND (objects->'payment_callback_event') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c4533e013200eb3398f043952b87b3751369e1d6c7dcad296454fe703862d53b"}'::jsonb AND (objects->'payment_reconciliation_case') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"661c6de1684ecbff9630e049d43e14263f01f60b8cd46ac1bf2aa71a74bd6739"}'::jsonb AND (objects->'store_order_economize') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"af93acc31f1e2011b8c4450064bf7506990768f899229d6153f6882e804a6a19"}'::jsonb AND (objects->'system_config') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"10becbd6bf8ae6ed41dba14e474fc8529df4116c61e84365b60c50d11e1b4336"}'::jsonb AND (objects->'user') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"9d8390088ef56e1c24f25b892d34cf73a403774e701a0831d189799c9bb33f7b"}'::jsonb AND (objects->'user_bill') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"8c28df2335af833c85658983df4e03c1202fdaa612550407122433b049ea19d5"}'::jsonb AND (objects->'user_money') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fc130d4977144e49c38c190a7949db01c472622a676b88bf525179ebac4d0290"}'::jsonb AND (objects->'wechat_user') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fb68f9c18236ea7f757726df87997cab1387479b6ee7690fef6ce38e6adba926"}'::jsonb THEN 'v1'
  WHEN (objects->'member_right') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ffed4c38d3893a186f8614d982dd397e0990cf9b068e696b1fd7afe7d5cbb331"}'::jsonb AND (objects->'other_order') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"1756e4e38c754862d1c76faac3e4ebbcf105484e09bddcabffc27e26dfbf820b"}'::jsonb AND (objects->'payment_callback_event') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"4ee2a3598865029344ff616079f864732d515805c9f3256c8bf96c4e961ff4f8"}'::jsonb AND (objects->'payment_reconciliation_case') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"661c6de1684ecbff9630e049d43e14263f01f60b8cd46ac1bf2aa71a74bd6739"}'::jsonb AND (objects->'store_order_economize') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"2383680a0cd0cd12c917c3b5214d4da6ad9facf5bc81f8c3f745656cc02b106c"}'::jsonb AND (objects->'system_config') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"10becbd6bf8ae6ed41dba14e474fc8529df4116c61e84365b60c50d11e1b4336"}'::jsonb AND (objects->'user') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"9d8390088ef56e1c24f25b892d34cf73a403774e701a0831d189799c9bb33f7b"}'::jsonb AND (objects->'user_bill') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b0390aca3bbc3e790de7581444678f594a65d1778187b05fd2701f2994f2faf9"}'::jsonb AND (objects->'user_money') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"7d80098a75e284bc393dd16dc98fb867435cc3fc4f107f43aaa490c2a560e763"}'::jsonb AND (objects->'wechat_user') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fb68f9c18236ea7f757726df87997cab1387479b6ee7690fef6ce38e6adba926"}'::jsonb AND (objects->'offline_order_admission') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"0c2a9fc2cb738c76b6ac518fa0cc71832e773e1b28328a4e310d8d9b8dc08a94"}'::jsonb AND (objects->'offline_order_balance') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"0555c78f98eefbd1392281c7698ca5f930be1ca1ae4f50d805d9ccb59102ce28"}'::jsonb AND (objects->'offline_order_callback_binding') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ecd8ba1c25926cd6304844d0c3697ebd57e61f96e494870c5c152baaf3cf95f2"}'::jsonb AND (objects->'offline_order_external_payment') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"65b9f9beb5b0652e8cf4ecf29325423375b0f62960bf3427032ebadc9112d7ae"}'::jsonb AND (objects->'offline_order_payment_dispatch') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"d92333abf3ab54db25503ece15dec2e4620d7ac063bb3ad3840578ed02aa0529"}'::jsonb AND (objects->'offline_order_payment_selection') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"12abd2bff4cb2ec209fb55bac6dcbafa258a9e5fa9ef11c4b3ddb948956ae934"}'::jsonb AND (objects->'offline_order_query_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"3fa09ba5101a8a7d9a5703c160013cf2888b0eac06bceeb711b4bc6c7a6225ca"}'::jsonb AND (objects->'ooa_lock_pricing') @> '{"present":false}'::jsonb AND (objects->'ooa_guard') @> '{"present":false}'::jsonb AND (objects->'oops_guard') @> '{"present":false}'::jsonb AND (objects->'oops_wallet_commit') @> '{"present":false}'::jsonb AND (objects->'oob_guard') @> '{"present":false}'::jsonb AND (objects->'ooqe_guard') @> '{"present":false}'::jsonb AND (objects->'oocb_guard') @> '{"present":false}'::jsonb AND (objects->'ooep_guard') @> '{"present":false}'::jsonb AND (objects->'ooep_paid_commit') @> '{"present":false}'::jsonb AND (objects->'oopd_guard') @> '{"present":false}'::jsonb THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot) c;
  IF initial_state='drift' OR (initial_state='orm-pending' AND NOT false) THEN
    RAISE EXCEPTION 'Offline catalog or ACL drift requires review or explicit empty ORM completion';
  END IF;
  LOCK TABLE public."member_right" IN ACCESS EXCLUSIVE MODE NOWAIT;
  LOCK TABLE public."system_config" IN ACCESS EXCLUSIVE MODE NOWAIT;
  LOCK TABLE public."payment_callback_event" IN ACCESS EXCLUSIVE MODE NOWAIT;
  LOCK TABLE public."payment_reconciliation_case" IN ACCESS EXCLUSIVE MODE NOWAIT;
  LOCK TABLE public."other_order" IN ACCESS EXCLUSIVE MODE NOWAIT;
  LOCK TABLE public."user" IN ACCESS EXCLUSIVE MODE NOWAIT;
  LOCK TABLE public."wechat_user" IN ACCESS EXCLUSIVE MODE NOWAIT;
  LOCK TABLE public."user_money" IN ACCESS EXCLUSIVE MODE NOWAIT;
  LOCK TABLE public."user_bill" IN ACCESS EXCLUSIVE MODE NOWAIT;
  LOCK TABLE public."store_order_economize" IN ACCESS EXCLUSIVE MODE NOWAIT;
  IF initial_state<>'fresh' THEN
    LOCK TABLE public.offline_order_admission IN ACCESS EXCLUSIVE MODE NOWAIT;
    LOCK TABLE public.offline_order_payment_selection IN ACCESS EXCLUSIVE MODE NOWAIT;
    LOCK TABLE public.offline_order_balance IN ACCESS EXCLUSIVE MODE NOWAIT;
    LOCK TABLE public.offline_order_query_evidence IN ACCESS EXCLUSIVE MODE NOWAIT;
    LOCK TABLE public.offline_order_callback_binding IN ACCESS EXCLUSIVE MODE NOWAIT;
    LOCK TABLE public.offline_order_external_payment IN ACCESS EXCLUSIVE MODE NOWAIT;
    LOCK TABLE public.offline_order_payment_dispatch IN ACCESS EXCLUSIVE MODE NOWAIT;
  END IF;
  SELECT state INTO final_state FROM (WITH catalog AS (
WITH relations AS (
  SELECT name,c.*,name IN ('offline_order_admission','offline_order_payment_selection','offline_order_balance','offline_order_query_evidence','offline_order_callback_binding','offline_order_external_payment','offline_order_payment_dispatch') AS ledger
  FROM (VALUES ('member_right'),('system_config'),('payment_callback_event'),('payment_reconciliation_case'),('other_order'),('user'),('wechat_user'),('user_money'),('user_bill'),('store_order_economize'),('offline_order_admission'),('offline_order_payment_selection'),('offline_order_balance'),('offline_order_query_evidence'),('offline_order_callback_binding'),('offline_order_external_payment'),('offline_order_payment_dispatch')) names(name)
  LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public."'||name||'"')
), tables AS (
  SELECT name,oid,relowner AS owner,
    relkind='r' AND relpersistence='p' AND NOT relispartition
    AND NOT relrowsecurity AND NOT relforcerowsecurity AND relreplident='d' AND reloptions IS NULL
    AND relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=r.oid OR inhparent=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=r.oid AND attnum>0 AND attisdropped)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=r.oid AND tgisinternal AND tgenabled<>'O')
    AND (NOT ledger OR (
      NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(relacl,pg_catalog.acldefault('r',relowner))) a
        WHERE a.grantee<>relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
        WHERE col.attrelid=r.oid AND a.grantee<>relowner AND
          (a.grantee=0 OR a.is_grantable OR name<>'offline_order_payment_dispatch'
            OR col.attname NOT IN ('state','ticket_payload','ticket_hash','finished_at','display_until') OR a.privilege_type<>'UPDATE'))
    )) AS safe,
    jsonb_build_object(
      'columns',(SELECT jsonb_agg(jsonb_build_array(CASE WHEN r.ledger THEN a.attnum END,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
        pg_get_expr(d.adbin,d.adrelid),a.attidentity::text,a.attgenerated::text,
        CASE WHEN a.attcollation=0 THEN NULL ELSE cn.nspname||'.'||co.collname END)
        ORDER BY CASE WHEN r.ledger THEN a.attnum END,a.attname COLLATE "C")
        FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
        WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.contype::text,pg_get_constraintdef(k.oid,false),
        k.convalidated,k.condeferrable,k.condeferred,k.connoinherit,k.conislocal,k.coninhcount,k.conparentid::text)
        ORDER BY k.conname COLLATE "C") FROM pg_catalog.pg_constraint k WHERE k.conrelid=r.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_array(ic.relname,pg_get_indexdef(i.indexrelid),i.indisunique,i.indisprimary,
        i.indisvalid,i.indisready,i.indislive,i.indimmediate,i.indisexclusion,i.indnullsnotdistinct,i.indisreplident,
        i.indnatts,i.indnkeyatts,CASE WHEN r.ledger THEN i.indkey::text END,i.indoption::text,ic.reloptions,ic.relpersistence)
        ORDER BY ic.relname COLLATE "C") FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=r.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,pg_get_triggerdef(t.oid,false),t.tgenabled::text)
        ORDER BY t.tgname COLLATE "C") FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
        WHERE t.tgrelid=r.oid AND NOT t.tgisinternal AND (r.ledger OR p.proname IN ('ooa_lock_pricing','ooa_guard','oops_guard','oops_wallet_commit','oob_guard','ooqe_guard','oocb_guard','ooep_guard','ooep_paid_commit','oopd_guard')
          OR t.tgname ~ '^(ooa|oops|oob|ooqe|oocb|ooep|oopd)_'))
    ) AS shape
  FROM relations r
), functions AS (
  SELECT name,p.* FROM (VALUES ('ooa_lock_pricing'),('ooa_guard'),('oops_guard'),('oops_wallet_commit'),('oob_guard'),('ooqe_guard'),('oocb_guard'),('ooep_guard'),('ooep_paid_commit'),('oopd_guard')) names(name)
  LEFT JOIN pg_catalog.pg_proc p ON p.pronamespace='public'::regnamespace AND p.proname=name
), components AS (
  SELECT 'table' AS kind,name,oid,owner,safe,shape FROM tables
  UNION ALL
  SELECT 'function',name,oid,proowner,
    prokind='f' AND pronargs=0 AND NOT proretset
    AND prorettype=CASE WHEN name='ooa_lock_pricing' THEN 'void'::regtype ELSE 'trigger'::regtype END
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(proacl,pg_catalog.acldefault('f',proowner))) a
      WHERE a.grantee<>proowner AND (name<>'ooa_lock_pricing' OR a.grantee=0 OR a.is_grantable OR a.privilege_type<>'EXECUTE')),
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
SELECT CASE WHEN components<>27 THEN 'drift'
  WHEN (objects->'member_right') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ffed4c38d3893a186f8614d982dd397e0990cf9b068e696b1fd7afe7d5cbb331"}'::jsonb AND (objects->'other_order') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"1756e4e38c754862d1c76faac3e4ebbcf105484e09bddcabffc27e26dfbf820b"}'::jsonb AND (objects->'payment_callback_event') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"977bf01c7e6aa9af22a11bcc13321cf8ea6496fc53f13bab1bf3e10620f255e1"}'::jsonb AND (objects->'payment_reconciliation_case') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fe607b08a5f66a653a673aa0ca8626a38d0e3482f4d7fccc618bf64f524ab959"}'::jsonb AND (objects->'store_order_economize') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"2383680a0cd0cd12c917c3b5214d4da6ad9facf5bc81f8c3f745656cc02b106c"}'::jsonb AND (objects->'system_config') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"10becbd6bf8ae6ed41dba14e474fc8529df4116c61e84365b60c50d11e1b4336"}'::jsonb AND (objects->'user') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"9d8390088ef56e1c24f25b892d34cf73a403774e701a0831d189799c9bb33f7b"}'::jsonb AND (objects->'user_bill') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"20a4ab84699fafe290e741577d22751bda9bda056c90ac9dcdc15f1b4560b434"}'::jsonb AND (objects->'user_money') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"17f28481406ae65e3b6143ed87215cfa75c892050e1814f882e79687dac8fcf2"}'::jsonb AND (objects->'wechat_user') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fb68f9c18236ea7f757726df87997cab1387479b6ee7690fef6ce38e6adba926"}'::jsonb AND (objects->'offline_order_admission') @> '{"present":false}'::jsonb AND (objects->'offline_order_payment_selection') @> '{"present":false}'::jsonb AND (objects->'offline_order_balance') @> '{"present":false}'::jsonb AND (objects->'offline_order_query_evidence') @> '{"present":false}'::jsonb AND (objects->'offline_order_callback_binding') @> '{"present":false}'::jsonb AND (objects->'offline_order_external_payment') @> '{"present":false}'::jsonb AND (objects->'offline_order_payment_dispatch') @> '{"present":false}'::jsonb AND (objects->'ooa_lock_pricing') @> '{"present":false}'::jsonb AND (objects->'ooa_guard') @> '{"present":false}'::jsonb AND (objects->'oops_guard') @> '{"present":false}'::jsonb AND (objects->'oops_wallet_commit') @> '{"present":false}'::jsonb AND (objects->'oob_guard') @> '{"present":false}'::jsonb AND (objects->'ooqe_guard') @> '{"present":false}'::jsonb AND (objects->'oocb_guard') @> '{"present":false}'::jsonb AND (objects->'ooep_guard') @> '{"present":false}'::jsonb AND (objects->'ooep_paid_commit') @> '{"present":false}'::jsonb AND (objects->'oopd_guard') @> '{"present":false}'::jsonb THEN 'fresh'
  WHEN (objects->'ooa_guard') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c80995492c819e825a4c6a2d8ce5f8bde530395a3b9d514d8cbbdbc41e46f113"}'::jsonb AND (objects->'ooa_lock_pricing') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"769c62a6fd1a877cc65936b35cb4dccc410ab56d2e4fe49811eacd678b17f1e4"}'::jsonb AND (objects->'oob_guard') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"3fb3bd3d42e4c192cac8b9c1932b51f5fe64dfc33af5f748f2dd7d7ee2e099cc"}'::jsonb AND (objects->'oocb_guard') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"3f1da24b0ba0029d08f55b6c8dcda2dc5ee2d40b53cea0a4495cbc1084e8fe1d"}'::jsonb AND (objects->'ooep_guard') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"4306e4f1925b75b89453fda45b8d702c3416a28edd4162b1a34344b79385885f"}'::jsonb AND (objects->'ooep_paid_commit') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"8022926f11369fa0ea4cd831457583e01f01880c815e7b72b373ba5558788cda"}'::jsonb AND (objects->'oopd_guard') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"e4b7fa82b42e02657d7a1506302a1d745ac93a9502d3100267913ed80b81700d"}'::jsonb AND (objects->'oops_guard') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"67439718137fdeb553f6a6cad68ee902c70d5951584c81fe1d59f83d0349ff3b"}'::jsonb AND (objects->'oops_wallet_commit') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b5573ef82f4949c37bba0eca8ea30dde4ea08498fe98549611fa533689836e34"}'::jsonb AND (objects->'ooqe_guard') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ad94dd2742c99be1d7bbbe153ec796c5f8961b36bd2530850f2c3d99eb9724c8"}'::jsonb AND (objects->'member_right') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ffed4c38d3893a186f8614d982dd397e0990cf9b068e696b1fd7afe7d5cbb331"}'::jsonb AND (objects->'offline_order_admission') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ca8934a5ce2de0e3be7f4e44f7e319bbd403446afce3fcf0ef4b1f183d129dc5"}'::jsonb AND (objects->'offline_order_balance') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fcb99e1c7e771beae2d0e12f7ea0aef4503bb9388c517ab10922528661233e04"}'::jsonb AND (objects->'offline_order_callback_binding') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c7bb72246c2b570eb59a6bab216c8407f99fd4bf07c0068dca4d93f1a00950fb"}'::jsonb AND (objects->'offline_order_external_payment') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"9af3b51fb27fb019819792631101f8ea0220fbddfbc28b32b307e7872d658fad"}'::jsonb AND (objects->'offline_order_payment_dispatch') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"652aa0cacb3623929f786b02e68298291e547118ce3579d944b03f4fafc0f8c2"}'::jsonb AND (objects->'offline_order_payment_selection') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"2c1f93e917c14b3c0a369be6d613ccc33672c40e57ea461a799b4fab4dbd0f75"}'::jsonb AND (objects->'offline_order_query_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"a12ec8ef9b7a9ca4c32f42616190edb6c20fb8f1665b450c16ab8bd474e33e6e"}'::jsonb AND (objects->'other_order') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"92e3fdeb757cffb0b460329157b265a8be401559655b96f0e94238119ac79d5f"}'::jsonb AND (objects->'payment_callback_event') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c4533e013200eb3398f043952b87b3751369e1d6c7dcad296454fe703862d53b"}'::jsonb AND (objects->'payment_reconciliation_case') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"661c6de1684ecbff9630e049d43e14263f01f60b8cd46ac1bf2aa71a74bd6739"}'::jsonb AND (objects->'store_order_economize') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"af93acc31f1e2011b8c4450064bf7506990768f899229d6153f6882e804a6a19"}'::jsonb AND (objects->'system_config') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"10becbd6bf8ae6ed41dba14e474fc8529df4116c61e84365b60c50d11e1b4336"}'::jsonb AND (objects->'user') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"9d8390088ef56e1c24f25b892d34cf73a403774e701a0831d189799c9bb33f7b"}'::jsonb AND (objects->'user_bill') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"8c28df2335af833c85658983df4e03c1202fdaa612550407122433b049ea19d5"}'::jsonb AND (objects->'user_money') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fc130d4977144e49c38c190a7949db01c472622a676b88bf525179ebac4d0290"}'::jsonb AND (objects->'wechat_user') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fb68f9c18236ea7f757726df87997cab1387479b6ee7690fef6ce38e6adba926"}'::jsonb THEN 'v1'
  WHEN (objects->'member_right') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ffed4c38d3893a186f8614d982dd397e0990cf9b068e696b1fd7afe7d5cbb331"}'::jsonb AND (objects->'other_order') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"1756e4e38c754862d1c76faac3e4ebbcf105484e09bddcabffc27e26dfbf820b"}'::jsonb AND (objects->'payment_callback_event') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"4ee2a3598865029344ff616079f864732d515805c9f3256c8bf96c4e961ff4f8"}'::jsonb AND (objects->'payment_reconciliation_case') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"661c6de1684ecbff9630e049d43e14263f01f60b8cd46ac1bf2aa71a74bd6739"}'::jsonb AND (objects->'store_order_economize') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"2383680a0cd0cd12c917c3b5214d4da6ad9facf5bc81f8c3f745656cc02b106c"}'::jsonb AND (objects->'system_config') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"10becbd6bf8ae6ed41dba14e474fc8529df4116c61e84365b60c50d11e1b4336"}'::jsonb AND (objects->'user') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"9d8390088ef56e1c24f25b892d34cf73a403774e701a0831d189799c9bb33f7b"}'::jsonb AND (objects->'user_bill') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b0390aca3bbc3e790de7581444678f594a65d1778187b05fd2701f2994f2faf9"}'::jsonb AND (objects->'user_money') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"7d80098a75e284bc393dd16dc98fb867435cc3fc4f107f43aaa490c2a560e763"}'::jsonb AND (objects->'wechat_user') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fb68f9c18236ea7f757726df87997cab1387479b6ee7690fef6ce38e6adba926"}'::jsonb AND (objects->'offline_order_admission') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"0c2a9fc2cb738c76b6ac518fa0cc71832e773e1b28328a4e310d8d9b8dc08a94"}'::jsonb AND (objects->'offline_order_balance') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"0555c78f98eefbd1392281c7698ca5f930be1ca1ae4f50d805d9ccb59102ce28"}'::jsonb AND (objects->'offline_order_callback_binding') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ecd8ba1c25926cd6304844d0c3697ebd57e61f96e494870c5c152baaf3cf95f2"}'::jsonb AND (objects->'offline_order_external_payment') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"65b9f9beb5b0652e8cf4ecf29325423375b0f62960bf3427032ebadc9112d7ae"}'::jsonb AND (objects->'offline_order_payment_dispatch') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"d92333abf3ab54db25503ece15dec2e4620d7ac063bb3ad3840578ed02aa0529"}'::jsonb AND (objects->'offline_order_payment_selection') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"12abd2bff4cb2ec209fb55bac6dcbafa258a9e5fa9ef11c4b3ddb948956ae934"}'::jsonb AND (objects->'offline_order_query_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"3fa09ba5101a8a7d9a5703c160013cf2888b0eac06bceeb711b4bc6c7a6225ca"}'::jsonb AND (objects->'ooa_lock_pricing') @> '{"present":false}'::jsonb AND (objects->'ooa_guard') @> '{"present":false}'::jsonb AND (objects->'oops_guard') @> '{"present":false}'::jsonb AND (objects->'oops_wallet_commit') @> '{"present":false}'::jsonb AND (objects->'oob_guard') @> '{"present":false}'::jsonb AND (objects->'ooqe_guard') @> '{"present":false}'::jsonb AND (objects->'oocb_guard') @> '{"present":false}'::jsonb AND (objects->'ooep_guard') @> '{"present":false}'::jsonb AND (objects->'ooep_paid_commit') @> '{"present":false}'::jsonb AND (objects->'oopd_guard') @> '{"present":false}'::jsonb THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot) c;
  IF initial_state IS DISTINCT FROM final_state THEN RAISE EXCEPTION 'Offline catalog changed during locking'; END IF;
  IF initial_state='orm-pending' THEN
    IF EXISTS(SELECT 1 FROM public.offline_order_admission) OR EXISTS(SELECT 1 FROM public.offline_order_payment_selection) OR EXISTS(SELECT 1 FROM public.offline_order_balance) OR EXISTS(SELECT 1 FROM public.offline_order_query_evidence) OR EXISTS(SELECT 1 FROM public.offline_order_callback_binding) OR EXISTS(SELECT 1 FROM public.offline_order_external_payment) OR EXISTS(SELECT 1 FROM public.offline_order_payment_dispatch) THEN
      RAISE EXCEPTION 'Unprotected offline ORM ledgers must all be empty; no evidence repair is allowed';
    END IF;
    CREATE FUNCTION public.ooa_lock_pricing() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $ooa_lock$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'offline admission requires READ COMMITTED' USING ERRCODE='25000';
  END IF;
  LOCK TABLE public.member_right,public.system_config IN SHARE MODE NOWAIT;
END $ooa_lock$;
REVOKE ALL ON FUNCTION public.ooa_lock_pricing() FROM PUBLIC;

CREATE FUNCTION public.ooa_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $ooa$
DECLARE o public.other_order%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='offline_order_admission' THEN
    IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'offline admission is immutable'; END IF;
    SELECT * INTO o FROM public.other_order WHERE id=NEW.order_id FOR UPDATE;
    IF NOT FOUND OR o.uid<>NEW.uid OR o.order_id<>NEW.order_no OR o.type<>3
      OR o.store_id<>0 OR o.staff_id<>0 OR o.money<>NEW.raw_price OR o.pay_price<>NEW.pay_price
      OR o.member_price<>NEW.pay_price OR o.channel_type<>NEW.channel OR o.add_time<>NEW.created_at
      OR o.paid<>0 OR o.pay_type<>'' OR o.trade_no<>'' OR o.pay_time<>0 OR o.is_del<>0
      OR o.member_type<>'' OR o.is_free<>0 OR o.is_permanent<>0 OR o.vip_day<>0 OR o.overdue_time<>0
    THEN RAISE EXCEPTION 'offline admission order mismatch'; END IF;
    RETURN NEW;
  END IF;
  IF EXISTS(SELECT 1 FROM public.offline_order_admission WHERE order_id=OLD.id) THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'admitted offline order cannot be deleted'; END IF;
    IF ROW(NEW.id,NEW.uid,NEW.order_id,NEW.type,NEW.store_id,NEW.staff_id,NEW.money,NEW.pay_price,NEW.member_price,
      NEW.channel_type,NEW.add_time,NEW.member_type,NEW.is_free,NEW.is_permanent,NEW.vip_day,NEW.overdue_time)
      IS DISTINCT FROM ROW(OLD.id,OLD.uid,OLD.order_id,OLD.type,OLD.store_id,OLD.staff_id,OLD.money,OLD.pay_price,OLD.member_price,
      OLD.channel_type,OLD.add_time,OLD.member_type,OLD.is_free,OLD.is_permanent,OLD.vip_day,OLD.overdue_time)
    THEN RAISE EXCEPTION 'offline order admission fields are immutable'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $ooa$;
REVOKE ALL ON FUNCTION public.ooa_guard() FROM PUBLIC;
CREATE TRIGGER ooa_insert_guard BEFORE INSERT ON public.offline_order_admission FOR EACH ROW EXECUTE FUNCTION public.ooa_guard();
CREATE TRIGGER ooa_change_guard BEFORE UPDATE OR DELETE ON public.offline_order_admission FOR EACH ROW EXECUTE FUNCTION public.ooa_guard();
CREATE TRIGGER ooa_truncate_guard BEFORE TRUNCATE ON public.offline_order_admission FOR EACH STATEMENT EXECUTE FUNCTION public.ooa_guard();
CREATE TRIGGER ooa_order_guard BEFORE UPDATE OR DELETE ON public.other_order FOR EACH ROW EXECUTE FUNCTION public.ooa_guard();

CREATE FUNCTION public.oops_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $oops$
DECLARE o public.other_order%ROWTYPE; a public.offline_order_admission%ROWTYPE;
  s public.offline_order_payment_selection%ROWTYPE; matches integer; payer text;
BEGIN
  IF TG_TABLE_NAME='offline_order_payment_selection' THEN
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'offline payment selection is immutable'; END IF;
    IF current_setting('transaction_isolation')<>'read committed' THEN
      RAISE EXCEPTION 'offline payment requires READ COMMITTED' USING ERRCODE='25000';
    END IF;
    SELECT * INTO o FROM public.other_order WHERE id=NEW.order_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'offline payment order missing'; END IF;
    SELECT * INTO a FROM public.offline_order_admission WHERE order_id=NEW.order_id;
    IF NOT FOUND OR a.uid<>NEW.uid OR a.order_no<>NEW.order_no OR a.pay_price<>NEW.pay_price
      OR o.uid<>NEW.uid OR o.order_id<>NEW.order_no OR o.type<>3 OR o.pay_price<>NEW.pay_price
      OR o.paid<>0 OR o.pay_type<>'' OR o.trade_no<>'' OR o.pay_time<>0 OR o.is_del<>0 OR NEW.created_at<a.created_at
    THEN RAISE EXCEPTION 'offline payment selection order mismatch'; END IF;
    PERFORM uid FROM public."user" WHERE uid=NEW.uid AND status=1 AND is_del=0 AND delete_time IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'offline payment account unavailable'; END IF;
    IF NEW.rail='wechat' THEN
      IF (a.channel='routine' AND (NEW.profile<>'routine' OR NEW.transaction_type<>'jsapi'))
        OR (a.channel='wechat' AND (NEW.profile<>'wechat' OR NEW.transaction_type<>'jsapi'))
        OR (a.channel IN ('h5','weixinh5') AND (NEW.profile<>'wechat' OR NEW.transaction_type<>'h5'))
      THEN RAISE EXCEPTION 'offline payment channel mismatch'; END IF;
      IF NEW.transaction_type='jsapi' THEN
        SELECT count(*),min(openid) INTO matches,payer FROM
          (SELECT openid FROM public.wechat_user WHERE uid=NEW.uid AND user_type=NEW.profile AND is_del=0 LIMIT 2 FOR UPDATE) bindings;
        IF matches<>1 OR payer IS DISTINCT FROM NEW.payer_id THEN RAISE EXCEPTION 'offline payment payer mismatch'; END IF;
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO s FROM public.offline_order_payment_selection WHERE order_id=OLD.id;
  IF FOUND AND ROW(NEW.paid,NEW.pay_type,NEW.trade_no,NEW.pay_time) IS DISTINCT FROM ROW(OLD.paid,OLD.pay_type,OLD.trade_no,OLD.pay_time) THEN
    IF NOT ((NEW.paid=0 AND NEW.pay_type='' AND NEW.trade_no='' AND NEW.pay_time=0)
      OR (NEW.paid=1 AND NEW.pay_time>=s.created_at
        AND NEW.pay_type=CASE s.rail WHEN 'wechat' THEN 'weixin' ELSE s.rail END
        AND ((s.rail='yue' AND NEW.trade_no='') OR (s.rail<>'yue' AND NEW.trade_no<>''))))
    THEN RAISE EXCEPTION 'offline payment rail mismatch'; END IF;
  END IF;
  RETURN NEW;
END $oops$;
REVOKE ALL ON FUNCTION public.oops_guard() FROM PUBLIC;
CREATE TRIGGER oops_insert_guard BEFORE INSERT ON public.offline_order_payment_selection FOR EACH ROW EXECUTE FUNCTION public.oops_guard();
CREATE TRIGGER oops_change_guard BEFORE UPDATE OR DELETE ON public.offline_order_payment_selection FOR EACH ROW EXECUTE FUNCTION public.oops_guard();
CREATE TRIGGER oops_truncate_guard BEFORE TRUNCATE ON public.offline_order_payment_selection FOR EACH STATEMENT EXECUTE FUNCTION public.oops_guard();
CREATE TRIGGER oops_order_guard BEFORE UPDATE ON public.other_order FOR EACH ROW EXECUTE FUNCTION public.oops_guard();

-- A wallet reservation is never an orphan committed before the debit. External
-- choices intentionally persist while provider outcome is still unknown.
CREATE FUNCTION public.oops_wallet_commit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $oops_commit$
BEGIN
  IF NEW.rail='yue' AND NOT EXISTS(SELECT 1 FROM public.offline_order_balance
    WHERE order_id=NEW.order_id AND uid=NEW.uid AND order_no=NEW.order_no AND pay_price=NEW.pay_price AND paid_at=NEW.created_at)
  THEN RAISE EXCEPTION 'offline wallet selection requires committed receipt'; END IF;
  RETURN NULL;
END $oops_commit$;
REVOKE ALL ON FUNCTION public.oops_wallet_commit() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER oops_wallet_commit AFTER INSERT ON public.offline_order_payment_selection
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.oops_wallet_commit();

CREATE FUNCTION public.oob_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $oob$
DECLARE o public.other_order%ROWTYPE; a public.offline_order_admission%ROWTYPE;
  p public.offline_order_payment_selection%ROWTYPE;
  u public."user"%ROWTYPE; m public.user_money%ROWTYPE; b public.user_bill%ROWTYPE;
  s public.store_order_economize%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='offline_order_balance' THEN
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'offline balance receipt is immutable'; END IF;
    SELECT * INTO o FROM public.other_order WHERE id=NEW.order_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'offline balance order missing'; END IF;
    SELECT * INTO a FROM public.offline_order_admission WHERE order_id=NEW.order_id;
    IF NOT FOUND OR a.uid<>NEW.uid OR a.order_no<>NEW.order_no OR a.pay_price<>NEW.pay_price
      OR o.uid<>NEW.uid OR o.order_id<>NEW.order_no OR o.type<>3 OR o.pay_price<>NEW.pay_price
      OR o.paid<>1 OR o.pay_type<>'yue' OR o.pay_time<>NEW.paid_at OR o.trade_no<>'' OR o.is_del<>0
      OR NEW.paid_at<a.created_at
    THEN RAISE EXCEPTION 'offline balance order mismatch'; END IF;
    SELECT * INTO p FROM public.offline_order_payment_selection WHERE order_id=NEW.order_id;
    IF NOT FOUND OR p.rail<>'yue' OR p.uid<>NEW.uid OR p.order_no<>NEW.order_no OR p.pay_price<>NEW.pay_price OR p.created_at<>NEW.paid_at
    THEN RAISE EXCEPTION 'offline balance payment selection mismatch'; END IF;
    SELECT * INTO u FROM public."user" WHERE uid=NEW.uid FOR UPDATE;
    IF NOT FOUND OR u.status<>1 OR u.is_del<>0 OR u.delete_time IS NOT NULL
      OR u.now_money<>NEW.balance_after OR u.integral<>NEW.integral_after OR (NEW.promoted AND u.is_promoter<>1)
    THEN RAISE EXCEPTION 'offline balance account mismatch'; END IF;
    SELECT * INTO m FROM public.user_money WHERE id=NEW.money_id FOR UPDATE;
    IF NOT FOUND OR m.uid<>NEW.uid OR m.link_id<>NEW.order_no OR m.type<>'offline_scan'
      OR m.pm<>0 OR m.status<>1 OR m.number<>NEW.pay_price OR m.balance<>NEW.balance_after OR m.add_time<>NEW.paid_at
    THEN RAISE EXCEPTION 'offline balance money mismatch'; END IF;
    IF NEW.integral_bill_id IS NOT NULL THEN
      SELECT * INTO b FROM public.user_bill WHERE id=NEW.integral_bill_id FOR UPDATE;
      IF NOT FOUND OR b.uid<>NEW.uid OR b.link_id<>NEW.order_no OR b.category<>'integral' OR b.type<>'gain'
        OR b.event_key<>'offline_order_give_integral' OR b.pm<>1 OR b.status<>1 OR b.take<>0 OR b.frozen_time<>0
        OR b.number<>NEW.integral_reward OR b.balance<>NEW.integral_after OR b.add_time<>NEW.paid_at
      THEN RAISE EXCEPTION 'offline balance integral mismatch'; END IF;
    END IF;
    IF (a.discount_percent>0) IS DISTINCT FROM (NEW.savings_id IS NOT NULL)
    THEN RAISE EXCEPTION 'offline balance savings identity mismatch'; END IF;
    IF NEW.savings_id IS NOT NULL THEN
      SELECT * INTO s FROM public.store_order_economize WHERE id=NEW.savings_id FOR UPDATE;
      IF NOT FOUND OR s.uid<>NEW.uid OR s.order_id<>NEW.order_no OR s.order_type<>2 OR s.pay_price<>NEW.pay_price
        OR s.offline_price<>a.raw_price-a.pay_price OR s.postage_price<>0 OR s.member_price<>0 OR s.coupon_price<>0
        OR s.add_time<>NEW.paid_at OR s.status<>0
      THEN RAISE EXCEPTION 'offline balance savings mismatch'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='TRUNCATE' THEN
    IF EXISTS(SELECT 1 FROM public.offline_order_balance) THEN RAISE EXCEPTION 'offline balance effects are immutable'; END IF;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME='other_order' THEN
    IF EXISTS(SELECT 1 FROM public.offline_order_balance WHERE order_id=OLD.id) THEN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'offline balance paid state is immutable'; END IF;
      IF ROW(NEW.paid,NEW.pay_type,NEW.pay_time,NEW.trade_no) IS DISTINCT FROM ROW(OLD.paid,OLD.pay_type,OLD.pay_time,OLD.trade_no)
      THEN RAISE EXCEPTION 'offline balance paid state is immutable'; END IF;
    END IF;
  ELSIF (TG_TABLE_NAME='user_money' AND EXISTS(SELECT 1 FROM public.offline_order_balance WHERE money_id=OLD.id))
    OR (TG_TABLE_NAME='user_bill' AND EXISTS(SELECT 1 FROM public.offline_order_balance WHERE integral_bill_id=OLD.id))
    OR (TG_TABLE_NAME='store_order_economize' AND EXISTS(SELECT 1 FROM public.offline_order_balance WHERE savings_id=OLD.id))
  THEN RAISE EXCEPTION 'offline balance effects are immutable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $oob$;
REVOKE ALL ON FUNCTION public.oob_guard() FROM PUBLIC;
CREATE TRIGGER oob_insert_guard BEFORE INSERT ON public.offline_order_balance FOR EACH ROW EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_change_guard BEFORE UPDATE OR DELETE ON public.offline_order_balance FOR EACH ROW EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_truncate_guard BEFORE TRUNCATE ON public.offline_order_balance FOR EACH STATEMENT EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_order_guard BEFORE UPDATE OR DELETE ON public.other_order FOR EACH ROW EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_money_guard BEFORE UPDATE OR DELETE ON public.user_money FOR EACH ROW EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_bill_guard BEFORE UPDATE OR DELETE ON public.user_bill FOR EACH ROW EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_savings_guard BEFORE UPDATE OR DELETE ON public.store_order_economize FOR EACH ROW EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_money_truncate BEFORE TRUNCATE ON public.user_money FOR EACH STATEMENT EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_bill_truncate BEFORE TRUNCATE ON public.user_bill FOR EACH STATEMENT EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_savings_truncate BEFORE TRUNCATE ON public.store_order_economize FOR EACH STATEMENT EXECUTE FUNCTION public.oob_guard();

CREATE FUNCTION public.ooqe_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $ooqe$
DECLARE p public.offline_order_payment_selection%ROWTYPE; r public.payment_reconciliation_case%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'offline query evidence is immutable'; END IF;
  SELECT * INTO p FROM public.offline_order_payment_selection WHERE selection_key=NEW.selection_key;
  IF NOT FOUND OR p.rail<>NEW.provider OR p.profile<>NEW.profile OR p.order_no<>NEW.order_no
    OR p.pay_price*100<>NEW.amount_cents OR p.currency<>NEW.currency OR NEW.created_at<p.created_at
  THEN RAISE EXCEPTION 'offline query selection mismatch'; END IF;
  SELECT * INTO r FROM public.payment_reconciliation_case WHERE id=NEW.case_id;
  IF NOT FOUND OR r.provider<>NEW.provider OR r.profile<>NEW.profile OR r.order_no<>NEW.order_no
    OR r.order_domain<>'offline_order' OR r.expected_amount_cents<>NEW.amount_cents OR r.currency<>NEW.currency
  THEN RAISE EXCEPTION 'offline query recovery mismatch'; END IF;
  RETURN NEW;
END $ooqe$;
REVOKE ALL ON FUNCTION public.ooqe_guard() FROM PUBLIC;
CREATE TRIGGER ooqe_insert_guard BEFORE INSERT ON public.offline_order_query_evidence FOR EACH ROW EXECUTE FUNCTION public.ooqe_guard();
CREATE TRIGGER ooqe_change_guard BEFORE UPDATE OR DELETE ON public.offline_order_query_evidence FOR EACH ROW EXECUTE FUNCTION public.ooqe_guard();
CREATE TRIGGER ooqe_truncate_guard BEFORE TRUNCATE ON public.offline_order_query_evidence FOR EACH STATEMENT EXECUTE FUNCTION public.ooqe_guard();
CREATE FUNCTION public.oocb_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $oocb$
DECLARE e public.payment_callback_event%ROWTYPE; p public.offline_order_payment_selection%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='offline_order_callback_binding' THEN
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'offline callback binding is immutable'; END IF;
    SELECT * INTO e FROM public.payment_callback_event WHERE id=NEW.event_id FOR UPDATE;
    IF NOT FOUND OR e.payload_hash<>NEW.event_hash OR e.currency<>'CNY' OR e.order_domain NOT IN ('','offline_order')
      OR e.last_error_code='transaction_evidence_conflict'
      OR NOT ((e.provider='wechat' AND e.trade_state='SUCCESS') OR (e.provider='alipay' AND e.trade_state IN ('TRADE_SUCCESS','TRADE_FINISHED')))
    THEN RAISE EXCEPTION 'offline callback event mismatch'; END IF;
    SELECT * INTO p FROM public.offline_order_payment_selection WHERE selection_key=NEW.selection_key;
    IF NOT FOUND OR p.rail<>e.provider OR p.profile<>e.profile OR p.order_no<>e.order_no
      OR p.pay_price*100<>e.amount_cents OR NEW.created_at<p.created_at
    THEN RAISE EXCEPTION 'offline callback selection mismatch'; END IF;
    RETURN NEW;
  END IF;
  IF EXISTS(SELECT 1 FROM public.offline_order_callback_binding WHERE event_id=OLD.id) AND
    ROW(NEW.id,NEW.provider,NEW.profile,NEW.provider_event_id,NEW.replay_key,NEW.payload_hash,NEW.order_no,
      NEW.transaction_id,NEW.trade_state,NEW.amount_cents,NEW.currency,NEW.provider_event_time)
    IS DISTINCT FROM ROW(OLD.id,OLD.provider,OLD.profile,OLD.provider_event_id,OLD.replay_key,OLD.payload_hash,OLD.order_no,
      OLD.transaction_id,OLD.trade_state,OLD.amount_cents,OLD.currency,OLD.provider_event_time)
  THEN RAISE EXCEPTION 'bound offline callback evidence is immutable'; END IF;
  RETURN NEW;
END $oocb$;
REVOKE ALL ON FUNCTION public.oocb_guard() FROM PUBLIC;
CREATE TRIGGER oocb_insert_guard BEFORE INSERT ON public.offline_order_callback_binding FOR EACH ROW EXECUTE FUNCTION public.oocb_guard();
CREATE TRIGGER oocb_change_guard BEFORE UPDATE OR DELETE ON public.offline_order_callback_binding FOR EACH ROW EXECUTE FUNCTION public.oocb_guard();
CREATE TRIGGER oocb_truncate_guard BEFORE TRUNCATE ON public.offline_order_callback_binding FOR EACH STATEMENT EXECUTE FUNCTION public.oocb_guard();
CREATE TRIGGER oocb_event_guard BEFORE UPDATE ON public.payment_callback_event FOR EACH ROW EXECUTE FUNCTION public.oocb_guard();

CREATE FUNCTION public.ooep_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $ooep$
DECLARE o public.other_order%ROWTYPE; a public.offline_order_admission%ROWTYPE; p public.offline_order_payment_selection%ROWTYPE;
  e public.payment_callback_event%ROWTYPE; c public.offline_order_callback_binding%ROWTYPE; q public.offline_order_query_evidence%ROWTYPE;
  u public."user"%ROWTYPE; b public.user_bill%ROWTYPE; s public.store_order_economize%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='offline_order_external_payment' THEN
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'offline external receipt is immutable'; END IF;
    SELECT * INTO o FROM public.other_order WHERE id=NEW.order_id FOR UPDATE;
    IF NOT FOUND OR o.uid<>NEW.uid OR o.order_id<>NEW.order_no OR o.type<>3 OR o.pay_price<>NEW.pay_price
      OR o.paid<>1 OR o.pay_type<>(CASE NEW.provider WHEN 'wechat' THEN 'weixin' ELSE 'alipay' END)
      OR o.pay_time<>NEW.paid_at OR o.trade_no<>NEW.transaction_id
    THEN RAISE EXCEPTION 'offline external paid order mismatch'; END IF;
    SELECT * INTO a FROM public.offline_order_admission WHERE order_id=NEW.order_id;
    IF NOT FOUND OR a.uid<>NEW.uid OR a.order_no<>NEW.order_no OR a.pay_price<>NEW.pay_price
    THEN RAISE EXCEPTION 'offline external admission mismatch'; END IF;
    SELECT * INTO p FROM public.offline_order_payment_selection WHERE order_id=NEW.order_id;
    IF NOT FOUND OR p.rail<>NEW.provider OR p.profile<>NEW.profile OR p.uid<>NEW.uid OR p.order_no<>NEW.order_no
      OR p.pay_price<>NEW.pay_price OR NEW.paid_at<p.created_at
    THEN RAISE EXCEPTION 'offline external selection mismatch'; END IF;
    IF NEW.event_id IS NOT NULL THEN
    SELECT * INTO c FROM public.offline_order_callback_binding WHERE event_id=NEW.event_id;
    IF NOT FOUND OR c.selection_key<>p.selection_key OR NEW.paid_at<c.created_at
    THEN RAISE EXCEPTION 'offline external binding mismatch'; END IF;
    SELECT * INTO e FROM public.payment_callback_event WHERE id=NEW.event_id;
    IF NOT FOUND OR e.payload_hash<>c.event_hash OR e.provider<>NEW.provider OR e.profile<>NEW.profile
      OR e.order_no<>NEW.order_no OR e.transaction_id<>NEW.transaction_id OR e.amount_cents<>NEW.pay_price*100
      OR e.currency<>'CNY' OR e.provider_event_time<>NEW.provider_paid_at
      OR NOT ((e.provider='wechat' AND e.trade_state='SUCCESS') OR (e.provider='alipay' AND e.trade_state IN ('TRADE_SUCCESS','TRADE_FINISHED')))
    THEN RAISE EXCEPTION 'offline external collection mismatch'; END IF;
    ELSE
      SELECT * INTO q FROM public.offline_order_query_evidence WHERE id=NEW.query_id;
      IF NOT FOUND OR q.selection_key<>p.selection_key OR NEW.paid_at<q.created_at
        OR q.provider<>NEW.provider OR q.profile<>NEW.profile OR q.order_no<>NEW.order_no
        OR q.transaction_id<>NEW.transaction_id OR q.amount_cents<>NEW.pay_price*100
        OR q.currency<>'CNY' OR q.provider_event_time<>NEW.provider_paid_at
      THEN RAISE EXCEPTION 'offline external query collection mismatch'; END IF;
    END IF;
    SELECT * INTO u FROM public."user" WHERE uid=NEW.uid FOR UPDATE;
    IF NOT FOUND OR u.integral<>NEW.integral_after OR (NEW.promoted AND u.is_promoter<>1)
    THEN RAISE EXCEPTION 'offline external account mismatch'; END IF;
    IF NEW.integral_bill_id IS NOT NULL THEN
      SELECT * INTO b FROM public.user_bill WHERE id=NEW.integral_bill_id FOR UPDATE;
      IF NOT FOUND OR b.uid<>NEW.uid OR b.link_id<>NEW.order_no OR b.category<>'integral' OR b.type<>'gain'
        OR b.event_key<>'offline_order_give_integral' OR b.pm<>1 OR b.status<>1 OR b.take<>0 OR b.frozen_time<>0
        OR b.number<>NEW.integral_reward OR b.balance<>NEW.integral_after OR b.add_time<>NEW.paid_at
      THEN RAISE EXCEPTION 'offline external integral mismatch'; END IF;
    END IF;
    IF (a.discount_percent>0) IS DISTINCT FROM (NEW.savings_id IS NOT NULL)
    THEN RAISE EXCEPTION 'offline external savings identity mismatch'; END IF;
    IF NEW.savings_id IS NOT NULL THEN
      SELECT * INTO s FROM public.store_order_economize WHERE id=NEW.savings_id FOR UPDATE;
      IF NOT FOUND OR s.uid<>NEW.uid OR s.order_id<>NEW.order_no OR s.order_type<>2 OR s.pay_price<>NEW.pay_price
        OR s.offline_price<>a.raw_price-a.pay_price OR s.postage_price<>0 OR s.member_price<>0 OR s.coupon_price<>0
        OR s.add_time<>NEW.paid_at OR s.status<>0
      THEN RAISE EXCEPTION 'offline external savings mismatch'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='TRUNCATE' THEN
    IF EXISTS(SELECT 1 FROM public.offline_order_external_payment) THEN RAISE EXCEPTION 'offline external effects are immutable'; END IF;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME='other_order' THEN
    IF EXISTS(SELECT 1 FROM public.offline_order_external_payment WHERE order_id=OLD.id) THEN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'offline external paid state is immutable'; END IF;
      IF ROW(NEW.paid,NEW.pay_type,NEW.pay_time,NEW.trade_no) IS DISTINCT FROM ROW(OLD.paid,OLD.pay_type,OLD.pay_time,OLD.trade_no)
      THEN RAISE EXCEPTION 'offline external paid state is immutable'; END IF;
    END IF;
  ELSIF (TG_TABLE_NAME='user_bill' AND EXISTS(SELECT 1 FROM public.offline_order_external_payment WHERE integral_bill_id=OLD.id))
    OR (TG_TABLE_NAME='store_order_economize' AND EXISTS(SELECT 1 FROM public.offline_order_external_payment WHERE savings_id=OLD.id))
  THEN RAISE EXCEPTION 'offline external effects are immutable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $ooep$;
REVOKE ALL ON FUNCTION public.ooep_guard() FROM PUBLIC;
CREATE TRIGGER ooep_insert_guard BEFORE INSERT ON public.offline_order_external_payment FOR EACH ROW EXECUTE FUNCTION public.ooep_guard();
CREATE TRIGGER ooep_change_guard BEFORE UPDATE OR DELETE ON public.offline_order_external_payment FOR EACH ROW EXECUTE FUNCTION public.ooep_guard();
CREATE TRIGGER ooep_truncate_guard BEFORE TRUNCATE ON public.offline_order_external_payment FOR EACH STATEMENT EXECUTE FUNCTION public.ooep_guard();
CREATE TRIGGER ooep_order_guard BEFORE UPDATE OR DELETE ON public.other_order FOR EACH ROW EXECUTE FUNCTION public.ooep_guard();
CREATE TRIGGER ooep_bill_guard BEFORE UPDATE OR DELETE ON public.user_bill FOR EACH ROW EXECUTE FUNCTION public.ooep_guard();
CREATE TRIGGER ooep_savings_guard BEFORE UPDATE OR DELETE ON public.store_order_economize FOR EACH ROW EXECUTE FUNCTION public.ooep_guard();
CREATE TRIGGER ooep_bill_truncate BEFORE TRUNCATE ON public.user_bill FOR EACH STATEMENT EXECUTE FUNCTION public.ooep_guard();
CREATE TRIGGER ooep_savings_truncate BEFORE TRUNCATE ON public.store_order_economize FOR EACH STATEMENT EXECUTE FUNCTION public.ooep_guard();

-- Unlike a pre-dispatch selection, a paid state cannot commit ahead of its
-- financial receipt. Deferred so the order update and receipt can be atomic.
CREATE FUNCTION public.ooep_paid_commit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $ooep_commit$
BEGIN
  IF NEW.type=3 AND NEW.paid=1 AND EXISTS(SELECT 1 FROM public.offline_order_payment_selection
    WHERE order_id=NEW.id AND rail IN ('wechat','alipay')) AND NOT EXISTS(SELECT 1 FROM public.offline_order_external_payment
      WHERE order_id=NEW.id AND uid=NEW.uid AND order_no=NEW.order_id AND pay_price=NEW.pay_price
        AND paid_at=NEW.pay_time AND transaction_id=NEW.trade_no
        AND NEW.pay_type=CASE provider WHEN 'wechat' THEN 'weixin' ELSE 'alipay' END)
  THEN RAISE EXCEPTION 'offline external paid state requires committed receipt'; END IF;
  RETURN NULL;
END $ooep_commit$;
REVOKE ALL ON FUNCTION public.ooep_paid_commit() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER ooep_paid_commit AFTER UPDATE ON public.other_order
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.ooep_paid_commit();

CREATE FUNCTION public.oopd_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $oopd$
DECLARE s public.offline_order_payment_selection%ROWTYPE; c public.payment_reconciliation_case%ROWTYPE;
BEGIN
  IF TG_OP NOT IN ('INSERT','UPDATE') THEN RAISE EXCEPTION 'offline dispatch cannot be removed'; END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.selection_key,NEW.attempt_key,NEW.case_id,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.selection_key,OLD.attempt_key,OLD.case_id,OLD.created_at)
      OR OLD.state<>'ISSUING' OR NEW.state NOT IN ('READY','UNKNOWN')
    THEN RAISE EXCEPTION 'offline dispatch transition invalid'; END IF;
    RETURN NEW;
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'offline dispatch requires READ COMMITTED'; END IF;
  SELECT * INTO s FROM public.offline_order_payment_selection WHERE selection_key=NEW.selection_key;
  IF NOT FOUND OR s.rail NOT IN ('wechat','alipay') OR NEW.state<>'ISSUING' OR NEW.created_at<>s.created_at
    THEN RAISE EXCEPTION 'offline dispatch selection mismatch'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('payment-reconciliation:' || s.rail || ':' || s.order_no,0));
  SELECT * INTO c FROM public.payment_reconciliation_case WHERE id=NEW.case_id FOR UPDATE;
  IF NOT FOUND OR c.provider<>s.rail OR c.profile<>s.profile OR c.order_domain<>'offline_order' OR c.order_no<>s.order_no
    OR c.expected_amount_cents<>s.pay_price*100 OR c.currency<>'CNY' OR c.status<>'OPEN'
    OR c.provider_status<>'UNKNOWN' OR c.provider_transaction_id<>'' OR c.callback_event_id IS NOT NULL
    OR c.initiated_time<>NEW.created_at
  THEN RAISE EXCEPTION 'offline dispatch recovery mismatch'; END IF;
  PERFORM id FROM public.other_order WHERE id=s.order_id AND uid=s.uid AND paid=0 AND pay_type='' AND trade_no='' AND pay_time=0 AND is_del=0 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'offline dispatch order unavailable'; END IF;
  PERFORM uid FROM public."user" WHERE uid=s.uid AND status=1 AND is_del=0 AND delete_time IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'offline dispatch account unavailable'; END IF;
  RETURN NEW;
END $oopd$;
REVOKE ALL ON FUNCTION public.oopd_guard() FROM PUBLIC;
CREATE TRIGGER oopd_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.offline_order_payment_dispatch
  FOR EACH ROW EXECUTE FUNCTION public.oopd_guard();
CREATE TRIGGER oopd_truncate_guard BEFORE TRUNCATE ON public.offline_order_payment_dispatch
  FOR EACH STATEMENT EXECUTE FUNCTION public.oopd_guard();

  ELSIF initial_state='fresh' THEN

CREATE TABLE public.offline_order_admission (
  uid integer NOT NULL, request_key uuid NOT NULL, request_hash varchar(64) NOT NULL,
  order_id integer NOT NULL, order_no varchar(32) NOT NULL,
  version varchar(32) NOT NULL DEFAULT 'offline-admission-v1',
  raw_price numeric(10,2) NOT NULL, pay_price numeric(10,2) NOT NULL,
  member_active boolean NOT NULL, discount_percent integer NOT NULL,
  channel varchar(10) NOT NULL, created_at integer NOT NULL,
  CONSTRAINT ooa_pk PRIMARY KEY(uid,request_key),
  CONSTRAINT ooa_user_fk FOREIGN KEY(uid) REFERENCES public."user"(uid) ON DELETE RESTRICT,
  CONSTRAINT ooa_order_fk FOREIGN KEY(order_id) REFERENCES public.other_order(id) ON DELETE RESTRICT,
  CONSTRAINT ooa_identity_ck CHECK(uid>0 AND order_id>0 AND created_at>0
    AND request_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND request_hash ~ '^[0-9a-f]{64}$' AND order_no ~ '^xx[0-9a-f]{30}$'
    AND version='offline-admission-v1' AND channel IN ('wechat','weixinh5','routine','h5')),
  CONSTRAINT ooa_pricing_ck CHECK(raw_price>0 AND pay_price>=0 AND discount_percent BETWEEN 0 AND 100
    AND (member_active OR discount_percent=0)
    AND pay_price=CASE WHEN discount_percent=0 THEN raw_price ELSE trunc(raw_price*discount_percent/100,2) END)
);
CREATE UNIQUE INDEX ooa_order_id_uq ON public.offline_order_admission(order_id);
CREATE UNIQUE INDEX ooa_order_no_uq ON public.offline_order_admission(order_no);
CREATE INDEX ooa_user_history ON public.offline_order_admission(uid,created_at,order_id);
REVOKE ALL ON public.offline_order_admission FROM PUBLIC;

CREATE FUNCTION public.ooa_lock_pricing() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $ooa_lock$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'offline admission requires READ COMMITTED' USING ERRCODE='25000';
  END IF;
  LOCK TABLE public.member_right,public.system_config IN SHARE MODE NOWAIT;
END $ooa_lock$;
REVOKE ALL ON FUNCTION public.ooa_lock_pricing() FROM PUBLIC;

CREATE FUNCTION public.ooa_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $ooa$
DECLARE o public.other_order%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='offline_order_admission' THEN
    IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'offline admission is immutable'; END IF;
    SELECT * INTO o FROM public.other_order WHERE id=NEW.order_id FOR UPDATE;
    IF NOT FOUND OR o.uid<>NEW.uid OR o.order_id<>NEW.order_no OR o.type<>3
      OR o.store_id<>0 OR o.staff_id<>0 OR o.money<>NEW.raw_price OR o.pay_price<>NEW.pay_price
      OR o.member_price<>NEW.pay_price OR o.channel_type<>NEW.channel OR o.add_time<>NEW.created_at
      OR o.paid<>0 OR o.pay_type<>'' OR o.trade_no<>'' OR o.pay_time<>0 OR o.is_del<>0
      OR o.member_type<>'' OR o.is_free<>0 OR o.is_permanent<>0 OR o.vip_day<>0 OR o.overdue_time<>0
    THEN RAISE EXCEPTION 'offline admission order mismatch'; END IF;
    RETURN NEW;
  END IF;
  IF EXISTS(SELECT 1 FROM public.offline_order_admission WHERE order_id=OLD.id) THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'admitted offline order cannot be deleted'; END IF;
    IF ROW(NEW.id,NEW.uid,NEW.order_id,NEW.type,NEW.store_id,NEW.staff_id,NEW.money,NEW.pay_price,NEW.member_price,
      NEW.channel_type,NEW.add_time,NEW.member_type,NEW.is_free,NEW.is_permanent,NEW.vip_day,NEW.overdue_time)
      IS DISTINCT FROM ROW(OLD.id,OLD.uid,OLD.order_id,OLD.type,OLD.store_id,OLD.staff_id,OLD.money,OLD.pay_price,OLD.member_price,
      OLD.channel_type,OLD.add_time,OLD.member_type,OLD.is_free,OLD.is_permanent,OLD.vip_day,OLD.overdue_time)
    THEN RAISE EXCEPTION 'offline order admission fields are immutable'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $ooa$;
REVOKE ALL ON FUNCTION public.ooa_guard() FROM PUBLIC;
CREATE TRIGGER ooa_insert_guard BEFORE INSERT ON public.offline_order_admission FOR EACH ROW EXECUTE FUNCTION public.ooa_guard();
CREATE TRIGGER ooa_change_guard BEFORE UPDATE OR DELETE ON public.offline_order_admission FOR EACH ROW EXECUTE FUNCTION public.ooa_guard();
CREATE TRIGGER ooa_truncate_guard BEFORE TRUNCATE ON public.offline_order_admission FOR EACH STATEMENT EXECUTE FUNCTION public.ooa_guard();
CREATE TRIGGER ooa_order_guard BEFORE UPDATE OR DELETE ON public.other_order FOR EACH ROW EXECUTE FUNCTION public.ooa_guard();


CREATE TABLE public.offline_order_payment_selection (
  order_id integer PRIMARY KEY REFERENCES public.offline_order_admission(order_id) ON DELETE RESTRICT,
  selection_key uuid NOT NULL, uid integer NOT NULL, order_no varchar(32) NOT NULL,
  version varchar(32) NOT NULL DEFAULT 'offline-payment-v1', rail varchar(10) NOT NULL,
  profile varchar(10) NOT NULL, transaction_type varchar(10) NOT NULL,
  app_id varchar(64) NOT NULL, merchant_id varchar(64) NOT NULL, payer_id varchar(100) NOT NULL,
  currency varchar(3) NOT NULL DEFAULT 'CNY', pay_price numeric(10,2) NOT NULL, created_at integer NOT NULL,
  CONSTRAINT oops_identity_ck CHECK(order_id>0 AND uid>0 AND order_no ~ '^xx[0-9a-f]{30}$'
    AND selection_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND version='offline-payment-v1' AND currency='CNY' AND created_at>0),
  CONSTRAINT oops_price_ck CHECK(pay_price>0 AND pay_price<>'NaN'::numeric
    AND (rail='yue' OR pay_price<=21474836.47)),
  CONSTRAINT oops_rail_ck CHECK(
    (rail='yue' AND profile='' AND transaction_type='' AND app_id='' AND merchant_id='' AND payer_id='')
    OR (rail IN ('wechat','alipay') AND app_id ~ '^[A-Za-z0-9_-]{1,64}$' AND merchant_id ~ '^[A-Za-z0-9_-]{1,64}$'
      AND ((rail='wechat' AND profile IN ('wechat','routine')
        AND ((transaction_type='jsapi' AND payer_id ~ '^[A-Za-z0-9_-]{1,100}$')
          OR (transaction_type='h5' AND profile='wechat' AND payer_id='')))
      OR (rail='alipay' AND profile='alipay' AND transaction_type='wap' AND payer_id=''))))
);
CREATE UNIQUE INDEX oops_key_uq ON public.offline_order_payment_selection(selection_key);
CREATE UNIQUE INDEX oops_order_no_uq ON public.offline_order_payment_selection(order_no);
REVOKE ALL ON public.offline_order_payment_selection FROM PUBLIC;

CREATE FUNCTION public.oops_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $oops$
DECLARE o public.other_order%ROWTYPE; a public.offline_order_admission%ROWTYPE;
  s public.offline_order_payment_selection%ROWTYPE; matches integer; payer text;
BEGIN
  IF TG_TABLE_NAME='offline_order_payment_selection' THEN
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'offline payment selection is immutable'; END IF;
    IF current_setting('transaction_isolation')<>'read committed' THEN
      RAISE EXCEPTION 'offline payment requires READ COMMITTED' USING ERRCODE='25000';
    END IF;
    SELECT * INTO o FROM public.other_order WHERE id=NEW.order_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'offline payment order missing'; END IF;
    SELECT * INTO a FROM public.offline_order_admission WHERE order_id=NEW.order_id;
    IF NOT FOUND OR a.uid<>NEW.uid OR a.order_no<>NEW.order_no OR a.pay_price<>NEW.pay_price
      OR o.uid<>NEW.uid OR o.order_id<>NEW.order_no OR o.type<>3 OR o.pay_price<>NEW.pay_price
      OR o.paid<>0 OR o.pay_type<>'' OR o.trade_no<>'' OR o.pay_time<>0 OR o.is_del<>0 OR NEW.created_at<a.created_at
    THEN RAISE EXCEPTION 'offline payment selection order mismatch'; END IF;
    PERFORM uid FROM public."user" WHERE uid=NEW.uid AND status=1 AND is_del=0 AND delete_time IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'offline payment account unavailable'; END IF;
    IF NEW.rail='wechat' THEN
      IF (a.channel='routine' AND (NEW.profile<>'routine' OR NEW.transaction_type<>'jsapi'))
        OR (a.channel='wechat' AND (NEW.profile<>'wechat' OR NEW.transaction_type<>'jsapi'))
        OR (a.channel IN ('h5','weixinh5') AND (NEW.profile<>'wechat' OR NEW.transaction_type<>'h5'))
      THEN RAISE EXCEPTION 'offline payment channel mismatch'; END IF;
      IF NEW.transaction_type='jsapi' THEN
        SELECT count(*),min(openid) INTO matches,payer FROM
          (SELECT openid FROM public.wechat_user WHERE uid=NEW.uid AND user_type=NEW.profile AND is_del=0 LIMIT 2 FOR UPDATE) bindings;
        IF matches<>1 OR payer IS DISTINCT FROM NEW.payer_id THEN RAISE EXCEPTION 'offline payment payer mismatch'; END IF;
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO s FROM public.offline_order_payment_selection WHERE order_id=OLD.id;
  IF FOUND AND ROW(NEW.paid,NEW.pay_type,NEW.trade_no,NEW.pay_time) IS DISTINCT FROM ROW(OLD.paid,OLD.pay_type,OLD.trade_no,OLD.pay_time) THEN
    IF NOT ((NEW.paid=0 AND NEW.pay_type='' AND NEW.trade_no='' AND NEW.pay_time=0)
      OR (NEW.paid=1 AND NEW.pay_time>=s.created_at
        AND NEW.pay_type=CASE s.rail WHEN 'wechat' THEN 'weixin' ELSE s.rail END
        AND ((s.rail='yue' AND NEW.trade_no='') OR (s.rail<>'yue' AND NEW.trade_no<>''))))
    THEN RAISE EXCEPTION 'offline payment rail mismatch'; END IF;
  END IF;
  RETURN NEW;
END $oops$;
REVOKE ALL ON FUNCTION public.oops_guard() FROM PUBLIC;
CREATE TRIGGER oops_insert_guard BEFORE INSERT ON public.offline_order_payment_selection FOR EACH ROW EXECUTE FUNCTION public.oops_guard();
CREATE TRIGGER oops_change_guard BEFORE UPDATE OR DELETE ON public.offline_order_payment_selection FOR EACH ROW EXECUTE FUNCTION public.oops_guard();
CREATE TRIGGER oops_truncate_guard BEFORE TRUNCATE ON public.offline_order_payment_selection FOR EACH STATEMENT EXECUTE FUNCTION public.oops_guard();
CREATE TRIGGER oops_order_guard BEFORE UPDATE ON public.other_order FOR EACH ROW EXECUTE FUNCTION public.oops_guard();

-- A wallet reservation is never an orphan committed before the debit. External
-- choices intentionally persist while provider outcome is still unknown.
CREATE FUNCTION public.oops_wallet_commit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $oops_commit$
BEGIN
  IF NEW.rail='yue' AND NOT EXISTS(SELECT 1 FROM public.offline_order_balance
    WHERE order_id=NEW.order_id AND uid=NEW.uid AND order_no=NEW.order_no AND pay_price=NEW.pay_price AND paid_at=NEW.created_at)
  THEN RAISE EXCEPTION 'offline wallet selection requires committed receipt'; END IF;
  RETURN NULL;
END $oops_commit$;
REVOKE ALL ON FUNCTION public.oops_wallet_commit() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER oops_wallet_commit AFTER INSERT ON public.offline_order_payment_selection
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.oops_wallet_commit();


CREATE TABLE public.offline_order_balance (
  order_id integer PRIMARY KEY REFERENCES public.offline_order_payment_selection(order_id) ON DELETE RESTRICT,
  uid integer NOT NULL, order_no varchar(32) NOT NULL,
  version varchar(32) NOT NULL DEFAULT 'offline-balance-v1',
  pay_price numeric(10,2) NOT NULL, balance_before numeric(12,2) NOT NULL, balance_after numeric(12,2) NOT NULL,
  money_id integer NOT NULL REFERENCES public.user_money(id) ON DELETE RESTRICT,
  integral_before integer NOT NULL, integral_after integer NOT NULL, integral_reward integer NOT NULL,
  integral_rate numeric(14,6) NOT NULL, member_bonus integer NOT NULL, member_active boolean NOT NULL,
  integral_bill_id integer REFERENCES public.user_bill(id) ON DELETE RESTRICT,
  savings_id integer REFERENCES public.store_order_economize(id) ON DELETE RESTRICT,
  promoted boolean NOT NULL, policy jsonb NOT NULL, paid_at integer NOT NULL,
  CONSTRAINT oob_identity_ck CHECK(uid>0 AND order_id>0 AND order_no ~ '^xx[0-9a-f]{30}$'
    AND version='offline-balance-v1' AND paid_at>0 AND money_id>0
    AND (integral_bill_id IS NULL OR integral_bill_id>0) AND (savings_id IS NULL OR savings_id>0)
    AND jsonb_typeof(policy)='object' AND octet_length(policy::text)<=4096),
  CONSTRAINT oob_money_ck CHECK(pay_price>0 AND pay_price<>'NaN'::numeric
    AND balance_before>=0 AND balance_before<>'NaN'::numeric AND balance_after>=0 AND balance_after<>'NaN'::numeric
    AND balance_before=balance_after+pay_price),
  CONSTRAINT oob_integral_ck CHECK(integral_before>=0 AND integral_after>=0 AND integral_reward>=0
    AND integral_after::bigint=integral_before::bigint+integral_reward::bigint
    AND integral_rate>=0 AND member_bonus>=0 AND (member_active OR member_bonus=0)
    AND integral_reward=trunc(integral_rate*pay_price)+member_bonus
    AND ((integral_reward=0 AND integral_bill_id IS NULL) OR (integral_reward>0 AND integral_bill_id IS NOT NULL)))
);
CREATE UNIQUE INDEX oob_order_no_uq ON public.offline_order_balance(order_no);
CREATE UNIQUE INDEX oob_money_uq ON public.offline_order_balance(money_id);
CREATE UNIQUE INDEX oob_integral_uq ON public.offline_order_balance(integral_bill_id);
CREATE UNIQUE INDEX oob_savings_uq ON public.offline_order_balance(savings_id);
CREATE UNIQUE INDEX um_offline_balance_uq ON public.user_money(uid,link_id) WHERE type='offline_scan';
CREATE UNIQUE INDEX ub_offline_integral_uq ON public.user_bill(uid,link_id) WHERE event_key='offline_order_give_integral';
REVOKE ALL ON public.offline_order_balance FROM PUBLIC;

CREATE FUNCTION public.oob_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $oob$
DECLARE o public.other_order%ROWTYPE; a public.offline_order_admission%ROWTYPE;
  p public.offline_order_payment_selection%ROWTYPE;
  u public."user"%ROWTYPE; m public.user_money%ROWTYPE; b public.user_bill%ROWTYPE;
  s public.store_order_economize%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='offline_order_balance' THEN
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'offline balance receipt is immutable'; END IF;
    SELECT * INTO o FROM public.other_order WHERE id=NEW.order_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'offline balance order missing'; END IF;
    SELECT * INTO a FROM public.offline_order_admission WHERE order_id=NEW.order_id;
    IF NOT FOUND OR a.uid<>NEW.uid OR a.order_no<>NEW.order_no OR a.pay_price<>NEW.pay_price
      OR o.uid<>NEW.uid OR o.order_id<>NEW.order_no OR o.type<>3 OR o.pay_price<>NEW.pay_price
      OR o.paid<>1 OR o.pay_type<>'yue' OR o.pay_time<>NEW.paid_at OR o.trade_no<>'' OR o.is_del<>0
      OR NEW.paid_at<a.created_at
    THEN RAISE EXCEPTION 'offline balance order mismatch'; END IF;
    SELECT * INTO p FROM public.offline_order_payment_selection WHERE order_id=NEW.order_id;
    IF NOT FOUND OR p.rail<>'yue' OR p.uid<>NEW.uid OR p.order_no<>NEW.order_no OR p.pay_price<>NEW.pay_price OR p.created_at<>NEW.paid_at
    THEN RAISE EXCEPTION 'offline balance payment selection mismatch'; END IF;
    SELECT * INTO u FROM public."user" WHERE uid=NEW.uid FOR UPDATE;
    IF NOT FOUND OR u.status<>1 OR u.is_del<>0 OR u.delete_time IS NOT NULL
      OR u.now_money<>NEW.balance_after OR u.integral<>NEW.integral_after OR (NEW.promoted AND u.is_promoter<>1)
    THEN RAISE EXCEPTION 'offline balance account mismatch'; END IF;
    SELECT * INTO m FROM public.user_money WHERE id=NEW.money_id FOR UPDATE;
    IF NOT FOUND OR m.uid<>NEW.uid OR m.link_id<>NEW.order_no OR m.type<>'offline_scan'
      OR m.pm<>0 OR m.status<>1 OR m.number<>NEW.pay_price OR m.balance<>NEW.balance_after OR m.add_time<>NEW.paid_at
    THEN RAISE EXCEPTION 'offline balance money mismatch'; END IF;
    IF NEW.integral_bill_id IS NOT NULL THEN
      SELECT * INTO b FROM public.user_bill WHERE id=NEW.integral_bill_id FOR UPDATE;
      IF NOT FOUND OR b.uid<>NEW.uid OR b.link_id<>NEW.order_no OR b.category<>'integral' OR b.type<>'gain'
        OR b.event_key<>'offline_order_give_integral' OR b.pm<>1 OR b.status<>1 OR b.take<>0 OR b.frozen_time<>0
        OR b.number<>NEW.integral_reward OR b.balance<>NEW.integral_after OR b.add_time<>NEW.paid_at
      THEN RAISE EXCEPTION 'offline balance integral mismatch'; END IF;
    END IF;
    IF (a.discount_percent>0) IS DISTINCT FROM (NEW.savings_id IS NOT NULL)
    THEN RAISE EXCEPTION 'offline balance savings identity mismatch'; END IF;
    IF NEW.savings_id IS NOT NULL THEN
      SELECT * INTO s FROM public.store_order_economize WHERE id=NEW.savings_id FOR UPDATE;
      IF NOT FOUND OR s.uid<>NEW.uid OR s.order_id<>NEW.order_no OR s.order_type<>2 OR s.pay_price<>NEW.pay_price
        OR s.offline_price<>a.raw_price-a.pay_price OR s.postage_price<>0 OR s.member_price<>0 OR s.coupon_price<>0
        OR s.add_time<>NEW.paid_at OR s.status<>0
      THEN RAISE EXCEPTION 'offline balance savings mismatch'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='TRUNCATE' THEN
    IF EXISTS(SELECT 1 FROM public.offline_order_balance) THEN RAISE EXCEPTION 'offline balance effects are immutable'; END IF;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME='other_order' THEN
    IF EXISTS(SELECT 1 FROM public.offline_order_balance WHERE order_id=OLD.id) THEN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'offline balance paid state is immutable'; END IF;
      IF ROW(NEW.paid,NEW.pay_type,NEW.pay_time,NEW.trade_no) IS DISTINCT FROM ROW(OLD.paid,OLD.pay_type,OLD.pay_time,OLD.trade_no)
      THEN RAISE EXCEPTION 'offline balance paid state is immutable'; END IF;
    END IF;
  ELSIF (TG_TABLE_NAME='user_money' AND EXISTS(SELECT 1 FROM public.offline_order_balance WHERE money_id=OLD.id))
    OR (TG_TABLE_NAME='user_bill' AND EXISTS(SELECT 1 FROM public.offline_order_balance WHERE integral_bill_id=OLD.id))
    OR (TG_TABLE_NAME='store_order_economize' AND EXISTS(SELECT 1 FROM public.offline_order_balance WHERE savings_id=OLD.id))
  THEN RAISE EXCEPTION 'offline balance effects are immutable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $oob$;
REVOKE ALL ON FUNCTION public.oob_guard() FROM PUBLIC;
CREATE TRIGGER oob_insert_guard BEFORE INSERT ON public.offline_order_balance FOR EACH ROW EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_change_guard BEFORE UPDATE OR DELETE ON public.offline_order_balance FOR EACH ROW EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_truncate_guard BEFORE TRUNCATE ON public.offline_order_balance FOR EACH STATEMENT EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_order_guard BEFORE UPDATE OR DELETE ON public.other_order FOR EACH ROW EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_money_guard BEFORE UPDATE OR DELETE ON public.user_money FOR EACH ROW EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_bill_guard BEFORE UPDATE OR DELETE ON public.user_bill FOR EACH ROW EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_savings_guard BEFORE UPDATE OR DELETE ON public.store_order_economize FOR EACH ROW EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_money_truncate BEFORE TRUNCATE ON public.user_money FOR EACH STATEMENT EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_bill_truncate BEFORE TRUNCATE ON public.user_bill FOR EACH STATEMENT EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_savings_truncate BEFORE TRUNCATE ON public.store_order_economize FOR EACH STATEMENT EXECUTE FUNCTION public.oob_guard();


CREATE TABLE public.offline_order_query_evidence (
  id uuid PRIMARY KEY, replay_key uuid NOT NULL,
  case_id bigint NOT NULL REFERENCES public.payment_reconciliation_case(id) ON DELETE RESTRICT,
  selection_key uuid NOT NULL REFERENCES public.offline_order_payment_selection(selection_key) ON DELETE RESTRICT,
  version varchar(32) NOT NULL DEFAULT 'offline-query-v1', identity_source varchar(32) NOT NULL,
  provider varchar(10) NOT NULL, profile varchar(10) NOT NULL, order_no varchar(32) NOT NULL,
  transaction_id varchar(50) NOT NULL, trade_state varchar(32) NOT NULL, amount_cents integer NOT NULL,
  currency varchar(3) NOT NULL, provider_event_time integer NOT NULL,
  evidence_hash varchar(64) NOT NULL, identity_hash varchar(64) NOT NULL, created_at integer NOT NULL,
  CONSTRAINT ooqe_identity_ck CHECK(version='offline-query-v1' AND case_id>0 AND order_no ~ '^xx[0-9a-f]{30}$'
    AND transaction_id ~ '^[A-Za-z0-9_-]{1,50}$' AND amount_cents>0 AND currency='CNY'
    AND provider_event_time>0 AND created_at>0 AND evidence_hash ~ '^[0-9a-f]{64}$' AND identity_hash ~ '^[0-9a-f]{64}$'
    AND ((provider='wechat' AND profile IN ('wechat','routine') AND trade_state='SUCCESS' AND identity_source='wechat-signed-query')
      OR (provider='alipay' AND profile='alipay' AND trade_state IN ('TRADE_SUCCESS','TRADE_FINISHED') AND identity_source='alipay-direct-request-scope')))
);
CREATE UNIQUE INDEX ooqe_evidence_uq ON public.offline_order_query_evidence(evidence_hash);
CREATE UNIQUE INDEX ooqe_replay_uq ON public.offline_order_query_evidence(replay_key);
CREATE INDEX ooqe_case_idx ON public.offline_order_query_evidence(case_id,created_at,id);
CREATE INDEX ooqe_transaction_idx ON public.offline_order_query_evidence(provider,transaction_id);
CREATE INDEX prc_provider_transaction_lookup ON public.payment_reconciliation_case(provider,provider_transaction_id)
  WHERE provider_transaction_id<>'';
REVOKE ALL ON public.offline_order_query_evidence FROM PUBLIC;
CREATE TABLE public.offline_order_callback_binding (
  event_id bigint PRIMARY KEY REFERENCES public.payment_callback_event(id) ON DELETE RESTRICT,
  selection_key uuid NOT NULL REFERENCES public.offline_order_payment_selection(selection_key) ON DELETE RESTRICT,
  event_hash varchar(64) NOT NULL, identity_hash varchar(64) NOT NULL, created_at integer NOT NULL,
  CONSTRAINT oocb_identity_ck CHECK(event_id>0 AND created_at>0
    AND event_hash ~ '^[0-9a-f]{64}$' AND identity_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX oocb_selection_idx ON public.offline_order_callback_binding(selection_key);
CREATE TABLE public.offline_order_external_payment (
  order_id integer PRIMARY KEY REFERENCES public.offline_order_payment_selection(order_id) ON DELETE RESTRICT,
  event_id bigint REFERENCES public.offline_order_callback_binding(event_id) ON DELETE RESTRICT,
  query_id uuid REFERENCES public.offline_order_query_evidence(id) ON DELETE RESTRICT,
  uid integer NOT NULL, order_no varchar(32) NOT NULL, version varchar(32) NOT NULL DEFAULT 'offline-external-v1',
  provider varchar(10) NOT NULL, profile varchar(10) NOT NULL, transaction_id varchar(50) NOT NULL,
  provider_paid_at integer NOT NULL, pay_price numeric(10,2) NOT NULL,
  integral_before integer NOT NULL, integral_after integer NOT NULL, integral_reward integer NOT NULL,
  integral_rate numeric(14,6) NOT NULL, member_bonus integer NOT NULL, member_active boolean NOT NULL,
  integral_bill_id integer REFERENCES public.user_bill(id) ON DELETE RESTRICT,
  savings_id integer REFERENCES public.store_order_economize(id) ON DELETE RESTRICT,
  promoted boolean NOT NULL, policy jsonb NOT NULL, paid_at integer NOT NULL,
  CONSTRAINT ooep_source_ck CHECK((event_id IS NOT NULL AND query_id IS NULL) OR (event_id IS NULL AND query_id IS NOT NULL)),
  CONSTRAINT ooep_identity_ck CHECK(order_id>0 AND (event_id IS NULL OR event_id>0) AND uid>0 AND order_no ~ '^xx[0-9a-f]{30}$'
    AND version='offline-external-v1' AND paid_at>0 AND provider_paid_at>=0
    AND ((provider='wechat' AND profile IN ('wechat','routine')) OR (provider='alipay' AND profile='alipay'))
    AND transaction_id ~ '^[A-Za-z0-9_-]{1,50}$'
    AND (integral_bill_id IS NULL OR integral_bill_id>0) AND (savings_id IS NULL OR savings_id>0)
    AND jsonb_typeof(policy)='object' AND octet_length(policy::text)<=4096),
  CONSTRAINT ooep_amount_ck CHECK(pay_price>0 AND pay_price<=21474836.47 AND pay_price<>'NaN'::numeric),
  CONSTRAINT ooep_integral_ck CHECK(integral_before>=0 AND integral_after>=0 AND integral_reward>=0
    AND integral_after::bigint=integral_before::bigint+integral_reward::bigint
    AND integral_rate>=0 AND integral_rate<>'NaN'::numeric AND member_bonus>=0 AND (member_active OR member_bonus=0)
    AND integral_reward=trunc(integral_rate*pay_price)+member_bonus
    AND ((integral_reward=0 AND integral_bill_id IS NULL) OR (integral_reward>0 AND integral_bill_id IS NOT NULL)))
);
CREATE UNIQUE INDEX ooep_order_no_uq ON public.offline_order_external_payment(order_no);
CREATE UNIQUE INDEX ooep_event_uq ON public.offline_order_external_payment(event_id);
CREATE UNIQUE INDEX ooep_query_uq ON public.offline_order_external_payment(query_id);
CREATE UNIQUE INDEX ooep_transaction_uq ON public.offline_order_external_payment(provider,transaction_id);
CREATE UNIQUE INDEX ooep_integral_uq ON public.offline_order_external_payment(integral_bill_id);
CREATE UNIQUE INDEX ooep_savings_uq ON public.offline_order_external_payment(savings_id);
REVOKE ALL ON public.offline_order_callback_binding,public.offline_order_external_payment FROM PUBLIC;

CREATE FUNCTION public.ooqe_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $ooqe$
DECLARE p public.offline_order_payment_selection%ROWTYPE; r public.payment_reconciliation_case%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'offline query evidence is immutable'; END IF;
  SELECT * INTO p FROM public.offline_order_payment_selection WHERE selection_key=NEW.selection_key;
  IF NOT FOUND OR p.rail<>NEW.provider OR p.profile<>NEW.profile OR p.order_no<>NEW.order_no
    OR p.pay_price*100<>NEW.amount_cents OR p.currency<>NEW.currency OR NEW.created_at<p.created_at
  THEN RAISE EXCEPTION 'offline query selection mismatch'; END IF;
  SELECT * INTO r FROM public.payment_reconciliation_case WHERE id=NEW.case_id;
  IF NOT FOUND OR r.provider<>NEW.provider OR r.profile<>NEW.profile OR r.order_no<>NEW.order_no
    OR r.order_domain<>'offline_order' OR r.expected_amount_cents<>NEW.amount_cents OR r.currency<>NEW.currency
  THEN RAISE EXCEPTION 'offline query recovery mismatch'; END IF;
  RETURN NEW;
END $ooqe$;
REVOKE ALL ON FUNCTION public.ooqe_guard() FROM PUBLIC;
CREATE TRIGGER ooqe_insert_guard BEFORE INSERT ON public.offline_order_query_evidence FOR EACH ROW EXECUTE FUNCTION public.ooqe_guard();
CREATE TRIGGER ooqe_change_guard BEFORE UPDATE OR DELETE ON public.offline_order_query_evidence FOR EACH ROW EXECUTE FUNCTION public.ooqe_guard();
CREATE TRIGGER ooqe_truncate_guard BEFORE TRUNCATE ON public.offline_order_query_evidence FOR EACH STATEMENT EXECUTE FUNCTION public.ooqe_guard();
CREATE FUNCTION public.oocb_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $oocb$
DECLARE e public.payment_callback_event%ROWTYPE; p public.offline_order_payment_selection%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='offline_order_callback_binding' THEN
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'offline callback binding is immutable'; END IF;
    SELECT * INTO e FROM public.payment_callback_event WHERE id=NEW.event_id FOR UPDATE;
    IF NOT FOUND OR e.payload_hash<>NEW.event_hash OR e.currency<>'CNY' OR e.order_domain NOT IN ('','offline_order')
      OR e.last_error_code='transaction_evidence_conflict'
      OR NOT ((e.provider='wechat' AND e.trade_state='SUCCESS') OR (e.provider='alipay' AND e.trade_state IN ('TRADE_SUCCESS','TRADE_FINISHED')))
    THEN RAISE EXCEPTION 'offline callback event mismatch'; END IF;
    SELECT * INTO p FROM public.offline_order_payment_selection WHERE selection_key=NEW.selection_key;
    IF NOT FOUND OR p.rail<>e.provider OR p.profile<>e.profile OR p.order_no<>e.order_no
      OR p.pay_price*100<>e.amount_cents OR NEW.created_at<p.created_at
    THEN RAISE EXCEPTION 'offline callback selection mismatch'; END IF;
    RETURN NEW;
  END IF;
  IF EXISTS(SELECT 1 FROM public.offline_order_callback_binding WHERE event_id=OLD.id) AND
    ROW(NEW.id,NEW.provider,NEW.profile,NEW.provider_event_id,NEW.replay_key,NEW.payload_hash,NEW.order_no,
      NEW.transaction_id,NEW.trade_state,NEW.amount_cents,NEW.currency,NEW.provider_event_time)
    IS DISTINCT FROM ROW(OLD.id,OLD.provider,OLD.profile,OLD.provider_event_id,OLD.replay_key,OLD.payload_hash,OLD.order_no,
      OLD.transaction_id,OLD.trade_state,OLD.amount_cents,OLD.currency,OLD.provider_event_time)
  THEN RAISE EXCEPTION 'bound offline callback evidence is immutable'; END IF;
  RETURN NEW;
END $oocb$;
REVOKE ALL ON FUNCTION public.oocb_guard() FROM PUBLIC;
CREATE TRIGGER oocb_insert_guard BEFORE INSERT ON public.offline_order_callback_binding FOR EACH ROW EXECUTE FUNCTION public.oocb_guard();
CREATE TRIGGER oocb_change_guard BEFORE UPDATE OR DELETE ON public.offline_order_callback_binding FOR EACH ROW EXECUTE FUNCTION public.oocb_guard();
CREATE TRIGGER oocb_truncate_guard BEFORE TRUNCATE ON public.offline_order_callback_binding FOR EACH STATEMENT EXECUTE FUNCTION public.oocb_guard();
CREATE TRIGGER oocb_event_guard BEFORE UPDATE ON public.payment_callback_event FOR EACH ROW EXECUTE FUNCTION public.oocb_guard();

CREATE FUNCTION public.ooep_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $ooep$
DECLARE o public.other_order%ROWTYPE; a public.offline_order_admission%ROWTYPE; p public.offline_order_payment_selection%ROWTYPE;
  e public.payment_callback_event%ROWTYPE; c public.offline_order_callback_binding%ROWTYPE; q public.offline_order_query_evidence%ROWTYPE;
  u public."user"%ROWTYPE; b public.user_bill%ROWTYPE; s public.store_order_economize%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='offline_order_external_payment' THEN
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'offline external receipt is immutable'; END IF;
    SELECT * INTO o FROM public.other_order WHERE id=NEW.order_id FOR UPDATE;
    IF NOT FOUND OR o.uid<>NEW.uid OR o.order_id<>NEW.order_no OR o.type<>3 OR o.pay_price<>NEW.pay_price
      OR o.paid<>1 OR o.pay_type<>(CASE NEW.provider WHEN 'wechat' THEN 'weixin' ELSE 'alipay' END)
      OR o.pay_time<>NEW.paid_at OR o.trade_no<>NEW.transaction_id
    THEN RAISE EXCEPTION 'offline external paid order mismatch'; END IF;
    SELECT * INTO a FROM public.offline_order_admission WHERE order_id=NEW.order_id;
    IF NOT FOUND OR a.uid<>NEW.uid OR a.order_no<>NEW.order_no OR a.pay_price<>NEW.pay_price
    THEN RAISE EXCEPTION 'offline external admission mismatch'; END IF;
    SELECT * INTO p FROM public.offline_order_payment_selection WHERE order_id=NEW.order_id;
    IF NOT FOUND OR p.rail<>NEW.provider OR p.profile<>NEW.profile OR p.uid<>NEW.uid OR p.order_no<>NEW.order_no
      OR p.pay_price<>NEW.pay_price OR NEW.paid_at<p.created_at
    THEN RAISE EXCEPTION 'offline external selection mismatch'; END IF;
    IF NEW.event_id IS NOT NULL THEN
    SELECT * INTO c FROM public.offline_order_callback_binding WHERE event_id=NEW.event_id;
    IF NOT FOUND OR c.selection_key<>p.selection_key OR NEW.paid_at<c.created_at
    THEN RAISE EXCEPTION 'offline external binding mismatch'; END IF;
    SELECT * INTO e FROM public.payment_callback_event WHERE id=NEW.event_id;
    IF NOT FOUND OR e.payload_hash<>c.event_hash OR e.provider<>NEW.provider OR e.profile<>NEW.profile
      OR e.order_no<>NEW.order_no OR e.transaction_id<>NEW.transaction_id OR e.amount_cents<>NEW.pay_price*100
      OR e.currency<>'CNY' OR e.provider_event_time<>NEW.provider_paid_at
      OR NOT ((e.provider='wechat' AND e.trade_state='SUCCESS') OR (e.provider='alipay' AND e.trade_state IN ('TRADE_SUCCESS','TRADE_FINISHED')))
    THEN RAISE EXCEPTION 'offline external collection mismatch'; END IF;
    ELSE
      SELECT * INTO q FROM public.offline_order_query_evidence WHERE id=NEW.query_id;
      IF NOT FOUND OR q.selection_key<>p.selection_key OR NEW.paid_at<q.created_at
        OR q.provider<>NEW.provider OR q.profile<>NEW.profile OR q.order_no<>NEW.order_no
        OR q.transaction_id<>NEW.transaction_id OR q.amount_cents<>NEW.pay_price*100
        OR q.currency<>'CNY' OR q.provider_event_time<>NEW.provider_paid_at
      THEN RAISE EXCEPTION 'offline external query collection mismatch'; END IF;
    END IF;
    SELECT * INTO u FROM public."user" WHERE uid=NEW.uid FOR UPDATE;
    IF NOT FOUND OR u.integral<>NEW.integral_after OR (NEW.promoted AND u.is_promoter<>1)
    THEN RAISE EXCEPTION 'offline external account mismatch'; END IF;
    IF NEW.integral_bill_id IS NOT NULL THEN
      SELECT * INTO b FROM public.user_bill WHERE id=NEW.integral_bill_id FOR UPDATE;
      IF NOT FOUND OR b.uid<>NEW.uid OR b.link_id<>NEW.order_no OR b.category<>'integral' OR b.type<>'gain'
        OR b.event_key<>'offline_order_give_integral' OR b.pm<>1 OR b.status<>1 OR b.take<>0 OR b.frozen_time<>0
        OR b.number<>NEW.integral_reward OR b.balance<>NEW.integral_after OR b.add_time<>NEW.paid_at
      THEN RAISE EXCEPTION 'offline external integral mismatch'; END IF;
    END IF;
    IF (a.discount_percent>0) IS DISTINCT FROM (NEW.savings_id IS NOT NULL)
    THEN RAISE EXCEPTION 'offline external savings identity mismatch'; END IF;
    IF NEW.savings_id IS NOT NULL THEN
      SELECT * INTO s FROM public.store_order_economize WHERE id=NEW.savings_id FOR UPDATE;
      IF NOT FOUND OR s.uid<>NEW.uid OR s.order_id<>NEW.order_no OR s.order_type<>2 OR s.pay_price<>NEW.pay_price
        OR s.offline_price<>a.raw_price-a.pay_price OR s.postage_price<>0 OR s.member_price<>0 OR s.coupon_price<>0
        OR s.add_time<>NEW.paid_at OR s.status<>0
      THEN RAISE EXCEPTION 'offline external savings mismatch'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='TRUNCATE' THEN
    IF EXISTS(SELECT 1 FROM public.offline_order_external_payment) THEN RAISE EXCEPTION 'offline external effects are immutable'; END IF;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME='other_order' THEN
    IF EXISTS(SELECT 1 FROM public.offline_order_external_payment WHERE order_id=OLD.id) THEN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'offline external paid state is immutable'; END IF;
      IF ROW(NEW.paid,NEW.pay_type,NEW.pay_time,NEW.trade_no) IS DISTINCT FROM ROW(OLD.paid,OLD.pay_type,OLD.pay_time,OLD.trade_no)
      THEN RAISE EXCEPTION 'offline external paid state is immutable'; END IF;
    END IF;
  ELSIF (TG_TABLE_NAME='user_bill' AND EXISTS(SELECT 1 FROM public.offline_order_external_payment WHERE integral_bill_id=OLD.id))
    OR (TG_TABLE_NAME='store_order_economize' AND EXISTS(SELECT 1 FROM public.offline_order_external_payment WHERE savings_id=OLD.id))
  THEN RAISE EXCEPTION 'offline external effects are immutable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $ooep$;
REVOKE ALL ON FUNCTION public.ooep_guard() FROM PUBLIC;
CREATE TRIGGER ooep_insert_guard BEFORE INSERT ON public.offline_order_external_payment FOR EACH ROW EXECUTE FUNCTION public.ooep_guard();
CREATE TRIGGER ooep_change_guard BEFORE UPDATE OR DELETE ON public.offline_order_external_payment FOR EACH ROW EXECUTE FUNCTION public.ooep_guard();
CREATE TRIGGER ooep_truncate_guard BEFORE TRUNCATE ON public.offline_order_external_payment FOR EACH STATEMENT EXECUTE FUNCTION public.ooep_guard();
CREATE TRIGGER ooep_order_guard BEFORE UPDATE OR DELETE ON public.other_order FOR EACH ROW EXECUTE FUNCTION public.ooep_guard();
CREATE TRIGGER ooep_bill_guard BEFORE UPDATE OR DELETE ON public.user_bill FOR EACH ROW EXECUTE FUNCTION public.ooep_guard();
CREATE TRIGGER ooep_savings_guard BEFORE UPDATE OR DELETE ON public.store_order_economize FOR EACH ROW EXECUTE FUNCTION public.ooep_guard();
CREATE TRIGGER ooep_bill_truncate BEFORE TRUNCATE ON public.user_bill FOR EACH STATEMENT EXECUTE FUNCTION public.ooep_guard();
CREATE TRIGGER ooep_savings_truncate BEFORE TRUNCATE ON public.store_order_economize FOR EACH STATEMENT EXECUTE FUNCTION public.ooep_guard();

-- Unlike a pre-dispatch selection, a paid state cannot commit ahead of its
-- financial receipt. Deferred so the order update and receipt can be atomic.
CREATE FUNCTION public.ooep_paid_commit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $ooep_commit$
BEGIN
  IF NEW.type=3 AND NEW.paid=1 AND EXISTS(SELECT 1 FROM public.offline_order_payment_selection
    WHERE order_id=NEW.id AND rail IN ('wechat','alipay')) AND NOT EXISTS(SELECT 1 FROM public.offline_order_external_payment
      WHERE order_id=NEW.id AND uid=NEW.uid AND order_no=NEW.order_id AND pay_price=NEW.pay_price
        AND paid_at=NEW.pay_time AND transaction_id=NEW.trade_no
        AND NEW.pay_type=CASE provider WHEN 'wechat' THEN 'weixin' ELSE 'alipay' END)
  THEN RAISE EXCEPTION 'offline external paid state requires committed receipt'; END IF;
  RETURN NULL;
END $ooep_commit$;
REVOKE ALL ON FUNCTION public.ooep_paid_commit() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER ooep_paid_commit AFTER UPDATE ON public.other_order
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.ooep_paid_commit();


ALTER TABLE public.payment_callback_event DROP CONSTRAINT pce_order_domain_ck;
ALTER TABLE public.payment_callback_event ADD CONSTRAINT pce_order_domain_ck
  CHECK(order_domain IN ('','store_order','recharge','membership','offline_order'));
ALTER TABLE public.payment_reconciliation_case DROP CONSTRAINT prc_order_domain_ck;
ALTER TABLE public.payment_reconciliation_case ADD CONSTRAINT prc_order_domain_ck
  CHECK(order_domain IN ('','store_order','recharge','membership','offline_order'));


CREATE TABLE public.offline_order_payment_dispatch (
  selection_key uuid PRIMARY KEY REFERENCES public.offline_order_payment_selection(selection_key) ON DELETE RESTRICT,
  attempt_key uuid NOT NULL, case_id bigint NOT NULL REFERENCES public.payment_reconciliation_case(id) ON DELETE RESTRICT,
  state varchar(10) NOT NULL, ticket_payload text NOT NULL DEFAULT '', ticket_hash varchar(64) NOT NULL DEFAULT '',
  created_at integer NOT NULL, finished_at integer NOT NULL DEFAULT 0, display_until integer NOT NULL DEFAULT 0,
  CONSTRAINT oopd_identity_ck CHECK(attempt_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND case_id>0 AND created_at>0),
  CONSTRAINT oopd_state_ck CHECK(
    (state='ISSUING' AND finished_at=0 AND display_until=0 AND ticket_payload='' AND ticket_hash='')
    OR (state='UNKNOWN' AND finished_at>=created_at AND display_until=0 AND ticket_payload='' AND ticket_hash='')
    OR (state='READY' AND finished_at>=created_at AND display_until=created_at+300
      AND octet_length(ticket_payload) BETWEEN 2 AND 8192 AND ticket_hash ~ '^[0-9a-f]{64}$'))
);
CREATE UNIQUE INDEX oopd_attempt_uq ON public.offline_order_payment_dispatch(attempt_key);
CREATE UNIQUE INDEX oopd_case_uq ON public.offline_order_payment_dispatch(case_id);
REVOKE ALL ON public.offline_order_payment_dispatch FROM PUBLIC;
CREATE FUNCTION public.oopd_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $oopd$
DECLARE s public.offline_order_payment_selection%ROWTYPE; c public.payment_reconciliation_case%ROWTYPE;
BEGIN
  IF TG_OP NOT IN ('INSERT','UPDATE') THEN RAISE EXCEPTION 'offline dispatch cannot be removed'; END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.selection_key,NEW.attempt_key,NEW.case_id,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.selection_key,OLD.attempt_key,OLD.case_id,OLD.created_at)
      OR OLD.state<>'ISSUING' OR NEW.state NOT IN ('READY','UNKNOWN')
    THEN RAISE EXCEPTION 'offline dispatch transition invalid'; END IF;
    RETURN NEW;
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'offline dispatch requires READ COMMITTED'; END IF;
  SELECT * INTO s FROM public.offline_order_payment_selection WHERE selection_key=NEW.selection_key;
  IF NOT FOUND OR s.rail NOT IN ('wechat','alipay') OR NEW.state<>'ISSUING' OR NEW.created_at<>s.created_at
    THEN RAISE EXCEPTION 'offline dispatch selection mismatch'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('payment-reconciliation:' || s.rail || ':' || s.order_no,0));
  SELECT * INTO c FROM public.payment_reconciliation_case WHERE id=NEW.case_id FOR UPDATE;
  IF NOT FOUND OR c.provider<>s.rail OR c.profile<>s.profile OR c.order_domain<>'offline_order' OR c.order_no<>s.order_no
    OR c.expected_amount_cents<>s.pay_price*100 OR c.currency<>'CNY' OR c.status<>'OPEN'
    OR c.provider_status<>'UNKNOWN' OR c.provider_transaction_id<>'' OR c.callback_event_id IS NOT NULL
    OR c.initiated_time<>NEW.created_at
  THEN RAISE EXCEPTION 'offline dispatch recovery mismatch'; END IF;
  PERFORM id FROM public.other_order WHERE id=s.order_id AND uid=s.uid AND paid=0 AND pay_type='' AND trade_no='' AND pay_time=0 AND is_del=0 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'offline dispatch order unavailable'; END IF;
  PERFORM uid FROM public."user" WHERE uid=s.uid AND status=1 AND is_del=0 AND delete_time IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'offline dispatch account unavailable'; END IF;
  RETURN NEW;
END $oopd$;
REVOKE ALL ON FUNCTION public.oopd_guard() FROM PUBLIC;
CREATE TRIGGER oopd_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.offline_order_payment_dispatch
  FOR EACH ROW EXECUTE FUNCTION public.oopd_guard();
CREATE TRIGGER oopd_truncate_guard BEFORE TRUNCATE ON public.offline_order_payment_dispatch
  FOR EACH STATEMENT EXECUTE FUNCTION public.oopd_guard();

  END IF;
  SELECT state INTO final_state FROM (WITH catalog AS (
WITH relations AS (
  SELECT name,c.*,name IN ('offline_order_admission','offline_order_payment_selection','offline_order_balance','offline_order_query_evidence','offline_order_callback_binding','offline_order_external_payment','offline_order_payment_dispatch') AS ledger
  FROM (VALUES ('member_right'),('system_config'),('payment_callback_event'),('payment_reconciliation_case'),('other_order'),('user'),('wechat_user'),('user_money'),('user_bill'),('store_order_economize'),('offline_order_admission'),('offline_order_payment_selection'),('offline_order_balance'),('offline_order_query_evidence'),('offline_order_callback_binding'),('offline_order_external_payment'),('offline_order_payment_dispatch')) names(name)
  LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public."'||name||'"')
), tables AS (
  SELECT name,oid,relowner AS owner,
    relkind='r' AND relpersistence='p' AND NOT relispartition
    AND NOT relrowsecurity AND NOT relforcerowsecurity AND relreplident='d' AND reloptions IS NULL
    AND relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=r.oid OR inhparent=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=r.oid AND attnum>0 AND attisdropped)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=r.oid AND tgisinternal AND tgenabled<>'O')
    AND (NOT ledger OR (
      NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(relacl,pg_catalog.acldefault('r',relowner))) a
        WHERE a.grantee<>relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
        WHERE col.attrelid=r.oid AND a.grantee<>relowner AND
          (a.grantee=0 OR a.is_grantable OR name<>'offline_order_payment_dispatch'
            OR col.attname NOT IN ('state','ticket_payload','ticket_hash','finished_at','display_until') OR a.privilege_type<>'UPDATE'))
    )) AS safe,
    jsonb_build_object(
      'columns',(SELECT jsonb_agg(jsonb_build_array(CASE WHEN r.ledger THEN a.attnum END,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
        pg_get_expr(d.adbin,d.adrelid),a.attidentity::text,a.attgenerated::text,
        CASE WHEN a.attcollation=0 THEN NULL ELSE cn.nspname||'.'||co.collname END)
        ORDER BY CASE WHEN r.ledger THEN a.attnum END,a.attname COLLATE "C")
        FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
        WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.contype::text,pg_get_constraintdef(k.oid,false),
        k.convalidated,k.condeferrable,k.condeferred,k.connoinherit,k.conislocal,k.coninhcount,k.conparentid::text)
        ORDER BY k.conname COLLATE "C") FROM pg_catalog.pg_constraint k WHERE k.conrelid=r.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_array(ic.relname,pg_get_indexdef(i.indexrelid),i.indisunique,i.indisprimary,
        i.indisvalid,i.indisready,i.indislive,i.indimmediate,i.indisexclusion,i.indnullsnotdistinct,i.indisreplident,
        i.indnatts,i.indnkeyatts,CASE WHEN r.ledger THEN i.indkey::text END,i.indoption::text,ic.reloptions,ic.relpersistence)
        ORDER BY ic.relname COLLATE "C") FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=r.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,pg_get_triggerdef(t.oid,false),t.tgenabled::text)
        ORDER BY t.tgname COLLATE "C") FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
        WHERE t.tgrelid=r.oid AND NOT t.tgisinternal AND (r.ledger OR p.proname IN ('ooa_lock_pricing','ooa_guard','oops_guard','oops_wallet_commit','oob_guard','ooqe_guard','oocb_guard','ooep_guard','ooep_paid_commit','oopd_guard')
          OR t.tgname ~ '^(ooa|oops|oob|ooqe|oocb|ooep|oopd)_'))
    ) AS shape
  FROM relations r
), functions AS (
  SELECT name,p.* FROM (VALUES ('ooa_lock_pricing'),('ooa_guard'),('oops_guard'),('oops_wallet_commit'),('oob_guard'),('ooqe_guard'),('oocb_guard'),('ooep_guard'),('ooep_paid_commit'),('oopd_guard')) names(name)
  LEFT JOIN pg_catalog.pg_proc p ON p.pronamespace='public'::regnamespace AND p.proname=name
), components AS (
  SELECT 'table' AS kind,name,oid,owner,safe,shape FROM tables
  UNION ALL
  SELECT 'function',name,oid,proowner,
    prokind='f' AND pronargs=0 AND NOT proretset
    AND prorettype=CASE WHEN name='ooa_lock_pricing' THEN 'void'::regtype ELSE 'trigger'::regtype END
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(proacl,pg_catalog.acldefault('f',proowner))) a
      WHERE a.grantee<>proowner AND (name<>'ooa_lock_pricing' OR a.grantee=0 OR a.is_grantable OR a.privilege_type<>'EXECUTE')),
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
SELECT CASE WHEN components<>27 THEN 'drift'
  WHEN (objects->'member_right') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ffed4c38d3893a186f8614d982dd397e0990cf9b068e696b1fd7afe7d5cbb331"}'::jsonb AND (objects->'other_order') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"1756e4e38c754862d1c76faac3e4ebbcf105484e09bddcabffc27e26dfbf820b"}'::jsonb AND (objects->'payment_callback_event') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"977bf01c7e6aa9af22a11bcc13321cf8ea6496fc53f13bab1bf3e10620f255e1"}'::jsonb AND (objects->'payment_reconciliation_case') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fe607b08a5f66a653a673aa0ca8626a38d0e3482f4d7fccc618bf64f524ab959"}'::jsonb AND (objects->'store_order_economize') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"2383680a0cd0cd12c917c3b5214d4da6ad9facf5bc81f8c3f745656cc02b106c"}'::jsonb AND (objects->'system_config') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"10becbd6bf8ae6ed41dba14e474fc8529df4116c61e84365b60c50d11e1b4336"}'::jsonb AND (objects->'user') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"9d8390088ef56e1c24f25b892d34cf73a403774e701a0831d189799c9bb33f7b"}'::jsonb AND (objects->'user_bill') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"20a4ab84699fafe290e741577d22751bda9bda056c90ac9dcdc15f1b4560b434"}'::jsonb AND (objects->'user_money') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"17f28481406ae65e3b6143ed87215cfa75c892050e1814f882e79687dac8fcf2"}'::jsonb AND (objects->'wechat_user') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fb68f9c18236ea7f757726df87997cab1387479b6ee7690fef6ce38e6adba926"}'::jsonb AND (objects->'offline_order_admission') @> '{"present":false}'::jsonb AND (objects->'offline_order_payment_selection') @> '{"present":false}'::jsonb AND (objects->'offline_order_balance') @> '{"present":false}'::jsonb AND (objects->'offline_order_query_evidence') @> '{"present":false}'::jsonb AND (objects->'offline_order_callback_binding') @> '{"present":false}'::jsonb AND (objects->'offline_order_external_payment') @> '{"present":false}'::jsonb AND (objects->'offline_order_payment_dispatch') @> '{"present":false}'::jsonb AND (objects->'ooa_lock_pricing') @> '{"present":false}'::jsonb AND (objects->'ooa_guard') @> '{"present":false}'::jsonb AND (objects->'oops_guard') @> '{"present":false}'::jsonb AND (objects->'oops_wallet_commit') @> '{"present":false}'::jsonb AND (objects->'oob_guard') @> '{"present":false}'::jsonb AND (objects->'ooqe_guard') @> '{"present":false}'::jsonb AND (objects->'oocb_guard') @> '{"present":false}'::jsonb AND (objects->'ooep_guard') @> '{"present":false}'::jsonb AND (objects->'ooep_paid_commit') @> '{"present":false}'::jsonb AND (objects->'oopd_guard') @> '{"present":false}'::jsonb THEN 'fresh'
  WHEN (objects->'ooa_guard') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c80995492c819e825a4c6a2d8ce5f8bde530395a3b9d514d8cbbdbc41e46f113"}'::jsonb AND (objects->'ooa_lock_pricing') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"769c62a6fd1a877cc65936b35cb4dccc410ab56d2e4fe49811eacd678b17f1e4"}'::jsonb AND (objects->'oob_guard') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"3fb3bd3d42e4c192cac8b9c1932b51f5fe64dfc33af5f748f2dd7d7ee2e099cc"}'::jsonb AND (objects->'oocb_guard') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"3f1da24b0ba0029d08f55b6c8dcda2dc5ee2d40b53cea0a4495cbc1084e8fe1d"}'::jsonb AND (objects->'ooep_guard') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"4306e4f1925b75b89453fda45b8d702c3416a28edd4162b1a34344b79385885f"}'::jsonb AND (objects->'ooep_paid_commit') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"8022926f11369fa0ea4cd831457583e01f01880c815e7b72b373ba5558788cda"}'::jsonb AND (objects->'oopd_guard') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"e4b7fa82b42e02657d7a1506302a1d745ac93a9502d3100267913ed80b81700d"}'::jsonb AND (objects->'oops_guard') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"67439718137fdeb553f6a6cad68ee902c70d5951584c81fe1d59f83d0349ff3b"}'::jsonb AND (objects->'oops_wallet_commit') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b5573ef82f4949c37bba0eca8ea30dde4ea08498fe98549611fa533689836e34"}'::jsonb AND (objects->'ooqe_guard') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ad94dd2742c99be1d7bbbe153ec796c5f8961b36bd2530850f2c3d99eb9724c8"}'::jsonb AND (objects->'member_right') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ffed4c38d3893a186f8614d982dd397e0990cf9b068e696b1fd7afe7d5cbb331"}'::jsonb AND (objects->'offline_order_admission') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ca8934a5ce2de0e3be7f4e44f7e319bbd403446afce3fcf0ef4b1f183d129dc5"}'::jsonb AND (objects->'offline_order_balance') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fcb99e1c7e771beae2d0e12f7ea0aef4503bb9388c517ab10922528661233e04"}'::jsonb AND (objects->'offline_order_callback_binding') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c7bb72246c2b570eb59a6bab216c8407f99fd4bf07c0068dca4d93f1a00950fb"}'::jsonb AND (objects->'offline_order_external_payment') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"9af3b51fb27fb019819792631101f8ea0220fbddfbc28b32b307e7872d658fad"}'::jsonb AND (objects->'offline_order_payment_dispatch') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"652aa0cacb3623929f786b02e68298291e547118ce3579d944b03f4fafc0f8c2"}'::jsonb AND (objects->'offline_order_payment_selection') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"2c1f93e917c14b3c0a369be6d613ccc33672c40e57ea461a799b4fab4dbd0f75"}'::jsonb AND (objects->'offline_order_query_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"a12ec8ef9b7a9ca4c32f42616190edb6c20fb8f1665b450c16ab8bd474e33e6e"}'::jsonb AND (objects->'other_order') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"92e3fdeb757cffb0b460329157b265a8be401559655b96f0e94238119ac79d5f"}'::jsonb AND (objects->'payment_callback_event') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"c4533e013200eb3398f043952b87b3751369e1d6c7dcad296454fe703862d53b"}'::jsonb AND (objects->'payment_reconciliation_case') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"661c6de1684ecbff9630e049d43e14263f01f60b8cd46ac1bf2aa71a74bd6739"}'::jsonb AND (objects->'store_order_economize') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"af93acc31f1e2011b8c4450064bf7506990768f899229d6153f6882e804a6a19"}'::jsonb AND (objects->'system_config') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"10becbd6bf8ae6ed41dba14e474fc8529df4116c61e84365b60c50d11e1b4336"}'::jsonb AND (objects->'user') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"9d8390088ef56e1c24f25b892d34cf73a403774e701a0831d189799c9bb33f7b"}'::jsonb AND (objects->'user_bill') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"8c28df2335af833c85658983df4e03c1202fdaa612550407122433b049ea19d5"}'::jsonb AND (objects->'user_money') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fc130d4977144e49c38c190a7949db01c472622a676b88bf525179ebac4d0290"}'::jsonb AND (objects->'wechat_user') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fb68f9c18236ea7f757726df87997cab1387479b6ee7690fef6ce38e6adba926"}'::jsonb THEN 'v1'
  WHEN (objects->'member_right') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ffed4c38d3893a186f8614d982dd397e0990cf9b068e696b1fd7afe7d5cbb331"}'::jsonb AND (objects->'other_order') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"1756e4e38c754862d1c76faac3e4ebbcf105484e09bddcabffc27e26dfbf820b"}'::jsonb AND (objects->'payment_callback_event') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"4ee2a3598865029344ff616079f864732d515805c9f3256c8bf96c4e961ff4f8"}'::jsonb AND (objects->'payment_reconciliation_case') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"661c6de1684ecbff9630e049d43e14263f01f60b8cd46ac1bf2aa71a74bd6739"}'::jsonb AND (objects->'store_order_economize') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"2383680a0cd0cd12c917c3b5214d4da6ad9facf5bc81f8c3f745656cc02b106c"}'::jsonb AND (objects->'system_config') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"10becbd6bf8ae6ed41dba14e474fc8529df4116c61e84365b60c50d11e1b4336"}'::jsonb AND (objects->'user') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"9d8390088ef56e1c24f25b892d34cf73a403774e701a0831d189799c9bb33f7b"}'::jsonb AND (objects->'user_bill') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"b0390aca3bbc3e790de7581444678f594a65d1778187b05fd2701f2994f2faf9"}'::jsonb AND (objects->'user_money') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"7d80098a75e284bc393dd16dc98fb867435cc3fc4f107f43aaa490c2a560e763"}'::jsonb AND (objects->'wechat_user') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"fb68f9c18236ea7f757726df87997cab1387479b6ee7690fef6ce38e6adba926"}'::jsonb AND (objects->'offline_order_admission') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"0c2a9fc2cb738c76b6ac518fa0cc71832e773e1b28328a4e310d8d9b8dc08a94"}'::jsonb AND (objects->'offline_order_balance') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"0555c78f98eefbd1392281c7698ca5f930be1ca1ae4f50d805d9ccb59102ce28"}'::jsonb AND (objects->'offline_order_callback_binding') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"ecd8ba1c25926cd6304844d0c3697ebd57e61f96e494870c5c152baaf3cf95f2"}'::jsonb AND (objects->'offline_order_external_payment') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"65b9f9beb5b0652e8cf4ecf29325423375b0f62960bf3427032ebadc9112d7ae"}'::jsonb AND (objects->'offline_order_payment_dispatch') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"d92333abf3ab54db25503ece15dec2e4620d7ac063bb3ad3840578ed02aa0529"}'::jsonb AND (objects->'offline_order_payment_selection') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"12abd2bff4cb2ec209fb55bac6dcbafa258a9e5fa9ef11c4b3ddb948956ae934"}'::jsonb AND (objects->'offline_order_query_evidence') @> '{"present":true,"owned":true,"safe":true,"fingerprint":"3fa09ba5101a8a7d9a5703c160013cf2888b0eac06bceeb711b4bc6c7a6225ca"}'::jsonb AND (objects->'ooa_lock_pricing') @> '{"present":false}'::jsonb AND (objects->'ooa_guard') @> '{"present":false}'::jsonb AND (objects->'oops_guard') @> '{"present":false}'::jsonb AND (objects->'oops_wallet_commit') @> '{"present":false}'::jsonb AND (objects->'oob_guard') @> '{"present":false}'::jsonb AND (objects->'ooqe_guard') @> '{"present":false}'::jsonb AND (objects->'oocb_guard') @> '{"present":false}'::jsonb AND (objects->'ooep_guard') @> '{"present":false}'::jsonb AND (objects->'ooep_paid_commit') @> '{"present":false}'::jsonb AND (objects->'oopd_guard') @> '{"present":false}'::jsonb THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot) c;
  IF final_state IS DISTINCT FROM 'v1' OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Offline installation catalog or ACL verification failed';
  END IF;
END
$offline_install$;
