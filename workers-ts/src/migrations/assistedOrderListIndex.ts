/** External 0165 / embedded 0171. Keep both forward-only entry points identical. */
export const ASSISTED_ORDER_LIST_INDEX_SQL = String.raw`-- Forward-only ordinary index for actor-scoped assisted-order list ordering.
-- Caller owns one bounded maintenance transaction; never replay bootstrap.
SET LOCAL search_path TO pg_catalog, public, pg_temp;
SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
  set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true),
  set_config('default_tablespace','',true);
DO $assisted_order_list_index$
DECLARE
  table_oid oid;
  index_oid oid;
  key_att smallint[];
  row_count integer;
BEGIN
  IF current_setting('server_version_num')::integer / 10000 <> 16
    OR current_setting('session_replication_role') <> 'origin'
    OR EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtenabled <> 'D') THEN
    RAISE EXCEPTION 'Assisted order list index environment requires review';
  END IF;
  table_oid := to_regclass('public.store_order');
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=table_oid AND c.relkind='r' AND c.relpersistence='p'
    AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND pg_has_role(current_user,c.relowner,'USAGE')
    AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid)) THEN
    RAISE EXCEPTION 'Assisted order list table/owner drift';
  END IF;
  LOCK TABLE ONLY public.store_order IN SHARE MODE NOWAIT;
  IF to_regclass('public.store_order') IS DISTINCT FROM table_oid THEN
    RAISE EXCEPTION 'Assisted order list table identity drift';
  END IF;
  SELECT array_agg(a.attnum ORDER BY k.pos) INTO key_att
  FROM (VALUES (1,'staff_id','integer'::regtype),(2,'is_channel','smallint'::regtype),
    (3,'is_system_del','smallint'::regtype),(4,'is_del','smallint'::regtype),
    (5,'add_time','integer'::regtype),(6,'id','integer'::regtype)) k(pos,name,datatype)
  JOIN pg_attribute a ON a.attrelid=table_oid AND a.attname=k.name AND a.atttypid=k.datatype
    AND a.atttypmod=-1 AND a.attnotnull AND NOT a.attisdropped
    AND a.attgenerated='' AND a.attidentity='' AND a.attcollation=0;
  IF cardinality(key_att) IS DISTINCT FROM 6 THEN
    RAISE EXCEPTION 'Assisted order list column drift';
  END IF;
  index_oid := to_regclass('public.so_assisted_actor_list');
  IF index_oid IS NULL THEN
    SELECT count(*) INTO row_count FROM (SELECT 1 FROM ONLY public.store_order LIMIT 100001) bounded;
    IF row_count>100000 THEN RAISE EXCEPTION 'Assisted order list index maintenance row budget exceeded'; END IF;
    CREATE INDEX so_assisted_actor_list ON public.store_order USING btree
      (staff_id,is_channel,is_system_del,is_del,add_time DESC,id DESC);
    index_oid := to_regclass('public.so_assisted_actor_list');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid
      JOIN pg_am am ON am.oid=c.relam JOIN pg_class t ON t.oid=i.indrelid
    WHERE c.oid=index_oid AND c.relkind='i' AND c.relpersistence='p' AND c.relowner=t.relowner
      AND c.reloptions IS NULL AND c.relacl IS NULL AND c.reltablespace=0 AND am.amname='btree'
      AND i.indrelid=table_oid AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
      AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion AND NOT i.indnullsnotdistinct
      AND NOT i.indisreplident AND NOT i.indisclustered AND i.indpred IS NULL AND i.indexprs IS NULL
      AND i.indnatts=6 AND i.indnkeyatts=6
      AND i.indkey[0]=key_att[1] AND i.indkey[1]=key_att[2] AND i.indkey[2]=key_att[3]
      AND i.indkey[3]=key_att[4] AND i.indkey[4]=key_att[5] AND i.indkey[5]=key_att[6]
      AND i.indoption[0]=0 AND i.indoption[1]=0 AND i.indoption[2]=0 AND i.indoption[3]=0
      AND i.indoption[4]=3 AND i.indoption[5]=3
      AND i.indcollation[0]=0 AND i.indcollation[1]=0 AND i.indcollation[2]=0
      AND i.indcollation[3]=0 AND i.indcollation[4]=0 AND i.indcollation[5]=0
      AND i.indclass[0]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='int4_ops' AND opcmethod=c.relam)
      AND i.indclass[1]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='int2_ops' AND opcmethod=c.relam)
      AND i.indclass[2]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='int2_ops' AND opcmethod=c.relam)
      AND i.indclass[3]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='int2_ops' AND opcmethod=c.relam)
      AND i.indclass[4]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='int4_ops' AND opcmethod=c.relam)
      AND i.indclass[5]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='int4_ops' AND opcmethod=c.relam)
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conindid=c.oid)
      AND pg_get_indexdef(c.oid)='CREATE INDEX so_assisted_actor_list ON public.store_order USING btree (staff_id, is_channel, is_system_del, is_del, add_time DESC, id DESC)'
  ) THEN RAISE EXCEPTION 'Assisted order list index drift'; END IF;
END
$assisted_order_list_index$;`;
