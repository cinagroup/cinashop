import { SHIPPING_TEMPLATE_CREATE_REPLAY_SQL } from './shippingTemplateCreateReplay';
import { SHIPPING_CREATE_REPLAY_COMPATIBILITY_SQL } from './shippingTemplateCreateReplayCatalog';

/** External 0154 and embedded 0160 use this exact SQL. Public only; caller owns
 * the transaction. No data backfill, privilege repair, replacement or startup hook.
 */
export const SHIPPING_CREATE_REPLAY_INSTALLATION_SQL = `
SET LOCAL search_path=public,pg_temp;
SET LOCAL row_security=off;
SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),30000)::text || 'ms',true),
  set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true);
DO $stcr_install$
DECLARE state record;
BEGIN
  IF current_setting('server_version_num')::integer / 10000 <> 16
    OR current_setting('transaction_isolation') <> 'read committed' OR current_setting('transaction_read_only') <> 'off'
    OR current_schema() <> 'public' OR current_setting('search_path') <> 'public, pg_temp'
    OR current_setting('row_security') <> 'off' THEN
    RAISE EXCEPTION 'Shipping replay installation requires public PG16 read-write READ COMMITTED';
  END IF;
  IF current_setting('session_replication_role') <> 'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled <> 'D') THEN
    RAISE EXCEPTION 'Shipping replay installation environment requires review';
  END IF;
  IF NOT pg_try_advisory_xact_lock(731606,0) THEN RAISE EXCEPTION 'Shipping replay installation already running'; END IF;
  SELECT * INTO state FROM (${SHIPPING_CREATE_REPLAY_COMPATIBILITY_SQL}) c;
  IF state.present THEN
    IF state.compatible IS DISTINCT FROM true THEN RAISE EXCEPTION 'Shipping replay catalog or ACL drift'; END IF;
    LOCK TABLE public.shipping_template_create_replay IN ACCESS EXCLUSIVE MODE NOWAIT;
  ELSE
${SHIPPING_TEMPLATE_CREATE_REPLAY_SQL}
  END IF;
  -- Recheck under the relation lock (or our own newly-created relation lock).
  SELECT * INTO state FROM (${SHIPPING_CREATE_REPLAY_COMPATIBILITY_SQL}) c;
  IF state.compatible IS DISTINCT FROM true THEN RAISE EXCEPTION 'Shipping replay catalog or ACL drift after lock/create'; END IF;
  IF current_setting('session_replication_role') <> 'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled <> 'D') THEN
    RAISE EXCEPTION 'Shipping replay installation environment changed';
  END IF;
END
$stcr_install$;
`;
