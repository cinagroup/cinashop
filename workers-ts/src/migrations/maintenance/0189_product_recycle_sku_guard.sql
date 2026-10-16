-- Independent explicit PG16 owner maintenance; not historical bootstrap.
SELECT
  pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
  pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
  pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true);
DO $product_recycle_sku_guard$
DECLARE legacy boolean; successor boolean;
BEGIN
  IF NOT (current_user=session_user AND current_schema()='public'
  AND current_setting('server_version_num')::integer/10000=16
  AND current_setting('session_replication_role')='origin'
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')) OR current_setting('transaction_isolation')<>'read committed'
    OR current_setting('transaction_read_only')::boolean
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    OR NOT pg_catalog.pg_try_advisory_xact_lock(731627,13) THEN
    RAISE EXCEPTION 'Product recycle SKU guard requires explicit PG16 owner maintenance';
  END IF;
  LOCK TABLE ONLY public.store_product, ONLY public.store_product_attr_value, ONLY public.store_product_sku_retirement_log IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  SELECT (EXISTS(SELECT 1 FROM pg_catalog.pg_class p JOIN pg_catalog.pg_class s ON s.oid=to_regclass('public.store_product_attr_value')
  WHERE p.oid=to_regclass('public.store_product') AND p.relkind='r' AND s.relkind='r'
  AND p.relpersistence='p' AND s.relpersistence='p' AND NOT p.relispartition AND NOT s.relispartition
  AND NOT p.relrowsecurity AND NOT p.relforcerowsecurity AND NOT s.relrowsecurity AND NOT s.relforcerowsecurity
  AND p.relowner=s.relowner AND p.relowner=f.proowner
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid IN(p.oid,s.oid) OR inhparent IN(p.oid,s.oid))
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class IN(p.oid,s.oid))
  AND (SELECT count(*)=5 FROM pg_catalog.pg_attribute a WHERE a.attrelid=p.oid AND a.attname IN('id','type','relation_id','is_del','product_type')
    AND a.atttypid=CASE WHEN a.attname IN('id','relation_id') THEN 'pg_catalog.int4'::regtype ELSE 'pg_catalog.int2'::regtype END
    AND a.attnotnull AND NOT a.attisdropped AND a.attidentity='' AND a.attgenerated='')
  AND (SELECT count(*)=3 FROM pg_catalog.pg_attribute a WHERE a.attrelid=s.oid AND a.attname IN('product_id','type','is_retired')
    AND a.atttypid=CASE WHEN a.attname='product_id' THEN 'pg_catalog.int4'::regtype ELSE 'pg_catalog.int2'::regtype END
    AND a.attnotnull AND NOT a.attisdropped))) AND (EXISTS(SELECT 1 FROM pg_catalog.pg_class l WHERE l.oid=to_regclass('public.store_product_sku_retirement_log')
  AND l.relkind='r' AND l.relpersistence='p' AND NOT l.relispartition AND NOT l.relrowsecurity AND NOT l.relforcerowsecurity
  AND l.relowner=f.proowner AND l.relnatts=12 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=l.oid OR inhparent=l.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=l.oid)
  AND (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum)
    FROM pg_catalog.pg_attribute a WHERE a.attrelid=l.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attidentity='' AND a.attgenerated='')=
    '[ ["id","integer",true],["product_id","integer",true],["sku_id","integer",true],["unique_snapshot","character(8)",true],
       ["suk_snapshot","character varying(512)",true],["action","character varying(16)",true],["reason","character varying(255)",true],
       ["actor_id","integer",true],["actor_name","character varying(64)",true],["actor_ip","character varying(45)",true],
       ["dependency_snapshot","text",true],["add_time","integer",true] ]'::jsonb)) AND (f.prorettype='pg_catalog.trigger'::regtype AND f.pronargs=0 AND NOT f.prosecdef AND NOT f.proleakproof
  AND f.provolatile='v' AND f.prokind='f' AND NOT f.proisstrict AND NOT f.proretset AND f.proparallel='u'
  AND f.prosupport=0 AND f.provariadic=0 AND f.pronargdefaults=0 AND f.proargdefaults IS NULL
  AND f.proallargtypes IS NULL AND f.proargmodes IS NULL AND f.proargnames IS NULL AND f.procost=100
  AND f.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')) AND ((SELECT count(*)=1 AND bool_and(t.tgname='store_product_attr_value_retired_guard'
  AND t.tgrelid=to_regclass('public.store_product_attr_value') AND NOT t.tgisinternal AND t.tgenabled='O'
  AND t.tgtype=27 AND t.tgnargs=0 AND t.tgqual IS NULL AND t.tgconstraint=0 AND t.tgattr::text=''
  AND t.tgargs='\x'::bytea AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL)
  FROM pg_catalog.pg_trigger t WHERE t.tgfoid=f.oid)) AND (to_regprocedure('public.guard_product_permanent_delete_log()') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=to_regclass('public.store_product_sku_retirement_log')
    AND tgname IN('spsrl_permanent_rows','spsrl_permanent_truncate'))
  AND NOT EXISTS(SELECT 1 FROM ONLY public.store_product_sku_retirement_log WHERE action='permanent_delete'))
    AND f.prosrc='
BEGIN
  IF TG_OP = ''DELETE'' THEN
    IF OLD."is_retired" = 1 THEN
      RAISE EXCEPTION ''retired product SKU cannot be deleted'';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."is_retired" = 1 OR NEW."is_retired" = 1 THEN
    IF NEW."product_id" <> OLD."product_id"
      OR NEW."type" <> OLD."type"
      OR NEW."suk" <> OLD."suk"
      OR NEW."unique" <> OLD."unique" THEN
      RAISE EXCEPTION ''retired product SKU identity is immutable'';
    END IF;
    IF NEW."stock" < OLD."stock" THEN
      RAISE EXCEPTION ''retired product SKU stock cannot be consumed'';
    END IF;
  END IF;
  RETURN NEW;
END;
' AND f.proconfig IS NULL AND (NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a
  WHERE a.grantee<>f.proowner AND (a.grantee<>0 OR a.is_grantable OR a.privilege_type<>'EXECUTE'))
  AND EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a
    WHERE a.grantee=0 AND a.privilege_type='EXECUTE' AND NOT a.is_grantable))
    AND encode(sha256(convert_to(pg_get_functiondef(f.oid),'UTF8')),'hex')='a7fd5e4f568c081df96f905880e5396adfdfd49566ab9a2f3b335a3e3c703c09',
    (EXISTS(SELECT 1 FROM pg_catalog.pg_class p JOIN pg_catalog.pg_class s ON s.oid=to_regclass('public.store_product_attr_value')
  WHERE p.oid=to_regclass('public.store_product') AND p.relkind='r' AND s.relkind='r'
  AND p.relpersistence='p' AND s.relpersistence='p' AND NOT p.relispartition AND NOT s.relispartition
  AND NOT p.relrowsecurity AND NOT p.relforcerowsecurity AND NOT s.relrowsecurity AND NOT s.relforcerowsecurity
  AND p.relowner=s.relowner AND p.relowner=f.proowner
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid IN(p.oid,s.oid) OR inhparent IN(p.oid,s.oid))
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class IN(p.oid,s.oid))
  AND (SELECT count(*)=5 FROM pg_catalog.pg_attribute a WHERE a.attrelid=p.oid AND a.attname IN('id','type','relation_id','is_del','product_type')
    AND a.atttypid=CASE WHEN a.attname IN('id','relation_id') THEN 'pg_catalog.int4'::regtype ELSE 'pg_catalog.int2'::regtype END
    AND a.attnotnull AND NOT a.attisdropped AND a.attidentity='' AND a.attgenerated='')
  AND (SELECT count(*)=3 FROM pg_catalog.pg_attribute a WHERE a.attrelid=s.oid AND a.attname IN('product_id','type','is_retired')
    AND a.atttypid=CASE WHEN a.attname='product_id' THEN 'pg_catalog.int4'::regtype ELSE 'pg_catalog.int2'::regtype END
    AND a.attnotnull AND NOT a.attisdropped))) AND (f.prorettype='pg_catalog.trigger'::regtype AND f.pronargs=0 AND NOT f.prosecdef AND NOT f.proleakproof
  AND f.provolatile='v' AND f.prokind='f' AND NOT f.proisstrict AND NOT f.proretset AND f.proparallel='u'
  AND f.prosupport=0 AND f.provariadic=0 AND f.pronargdefaults=0 AND f.proargdefaults IS NULL
  AND f.proallargtypes IS NULL AND f.proargmodes IS NULL AND f.proargnames IS NULL AND f.procost=100
  AND f.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')) AND ((SELECT count(*)=1 AND bool_and(t.tgname='store_product_attr_value_retired_guard'
  AND t.tgrelid=to_regclass('public.store_product_attr_value') AND NOT t.tgisinternal AND t.tgenabled='O'
  AND t.tgtype=27 AND t.tgnargs=0 AND t.tgqual IS NULL AND t.tgconstraint=0 AND t.tgattr::text=''
  AND t.tgargs='\x'::bytea AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL)
  FROM pg_catalog.pg_trigger t WHERE t.tgfoid=f.oid)) AND ((EXISTS(SELECT 1 FROM pg_catalog.pg_class l WHERE l.oid=to_regclass('public.store_product_sku_retirement_log')
  AND l.relkind='r' AND l.relpersistence='p' AND NOT l.relispartition AND NOT l.relrowsecurity AND NOT l.relforcerowsecurity
  AND l.relowner=f.proowner AND l.relnatts=12 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=l.oid OR inhparent=l.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=l.oid)
  AND (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum)
    FROM pg_catalog.pg_attribute a WHERE a.attrelid=l.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attidentity='' AND a.attgenerated='')=
    '[ ["id","integer",true],["product_id","integer",true],["sku_id","integer",true],["unique_snapshot","character(8)",true],
       ["suk_snapshot","character varying(512)",true],["action","character varying(16)",true],["reason","character varying(255)",true],
       ["actor_id","integer",true],["actor_name","character varying(64)",true],["actor_ip","character varying(45)",true],
       ["dependency_snapshot","text",true],["add_time","integer",true] ]'::jsonb)) AND EXISTS(SELECT 1 FROM pg_catalog.pg_proc lf
  WHERE lf.oid=to_regprocedure('public.guard_product_permanent_delete_log()') AND lf.proowner=f.proowner
    AND (lf.prorettype='pg_catalog.trigger'::regtype AND lf.pronargs=0 AND NOT lf.prosecdef AND NOT lf.proleakproof
  AND lf.provolatile='v' AND lf.prokind='f' AND NOT lf.proisstrict AND NOT lf.proretset AND lf.proparallel='u'
  AND lf.prosupport=0 AND lf.provariadic=0 AND lf.pronargdefaults=0 AND lf.proargdefaults IS NULL
  AND lf.proallargtypes IS NULL AND lf.proargmodes IS NULL AND lf.proargnames IS NULL AND lf.procost=100
  AND lf.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')) AND lf.prosrc='BEGIN
  IF TG_TABLE_SCHEMA <> ''public'' OR TG_RELID <> pg_catalog.to_regclass(''public.store_product_sku_retirement_log'') THEN
    RAISE EXCEPTION ''Permanent product deletion log target mismatch'' USING ERRCODE=''42501'';
  END IF;
  IF TG_OP = ''TRUNCATE'' THEN
    IF EXISTS (SELECT 1 FROM ONLY public.store_product_sku_retirement_log WHERE action = ''permanent_delete'') THEN
      RAISE EXCEPTION ''Permanent product deletion facts cannot be truncated'' USING ERRCODE=''42501'';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = ''INSERT'' THEN
    IF NEW.action <> ''permanent_delete'' THEN RETURN NEW; END IF;
    IF NEW.product_id <= 0 OR NEW.sku_id <= 0 OR NEW.actor_id <= 0 OR NEW.add_time < 0
      OR NOT pg_catalog.pg_try_advisory_xact_lock(731742,NEW.sku_id) THEN
      RAISE EXCEPTION ''Permanent product deletion identity busy or invalid'' USING ERRCODE=''55P03'';
    END IF;
    IF EXISTS (SELECT 1 FROM ONLY public.store_product_sku_retirement_log WHERE action=''permanent_delete'' AND sku_id=NEW.sku_id) THEN
      RAISE EXCEPTION ''Permanent product deletion SKU fact already exists'' USING ERRCODE=''23505'';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ONLY public.store_product p JOIN ONLY public.store_product_attr_value s ON s.product_id=p.id
      WHERE p.id=NEW.product_id AND p.type=2 AND p.relation_id>0 AND p.is_del=1
        AND s.id=NEW.sku_id AND s.type=0 AND s."unique"=NEW.unique_snapshot AND s.suk=NEW.suk_snapshot
        AND NEW.dependency_snapshot::jsonb=pg_catalog.jsonb_build_object(''version'',1,''kind'',''supplier_product_permanent_delete'',
          ''owner_type'',2,''supplier_id'',p.relation_id,''product_type'',p.product_type)) THEN
      RAISE EXCEPTION ''Permanent product deletion fact does not match current Supplier root and SKU'' USING ERRCODE=''42501'';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.action=''permanent_delete'' THEN
    RAISE EXCEPTION ''Permanent product deletion facts are immutable'' USING ERRCODE=''42501'';
  END IF;
  IF TG_OP=''UPDATE'' THEN
    IF NEW.action=''permanent_delete'' THEN
      RAISE EXCEPTION ''Permanent product deletion facts are immutable'' USING ERRCODE=''42501'';
    END IF;
  END IF;
  IF TG_OP=''DELETE'' THEN RETURN OLD; END IF;
  RETURN NEW;
END'
    AND lf.proconfig=ARRAY['search_path=pg_catalog'] AND (NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(lf.proacl,pg_catalog.acldefault('f',lf.proowner))) a WHERE a.grantee<>lf.proowner))
    AND (SELECT count(*)=2 AND bool_and(NOT t.tgisinternal AND t.tgrelid=to_regclass('public.store_product_sku_retirement_log')
      AND t.tgenabled='O' AND t.tgnargs=0 AND t.tgqual IS NULL AND t.tgconstraint=0 AND t.tgattr::text='' AND t.tgargs='\x'::bytea
      AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL AND ((t.tgname='spsrl_permanent_rows' AND t.tgtype=31)
        OR (t.tgname='spsrl_permanent_truncate' AND t.tgtype=34))) FROM pg_catalog.pg_trigger t WHERE t.tgfoid=lf.oid)))
    AND f.prosrc='
BEGIN
  IF TG_OP = ''DELETE'' THEN
    IF OLD."is_retired" = 1 THEN
      IF OLD."type" = 0 AND TG_TABLE_SCHEMA = ''public''
        AND TG_RELID = pg_catalog.to_regclass(''public.store_product_attr_value'')
        AND NOT EXISTS (SELECT 1 FROM ONLY public.store_product WHERE id = OLD."product_id")
        AND EXISTS (SELECT 1 FROM ONLY public.store_product_sku_retirement_log l
          WHERE l.action = ''permanent_delete'' AND l.product_id = OLD."product_id" AND l.sku_id = OLD."id"
            AND l.unique_snapshot = OLD."unique" AND l.suk_snapshot = OLD."suk") THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION ''retired product SKU cannot be deleted'';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."is_retired" = 1 OR NEW."is_retired" = 1 THEN
    IF NEW."product_id" <> OLD."product_id"
      OR NEW."type" <> OLD."type"
      OR NEW."suk" <> OLD."suk"
      OR NEW."unique" <> OLD."unique" THEN
      RAISE EXCEPTION ''retired product SKU identity is immutable'';
    END IF;
    IF NEW."stock" < OLD."stock" THEN
      RAISE EXCEPTION ''retired product SKU stock cannot be consumed'';
    END IF;
  END IF;
  RETURN NEW;
END;
' AND f.proconfig=ARRAY['search_path=pg_catalog'] AND (NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a WHERE a.grantee<>f.proowner))
    INTO legacy,successor FROM pg_catalog.pg_proc f WHERE f.oid=to_regprocedure('public.guard_retired_product_sku()');
  IF successor IS TRUE THEN RETURN; END IF;
  IF legacy IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'Product recycle SKU predecessor catalog drift; no repair performed'; END IF;
  CREATE OR REPLACE FUNCTION public.guard_retired_product_sku() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $recycle_guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."is_retired" = 1 THEN
      IF OLD."type" = 0 AND TG_TABLE_SCHEMA = 'public'
        AND TG_RELID = pg_catalog.to_regclass('public.store_product_attr_value')
        AND NOT EXISTS (SELECT 1 FROM ONLY public.store_product WHERE id = OLD."product_id")
        AND EXISTS (SELECT 1 FROM ONLY public.store_product_sku_retirement_log l
          WHERE l.action = 'permanent_delete' AND l.product_id = OLD."product_id" AND l.sku_id = OLD."id"
            AND l.unique_snapshot = OLD."unique" AND l.suk_snapshot = OLD."suk") THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'retired product SKU cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."is_retired" = 1 OR NEW."is_retired" = 1 THEN
    IF NEW."product_id" <> OLD."product_id"
      OR NEW."type" <> OLD."type"
      OR NEW."suk" <> OLD."suk"
      OR NEW."unique" <> OLD."unique" THEN
      RAISE EXCEPTION 'retired product SKU identity is immutable';
    END IF;
    IF NEW."stock" < OLD."stock" THEN
      RAISE EXCEPTION 'retired product SKU stock cannot be consumed';
    END IF;
  END IF;
  RETURN NEW;
END;
$recycle_guard$;
REVOKE ALL ON FUNCTION public.guard_retired_product_sku() FROM PUBLIC;
CREATE FUNCTION public.guard_product_permanent_delete_log() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $permanent_log$BEGIN
  IF TG_TABLE_SCHEMA <> 'public' OR TG_RELID <> pg_catalog.to_regclass('public.store_product_sku_retirement_log') THEN
    RAISE EXCEPTION 'Permanent product deletion log target mismatch' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM ONLY public.store_product_sku_retirement_log WHERE action = 'permanent_delete') THEN
      RAISE EXCEPTION 'Permanent product deletion facts cannot be truncated' USING ERRCODE='42501';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.action <> 'permanent_delete' THEN RETURN NEW; END IF;
    IF NEW.product_id <= 0 OR NEW.sku_id <= 0 OR NEW.actor_id <= 0 OR NEW.add_time < 0
      OR NOT pg_catalog.pg_try_advisory_xact_lock(731742,NEW.sku_id) THEN
      RAISE EXCEPTION 'Permanent product deletion identity busy or invalid' USING ERRCODE='55P03';
    END IF;
    IF EXISTS (SELECT 1 FROM ONLY public.store_product_sku_retirement_log WHERE action='permanent_delete' AND sku_id=NEW.sku_id) THEN
      RAISE EXCEPTION 'Permanent product deletion SKU fact already exists' USING ERRCODE='23505';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ONLY public.store_product p JOIN ONLY public.store_product_attr_value s ON s.product_id=p.id
      WHERE p.id=NEW.product_id AND p.type=2 AND p.relation_id>0 AND p.is_del=1
        AND s.id=NEW.sku_id AND s.type=0 AND s."unique"=NEW.unique_snapshot AND s.suk=NEW.suk_snapshot
        AND NEW.dependency_snapshot::jsonb=pg_catalog.jsonb_build_object('version',1,'kind','supplier_product_permanent_delete',
          'owner_type',2,'supplier_id',p.relation_id,'product_type',p.product_type)) THEN
      RAISE EXCEPTION 'Permanent product deletion fact does not match current Supplier root and SKU' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.action='permanent_delete' THEN
    RAISE EXCEPTION 'Permanent product deletion facts are immutable' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.action='permanent_delete' THEN
      RAISE EXCEPTION 'Permanent product deletion facts are immutable' USING ERRCODE='42501';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END$permanent_log$;
REVOKE ALL ON FUNCTION public.guard_product_permanent_delete_log() FROM PUBLIC;
CREATE TRIGGER spsrl_permanent_rows BEFORE INSERT OR UPDATE OR DELETE ON public.store_product_sku_retirement_log
FOR EACH ROW EXECUTE FUNCTION public.guard_product_permanent_delete_log();
CREATE TRIGGER spsrl_permanent_truncate BEFORE TRUNCATE ON public.store_product_sku_retirement_log
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_product_permanent_delete_log();
  SELECT (EXISTS(SELECT 1 FROM pg_catalog.pg_class p JOIN pg_catalog.pg_class s ON s.oid=to_regclass('public.store_product_attr_value')
  WHERE p.oid=to_regclass('public.store_product') AND p.relkind='r' AND s.relkind='r'
  AND p.relpersistence='p' AND s.relpersistence='p' AND NOT p.relispartition AND NOT s.relispartition
  AND NOT p.relrowsecurity AND NOT p.relforcerowsecurity AND NOT s.relrowsecurity AND NOT s.relforcerowsecurity
  AND p.relowner=s.relowner AND p.relowner=f.proowner
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid IN(p.oid,s.oid) OR inhparent IN(p.oid,s.oid))
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class IN(p.oid,s.oid))
  AND (SELECT count(*)=5 FROM pg_catalog.pg_attribute a WHERE a.attrelid=p.oid AND a.attname IN('id','type','relation_id','is_del','product_type')
    AND a.atttypid=CASE WHEN a.attname IN('id','relation_id') THEN 'pg_catalog.int4'::regtype ELSE 'pg_catalog.int2'::regtype END
    AND a.attnotnull AND NOT a.attisdropped AND a.attidentity='' AND a.attgenerated='')
  AND (SELECT count(*)=3 FROM pg_catalog.pg_attribute a WHERE a.attrelid=s.oid AND a.attname IN('product_id','type','is_retired')
    AND a.atttypid=CASE WHEN a.attname='product_id' THEN 'pg_catalog.int4'::regtype ELSE 'pg_catalog.int2'::regtype END
    AND a.attnotnull AND NOT a.attisdropped))) AND (f.prorettype='pg_catalog.trigger'::regtype AND f.pronargs=0 AND NOT f.prosecdef AND NOT f.proleakproof
  AND f.provolatile='v' AND f.prokind='f' AND NOT f.proisstrict AND NOT f.proretset AND f.proparallel='u'
  AND f.prosupport=0 AND f.provariadic=0 AND f.pronargdefaults=0 AND f.proargdefaults IS NULL
  AND f.proallargtypes IS NULL AND f.proargmodes IS NULL AND f.proargnames IS NULL AND f.procost=100
  AND f.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')) AND ((SELECT count(*)=1 AND bool_and(t.tgname='store_product_attr_value_retired_guard'
  AND t.tgrelid=to_regclass('public.store_product_attr_value') AND NOT t.tgisinternal AND t.tgenabled='O'
  AND t.tgtype=27 AND t.tgnargs=0 AND t.tgqual IS NULL AND t.tgconstraint=0 AND t.tgattr::text=''
  AND t.tgargs='\x'::bytea AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL)
  FROM pg_catalog.pg_trigger t WHERE t.tgfoid=f.oid)) AND ((EXISTS(SELECT 1 FROM pg_catalog.pg_class l WHERE l.oid=to_regclass('public.store_product_sku_retirement_log')
  AND l.relkind='r' AND l.relpersistence='p' AND NOT l.relispartition AND NOT l.relrowsecurity AND NOT l.relforcerowsecurity
  AND l.relowner=f.proowner AND l.relnatts=12 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=l.oid OR inhparent=l.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=l.oid)
  AND (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum)
    FROM pg_catalog.pg_attribute a WHERE a.attrelid=l.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attidentity='' AND a.attgenerated='')=
    '[ ["id","integer",true],["product_id","integer",true],["sku_id","integer",true],["unique_snapshot","character(8)",true],
       ["suk_snapshot","character varying(512)",true],["action","character varying(16)",true],["reason","character varying(255)",true],
       ["actor_id","integer",true],["actor_name","character varying(64)",true],["actor_ip","character varying(45)",true],
       ["dependency_snapshot","text",true],["add_time","integer",true] ]'::jsonb)) AND EXISTS(SELECT 1 FROM pg_catalog.pg_proc lf
  WHERE lf.oid=to_regprocedure('public.guard_product_permanent_delete_log()') AND lf.proowner=f.proowner
    AND (lf.prorettype='pg_catalog.trigger'::regtype AND lf.pronargs=0 AND NOT lf.prosecdef AND NOT lf.proleakproof
  AND lf.provolatile='v' AND lf.prokind='f' AND NOT lf.proisstrict AND NOT lf.proretset AND lf.proparallel='u'
  AND lf.prosupport=0 AND lf.provariadic=0 AND lf.pronargdefaults=0 AND lf.proargdefaults IS NULL
  AND lf.proallargtypes IS NULL AND lf.proargmodes IS NULL AND lf.proargnames IS NULL AND lf.procost=100
  AND lf.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')) AND lf.prosrc='BEGIN
  IF TG_TABLE_SCHEMA <> ''public'' OR TG_RELID <> pg_catalog.to_regclass(''public.store_product_sku_retirement_log'') THEN
    RAISE EXCEPTION ''Permanent product deletion log target mismatch'' USING ERRCODE=''42501'';
  END IF;
  IF TG_OP = ''TRUNCATE'' THEN
    IF EXISTS (SELECT 1 FROM ONLY public.store_product_sku_retirement_log WHERE action = ''permanent_delete'') THEN
      RAISE EXCEPTION ''Permanent product deletion facts cannot be truncated'' USING ERRCODE=''42501'';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = ''INSERT'' THEN
    IF NEW.action <> ''permanent_delete'' THEN RETURN NEW; END IF;
    IF NEW.product_id <= 0 OR NEW.sku_id <= 0 OR NEW.actor_id <= 0 OR NEW.add_time < 0
      OR NOT pg_catalog.pg_try_advisory_xact_lock(731742,NEW.sku_id) THEN
      RAISE EXCEPTION ''Permanent product deletion identity busy or invalid'' USING ERRCODE=''55P03'';
    END IF;
    IF EXISTS (SELECT 1 FROM ONLY public.store_product_sku_retirement_log WHERE action=''permanent_delete'' AND sku_id=NEW.sku_id) THEN
      RAISE EXCEPTION ''Permanent product deletion SKU fact already exists'' USING ERRCODE=''23505'';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ONLY public.store_product p JOIN ONLY public.store_product_attr_value s ON s.product_id=p.id
      WHERE p.id=NEW.product_id AND p.type=2 AND p.relation_id>0 AND p.is_del=1
        AND s.id=NEW.sku_id AND s.type=0 AND s."unique"=NEW.unique_snapshot AND s.suk=NEW.suk_snapshot
        AND NEW.dependency_snapshot::jsonb=pg_catalog.jsonb_build_object(''version'',1,''kind'',''supplier_product_permanent_delete'',
          ''owner_type'',2,''supplier_id'',p.relation_id,''product_type'',p.product_type)) THEN
      RAISE EXCEPTION ''Permanent product deletion fact does not match current Supplier root and SKU'' USING ERRCODE=''42501'';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.action=''permanent_delete'' THEN
    RAISE EXCEPTION ''Permanent product deletion facts are immutable'' USING ERRCODE=''42501'';
  END IF;
  IF TG_OP=''UPDATE'' THEN
    IF NEW.action=''permanent_delete'' THEN
      RAISE EXCEPTION ''Permanent product deletion facts are immutable'' USING ERRCODE=''42501'';
    END IF;
  END IF;
  IF TG_OP=''DELETE'' THEN RETURN OLD; END IF;
  RETURN NEW;
END'
    AND lf.proconfig=ARRAY['search_path=pg_catalog'] AND (NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(lf.proacl,pg_catalog.acldefault('f',lf.proowner))) a WHERE a.grantee<>lf.proowner))
    AND (SELECT count(*)=2 AND bool_and(NOT t.tgisinternal AND t.tgrelid=to_regclass('public.store_product_sku_retirement_log')
      AND t.tgenabled='O' AND t.tgnargs=0 AND t.tgqual IS NULL AND t.tgconstraint=0 AND t.tgattr::text='' AND t.tgargs='\x'::bytea
      AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL AND ((t.tgname='spsrl_permanent_rows' AND t.tgtype=31)
        OR (t.tgname='spsrl_permanent_truncate' AND t.tgtype=34))) FROM pg_catalog.pg_trigger t WHERE t.tgfoid=lf.oid)))
    AND f.prosrc='
BEGIN
  IF TG_OP = ''DELETE'' THEN
    IF OLD."is_retired" = 1 THEN
      IF OLD."type" = 0 AND TG_TABLE_SCHEMA = ''public''
        AND TG_RELID = pg_catalog.to_regclass(''public.store_product_attr_value'')
        AND NOT EXISTS (SELECT 1 FROM ONLY public.store_product WHERE id = OLD."product_id")
        AND EXISTS (SELECT 1 FROM ONLY public.store_product_sku_retirement_log l
          WHERE l.action = ''permanent_delete'' AND l.product_id = OLD."product_id" AND l.sku_id = OLD."id"
            AND l.unique_snapshot = OLD."unique" AND l.suk_snapshot = OLD."suk") THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION ''retired product SKU cannot be deleted'';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."is_retired" = 1 OR NEW."is_retired" = 1 THEN
    IF NEW."product_id" <> OLD."product_id"
      OR NEW."type" <> OLD."type"
      OR NEW."suk" <> OLD."suk"
      OR NEW."unique" <> OLD."unique" THEN
      RAISE EXCEPTION ''retired product SKU identity is immutable'';
    END IF;
    IF NEW."stock" < OLD."stock" THEN
      RAISE EXCEPTION ''retired product SKU stock cannot be consumed'';
    END IF;
  END IF;
  RETURN NEW;
END;
' AND f.proconfig=ARRAY['search_path=pg_catalog'] AND (NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a WHERE a.grantee<>f.proowner))
    INTO successor FROM pg_catalog.pg_proc f WHERE f.oid=to_regprocedure('public.guard_retired_product_sku()');
  IF successor IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'Product recycle SKU successor catalog drift; complete installation rolled back'; END IF;
END
$product_recycle_sku_guard$;
