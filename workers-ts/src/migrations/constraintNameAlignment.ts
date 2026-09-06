export const CONSTRAINT_NAME_ALIGNMENT_SQL = String.raw`
-- DB-009D2b3d: rename three reviewed owning constraints and their indexes together.
-- Transactional, no business DML or rebuild. Unknown/ambiguous states abort.
DO $constraint_name_alignment$
DECLARE
  target_schema text := current_schema();
  item record;
  table_oid oid;
  old_constraint oid;
  new_constraint oid;
  old_index oid;
  new_index oid;
  selected_constraint oid;
  selected_index oid;
  selected_name text;
  aligned boolean;
BEGIN
  IF target_schema IS NULL THEN RAISE EXCEPTION '0139 target schema is missing'; END IF;
  PERFORM set_config('lock_timeout', '2s', true);
  FOR item IN SELECT * FROM (VALUES
    ('data_migration_checkpoint', 'data_migration_checkpoint_run_id_table_name_pk', 'data_migration_checkpoint_pkey', 'p', ARRAY['run_id', 'table_name']::text[], 'PRIMARY KEY (run_id, table_name)'),
    ('kefu_visitor_session', 'kefu_visitor_session_token_hash_unique', 'kefu_visitor_session_token_hash_key', 'u', ARRAY['token_hash']::text[], 'UNIQUE (token_hash)'),
    ('kefu_visitor_session', 'kefu_visitor_session_visitor_uid_unique', 'kefu_visitor_session_visitor_uid_key', 'u', ARRAY['visitor_uid']::text[], 'UNIQUE (visitor_uid)')
  ) AS expected(table_name,old_name,target_name,constraint_type,column_names,constraint_definition)
  LOOP
    SELECT c.oid INTO table_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=target_schema AND c.relname=item.table_name AND c.relkind='r'
        AND c.relpersistence='p' AND NOT c.relispartition;
    IF table_oid IS NULL THEN RAISE EXCEPTION '0139 expected permanent ordinary table % is missing', item.table_name; END IF;
    -- RENAME CONSTRAINT uses ACCESS EXCLUSIVE; bound waiting, not total duration.
    EXECUTE format('LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE',target_schema,item.table_name);
    SELECT c.oid INTO old_constraint FROM pg_constraint c WHERE c.conrelid=table_oid AND c.conname=item.old_name;
    SELECT c.oid INTO new_constraint FROM pg_constraint c WHERE c.conrelid=table_oid AND c.conname=item.target_name;
    SELECT c.oid INTO old_index FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=target_schema AND c.relname=item.old_name;
    SELECT c.oid INTO new_index FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=target_schema AND c.relname=item.target_name;
    IF NOT ((old_constraint IS NOT NULL AND old_index IS NOT NULL AND new_constraint IS NULL AND new_index IS NULL)
      OR (new_constraint IS NOT NULL AND new_index IS NOT NULL AND old_constraint IS NULL AND old_index IS NULL)) THEN
      RAISE EXCEPTION '0139 ambiguous or missing constraint/index pair: %.%',item.table_name,item.target_name;
    END IF;
    selected_constraint := COALESCE(old_constraint,new_constraint);
    selected_index := COALESCE(old_index,new_index);
    selected_name := CASE WHEN old_constraint IS NULL THEN item.target_name ELSE item.old_name END;
    SELECT c.conindid=selected_index AND c.contype::text=item.constraint_type
      AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred
      AND c.connoinherit AND c.conislocal AND c.coninhcount=0 AND c.conparentid=0
      AND c.conbin IS NULL AND c.conexclop IS NULL
      AND pg_get_constraintdef(c.oid,false)=item.constraint_definition
      AND (SELECT array_agg(a.attname::text ORDER BY k.ordinal)
        FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ordinal)
        JOIN pg_attribute a ON a.attrelid=table_oid AND a.attnum=k.attnum)=item.column_names
      AND x.relkind='i' AND x.relpersistence='p' AND NOT x.relispartition
      AND i.indrelid=table_oid AND i.indisunique AND i.indisprimary=(item.constraint_type='p')
      AND NOT i.indisexclusion AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
      AND NOT i.indnullsnotdistinct AND NOT i.indisreplident
      AND i.indnkeyatts=cardinality(item.column_names) AND i.indnatts=i.indnkeyatts
      AND i.indexprs IS NULL AND i.indpred IS NULL
      AND pg_get_indexdef(i.indexrelid)=format('CREATE UNIQUE INDEX %I ON %I.%I USING btree (%s)',
        selected_name,target_schema,item.table_name,
        (SELECT string_agg(quote_ident(column_name),', ' ORDER BY ordinal)
          FROM unnest(item.column_names) WITH ORDINALITY columns(column_name,ordinal)))
      AND (SELECT count(*) FROM pg_constraint owner WHERE owner.conindid=selected_index AND owner.contype IN ('p','u','x'))=1
      INTO aligned FROM pg_constraint c JOIN pg_index i ON i.indexrelid=c.conindid
      JOIN pg_class x ON x.oid=i.indexrelid WHERE c.oid=selected_constraint;
    IF aligned IS DISTINCT FROM true THEN RAISE EXCEPTION '0139 constraint/index definition drift: %.%',item.table_name,selected_name; END IF;
    IF old_constraint IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.%I RENAME CONSTRAINT %I TO %I',target_schema,item.table_name,item.old_name,item.target_name);
      SELECT c.oid INTO new_constraint FROM pg_constraint c WHERE c.conrelid=table_oid AND c.conname=item.target_name;
      SELECT c.oid INTO new_index FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=target_schema AND c.relname=item.target_name;
      IF new_constraint IS DISTINCT FROM old_constraint OR new_index IS DISTINCT FROM old_index
        OR (SELECT conindid FROM pg_constraint WHERE oid=new_constraint) IS DISTINCT FROM old_index
        OR pg_get_constraintdef(new_constraint,false) IS DISTINCT FROM item.constraint_definition THEN
        RAISE EXCEPTION '0139 renamed constraint/index identity changed: %.%',item.table_name,item.target_name;
      END IF;
    END IF;
  END LOOP;
END
$constraint_name_alignment$;
`;
