/** External 0162 / embedded 0168. Keep both forward-only entry points identical. */
export const SUPPLIER_REFUND_LOOKUP_INDEX_SQL = String.raw`-- Forward-only ordinary lookup indexes. No business rows, ACLs or historical DDL change.
-- Caller owns one maintenance transaction; existing databases must not replay bootstrap.
SET LOCAL search_path TO pg_catalog, public, pg_temp;
SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
  set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true),
  set_config('default_tablespace','',true);
DO $supplier_refund_lookup$
DECLARE
  target record;
  phase integer;
  table_oid oid;
  index_oid oid;
  link_att smallint;
  id_att smallint;
  row_count integer;
BEGIN
  IF current_setting('server_version_num')::integer / 10000 <> 16
    OR current_setting('session_replication_role') <> 'origin'
    OR EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtenabled <> 'D') THEN
    RAISE EXCEPTION 'Supplier refund lookup index environment requires review';
  END IF;
  FOR target IN SELECT * FROM (VALUES
    ('supplier_flowing_water','sfw_link_id_idx'), ('supplier_transactions','stx_link_id_idx')
  ) v(table_name,index_name) LOOP
    table_oid := to_regclass(format('public.%I',target.table_name));
    IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=table_oid AND c.relkind='r' AND c.relpersistence='p'
      AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND pg_has_role(current_user,c.relowner,'USAGE')
      AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid)) THEN
      RAISE EXCEPTION 'Supplier refund lookup table/owner drift: %',target.table_name;
    END IF;
    EXECUTE format('LOCK TABLE ONLY public.%I IN SHARE MODE NOWAIT',target.table_name);
    IF to_regclass(format('public.%I',target.table_name)) IS DISTINCT FROM table_oid THEN
      RAISE EXCEPTION 'Supplier refund lookup table identity drift: %',target.table_name;
    END IF;
  END LOOP;
  -- Validate BOTH targets before creating either; the second pass rechecks after DDL.
  FOR phase IN 1..2 LOOP
    FOR target IN SELECT * FROM (VALUES
      ('supplier_flowing_water','sfw_link_id_idx'), ('supplier_transactions','stx_link_id_idx')
    ) v(table_name,index_name) LOOP
      table_oid := to_regclass(format('public.%I',target.table_name));
      SELECT attnum INTO link_att FROM pg_attribute WHERE attrelid=table_oid AND attname='link_id'
        AND atttypid='varchar'::regtype AND atttypmod=54 AND attnotnull AND NOT attisdropped
        AND attgenerated='' AND attidentity='' AND attcollation='pg_catalog.default'::regcollation;
      SELECT attnum INTO id_att FROM pg_attribute WHERE attrelid=table_oid AND attname='id'
        AND atttypid='integer'::regtype AND atttypmod=-1 AND attnotnull AND NOT attisdropped
        AND attgenerated='' AND attidentity='' AND attcollation=0;
      IF link_att IS NULL OR id_att IS NULL THEN
        RAISE EXCEPTION 'Supplier refund lookup column drift: %',target.table_name;
      END IF;
      index_oid := to_regclass(format('public.%I',target.index_name));
      IF index_oid IS NULL THEN
        IF phase=1 THEN
          EXECUTE format('SELECT count(*) FROM (SELECT 1 FROM ONLY public.%I LIMIT 100001) bounded',target.table_name) INTO row_count;
          IF row_count>100000 THEN RAISE EXCEPTION 'Supplier refund lookup index maintenance row budget exceeded'; END IF;
          CONTINUE;
        END IF;
        EXECUTE format('CREATE INDEX %I ON public.%I USING btree (link_id,id)',target.index_name,target.table_name);
        index_oid := to_regclass(format('public.%I',target.index_name));
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid
          JOIN pg_am am ON am.oid=c.relam JOIN pg_class t ON t.oid=i.indrelid
        WHERE c.oid=index_oid AND c.relkind='i' AND c.relpersistence='p' AND c.relowner=t.relowner
          AND c.reloptions IS NULL AND c.relacl IS NULL AND c.reltablespace=0 AND am.amname='btree'
          AND i.indrelid=table_oid AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
          AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion AND NOT i.indnullsnotdistinct
          AND NOT i.indisreplident AND NOT i.indisclustered AND i.indpred IS NULL AND i.indexprs IS NULL
          AND i.indnatts=2 AND i.indnkeyatts=2 AND i.indkey[0]=link_att AND i.indkey[1]=id_att
          AND i.indoption[0]=0 AND i.indoption[1]=0
          AND i.indcollation[0]='pg_catalog.default'::regcollation AND i.indcollation[1]=0
          AND i.indclass[0]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='text_ops' AND opcmethod=c.relam)
          AND i.indclass[1]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='int4_ops' AND opcmethod=c.relam)
          AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conindid=c.oid)
          AND pg_get_indexdef(c.oid)=format('CREATE INDEX %I ON public.%I USING btree (link_id, id)',target.index_name,target.table_name)
      ) THEN RAISE EXCEPTION 'Supplier refund lookup index drift: %',target.index_name; END IF;
    END LOOP;
  END LOOP;
END
$supplier_refund_lookup$;
`;
