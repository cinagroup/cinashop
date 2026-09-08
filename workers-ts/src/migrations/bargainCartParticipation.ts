export const BARGAIN_CART_PARTICIPATION_SQL = String.raw`
-- A3f: durable cart-to-bargain participation binding; zero means unbound.
-- Existing databases must use the bounded standalone runner, not historical runAll().
-- No participant lookup, backfill, row rewrite, or historical seed replay.
DO $bargain_cart_participation$
DECLARE
  target_schema text := pg_catalog.current_schema();
  original_path text := pg_catalog.current_setting('search_path');
  table_oid oid;
  binding_column smallint;
  type_column smallint;
  constraint_ok boolean;
BEGIN
  IF target_schema IS NULL OR pg_catalog.left(target_schema,3)='pg_' OR target_schema='information_schema' THEN
    RAISE EXCEPTION '0149 expected application schema';
  END IF;
  PERFORM set_config('search_path','pg_catalog, pg_temp',true);
  PERFORM set_config('lock_timeout',
    LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms',true);
  IF EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtenabled <> 'D') THEN
    RAISE EXCEPTION '0149 enabled DDL event triggers require explicit review';
  END IF;
  SELECT c.oid INTO table_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=target_schema AND c.relname='store_cart'
      AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition;
  IF table_oid IS NULL THEN
    RAISE EXCEPTION '0149 expected permanent store_cart';
  END IF;
  EXECUTE format('LOCK TABLE ONLY %I.store_cart IN ACCESS EXCLUSIVE MODE',target_schema);
  IF table_oid <> to_regclass(format('%I.store_cart',target_schema))
    OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=table_oid AND relkind='r' AND relpersistence='p' AND NOT relispartition)
    OR EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid=table_oid OR inhparent=table_oid) THEN
    RAISE EXCEPTION '0149 changed or inherited table requires explicit review';
  END IF;
  SELECT attnum INTO type_column FROM pg_attribute
    WHERE attrelid=table_oid AND attname='type' AND NOT attisdropped AND attnum>0
      AND atttypid='smallint'::regtype AND atttypmod=-1 AND attcollation=0
      AND attnotnull AND attgenerated='' AND attidentity='';
  IF type_column IS NULL THEN
    RAISE EXCEPTION '0149 cart type column drift';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=table_oid AND attname='bargain_user_id' AND NOT attisdropped) THEN
    EXECUTE format('ALTER TABLE ONLY %I.store_cart ADD COLUMN bargain_user_id integer NOT NULL DEFAULT 0',target_schema);
  END IF;
  SELECT a.attnum INTO binding_column FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=table_oid AND a.attname='bargain_user_id' AND NOT a.attisdropped AND a.attnum>0
      AND a.atttypid='integer'::regtype AND a.atttypmod=-1 AND a.attcollation=0
      AND a.attnotnull AND a.attgenerated='' AND a.attidentity=''
      AND pg_get_expr(d.adbin,d.adrelid)='0';
  IF binding_column IS NULL THEN
    RAISE EXCEPTION '0149 bargain binding column drift';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=table_oid AND conname='sc_bargain_participation_ck') THEN
    EXECUTE format('ALTER TABLE ONLY %I.store_cart ADD CONSTRAINT sc_bargain_participation_ck CHECK (bargain_user_id >= 0 AND (type = 2 OR bargain_user_id = 0))',target_schema);
  END IF;
  SELECT contype='c' AND convalidated AND conislocal AND coninhcount=0 AND NOT connoinherit
    AND NOT condeferrable AND NOT condeferred AND conparentid=0
    AND conkey @> ARRAY[binding_column,type_column] AND cardinality(conkey)=2
    AND pg_get_expr(conbin,conrelid)='((bargain_user_id >= 0) AND ((type = 2) OR (bargain_user_id = 0)))'
    INTO constraint_ok FROM pg_constraint WHERE conrelid=table_oid AND conname='sc_bargain_participation_ck';
  IF constraint_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION '0149 bargain binding constraint drift';
  END IF;
  PERFORM set_config('search_path',original_path,true);
END
$bargain_cart_participation$;
`;
