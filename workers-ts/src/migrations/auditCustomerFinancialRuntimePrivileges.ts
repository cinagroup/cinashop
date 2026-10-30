import { is, sql } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as models from '../models/schema';
import type { DbClient } from '../lib/di';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE, CUSTOMER_FINANCIAL_RUNTIME_CONNECTION_LIMIT, customerFinancialRuntimePrivilegePlan } from './customerFinancialRuntimePlan';
import { MANAGER_PUBLIC_INVOKER_BASELINE } from './managerRuntimePrivilegePlan';
import { inspectCustomerWorkOperation } from './runCustomerWorkOperation';
import { inspectCustomerProductOperation } from './runCustomerProductOperation';
import { inspectCustomerUserOperation } from './runCustomerUserOperation';
import { inspectCustomerFinancialOperation } from './runCustomerFinancialOperation';
import { inspectCustomerWorkScopeLock } from './runCustomerWorkScopeLock';
import { customerWorkScopeCatalogReady } from './customerWorkScopeLock';
import { inspectCustomerProductCatalogLock } from './runCustomerProductCatalogLock';
import { customerProductCatalogReady } from './customerProductCatalogLock';
import { inspectCustomerUserCatalogLock } from './runCustomerUserCatalogLock';
import { customerUserCatalogReady } from './customerUserCatalogLock';
import { inspectCustomerWaybillActor } from './runCustomerWaybillActor';
import { CUSTOMER_CITY_CATALOG_SQL, CUSTOMER_CITY_CATALOG_SHA256 } from './customerCityDelivery';
import { inspectCheckoutPricingLock } from './checkoutPricingLock';
import { pricingCatalogReady } from './checkoutPricingLockCatalog';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { reviewedOfflinePricingOid } from './reviewedOfflinePricingCapability';
import { refundEntityAcceptedPairSql } from './guestRefundEntityCatalog';
import { inspectRuntimePurchaseEvidence, inspectRuntimePurchaseGiftEvidence, inspectRuntimePurchasePhysicalEvidence } from './runtimePurchaseEvidence';
import { inspectCouponTemplateCatalog } from './couponTemplateCatalog';
import { inspectOrderPromotionGiftReceiptCatalog } from './orderPromotionGiftReceipt';
import { inspectRoutinePaymentRuntime, routinePaymentRuntimeTablePrivileges, type RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';
import { outRequestHash } from '../services/out/OutIdempotency';
import { customerManualRefundRuntimePrivilegePlan } from './customerManualRefundRuntimePlan';
import { inspectCustomerFinancialManualRefundRuntime } from './customerFinancialManualRefundRuntime';
import { captureCustomerFinancialOriginalPaymentReaders, CUSTOMER_FINANCIAL_ORIGINAL_PAYMENT_READ_TABLES,
  inspectCustomerFinancialOriginalPaymentReaders, type CustomerFinancialOriginalPaymentReadersAddon } from './customerFinancialOriginalPaymentReaders';

type Query = Pick<DbClient, 'execute'>;
/** Explicit maintenance extension; the historical base plan stays exact. */
export interface CustomerFinancialManualRefundAddon { promotionOwner: string }
function reviewedPlan(manualRefund?: CustomerFinancialManualRefundAddon, originalPaymentReaders?: CustomerFinancialOriginalPaymentReadersAddon) {
  if (originalPaymentReaders) {
    captureCustomerFinancialOriginalPaymentReaders(originalPaymentReaders);
    if (!manualRefund) throw Error('Original-payment readers require the explicitly commissioned manual Financial profile');
  }
  const plan = manualRefund ? customerManualRefundRuntimePrivilegePlan() : customerFinancialRuntimePrivilegePlan();
  if (manualRefund) plan.tables.manager_order_operation_request = ['SELECT'];
  if (originalPaymentReaders) for (const table of CUSTOMER_FINANCIAL_ORIGINAL_PAYMENT_READ_TABLES) plan.tables[table] = ['SELECT'];
  return plan;
}
const sourceTables = new Map(Object.values(models).filter(value => is(value, PgTable)).map(table => {
  const config = getTableConfig(table);
  return [config.name, config.columns.map(column => column.name)] as const;
}));
const sourceSequences = new Map(Object.values(models).filter(value => is(value, PgTable)).flatMap(table => {
  const config = getTableConfig(table);
  return config.columns.filter(column => column.generatedIdentity || ['serial', 'bigserial', 'smallserial'].includes(column.getSQLType()))
    .map(column => {
      const name = column.generatedIdentity?.sequenceName ?? `${config.name}_${column.name}_seq`;
      pricingIdentifier(name);
      return [name, { name, table: config.name, column: column.name }] as const;
    });
}));
// models/schema/admin.ts declares this pgSequence/default explicitly;
// migrations/0104_kefu_visitor_session.sql fixes its OWNED BY. It is not a
// serial column, and must never be inferred from a server-side dependency.
sourceSequences.set('kefu_visitor_uid_seq', {
  name: 'kefu_visitor_uid_seq', table: 'kefu_visitor_session', column: 'visitor_uid',
});

/** The whole existing Customer financial profile, never a subset learned from
 * a fixture or the server's grants. This inspects existing protocols only. */
export async function inspectCustomerFinancialRuntimeCatalogPrerequisites(db: Query, maintenance: string,
  manualRefund?: CustomerFinancialManualRefundAddon, originalPaymentReaders?: CustomerFinancialOriginalPaymentReadersAddon) {
  const failures: string[] = [], plan = reviewedPlan(manualRefund, originalPaymentReaders);
  const relations = await db.execute<{ name: string; ordinary: boolean; columns: string[] }>(sql`SELECT c.relname AS name,
    c.relkind='r' AND c.relpersistence='p' AND NOT(c.relrowsecurity OR c.relforcerowsecurity OR c.relispartition)
      AND NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=c.oid) AS ordinary,
    ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum) AS columns
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v','m','f')`);
  for (const name of Object.keys(plan.tables)) {
    const relation = relations.find(row => row.name === name);
    if (!relation) { failures.push(`missing:${name}`); continue; }
    if (!relation.ordinary) failures.push(`shape:${name}`);
    const expected = sourceTables.get(name);
    for (const column of expected ?? []) if (!relation.columns.includes(column)) failures.push(`missing_column:${name}.${column}`);
    if (expected) for (const column of relation.columns) if (!expected.includes(column)) failures.push(`unexpected_column:${name}.${column}`);
    for (const column of plan.updateColumns[name] ?? []) if (!relation.columns.includes(column)) failures.push(`missing_column:${name}.${column}`);
  }
  const actualSequences = await db.execute<{ name: string; table: string; column: string; ordinary: boolean }>(sql`SELECT s.relname AS name,
    t.relname AS "table",a.attname AS column,s.relpersistence='p' AND t.relnamespace=s.relnamespace
      AND t.relkind='r' AND d.deptype IN('a','i') AS ordinary
    FROM pg_class s JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.refclassid=d.classid
      AND d.objid=s.oid AND d.deptype IN('a','i')
    JOIN pg_class t ON t.oid=d.refobjid JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
    WHERE s.relnamespace='public'::regnamespace AND s.relkind='S'`);
  // A server-side OWNED BY is not a declaration of authority. Only the
  // source's serial/identity column and canonical name may contribute a grant;
  // ordinary integer columns and second sequences are never learned as a plan.
  const ownedSequences = [...sourceSequences.values()].filter(row => plan.tables[row.table]?.includes('INSERT') || plan.standaloneSequences.includes(row.name));
  for (const expected of ownedSequences) {
    const bindings = actualSequences.filter(row => row.table === expected.table && row.column === expected.column);
    if (bindings.length !== 1 || bindings[0].name !== expected.name || bindings[0].ordinary !== true)
      failures.push(`sequence_binding:${expected.name}`);
  }
  for (const actual of actualSequences) if (plan.tables[actual.table]?.includes('INSERT')) {
    const expected = sourceSequences.get(actual.name);
    if (!expected || expected.table !== actual.table || expected.column !== actual.column || actual.ordinary !== true)
      failures.push(`sequence_binding:${actual.name}`);
  }
  const [publicData] = await db.execute(sql`SELECT NOT EXISTS(SELECT 1 FROM pg_class c
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) a
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v','m','f','S') AND a.grantee=0)
    AND NOT EXISTS(SELECT 1 FROM pg_attribute c CROSS JOIN LATERAL aclexplode(c.attacl) a
      WHERE c.attrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace) AND a.grantee=0) AS safe`);
  if (publicData?.safe !== true) failures.push('public_data_authority');
  const scope = await inspectCustomerWorkScopeLock(db), product = await inspectCustomerProductCatalogLock(db), users = await inspectCustomerUserCatalogLock(db);
  if (!customerWorkScopeCatalogReady(scope)) failures.push('customer_scope_catalog');
  if (!customerProductCatalogReady(product)) failures.push('customer_product_lock_catalog');
  if (!customerUserCatalogReady(users)) failures.push('customer_user_lock_catalog');
  for (const [name, inspection] of [
    ['work', await inspectCustomerWorkOperation(db)], ['product', await inspectCustomerProductOperation(db)],
    ['user', await inspectCustomerUserOperation(db)], ['financial', await inspectCustomerFinancialOperation(db)],
  ] as const) if (!inspection.complete) failures.push(`customer_${name}_operation_catalog`);
  const city = await db.execute<{ shape: unknown }>(sql.raw(CUSTOMER_CITY_CATALOG_SQL));
  if (city.length !== 1 || await outRequestHash(city[0].shape) !== CUSTOMER_CITY_CATALOG_SHA256) failures.push('customer_city_catalog');
  if (!(await inspectCustomerWaybillActor(db)).ready) failures.push('customer_waybill_catalog');
  const pricing = await inspectCheckoutPricingLock(db), offline = await reviewedOfflinePricingOid(db, 'public');
  if (!pricingCatalogReady(pricing) || !pricing.functionOid || !offline) failures.push('pricing_catalog');
  const refund = await db.execute<{ invoice: string; split: string; profile: string }>(sql.raw(refundEntityAcceptedPairSql(true)));
  if (refund.length !== 1 || !(refund[0].invoice === 'v2' && refund[0].split === 'v1' && refund[0].profile === 'legacy'
    || refund[0].invoice === 'v3' && refund[0].split === 'v2' && refund[0].profile === 'guest')) failures.push('refund_entity_catalog');
  if (!(await inspectRuntimePurchaseEvidence(db, maintenance)).ready) failures.push('purchase_evidence_catalog');
  if (!(await inspectRuntimePurchaseGiftEvidence(db, maintenance)).ready) failures.push('purchase_gift_catalog');
  if (!(await inspectRuntimePurchasePhysicalEvidence(db, maintenance)).ready) failures.push('purchase_physical_catalog');
  if (!(await inspectCouponTemplateCatalog(db, maintenance)).ready) failures.push('coupon_template_catalog');
  if (!(await inspectOrderPromotionGiftReceiptCatalog(db, maintenance)).ready) failures.push('promotion_gift_catalog');
  const manual = manualRefund ? await inspectCustomerFinancialManualRefundRuntime(db, {
    role: CUSTOMER_FINANCIAL_RUNTIME_ROLE, promotionOwner: manualRefund.promotionOwner, requirePrivileges: false,
  }) : null;
  if (manual && !manual.catalogReady) failures.push(...manual.failures.map(name => `manual:${name}`));
  const originalReaders = originalPaymentReaders ? await inspectCustomerFinancialOriginalPaymentReaders(db, {
    role: CUSTOMER_FINANCIAL_RUNTIME_ROLE, maintenance, readers: originalPaymentReaders, requirePrivileges: false,
  }) : null;
  if (originalReaders && !originalReaders.catalogReady) failures.push(...originalReaders.failures.map(name => `original_payment:${name}`));
  const reviewedDefiners = [...scope.functionOids, ...product.functionOids, ...users.functionOids,
    ...(pricing.functionOid ? [pricing.functionOid] : []), ...(offline ? [offline] : []),
    ...(manual?.catalogReady && manual.manualFunctionOid ? [manual.manualFunctionOid] : [])];
  const unique = [...new Set(failures)].sort();
  return { ready: unique.length === 0, readOnly: true as const, failures: unique, ownedSequences, reviewedDefiners,
    requiredTableCount: Object.keys(plan.tables).length };
}

export interface CustomerFinancialRuntimeInspection {
  requireLogin: boolean;
  routine: { target: RoutinePaymentRuntimeTarget; stage: 'before-customer' | 'ready' };
  manualRefund?: CustomerFinancialManualRefundAddon;
  originalPaymentReaders?: CustomerFinancialOriginalPaymentReadersAddon;
}

/** Maintenance named-role comparison; no SET ROLE or automatic grants. */
export async function inspectCustomerFinancialRuntimePrivileges(db: Query, options: CustomerFinancialRuntimeInspection) {
  if (typeof options.requireLogin !== 'boolean' || !['before-customer', 'ready'].includes(options.routine?.stage))
    throw Error('Explicit Customer financial LOGIN and routine stage required');
  const role = CUSTOMER_FINANCIAL_RUNTIME_ROLE, { target, stage } = options.routine;
  const catalogs = await inspectCustomerFinancialRuntimeCatalogPrerequisites(db, target.maintenance, options.manualRefund, options.originalPaymentReaders);
  const failures = [...catalogs.failures], plan = reviewedPlan(options.manualRefund, options.originalPaymentReaders);
  const manual = options.manualRefund ? await inspectCustomerFinancialManualRefundRuntime(db, {
    role, promotionOwner: options.manualRefund.promotionOwner, requirePrivileges: true,
  }) : null;
  if (manual && !manual.ready) failures.push(...manual.failures.map(name => `manual:${name}`));
  const originalReaders = options.originalPaymentReaders ? await inspectCustomerFinancialOriginalPaymentReaders(db, {
    role, maintenance: target.maintenance, readers: options.originalPaymentReaders, requirePrivileges: true,
  }) : null;
  if (originalReaders && !originalReaders.ready) failures.push(...originalReaders.failures.map(name => `original_payment:${name}`));
  const routine = await inspectRoutinePaymentRuntime(db, target);
  const [binding] = await db.execute(sql`SELECT current_database()=${target.database} AS ready`);
  const included = target.local?.includes(role) === true;
  if (!routine.ready || binding?.ready !== true || (stage === 'ready' ? !included : included)
    || target.app === role || target.admin === role || target.maintenance === role
    || target.caseLock?.runtimeRoles.includes(role)) failures.push('customer_routine_binding');
  if (stage === 'ready' && routine.ready && included) {
    Object.assign(plan.tables, routinePaymentRuntimeTablePrivileges('local'));
    plan.tables.payment_reconciliation_action = ['SELECT'];
  }
  const [identity] = await db.execute(sql`SELECT
    current_setting('server_version_num')::int/10000=16 AS pg16,r.rolcanlogin=${options.requireLogin} AS login_stage,
    r.rolconnlimit=${CUSTOMER_FINANCIAL_RUNTIME_CONNECTION_LIMIT} AS connection_limit,
    NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls) AS restricted,
    NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS no_memberships,
    NOT EXISTS(SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=r.oid AND deptype='o') AS no_ownership,
    has_database_privilege(r.oid,current_database(),'CONNECT') AND has_schema_privilege(r.oid,'public','USAGE') AS connected,
    NOT has_database_privilege(r.oid,current_database(),'CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND has_schema_privilege(r.oid,oid,'CREATE')) AS no_ddl,
    NOT has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM') AS no_replication_bypass,
    NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN('public','information_schema') AND n.nspname NOT LIKE 'pg_%'
      AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE')
        WHEN c.relkind IN('r','p','v','m','f') THEN has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') ELSE false END) AS no_other_schema_data
    FROM pg_roles r WHERE r.rolname=${role}`);
  for (const key of ['pg16', 'login_stage', 'connection_limit', 'restricted', 'no_memberships', 'no_ownership', 'connected', 'no_ddl', 'no_replication_bypass', 'no_other_schema_data'])
    if (identity?.[key] !== true) failures.push(key);
  if (!identity) return { ready: false, profileReady: false, readOnly: true as const, completeServiceCoverageVerified: false as const,
    failures: [...new Set([...failures, 'customer_financial_role_missing'])].sort(), tableCount: 0, sequenceCount: 0 };
  const tables = await db.execute(sql`SELECT c.relname AS name,c.relkind,c.relpersistence,
    c.relrowsecurity OR c.relforcerowsecurity OR c.relispartition
      OR EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
      OR EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=c.oid) AS nonordinary,
    p.privilege,has_table_privilege(${role},c.oid,p.privilege) AS allowed,
    has_table_privilege(${role},c.oid,p.privilege||' WITH GRANT OPTION') AS delegate
    FROM pg_class c CROSS JOIN(VALUES('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege)
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v','m','f')`);
  const present = new Set<string>();
  for (const row of tables) {
    const name = String(row.name), privilege = String(row.privilege); present.add(name);
    if (row.allowed !== (plan.tables[name]?.some(value => value === privilege) ?? false) || row.delegate !== false)
      failures.push(`table:${name}:${privilege}`);
    if (plan.tables[name] && (row.relkind !== 'r' || row.relpersistence !== 'p' || row.nonordinary !== false)) failures.push(`shape:${name}`);
  }
  for (const name of Object.keys(plan.tables)) if (!present.has(name)) failures.push(`missing:${name}`);
  const columns = await db.execute(sql`SELECT c.relname AS name,a.attname AS column,p.privilege,
    has_column_privilege(${role},c.oid,a.attnum,p.privilege) AS allowed,
    has_column_privilege(${role},c.oid,a.attnum,p.privilege||' WITH GRANT OPTION') AS delegate
    FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    CROSS JOIN(VALUES('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(privilege)
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p','v','m','f')`);
  for (const row of columns) {
    const name = String(row.name), column = String(row.column), privilege = String(row.privilege);
    const expected = (plan.tables[name]?.some(value => value === privilege) ?? false)
      || privilege === 'UPDATE' && (plan.updateColumns[name]?.includes(column) ?? false);
    if (row.allowed !== expected || row.delegate !== false) failures.push(`column:${name}.${column}:${privilege}`);
  }
  const expectedSequences = new Set(plan.standaloneSequences);
  for (const row of catalogs.ownedSequences) if (plan.tables[row.table]?.includes('INSERT')) expectedSequences.add(row.name);
  const sequences = await db.execute(sql`SELECT relname AS name,has_sequence_privilege(${role},oid,'USAGE') AS usage,
    has_sequence_privilege(${role},oid,'SELECT,UPDATE') AS extras,
    has_sequence_privilege(${role},oid,'USAGE WITH GRANT OPTION,SELECT WITH GRANT OPTION,UPDATE WITH GRANT OPTION') AS delegate
    FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='S'`);
  for (const row of sequences) if (row.usage !== expectedSequences.has(String(row.name)) || row.extras !== false || row.delegate !== false)
    failures.push(`sequence:${row.name}`);
  for (const name of expectedSequences) if (!sequences.some(row => row.name === name)) failures.push(`missing_sequence:${name}`);
  const routines = await db.execute(sql`SELECT p.oid::text AS oid,p.prosecdef,
    p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS signature,
    CASE WHEN p.prokind IN('f','p') THEN encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') ELSE NULL END AS fingerprint,
    has_function_privilege(${role},p.oid,'EXECUTE') AS executable,
    has_function_privilege(${role},p.oid,'EXECUTE WITH GRANT OPTION') AS delegate
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace`);
  const declared = new Set(plan.functions), reviewed = new Set(catalogs.reviewedDefiners);
  for (const row of routines) {
    const signature = String(row.signature);
    if (row.delegate !== false) failures.push(`routine_delegation:${signature}`);
    if (row.executable !== true) continue;
    const privateInvoker = declared.has(signature) && row.prosecdef === false && signature.startsWith('customer_');
    if (!reviewed.has(String(row.oid)) && !privateInvoker
      && (row.prosecdef !== false || MANAGER_PUBLIC_INVOKER_BASELINE[signature] !== row.fingerprint)) failures.push(`unreviewed_routine:${signature}`);
  }
  for (const signature of declared) if (!routines.some(row => row.signature === signature && row.executable === true && row.delegate === false))
    failures.push(`missing_function:${signature}`);
  const [foreignDefiners] = await db.execute(sql`SELECT NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.prosecdef AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
      AND has_function_privilege(${role},p.oid,'EXECUTE')
      AND NOT(p.oid::text IN(SELECT jsonb_array_elements_text(${JSON.stringify([...reviewed])}::jsonb)))) AS safe`);
  if (foreignDefiners?.safe !== true) failures.push('unreviewed_definer');
  const [defaults] = await db.execute(sql`SELECT NOT EXISTS(SELECT 1 FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname=${role})
      OR(a.grantee=0 AND d.defaclobjtype IN('r','S'))) AS safe`);
  if (defaults?.safe !== true) failures.push('default_grants');
  const unique = [...new Set(failures)].sort(), profileReady = unique.length === 0 && catalogs.ready;
  return { ready: profileReady && options.requireLogin && stage === 'ready', profileReady, readOnly: true as const,
    completeServiceCoverageVerified: false as const, failures: unique, tableCount: present.size, sequenceCount: sequences.length };
}

/** Independently authenticated LOGIN, not a maintenance SET ROLE session. */
export async function auditCustomerFinancialRuntimePrivileges(db: DbClient, target: RoutinePaymentRuntimeTarget,
  manualRefund?: CustomerFinancialManualRefundAddon, originalPaymentReaders?: CustomerFinancialOriginalPaymentReadersAddon) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Root Customer financial connection required');
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),
      set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
      set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
      set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
    const [identity] = await tx.execute(sql`SELECT current_database() AS database,current_user AS role,session_user AS session,
      (SELECT r.rolname FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid()) AS backend_role,
      current_setting('session_replication_role')='origin' AS origin`);
    const result = await inspectCustomerFinancialRuntimePrivileges(tx, { requireLogin: true, routine: { target, stage: 'ready' }, manualRefund, originalPaymentReaders });
    const realLogin = identity?.role === CUSTOMER_FINANCIAL_RUNTIME_ROLE && identity.session === CUSTOMER_FINANCIAL_RUNTIME_ROLE
      && identity.backend_role === CUSTOMER_FINANCIAL_RUNTIME_ROLE && identity.database === target.database && identity.origin === true;
    return { ...result, identity, realLogin, ready: result.ready && realLogin,
      failures: [...new Set([...result.failures, ...(realLogin ? [] : ['connection_identity'])])].sort() };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
