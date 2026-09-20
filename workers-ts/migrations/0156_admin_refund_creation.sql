
SET LOCAL search_path=public,pg_temp;
SET LOCAL row_security=off;
SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),30000)::text || 'ms',true),
  set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true);
DO $arc_install$
DECLARE state record;
BEGIN
  IF current_setting('server_version_num')::integer / 10000 <> 16
    OR current_setting('transaction_isolation') <> 'read committed' OR current_setting('transaction_read_only') <> 'off'
    OR current_schema() <> 'public' OR current_setting('search_path') <> 'public, pg_temp'
    OR current_setting('row_security') <> 'off' THEN
    RAISE EXCEPTION 'Admin refund creation receipt installation requires public PG16 read-write READ COMMITTED';
  END IF;
  IF current_setting('session_replication_role') <> 'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled <> 'D') THEN
    RAISE EXCEPTION 'Admin refund creation receipt installation environment requires review';
  END IF;
  IF NOT pg_try_advisory_xact_lock(731610,0) THEN RAISE EXCEPTION 'Admin refund creation receipt installation already running'; END IF;
  SELECT * INTO state FROM (SELECT present,oid,
  present AND safe AND shape = $arc_shape${"columns":[[1,"admin_id","integer",true,null,"","",null],[2,"request_key","uuid",true,null,"","",null],[3,"request_hash","character varying(64)",true,null,"","","pg_catalog.default"],[4,"order_id","integer",true,null,"","",null],[5,"refund_id","integer",false,null,"","",null],[6,"outcome","character varying(16)",true,null,"","","pg_catalog.default"],[7,"created_at","timestamp with time zone",true,"clock_timestamp()","","",null]],"constraints":[["arc_hash_ck","c","CHECK (((request_hash)::text ~ '^[0-9a-f]{64}$'::text))",true,false,false,false,true,0,"0"],["arc_identity_ck","c","CHECK (((admin_id > 0) AND (order_id > 0)))",true,false,false,false,true,0,"0"],["arc_key_ck","c","CHECK (((request_key)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text))",true,false,false,false,true,0,"0"],["arc_outcome_ck","c","CHECK (((((outcome)::text = 'created'::text) AND (refund_id IS NOT NULL) AND (refund_id > 0)) OR (((outcome)::text = 'abandoned'::text) AND (refund_id IS NULL))))",true,false,false,false,true,0,"0"],["arc_pk","p","PRIMARY KEY (admin_id, request_key)",true,false,false,true,true,0,"0"]],"indexes":[["arc_order_history","CREATE INDEX arc_order_history ON public.admin_refund_creation USING btree (order_id, created_at, admin_id, request_key)",false,false,true,true,true,true,false,false,false,4,4,"4 7 1 2","0 0 0 0",null,null],["arc_pk","CREATE UNIQUE INDEX arc_pk ON public.admin_refund_creation USING btree (admin_id, request_key)",true,true,true,true,true,true,false,false,false,2,2,"1 2","0 0",null,"arc_pk"]]}$arc_shape$::jsonb AS compatible
FROM (
SELECT c.oid IS NOT NULL AS present, c.oid::text AS oid,
  c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
  AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND c.relreplident='d'
  AND c.reloptions IS NULL AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
  AND c.relchecks=4 AND c.relnatts=7 AND c.relam=(SELECT oid FROM pg_am WHERE amname='heap')
  AND NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE confrelid=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND attisdropped)
  AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')))
  AND NOT EXISTS(SELECT 1 FROM pg_attribute col CROSS JOIN LATERAL aclexplode(col.attacl) a
    WHERE col.attrelid=c.oid AND a.grantee<>c.relowner
      AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT'))) AS safe,
  jsonb_build_object(
    'columns',(SELECT jsonb_agg(jsonb_build_array(a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
      pg_get_expr(d.adbin,d.adrelid),a.attidentity::text,a.attgenerated::text,
      CASE WHEN a.attcollation=0 THEN NULL ELSE cn.nspname||'.'||co.collname END) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.contype::text,pg_get_constraintdef(k.oid,false),
      k.convalidated,k.condeferrable,k.condeferred,k.connoinherit,k.conislocal,k.coninhcount,k.conparentid::text)
      ORDER BY k.conname COLLATE "C") FROM pg_constraint k WHERE k.conrelid=c.oid),
    'indexes',(SELECT jsonb_agg(jsonb_build_array(ic.relname,pg_get_indexdef(i.indexrelid),i.indisunique,i.indisprimary,
      i.indisvalid,i.indisready,i.indislive,i.indimmediate,i.indisexclusion,i.indnullsnotdistinct,i.indisreplident,
      i.indnatts,i.indnkeyatts,i.indkey::text,i.indoption::text,ic.reloptions,
      (SELECT k.conname FROM pg_constraint k WHERE k.conindid=i.indexrelid AND k.contype IN ('p','u')))
      ORDER BY ic.relname COLLATE "C") FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid)
  ) AS shape
FROM (VALUES(to_regclass('public.admin_refund_creation'))) target(id)
LEFT JOIN pg_class c ON c.oid=target.id) catalog) c;
  IF state.present THEN
    IF state.compatible IS DISTINCT FROM true THEN RAISE EXCEPTION 'Admin refund creation receipt catalog or ACL drift'; END IF;
    LOCK TABLE public.admin_refund_creation IN ACCESS EXCLUSIVE MODE NOWAIT;
  ELSE

CREATE TABLE "admin_refund_creation" (
  admin_id integer NOT NULL,
  request_key uuid NOT NULL,
  request_hash varchar(64) NOT NULL,
  order_id integer NOT NULL,
  refund_id integer,
  outcome varchar(16) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT arc_pk PRIMARY KEY (admin_id, request_key),
  CONSTRAINT arc_identity_ck CHECK (admin_id > 0 AND order_id > 0),
  CONSTRAINT arc_key_ck CHECK (request_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT arc_hash_ck CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT arc_outcome_ck CHECK (
    (outcome='created' AND refund_id IS NOT NULL AND refund_id > 0)
    OR (outcome='abandoned' AND refund_id IS NULL)
  )
);
CREATE INDEX arc_order_history ON admin_refund_creation(order_id, created_at, admin_id, request_key);

  END IF;
  SELECT * INTO state FROM (SELECT present,oid,
  present AND safe AND shape = $arc_shape${"columns":[[1,"admin_id","integer",true,null,"","",null],[2,"request_key","uuid",true,null,"","",null],[3,"request_hash","character varying(64)",true,null,"","","pg_catalog.default"],[4,"order_id","integer",true,null,"","",null],[5,"refund_id","integer",false,null,"","",null],[6,"outcome","character varying(16)",true,null,"","","pg_catalog.default"],[7,"created_at","timestamp with time zone",true,"clock_timestamp()","","",null]],"constraints":[["arc_hash_ck","c","CHECK (((request_hash)::text ~ '^[0-9a-f]{64}$'::text))",true,false,false,false,true,0,"0"],["arc_identity_ck","c","CHECK (((admin_id > 0) AND (order_id > 0)))",true,false,false,false,true,0,"0"],["arc_key_ck","c","CHECK (((request_key)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text))",true,false,false,false,true,0,"0"],["arc_outcome_ck","c","CHECK (((((outcome)::text = 'created'::text) AND (refund_id IS NOT NULL) AND (refund_id > 0)) OR (((outcome)::text = 'abandoned'::text) AND (refund_id IS NULL))))",true,false,false,false,true,0,"0"],["arc_pk","p","PRIMARY KEY (admin_id, request_key)",true,false,false,true,true,0,"0"]],"indexes":[["arc_order_history","CREATE INDEX arc_order_history ON public.admin_refund_creation USING btree (order_id, created_at, admin_id, request_key)",false,false,true,true,true,true,false,false,false,4,4,"4 7 1 2","0 0 0 0",null,null],["arc_pk","CREATE UNIQUE INDEX arc_pk ON public.admin_refund_creation USING btree (admin_id, request_key)",true,true,true,true,true,true,false,false,false,2,2,"1 2","0 0",null,"arc_pk"]]}$arc_shape$::jsonb AS compatible
FROM (
SELECT c.oid IS NOT NULL AS present, c.oid::text AS oid,
  c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
  AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND c.relreplident='d'
  AND c.reloptions IS NULL AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
  AND c.relchecks=4 AND c.relnatts=7 AND c.relam=(SELECT oid FROM pg_am WHERE amname='heap')
  AND NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE confrelid=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND attisdropped)
  AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')))
  AND NOT EXISTS(SELECT 1 FROM pg_attribute col CROSS JOIN LATERAL aclexplode(col.attacl) a
    WHERE col.attrelid=c.oid AND a.grantee<>c.relowner
      AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT'))) AS safe,
  jsonb_build_object(
    'columns',(SELECT jsonb_agg(jsonb_build_array(a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
      pg_get_expr(d.adbin,d.adrelid),a.attidentity::text,a.attgenerated::text,
      CASE WHEN a.attcollation=0 THEN NULL ELSE cn.nspname||'.'||co.collname END) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.contype::text,pg_get_constraintdef(k.oid,false),
      k.convalidated,k.condeferrable,k.condeferred,k.connoinherit,k.conislocal,k.coninhcount,k.conparentid::text)
      ORDER BY k.conname COLLATE "C") FROM pg_constraint k WHERE k.conrelid=c.oid),
    'indexes',(SELECT jsonb_agg(jsonb_build_array(ic.relname,pg_get_indexdef(i.indexrelid),i.indisunique,i.indisprimary,
      i.indisvalid,i.indisready,i.indislive,i.indimmediate,i.indisexclusion,i.indnullsnotdistinct,i.indisreplident,
      i.indnatts,i.indnkeyatts,i.indkey::text,i.indoption::text,ic.reloptions,
      (SELECT k.conname FROM pg_constraint k WHERE k.conindid=i.indexrelid AND k.contype IN ('p','u')))
      ORDER BY ic.relname COLLATE "C") FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid)
  ) AS shape
FROM (VALUES(to_regclass('public.admin_refund_creation'))) target(id)
LEFT JOIN pg_class c ON c.oid=target.id) catalog) c;
  IF state.compatible IS DISTINCT FROM true THEN RAISE EXCEPTION 'Admin refund creation receipt catalog or ACL drift after lock/create'; END IF;
  IF current_setting('session_replication_role') <> 'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled <> 'D') THEN
    RAISE EXCEPTION 'Admin refund creation receipt installation environment changed';
  END IF;
END
$arc_install$;
