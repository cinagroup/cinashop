import { INVOICE_HISTORY_V1_SQL, INVOICE_ALLOCATION_V2_SQL, INVOICE_HISTORY_CAPTURE_SQL, INVOICE_ALLOCATION_GUARD_SQL } from './invoiceEvidence';
import { INVOICE_EVIDENCE_STATE_SQL } from './invoiceEvidenceCatalog';

export const INVOICE_MAINTENANCE_SETUP_SQL = `SET LOCAL search_path=public,pg_temp;
SET LOCAL row_security=off;
SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),30000)::text||'ms',true),
  set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true);`;

function installation(completeEmptyOrm: boolean) {
  return `${INVOICE_MAINTENANCE_SETUP_SQL}
DO $invoice_install$
DECLARE initial_state text; final_state text;
BEGIN
  IF current_setting('server_version_num')::integer/10000<>16
    OR current_setting('transaction_isolation')<>'read committed'
    OR current_setting('transaction_read_only')<>'off'
    OR current_setting('search_path')<>'public, pg_temp' OR current_schema()<>'public'
    OR current_setting('row_security')<>'off'
    OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
    OR (SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout') NOT BETWEEN 1 AND 30000
    OR (SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout') NOT BETWEEN 1 AND 1000
    OR (SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout') NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'Invoice schema installation requires bounded public PG16 read-write READ COMMITTED';
  END IF;
  IF NOT pg_try_advisory_xact_lock(731611,0) THEN RAISE EXCEPTION 'Invoice installation already running'; END IF;
  SELECT state INTO initial_state FROM (${INVOICE_EVIDENCE_STATE_SQL}) c;
  IF initial_state='drift' OR (initial_state='orm-pending' AND NOT ${completeEmptyOrm}) THEN
    RAISE EXCEPTION 'Invoice catalog or ACL drift requires review or explicit empty ORM completion';
  END IF;
  LOCK TABLE public.store_order_invoice IN ACCESS EXCLUSIVE MODE NOWAIT;
  IF initial_state<>'fresh' THEN LOCK TABLE public.store_order_invoice_evidence IN ACCESS EXCLUSIVE MODE NOWAIT; END IF;
  IF initial_state IN ('v2','orm-pending') THEN LOCK TABLE public.store_order_invoice_allocation IN ACCESS EXCLUSIVE MODE NOWAIT; END IF;
  SELECT state INTO final_state FROM (${INVOICE_EVIDENCE_STATE_SQL}) c;
  IF initial_state IS DISTINCT FROM final_state THEN RAISE EXCEPTION 'Invoice catalog changed during locking'; END IF;
  IF initial_state='orm-pending' THEN
    IF EXISTS(SELECT 1 FROM public.store_order_invoice)
      OR EXISTS(SELECT 1 FROM public.store_order_invoice_evidence)
      OR EXISTS(SELECT 1 FROM public.store_order_invoice_allocation) THEN
      RAISE EXCEPTION 'Unprotected ORM invoice tables must be empty; no history repair is allowed';
    END IF;
${INVOICE_HISTORY_CAPTURE_SQL}
${INVOICE_ALLOCATION_GUARD_SQL}
  ELSE
    IF initial_state='fresh' THEN
${INVOICE_HISTORY_V1_SQL}
    END IF;
    IF initial_state<>'v2' THEN
${INVOICE_ALLOCATION_V2_SQL}
    END IF;
  END IF;
  SELECT state INTO final_state FROM (${INVOICE_EVIDENCE_STATE_SQL}) c;
  IF final_state IS DISTINCT FROM 'v2' OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Invoice catalog or ACL verification failed after installation';
  END IF;
END
$invoice_install$;
`;
}

/** External0157 / embedded0163. Structure only; no guessed runtime role/grants. */
export const INVOICE_EVIDENCE_INSTALLATION_SQL = installation(false);
/** Explicit fresh ORM follow-up only. Never used by a numbered upgrade. */
export const INVOICE_EVIDENCE_ORM_INSTALLATION_SQL = installation(true);
