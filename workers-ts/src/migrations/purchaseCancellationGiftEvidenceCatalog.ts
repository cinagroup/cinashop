import { PURCHASE_CANCELLATION_CATALOG_SQL, PURCHASE_CANCELLATION_FINGERPRINTS,
  PURCHASE_CANCELLATION_STATE_SQL } from './purchaseCancellationEvidenceCatalog';
import { PURCHASE_CANCELLATION_GIFT_VALIDATE_BODY } from './purchaseCancellationGiftEvidence';

const escapedBody = PURCHASE_CANCELLATION_GIFT_VALIDATE_BODY.replaceAll("'", "''");
const unchanged = Object.entries(PURCHASE_CANCELLATION_FINGERPRINTS)
  .filter(([name]) => name !== 'validate_purchase_cancellation_v1')
  .map(([name, fingerprint]) =>
    `(objects->'${name}') @> '${JSON.stringify({ owned: true, safe: true, fingerprint })}'::jsonb`)
  .join(' AND ');

/** Exact old catalog remains authoritative for the other five components.
 * The replacement's full PL/pgSQL source and execution attributes are checked
 * directly; a renamed, altered or extra attachment cannot enter gift-v1. */
export const PURCHASE_CANCELLATION_GIFT_STATE_SQL = `WITH legacy AS (${PURCHASE_CANCELLATION_STATE_SQL}),
  catalog AS (${PURCHASE_CANCELLATION_CATALOG_SQL}),
  snapshot AS (SELECT count(*) AS n,jsonb_object_agg(name,to_jsonb(catalog)) AS objects FROM catalog),
  validator AS (SELECT p.prosrc,p.prokind,p.pronargs,p.prorettype,p.proretset,
      p.prosecdef,p.proleakproof,p.provolatile,p.proparallel,p.proisstrict,
      p.proconfig,p.prolang,p.proowner
    FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.validate_purchase_cancellation_v1()'))
SELECT CASE WHEN legacy.state='v1' THEN 'v1'
  WHEN snapshot.n=6 AND ${unchanged}
    AND (snapshot.objects->'validate_purchase_cancellation_v1') @> '{"owned":true,"safe":true}'::jsonb
    AND EXISTS(SELECT 1 FROM validator v WHERE v.prosrc='${escapedBody}'
      AND v.prokind='f' AND v.pronargs=0 AND v.prorettype='trigger'::regtype AND NOT v.proretset
      AND NOT v.prosecdef AND NOT v.proleakproof AND v.provolatile='v' AND v.proparallel='u'
      AND NOT v.proisstrict AND v.proconfig=ARRAY['search_path=pg_catalog']::text[]
      AND v.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
      AND v.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)) THEN 'gift-v1'
  ELSE legacy.state END AS state FROM legacy CROSS JOIN snapshot`;
