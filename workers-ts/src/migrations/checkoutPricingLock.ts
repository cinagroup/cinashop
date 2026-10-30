import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { PRICING_LOCK_FUNCTION, PRICING_LOCK_KEY, PRICING_OWNER_SETTING,
  pricingCatalogQuery, pricingCatalogReady, pricingIdentifier } from './checkoutPricingLockCatalog';
import { checkoutPricingLockInstallationSql } from './checkoutPricingLockInstallation';
import { reviewedOfflinePricingOid, validatePricingRuntimeScope, type PricingRuntimeScope } from './reviewedOfflinePricingCapability';
import { managerScopeLockReadiness } from './runManagerScopeLock';
import { customerWorkScopeLockReadiness } from './runCustomerWorkScopeLock';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from './customerFinancialRuntimePlan';

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
  const ordinaryScope=scope==='customer-work-ordinary',customerScopeSelected=scope==='customer-work'||ordinaryScope;
  // The complete fixed financial LOGIN also carries the two mature taxonomy
  // locks. Only its actual session/backend identity selects this envelope;
  // names still cannot exempt a function without its full catalog/ACL proof.
  let financialLogin=false;
  if(scope==='customer-work'&&schema==='public'){
    const [identity]=await tx.execute(sql`SELECT current_user=${CUSTOMER_FINANCIAL_RUNTIME_ROLE}
      AND session_user=current_user AND current_setting('server_version_num')::integer/10000=16
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
        WHERE a.pid=pg_catalog.pg_backend_pid() AND r.rolname=current_user) AS ready`);
    financialLogin=identity?.ready===true;
  }
  const taxonomyScope=ordinaryScope||financialLogin;
  const sharedScope = scope === 'shared-shop' || customerScopeSelected;
  const offlineOid = sharedScope ? await reviewedOfflinePricingOid(tx, schema) : null;
  const managerScope = sharedScope ? await managerScopeLockReadiness(tx,schema) : null;
  const customerScope = customerScopeSelected ? await customerWorkScopeLockReadiness(tx,schema) : null;
  // The customer-work envelope may compose each mature capability after its
  // complete proof, including a separately commissioned cashier principal.
  // The ordinary/fixed-Financial pair remains mandatory exactly as before.
  // Their actual full definition/owner/ACL, taxonomy SELECT-only authority and
  // this independent LOGIN's EXECUTE must verify before any OID exemption.
  const inspectTaxonomy=taxonomyScope||(scope==='customer-work'&&schema==='public');
  const productCatalog=inspectTaxonomy?await(await import('./runCustomerProductCatalogLock')).customerProductCatalogLockReadiness(tx,schema):null;
  const userCatalog=inspectTaxonomy?await(await import('./runCustomerUserCatalogLock')).customerUserCatalogLockReadiness(tx,schema):null;
  const ordinaryOids=[...(productCatalog?.ready?productCatalog.catalog.functionOids:[]),...(userCatalog?.ready?userCatalog.catalog.functionOids:[])];
  // Exact catalog, NOLOGIN owner and caller ACL verification precedes OID use.
  // A matching function name cannot exempt an unknown definer routine.
  const managerOids = managerScope?.ready ? managerScope.catalog.functionOids : [];
  const managerCapabilityOids = sharedScope && schema==='public'
    ? await(await import('./managerRuntimeCapabilities')).reviewedManagerRuntimeCapabilityOids(tx) : [];
  // Only this explicit customer scope admits the three exact reviewed lock
  // capabilities. Catalog, owner, ACL and this LOGIN's EXECUTE must all pass.
  const customerOids = customerScope?.ready ? customerScope.catalog.functionOids : [];
  const manualOid=customerScopeSelected&&schema==='public'
    ?await(await import('./runCustomerManualRefund')).reviewedCustomerManualRefundPromotionOid(tx):null;
  // A separately commissioned Supplier feature may share this actual LOGIN.
  // Only its exact addon/owner/ACL proof admits this fixed definer; the frozen
  // default profile and every original owner predicate stay unchanged.
  const supplierManualOids=sharedScope&&schema==='public'
    ?await(await import('./supplierManualRefund')).reviewedSupplierManualRefundCapabilityOids(tx):[];
  // A separately installed message receipt writer shares only the explicit
  // shop LOGIN. Exempt its actual OID only after exact body/owner/ACL/table
  // review; the isolated pricing scope never accepts this additional writer.
  const messageRead=sharedScope&&schema==='public'
    ?await(await import('./userMessageReadCapability')).inspectUserMessageReadCapability(tx):null;
  // Only the shared whole-shop App may also execute this separately installed
  // Supplier label port. Its exact function, dedicated owner, ACL and runtime
  // denials must verify; its owner has no pricing/configuration write rights.
  const supplierLabel=scope==='shared-shop'&&schema==='public'
    ?await(await import('./supplierProductLabelCapability')).inspectSupplierProductLabelCapability(tx):null;
  const supplierLabelOids=supplierLabel?.ready&&supplierLabel.functionOid?[supplierLabel.functionOid]:[];
  const reviewedOids = [...managerOids,...managerCapabilityOids,...customerOids,...(manualOid?[manualOid]:[]),
    ...supplierManualOids,...ordinaryOids,...supplierLabelOids,...(messageRead?.ready&&messageRead.functionOid?[messageRead.functionOid]:[])];
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
        AND NOT (p.oid::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(reviewedOids)}::jsonb)))
        AND EXISTS(SELECT 1 FROM authority a WHERE pg_catalog.has_function_privilege(a.oid,p.oid,'EXECUTE'))) AS "noUnreviewedDefinerRoutine",
    (SELECT count(*)=2 AND bool_and(pg_catalog.has_table_privilege(current_user,oid,'SELECT')) FROM relations)
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid::text=${state.functionOid}
        AND pg_catalog.has_function_privilege(current_user,oid,'EXECUTE')) AS "requiredPrivileges"`);
  return { ready: pricingCatalogReady(state) && row?.callerSafe===true && row?.requiredPrivileges===true && row?.noUnreviewedDefinerRoutine===true
      && (!customerScopeSelected || customerScope?.ready===true)
      && (!taxonomyScope || (productCatalog?.ready===true&&userCatalog?.ready===true)),
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
