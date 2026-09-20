import { INVOICE_MAINTENANCE_SETUP_SQL } from './invoiceEvidenceInstallation';
import { INVOICE_EVIDENCE_STATE_SQL } from './invoiceEvidenceCatalog';
import { REFUND_SPLIT_STATE_SQL } from './refundOrderSplitCatalog';
import { REFUND_ORDER_SPLIT_TABLE_SQL, REFUND_ORDER_SPLIT_GUARD_SQL } from './refundOrderSplit';

function installation(completeEmptyOrm: boolean) {
  return `${INVOICE_MAINTENANCE_SETUP_SQL}
DO $refund_split_install$
DECLARE initial_state text; final_state text; invoice_state text;
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
    RAISE EXCEPTION 'Refund split installation requires bounded public PG16 read-write READ COMMITTED';
  END IF;
  -- Same installation lock and invoice-table order as the dependency installer.
  IF NOT pg_try_advisory_xact_lock(731611,0) THEN RAISE EXCEPTION 'Evidence installation already running'; END IF;
  SELECT state INTO invoice_state FROM (${INVOICE_EVIDENCE_STATE_SQL}) c;
  IF invoice_state IS DISTINCT FROM 'v2' THEN RAISE EXCEPTION 'Complete invoice protection is required before refund split installation'; END IF;
  SELECT state INTO initial_state FROM (${REFUND_SPLIT_STATE_SQL}) c;
  IF initial_state='drift' OR (initial_state='orm-pending' AND NOT ${completeEmptyOrm}) THEN
    RAISE EXCEPTION 'Refund split catalog or ACL drift requires review or explicit empty ORM completion';
  END IF;
  LOCK TABLE public.store_order_invoice IN ACCESS EXCLUSIVE MODE NOWAIT;
  LOCK TABLE public.store_order_invoice_evidence IN ACCESS EXCLUSIVE MODE NOWAIT;
  LOCK TABLE public.store_order_invoice_allocation IN ACCESS EXCLUSIVE MODE NOWAIT;
  IF initial_state<>'fresh' THEN
    LOCK TABLE public.store_order_refund_split IN ACCESS EXCLUSIVE MODE NOWAIT;
    LOCK TABLE public.store_order_fulfillment_branch IN ACCESS EXCLUSIVE MODE NOWAIT;
  END IF;
  SELECT state INTO invoice_state FROM (${INVOICE_EVIDENCE_STATE_SQL}) c;
  SELECT state INTO final_state FROM (${REFUND_SPLIT_STATE_SQL}) c;
  IF invoice_state IS DISTINCT FROM 'v2' OR initial_state IS DISTINCT FROM final_state THEN
    RAISE EXCEPTION 'Evidence catalog changed during locking';
  END IF;
  IF initial_state='orm-pending' THEN
    IF EXISTS(SELECT 1 FROM public.store_order_refund_split) OR EXISTS(SELECT 1 FROM public.store_order_fulfillment_branch) THEN
      RAISE EXCEPTION 'Unprotected ORM refund ledgers must be empty; no evidence repair is allowed';
    END IF;
  ELSIF initial_state='fresh' THEN
${REFUND_ORDER_SPLIT_TABLE_SQL}
  END IF;
  IF initial_state<>'v1' THEN
${REFUND_ORDER_SPLIT_GUARD_SQL}
  END IF;
  SELECT state INTO final_state FROM (${REFUND_SPLIT_STATE_SQL}) c;
  SELECT state INTO invoice_state FROM (${INVOICE_EVIDENCE_STATE_SQL}) c;
  IF final_state IS DISTINCT FROM 'v1' OR invoice_state IS DISTINCT FROM 'v2'
    OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Evidence catalog or ACL verification failed after refund split installation';
  END IF;
END
$refund_split_install$;
`;
}

/** Structure only. No runtime grants, history synthesis or public v2 activation. */
export const REFUND_SPLIT_INSTALLATION_SQL = installation(false);
export const REFUND_SPLIT_ORM_INSTALLATION_SQL = installation(true);
