import { PURCHASE_ORIGIN_DEFINITION_SQL, PURCHASE_ORIGIN_PROTECTION_SQL } from './purchaseOriginEvidence';
import { PURCHASE_ORIGIN_STATE_SQL } from './purchaseOriginEvidenceCatalog';

export const PURCHASE_ORIGIN_SETUP_SQL = String.raw`SET LOCAL search_path=pg_catalog,public,pg_temp;
SET LOCAL row_security=off;
SET LOCAL default_tablespace='';
SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),30000)::text||'ms',true),
  set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true);`;

const columns: Record<string, Array<[string, string, boolean]>> = {
  store_order: [
    ['id','integer',true],['uid','integer',true],['type','smallint',true],['pid','integer',true],
    ['paid','smallint',true],['status','smallint',true],['is_del','smallint',true],['is_system_del','smallint',true],
    ['supplier_allocation_status','smallint',true],['refund_status','smallint',true],['refund_type','smallint',true],
    ['total_num','integer',true],['use_integral','numeric(12,2)',true],['cart_id','text',false],
  ],
  store_order_cart_info: [
    ['id','integer',true],['oid','integer',true],['uid','integer',true],['cart_id','character varying(50)',true],
    ['old_cart_id','character varying(50)',true],['product_id','integer',true],['sku_unique','character varying(255)',true],
    ['cart_num','integer',true],['refund_num','integer',true],['split_status','smallint',true],
    ['split_surplus_num','integer',true],['surplus_num','integer',true],['is_writeoff','smallint',true],['cart_info','text',false],
  ],
};
/** Only the source contract used by capture, not a certificate for the entire commerce schema. */
export const PURCHASE_ORIGIN_SOURCE_SQL = `WITH tables AS (
  SELECT name,c.* FROM (VALUES ('store_order'),('store_order_cart_info')) names(name)
  LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public.'||name)
), expected AS (SELECT * FROM (VALUES ${Object.entries(columns).flatMap(([table, fields]) => fields.map(([name,type,notNull]) =>
  `('${table}','${name}','${type}',${notNull})`)).join(',\n')}) e(tab,col,typ,nn))
SELECT NOT EXISTS(SELECT 1 FROM tables WHERE oid IS NULL OR relkind<>'r' OR relpersistence<>'p'
    OR relispartition OR relrowsecurity OR relforcerowsecurity
    OR relowner<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))
  AND NOT EXISTS(SELECT 1 FROM tables t JOIN pg_catalog.pg_inherits i ON i.inhrelid=t.oid OR i.inhparent=t.oid)
  AND NOT EXISTS(SELECT 1 FROM tables t JOIN pg_catalog.pg_rewrite r ON r.ev_class=t.oid)
  AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN tables t ON t.name=e.tab
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attname=e.col AND a.attnum>0 AND NOT a.attisdropped
    WHERE a.attnum IS NULL OR pg_catalog.format_type(a.atttypid,a.atttypmod)<>e.typ OR a.attnotnull<>e.nn
      OR a.attgenerated<>'' OR a.attidentity<>'')
  AND NOT EXISTS(SELECT 1 FROM tables t CROSS JOIN (VALUES ('id',true),('lookup',false)) k(col,pk)
    WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
      JOIN pg_catalog.pg_am am ON am.oid=ic.relam JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[0]
      WHERE i.indrelid=t.oid AND a.attname=CASE WHEN k.pk THEN 'id' WHEN t.name='store_order' THEN 'pid' ELSE 'oid' END
        AND i.indisvalid AND i.indisready AND i.indislive AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname='btree'
        AND (NOT k.pk OR (i.indisprimary AND i.indisunique AND i.indnatts=1))
        AND i.indclass[0]=(SELECT oid FROM pg_catalog.pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace
          AND opcname='int4_ops' AND opcmethod=ic.relam))) AS ready`;

function installation(completeEmptyOrm: boolean) {
  return `${PURCHASE_ORIGIN_SETUP_SQL}
DO $purchase_origin_install$
DECLARE initial_state text; final_state text; sources_ready boolean;
BEGIN
  IF current_setting('server_version_num')::integer/10000<>16
    OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off'
    OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Purchase origin installation requires reviewed PG16 read-write READ COMMITTED';
  END IF;
  IF NOT pg_try_advisory_xact_lock(731611,0) THEN RAISE EXCEPTION 'Evidence installation already running'; END IF;
  SELECT state INTO initial_state FROM (${PURCHASE_ORIGIN_STATE_SQL}) s;
  SELECT ready INTO sources_ready FROM (${PURCHASE_ORIGIN_SOURCE_SQL}) s;
  IF initial_state='drift' OR NOT sources_ready OR (initial_state='orm-pending' AND NOT ${completeEmptyOrm}) THEN
    RAISE EXCEPTION 'Purchase origin catalog/source drift or unprotected ORM table requires review';
  END IF;
  LOCK TABLE ONLY public.store_order IN SHARE MODE NOWAIT;
  LOCK TABLE ONLY public.store_order_cart_info IN SHARE MODE NOWAIT;
  IF initial_state IN ('v1','orm-pending') THEN LOCK TABLE ONLY public.store_order_purchase_origin IN ACCESS EXCLUSIVE MODE NOWAIT; END IF;
  SELECT state INTO final_state FROM (${PURCHASE_ORIGIN_STATE_SQL}) s;
  SELECT ready INTO sources_ready FROM (${PURCHASE_ORIGIN_SOURCE_SQL}) s;
  IF final_state IS DISTINCT FROM initial_state OR NOT sources_ready THEN RAISE EXCEPTION 'Purchase origin catalog changed during locking'; END IF;
  IF initial_state='orm-pending' THEN
    IF EXISTS(SELECT 1 FROM public.store_order_purchase_origin) THEN
      RAISE EXCEPTION 'Unprotected ORM purchase origin table must be empty; no history repair is allowed';
    END IF;
${PURCHASE_ORIGIN_PROTECTION_SQL}
  ELSIF initial_state='fresh' THEN
${PURCHASE_ORIGIN_DEFINITION_SQL}
  END IF;
  SELECT state INTO final_state FROM (${PURCHASE_ORIGIN_STATE_SQL}) s;
  SELECT ready INTO sources_ready FROM (${PURCHASE_ORIGIN_SOURCE_SQL}) s;
  IF final_state IS DISTINCT FROM 'v1' OR NOT sources_ready OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Purchase origin verification failed after installation';
  END IF;
END
$purchase_origin_install$;`;
}

/** Forward-only schema protocol. No backfill, repair, takeover, or ORM adoption. */
export const PURCHASE_ORIGIN_INSTALLATION_SQL = installation(false);
/** Separate explicit empty-ORM completion; never used by an ordinary upgrade. */
export const PURCHASE_ORIGIN_ORM_INSTALLATION_SQL = installation(true);
