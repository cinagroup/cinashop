import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from './customerFinancialRuntimePlan';
import { CUSTOMER_FINANCIAL_PROVISION_GATE } from './provisionCustomerFinancialRuntime';
import { inspectCustomerFinancialRuntimePrivileges, type CustomerFinancialManualRefundAddon } from './auditCustomerFinancialRuntimePrivileges';
import { captureCustomerFinancialOriginalPaymentReaders, CUSTOMER_FINANCIAL_ORIGINAL_PAYMENT_READ_TABLES,
  inspectCustomerFinancialOriginalPaymentReaders, type CustomerFinancialOriginalPaymentReadersAddon } from './customerFinancialOriginalPaymentReaders';
import { inspectRoutinePaymentRuntime, type RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';
import { CASHIER_SECOND_CARD_MAINTENANCE_LOCK_KEY } from './cashierSecondCardOrigin';

type Query = Pick<DbClient, 'execute'>;
export const CUSTOMER_FINANCIAL_ORIGINAL_PAYMENT_READERS_OPERATION = 'customer-financial-original-payment-readers-v1';
function capture(target: RoutinePaymentRuntimeTarget) {
  const copy = { ...target, local: target.local ? [...target.local] : undefined,
    caseLock: target.caseLock ? { ...target.caseLock, runtimeRoles: [...target.caseLock.runtimeRoles] } : undefined };
  for (const name of [copy.database, copy.maintenance, copy.app, copy.admin, ...(copy.local ?? []),
    ...(copy.caseLock?.runtimeRoles ?? [])]) pricingIdentifier(name);
  if (!copy.local?.includes(CUSTOMER_FINANCIAL_RUNTIME_ROLE)
    || [copy.maintenance, copy.app, copy.admin, ...(copy.caseLock?.runtimeRoles ?? [])].includes(CUSTOMER_FINANCIAL_RUNTIME_ROLE))
    throw Error('Explicit existing Financial direct-lock routine binding required');
  return copy;
}

/** Complete manual profile -> exact immutable original-payment reader addon.
 * No source installer, grants inferred from ACLs, partial repair, credential or
 * history changes. Caller rollback includes all four SELECT grants. */
export async function upgradeCustomerFinancialOriginalPaymentReadersInTransaction(tx: Query,
  declared: RoutinePaymentRuntimeTarget, addon: CustomerFinancialManualRefundAddon,
  input: CustomerFinancialOriginalPaymentReadersAddon) {
  if (Object.hasOwn(tx, '$client')) throw Error('Original-payment reader forward requires a caller-owned transaction');
  const target = capture(declared), manualRefund = { promotionOwner: addon?.promotionOwner };
  pricingIdentifier(manualRefund.promotionOwner);
  const originalPaymentReaders = captureCustomerFinancialOriginalPaymentReaders(input), role = CUSTOMER_FINANCIAL_RUNTIME_ROLE;
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  const [identity] = await tx.execute(sql`SELECT current_database()=${target.database} AND current_user=${target.maintenance}
    AND current_user=session_user AND current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed' AND current_setting('transaction_read_only')='off'
    AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid
      WHERE a.pid=pg_backend_pid() AND r.rolname=current_user AND r.rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') AS ready`);
  if (identity?.ready !== true) throw Error('Original-payment Financial maintenance target refused');
  for (const [key, subkey] of [[731669, 0], [731670, 0], CUSTOMER_FINANCIAL_PROVISION_GATE]) {
    const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${key},${subkey}) AS locked`);
    if (gate?.locked !== true) throw Error('Original-payment reader forward is busy');
  }
  const [namespace] = await tx.execute<{ oid: number }>(sql`SELECT oid::integer AS oid FROM pg_namespace WHERE nspname='public'`);
  if (!Number.isSafeInteger(namespace?.oid)) throw Error('Original-payment reader schema unavailable');
  // Existing manual order first, then independent source-installation gates.
  for (const [key, subkey] of [[731695, namespace.oid], [731711, 0], [731626, 0],
    [CASHIER_SECOND_CARD_MAINTENANCE_LOCK_KEY, 0], [731627, 15], [731627, 16]]) {
    const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${key},${subkey}) AS locked`);
    if (gate?.locked !== true) throw Error('Original-payment reader forward is busy');
  }
  if (!(await inspectRoutinePaymentRuntime(tx, target)).ready) throw Error('Exact Financial routine binding is not commissioned');
  const readyOptions = { requireLogin: true, routine: { target, stage: 'ready' as const }, manualRefund };
  const existing = await inspectCustomerFinancialRuntimePrivileges(tx, { ...readyOptions, originalPaymentReaders });
  if (existing.ready) return { operation: CUSTOMER_FINANCIAL_ORIGINAL_PAYMENT_READERS_OPERATION, changed: false as const,
    role, target, manualRefund, originalPaymentReaders, audit: existing, historicalRowsReassigned: false as const,
    credentialChanged: false as const, sourceWritesGranted: false as const };
  if (!(await inspectCustomerFinancialRuntimePrivileges(tx, readyOptions)).ready)
    throw Error('Exact manual Financial profile required; partial reader grants need separate review');
  const pre = await inspectCustomerFinancialOriginalPaymentReaders(tx, {
    role, maintenance: target.maintenance, readers: originalPaymentReaders, requirePrivileges: false,
  });
  if (!pre.ready || !pre.catalogReady) throw Error('Canonical original-payment sources are not commissioned');
  await tx.execute(sql.raw('LOCK TABLE ONLY public.routine_identity_witness, ONLY public.routine_payment_attempt, '
    + 'ONLY public.payment_reconciliation_action, ONLY public.customer_financial_operation_request, '
    + 'ONLY public.customer_financial_manual_refund_v1, ONLY public.store_order_promotions, ONLY public.manager_order_operation_request, '
    + 'ONLY public.cashier_second_card_cart_v1, ONLY public.cashier_second_card_origin_v1, ONLY public.cashier_second_card_payment_v1, '
    + 'ONLY public.supplier_order_edit_operation_v1, ONLY public.legacy_order_gain_partition_v1 IN ACCESS EXCLUSIVE MODE NOWAIT'));
  if (!(await inspectCustomerFinancialRuntimePrivileges(tx, readyOptions)).ready)
    throw Error('Manual Financial profile changed while locking');
  const locked = await inspectCustomerFinancialOriginalPaymentReaders(tx, {
    role, maintenance: target.maintenance, readers: originalPaymentReaders, requirePrivileges: false,
  });
  if (!locked.ready || JSON.stringify(locked.sourceBindings) !== JSON.stringify(pre.sourceBindings)
    || JSON.stringify(locked.validatorBindings) !== JSON.stringify(pre.validatorBindings))
    throw Error('Original-payment source binding changed while locking');
  await tx.execute(sql.raw(`GRANT SELECT ON TABLE ${CUSTOMER_FINANCIAL_ORIGINAL_PAYMENT_READ_TABLES
    .map(table => 'public.' + pricingIdentifier(table)).join(',')} TO ${pricingIdentifier(role)}`));
  const audit = await inspectCustomerFinancialRuntimePrivileges(tx, { ...readyOptions, originalPaymentReaders });
  if (!audit.ready || !(await inspectRoutinePaymentRuntime(tx, target)).ready) throw Error('Final complete original-payment reader profile refused');
  return { operation: CUSTOMER_FINANCIAL_ORIGINAL_PAYMENT_READERS_OPERATION, changed: true as const,
    role, target, manualRefund, originalPaymentReaders, audit, historicalRowsReassigned: false as const,
    credentialChanged: false as const, sourceWritesGranted: false as const };
}

export async function upgradeCustomerFinancialOriginalPaymentReaders(db: DbClient, declared: RoutinePaymentRuntimeTarget,
  addon: CustomerFinancialManualRefundAddon, readers: CustomerFinancialOriginalPaymentReadersAddon) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Root Financial maintenance connection required');
  const target = capture(declared), manualRefund = { promotionOwner: addon?.promotionOwner };
  pricingIdentifier(manualRefund.promotionOwner); const originalPaymentReaders = captureCustomerFinancialOriginalPaymentReaders(readers);
  try { return await db.transaction(tx => upgradeCustomerFinancialOriginalPaymentReadersInTransaction(tx, target, manualRefund, originalPaymentReaders),
    { isolationLevel: 'read committed', accessMode: 'read write' }); }
  catch { throw Error('Original-payment reader forward outcome not confirmed; inspect the exact profile before further action'); }
}
