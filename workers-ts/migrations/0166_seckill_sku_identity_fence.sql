-- Forward-only identity fence for active seckill SKU rows. Historical retired
-- rows and other activity types retain their existing identities and indexes.
-- The caller owns one bounded PostgreSQL 16 maintenance transaction.
SET LOCAL search_path TO pg_catalog, public, pg_temp;
SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
  set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true),
  set_config('default_tablespace','',true);
DO $seckill_sku_identity_fence$
DECLARE
  table_oid oid;
  index_oid oid;
  expected RECORD;
  key_att smallint[];
  row_count integer;
BEGIN
  IF current_setting('server_version_num')::integer / 10000 <> 16
    OR current_setting('session_replication_role') <> 'origin'
    OR EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtenabled <> 'D') THEN
    RAISE EXCEPTION 'Seckill SKU identity fence environment requires review';
  END IF;

  table_oid := to_regclass('public.store_product_attr_value');
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c WHERE c.oid=table_oid AND c.relkind='r' AND c.relpersistence='p'
      AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND pg_has_role(current_user,c.relowner,'USAGE')
      AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid)
  ) THEN RAISE EXCEPTION 'Seckill SKU identity table/owner drift'; END IF;
  LOCK TABLE ONLY public.store_product_attr_value IN SHARE MODE NOWAIT;
  IF to_regclass('public.store_product_attr_value') IS DISTINCT FROM table_oid THEN
    RAISE EXCEPTION 'Seckill SKU identity table drift';
  END IF;

  SELECT array_agg(a.attnum ORDER BY specification.position) INTO key_att
  FROM (VALUES
    (1,'product_id','integer'::regtype,-1),
    (2,'type','smallint'::regtype,-1),
    (3,'is_retired','smallint'::regtype,-1),
    (4,'suk','pg_catalog.varchar'::regtype,516),
    (5,'unique','pg_catalog.bpchar'::regtype,12)
  ) specification(position,name,datatype,typmod)
  JOIN pg_attribute a ON a.attrelid=table_oid AND a.attname=specification.name
    AND a.atttypid=specification.datatype AND a.atttypmod=specification.typmod
    AND a.attnotnull AND NOT a.attisdropped
    AND a.attgenerated='' AND a.attidentity='';
  IF cardinality(key_att) IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'Seckill SKU identity column drift';
  END IF;

  IF to_regclass('public.spav_seckill_active_suk_uq') IS NULL
    OR to_regclass('public.spav_seckill_active_unique_uq') IS NULL THEN
    SELECT count(*) INTO row_count FROM (
      SELECT 1 FROM ONLY public.store_product_attr_value
      WHERE type=1 AND is_retired=0 LIMIT 100001
    ) bounded;
    IF row_count>100000 THEN
      RAISE EXCEPTION 'Seckill SKU identity maintenance row budget exceeded';
    END IF;
    IF EXISTS (
      SELECT 1 FROM ONLY public.store_product_attr_value
      WHERE type=1 AND is_retired=0
      GROUP BY product_id,suk HAVING count(*)>1
    ) THEN RAISE EXCEPTION 'Duplicate active seckill SKU label requires review'; END IF;
    IF EXISTS (
      SELECT 1 FROM ONLY public.store_product_attr_value
      WHERE type=1 AND is_retired=0
      GROUP BY product_id,"unique" HAVING count(*)>1
    ) THEN RAISE EXCEPTION 'Duplicate active seckill SKU identifier requires review'; END IF;
    IF to_regclass('public.spav_seckill_active_suk_uq') IS NULL THEN
      CREATE UNIQUE INDEX spav_seckill_active_suk_uq
        ON public.store_product_attr_value USING btree (product_id,suk)
        WHERE type=1 AND is_retired=0;
    END IF;
    IF to_regclass('public.spav_seckill_active_unique_uq') IS NULL THEN
      CREATE UNIQUE INDEX spav_seckill_active_unique_uq
        ON public.store_product_attr_value USING btree (product_id,"unique")
        WHERE type=1 AND is_retired=0;
    END IF;
  END IF;

  FOR expected IN SELECT * FROM (VALUES
    ('spav_seckill_active_suk_uq'::text,key_att[4],
      (SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace
        AND opcname='text_ops' AND opcmethod=(SELECT oid FROM pg_am WHERE amname='btree')),
      'suk'::text),
    ('spav_seckill_active_unique_uq',key_att[5],
      (SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace
        AND opcname='bpchar_ops' AND opcmethod=(SELECT oid FROM pg_am WHERE amname='btree')),
      '"unique"')
  ) specification(index_name,second_att,second_opclass,second_key) LOOP
    index_oid := to_regclass(format('public.%I',expected.index_name));
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_index i ON i.indexrelid=c.oid
      JOIN pg_am am ON am.oid=c.relam
      JOIN pg_class t ON t.oid=i.indrelid
      JOIN pg_attribute second_column ON second_column.attrelid=table_oid
        AND second_column.attnum=expected.second_att
      WHERE c.oid=index_oid AND c.relkind='i' AND c.relpersistence='p'
        AND c.relowner=t.relowner AND c.reloptions IS NULL AND c.relacl IS NULL
        AND c.reltablespace=0 AND am.amname='btree' AND i.indrelid=table_oid
        AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
        AND i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
        AND NOT i.indnullsnotdistinct AND NOT i.indisreplident AND NOT i.indisclustered
        AND i.indpred IS NOT NULL AND i.indexprs IS NULL
        AND i.indnatts=2 AND i.indnkeyatts=2
        AND i.indkey[0]=key_att[1] AND i.indkey[1]=expected.second_att
        AND i.indoption[0]=0 AND i.indoption[1]=0
        AND i.indcollation[0]=0 AND i.indcollation[1]=second_column.attcollation
        AND i.indclass[0]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace
          AND opcname='int4_ops' AND opcmethod=c.relam)
        AND i.indclass[1]=expected.second_opclass
        AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conindid=c.oid)
        AND pg_get_indexdef(c.oid,1,true)='product_id'
        AND pg_get_indexdef(c.oid,2,true)=expected.second_key
        AND lower(replace(replace(replace(replace(
          pg_get_expr(i.indpred,i.indrelid,true),'(',''),')',''),' ',''),'"',''))
          ='type=1andis_retired=0'
    ) THEN RAISE EXCEPTION 'Seckill SKU identity index drift: %',expected.index_name; END IF;
  END LOOP;
END
$seckill_sku_identity_fence$;
