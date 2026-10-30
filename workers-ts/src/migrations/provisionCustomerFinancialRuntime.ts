import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE, CUSTOMER_FINANCIAL_RUNTIME_CONNECTION_LIMIT, customerFinancialRuntimeGrantSql } from './customerFinancialRuntimePlan';
import { inspectCustomerFinancialRuntimeCatalogPrerequisites, inspectCustomerFinancialRuntimePrivileges } from './auditCustomerFinancialRuntimePrivileges';
import { inspectRoutinePaymentRuntime, type RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';

type Query = Pick<DbClient, 'execute'>;
export const CUSTOMER_FINANCIAL_PROVISION_OPERATION = 'provision-customer-financial-runtime-v1';
export const CUSTOMER_FINANCIAL_PROVISION_GATE = [731665, 1] as const;
export const CUSTOMER_FINANCIAL_PROVISION_CONNECTION_LIMIT = CUSTOMER_FINANCIAL_RUNTIME_CONNECTION_LIMIT;

const capture = (previous: RoutinePaymentRuntimeTarget): RoutinePaymentRuntimeTarget => ({ ...previous,
  local: previous.local ? [...previous.local] : undefined,
  caseLock: previous.caseLock ? { ...previous.caseLock, runtimeRoles: [...previous.caseLock.runtimeRoles] } : undefined });

/** Existing global principals stay exact. This whole Customer profile already
 * has approved case UPDATE and uses direct locking; no definer is added. */
export function customerFinancialRuntimeSuccessor(previous: RoutinePaymentRuntimeTarget): RoutinePaymentRuntimeTarget {
  previous = capture(previous);
  for (const name of [previous.database, previous.maintenance, previous.app, previous.admin]) pricingIdentifier(name);
  if ([previous.maintenance, previous.app, previous.admin, ...(previous.local ?? []), ...(previous.caseLock?.runtimeRoles ?? [])]
    .includes(CUSTOMER_FINANCIAL_RUNTIME_ROLE)) throw Error('Explicit pre-Customer routine binding required');
  return { ...previous, local: [...(previous.local ?? []), CUSTOMER_FINANCIAL_RUNTIME_ROLE].sort() };
}

/** Atomic fixed fresh role only. All protocols and the exact prior global
 * binding must already exist. Caller rollback includes role/password/addon.
 * Never repairs an existing role, installs missing catalogs or rewrites rows. */
export async function provisionCustomerFinancialRuntimeInTransaction(tx: Query, password: string, previous: RoutinePaymentRuntimeTarget) {
  if (Object.hasOwn(tx, '$client')) throw Error('Customer commissioning requires a caller-owned transaction');
  if (!/^[a-f0-9]{64}$/.test(password)) throw Error('A generated Customer financial credential is required');
  previous = capture(previous);
  const target = customerFinancialRuntimeSuccessor(previous), role = CUSTOMER_FINANCIAL_RUNTIME_ROLE;
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true),
    set_config('password_encryption','scram-sha-256',true)`);
  const [identity] = await tx.execute(sql`SELECT current_database()=${target.database} AND current_user=${target.maintenance}
    AND session_user=current_user AND current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed' AND current_setting('transaction_read_only')='off'
    AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid() AND r.rolname=current_user AND r.rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') AS ready`);
  if (identity?.ready !== true) throw Error('Customer financial maintenance target refused');
  for (const [key, subkey] of [[731669, 0], [731670, 0], CUSTOMER_FINANCIAL_PROVISION_GATE]) {
    const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${key},${subkey}) AS locked`);
    if (gate?.locked !== true) throw Error('Customer financial commissioning is busy');
  }
  const existing = await tx.execute(sql`SELECT oid FROM pg_roles WHERE rolname=${role}`);
  if (existing.length) throw Error('Existing fixed Customer financial role requires separate review');
  const prior = await inspectRoutinePaymentRuntime(tx, previous);
  if (!prior.ready) throw Error('Exact prior routine binding is not commissioned');
  const catalogs = await inspectCustomerFinancialRuntimeCatalogPrerequisites(tx, target.maintenance);
  if (!catalogs.ready) throw Error(`Customer financial prerequisites refused: ${catalogs.failures.join(',')}`);
  await tx.execute(sql.raw('LOCK TABLE ONLY public.routine_identity_witness, ONLY public.routine_payment_attempt, ONLY public.payment_reconciliation_action IN ACCESS EXCLUSIVE MODE NOWAIT'));
  if (!(await inspectRoutinePaymentRuntime(tx, previous)).ready) throw Error('Prior routine binding changed while locking');
  await tx.execute(sql.raw(`CREATE ROLE ${pricingIdentifier(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${CUSTOMER_FINANCIAL_PROVISION_CONNECTION_LIMIT}`));
  await tx.execute(sql`GRANT CONNECT ON DATABASE ${sql.identifier(target.database)} TO ${sql.identifier(role)}`);
  await tx.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(role)}`);
  for (const grant of customerFinancialRuntimeGrantSql(role, catalogs.ownedSequences)) await tx.execute(sql.raw(grant));
  const staged = await inspectCustomerFinancialRuntimePrivileges(tx, { requireLogin: false, routine: { target: previous, stage: 'before-customer' } });
  if (!staged.profileReady || staged.ready) throw Error(`NOLOGIN Customer financial profile refused: ${staged.failures.join(',')}`);
  await tx.execute(sql.raw(`GRANT SELECT ON public.routine_payment_attempt, public.payment_reconciliation_action TO ${pricingIdentifier(role)}`));
  // Strict hex credential is never logged or returned. LOGIN remains invisible
  // to other backends until this entire maintenance transaction commits.
  await tx.execute(sql.raw(`ALTER ROLE ${pricingIdentifier(role)} PASSWORD '${password}' LOGIN`));
  if (!(await inspectRoutinePaymentRuntime(tx, target)).ready) throw Error('Customer financial routine successor failed verification');
  const audit = await inspectCustomerFinancialRuntimePrivileges(tx, { requireLogin: true, routine: { target, stage: 'ready' } });
  if (!audit.ready) throw Error(`Final Customer financial profile refused: ${audit.failures.join(',')}`);
  return { operation: CUSTOMER_FINANCIAL_PROVISION_OPERATION, created: true as const, commissioned: true as const,
    role, target, audit, historicalRowsReassigned: false as const, businessValidationRequired: true as const };
}

export async function provisionCustomerFinancialRuntime(db: DbClient, password: string, previous: RoutinePaymentRuntimeTarget) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Root Customer financial maintenance connection required');
  previous = capture(previous);
  customerFinancialRuntimeSuccessor(previous);
  if (!/^[a-f0-9]{64}$/.test(password)) throw Error('A generated Customer financial credential is required');
  try {
    return await db.transaction(tx => provisionCustomerFinancialRuntimeInTransaction(tx, password, previous),
      { isolationLevel: 'read committed', accessMode: 'read write' });
  } catch { throw Error('Customer financial commissioning outcome not confirmed; inspect the fixed role before further action'); }
}
