export const REPOSITORY_COLUMN_WIDTH_ALIGNMENT_SQL = String.raw`-- DB-009: align the external installation path with the existing Worker/ORM widths.
-- Caller owns the transaction. Only known narrow/target varchar shapes are accepted.
DO $repository_column_width_alignment$
DECLARE
  target_schema text := current_schema();
  expected record;
  observed record;
BEGIN
  IF target_schema IS NULL THEN RAISE EXCEPTION 'Repository width alignment has no target schema'; END IF;
  PERFORM set_config('lock_timeout', '2s', true);
  FOR expected IN SELECT * FROM (VALUES
    ('user','add_ip',16,45),
    ('user','last_ip',16,45),
    ('store_order','user_ip',16,45),
    ('store_product_category','pic',128,512)
  ) AS columns_to_align(table_name,column_name,legacy_length,target_length)
  LOOP
    SELECT a.atttypid, a.atttypmod, a.attnotnull, c.relkind, c.relpersistence INTO observed
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=target_schema AND c.relname=expected.table_name
      AND a.attname=expected.column_name AND a.attnum>0 AND NOT a.attisdropped;
    IF NOT FOUND OR observed.atttypid<>'pg_catalog.varchar'::regtype
      OR observed.atttypmod NOT IN (expected.legacy_length+4,expected.target_length+4)
      OR NOT observed.attnotnull OR observed.relkind<>'r' OR observed.relpersistence<>'p' THEN
      RAISE EXCEPTION 'Repository width alignment refuses unknown shape %.%',expected.table_name,expected.column_name;
    END IF;
    IF observed.atttypmod<>expected.target_length+4 THEN
      EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I TYPE varchar(%s)',
        target_schema,expected.table_name,expected.column_name,expected.target_length);
    END IF;
  END LOOP;
END
$repository_column_width_alignment$;
`;
