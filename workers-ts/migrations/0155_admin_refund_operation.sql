SET LOCAL search_path=public,pg_temp;
SET LOCAL row_security=off;
SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),30000)::text || 'ms',true),
  set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true);
DO $aro_install$
DECLARE state record;
BEGIN
  IF current_setting('server_version_num')::integer / 10000 <> 16
    OR current_setting('transaction_isolation') <> 'read committed' OR current_setting('transaction_read_only') <> 'off'
    OR current_schema() <> 'public' OR current_setting('search_path') <> 'public, pg_temp'
    OR current_setting('row_security') <> 'off' THEN
    RAISE EXCEPTION 'Admin refund receipt installation requires public PG16 read-write READ COMMITTED';
  END IF;
  IF current_setting('session_replication_role') <> 'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled <> 'D') THEN
    RAISE EXCEPTION 'Admin refund receipt installation environment requires review';
  END IF;
  IF NOT pg_try_advisory_xact_lock(731608,0) THEN RAISE EXCEPTION 'Admin refund receipt installation already running'; END IF;
  SELECT * INTO state FROM (SELECT present,oid,
  present AND safe AND shape = $aro_shape${"columns":[[1,"admin_id","integer",true,null,"","",null],[2,"request_key","uuid",true,null,"","",null],[3,"request_hash","character varying(64)",true,null,"","","pg_catalog.default"],[4,"refund_id","integer",true,null,"","",null],[5,"action","character varying(8)",true,null,"","","pg_catalog.default"],[6,"outcome","character varying(24)",true,null,"","","pg_catalog.default"],[7,"created_at","timestamp with time zone",true,"clock_timestamp()","","",null]],"constraints":[["aro_hash_ck","c","CHECK (((request_hash)::text ~ '^[0-9a-f]{64}$'::text))",true,false,false,false,true,0,"0"],["aro_identity_ck","c","CHECK (((admin_id > 0) AND (refund_id > 0)))",true,false,false,false,true,0,"0"],["aro_key_ck","c","CHECK (((request_key)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text))",true,false,false,false,true,0,"0"],["aro_outcome_ck","c","CHECK (((((action)::text = 'return'::text) AND ((outcome)::text = ANY ((ARRAY['return-approved'::character varying, 'abandoned'::character varying])::text[]))) OR (((action)::text = 'refuse'::text) AND ((outcome)::text = ANY ((ARRAY['refused'::character varying, 'abandoned'::character varying])::text[]))) OR (((action)::text = 'refund'::text) AND ((outcome)::text = ANY ((ARRAY['balance-settled'::character varying, 'provider-admitted'::character varying, 'abandoned'::character varying])::text[])))))",true,false,false,false,true,0,"0"],["aro_pk","p","PRIMARY KEY (admin_id, request_key)",true,false,false,true,true,0,"0"]],"indexes":[["aro_pk","CREATE UNIQUE INDEX aro_pk ON public.admin_refund_operation USING btree (admin_id, request_key)",true,true,true,true,true,true,false,false,false,2,2,"1 2","0 0",null,"aro_pk"],["aro_refund_history","CREATE INDEX aro_refund_history ON public.admin_refund_operation USING btree (refund_id, created_at, admin_id, request_key)",false,false,true,true,true,true,false,false,false,4,4,"4 7 1 2","0 0 0 0",null,null]]}$aro_shape$::jsonb AS compatible
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
FROM (VALUES(to_regclass('public.admin_refund_operation'))) target(id)
LEFT JOIN pg_class c ON c.oid=target.id) catalog) c;
  IF state.present THEN
    IF state.compatible IS DISTINCT FROM true THEN RAISE EXCEPTION 'Admin refund receipt catalog or ACL drift'; END IF;
    LOCK TABLE public.admin_refund_operation IN ACCESS EXCLUSIVE MODE NOWAIT;
  ELSE

CREATE TABLE "admin_refund_operation" (
  "admin_id" integer NOT NULL,
  "request_key" uuid NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "refund_id" integer NOT NULL,
  "action" varchar(8) NOT NULL,
  "outcome" varchar(24) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT aro_pk PRIMARY KEY (admin_id, request_key),
  CONSTRAINT aro_identity_ck CHECK (admin_id > 0 AND refund_id > 0),
  CONSTRAINT aro_hash_ck CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT aro_key_ck CHECK (request_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT aro_outcome_ck CHECK (
    (action = 'return' AND outcome IN ('return-approved','abandoned')) OR
    (action = 'refuse' AND outcome IN ('refused','abandoned')) OR
    (action = 'refund' AND outcome IN ('balance-settled','provider-admitted','abandoned'))
  )
);
CREATE INDEX aro_refund_history ON admin_refund_operation (refund_id, created_at, admin_id, request_key);

  END IF;
  SELECT * INTO state FROM (SELECT present,oid,
  present AND safe AND shape = $aro_shape${"columns":[[1,"admin_id","integer",true,null,"","",null],[2,"request_key","uuid",true,null,"","",null],[3,"request_hash","character varying(64)",true,null,"","","pg_catalog.default"],[4,"refund_id","integer",true,null,"","",null],[5,"action","character varying(8)",true,null,"","","pg_catalog.default"],[6,"outcome","character varying(24)",true,null,"","","pg_catalog.default"],[7,"created_at","timestamp with time zone",true,"clock_timestamp()","","",null]],"constraints":[["aro_hash_ck","c","CHECK (((request_hash)::text ~ '^[0-9a-f]{64}$'::text))",true,false,false,false,true,0,"0"],["aro_identity_ck","c","CHECK (((admin_id > 0) AND (refund_id > 0)))",true,false,false,false,true,0,"0"],["aro_key_ck","c","CHECK (((request_key)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text))",true,false,false,false,true,0,"0"],["aro_outcome_ck","c","CHECK (((((action)::text = 'return'::text) AND ((outcome)::text = ANY ((ARRAY['return-approved'::character varying, 'abandoned'::character varying])::text[]))) OR (((action)::text = 'refuse'::text) AND ((outcome)::text = ANY ((ARRAY['refused'::character varying, 'abandoned'::character varying])::text[]))) OR (((action)::text = 'refund'::text) AND ((outcome)::text = ANY ((ARRAY['balance-settled'::character varying, 'provider-admitted'::character varying, 'abandoned'::character varying])::text[])))))",true,false,false,false,true,0,"0"],["aro_pk","p","PRIMARY KEY (admin_id, request_key)",true,false,false,true,true,0,"0"]],"indexes":[["aro_pk","CREATE UNIQUE INDEX aro_pk ON public.admin_refund_operation USING btree (admin_id, request_key)",true,true,true,true,true,true,false,false,false,2,2,"1 2","0 0",null,"aro_pk"],["aro_refund_history","CREATE INDEX aro_refund_history ON public.admin_refund_operation USING btree (refund_id, created_at, admin_id, request_key)",false,false,true,true,true,true,false,false,false,4,4,"4 7 1 2","0 0 0 0",null,null]]}$aro_shape$::jsonb AS compatible
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
FROM (VALUES(to_regclass('public.admin_refund_operation'))) target(id)
LEFT JOIN pg_class c ON c.oid=target.id) catalog) c;
  IF state.compatible IS DISTINCT FROM true THEN RAISE EXCEPTION 'Admin refund receipt catalog or ACL drift after lock/create'; END IF;
  IF current_setting('session_replication_role') <> 'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled <> 'D') THEN
    RAISE EXCEPTION 'Admin refund receipt installation environment changed';
  END IF;
END
$aro_install$;
