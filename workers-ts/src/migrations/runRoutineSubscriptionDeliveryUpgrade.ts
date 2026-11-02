import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { ROUTINE_SUBSCRIPTION_DELIVERY_SQL, inspectRoutineSubscriptionDeliveryCatalog } from './routineSubscriptionDelivery';
import { inspectRoutineSubscriptionCatalog } from './routineSubscription';
import type { RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';
import { captureRuntimeGiftPeerDeclarations, type RuntimeGiftPeerDeclarations } from './customerRuntimeGiftPeers';
import { captureRuntimeAppCashierOriginReader, type RuntimeAppCashierOriginReaderAddon } from './runtimeAppCashierOriginReader';

type Query = Pick<DbClient, 'execute'>;
export const ROUTINE_SUBSCRIPTION_DELIVERY_UPGRADE = 'routine-subscription-delivery-v1';

/** Copy bounded data before any asynchronous connection/transaction operation.
 * Accessors, coercion and shared nested arrays cannot change commissioning. */
function snapshot<T>(value: T): T {
  let nodes = 0, bytes = 0;
  const copy = (v: unknown, depth: number): unknown => {
    if (++nodes > 256 || depth > 8) throw Error('Bounded plain subscription delivery declaration required');
    if (v === null || v === undefined || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      bytes += v.length;
      if (v.length > 1024 || bytes > 65536) throw Error('Bounded subscription delivery declaration strings required');
      return v;
    }
    if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
    if (!v || typeof v !== 'object' || (Array.isArray(v) ? Object.getPrototypeOf(v) !== Array.prototype
      : ![Object.prototype, null].includes(Object.getPrototypeOf(v)))) throw Error('Primitive subscription delivery declaration fields required');
    const descriptors = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(v);
    if (Array.isArray(v)) {
      if (v.length > 32 || keys.length !== v.length + 1 || keys.some(k => typeof k !== 'string'
        || k !== 'length' && (!/^(0|[1-9][0-9]*)$/u.test(k) || Number(k) >= v.length)))
        throw Error('Dense bounded subscription delivery declaration arrays required');
      return Array.from({ length: v.length }, (_, i) => {
        const d = descriptors[String(i)];
        if (!d?.enumerable || !('value' in d)) throw Error('Plain subscription delivery declaration array required');
        return copy(d.value, depth + 1);
      });
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const k of keys) {
      if (typeof k !== 'string' || !descriptors[k]?.enumerable || !('value' in descriptors[k]))
        throw Error('Data-only subscription delivery declaration required');
      result[k] = copy(descriptors[k].value, depth + 1);
    }
    return result;
  };
  return copy(value, 0) as T;
}

function captureDeclaration(value: RoutinePaymentRuntimeTarget, peers?: RuntimeGiftPeerDeclarations,
  appReader?: RuntimeAppCashierOriginReaderAddon) {
  const raw = snapshot({ value, ...(peers === undefined ? {} : { peers }), ...(appReader === undefined ? {} : { appReader }) });
  const v = raw.value;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('Explicit subscription delivery target required');
  const identity = (n: unknown): string => {
    if (typeof n !== 'string') throw Error('Primitive subscription delivery identity required');
    pricingIdentifier(n); return n;
  };
  if (v.local !== undefined && (!Array.isArray(v.local) || v.local.length > 16)) throw Error('Bounded subscription delivery local identities required');
  if (v.caseLock && (!Array.isArray(v.caseLock.runtimeRoles) || !v.caseLock.runtimeRoles.length || v.caseLock.runtimeRoles.length > 16))
    throw Error('Explicit bounded subscription delivery case-lock identities required');
  // Only declared target fields are returned. Fixture/deployment metadata does
  // not become authority or an echoed arbitrary object.
  const target: RoutinePaymentRuntimeTarget = {
    database: identity(v.database), maintenance: identity(v.maintenance), app: identity(v.app), admin: identity(v.admin),
    ...(v.local === undefined ? {} : { local: v.local.map(identity) }),
    ...(v.caseLock ? { caseLock: { owner: identity(v.caseLock.owner), runtimeRoles: v.caseLock.runtimeRoles.map(identity) } } : {}),
  };
  const identities = [target.maintenance, target.app, target.admin, ...(target.local ?? [])];
  if (new Set(identities).size !== identities.length) throw Error('Distinct subscription delivery runtime identities required');
  if (target.caseLock && (identities.includes(target.caseLock.owner)
    || new Set(target.caseLock.runtimeRoles).size !== target.caseLock.runtimeRoles.length
    || target.caseLock.runtimeRoles.some(role => !target.local?.includes(role)))) throw Error('Explicit local-only subscription delivery case lock required');
  const capturedPeers = raw.peers === undefined ? undefined : captureRuntimeGiftPeerDeclarations(raw.peers);
  const capturedReader = raw.appReader === undefined ? undefined : captureRuntimeAppCashierOriginReader(raw.appReader);
  const binding = (t: RoutinePaymentRuntimeTarget) => JSON.stringify([t.database, t.maintenance, t.app, t.admin,
    [...(t.local ?? [])].sort(), t.caseLock ? [t.caseLock.owner, [...t.caseLock.runtimeRoles].sort()] : null]);
  if (capturedPeers && binding(capturedPeers.target) !== binding(target)) throw Error('Subscription peers require the exact declared target');
  return { target, peers: capturedPeers, appReader: capturedReader };
}

/** Atomic append-only attempt/result storage. App receives only non-delegable
 * SELECT/INSERT. Full before/after profile audits retain the established
 * maintenance limits: each SQL/idle <=5s and lock <=1s; this is not a fresh
 * business-authority transaction with a five-second total age. No intent,
 * consent, provider result or business payload is authored. */
export async function installRoutineSubscriptionDeliveryUpgradeInTransaction(tx: Query, declaredTarget: RoutinePaymentRuntimeTarget,
  declaredPeers?: RuntimeGiftPeerDeclarations, declaredReader?: RuntimeAppCashierOriginReaderAddon) {
  if (Object.hasOwn(tx, '$client')) throw Error('Subscription delivery upgrade requires an existing maintenance transaction');
  const c = captureDeclaration(declaredTarget, declaredPeers, declaredReader), { target, peers, appReader } = c;
  await tx.execute(sql`SELECT pg_catalog.set_config('search_path','public,pg_temp',true),
    pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
    pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  const [context] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.current_database()=${target.database}
    AND current_user=${target.maintenance} AND current_user=session_user AND pg_catalog.current_schema()='public'
    AND r.rolsuper AND r.rolcanlogin AND r.oid=(SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid())
    AND pg_catalog.current_setting('server_version_num')::integer/10000=16
    AND pg_catalog.current_setting('transaction_isolation')='read committed' AND pg_catalog.current_setting('transaction_read_only')='off'
    AND pg_catalog.current_setting('session_replication_role')='origin'
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
      WHERE d.defaclrole=r.oid AND d.defaclnamespace IN(0,'public'::regnamespace) AND d.defaclobjtype IN('r','f','S') AND a.grantee<>d.defaclrole)
    AS ready FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
  if (context?.ready !== true) throw Error('Subscription delivery upgrade requires the actual PG16 maintenance LOGIN/database without default grants');
  // The commissioned subscription source carries the original/ownership proof.
  // Every source and new gate is try-only and precedes physical resources.
  for (const key of [731714, 731716, 731725, 731726]) {
    const [gate] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(${key},0) AS locked`);
    if (gate?.locked !== true) throw Error('Subscription delivery commissioning is busy');
  }
  const names = { maintenance: target.maintenance, app: target.app, admin: target.admin };
  const requireSources = async () => {
    const source = await inspectRoutineSubscriptionCatalog(tx, names), b = source.binding;
    if (!source.ready || !b?.app || !b.appOid || b.maintenance !== target.maintenance || b.app !== target.app)
      throw Error('Subscription delivery commissioning requires the exact complete named subscription source');
  };
  await requireSources();
  await tx.execute(sql.raw('LOCK TABLE ONLY public.routine_original_payment_evidence, ONLY public.routine_identity_ownership, ONLY public.routine_subscription_account_policy, ONLY public.system_admin, ONLY public.system_role IN SHARE ROW EXCLUSIVE MODE NOWAIT'));
  await requireSources();
  let before = await inspectRoutineSubscriptionDeliveryCatalog(tx, names);
  if (before.present && !before.ready) throw Error('Partial or drifted subscription delivery catalog requires review: ' + before.failures.join(','));
  if (before.present) {
    await tx.execute(sql.raw('LOCK TABLE ONLY public.routine_subscribe_attempt, ONLY public.routine_subscribe_result IN SHARE ROW EXCLUSIVE MODE NOWAIT'));
    before = await inspectRoutineSubscriptionDeliveryCatalog(tx, names);
    if (!before.ready) throw Error('Subscription delivery catalog changed during maintenance locking');
  }
  const inspect = async () => ({
    app: await inspectRuntimeBusinessProfileInTransaction(tx, 'app', target, 'current', peers, appReader),
    admin: await inspectRuntimeBusinessProfileInTransaction(tx, 'admin', target, 'current', peers),
  });
  const prior = await inspect();
  if (!prior.app.ready || !prior.admin.ready) throw Error('Subscription delivery commissioning requires exact existing App/Admin and declared peer profiles');
  const result = (applied: boolean) => ({ operation: ROUTINE_SUBSCRIPTION_DELIVERY_UPGRADE, applied, target, ...(peers ? { peers } : {}), ...(appReader ? { appReader } : {}) });
  if (before.ready) return result(false);
  await tx.execute(sql.raw(ROUTINE_SUBSCRIPTION_DELIVERY_SQL));
  const created = await inspectRoutineSubscriptionDeliveryCatalog(tx);
  if (!created.ready || created.binding?.app !== null) throw Error('Subscription delivery initial owner-only catalog verification failed');
  await tx.execute(sql.raw(`GRANT SELECT,INSERT ON TABLE public.routine_subscribe_attempt,public.routine_subscribe_result TO ${pricingIdentifier(target.app)}`));
  const after = await inspectRoutineSubscriptionDeliveryCatalog(tx, names);
  if (!after.ready) throw Error('Subscription delivery installed catalog/ACL verification failed: ' + after.failures.join(','));
  const commissioned = await inspect();
  if (!commissioned.app.ready || !commissioned.admin.ready) throw Error('Subscription delivery commissioned runtime profiles failed verification');
  return result(true);
}

export const runRoutineSubscriptionDeliveryUpgradeInTransaction = installRoutineSubscriptionDeliveryUpgradeInTransaction;

export async function runRoutineSubscriptionDeliveryUpgrade(db: DbClient, target: RoutinePaymentRuntimeTarget,
  peers?: RuntimeGiftPeerDeclarations, appReader?: RuntimeAppCashierOriginReaderAddon) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Subscription delivery upgrade requires a root maintenance connection');
  const c = captureDeclaration(target, peers, appReader);
  return db.transaction(tx => installRoutineSubscriptionDeliveryUpgradeInTransaction(tx, c.target, c.peers, c.appReader),
    { isolationLevel: 'read committed', accessMode: 'read write' });
}
