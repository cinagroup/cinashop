import { PURCHASE_CANCELLATION_CATALOG_SQL, PURCHASE_CANCELLATION_FINGERPRINTS } from './purchaseCancellationEvidenceCatalog';
import { PURCHASE_CANCELLATION_GIFT_STATE_SQL } from './purchaseCancellationGiftEvidenceCatalog';
import { PURCHASE_PHYSICAL_CANCELLATION_VALIDATE_BODY } from './purchasePhysicalCancellationEvidence';

const escapedBody = PURCHASE_PHYSICAL_CANCELLATION_VALIDATE_BODY.replaceAll("'", "''");
const unchanged = Object.entries(PURCHASE_CANCELLATION_FINGERPRINTS)
  .filter(([name]) => name !== 'validate_purchase_cancellation_v1')
  .map(([name, fingerprint]) =>
    `(objects->'${name}') @> '${JSON.stringify({ owned: true, safe: true, fingerprint })}'::jsonb`)
  .join(' AND ');

/** Exact old catalog remains authoritative for the other five components.
 * The replacement's full PL/pgSQL source and execution attributes are checked
 * directly; a renamed, altered or extra attachment cannot enter physical-v1. */
export const PURCHASE_PHYSICAL_CANCELLATION_STATE_SQL = `WITH legacy AS (${PURCHASE_CANCELLATION_GIFT_STATE_SQL}),
  catalog AS (${PURCHASE_CANCELLATION_CATALOG_SQL}),
  snapshot AS (SELECT count(*) AS n,jsonb_object_agg(name,to_jsonb(catalog)) AS objects FROM catalog),
  validator AS (SELECT p.*
    FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.validate_purchase_cancellation_v1()'))
SELECT CASE WHEN legacy.state IN ('v1','gift-v1') THEN legacy.state
  WHEN snapshot.n=6 AND ${unchanged}
    AND (snapshot.objects->'validate_purchase_cancellation_v1') @> '{"owned":true,"safe":true}'::jsonb
    AND EXISTS(SELECT 1 FROM validator v WHERE v.prosrc='${escapedBody}'
      AND v.prokind='f' AND v.pronargs=0 AND v.prorettype='trigger'::regtype AND NOT v.proretset
      AND NOT v.prosecdef AND NOT v.proleakproof AND v.provolatile='v' AND v.proparallel='u'
      AND NOT v.proisstrict AND v.prosupport=0 AND v.probin IS NULL AND v.prosqlbody IS NULL
      AND v.procost=100 AND v.prorows=0 AND v.provariadic=0 AND v.pronargdefaults=0
      AND v.proargtypes=''::oidvector AND v.proallargtypes IS NULL AND v.proargmodes IS NULL
      AND v.proargnames IS NULL AND v.proargdefaults IS NULL AND v.protrftypes IS NULL
      AND v.proconfig=ARRAY['search_path=pg_catalog']::text[]
      AND v.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
      AND v.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)) THEN 'physical-v1'
  ELSE legacy.state END AS state FROM legacy CROSS JOIN snapshot`;
