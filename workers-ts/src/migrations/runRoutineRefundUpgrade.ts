import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { ROUTINE_REFUND_SQL, inspectRoutineRefundCatalog } from './routineRefund';
import type { RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';
import { captureRuntimeGiftPeerDeclarations, type RuntimeGiftPeerDeclarations } from './customerRuntimeGiftPeers';
import { captureRuntimeAppCashierOriginReader, type RuntimeAppCashierOriginReaderAddon } from './runtimeAppCashierOriginReader';

type Query = Pick<DbClient, 'execute'>;
export const ROUTINE_REFUND_UPGRADE = 'routine-refund-foundation-v1';

/** Capture declarations before BEGIN can yield. Local LOGIN/case-lock and
 * independently commissioned peer/reader contracts remain explicit. */
function captureDeclaration(value: RoutinePaymentRuntimeTarget,
  peers?: RuntimeGiftPeerDeclarations, appReader?: RuntimeAppCashierOriginReaderAddon) {
  if (!Array.isArray(value.local ?? []) || (value.local?.length ?? 0) > 16) throw Error('Explicit bounded Routine refund local identities required');
  if (value.caseLock && !Array.isArray(value.caseLock.runtimeRoles)) throw Error('Explicit Routine refund case-lock identities required');
  const target: RoutinePaymentRuntimeTarget = { database: value.database, maintenance: value.maintenance, app: value.app, admin: value.admin,
    ...(value.local ? { local: [...value.local] } : {}),
    ...(value.caseLock ? { caseLock: { owner: value.caseLock.owner, runtimeRoles: [...value.caseLock.runtimeRoles] } } : {}) };
  const local = target.local ?? [], identities = [target.maintenance, target.app, target.admin, ...local];
  [...identities, target.database].forEach(pricingIdentifier);
  if (new Set(identities).size !== identities.length) throw Error('Distinct Routine refund runtime identities required');
  if (target.caseLock) {
    const lock = target.caseLock;
    pricingIdentifier(lock.owner); lock.runtimeRoles.forEach(pricingIdentifier);
    if (!lock.runtimeRoles.length || lock.runtimeRoles.length > 16 || identities.includes(lock.owner)
      || new Set(lock.runtimeRoles).size !== lock.runtimeRoles.length || lock.runtimeRoles.some(role => !local.includes(role)))
      throw Error('Explicit local-only Routine refund case lock required');
  }
  const capturedPeers = peers === undefined ? undefined : captureRuntimeGiftPeerDeclarations(peers);
  const capturedReader = appReader === undefined ? undefined : captureRuntimeAppCashierOriginReader(appReader);
  const binding = (t: RoutinePaymentRuntimeTarget) => JSON.stringify([t.database, t.maintenance, t.app, t.admin,
    [...(t.local ?? [])].sort(), t.caseLock ? [t.caseLock.owner, [...t.caseLock.runtimeRoles].sort()] : null]);
  if (capturedPeers && binding(capturedPeers.target) !== binding(target)) throw Error('Routine refund peers require the exact declared target');
  return { target, peers: capturedPeers, appReader: capturedReader };
}

/** Explicit maintenance forward protocol. Exact complete App/Admin profiles,
 * absent-or-exact namespace, immutable catalog and grants commit atomically.
 * An owner-only or partial prior install refuses; a full repeat makes no DDL,
 * grant or data changes. No account, identity, order or business row is edited. */
export async function installRoutineRefundUpgradeInTransaction(tx: Query, declaredTarget: RoutinePaymentRuntimeTarget,
  declaredPeers?: RuntimeGiftPeerDeclarations, declaredReader?: RuntimeAppCashierOriginReaderAddon) {
  if (Object.hasOwn(tx, '$client')) throw Error('Routine refund upgrade requires an existing maintenance transaction');
  const { target, peers, appReader } = captureDeclaration(declaredTarget, declaredPeers, declaredReader);
  await tx.execute(sql`SELECT pg_catalog.set_config('search_path','public,pg_temp',true),
    pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
    pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  const [context] = await tx.execute(sql`SELECT pg_catalog.current_database()=${target.database} AND current_user=${target.maintenance}
    AND current_user=session_user AND pg_catalog.current_schema()='public' AND pg_catalog.current_setting('server_version_num')::integer/10000=16
    AND pg_catalog.current_setting('transaction_isolation')='read committed' AND pg_catalog.current_setting('transaction_read_only')='off'
    AND pg_catalog.current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
      WHERE a.pid=pg_catalog.pg_backend_pid() AND r.rolname=current_user AND r.rolsuper AND r.rolcanlogin)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
      WHERE d.defaclrole=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
      AND d.defaclnamespace IN (0,'public'::regnamespace) AND d.defaclobjtype IN ('r','f','S') AND a.grantee<>d.defaclrole) AS ready`);
  if (context?.ready !== true) throw Error('Routine refund requires explicit PG16 owner/database maintenance without default grants');
  const [gate] = await tx.execute(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(731718,0) AS locked`);
  if (gate?.locked !== true) throw Error('Routine refund commissioning is busy');
  await tx.execute(sql.raw('LOCK TABLE ONLY public.system_admin, ONLY public.system_role IN SHARE ROW EXCLUSIVE MODE NOWAIT'));
  const names = { maintenance: target.maintenance, app: target.app, admin: target.admin };
  let before = await inspectRoutineRefundCatalog(tx, names);
  if (before.present && !before.ready) throw Error('Partial or drifted Routine refund catalog requires review: ' + before.failures.join(','));
  if (before.present) {
    await tx.execute(sql.raw('LOCK TABLE ONLY public.routine_refund_account_policy, ONLY public.routine_refund_dispatch, ONLY public.routine_refund_provider_evidence IN ACCESS EXCLUSIVE MODE NOWAIT'));
    before = await inspectRoutineRefundCatalog(tx, names);
    if (!before.ready) throw Error('Routine refund catalog changed during maintenance locking');
  }
  const inspect = async () => ({
    app: await inspectRuntimeBusinessProfileInTransaction(tx, 'app', target, 'current', peers, appReader),
    admin: await inspectRuntimeBusinessProfileInTransaction(tx, 'admin', target, 'current', peers),
  });
  const prior = await inspect();
  if (!prior.app.ready || !prior.admin.ready) throw Error('Routine refund commissioning requires exact existing runtime profiles');
  if (before.ready) return { operation: ROUTINE_REFUND_UPGRADE, applied: false as const };
  await tx.execute(sql.raw(ROUTINE_REFUND_SQL));
  const created = await inspectRoutineRefundCatalog(tx);
  if (!created.ready || created.binding?.app !== null) throw Error('Routine refund initial owner-only catalog verification failed');
  await tx.execute(sql.raw(`GRANT SELECT ON TABLE public.routine_refund_account_policy TO ${pricingIdentifier(target.app)}`));
  await tx.execute(sql.raw(`GRANT SELECT,INSERT ON TABLE public.routine_refund_dispatch,public.routine_refund_provider_evidence TO ${pricingIdentifier(target.app)}`));
  const after = await inspectRoutineRefundCatalog(tx, names);
  if (!after.ready) throw Error('Routine refund installed catalog/ACL verification failed: ' + after.failures.join(','));
  const commissioned = await inspect();
  if (!commissioned.app.ready || !commissioned.admin.ready) throw Error('Routine refund commissioned runtime profiles failed verification');
  return { operation: ROUTINE_REFUND_UPGRADE, applied: true as const };
}

export async function runRoutineRefundUpgrade(db: DbClient, target: RoutinePaymentRuntimeTarget,
  peers?: RuntimeGiftPeerDeclarations, appReader?: RuntimeAppCashierOriginReaderAddon) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Routine refund upgrade requires a root maintenance connection');
  const captured = captureDeclaration(target, peers, appReader);
  return db.transaction(tx => installRoutineRefundUpgradeInTransaction(tx, captured.target, captured.peers, captured.appReader),
    { isolationLevel: 'read committed', accessMode: 'read write' });
}
