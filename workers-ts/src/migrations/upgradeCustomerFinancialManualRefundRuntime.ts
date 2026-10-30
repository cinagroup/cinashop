import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from './customerFinancialRuntimePlan';
import { CUSTOMER_FINANCIAL_PROVISION_GATE } from './provisionCustomerFinancialRuntime';
import { inspectCustomerFinancialRuntimePrivileges, type CustomerFinancialManualRefundAddon } from './auditCustomerFinancialRuntimePrivileges';
import { inspectCustomerFinancialManualRefundRuntime } from './customerFinancialManualRefundRuntime';
import { customerManualManagerOriginReadGrantSql } from './customerManualOfflineOriginCatalog';
import { inspectRoutinePaymentRuntime, type RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';

type Query = Pick<DbClient, 'execute'>;
export const CUSTOMER_FINANCIAL_MANUAL_FORWARD_OPERATION = 'customer-financial-manual-refund-forward-v1';

function capture(target: RoutinePaymentRuntimeTarget): RoutinePaymentRuntimeTarget {
  const copy = { ...target, local: target.local ? [...target.local] : undefined,
    caseLock: target.caseLock ? { ...target.caseLock, runtimeRoles: [...target.caseLock.runtimeRoles] } : undefined };
  for (const name of [copy.database, copy.maintenance, copy.app, copy.admin, ...(copy.local ?? []),
    ...(copy.caseLock?.runtimeRoles ?? [])]) pricingIdentifier(name);
  if (!copy.local?.includes(CUSTOMER_FINANCIAL_RUNTIME_ROLE)
    || [copy.maintenance, copy.app, copy.admin, ...(copy.caseLock?.runtimeRoles ?? [])].includes(CUSTOMER_FINANCIAL_RUNTIME_ROLE))
    throw Error('Explicit existing Financial direct-lock routine binding required');
  return copy;
}

/** Existing fixed LOGIN only. Canonical protocols, the promotion guard and an
 * explicit restricted NOLOGIN manual owner must already be commissioned. Nothing
 * installs/repairs a protocol, widens the base profile or rotates a credential.
 * The original routine principals and all historical evidence stay unchanged. */
export async function upgradeCustomerFinancialManualRefundRuntimeInTransaction(tx: Query,
  declared: RoutinePaymentRuntimeTarget, addon: CustomerFinancialManualRefundAddon) {
  if (Object.hasOwn(tx, '$client')) throw Error('Manual Financial forward requires a caller-owned transaction');
  const target = capture(declared), promotionOwner = addon?.promotionOwner;
  pricingIdentifier(promotionOwner);
  const manualRefund = { promotionOwner }, role = CUSTOMER_FINANCIAL_RUNTIME_ROLE;
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
  if (identity?.ready !== true) throw Error('Manual Financial maintenance target refused');
  for (const [key, subkey] of [[731669, 0], [731670, 0], CUSTOMER_FINANCIAL_PROVISION_GATE]) {
    const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${key},${subkey}) AS locked`);
    if (gate?.locked !== true) throw Error('Manual Financial forward is busy');
  }
  const [namespace] = await tx.execute<{ oid: number }>(sql`SELECT oid::integer AS oid FROM pg_namespace WHERE nspname='public'`);
  if (!Number.isSafeInteger(namespace?.oid)) throw Error('Manual Financial schema unavailable');
  for (const [key, subkey] of [[731695, namespace.oid], [731711, 0], [731626, 0]]) {
    const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${key},${subkey}) AS locked`);
    if (gate?.locked !== true) throw Error('Manual Financial forward is busy');
  }
  if (!(await inspectRoutinePaymentRuntime(tx, target)).ready) throw Error('Exact Financial routine binding is not commissioned');
  const readyOptions = { requireLogin: true, routine: { target, stage: 'ready' as const } };
  const existing = await inspectCustomerFinancialRuntimePrivileges(tx, { ...readyOptions, manualRefund });
  if (existing.ready) return { operation: CUSTOMER_FINANCIAL_MANUAL_FORWARD_OPERATION, role,
    changed: false as const, commissioned: true as const, manualRefund, target, audit: existing,
    historicalRowsReassigned: false as const, credentialChanged: false as const };
  const before = await inspectCustomerFinancialRuntimePrivileges(tx, readyOptions);
  if (!before.ready) throw Error('Exact unextended Financial base profile required; partial grants need separate review');
  const pre = await inspectCustomerFinancialManualRefundRuntime(tx, { role, promotionOwner, requirePrivileges: false });
  if (!pre.ready || !pre.catalogReady || !pre.manualFunctionOid
    || pre.promotionSequence?.name !== 'store_order_promotions_id_seq')
    throw Error('Manual Financial canonical prerequisites are not commissioned');

  // Nonblocking locks keep the source catalogs stable through all grants and
  // their final full-profile comparison. Runtime traffic never takes this path.
  await tx.execute(sql.raw('LOCK TABLE ONLY public.routine_identity_witness, ONLY public.routine_payment_attempt, '
    + 'ONLY public.payment_reconciliation_action, ONLY public.customer_financial_operation_request, '
    + 'ONLY public.customer_financial_manual_refund_v1, ONLY public.store_order_promotions, '
    + 'ONLY public.manager_order_operation_request IN ACCESS EXCLUSIVE MODE NOWAIT'));
  if (!(await inspectCustomerFinancialRuntimePrivileges(tx, readyOptions)).ready)
    throw Error('Financial base profile changed while locking');
  const locked = await inspectCustomerFinancialManualRefundRuntime(tx, { role, promotionOwner, requirePrivileges: false });
  if (!locked.ready || locked.manualFunctionOid !== pre.manualFunctionOid
    || locked.promotionOwnerOid !== pre.promotionOwnerOid
    || locked.promotionSequence?.name !== pre.promotionSequence.name)
    throw Error('Manual Financial prerequisites changed while locking');

  await tx.execute(sql`GRANT SELECT,INSERT ON TABLE public.store_order_promotions,public.customer_financial_manual_refund_v1 TO ${sql.identifier(role)}`);
  await tx.execute(sql`GRANT USAGE ON SEQUENCE public.store_order_promotions_id_seq TO ${sql.identifier(role)}`);
  // This grant is deliberately inside the checked, locked transaction. The
  // full generic owner-only UPDATE trigger and its exact manual-owner DELETE
  // exception were verified above; a bare grant compiler is never exported.
  await tx.execute(sql`GRANT UPDATE(id) ON TABLE public.store_order_promotions TO ${sql.identifier(role)}`);
  await tx.execute(sql`GRANT EXECUTE ON FUNCTION public.customer_manual_refund_promotion_delete_v1(integer,integer) TO ${sql.identifier(role)}`);
  await tx.execute(sql.raw(customerManualManagerOriginReadGrantSql(role)));
  const audit = await inspectCustomerFinancialRuntimePrivileges(tx, { ...readyOptions, manualRefund });
  if (!audit.ready || !(await inspectRoutinePaymentRuntime(tx, target)).ready)
    throw Error('Final complete manual Financial profile refused');
  return { operation: CUSTOMER_FINANCIAL_MANUAL_FORWARD_OPERATION, role, changed: true as const,
    commissioned: true as const, manualRefund, target, audit,
    historicalRowsReassigned: false as const, credentialChanged: false as const };
}

export async function upgradeCustomerFinancialManualRefundRuntime(db: DbClient,
  declared: RoutinePaymentRuntimeTarget, addon: CustomerFinancialManualRefundAddon) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Root Financial maintenance connection required');
  const target = capture(declared), manualRefund = { promotionOwner: addon?.promotionOwner };
  pricingIdentifier(manualRefund.promotionOwner);
  try {
    return await db.transaction(tx => upgradeCustomerFinancialManualRefundRuntimeInTransaction(tx, target, manualRefund),
      { isolationLevel: 'read committed', accessMode: 'read write' });
  } catch {
    throw Error('Manual Financial forward outcome not confirmed; inspect the exact profile before further action');
  }
}
