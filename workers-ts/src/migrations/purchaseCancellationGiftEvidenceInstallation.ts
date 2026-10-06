import { PURCHASE_CANCELLATION_SETUP_SQL, PURCHASE_CANCELLATION_SOURCE_SQL }
  from './purchaseCancellationEvidenceInstallation';
import { PURCHASE_CANCELLATION_GIFT_VALIDATE_SQL } from './purchaseCancellationGiftEvidence';
import { PURCHASE_CANCELLATION_GIFT_STATE_SQL } from './purchaseCancellationGiftEvidenceCatalog';

/** Explicit 0177 forward. Only an exact 0164 installation can be advanced;
 * the transaction locks the cancellation source before replacing one function.
 * No receipt, trigger, table, prior SQL artifact or historical row is touched. */
export const PURCHASE_CANCELLATION_GIFT_INSTALLATION_SQL = `${PURCHASE_CANCELLATION_SETUP_SQL}
DO $purchase_cancellation_gift_forward$
DECLARE initial_state text; final_state text; sources_ready boolean;
BEGIN
  IF current_setting('server_version_num')::integer/10000<>16
    OR current_setting('transaction_isolation')<>'read committed'
    OR current_setting('transaction_read_only')<>'off'
    OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Purchase cancellation gift forward requires reviewed PG16 read-write READ COMMITTED';
  END IF;
  IF NOT pg_try_advisory_xact_lock(731611,0) THEN
    RAISE EXCEPTION 'Purchase evidence maintenance already running';
  END IF;
  SELECT state INTO initial_state FROM (${PURCHASE_CANCELLATION_GIFT_STATE_SQL}) s;
  SELECT ready INTO sources_ready FROM (${PURCHASE_CANCELLATION_SOURCE_SQL}) s;
  IF initial_state NOT IN ('v1','gift-v1') OR NOT sources_ready THEN
    RAISE EXCEPTION 'Purchase cancellation gift forward requires exact prior evidence and sources';
  END IF;
  LOCK TABLE ONLY public.store_order IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  LOCK TABLE ONLY public.store_order_cart_info IN SHARE MODE NOWAIT;
  LOCK TABLE ONLY public.store_order_purchase_origin IN SHARE MODE NOWAIT;
  LOCK TABLE ONLY public.store_order_status IN SHARE MODE NOWAIT;
  LOCK TABLE ONLY public.user_bill IN SHARE MODE NOWAIT;
  LOCK TABLE ONLY public.store_order_purchase_cancellation IN ACCESS EXCLUSIVE MODE NOWAIT;
  SELECT state INTO final_state FROM (${PURCHASE_CANCELLATION_GIFT_STATE_SQL}) s;
  SELECT ready INTO sources_ready FROM (${PURCHASE_CANCELLATION_SOURCE_SQL}) s;
  IF final_state IS DISTINCT FROM initial_state OR NOT sources_ready THEN
    RAISE EXCEPTION 'Purchase cancellation gift catalog changed during locking';
  END IF;
  IF initial_state='v1' THEN
    EXECUTE $gift_validate$${PURCHASE_CANCELLATION_GIFT_VALIDATE_SQL}$gift_validate$;
  END IF;
  SELECT state INTO final_state FROM (${PURCHASE_CANCELLATION_GIFT_STATE_SQL}) s;
  SELECT ready INTO sources_ready FROM (${PURCHASE_CANCELLATION_SOURCE_SQL}) s;
  IF final_state IS DISTINCT FROM 'gift-v1' OR NOT sources_ready
    OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Purchase cancellation gift forward verification failed';
  END IF;
END
$purchase_cancellation_gift_forward$;`;
