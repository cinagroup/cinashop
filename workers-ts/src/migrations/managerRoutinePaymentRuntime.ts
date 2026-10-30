import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { MANAGER_RUNTIME_ROLE } from './managerRuntimePrivilegePlan';
import { inspectManagerRuntimePrivileges } from './auditManagerRuntimePrivileges';
import { inspectRoutinePaymentRuntime, type RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';
import { inspectLocalPaymentCaseLock, installLocalPaymentCaseLock, LOCAL_PAYMENT_CASE_LOCK_SIGNATURE } from './localPaymentCaseLock';

type Query = Pick<DbClient, 'execute'>;
export interface ManagerRoutinePaymentForward {
  /** Reviewed, already commissioned binding, before this fixed manager delta. */
  previous: RoutinePaymentRuntimeTarget;
  caseLockOwner: string;
}
export const MANAGER_ROUTINE_PAYMENT_OPERATION = 'manager-routine-payment-runtime-v1';

/** The successor is source-derived; no server ACL is converted into a plan. */
export function managerRoutinePaymentSuccessor(input: ManagerRoutinePaymentForward): RoutinePaymentRuntimeTarget {
  const prior = input.previous;
  pricingIdentifier(input.caseLockOwner); pricingIdentifier(prior.database);
  if ([prior.maintenance, prior.app, prior.admin, ...(prior.local ?? [])].includes(MANAGER_RUNTIME_ROLE)
    || prior.caseLock && prior.caseLock.owner !== input.caseLockOwner)
    throw Error('Explicit pre-manager routine binding required');
  return { ...prior, local: [...(prior.local ?? []), MANAGER_RUNTIME_ROLE].sort(),
    caseLock: { owner: input.caseLockOwner, runtimeRoles: [...(prior.caseLock?.runtimeRoles ?? []), MANAGER_RUNTIME_ROLE].sort() } };
}

/** Explicit exact-prior -> fixed-successor forward. The generic installer
 * continues to refuse partial ACLs. No role/password changes, historical row
 * updates, request-time repair, provider calls or authority reassignment. */
export async function installManagerRoutinePaymentInTransaction(tx: Query, input: ManagerRoutinePaymentForward) {
  if (Object.hasOwn(tx, '$client')) throw Error('Manager routine forward requires a caller-owned transaction');
  const target = managerRoutinePaymentSuccessor(input);
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  const [identity] = await tx.execute(sql`SELECT current_database()=${target.database} AND current_user=${target.maintenance}
    AND session_user=current_user AND current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed' AND current_setting('transaction_read_only')='off'
    AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid() AND r.rolname=current_user AND r.rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') AS ready`);
  if (identity?.ready !== true) throw Error('Manager routine maintenance target refused');
  // Same order as Mini storage maintenance, before case/business resources.
  for (const [key, subkey] of [[731669, 0], [731670, 0], [731812, 1]]) {
    const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${key},${subkey}) AS locked`);
    if (gate?.locked !== true) throw Error('Manager routine maintenance is busy');
  }
  const storage = await inspectRoutinePaymentRuntime(tx, target);
  if (!storage.storageReady) throw Error('Manager routine storage requires prior installation');
  await tx.execute(sql.raw('LOCK TABLE ONLY public.routine_identity_witness, ONLY public.routine_payment_attempt, ONLY public.payment_reconciliation_action, ONLY public.payment_reconciliation_case IN ACCESS EXCLUSIVE MODE NOWAIT'));
  const successor = await inspectRoutinePaymentRuntime(tx, target);
  if (successor.ready) {
    const audit = await inspectManagerRuntimePrivileges(tx, { requireLogin: true, routine: { target, stage: 'ready' } });
    if (!audit.ready) throw Error(`Manager successor profile refused: ${audit.failures.join(',')}`);
    return { operation: MANAGER_ROUTINE_PAYMENT_OPERATION, applied: false, target, audit,
      businessValidationRequired: true as const, historicalRowsReassigned: false as const };
  }
  const before = await inspectRoutinePaymentRuntime(tx, input.previous);
  if (!before.ready) throw Error(`Manager exact prior binding refused: ${before.failures.join(',')}`);
  const priorAudit = await inspectManagerRuntimePrivileges(tx, { requireLogin: true,
    routine: { target: input.previous, stage: 'before-manager' } });
  if (!priorAudit.profileReady) throw Error(`Manager prior base profile refused: ${priorAudit.failures.join(',')}`);
  const lock = await inspectLocalPaymentCaseLock(tx, MANAGER_RUNTIME_ROLE);
  if (!lock.runtimeSafe) throw Error('Manager SELECT-only case principal required');
  await tx.execute(sql.raw(`GRANT SELECT ON TABLE public.routine_payment_attempt, public.payment_reconciliation_action TO ${pricingIdentifier(MANAGER_RUNTIME_ROLE)}`));
  if (lock.absent) {
    await installLocalPaymentCaseLock(tx, { database: target.database, maintenance: target.maintenance,
      owner: input.caseLockOwner, runtimeRoles: target.caseLock!.runtimeRoles });
  } else {
    // The exact previous global binding already pinned owner/body/grantees.
    // This operation can add only the fixed manager EXECUTE privilege.
    await tx.execute(sql.raw(`GRANT EXECUTE ON FUNCTION ${LOCAL_PAYMENT_CASE_LOCK_SIGNATURE} TO ${pricingIdentifier(MANAGER_RUNTIME_ROLE)}`));
  }
  const after = await inspectRoutinePaymentRuntime(tx, target);
  const audit = await inspectManagerRuntimePrivileges(tx, { requireLogin: true, routine: { target, stage: 'ready' } });
  if (!after.ready || !audit.ready) throw Error(`Manager routine final verification refused: ${[...after.failures, ...audit.failures].join(',')}`);
  return { operation: MANAGER_ROUTINE_PAYMENT_OPERATION, applied: true, target, audit,
    businessValidationRequired: true as const, historicalRowsReassigned: false as const };
}

export async function runManagerRoutinePaymentForward(db: DbClient, input: ManagerRoutinePaymentForward) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Root manager maintenance connection required');
  return db.transaction(tx => installManagerRoutinePaymentInTransaction(tx, input),
    { isolationLevel: 'read committed', accessMode: 'read write' });
}
