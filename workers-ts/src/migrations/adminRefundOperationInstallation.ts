import { ADMIN_REFUND_OPERATION_SQL } from './adminRefundOperation';
import { ADMIN_REFUND_OPERATION_COMPATIBILITY_SQL } from './adminRefundOperationCatalog';

/** External0155/embedded0161. Explicit owner transaction, no startup hook,
 * backfill, privilege repair or replacement of a preexisting receipt table. */
export const ADMIN_REFUND_OPERATION_INSTALLATION_SQL = `
SET LOCAL search_path=public,pg_temp;
SET LOCAL row_security=off;
SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),30000)::text || 'ms',true),
  set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true);
DO $aro_install$
DECLARE state record;
BEGIN
  IF current_setting('server_version_num')::integer / 10000 <> 16
    OR current_setting('transaction_isolation') <> 'read committed' OR current_setting('transaction_read_only') <> 'off'
    OR current_schema() <> 'public' OR current_setting('search_path') <> 'public, pg_temp'
    OR current_setting('row_security') <> 'off' THEN
    RAISE EXCEPTION 'Admin refund receipt installation requires public PG16 read-write READ COMMITTED';
  END IF;
  IF current_setting('session_replication_role') <> 'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled <> 'D') THEN
    RAISE EXCEPTION 'Admin refund receipt installation environment requires review';
  END IF;
  IF NOT pg_try_advisory_xact_lock(731608,0) THEN RAISE EXCEPTION 'Admin refund receipt installation already running'; END IF;
  SELECT * INTO state FROM (${ADMIN_REFUND_OPERATION_COMPATIBILITY_SQL}) c;
  IF state.present THEN
    IF state.compatible IS DISTINCT FROM true THEN RAISE EXCEPTION 'Admin refund receipt catalog or ACL drift'; END IF;
    LOCK TABLE public.admin_refund_operation IN ACCESS EXCLUSIVE MODE NOWAIT;
  ELSE
${ADMIN_REFUND_OPERATION_SQL}
  END IF;
  SELECT * INTO state FROM (${ADMIN_REFUND_OPERATION_COMPATIBILITY_SQL}) c;
  IF state.compatible IS DISTINCT FROM true THEN RAISE EXCEPTION 'Admin refund receipt catalog or ACL drift after lock/create'; END IF;
  IF current_setting('session_replication_role') <> 'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled <> 'D') THEN
    RAISE EXCEPTION 'Admin refund receipt installation environment changed';
  END IF;
END
$aro_install$;
`;
