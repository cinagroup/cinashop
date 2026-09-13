SET LOCAL search_path=pg_catalog,pg_temp; SET LOCAL row_security=off;
SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),30000)::text || 'ms',true),
  set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true);
DO $shipping_indexes_0153$
DECLARE
  ready boolean; item record; phase integer;
  observed_functions jsonb; observed_triggers jsonb; functions_ok boolean; triggers_ok boolean;
  expected_functions jsonb := $shipping_index_functions$[{"name":"shipping_lifecycle_bind","args":"23 23 23","argNames":["template","owner_type","owner_id"],"returns":2278,"language":"plpgsql","volatility":"v","strict":false,"body":"\nDECLARE parent record;\nBEGIN\n IF template=0 THEN RETURN; END IF;\n IF current_setting('transaction_isolation')<>'read committed' THEN\n  RAISE EXCEPTION USING ERRCODE='25000',MESSAGE='Shipping lifecycle requires READ COMMITTED';\n END IF;\n SELECT s.id,s.owner_type,s.relation_id,s.is_del,s.status INTO parent\n FROM public.shipping_templates s WHERE s.id=template FOR SHARE NOWAIT;\n IF NOT FOUND OR parent.is_del<>0 OR parent.status<>1 OR owner_type NOT IN (0,1,2)\n   OR (owner_type=0 AND owner_id<>0) OR (owner_type<>0 AND owner_id<=0)\n   OR parent.owner_type<>owner_type OR parent.relation_id<>owner_id THEN\n  RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='Shipping template binding is unavailable or belongs to another owner';\n END IF;\nEND ","config":["search_path=pg_catalog, pg_temp","row_security=off"]},{"name":"shipping_lifecycle_child","args":"","argNames":null,"returns":2279,"language":"plpgsql","volatility":"v","strict":false,"body":"\nDECLARE incoming jsonb; previous jsonb; source record; reference integer; dependent integer;\nBEGIN\n IF TG_TABLE_SCHEMA<>'public' OR TG_TABLE_NAME NOT IN\n  ('store_product','store_seckill','store_bargain','store_combination','store_integral','store_discounts_products') THEN\n  RAISE EXCEPTION 'Unexpected shipping lifecycle table';\n END IF;\n IF TG_OP<>'DELETE' THEN incoming=to_jsonb(NEW); END IF;\n IF TG_OP<>'INSERT' THEN previous=to_jsonb(OLD); END IF;\n -- Zero is the only unbound/default sentinel. Reject negative stored IDs before\n -- either free/fixed freight or an unchanged-row shortcut can hide invalid data.\n IF TG_OP<>'DELETE' AND (incoming->>'temp_id')::integer<0 THEN\n  RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='Shipping template ID cannot be negative';\n END IF;\n -- Final values, not UPDATE's column list: catches a BEFORE trigger rebinding\n -- during an apparently unrelated update. Ordinary price/stock writes are free.\n IF TG_OP='UPDATE' AND (incoming->'id',incoming->'temp_id',incoming->'freight',incoming->'product_id',incoming->'type',incoming->'relation_id')\n  IS NOT DISTINCT FROM (previous->'id',previous->'temp_id',previous->'freight',previous->'product_id',previous->'type',previous->'relation_id') THEN\n  RETURN NULL;\n END IF;\n IF current_setting('transaction_isolation')<>'read committed' THEN\n  RAISE EXCEPTION USING ERRCODE='25000',MESSAGE='Shipping lifecycle requires READ COMMITTED';\n END IF;\n IF TG_TABLE_NAME='store_product' THEN\n  -- Product ownership is also the authority for independent activity bindings.\n  -- Hold the actual product write lock already acquired by the outer DML;\n  -- acquire templates in ID order, NOWAIT, without waiting in reverse order.\n  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (NEW.id,NEW.type,NEW.relation_id) IS DISTINCT FROM (OLD.id,OLD.type,OLD.relation_id)) THEN\n   FOR dependent IN SELECT DISTINCT refs.ref FROM (\n    SELECT public.shipping_lifecycle_ref(temp_id,freight) AS ref FROM public.store_seckill WHERE product_id=OLD.id\n    UNION ALL SELECT public.shipping_lifecycle_ref(temp_id,freight) FROM public.store_bargain WHERE product_id=OLD.id\n    UNION ALL SELECT public.shipping_lifecycle_ref(temp_id,freight) FROM public.store_combination WHERE product_id=OLD.id\n    UNION ALL SELECT public.shipping_lifecycle_ref(temp_id,freight) FROM public.store_integral WHERE product_id=OLD.id\n    UNION ALL SELECT public.shipping_lifecycle_ref(temp_id,2) FROM public.store_discounts_products WHERE product_id=OLD.id\n   ) refs WHERE refs.ref>0 ORDER BY refs.ref LOOP\n    IF TG_OP='DELETE' OR NEW.id<>OLD.id THEN\n     RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='Shipping activity still references the source product';\n    END IF;\n    PERFORM public.shipping_lifecycle_bind(dependent,NEW.type,NEW.relation_id);\n   END LOOP;\n  END IF;\n  IF TG_OP='DELETE' THEN RETURN NULL; END IF;\n  PERFORM public.shipping_lifecycle_bind(public.shipping_lifecycle_ref(NEW.temp_id,NEW.freight),NEW.type,NEW.relation_id);\n ELSE\n  IF TG_OP='DELETE' THEN RETURN NULL; END IF;\n  reference=public.shipping_lifecycle_ref((incoming->>'temp_id')::integer,COALESCE((incoming->>'freight')::integer,2));\n  IF reference>0 THEN\n   SELECT p.id,p.type,p.relation_id INTO source FROM public.store_product p\n    WHERE p.id=(incoming->>'product_id')::integer FOR SHARE NOWAIT;\n   IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='Shipping source product is missing'; END IF;\n   PERFORM public.shipping_lifecycle_bind(reference,source.type,source.relation_id);\n  END IF;\n END IF;\n RETURN NULL;\nEND ","config":["search_path=pg_catalog, pg_temp","row_security=off"]},{"name":"shipping_lifecycle_no_truncate","args":"","argNames":null,"returns":2279,"language":"plpgsql","volatility":"v","strict":false,"body":"\nBEGIN RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='Shipping template/source TRUNCATE requires a separate maintenance protocol'; END ","config":["search_path=pg_catalog, pg_temp"]},{"name":"shipping_lifecycle_parent","args":"","argNames":null,"returns":2279,"language":"plpgsql","volatility":"v","strict":false,"body":"\nDECLARE referenced boolean;\nBEGIN\n IF TG_TABLE_SCHEMA<>'public' OR TG_TABLE_NAME<>'shipping_templates' THEN RAISE EXCEPTION 'Unexpected shipping parent table'; END IF;\n IF TG_OP='UPDATE' THEN\n  IF (NEW.id,NEW.owner_type,NEW.relation_id,NEW.is_del,NEW.status) IS NOT DISTINCT FROM\n     (OLD.id,OLD.owner_type,OLD.relation_id,OLD.is_del,OLD.status) THEN RETURN NULL; END IF;\n  IF NEW.id=OLD.id AND NEW.owner_type=OLD.owner_type AND NEW.relation_id=OLD.relation_id\n    AND NEW.is_del=0 AND NEW.status=1 THEN RETURN NULL; END IF;\n END IF;\n IF current_setting('transaction_isolation')<>'read committed' THEN\n  RAISE EXCEPTION USING ERRCODE='25000',MESSAGE='Shipping lifecycle requires READ COMMITTED';\n END IF;\n -- VOLATILE SPI reads a fresh RC snapshot after the parent DML lock is held.\n -- Child admission's SHARE lock prevents a successful concurrent retirement.\n -- Plan for this template ID, not a parameter-insensitive cached EXISTS plan:\n -- hot references and absent IDs have radically different selectivity. The\n -- statement and identifiers are fixed; only the typed OLD.id is bound by USING.\n EXECUTE $shipping_reference_check$\n SELECT EXISTS(SELECT 1 FROM public.store_product WHERE (CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN(1,2) THEN 1 ELSE 0 END)=$1)\n OR EXISTS(SELECT 1 FROM public.store_seckill WHERE (CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN(1,2) THEN 1 ELSE 0 END)=$1)\n OR EXISTS(SELECT 1 FROM public.store_bargain WHERE (CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN(1,2) THEN 1 ELSE 0 END)=$1)\n OR EXISTS(SELECT 1 FROM public.store_combination WHERE (CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN(1,2) THEN 1 ELSE 0 END)=$1)\n OR EXISTS(SELECT 1 FROM public.store_integral WHERE (CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN(1,2) THEN 1 ELSE 0 END)=$1)\n OR EXISTS(SELECT 1 FROM public.store_discounts_products WHERE (CASE WHEN temp_id>0 THEN temp_id ELSE 0 END)=$1)\n $shipping_reference_check$ INTO referenced USING OLD.id;\n IF referenced THEN\n  RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='Shipping template is still referenced';\n END IF;\n RETURN NULL;\nEND ","config":["search_path=pg_catalog, pg_temp","row_security=off"]},{"name":"shipping_lifecycle_ref","args":"23 23","argNames":["temp","freight"],"returns":23,"language":"sql","volatility":"i","strict":true,"body":" SELECT CASE WHEN temp>0 THEN temp WHEN freight NOT IN (1,2) THEN 1 ELSE 0 END ","config":["search_path=pg_catalog, pg_temp"]}]$shipping_index_functions$::jsonb;
  expected_triggers jsonb := $shipping_index_triggers$[{"table":"shipping_templates","name":"shipping_lifecycle_no_truncate","function":"shipping_lifecycle_no_truncate","type":34,"schema":"public"},{"table":"shipping_templates","name":"shipping_lifecycle_parent","function":"shipping_lifecycle_parent","type":25,"schema":"public"},{"table":"store_bargain","name":"shipping_lifecycle_child","function":"shipping_lifecycle_child","type":29,"schema":"public"},{"table":"store_combination","name":"shipping_lifecycle_child","function":"shipping_lifecycle_child","type":29,"schema":"public"},{"table":"store_discounts_products","name":"shipping_lifecycle_child","function":"shipping_lifecycle_child","type":29,"schema":"public"},{"table":"store_integral","name":"shipping_lifecycle_child","function":"shipping_lifecycle_child","type":29,"schema":"public"},{"table":"store_product","name":"shipping_lifecycle_child","function":"shipping_lifecycle_child","type":29,"schema":"public"},{"table":"store_product","name":"shipping_lifecycle_no_truncate","function":"shipping_lifecycle_no_truncate","type":34,"schema":"public"},{"table":"store_seckill","name":"shipping_lifecycle_child","function":"shipping_lifecycle_child","type":29,"schema":"public"}]$shipping_index_triggers$::jsonb;
BEGIN
  IF current_setting('server_version_num')::integer / 10000 <> 16
    OR current_setting('transaction_isolation') <> 'read committed' OR current_setting('transaction_read_only') <> 'off' THEN
    RAISE EXCEPTION 'Shipping indexes require PostgreSQL 16 read-write READ COMMITTED';
  END IF;
  IF current_setting('search_path') <> 'pg_catalog, pg_temp' OR current_setting('row_security') <> 'off'
    OR (SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout') NOT BETWEEN 1 AND 30000
    OR (SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout') NOT BETWEEN 1 AND 1000
    OR (SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout') NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'Shipping indexes require bounded maintenance settings';
  END IF;
  FOR phase IN 0..1 LOOP
    SELECT "originTriggersActive" AND "noEnabledEventTriggers" AND "noUnreviewedRelationTriggers" INTO ready
      FROM (SELECT
  pg_catalog.current_setting('session_replication_role') IN ('origin','local') AS "originTriggersActive",
  NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS "noEnabledEventTriggers",
  NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
    WHERE n.nspname='public' AND c.relname IN
      ('shipping_templates','store_product','store_seckill','store_bargain',
       'store_combination','store_integral','store_discounts_products')
      AND t.tgenabled<>'D'
      -- Reserved names/functions remain the exact protocol inspector's job.
      -- Do not waive internal RI triggers: CASCADE can remove/rebind retained
      -- references before the shipping AFTER trigger observes them.
      AND NOT pg_catalog.starts_with(t.tgname,'shipping_lifecycle_')
      AND NOT (pn.nspname='public' AND pg_catalog.starts_with(p.proname,'shipping_lifecycle_'))
  ) AS "noUnreviewedRelationTriggers") e;
    IF ready IS DISTINCT FROM true THEN RAISE EXCEPTION 'Shipping index installation environment requires review'; END IF;
    SELECT count(*)=7 AND bool_and(compatible) INTO ready FROM (
WITH wanted(table_name,columns,types) AS (VALUES
        ('shipping_templates',ARRAY['id','owner_type','relation_id','is_del','status'],ARRAY[23,21,23,21,21]),
        ('store_product',ARRAY['id','type','relation_id','temp_id','freight'],ARRAY[23,21,23,23,21]),
        ('store_seckill',ARRAY['id','product_id','temp_id','freight'],ARRAY[23,23,23,21]),
        ('store_bargain',ARRAY['id','product_id','temp_id','freight'],ARRAY[23,23,23,21]),
        ('store_combination',ARRAY['id','product_id','temp_id','freight'],ARRAY[23,23,23,21]),
        ('store_integral',ARRAY['id','product_id','temp_id','freight'],ARRAY[23,23,23,21]),
        ('store_discounts_products',ARRAY['id','product_id','temp_id'],ARRAY[23,23,23])
      ) SELECT w.table_name, COALESCE(c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
        AND NOT EXISTS(SELECT 1 FROM unnest(w.columns,w.types) required(name,type_oid)
          LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname=required.name AND a.attnum>0 AND NOT a.attisdropped
          WHERE a.attnum IS NULL OR a.atttypid<>required.type_oid OR NOT a.attnotnull OR a.attgenerated<>'')
        AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint pk JOIN pg_catalog.pg_attribute id ON id.attrelid=c.oid AND id.attname='id'
          WHERE pk.conrelid=c.oid AND pk.contype='p' AND pk.convalidated AND NOT pk.condeferrable AND pk.conkey=ARRAY[id.attnum]),false) AS compatible
      FROM wanted w LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public'
      LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=w.table_name
) s;
    IF ready IS DISTINCT FROM true THEN RAISE EXCEPTION 'Shipping index table structure differs'; END IF;
    IF phase=0 THEN

LOCK TABLE ONLY public.shipping_templates, ONLY public.store_bargain,
      ONLY public.store_combination, ONLY public.store_discounts_products, ONLY public.store_integral,
      ONLY public.store_product, ONLY public.store_seckill IN SHARE ROW EXCLUSIVE MODE NOWAIT
;
    END IF;
  END LOOP;
  SELECT count(*)=6 AND bool_and(invalid_references=0) INTO ready FROM (
WITH stored AS MATERIALIZED (
        SELECT 'store_product'::text AS table_name,p.temp_id,p.freight,p.type AS owner_type,p.relation_id AS owner_id,true AS source_present FROM public.store_product p
        UNION ALL SELECT 'store_seckill',c.temp_id,c.freight,p.type,p.relation_id,p.id IS NOT NULL FROM public.store_seckill c LEFT JOIN public.store_product p ON p.id=c.product_id
        UNION ALL SELECT 'store_bargain',c.temp_id,c.freight,p.type,p.relation_id,p.id IS NOT NULL FROM public.store_bargain c LEFT JOIN public.store_product p ON p.id=c.product_id
        UNION ALL SELECT 'store_combination',c.temp_id,c.freight,p.type,p.relation_id,p.id IS NOT NULL FROM public.store_combination c LEFT JOIN public.store_product p ON p.id=c.product_id
        UNION ALL SELECT 'store_integral',c.temp_id,c.freight,p.type,p.relation_id,p.id IS NOT NULL FROM public.store_integral c LEFT JOIN public.store_product p ON p.id=c.product_id
        UNION ALL SELECT 'store_discounts_products',c.temp_id,2,p.type,p.relation_id,p.id IS NOT NULL FROM public.store_discounts_products c LEFT JOIN public.store_product p ON p.id=c.product_id
      ), refs AS (SELECT *,CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN (1,2) THEN 1 ELSE 0 END AS ref FROM stored),
      checks AS (SELECT r.*,temp_id<0 AS bad_id,ref>0 AND NOT source_present AS bad_source,
        ref>0 AND source_present AND NOT COALESCE(r.owner_type IN (0,1,2) AND (CASE WHEN r.owner_type=0 THEN owner_id=0 ELSE owner_id>0 END),false) AS bad_owner,
        ref>0 AND t.id IS NULL AS missing_parent,
        ref>0 AND t.id IS NOT NULL AND (t.is_del<>0 OR t.status<>1) AS unavailable_parent,
        ref>0 AND source_present AND t.id IS NOT NULL AND (t.owner_type IS DISTINCT FROM r.owner_type OR t.relation_id IS DISTINCT FROM r.owner_id) AS wrong_owner
        FROM refs r LEFT JOIN public.shipping_templates t ON t.id=r.ref),
      names(table_name) AS (VALUES('store_product'),('store_seckill'),('store_bargain'),('store_combination'),('store_integral'),('store_discounts_products'))
      SELECT names.table_name,count(c.table_name)::int AS rows,count(*) FILTER(WHERE ref>0)::int AS reference_count,
        count(*) FILTER(WHERE ref=1 AND temp_id<=0)::int AS implicit_default,
        count(*) FILTER(WHERE bad_id OR bad_source OR bad_owner OR missing_parent OR unavailable_parent OR wrong_owner)::int AS invalid_references,
        count(*) FILTER(WHERE bad_id)::int AS negative_template_id,count(*) FILTER(WHERE bad_source)::int AS missing_source,
        count(*) FILTER(WHERE bad_owner)::int AS invalid_source_owner,count(*) FILTER(WHERE missing_parent)::int AS missing_template,
        count(*) FILTER(WHERE unavailable_parent)::int AS unavailable_template,count(*) FILTER(WHERE wrong_owner)::int AS owner_mismatch
      FROM names LEFT JOIN checks c ON c.table_name=names.table_name GROUP BY names.table_name
) b;
  IF ready IS DISTINCT FROM true THEN RAISE EXCEPTION 'Shipping index reference baseline differs'; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(f)-'common' ORDER BY f.name COLLATE "C",f.args COLLATE "C"),'[]'::jsonb),
    COALESCE(bool_and(common),false) INTO observed_functions,functions_ok FROM (
SELECT p.proname AS "name",
    p.proargtypes::text AS "args",
    p.proargnames AS "argNames",
    p.prorettype::int AS "returns",
    l.lanname AS "language",
    p.provolatile AS "volatility",
    p.proisstrict AS "strict",
    p.prosrc AS "body",
    p.proconfig AS "config",
    p.prokind='f' AND NOT p.proretset AND NOT p.prosecdef AND NOT p.proleakproof
      AND p.proparallel='u' AND p.provariadic=0 AND p.prosupport=0 AND p.procost=100 AND p.prorows=0
      AND p.pronargdefaults=0 AND p.proallargtypes IS NULL AND p.proargmodes IS NULL
      AND p.proargdefaults IS NULL AND p.protrftypes IS NULL AND p.probin IS NULL AND p.prosqlbody IS NULL
      AND p.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
      AND ARRAY(SELECT a::text FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a ORDER BY a::text)
        =ARRAY(SELECT a::text FROM pg_catalog.aclexplode(pg_catalog.acldefault('f',p.proowner)) a ORDER BY a::text) AS "common"
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND starts_with(p.proname,'shipping_lifecycle_')
) f;
  SELECT COALESCE(jsonb_agg(to_jsonb(t)-'common' ORDER BY t."table" COLLATE "C",t.name COLLATE "C"),'[]'::jsonb),
    COALESCE(bool_and(common),false) INTO observed_triggers,triggers_ok FROM (
SELECT t.tgname AS "name",
    c.relname AS "table",
    n.nspname AS "schema",
    p.proname AS "function",
    t.tgtype AS "type",
    pn.nspname='public' AND p.pronargs=0 AND t.tgenabled='O' AND NOT t.tgisinternal
      AND t.tgparentid=0 AND t.tgconstrrelid=0 AND t.tgconstrindid=0 AND t.tgconstraint=0
      AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgnargs=0 AND t.tgattr::text=''
      AND octet_length(t.tgargs)=0 AND t.tgqual IS NULL AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
      AND c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS "common"
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
    WHERE (n.nspname='public' AND starts_with(t.tgname,'shipping_lifecycle_'))
      OR (pn.nspname='public' AND starts_with(p.proname,'shipping_lifecycle_'))
) t;
  IF observed_functions<>expected_functions OR observed_triggers<>expected_triggers OR NOT functions_ok OR NOT triggers_ok THEN
    RAISE EXCEPTION 'Shipping indexes require the complete exact lifecycle protocol';
  END IF;
  SELECT compatible INTO ready FROM (
SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_index i
 JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_class t ON t.oid=i.indrelid
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname='sdp_product_discount' AND c.relkind='i' AND c.relpersistence='p'
 AND c.relowner=t.relowner AND c.reloptions IS NULL AND c.reltablespace=0
 AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
 AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion AND NOT i.indisreplident AND NOT i.indnullsnotdistinct
 AND i.indnkeyatts=2 AND i.indnatts=2 AND i.indexprs IS NULL AND i.indpred IS NULL
 AND pg_catalog.pg_get_indexdef(i.indexrelid)='CREATE INDEX sdp_product_discount ON public.store_discounts_products USING btree (product_id, discount_id)'
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conindid=i.indexrelid)) AS compatible
) r;
  IF ready IS DISTINCT FROM true THEN RAISE EXCEPTION 'Shipping package source index requires review'; END IF;
  SELECT "originTriggersActive" AND "noEnabledEventTriggers" AND "noUnreviewedRelationTriggers" INTO ready
    FROM (SELECT
  pg_catalog.current_setting('session_replication_role') IN ('origin','local') AS "originTriggersActive",
  NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS "noEnabledEventTriggers",
  NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
    WHERE n.nspname='public' AND c.relname IN
      ('shipping_templates','store_product','store_seckill','store_bargain',
       'store_combination','store_integral','store_discounts_products')
      AND t.tgenabled<>'D'
      -- Reserved names/functions remain the exact protocol inspector's job.
      -- Do not waive internal RI triggers: CASCADE can remove/rebind retained
      -- references before the shipping AFTER trigger observes them.
      AND NOT pg_catalog.starts_with(t.tgname,'shipping_lifecycle_')
      AND NOT (pn.nspname='public' AND pg_catalog.starts_with(p.proname,'shipping_lifecycle_'))
  ) AS "noUnreviewedRelationTriggers") e;
  IF ready IS DISTINCT FROM true THEN RAISE EXCEPTION 'Shipping index installation environment requires review'; END IF;
  IF EXISTS(SELECT 1 FROM (
WITH wanted AS (SELECT * FROM jsonb_to_recordset($shipping_index_manifest$[{"table":"store_product","name":"sp_shipping_ref","ddl":"CREATE INDEX sp_shipping_ref ON public.store_product ((CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN(1,2) THEN 1 ELSE 0 END))","definition":"CREATE INDEX sp_shipping_ref ON public.store_product USING btree ((\nCASE\n    WHEN (temp_id > 0) THEN temp_id\n    WHEN (freight <> ALL (ARRAY[1, 2])) THEN 1\n    ELSE 0\nEND))"},{"table":"store_seckill","name":"sseckill_shipping_ref","ddl":"CREATE INDEX sseckill_shipping_ref ON public.store_seckill ((CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN(1,2) THEN 1 ELSE 0 END))","definition":"CREATE INDEX sseckill_shipping_ref ON public.store_seckill USING btree ((\nCASE\n    WHEN (temp_id > 0) THEN temp_id\n    WHEN (freight <> ALL (ARRAY[1, 2])) THEN 1\n    ELSE 0\nEND))"},{"table":"store_bargain","name":"sbarg_shipping_ref","ddl":"CREATE INDEX sbarg_shipping_ref ON public.store_bargain ((CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN(1,2) THEN 1 ELSE 0 END))","definition":"CREATE INDEX sbarg_shipping_ref ON public.store_bargain USING btree ((\nCASE\n    WHEN (temp_id > 0) THEN temp_id\n    WHEN (freight <> ALL (ARRAY[1, 2])) THEN 1\n    ELSE 0\nEND))"},{"table":"store_combination","name":"scomb_shipping_ref","ddl":"CREATE INDEX scomb_shipping_ref ON public.store_combination ((CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN(1,2) THEN 1 ELSE 0 END))","definition":"CREATE INDEX scomb_shipping_ref ON public.store_combination USING btree ((\nCASE\n    WHEN (temp_id > 0) THEN temp_id\n    WHEN (freight <> ALL (ARRAY[1, 2])) THEN 1\n    ELSE 0\nEND))"},{"table":"store_integral","name":"sint_shipping_ref","ddl":"CREATE INDEX sint_shipping_ref ON public.store_integral ((CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN(1,2) THEN 1 ELSE 0 END))","definition":"CREATE INDEX sint_shipping_ref ON public.store_integral USING btree ((\nCASE\n    WHEN (temp_id > 0) THEN temp_id\n    WHEN (freight <> ALL (ARRAY[1, 2])) THEN 1\n    ELSE 0\nEND))"},{"table":"store_discounts_products","name":"sdp_shipping_ref","ddl":"CREATE INDEX sdp_shipping_ref ON public.store_discounts_products ((CASE WHEN temp_id>0 THEN temp_id ELSE 0 END))","definition":"CREATE INDEX sdp_shipping_ref ON public.store_discounts_products USING btree ((\nCASE\n    WHEN (temp_id > 0) THEN temp_id\n    ELSE 0\nEND))"},{"table":"store_seckill","name":"sseckill_shipping_source","ddl":"CREATE INDEX sseckill_shipping_source ON public.store_seckill (product_id)","definition":"CREATE INDEX sseckill_shipping_source ON public.store_seckill USING btree (product_id)"},{"table":"store_bargain","name":"sbarg_shipping_source","ddl":"CREATE INDEX sbarg_shipping_source ON public.store_bargain (product_id)","definition":"CREATE INDEX sbarg_shipping_source ON public.store_bargain USING btree (product_id)"},{"table":"store_combination","name":"scomb_shipping_source","ddl":"CREATE INDEX scomb_shipping_source ON public.store_combination (product_id)","definition":"CREATE INDEX scomb_shipping_source ON public.store_combination USING btree (product_id)"},{"table":"store_integral","name":"sint_shipping_source","ddl":"CREATE INDEX sint_shipping_source ON public.store_integral (product_id)","definition":"CREATE INDEX sint_shipping_source ON public.store_integral USING btree (product_id)"}]$shipping_index_manifest$::jsonb)
  AS w(name text,"table" text,definition text,ddl text))
SELECT w.name,w."table",w.ddl,c.oid IS NOT NULL AS present,
  COALESCE(c.relkind='i' AND c.relpersistence='p' AND NOT c.relispartition AND c.relowner=t.relowner
    AND c.reloptions IS NULL AND c.reltablespace=0 AND i.indrelid=t.oid
    AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
    AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
    AND NOT i.indnullsnotdistinct AND NOT i.indisreplident
    AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indpred IS NULL
    AND pg_catalog.pg_get_indexdef(i.indexrelid)=w.definition
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conindid=i.indexrelid),false) AS compatible
FROM wanted w LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public'
LEFT JOIN pg_catalog.pg_class t ON t.relnamespace=n.oid AND t.relname=w."table"
LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=w.name
LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
) i WHERE present AND NOT compatible) THEN
    RAISE EXCEPTION 'Shipping lifecycle index definition drift';
  END IF;
  FOR item IN SELECT * FROM (
WITH wanted AS (SELECT * FROM jsonb_to_recordset($shipping_index_manifest$[{"table":"store_product","name":"sp_shipping_ref","ddl":"CREATE INDEX sp_shipping_ref ON public.store_product ((CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN(1,2) THEN 1 ELSE 0 END))","definition":"CREATE INDEX sp_shipping_ref ON public.store_product USING btree ((\nCASE\n    WHEN (temp_id > 0) THEN temp_id\n    WHEN (freight <> ALL (ARRAY[1, 2])) THEN 1\n    ELSE 0\nEND))"},{"table":"store_seckill","name":"sseckill_shipping_ref","ddl":"CREATE INDEX sseckill_shipping_ref ON public.store_seckill ((CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN(1,2) THEN 1 ELSE 0 END))","definition":"CREATE INDEX sseckill_shipping_ref ON public.store_seckill USING btree ((\nCASE\n    WHEN (temp_id > 0) THEN temp_id\n    WHEN (freight <> ALL (ARRAY[1, 2])) THEN 1\n    ELSE 0\nEND))"},{"table":"store_bargain","name":"sbarg_shipping_ref","ddl":"CREATE INDEX sbarg_shipping_ref ON public.store_bargain ((CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN(1,2) THEN 1 ELSE 0 END))","definition":"CREATE INDEX sbarg_shipping_ref ON public.store_bargain USING btree ((\nCASE\n    WHEN (temp_id > 0) THEN temp_id\n    WHEN (freight <> ALL (ARRAY[1, 2])) THEN 1\n    ELSE 0\nEND))"},{"table":"store_combination","name":"scomb_shipping_ref","ddl":"CREATE INDEX scomb_shipping_ref ON public.store_combination ((CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN(1,2) THEN 1 ELSE 0 END))","definition":"CREATE INDEX scomb_shipping_ref ON public.store_combination USING btree ((\nCASE\n    WHEN (temp_id > 0) THEN temp_id\n    WHEN (freight <> ALL (ARRAY[1, 2])) THEN 1\n    ELSE 0\nEND))"},{"table":"store_integral","name":"sint_shipping_ref","ddl":"CREATE INDEX sint_shipping_ref ON public.store_integral ((CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN(1,2) THEN 1 ELSE 0 END))","definition":"CREATE INDEX sint_shipping_ref ON public.store_integral USING btree ((\nCASE\n    WHEN (temp_id > 0) THEN temp_id\n    WHEN (freight <> ALL (ARRAY[1, 2])) THEN 1\n    ELSE 0\nEND))"},{"table":"store_discounts_products","name":"sdp_shipping_ref","ddl":"CREATE INDEX sdp_shipping_ref ON public.store_discounts_products ((CASE WHEN temp_id>0 THEN temp_id ELSE 0 END))","definition":"CREATE INDEX sdp_shipping_ref ON public.store_discounts_products USING btree ((\nCASE\n    WHEN (temp_id > 0) THEN temp_id\n    ELSE 0\nEND))"},{"table":"store_seckill","name":"sseckill_shipping_source","ddl":"CREATE INDEX sseckill_shipping_source ON public.store_seckill (product_id)","definition":"CREATE INDEX sseckill_shipping_source ON public.store_seckill USING btree (product_id)"},{"table":"store_bargain","name":"sbarg_shipping_source","ddl":"CREATE INDEX sbarg_shipping_source ON public.store_bargain (product_id)","definition":"CREATE INDEX sbarg_shipping_source ON public.store_bargain USING btree (product_id)"},{"table":"store_combination","name":"scomb_shipping_source","ddl":"CREATE INDEX scomb_shipping_source ON public.store_combination (product_id)","definition":"CREATE INDEX scomb_shipping_source ON public.store_combination USING btree (product_id)"},{"table":"store_integral","name":"sint_shipping_source","ddl":"CREATE INDEX sint_shipping_source ON public.store_integral (product_id)","definition":"CREATE INDEX sint_shipping_source ON public.store_integral USING btree (product_id)"}]$shipping_index_manifest$::jsonb)
  AS w(name text,"table" text,definition text,ddl text))
SELECT w.name,w."table",w.ddl,c.oid IS NOT NULL AS present,
  COALESCE(c.relkind='i' AND c.relpersistence='p' AND NOT c.relispartition AND c.relowner=t.relowner
    AND c.reloptions IS NULL AND c.reltablespace=0 AND i.indrelid=t.oid
    AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
    AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
    AND NOT i.indnullsnotdistinct AND NOT i.indisreplident
    AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indpred IS NULL
    AND pg_catalog.pg_get_indexdef(i.indexrelid)=w.definition
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conindid=i.indexrelid),false) AS compatible
FROM wanted w LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public'
LEFT JOIN pg_catalog.pg_class t ON t.relnamespace=n.oid AND t.relname=w."table"
LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=w.name
LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
) i WHERE NOT present ORDER BY name COLLATE "C" LOOP
    -- DDL is taken from the fixed embedded manifest, never observed catalog text.
    EXECUTE item.ddl;
  END LOOP;
  -- All creations and their final verification belong to this one transaction.
  SELECT count(*)=10 AND bool_and(compatible) INTO ready FROM (
WITH wanted AS (SELECT * FROM jsonb_to_recordset($shipping_index_manifest$[{"table":"store_product","name":"sp_shipping_ref","ddl":"CREATE INDEX sp_shipping_ref ON public.store_product ((CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN(1,2) THEN 1 ELSE 0 END))","definition":"CREATE INDEX sp_shipping_ref ON public.store_product USING btree ((\nCASE\n    WHEN (temp_id > 0) THEN temp_id\n    WHEN (freight <> ALL (ARRAY[1, 2])) THEN 1\n    ELSE 0\nEND))"},{"table":"store_seckill","name":"sseckill_shipping_ref","ddl":"CREATE INDEX sseckill_shipping_ref ON public.store_seckill ((CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN(1,2) THEN 1 ELSE 0 END))","definition":"CREATE INDEX sseckill_shipping_ref ON public.store_seckill USING btree ((\nCASE\n    WHEN (temp_id > 0) THEN temp_id\n    WHEN (freight <> ALL (ARRAY[1, 2])) THEN 1\n    ELSE 0\nEND))"},{"table":"store_bargain","name":"sbarg_shipping_ref","ddl":"CREATE INDEX sbarg_shipping_ref ON public.store_bargain ((CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN(1,2) THEN 1 ELSE 0 END))","definition":"CREATE INDEX sbarg_shipping_ref ON public.store_bargain USING btree ((\nCASE\n    WHEN (temp_id > 0) THEN temp_id\n    WHEN (freight <> ALL (ARRAY[1, 2])) THEN 1\n    ELSE 0\nEND))"},{"table":"store_combination","name":"scomb_shipping_ref","ddl":"CREATE INDEX scomb_shipping_ref ON public.store_combination ((CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN(1,2) THEN 1 ELSE 0 END))","definition":"CREATE INDEX scomb_shipping_ref ON public.store_combination USING btree ((\nCASE\n    WHEN (temp_id > 0) THEN temp_id\n    WHEN (freight <> ALL (ARRAY[1, 2])) THEN 1\n    ELSE 0\nEND))"},{"table":"store_integral","name":"sint_shipping_ref","ddl":"CREATE INDEX sint_shipping_ref ON public.store_integral ((CASE WHEN temp_id>0 THEN temp_id WHEN freight NOT IN(1,2) THEN 1 ELSE 0 END))","definition":"CREATE INDEX sint_shipping_ref ON public.store_integral USING btree ((\nCASE\n    WHEN (temp_id > 0) THEN temp_id\n    WHEN (freight <> ALL (ARRAY[1, 2])) THEN 1\n    ELSE 0\nEND))"},{"table":"store_discounts_products","name":"sdp_shipping_ref","ddl":"CREATE INDEX sdp_shipping_ref ON public.store_discounts_products ((CASE WHEN temp_id>0 THEN temp_id ELSE 0 END))","definition":"CREATE INDEX sdp_shipping_ref ON public.store_discounts_products USING btree ((\nCASE\n    WHEN (temp_id > 0) THEN temp_id\n    ELSE 0\nEND))"},{"table":"store_seckill","name":"sseckill_shipping_source","ddl":"CREATE INDEX sseckill_shipping_source ON public.store_seckill (product_id)","definition":"CREATE INDEX sseckill_shipping_source ON public.store_seckill USING btree (product_id)"},{"table":"store_bargain","name":"sbarg_shipping_source","ddl":"CREATE INDEX sbarg_shipping_source ON public.store_bargain (product_id)","definition":"CREATE INDEX sbarg_shipping_source ON public.store_bargain USING btree (product_id)"},{"table":"store_combination","name":"scomb_shipping_source","ddl":"CREATE INDEX scomb_shipping_source ON public.store_combination (product_id)","definition":"CREATE INDEX scomb_shipping_source ON public.store_combination USING btree (product_id)"},{"table":"store_integral","name":"sint_shipping_source","ddl":"CREATE INDEX sint_shipping_source ON public.store_integral (product_id)","definition":"CREATE INDEX sint_shipping_source ON public.store_integral USING btree (product_id)"}]$shipping_index_manifest$::jsonb)
  AS w(name text,"table" text,definition text,ddl text))
SELECT w.name,w."table",w.ddl,c.oid IS NOT NULL AS present,
  COALESCE(c.relkind='i' AND c.relpersistence='p' AND NOT c.relispartition AND c.relowner=t.relowner
    AND c.reloptions IS NULL AND c.reltablespace=0 AND i.indrelid=t.oid
    AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
    AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
    AND NOT i.indnullsnotdistinct AND NOT i.indisreplident
    AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indpred IS NULL
    AND pg_catalog.pg_get_indexdef(i.indexrelid)=w.definition
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conindid=i.indexrelid),false) AS compatible
FROM wanted w LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public'
LEFT JOIN pg_catalog.pg_class t ON t.relnamespace=n.oid AND t.relname=w."table"
LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=w.name
LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
) i;
  IF ready IS DISTINCT FROM true THEN RAISE EXCEPTION 'Shipping lifecycle indexes differ after installation'; END IF;
END
$shipping_indexes_0153$;
