/** Exact bundled copy of migrations/0167_member_barcode_index.sql. */
export const MEMBER_BARCODE_INDEX_SQL = String.raw`-- Forward-only member barcode identity fence. A retired user keeps the old code.
-- Run in one bounded PostgreSQL 16 maintenance transaction after a read-only
-- duplicate preflight; this file never rewrites user rows.
SET LOCAL search_path TO pg_catalog, public, pg_temp;
SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
  set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true),
  set_config('default_tablespace','',true);
DO $member_barcode_index$
DECLARE
  table_oid oid;
  index_oid oid;
  barcode_att smallint;
  row_count integer;
BEGIN
  IF current_setting('server_version_num')::integer / 10000 <> 16
    OR current_setting('session_replication_role') <> 'origin'
    OR EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtenabled <> 'D') THEN
    RAISE EXCEPTION 'Member barcode index environment requires review';
  END IF;
  table_oid := to_regclass('public."user"');
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c WHERE c.oid=table_oid AND c.relkind='r' AND c.relpersistence='p'
      AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND pg_has_role(current_user,c.relowner,'USAGE')
      AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid)
  ) THEN RAISE EXCEPTION 'Member barcode table/owner drift'; END IF;
  LOCK TABLE ONLY public."user" IN SHARE MODE NOWAIT;
  IF to_regclass('public."user"') IS DISTINCT FROM table_oid THEN
    RAISE EXCEPTION 'Member barcode table identity drift';
  END IF;
  SELECT a.attnum INTO barcode_att FROM pg_attribute a
    WHERE a.attrelid=table_oid AND a.attname='bar_code'
      AND a.atttypid='pg_catalog.varchar'::regtype AND a.atttypmod=36
      AND a.attnotnull AND NOT a.attisdropped AND a.attgenerated='' AND a.attidentity='';
  IF barcode_att IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_attribute a WHERE a.attrelid=table_oid AND a.attname='uid'
      AND a.atttypid='integer'::regtype AND a.attnotnull AND NOT a.attisdropped
  ) THEN RAISE EXCEPTION 'Member barcode column drift'; END IF;
  index_oid := to_regclass('public.user_bar_code_uq');
  IF index_oid IS NULL THEN
    SELECT count(*) INTO row_count FROM (
      SELECT 1 FROM ONLY public."user" WHERE bar_code <> '' LIMIT 100001
    ) bounded;
    IF row_count > 100000 THEN RAISE EXCEPTION 'Member barcode maintenance row budget exceeded'; END IF;
    IF EXISTS (
      SELECT 1 FROM ONLY public."user" WHERE bar_code <> ''
      GROUP BY bar_code HAVING count(*) > 1
    ) THEN RAISE EXCEPTION 'Duplicate member barcode requires review'; END IF;
    CREATE UNIQUE INDEX user_bar_code_uq ON public."user" USING btree (bar_code)
      WHERE bar_code <> '';
    index_oid := to_regclass('public.user_bar_code_uq');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid
      JOIN pg_am am ON am.oid=c.relam JOIN pg_class t ON t.oid=i.indrelid
      JOIN pg_attribute a ON a.attrelid=table_oid AND a.attnum=barcode_att
    WHERE c.oid=index_oid AND c.relkind='i' AND c.relpersistence='p'
      AND c.relowner=t.relowner AND c.reloptions IS NULL AND c.relacl IS NULL
      AND c.reltablespace=0 AND am.amname='btree' AND i.indrelid=table_oid
      AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
      AND i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
      AND NOT i.indnullsnotdistinct AND NOT i.indisreplident AND NOT i.indisclustered
      AND i.indpred IS NOT NULL AND i.indexprs IS NULL
      AND i.indnatts=1 AND i.indnkeyatts=1 AND i.indkey[0]=barcode_att
      AND i.indoption[0]=0 AND i.indcollation[0]=a.attcollation
      AND i.indclass[0]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace
        AND opcname='text_ops' AND opcmethod=c.relam)
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conindid=c.oid)
      AND pg_get_indexdef(c.oid,1,true)='bar_code'
      AND lower(replace(regexp_replace(pg_get_expr(i.indpred,i.indrelid,true),'[()[:space:]]','','g'),'"',''))
        = 'bar_code::text<>''''::text'
  ) THEN RAISE EXCEPTION 'Member barcode index drift'; END IF;
END
$member_barcode_index$;`;
