import { SHIPPING_LIFECYCLE_INDEX_CATALOG_SQL, SHIPPING_LIFECYCLE_REUSED_INDEX_SQL } from './shippingLifecycleIndexes';
import { SHIPPING_LIFECYCLE_SHAPE_SQL, SHIPPING_LIFECYCLE_BASELINE_SQL, SHIPPING_LIFECYCLE_LOCK_SQL } from './shippingLifecycleInspectionSql';
import { SHIPPING_LIFECYCLE_ENVIRONMENT_SQL } from './assertShippingLifecycleInstallationEnvironment';
import { SHIPPING_LIFECYCLE_FUNCTIONS_SQL, SHIPPING_LIFECYCLE_TRIGGERS_SQL } from './shippingLifecycleProtocolQueries';
import { SHIPPING_LIFECYCLE_FUNCTIONS, SHIPPING_LIFECYCLE_TRIGGERS } from './shippingLifecycleProtocol';

const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const functions = [...SHIPPING_LIFECYCLE_FUNCTIONS].sort((a,b) => order(a.name,b.name));
const triggers = SHIPPING_LIFECYCLE_TRIGGERS.map(t => ({...t,schema:'public'}))
  .sort((a,b) => order(a.table,b.table) || order(a.name,b.name));

// Public schema only, same fixed SQL for external 0153, embedded 0159 and root
// maintenance. Independent 30s DDL budget; never widens a stricter caller limit.
// Does not install/replace the protocol, repair data, ANALYZE or change privileges.
export const SHIPPING_LIFECYCLE_INDEX_INSTALLATION_SQL = String.raw`
SET LOCAL search_path=pg_catalog,pg_temp; SET LOCAL row_security=off;
SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),30000)::text || 'ms',true),
  set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true);
DO $shipping_indexes_0153$
DECLARE
  ready boolean; item record; phase integer;
  observed_functions jsonb; observed_triggers jsonb; functions_ok boolean; triggers_ok boolean;
  expected_functions jsonb := $shipping_index_functions$${JSON.stringify(functions)}$shipping_index_functions$::jsonb;
  expected_triggers jsonb := $shipping_index_triggers$${JSON.stringify(triggers)}$shipping_index_triggers$::jsonb;
BEGIN
  IF current_setting('server_version_num')::integer / 10000 <> 16
    OR current_setting('transaction_isolation') <> 'read committed' OR current_setting('transaction_read_only') <> 'off' THEN
    RAISE EXCEPTION 'Shipping indexes require PostgreSQL 16 read-write READ COMMITTED';
  END IF;
  IF current_setting('search_path') <> 'pg_catalog, pg_temp' OR current_setting('row_security') <> 'off'
    OR (SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout') NOT BETWEEN 1 AND 30000
    OR (SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout') NOT BETWEEN 1 AND 1000
    OR (SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout') NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'Shipping indexes require bounded maintenance settings';
  END IF;
  FOR phase IN 0..1 LOOP
    SELECT "originTriggersActive" AND "noEnabledEventTriggers" AND "noUnreviewedRelationTriggers" AND "noUnreviewedRelationRules" INTO ready
      FROM (${SHIPPING_LIFECYCLE_ENVIRONMENT_SQL}) e;
    IF ready IS DISTINCT FROM true THEN RAISE EXCEPTION 'Shipping index installation environment requires review'; END IF;
    SELECT count(*)=7 AND bool_and(compatible) INTO ready FROM (${SHIPPING_LIFECYCLE_SHAPE_SQL}) s;
    IF ready IS DISTINCT FROM true THEN RAISE EXCEPTION 'Shipping index table structure differs'; END IF;
    IF phase=0 THEN
${SHIPPING_LIFECYCLE_LOCK_SQL};
    END IF;
  END LOOP;
  SELECT count(*)=6 AND bool_and(invalid_references=0) INTO ready FROM (${SHIPPING_LIFECYCLE_BASELINE_SQL}) b;
  IF ready IS DISTINCT FROM true THEN RAISE EXCEPTION 'Shipping index reference baseline differs'; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(f)-'common' ORDER BY f.name COLLATE "C",f.args COLLATE "C"),'[]'::jsonb),
    COALESCE(bool_and(common),false) INTO observed_functions,functions_ok FROM (${SHIPPING_LIFECYCLE_FUNCTIONS_SQL}) f;
  SELECT COALESCE(jsonb_agg(to_jsonb(t)-'common' ORDER BY t."table" COLLATE "C",t.name COLLATE "C"),'[]'::jsonb),
    COALESCE(bool_and(common),false) INTO observed_triggers,triggers_ok FROM (${SHIPPING_LIFECYCLE_TRIGGERS_SQL}) t;
  IF observed_functions<>expected_functions OR observed_triggers<>expected_triggers OR NOT functions_ok OR NOT triggers_ok THEN
    RAISE EXCEPTION 'Shipping indexes require the complete exact lifecycle protocol';
  END IF;
  SELECT compatible INTO ready FROM (${SHIPPING_LIFECYCLE_REUSED_INDEX_SQL}) r;
  IF ready IS DISTINCT FROM true THEN RAISE EXCEPTION 'Shipping package source index requires review'; END IF;
  SELECT "originTriggersActive" AND "noEnabledEventTriggers" AND "noUnreviewedRelationTriggers" AND "noUnreviewedRelationRules" INTO ready
    FROM (${SHIPPING_LIFECYCLE_ENVIRONMENT_SQL}) e;
  IF ready IS DISTINCT FROM true THEN RAISE EXCEPTION 'Shipping index installation environment requires review'; END IF;
  IF EXISTS(SELECT 1 FROM (${SHIPPING_LIFECYCLE_INDEX_CATALOG_SQL}) i WHERE present AND NOT compatible) THEN
    RAISE EXCEPTION 'Shipping lifecycle index definition drift';
  END IF;
  FOR item IN SELECT * FROM (${SHIPPING_LIFECYCLE_INDEX_CATALOG_SQL}) i WHERE NOT present ORDER BY name COLLATE "C" LOOP
    -- DDL is taken from the fixed embedded manifest, never observed catalog text.
    EXECUTE item.ddl;
  END LOOP;
  -- All creations and their final verification belong to this one transaction.
  SELECT count(*)=10 AND bool_and(compatible) INTO ready FROM (${SHIPPING_LIFECYCLE_INDEX_CATALOG_SQL}) i;
  IF ready IS DISTINCT FROM true THEN RAISE EXCEPTION 'Shipping lifecycle indexes differ after installation'; END IF;
END
$shipping_indexes_0153$;
`;
