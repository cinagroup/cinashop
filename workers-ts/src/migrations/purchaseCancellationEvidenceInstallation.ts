import { PURCHASE_CANCELLATION_DEFINITION_SQL, PURCHASE_CANCELLATION_PROTECTION_SQL } from './purchaseCancellationEvidence';
import { PURCHASE_CANCELLATION_STATE_SQL } from './purchaseCancellationEvidenceCatalog';
import { PURCHASE_ORIGIN_STATE_SQL } from './purchaseOriginEvidenceCatalog';
import { PURCHASE_ORIGIN_SETUP_SQL, PURCHASE_ORIGIN_SOURCE_SQL } from './purchaseOriginEvidenceInstallation';

// Same evidence-maintenance transaction environment and global installation fence.
export const PURCHASE_CANCELLATION_SETUP_SQL = PURCHASE_ORIGIN_SETUP_SQL;
const columns: Record<string,Array<[string,string]>> = {
  store_order_status:[['id','integer'],['oid','integer'],['change_type','character varying(32)']],
  user_bill:[['id','integer'],['uid','integer'],['link_id','character varying(32)'],['category','character varying(64)'],
    ['type','character varying(64)'],['event_key','character varying(64)'],['pm','smallint'],['number','numeric(12,2)'],['status','smallint']],
};
/** Origin v1 plus only the source contract this protocol consumes. Not full
 * business readiness, compensation authority or historical-data attestation. */
export const PURCHASE_CANCELLATION_SOURCE_SQL = `WITH origin AS (${PURCHASE_ORIGIN_STATE_SQL}),
  original_sources AS (${PURCHASE_ORIGIN_SOURCE_SQL}), tables AS (
    SELECT name,c.* FROM (VALUES ('store_order_status'),('user_bill')) names(name)
      LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public.'||name)
  ), expected AS (SELECT * FROM (VALUES ${Object.entries(columns).flatMap(([table,fields]) =>
    fields.map(([name,type]) => `('${table}','${name}','${type}')`)).join(',\n')}) e(tab,col,typ))
SELECT (SELECT state='v1' FROM origin) AND (SELECT ready FROM original_sources)
  AND NOT EXISTS(SELECT 1 FROM tables WHERE oid IS NULL OR relkind<>'r' OR relpersistence<>'p'
    OR relispartition OR relrowsecurity OR relforcerowsecurity
    OR relowner<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))
  AND NOT EXISTS(SELECT 1 FROM tables t JOIN pg_catalog.pg_inherits i ON i.inhrelid=t.oid OR i.inhparent=t.oid)
  AND NOT EXISTS(SELECT 1 FROM tables t JOIN pg_catalog.pg_rewrite r ON r.ev_class=t.oid)
  AND NOT EXISTS(SELECT 1 FROM expected e LEFT JOIN tables t ON t.name=e.tab
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attname=e.col AND a.attnum>0 AND NOT a.attisdropped
    WHERE a.attnum IS NULL OR pg_catalog.format_type(a.atttypid,a.atttypmod)<>e.typ OR NOT a.attnotnull
      OR a.attgenerated<>'' OR a.attidentity<>'')
  AND NOT EXISTS(SELECT 1 FROM tables t WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=ic.relam
    JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[0]
    WHERE i.indrelid=t.oid AND a.attname='id' AND i.indisprimary AND i.indisunique AND i.indnatts=1
      AND i.indisvalid AND i.indisready AND i.indislive AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname='btree'
      AND i.indclass[0]=(SELECT oid FROM pg_catalog.pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace
        AND opcname='int4_ops' AND opcmethod=ic.relam)))
  AND NOT EXISTS(SELECT 1 FROM tables t WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=ic.relam
    WHERE i.indrelid=t.oid AND i.indisvalid AND i.indisready AND i.indislive
      AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname='btree'
      AND i.indnkeyatts>=CASE WHEN t.name='user_bill' THEN 3 ELSE 1 END
      AND NOT EXISTS(SELECT 1 FROM generate_series(0,CASE WHEN t.name='user_bill' THEN 2 ELSE 0 END) k(pos)
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[k.pos]
        WHERE a.attname IS DISTINCT FROM CASE WHEN t.name='store_order_status' THEN 'oid'
          WHEN k.pos=0 THEN 'category' WHEN k.pos=1 THEN 'type' ELSE 'link_id' END
          OR i.indcollation[k.pos]<>a.attcollation
          OR i.indclass[k.pos]<>(SELECT oid FROM pg_catalog.pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace
            AND opcname=CASE WHEN t.name='user_bill' THEN 'text_ops' ELSE 'int4_ops' END AND opcmethod=ic.relam)))) AS ready`;

function installation(completeEmptyOrm: boolean) {
  return `${PURCHASE_CANCELLATION_SETUP_SQL}
DO $purchase_cancellation_install$
DECLARE initial_state text; final_state text; sources_ready boolean;
BEGIN
  IF current_setting('server_version_num')::integer/10000<>16
    OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off'
    OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Purchase cancellation installation requires reviewed PG16 read-write READ COMMITTED';
  END IF;
  IF NOT pg_try_advisory_xact_lock(731611,0) THEN RAISE EXCEPTION 'Evidence installation already running'; END IF;
  SELECT state INTO initial_state FROM (${PURCHASE_CANCELLATION_STATE_SQL}) s;
  SELECT ready INTO sources_ready FROM (${PURCHASE_CANCELLATION_SOURCE_SQL}) s;
  IF initial_state='drift' OR NOT sources_ready OR (initial_state='orm-pending' AND NOT ${completeEmptyOrm}) THEN
    RAISE EXCEPTION 'Purchase cancellation catalog/source drift or unprotected ORM table requires review';
  END IF;
  -- Take the mode required by CREATE TRIGGER up front, no waiting lock upgrade.
  LOCK TABLE ONLY public.store_order IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  LOCK TABLE ONLY public.store_order_cart_info IN SHARE MODE NOWAIT;
  LOCK TABLE ONLY public.store_order_purchase_origin IN SHARE MODE NOWAIT;
  LOCK TABLE ONLY public.store_order_status IN SHARE MODE NOWAIT;
  LOCK TABLE ONLY public.user_bill IN SHARE MODE NOWAIT;
  IF initial_state IN ('v1','orm-pending') THEN LOCK TABLE ONLY public.store_order_purchase_cancellation IN ACCESS EXCLUSIVE MODE NOWAIT; END IF;
  SELECT state INTO final_state FROM (${PURCHASE_CANCELLATION_STATE_SQL}) s;
  SELECT ready INTO sources_ready FROM (${PURCHASE_CANCELLATION_SOURCE_SQL}) s;
  IF final_state IS DISTINCT FROM initial_state OR NOT sources_ready THEN RAISE EXCEPTION 'Purchase cancellation catalog changed during locking'; END IF;
  IF initial_state='orm-pending' THEN
    IF EXISTS(SELECT 1 FROM public.store_order_purchase_cancellation) THEN
      RAISE EXCEPTION 'Unprotected ORM purchase cancellation table must be empty; no history repair is allowed';
    END IF;
${PURCHASE_CANCELLATION_PROTECTION_SQL}
  ELSIF initial_state='fresh' THEN
${PURCHASE_CANCELLATION_DEFINITION_SQL}
    IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL
      pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE c.oid='public.store_order_purchase_cancellation'::regclass AND a.grantee<>c.relowner) THEN
      RAISE EXCEPTION 'Purchase cancellation defaults must not expose new evidence';
    END IF;
  END IF;
  SELECT state INTO final_state FROM (${PURCHASE_CANCELLATION_STATE_SQL}) s;
  SELECT ready INTO sources_ready FROM (${PURCHASE_CANCELLATION_SOURCE_SQL}) s;
  IF final_state IS DISTINCT FROM 'v1' OR NOT sources_ready OR current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Purchase cancellation verification failed after installation';
  END IF;
END
$purchase_cancellation_install$;`;
}

/** Forward-only ordinary install. Never adopts an unprotected ORM table. */
export const PURCHASE_CANCELLATION_INSTALLATION_SQL = installation(false);
/** Explicit exact empty-ORM completion, not a normal upgrade or runtime path. */
export const PURCHASE_CANCELLATION_ORM_INSTALLATION_SQL = installation(true);
