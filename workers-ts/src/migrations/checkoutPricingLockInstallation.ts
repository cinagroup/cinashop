import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { PRICING_LOCK_FUNCTION, PRICING_LOCK_KEY, PRICING_OWNER_SETTING,
  pricingBody, pricingCatalogQuery, pricingIdentifier, pricingOwnerQuery } from './checkoutPricingLockCatalog';

function inline(query: SQL): string {
  const compiled = new PgDialect().sqlToQuery(query.inlineParams());
  if (compiled.params.length) throw Error('Pricing installation must contain no unbound parameters');
  return compiled.sql;
}
const literal = (value: string) => inline(sql`${value}`);
const ready = (name: 'initial_state' | 'final_state') =>
  `(${name}->>'tablesSafe'='true' AND ${name}->>'absent'='false'
    AND ${name}->>'definitionSafe'='true' AND ${name}->>'ownerSafe'='true' AND ${name}->>'aclSafe'='true')`;

/** No role creation, implicit owner choice, business grants or drift repair.
 * The explicit owner is a transaction-local setting supplied by the operator
 * or root installer. External and embedded SQL share exactly this definition. */
export function checkoutPricingLockInstallationSql(schema = 'public'): string {
  const namespace = pricingIdentifier(schema);
  const catalog = inline(pricingCatalogQuery(schema));
  const owner = inline(pricingOwnerQuery(sql.raw('pricing_owner'), schema));
  const create = `CREATE FUNCTION ${namespace}.${PRICING_LOCK_FUNCTION}() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
    AS $pricing_lock$${pricingBody(schema)}$pricing_lock$`;
  return `-- Explicit PG16 checkout pricing capability; NOLOGIN owner must already exist.
-- Set ${PRICING_OWNER_SETTING} locally in this maintenance transaction.
SELECT
  pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
  pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
  pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true),
  pg_catalog.set_config('search_path','pg_catalog,pg_temp',true);
DO $checkout_pricing_install$
DECLARE
  pricing_owner text := nullif(pg_catalog.current_setting('${PRICING_OWNER_SETTING}',true),'');
  owner_oid text;
  namespace_oid integer;
  initial_state jsonb;
  locked_state jsonb;
  final_state jsonb;
BEGIN
  IF pricing_owner IS NULL OR pricing_owner !~ '^[a-z_][a-z0-9_]{0,62}$'
    OR pg_catalog.starts_with(pricing_owner,'pg_') OR pricing_owner='information_schema' THEN
    RAISE EXCEPTION 'Pricing installation requires an explicit safe NOLOGIN owner setting';
  END IF;
  IF pg_catalog.current_setting('server_version_num')::integer/10000<>16
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR pg_catalog.current_setting('session_replication_role')<>'origin'
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Pricing capability requires reviewed PG16 READ COMMITTED';
  END IF;
  SELECT oid::integer INTO namespace_oid FROM pg_catalog.pg_namespace WHERE nspname=${literal(schema)};
  IF namespace_oid IS NULL OR NOT pg_catalog.pg_try_advisory_xact_lock(${PRICING_LOCK_KEY},namespace_oid) THEN
    RAISE EXCEPTION 'Pricing capability maintenance is busy or schema is missing';
  END IF;
  SELECT q.oid INTO owner_oid FROM (${owner}) q;
  IF owner_oid IS NULL THEN
    RAISE EXCEPTION 'Pricing capability owner must be a separate restricted NOLOGIN role';
  END IF;
  SELECT pg_catalog.to_jsonb(q) INTO initial_state FROM (${catalog}) q;
  IF initial_state->>'tablesSafe' IS DISTINCT FROM 'true'
    OR (initial_state->>'absent' IS DISTINCT FROM 'true'
      AND (NOT COALESCE(${ready('initial_state')},false) OR initial_state->>'ownerOid' IS DISTINCT FROM owner_oid)) THEN
    RAISE EXCEPTION 'Pricing capability catalog, owner or ACL drift requires review';
  END IF;
  LOCK TABLE ${namespace}.member_right,${namespace}.system_config IN ACCESS EXCLUSIVE MODE NOWAIT;
  SELECT pg_catalog.to_jsonb(q) INTO locked_state FROM (${catalog}) q;
  IF locked_state IS DISTINCT FROM initial_state THEN
    RAISE EXCEPTION 'Pricing capability changed during installation';
  END IF;
  IF initial_state->>'absent'='true' THEN
    EXECUTE pg_catalog.format(${literal(`GRANT USAGE,CREATE ON SCHEMA ${namespace} TO %I`)},pricing_owner);
    EXECUTE pg_catalog.format(${literal(`GRANT UPDATE ON ${namespace}.member_right,${namespace}.system_config TO %I`)},pricing_owner);
    EXECUTE ${literal(create)};
    REVOKE ALL ON FUNCTION ${namespace}.${PRICING_LOCK_FUNCTION}() FROM PUBLIC;
    EXECUTE pg_catalog.format(${literal(`ALTER FUNCTION ${namespace}.${PRICING_LOCK_FUNCTION}() OWNER TO %I`)},pricing_owner);
    EXECUTE pg_catalog.format(${literal(`REVOKE CREATE ON SCHEMA ${namespace} FROM %I`)},pricing_owner);
  END IF;
  SELECT pg_catalog.to_jsonb(q) INTO final_state FROM (${catalog}) q;
  IF NOT COALESCE(${ready('final_state')},false) OR final_state->>'ownerOid' IS DISTINCT FROM owner_oid THEN
    RAISE EXCEPTION 'Pricing capability final verification failed';
  END IF;
END
$checkout_pricing_install$;
`;
}

export const CHECKOUT_PRICING_LOCK_INSTALLATION_SQL = checkoutPricingLockInstallationSql();
