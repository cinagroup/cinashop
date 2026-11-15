-- Durable opt-in and one-post receipt for explicit buyer review synchronization.
-- No historical review is enrolled, no business rows or runtime grants change.
SET LOCAL search_path TO pg_catalog, public, pg_temp;
SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
  set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true);
DO $review_community_sync$
DECLARE target oid; present integer;
BEGIN
  IF current_setting('server_version_num')::integer/10000<>16
    OR current_setting('transaction_isolation')<>'read committed'
    OR current_setting('transaction_read_only')<>'off'
    OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Review community synchronization requires reviewed PG16 maintenance';
  END IF;
  IF NOT pg_try_advisory_xact_lock(741915,0) THEN RAISE EXCEPTION 'Review synchronization maintenance busy'; END IF;
  target:=to_regclass('public.store_product_reply');
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=target AND c.relkind='r' AND c.relpersistence='p'
    AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND pg_has_role(current_user,c.relowner,'USAGE')
    AND NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid)) THEN
    RAISE EXCEPTION 'Review synchronization table identity/owner drift';
  END IF;
  LOCK TABLE ONLY public.store_product_reply IN ACCESS EXCLUSIVE MODE NOWAIT;
  IF to_regclass('public.store_product_reply') IS DISTINCT FROM target THEN RAISE EXCEPTION 'Review synchronization table replaced'; END IF;
  SELECT count(*) INTO present FROM pg_attribute WHERE attrelid=target AND NOT attisdropped
    AND attname IN ('community_sync_requested','community_sync_digest','community_sync_post_id');
  IF present=0 THEN
    ALTER TABLE ONLY public.store_product_reply
      ADD COLUMN community_sync_requested smallint DEFAULT 0 NOT NULL,
      ADD COLUMN community_sync_digest varchar(64) DEFAULT '' NOT NULL,
      ADD COLUMN community_sync_post_id integer DEFAULT 0 NOT NULL;
  ELSIF present<>3 THEN RAISE EXCEPTION 'Partial review synchronization installation'; END IF;
  IF (SELECT count(*) FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=target AND a.attnotnull AND NOT a.attisdropped AND a.attidentity='' AND a.attgenerated=''
    AND ((a.attname='community_sync_requested' AND a.atttypid='smallint'::regtype AND a.atttypmod=-1 AND pg_get_expr(d.adbin,d.adrelid)='0')
      OR (a.attname='community_sync_digest' AND a.atttypid='varchar'::regtype AND a.atttypmod=68 AND pg_get_expr(d.adbin,d.adrelid) = quote_literal('') || '::character varying')
      OR (a.attname='community_sync_post_id' AND a.atttypid='integer'::regtype AND a.atttypmod=-1 AND pg_get_expr(d.adbin,d.adrelid)='0')) )<>3 THEN
    RAISE EXCEPTION 'Review synchronization column/default drift';
  END IF;
END
$review_community_sync$;
