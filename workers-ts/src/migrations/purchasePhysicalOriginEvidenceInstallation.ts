import { PURCHASE_ORIGIN_SETUP_SQL, PURCHASE_ORIGIN_SOURCE_SQL } from './purchaseOriginEvidenceInstallation';
import { PURCHASE_ORIGIN_STATE_SQL } from './purchaseOriginEvidenceCatalog';
import { PURCHASE_PHYSICAL_ORIGIN_DEFINITION_SQL, PURCHASE_PHYSICAL_ORIGIN_PROTECTION_SQL } from './purchasePhysicalOriginEvidence';
import { PURCHASE_PHYSICAL_ORIGIN_STATE_SQL } from './purchasePhysicalOriginEvidenceCatalog';
import { PURCHASE_PHYSICAL_CANCELLATION_STATE_SQL } from './purchasePhysicalCancellationEvidenceCatalog';
import { PURCHASE_PHYSICAL_CANCELLATION_VALIDATE_SQL } from './purchasePhysicalCancellationEvidence';
import { PURCHASE_CANCELLATION_SOURCE_SQL } from './purchaseCancellationEvidenceInstallation';

export const PURCHASE_PHYSICAL_ORIGIN_SETUP_SQL=PURCHASE_ORIGIN_SETUP_SQL;
const extraColumns=[['store_order','promotions_give','text',false],
  ['store_order_cart_info','is_gift','smallint',true],['store_order_cart_info','product_type','smallint',true],
  ['store_order_cart_info','settle_price','numeric(12,2)',true],['store_order_cart_info','write_times','integer',true],
  ['store_order_cart_info','write_surplus_times','integer',true],['store_order_cart_info','promotions_id','text',false]] as const;
export const PURCHASE_PHYSICAL_ORIGIN_SOURCE_SQL=`WITH origin AS (${PURCHASE_ORIGIN_STATE_SQL}),
  sources AS (${PURCHASE_ORIGIN_SOURCE_SQL}), expected AS (SELECT * FROM (VALUES ${extraColumns.map(([table,col,type,nn])=>`('${table}','${col}','${type}',${nn})`).join(',')}) e(tab,col,typ,nn))
SELECT (SELECT state='v1' FROM origin) AND (SELECT ready FROM sources)
  AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN pg_attribute a ON a.attrelid=to_regclass('public.'||e.tab)
    AND a.attname=e.col AND a.attnum>0 AND NOT a.attisdropped WHERE a.attnum IS NULL
    OR format_type(a.atttypid,a.atttypmod)<>e.typ OR a.attnotnull<>e.nn OR a.attgenerated<>'' OR a.attidentity<>'') AS ready`;

/** Only an exact old cancellation body can advance. Fresh narrow fixtures may
 * omit cancellation entirely; no relation/function is fabricated for them. */
export const PURCHASE_PHYSICAL_CANCELLATION_INSTALLATION_SQL=`${PURCHASE_PHYSICAL_ORIGIN_SETUP_SQL}
DO $physical_cancel_forward$
DECLARE before_state text; after_state text; sources_ready boolean;
BEGIN
  IF current_setting('server_version_num')::integer/10000<>16 OR current_setting('transaction_isolation')<>'read committed'
    OR current_setting('transaction_read_only')<>'off' OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'Physical cancellation requires reviewed PG16 READ COMMITTED'; END IF;
  IF NOT pg_try_advisory_xact_lock(731611,0) THEN RAISE EXCEPTION 'Purchase evidence maintenance busy'; END IF;
  SELECT state INTO before_state FROM (${PURCHASE_PHYSICAL_CANCELLATION_STATE_SQL}) s;
  IF before_state<>'fresh' THEN
    SELECT ready INTO sources_ready FROM (${PURCHASE_CANCELLATION_SOURCE_SQL}) s;
    IF before_state NOT IN ('v1','gift-v1','physical-v1') OR NOT sources_ready
      OR (SELECT state FROM (${PURCHASE_PHYSICAL_ORIGIN_STATE_SQL}) s)<>'v1' THEN
      RAISE EXCEPTION 'Physical cancellation requires exact existing protocols';
    END IF;
    LOCK TABLE ONLY public.store_order IN SHARE ROW EXCLUSIVE MODE NOWAIT;
    LOCK TABLE ONLY public.store_order_cart_info IN SHARE MODE NOWAIT;
    LOCK TABLE ONLY public.store_order_purchase_origin IN SHARE MODE NOWAIT;
    LOCK TABLE ONLY public.store_order_status IN SHARE MODE NOWAIT;
    LOCK TABLE ONLY public.user_bill IN SHARE MODE NOWAIT;
    LOCK TABLE ONLY public.store_order_purchase_cancellation IN ACCESS EXCLUSIVE MODE NOWAIT;
    LOCK TABLE ONLY public.store_order_purchase_physical_origin IN SHARE MODE NOWAIT;
    SELECT state INTO after_state FROM (${PURCHASE_PHYSICAL_CANCELLATION_STATE_SQL}) s;
    IF after_state IS DISTINCT FROM before_state THEN RAISE EXCEPTION 'Physical cancellation changed while locking'; END IF;
    IF before_state<>'physical-v1' THEN
      EXECUTE $physical_cancel_body$${PURCHASE_PHYSICAL_CANCELLATION_VALIDATE_SQL}$physical_cancel_body$;
    END IF;
    SELECT state INTO after_state FROM (${PURCHASE_PHYSICAL_CANCELLATION_STATE_SQL}) s;
    IF after_state IS DISTINCT FROM 'physical-v1' THEN RAISE EXCEPTION 'Physical cancellation verification failed'; END IF;
  END IF;
END $physical_cancel_forward$;`;

function installation(completeEmptyOrm:boolean){return `${PURCHASE_PHYSICAL_ORIGIN_SETUP_SQL}
DO $physical_origin_install$
DECLARE before_state text; after_state text; sources_ready boolean;
BEGIN
  IF current_setting('server_version_num')::integer/10000<>16 OR current_setting('transaction_isolation')<>'read committed'
    OR current_setting('transaction_read_only')<>'off' OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'Physical origin requires reviewed PG16 READ COMMITTED'; END IF;
  IF NOT pg_try_advisory_xact_lock(731611,0) THEN RAISE EXCEPTION 'Purchase evidence maintenance busy'; END IF;
  SELECT state INTO before_state FROM (${PURCHASE_PHYSICAL_ORIGIN_STATE_SQL}) s;
  SELECT ready INTO sources_ready FROM (${PURCHASE_PHYSICAL_ORIGIN_SOURCE_SQL}) s;
  IF NOT sources_ready OR before_state='drift' OR (before_state='orm-pending' AND NOT ${completeEmptyOrm}) THEN
    RAISE EXCEPTION 'Physical origin catalog/source drift or unprotected ORM requires review';
  END IF;
  LOCK TABLE ONLY public.store_order IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  LOCK TABLE ONLY public.store_order_cart_info IN SHARE MODE NOWAIT;
  LOCK TABLE ONLY public.store_order_purchase_origin IN SHARE MODE NOWAIT;
  IF before_state IN ('v1','orm-pending') THEN LOCK TABLE ONLY public.store_order_purchase_physical_origin IN ACCESS EXCLUSIVE MODE NOWAIT; END IF;
  SELECT state INTO after_state FROM (${PURCHASE_PHYSICAL_ORIGIN_STATE_SQL}) s;
  SELECT ready INTO sources_ready FROM (${PURCHASE_PHYSICAL_ORIGIN_SOURCE_SQL}) s;
  IF after_state IS DISTINCT FROM before_state OR NOT sources_ready THEN RAISE EXCEPTION 'Physical origin changed while locking'; END IF;
  IF before_state='orm-pending' THEN
    IF EXISTS(SELECT 1 FROM public.store_order_purchase_physical_origin) THEN RAISE EXCEPTION 'Physical ORM table must be empty; no history adoption'; END IF;
${PURCHASE_PHYSICAL_ORIGIN_PROTECTION_SQL}
  ELSIF before_state='fresh' THEN
${PURCHASE_PHYSICAL_ORIGIN_DEFINITION_SQL}
    IF EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid='public.store_order_purchase_physical_origin'::regclass AND a.grantee<>c.relowner) THEN
      RAISE EXCEPTION 'Physical origin defaults expose new evidence';
    END IF;
  END IF;
  SELECT state INTO after_state FROM (${PURCHASE_PHYSICAL_ORIGIN_STATE_SQL}) s;
  SELECT ready INTO sources_ready FROM (${PURCHASE_PHYSICAL_ORIGIN_SOURCE_SQL}) s;
  IF after_state IS DISTINCT FROM 'v1' OR NOT sources_ready THEN RAISE EXCEPTION 'Physical origin installation verification failed'; END IF;
END $physical_origin_install$;
${PURCHASE_PHYSICAL_CANCELLATION_INSTALLATION_SQL}`;}
export const PURCHASE_PHYSICAL_ORIGIN_INSTALLATION_SQL=installation(false);
export const PURCHASE_PHYSICAL_ORIGIN_ORM_INSTALLATION_SQL=installation(true);
