import { INVOICE_MAINTENANCE_SETUP_SQL } from './invoiceEvidenceInstallation';
import { OFFLINE_STATE_SQL, OFFLINE_DEPENDENCIES, OFFLINE_TABLES } from './offlineOrderCatalog';
import { OFFLINE_ORDER_ADMISSION_SQL, OFFLINE_ORDER_ADMISSION_GUARD_SQL } from './offlineOrderAdmission';
import { OFFLINE_ORDER_PAYMENT_SELECTION_SQL, OFFLINE_ORDER_PAYMENT_SELECTION_GUARD_SQL } from './offlineOrderPaymentSelection';
import { OFFLINE_ORDER_BALANCE_SQL, OFFLINE_ORDER_BALANCE_GUARD_SQL } from './offlineOrderBalance';
import { OFFLINE_ORDER_EXTERNAL_PAYMENT_SQL, OFFLINE_ORDER_EXTERNAL_PAYMENT_GUARD_SQL } from './offlineOrderExternalPayment';
import { OFFLINE_ORDER_CALLBACK_DOMAIN_SQL } from './offlineOrderCallbackDomain';
import { OFFLINE_ORDER_PAYMENT_DISPATCH_SQL, OFFLINE_ORDER_PAYMENT_DISPATCH_GUARD_SQL } from './offlineOrderPaymentDispatch';

/** No automatic business-path installation. Exact fresh or complete candidate,
 * plus explicitly requested empty ORM completion only; no data backfill,
 * partial-candidate repair or broad permission repair. */
function installation(completeEmptyOrm: boolean) {
  return `${INVOICE_MAINTENANCE_SETUP_SQL}
DO $offline_install$
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
    RAISE EXCEPTION 'Offline installation requires bounded public PG16 read-write READ COMMITTED';
  END IF;
  IF NOT pg_try_advisory_xact_lock(731611,0) THEN RAISE EXCEPTION 'Evidence installation already running'; END IF;
  SELECT state INTO initial_state FROM (${OFFLINE_STATE_SQL}) c;
  IF initial_state='drift' OR (initial_state='orm-pending' AND NOT ${completeEmptyOrm}) THEN
    RAISE EXCEPTION 'Offline catalog or ACL drift requires review or explicit empty ORM completion';
  END IF;
  ${OFFLINE_DEPENDENCIES.map(name => `LOCK TABLE public."${name}" IN ACCESS EXCLUSIVE MODE NOWAIT;`).join('\n  ')}
  IF initial_state<>'fresh' THEN
    ${OFFLINE_TABLES.map(name => `LOCK TABLE public.${name} IN ACCESS EXCLUSIVE MODE NOWAIT;`).join('\n    ')}
  END IF;
  SELECT state INTO final_state FROM (${OFFLINE_STATE_SQL}) c;
  IF initial_state IS DISTINCT FROM final_state THEN RAISE EXCEPTION 'Offline catalog changed during locking'; END IF;
  IF initial_state='orm-pending' THEN
    IF ${OFFLINE_TABLES.map(name => `EXISTS(SELECT 1 FROM public.${name})`).join(' OR ')} THEN
      RAISE EXCEPTION 'Unprotected offline ORM ledgers must all be empty; no evidence repair is allowed';
    END IF;
    ${[OFFLINE_ORDER_ADMISSION_GUARD_SQL, OFFLINE_ORDER_PAYMENT_SELECTION_GUARD_SQL, OFFLINE_ORDER_BALANCE_GUARD_SQL,
      OFFLINE_ORDER_EXTERNAL_PAYMENT_GUARD_SQL, OFFLINE_ORDER_PAYMENT_DISPATCH_GUARD_SQL].join('\n')}
  ELSIF initial_state='fresh' THEN
${[OFFLINE_ORDER_ADMISSION_SQL, OFFLINE_ORDER_PAYMENT_SELECTION_SQL, OFFLINE_ORDER_BALANCE_SQL,
      OFFLINE_ORDER_EXTERNAL_PAYMENT_SQL, OFFLINE_ORDER_CALLBACK_DOMAIN_SQL, OFFLINE_ORDER_PAYMENT_DISPATCH_SQL].join('\n')}
  END IF;
  SELECT state INTO final_state FROM (${OFFLINE_STATE_SQL}) c;
  IF final_state IS DISTINCT FROM 'v1' OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Offline installation catalog or ACL verification failed';
  END IF;
END
$offline_install$;`;
}

export const OFFLINE_INSTALLATION_SQL = installation(false);
export const OFFLINE_ORM_INSTALLATION_SQL = installation(true);
