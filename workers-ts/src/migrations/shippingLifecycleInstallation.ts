import { SHIPPING_LIFECYCLE_CANDIDATE_SQL, SHIPPING_LIFECYCLE_FUNCTIONS, SHIPPING_LIFECYCLE_TRIGGERS } from './shippingLifecycleProtocol';
import { SHIPPING_LIFECYCLE_BASELINE_SQL, SHIPPING_LIFECYCLE_BOUND_SQL, SHIPPING_LIFECYCLE_LOCK_SQL, SHIPPING_LIFECYCLE_SHAPE_SQL } from './shippingLifecycleInspectionSql';
import { SHIPPING_LIFECYCLE_FUNCTIONS_SQL, SHIPPING_LIFECYCLE_TRIGGERS_SQL } from './shippingLifecycleProtocolQueries';
import { SHIPPING_LIFECYCLE_ENVIRONMENT_SQL } from './assertShippingLifecycleInstallationEnvironment';

// Every input is a fixed, version-controlled definition, never observed catalog
// content or caller SQL. The generated SQL is mirrored verbatim in filesystem
// migration 0152 and used by embedded step 0158 and the standalone root runner.
const literal = (tag: string, value: string) => {
  const delimiter = `$${tag}$`;
  if (value.includes(delimiter)) throw new Error('Shipping migration literal delimiter collision');
  return `${delimiter}${value}${delimiter}`;
};
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const functions = [...SHIPPING_LIFECYCLE_FUNCTIONS].sort((a,b) => order(a.name,b.name));
const triggers = SHIPPING_LIFECYCLE_TRIGGERS.map(t => ({ ...t, schema: 'public' }))
  .sort((a,b) => order(a.table,b.table) || order(a.name,b.name));

export const SHIPPING_LIFECYCLE_INSTALLATION_SQL = String.raw`
-- 0152 (embedded 0158): shipping reference/lifecycle protocol, public schema only.
-- Run as one transaction on PostgreSQL 16 READ COMMITTED. No backfill or grants.
-- Existing databases use runShippingLifecycle(), never historical runAll().
-- Independent maintenance identities must be coordinated outside this protocol.
${SHIPPING_LIFECYCLE_BOUND_SQL};
DO $shipping_install_0152$
DECLARE
  environment_ok boolean;
  shape_ok boolean;
  baseline_ok boolean;
  observed_functions jsonb;
  observed_triggers jsonb;
  function_properties_ok boolean;
  trigger_properties_ok boolean;
  phase integer;
  expected_functions jsonb := ${literal('shipping_expected_functions', JSON.stringify(functions))}::jsonb;
  expected_triggers jsonb := ${literal('shipping_expected_triggers', JSON.stringify(triggers))}::jsonb;
BEGIN
  IF current_setting('server_version_num')::integer / 10000 <> 16
    OR current_setting('transaction_read_only') <> 'off'
    OR current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Shipping installation requires a PostgreSQL 16 read-write read-committed transaction';
  END IF;
  IF pg_catalog.current_setting('search_path') <> 'pg_catalog, pg_temp'
    OR pg_catalog.current_setting('row_security') <> 'off'
    OR (SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout') NOT BETWEEN 1 AND 5000
    OR (SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout') NOT BETWEEN 1 AND 1000
    OR (SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout') NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'Shipping installation requires bounded transaction settings';
  END IF;
  SELECT "originTriggersActive" AND "noEnabledEventTriggers" AND "noUnreviewedRelationTriggers" INTO environment_ok
    FROM (${SHIPPING_LIFECYCLE_ENVIRONMENT_SQL}) e;
  IF environment_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Shipping installation environment requires review'; END IF;
  SELECT count(*)=7 AND bool_and(compatible) INTO shape_ok FROM (${SHIPPING_LIFECYCLE_SHAPE_SQL}) s;
  IF shape_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Shipping installation baseline is incompatible'; END IF;
${SHIPPING_LIFECYCLE_LOCK_SQL};
  SELECT count(*)=7 AND bool_and(compatible) INTO shape_ok FROM (${SHIPPING_LIFECYCLE_SHAPE_SQL}) s;
  IF shape_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Shipping installation baseline is incompatible'; END IF;
  SELECT count(*)=6 AND bool_and(invalid_references=0) INTO baseline_ok FROM (${SHIPPING_LIFECYCLE_BASELINE_SQL}) b;
  IF baseline_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Shipping installation baseline is incompatible'; END IF;
  SELECT "originTriggersActive" AND "noEnabledEventTriggers" AND "noUnreviewedRelationTriggers" INTO environment_ok
    FROM (${SHIPPING_LIFECYCLE_ENVIRONMENT_SQL}) e;
  IF environment_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Shipping installation environment requires review'; END IF;
  FOR phase IN 0..1 LOOP
    SELECT COALESCE(jsonb_agg(to_jsonb(f)-'common' ORDER BY f.name COLLATE "C",f.args COLLATE "C"),'[]'::jsonb),
      COALESCE(bool_and(common),false) INTO observed_functions,function_properties_ok
      FROM (${SHIPPING_LIFECYCLE_FUNCTIONS_SQL}) f;
    SELECT COALESCE(jsonb_agg(to_jsonb(t)-'common' ORDER BY t."table" COLLATE "C",t.name COLLATE "C"),'[]'::jsonb),
      COALESCE(bool_and(common),false) INTO observed_triggers,trigger_properties_ok
      FROM (${SHIPPING_LIFECYCLE_TRIGGERS_SQL}) t;
    IF observed_functions=expected_functions AND observed_triggers=expected_triggers
      AND function_properties_ok AND trigger_properties_ok THEN RETURN; END IF;
    IF phase=1 THEN RAISE EXCEPTION 'Shipping lifecycle protocol catalog differs after installation'; END IF;
    IF observed_functions<>'[]'::jsonb OR observed_triggers<>'[]'::jsonb THEN
      RAISE EXCEPTION 'Shipping lifecycle protocol catalog differs';
    END IF;
    EXECUTE ${literal('shipping_protocol_ddl', SHIPPING_LIFECYCLE_CANDIDATE_SQL)};
  END LOOP;
END
$shipping_install_0152$;
`;
