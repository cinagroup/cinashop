import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SECKILL_TIME_REFERENCE_LOCK_FUNCTION, SECKILL_TIME_REFERENCE_LOCK_MAINTENANCE_KEY, SECKILL_TIME_REFERENCE_OWNER_SETTING,
  seckillTimeReferenceLockBody, seckillTimeReferenceLockCatalogQuery, seckillTimeReferenceLockOwnerQuery } from './seckillTimeReferenceLockCatalog';
import { pricingIdentifier } from './checkoutPricingLockCatalog';

function inline(query: SQL): string {
  const compiled = new PgDialect().sqlToQuery(query.inlineParams());
  if (compiled.params.length) throw Error('Seckill time reference lock installation must contain no unbound parameters');
  return compiled.sql;
}
const literal = (value: string) => inline(sql`${value}`);
const ready = (name: 'initial_state' | 'final_state') =>
  `(${name}->>'tablesSafe'='true' AND ${name}->>'absent'='false'
    AND ${name}->>'definitionSafe'='true' AND ${name}->>'ownerSafe'='true' AND ${name}->>'aclSafe'='true')`;

/** No role creation, implicit owner choice, business grants or drift repair.
 * The explicit owner is a transaction-local setting supplied by the operator
 * or root installer. External and embedded SQL share exactly this definition. */
export function seckillTimeReferenceLockInstallationSql(schema = 'public'): string {
  const namespace = pricingIdentifier(schema);
  const catalog = inline(seckillTimeReferenceLockCatalogQuery(schema));
  const owner = inline(seckillTimeReferenceLockOwnerQuery(sql.raw('reference_lock_owner'), schema));
  const create = `CREATE FUNCTION ${namespace}.${SECKILL_TIME_REFERENCE_LOCK_FUNCTION}() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
    AS $reference_lock$${seckillTimeReferenceLockBody(schema)}$reference_lock$`;
  return `-- Explicit PG16 seckill time reference locking capability; NOLOGIN owner must already exist.
-- Set ${SECKILL_TIME_REFERENCE_OWNER_SETTING} locally in this maintenance transaction.
SELECT
  pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
  pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
  pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true),
  pg_catalog.set_config('search_path','pg_catalog,pg_temp',true);
DO $seckill_time_reference_lock_install$
DECLARE
  reference_lock_owner text := nullif(pg_catalog.current_setting('${SECKILL_TIME_REFERENCE_OWNER_SETTING}',true),'');
  owner_oid text;
  namespace_oid integer;
  initial_state jsonb;
  locked_state jsonb;
  final_state jsonb;
BEGIN
  IF reference_lock_owner IS NULL OR reference_lock_owner !~ '^[a-z_][a-z0-9_]{0,62}$'
    OR pg_catalog.starts_with(reference_lock_owner,'pg_') OR reference_lock_owner='information_schema' THEN
    RAISE EXCEPTION 'Seckill time reference lock installation requires an explicit safe NOLOGIN owner setting';
  END IF;
  IF pg_catalog.current_setting('server_version_num')::integer/10000<>16
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR pg_catalog.current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Seckill time reference lock capability requires reviewed PG16 READ COMMITTED';
  END IF;
  SELECT oid::integer INTO namespace_oid FROM pg_catalog.pg_namespace WHERE nspname=${literal(schema)};
  IF namespace_oid IS NULL OR NOT pg_catalog.pg_try_advisory_xact_lock(${SECKILL_TIME_REFERENCE_LOCK_MAINTENANCE_KEY},namespace_oid) THEN
    RAISE EXCEPTION 'Seckill time reference lock capability maintenance is busy or schema is missing';
  END IF;
  SELECT q.oid INTO owner_oid FROM (${owner}) q;
  IF owner_oid IS NULL THEN
    RAISE EXCEPTION 'Seckill time reference lock capability owner must be a separate restricted NOLOGIN role';
  END IF;
  SELECT pg_catalog.to_jsonb(q) INTO initial_state FROM (${catalog}) q;
  IF initial_state->>'tablesSafe' IS DISTINCT FROM 'true'
    OR (initial_state->>'absent' IS DISTINCT FROM 'true'
      AND (NOT COALESCE(${ready('initial_state')},false) OR initial_state->>'ownerOid' IS DISTINCT FROM owner_oid)) THEN
    RAISE EXCEPTION 'Seckill time reference lock capability catalog, owner or ACL drift requires review';
  END IF;
  LOCK TABLE ${namespace}.store_activity,${namespace}.store_seckill IN ACCESS EXCLUSIVE MODE NOWAIT;
  SELECT pg_catalog.to_jsonb(q) INTO locked_state FROM (${catalog}) q;
  IF locked_state IS DISTINCT FROM initial_state THEN
    RAISE EXCEPTION 'Seckill time reference lock capability changed during installation';
  END IF;
  IF initial_state->>'absent'='true' THEN
    EXECUTE pg_catalog.format(${literal(`GRANT USAGE,CREATE ON SCHEMA ${namespace} TO %I`)},reference_lock_owner);
    EXECUTE pg_catalog.format(${literal(`GRANT UPDATE ON ${namespace}.store_activity,${namespace}.store_seckill TO %I`)},reference_lock_owner);
    EXECUTE ${literal(create)};
    REVOKE ALL ON FUNCTION ${namespace}.${SECKILL_TIME_REFERENCE_LOCK_FUNCTION}() FROM PUBLIC;
    EXECUTE pg_catalog.format(${literal(`ALTER FUNCTION ${namespace}.${SECKILL_TIME_REFERENCE_LOCK_FUNCTION}() OWNER TO %I`)},reference_lock_owner);
    EXECUTE pg_catalog.format(${literal(`REVOKE CREATE ON SCHEMA ${namespace} FROM %I`)},reference_lock_owner);
  END IF;
  SELECT pg_catalog.to_jsonb(q) INTO final_state FROM (${catalog}) q;
  IF NOT COALESCE(${ready('final_state')},false) OR final_state->>'ownerOid' IS DISTINCT FROM owner_oid THEN
    RAISE EXCEPTION 'Seckill time reference lock capability final verification failed';
  END IF;
END
$seckill_time_reference_lock_install$;
`;
}

export const SECKILL_TIME_REFERENCE_LOCK_INSTALLATION_SQL = seckillTimeReferenceLockInstallationSql();
