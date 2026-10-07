/** Independently installed, append-only receipt. It is deliberately outside
 * MigrationService.runAll and the fixed external/ORM schema cohorts. */
export const NEWCOMER_CART_ADD_REPLAY_SQL = `
CREATE TABLE public.newcomer_cart_add_replay (
  uid INTEGER NOT NULL,
  request_key VARCHAR(36) NOT NULL,
  intent_hash VARCHAR(64) NOT NULL,
  cart_id INTEGER NOT NULL,
  base_unique VARCHAR(16) NOT NULL,
  created_at INTEGER NOT NULL,
  CONSTRAINT ncar_pk PRIMARY KEY (uid, request_key),
  CONSTRAINT ncar_identity_ck CHECK (uid > 0 AND cart_id > 0 AND created_at >= 0
    AND request_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND intent_hash ~ '^[0-9a-f]{64}$' AND base_unique <> '')
);
CREATE UNIQUE INDEX ncar_cart_uq ON public.newcomer_cart_add_replay(cart_id);
REVOKE ALL ON public.newcomer_cart_add_replay FROM PUBLIC;
`;

/** Owner-only, fresh-table forward. Granting the selected restricted app role
 * is a separate statement in the same root transaction. Never auto-install
 * this from a request or Worker startup. */
export const NEWCOMER_CART_ADD_REPLAY_INSTALLATION_SQL = `
SET LOCAL search_path TO public, pg_temp;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SET LOCAL idle_in_transaction_session_timeout = '5s';
DO $newcomer_cart_replay_install$
BEGIN
  IF current_setting('server_version_num')::integer / 10000 <> 16 OR
     current_setting('transaction_isolation') <> 'read committed' OR
     current_setting('transaction_read_only') <> 'off' OR
     current_setting('session_replication_role') <> 'origin' OR
     to_regclass('public.store_cart') IS NULL OR
     to_regclass('public.newcomer_cart_add_replay') IS NOT NULL OR
     to_regclass('public.ncar_cart_uq') IS NOT NULL OR
     EXISTS (SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled <> 'D') THEN
    RAISE EXCEPTION 'Newcomer cart replay requires a fresh PG16 owner transaction';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(1313030497, 0) THEN
    RAISE EXCEPTION 'Newcomer cart replay installation already running';
  END IF;
END $newcomer_cart_replay_install$;
${NEWCOMER_CART_ADD_REPLAY_SQL}`;
