import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { captureRuntimeAppCashierOriginReader, inspectRuntimeAppCashierOriginReader, RUNTIME_APP_CASHIER_ORIGIN_READ_TABLE,
  type RuntimeAppCashierOriginReaderAddon } from './runtimeAppCashierOriginReader';
import { captureRuntimeGiftPeerDeclarations, type RuntimeGiftPeerDeclarations } from './customerRuntimeGiftPeers';
import { inspectRoutinePaymentRuntime, type RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';
import { CASHIER_SECOND_CARD_MAINTENANCE_LOCK_KEY } from './cashierSecondCardOrigin';

type Query = Pick<DbClient, 'execute'>;
export const RUNTIME_APP_CASHIER_ORIGIN_READER_OPERATION = 'runtime-app-cashier-origin-reader-v1';
function captureTarget(value: RoutinePaymentRuntimeTarget): RoutinePaymentRuntimeTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.local !== undefined && (!Array.isArray(value.local) || value.local.length > 16)
    || value.caseLock !== undefined && (!value.caseLock || typeof value.caseLock !== 'object' || Array.isArray(value.caseLock)
      || !Array.isArray(value.caseLock.runtimeRoles) || !value.caseLock.runtimeRoles.length || value.caseLock.runtimeRoles.length > 16))
    throw Error('Explicit bounded App reader routine target required');
  const target = { database: value.database, maintenance: value.maintenance, app: value.app, admin: value.admin,
    ...(value.local ? { local: [...value.local] } : {}),
    ...(value.caseLock ? { caseLock: { owner: value.caseLock.owner, runtimeRoles: [...value.caseLock.runtimeRoles] } } : {}) };
  const roles = [target.maintenance, target.app, target.admin, ...(target.local ?? [])];
  for (const name of [target.database, ...roles, ...(target.caseLock ? [target.caseLock.owner, ...target.caseLock.runtimeRoles] : [])]) pricingIdentifier(name);
  if (new Set(roles).size !== roles.length || target.caseLock && (roles.includes(target.caseLock.owner)
    || new Set(target.caseLock.runtimeRoles).size !== target.caseLock.runtimeRoles.length
    || target.caseLock.runtimeRoles.some(role => !target.local?.includes(role))))
    throw Error('Distinct App reader identities and local-only case binding required');
  return target;
}
function bindingKey(target: RoutinePaymentRuntimeTarget) {
  return JSON.stringify({ database: target.database, maintenance: target.maintenance, app: target.app, admin: target.admin,
    local: [...(target.local ?? [])].sort(), caseLock: target.caseLock
      ? { owner: target.caseLock.owner, runtimeRoles: [...target.caseLock.runtimeRoles].sort() } : null });
}
function capturePeers(target: RoutinePaymentRuntimeTarget, value?: RuntimeGiftPeerDeclarations) {
  if (value === undefined) return undefined;
  const peers = captureRuntimeGiftPeerDeclarations(value);
  if (bindingKey(captureTarget(peers.target)) !== bindingKey(target)) throw Error('App reader gift peers must declare the same complete routine target');
  return peers;
}

/** Exact complete App base -> one immutable origin SELECT. No installation,
 * grant inference, partial repair, password/history change or source writes.
 * The existing completed addon is a read-only idempotent outcome. */
export async function upgradeRuntimeAppCashierOriginReaderInTransaction(tx: Query, declared: RoutinePaymentRuntimeTarget,
  input: RuntimeAppCashierOriginReaderAddon, declaredPeers?: RuntimeGiftPeerDeclarations) {
  if (Object.hasOwn(tx, '$client')) throw Error('App origin reader forward requires a caller-owned transaction');
  const target = captureTarget(declared), appReader = captureRuntimeAppCashierOriginReader(input), peers = capturePeers(target, declaredPeers);
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
  if (identity?.ready !== true) throw Error('App origin reader maintenance target refused');
  // Same raw storage order as established payment/runtime maintenance, then
  // the complete App grant boundary and the published Cashier installer gate.
  for (const [key, subkey] of [[731669, 0], [731670, 0], [731625, 2], [CASHIER_SECOND_CARD_MAINTENANCE_LOCK_KEY, 0]]) {
    const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${key},${subkey}) AS locked`);
    if (gate?.locked !== true) throw Error('App origin reader forward is busy');
  }
  if (!(await inspectRoutinePaymentRuntime(tx, target)).ready) throw Error('Exact App reader routine binding is not commissioned');
  const existing = await inspectRuntimeBusinessProfileInTransaction(tx, 'app', target, 'current', peers, appReader);
  if (existing.ready) return { operation: RUNTIME_APP_CASHIER_ORIGIN_READER_OPERATION, changed: false as const,
    role: target.app, target, appReader, audit: existing, credentialChanged: false as const,
    historicalRowsReassigned: false as const, sourceWritesGranted: false as const, completeServiceCoverageVerified: false as const };
  if (!(await inspectRuntimeBusinessProfileInTransaction(tx, 'app', target, 'current', peers)).ready)
    throw Error('Exact complete App base required; partial origin reader grants need separate review');
  const inspect = (requirePrivileges: boolean) => inspectRuntimeAppCashierOriginReader(tx,
    { role: target.app, maintenance: target.maintenance, addon: appReader, requirePrivileges });
  const pre = await inspect(false);
  if (!pre.ready || !pre.catalogReady) throw Error('Canonical App cashier-origin source is not commissioned');
  await tx.execute(sql.raw('LOCK TABLE ONLY public.routine_identity_witness, ONLY public.routine_payment_attempt, '
    + 'ONLY public.payment_reconciliation_action, ONLY public.payment_reconciliation_case, '
    + 'ONLY public.cashier_second_card_cart_v1, ONLY public.cashier_second_card_origin_v1, ONLY public.cashier_second_card_payment_v1 '
    + 'IN ACCESS EXCLUSIVE MODE NOWAIT'));
  if (!(await inspectRuntimeBusinessProfileInTransaction(tx, 'app', target, 'current', peers)).ready
    || !(await inspectRoutinePaymentRuntime(tx, target)).ready) throw Error('Complete App base changed while locking');
  const locked = await inspect(false);
  if (!locked.ready || !locked.catalogReady || locked.roleOid !== pre.roleOid || locked.maintenanceOid !== pre.maintenanceOid
    || JSON.stringify(locked.sourceBindings) !== JSON.stringify(pre.sourceBindings)
    || JSON.stringify(locked.validatorBindings) !== JSON.stringify(pre.validatorBindings))
    throw Error('App origin source binding changed while locking');
  await tx.execute(sql.raw(`GRANT SELECT ON TABLE public.${pricingIdentifier(RUNTIME_APP_CASHIER_ORIGIN_READ_TABLE)} TO ${pricingIdentifier(target.app)}`));
  const audit = await inspectRuntimeBusinessProfileInTransaction(tx, 'app', target, 'current', peers, appReader), post = await inspect(true);
  if (!audit.ready || !post.ready || post.roleOid !== pre.roleOid || post.maintenanceOid !== pre.maintenanceOid
    || JSON.stringify(post.sourceBindings) !== JSON.stringify(pre.sourceBindings)
    || JSON.stringify(post.validatorBindings) !== JSON.stringify(pre.validatorBindings)
    || !(await inspectRoutinePaymentRuntime(tx, target)).ready) throw Error('Final complete App origin reader profile refused');
  return { operation: RUNTIME_APP_CASHIER_ORIGIN_READER_OPERATION, changed: true as const,
    role: target.app, target, appReader, audit, credentialChanged: false as const,
    historicalRowsReassigned: false as const, sourceWritesGranted: false as const, completeServiceCoverageVerified: false as const };
}

export async function upgradeRuntimeAppCashierOriginReader(db: DbClient, declared: RoutinePaymentRuntimeTarget,
  input: RuntimeAppCashierOriginReaderAddon, declaredPeers?: RuntimeGiftPeerDeclarations) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Root App reader maintenance connection required');
  const target = captureTarget(declared), addon = captureRuntimeAppCashierOriginReader(input), peers = capturePeers(target, declaredPeers);
  try { return await db.transaction(tx => upgradeRuntimeAppCashierOriginReaderInTransaction(tx, target, addon, peers),
    { isolationLevel: 'read committed', accessMode: 'read write' }); }
  catch { throw Error('App origin reader forward outcome not confirmed; inspect the exact profile before further action'); }
}
