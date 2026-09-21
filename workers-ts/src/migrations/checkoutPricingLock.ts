import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { PRICING_LOCK_FUNCTION, PRICING_LOCK_KEY, PRICING_OWNER_SETTING,
  pricingCatalogQuery, pricingCatalogReady, pricingIdentifier } from './checkoutPricingLockCatalog';
import { checkoutPricingLockInstallationSql } from './checkoutPricingLockInstallation';
import { reviewedOfflinePricingOid, validatePricingRuntimeScope, type PricingRuntimeScope } from './reviewedOfflinePricingCapability';

const installationErrors = new Set([
  'Pricing installation requires an explicit safe NOLOGIN owner setting',
  'Pricing capability requires reviewed PG16 READ COMMITTED',
  'Pricing capability maintenance is busy or schema is missing',
  'Pricing capability owner must be a separate restricted NOLOGIN role',
  'Pricing capability catalog, owner or ACL drift requires review',
  'Pricing capability changed during installation',
  'Pricing capability final verification failed',
]);

type Query = Pick<DbClient, 'execute'>;
type Root = Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>;
function requireRoot(db: Root) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Pricing maintenance requires a root database');
}
async function gate(tx: Query, schema: string, shared: boolean) {
  pricingIdentifier(schema);
  const [row] = await tx.execute(sql`SELECT ${shared
    ? sql`pg_catalog.pg_try_advisory_xact_lock_shared(${PRICING_LOCK_KEY},n.oid::integer)`
    : sql`pg_catalog.pg_try_advisory_xact_lock(${PRICING_LOCK_KEY},n.oid::integer)`} AS locked
    FROM pg_catalog.pg_namespace n WHERE n.nspname=${schema}`);
  if (row?.locked !== true) throw Error('Pricing capability maintenance is busy or schema is missing');
}


/** Exact shared catalog envelope, not the full application schema contract. */
export async function inspectCheckoutPricingLock(tx: Query, schema = 'public') {
  const [row] = await tx.execute(pricingCatalogQuery(schema));
  if (!row) throw Error('Pricing capability catalog unavailable');
  return { tablesSafe: row.tablesSafe === true, absent: row.absent === true,
    definitionSafe: row.definitionSafe === true, ownerSafe: row.ownerSafe === true, aclSafe: row.aclSafe === true,
    ownerOid: typeof row.ownerOid === 'string' ? row.ownerOid : null,
    functionOid: typeof row.functionOid === 'string' ? row.functionOid : null };
}

/** Explicit commissioning only. Uses the same atomic SQL as numbered migration;
 * never creates roles/credentials, rewrites drift or grants caller config DML. */
export async function installCheckoutPricingLock(db: Root, ownerRole: string | undefined, schema = 'public') {
  requireRoot(db); if (ownerRole !== undefined) pricingIdentifier(ownerRole); pricingIdentifier(schema);
  return db.transaction(async tx => {
    // Undefined is only for the numbered migration runner: the transaction's
    // explicit owner setting must already exist, or the shared SQL refuses.
    if (ownerRole !== undefined)
      await tx.execute(sql`SELECT pg_catalog.set_config(${PRICING_OWNER_SETTING},${ownerRole},true)`);
    try { await tx.execute(sql.raw(checkoutPricingLockInstallationSql(schema))); }
    catch (error) {
      // Preserve fixed protocol refusals without surfacing a whole SQL statement
      // as the top-level error. Other database errors keep their original cause.
      let cause: unknown = error;
      for (let depth=0;depth<8 && cause && typeof cause==='object';depth++) {
        if ('code' in cause && cause.code==='P0001' && 'message' in cause
          && typeof cause.message==='string' && installationErrors.has(cause.message))
          throw new Error(cause.message, { cause: error });
        if (!('cause' in cause) || cause.cause===cause) break;
        cause=cause.cause;
      }
      throw error;
    }
    const result = await inspectCheckoutPricingLock(tx, schema);
    if (!pricingCatalogReady(result)) throw Error('Pricing capability final verification failed');
    return result;
  }, { isolationLevel: 'read committed', accessMode: 'read write' });
}

/** Read-only inspection of real connection identity and all membership paths.
 * Deliberately conservative: even NOINHERIT / SET-false ancestry is included.
 * This is the two-configuration-table envelope, not a complete app audit. */
export async function auditCheckoutPricingLockRuntime(tx: Query, schema = 'public', scope: PricingRuntimeScope = 'isolated') {
  validatePricingRuntimeScope(scope);
  pricingIdentifier(schema);
  const state=await inspectCheckoutPricingLock(tx,schema);
  const offlineOid = scope === 'shared-shop' ? await reviewedOfflinePricingOid(tx, schema) : null;
  const [row]=await tx.execute(sql`WITH RECURSIVE identities AS (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (current_user,session_user)
    UNION SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()
  ), authority(oid) AS (
    SELECT oid FROM identities UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN authority a ON a.oid=m.member
  ), relations AS (
    SELECT c.oid,c.relowner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=${schema} AND c.relname IN ('member_right','system_config')
  ) SELECT
    EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid() AND usesysid IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM authority a JOIN pg_catalog.pg_roles r ON r.oid=a.oid
      WHERE r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
        OR r.oid::text=${state.ownerOid} OR pg_catalog.has_schema_privilege(r.oid,${schema},'CREATE')
        OR pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET')
        OR pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM')
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datname=current_database() AND datdba=r.oid)
        OR EXISTS(SELECT 1 FROM relations c WHERE c.relowner=r.oid
          OR pg_catalog.has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES'))) AS "callerSafe",
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE p.prosecdef AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
        AND p.oid::text IS DISTINCT FROM ${state.functionOid}
        AND p.oid::text IS DISTINCT FROM ${offlineOid}
        AND EXISTS(SELECT 1 FROM authority a WHERE pg_catalog.has_function_privilege(a.oid,p.oid,'EXECUTE'))) AS "noUnreviewedDefinerRoutine",
    (SELECT count(*)=2 AND bool_and(pg_catalog.has_table_privilege(current_user,oid,'SELECT')) FROM relations)
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid::text=${state.functionOid}
        AND pg_catalog.has_function_privilege(current_user,oid,'EXECUTE')) AS "requiredPrivileges"`);
  return { ready: pricingCatalogReady(state) && row?.callerSafe===true && row?.requiredPrivileges===true && row?.noUnreviewedDefinerRoutine===true,
    catalogReady: pricingCatalogReady(state), callerSafe: row?.callerSafe===true, requiredPrivileges: row?.requiredPrivileges===true,
    noUnreviewedDefinerRoutine: row?.noUnreviewedDefinerRoutine===true };
}

/** Must run inside the caller's existing READ COMMITTED write transaction, not
 * on a root/autocommit connection. No DDL, grant, automatic retry or fallback. */
export async function acquireCheckoutPricingLock(tx: DbClient, schema = 'public') {
  if (Object.hasOwn(tx,'$client')) throw Error('Pricing capability must be acquired inside the business transaction');
  const namespace=pricingIdentifier(schema);
  await gate(tx,schema,true);
  if (!pricingCatalogReady(await inspectCheckoutPricingLock(tx,schema))) throw Error('Pricing capability is missing or requires review');
  await tx.execute(sql.raw(`SELECT ${namespace}.${PRICING_LOCK_FUNCTION}()`));
}
