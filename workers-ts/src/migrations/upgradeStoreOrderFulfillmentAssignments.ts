import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import type { RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from './customerFinancialRuntimePlan';
import { MANAGER_RUNTIME_ROLE } from './managerRuntimePrivilegePlan';
import { captureRuntimeGiftPeerDeclarations, type RuntimeGiftPeerDeclarations } from './customerRuntimeGiftPeers';
import { captureRuntimeAppCashierOriginReader, type RuntimeAppCashierOriginReaderAddon } from './runtimeAppCashierOriginReader';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { inspectManagerRuntimePrivileges } from './auditManagerRuntimePrivileges';
import { FULFILLMENT_CITY_CONFLICT_GATE } from './fulfillmentCityConflictReader';
import { captureStoreOrderFulfillmentAssignmentsAddon, inspectStoreOrderFulfillmentAssignment,
  STORE_ORDER_FULFILLMENT_ASSIGNMENT_SQL, STORE_ORDER_FULFILLMENT_ASSIGNMENTS_GATE,
  type StoreOrderFulfillmentAssignmentsAddon } from './storeOrderFulfillmentAssignment';

type Query = Pick<DbClient, 'execute'>;
export const STORE_ORDER_FULFILLMENT_ASSIGNMENTS_UPGRADE = 'store-order-fulfillment-assignments-v1';

/** Detach the complete target, five-profile intent and optional App reader
 * before BEGIN or the first metadata await. Getters, symbols, sparse arrays,
 * exotic prototypes and mutable caller arrays cannot replace an authority. */
function snapshot<T>(value: T): T {
  let nodes = 0, bytes = 0;
  const copy = (v: unknown, depth: number): unknown => {
    if (++nodes > 256 || depth > 8) throw Error('Bounded assignment declaration required');
    if (v === null || v === undefined || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      bytes += v.length;
      if (v.length > 1024 || bytes > 65536) throw Error('Bounded assignment strings required');
      return v;
    }
    if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
    if (!v || typeof v !== 'object' || (Array.isArray(v) ? Object.getPrototypeOf(v) !== Array.prototype
      : ![Object.prototype, null].includes(Object.getPrototypeOf(v)))) throw Error('Plain assignment declaration required');
    const descriptors = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(v);
    if (Array.isArray(v)) {
      if (v.length > 32 || keys.length !== v.length + 1 || keys.some(k => typeof k !== 'string'
        || k !== 'length' && (!/^(0|[1-9][0-9]*)$/u.test(k) || Number(k) >= v.length))) throw Error('Dense assignment declaration arrays required');
      return Array.from({ length: v.length }, (_, i) => {
        const d = descriptors[String(i)];
        if (!d?.enumerable || !('value' in d)) throw Error('Data-only assignment array required');
        return copy(d.value, depth + 1);
      });
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const k of keys) {
      if (typeof k !== 'string' || !descriptors[k]?.enumerable || !('value' in descriptors[k])) throw Error('Data-only assignment fields required');
      result[k] = copy(descriptors[k].value, depth + 1);
    }
    return result;
  };
  return copy(value, 0) as T;
}

function capture(target: RoutinePaymentRuntimeTarget, input: StoreOrderFulfillmentAssignmentsAddon,
  peers: RuntimeGiftPeerDeclarations, reader?: RuntimeAppCashierOriginReaderAddon) {
  const raw = snapshot({ target, input, peers, ...(reader === undefined ? {} : { reader }) }), t = raw.target;
  const identity = (v: unknown): string => {
    if (typeof v !== 'string') throw Error('Primitive assignment identity required');
    pricingIdentifier(v); return v;
  };
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw Error('Assignment target required');
  if (t.local !== undefined && (!Array.isArray(t.local) || t.local.length > 16)) throw Error('Bounded assignment local identities required');
  if (t.caseLock !== undefined && (!t.caseLock || typeof t.caseLock !== 'object' || Array.isArray(t.caseLock)
    || Reflect.ownKeys(t.caseLock).some(k => typeof k !== 'string' || !['owner','runtimeRoles'].includes(k))
    || !Array.isArray(t.caseLock.runtimeRoles) || !t.caseLock.runtimeRoles.length || t.caseLock.runtimeRoles.length > 16))
    throw Error('Complete assignment case-lock target required');
  // Existing deployment targets may carry additional bounded, data-only
  // metadata. Extract only the identity contract: extra fields never influence
  // authority and are neither returned nor forwarded to the profile auditors.
  const captured: RoutinePaymentRuntimeTarget = { database: identity(t.database), maintenance: identity(t.maintenance),
    app: identity(t.app), admin: identity(t.admin), ...(t.local ? { local: t.local.map(identity) } : {}),
    ...(t.caseLock ? { caseLock: { owner: identity(t.caseLock.owner), runtimeRoles: t.caseLock.runtimeRoles.map(identity) } } : {}) };
  const identities = [captured.maintenance, captured.app, captured.admin, ...(captured.local ?? [])];
  if (new Set(identities).size !== identities.length || captured.caseLock && (identities.includes(captured.caseLock.owner)
    || new Set(captured.caseLock.runtimeRoles).size !== captured.caseLock.runtimeRoles.length
    || captured.caseLock.runtimeRoles.some(n => !captured.local?.includes(n)))) throw Error('Independent assignment target identities required');
  const assignments = captureStoreOrderFulfillmentAssignmentsAddon(raw.input);
  const afterPeers = captureRuntimeGiftPeerDeclarations(raw.peers);
  const binding = (v: RoutinePaymentRuntimeTarget) => JSON.stringify([v.database,v.maintenance,v.app,v.admin,
    [...(v.local ?? [])].sort(),v.caseLock ? [v.caseLock.owner,[...v.caseLock.runtimeRoles].sort()] : null]);
  if (binding(captured) !== binding(afterPeers.target) || !afterPeers.fulfillmentAssignments
    || JSON.stringify(assignments) !== JSON.stringify(afterPeers.fulfillmentAssignments)) throw Error('Exact assignment successor peers required');
  if (!afterPeers.financial || !afterPeers.cashierSecondCard || !afterPeers.manager
    || !captured.local?.includes(CUSTOMER_FINANCIAL_RUNTIME_ROLE) || !captured.local.includes(MANAGER_RUNTIME_ROLE)
    || !captured.local.includes(afterPeers.cashierSecondCard.role)) throw Error('Complete five assignment runtime peers required');
  const { fulfillmentAssignments: _, ...basePeers } = afterPeers;
  const beforePeers: RuntimeGiftPeerDeclarations = basePeers;
  return { target: captured, assignments, beforePeers, afterPeers,
    reader: raw.reader === undefined ? undefined : captureRuntimeAppCashierOriginReader(raw.reader) };
}

/** Formal prospective storage forward only. This adds no role, business row,
 * HTTP handler, active assignment, proof author or Manager delivery capability.
 * Existing catalogs are never replaced or repaired. Caller rollback withdraws
 * the table, immutable function/triggers and exact grants together. */
export async function upgradeStoreOrderFulfillmentAssignmentsInTransaction(tx: Query, target: RoutinePaymentRuntimeTarget,
  input: StoreOrderFulfillmentAssignmentsAddon, peers: RuntimeGiftPeerDeclarations, reader?: RuntimeAppCashierOriginReaderAddon) {
  if (Object.hasOwn(tx, '$client')) throw Error('Existing assignment maintenance transaction required');
  const c = capture(target, input, peers, reader), t = c.target;
  await tx.execute(sql`SELECT pg_catalog.set_config('search_path','public,pg_temp',true),
    pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
    pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  const [identity] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.current_database()=${t.database}
    AND current_user=${t.maintenance} AND current_user=session_user AND pg_catalog.current_setting('role')='none'
    AND pg_catalog.current_schema()='public' AND r.rolsuper AND r.rolcanlogin
    AND r.oid=(SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid())
    AND pg_catalog.current_setting('server_version_num')::integer/10000=16
    AND pg_catalog.current_setting('transaction_isolation')='read committed'
    AND pg_catalog.current_setting('transaction_read_only')='off' AND pg_catalog.current_setting('session_replication_role')='origin'
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS ready
    FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
  if (identity?.ready !== true) throw Error('Actual PG16 assignment maintenance LOGIN/database required');
  // Match the existing cross-profile commissioning order. The new storage gate
  // comes last; neither this forward nor a repeat acquires an order-resource lock.
  for (const [key, subkey] of [[731669,0],[731670,0],[731625,2],[731624,0],[731685,0],[731812,1],
    [731714,0],[731717,0],[731718,0],[731719,0],[731735,0],FULFILLMENT_CITY_CONFLICT_GATE,[731722,0],STORE_ORDER_FULFILLMENT_ASSIGNMENTS_GATE]) {
    const [gate] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(${key},${subkey}) AS locked`);
    if (gate?.locked !== true) throw Error('Assignment commissioning is busy');
  }
  const names = { maintenance: t.maintenance, admin: t.admin, manager: MANAGER_RUNTIME_ROLE };
  const initial = await inspectStoreOrderFulfillmentAssignment(tx, names);
  if (initial.present && !initial.ready) throw Error('Assignment catalog drift; partial state is not repaired: '+initial.failures.join(','));
  const inspect = async (p: RuntimeGiftPeerDeclarations) => {
    const app = await inspectRuntimeBusinessProfileInTransaction(tx, 'app', t, 'current', p, c.reader);
    const admin = await inspectRuntimeBusinessProfileInTransaction(tx, 'admin', t, 'current', p);
    const manager = await inspectManagerRuntimePrivileges(tx, { requireLogin: true, routine: { target: t, stage: 'ready' },
      ...(p.routineRefundActors?.manager ? { routineRefund: true } : {}),
      ...(p.cityConflictReaders?.manager ? { cityConflictReaders: p.cityConflictReaders } : {}),
      ...(p.fulfillmentAssignments ? { fulfillmentAssignments: p.fulfillmentAssignments } : {}),
      ...(p.managerAssignedWholeExpress ? { managerAssignedWholeExpress: p.managerAssignedWholeExpress } : {}) });
    return { ready: app.ready && admin.ready && manager.ready, failures: [...app.failures.map(n => 'app:'+n),
      ...admin.failures.map(n => 'admin:'+n),...manager.failures.map(n => 'manager:'+n)].slice(0,32) };
  };
  if (initial.ready) {
    // Metadata SELECTs alone do not conflict with a table's ACCESS EXCLUSIVE
    // holder. Keep a physical read fence until this read-only repeat commits.
    await tx.execute(sql.raw('LOCK TABLE ONLY public.store_order_fulfillment_assignment IN ACCESS SHARE MODE NOWAIT'));
    const locked = await inspectStoreOrderFulfillmentAssignment(tx, names);
    if (!locked.ready) throw Error('Locked assignment repeat catalog refused: '+locked.failures.join(','));
    const repeated = await inspect(c.afterPeers);
    if (!repeated.ready) throw Error('Complete repeated assignment profiles required: '+repeated.failures.join(','));
    return { operation: STORE_ORDER_FULFILLMENT_ASSIGNMENTS_UPGRADE, applied: false as const,
      target: t, assignments: c.assignments, peers: c.afterPeers };
  }
  const previous = await inspect(c.beforePeers);
  if (!previous.ready) throw Error('Exact previous assignment profiles required: '+previous.failures.join(','));
  await tx.execute(sql.raw('LOCK TABLE ONLY public.system_admin, ONLY public.system_role, ONLY public.system_store, ONLY public.system_store_staff IN SHARE ROW EXCLUSIVE MODE NOWAIT'));
  await tx.execute(sql.raw(STORE_ORDER_FULFILLMENT_ASSIGNMENT_SQL));
  const fresh = await inspectStoreOrderFulfillmentAssignment(tx, names);
  if (!fresh.catalogReady || !fresh.ownerOnly || !fresh.binding || fresh.binding.database !== t.database
    || fresh.binding.maintenance !== t.maintenance || fresh.binding.admin !== t.admin || fresh.binding.manager !== MANAGER_RUNTIME_ROLE)
    throw Error('Assignment owner-only initial catalog refused: '+fresh.failures.join(','));
  await tx.execute(sql.raw('GRANT SELECT,INSERT ON TABLE public.store_order_fulfillment_assignment TO '+pricingIdentifier(t.admin)));
  await tx.execute(sql.raw('GRANT SELECT ON TABLE public.store_order_fulfillment_assignment TO '+pricingIdentifier(MANAGER_RUNTIME_ROLE)));
  const final = await inspectStoreOrderFulfillmentAssignment(tx, names), post = await inspect(c.afterPeers);
  if (!final.ready || !final.binding || final.binding.database !== t.database || !post.ready)
    throw Error('Final assignment contract refused: '+[...final.failures,...post.failures].join(','));
  return { operation: STORE_ORDER_FULFILLMENT_ASSIGNMENTS_UPGRADE, applied: true as const,
    target: t, assignments: c.assignments, peers: c.afterPeers };
}

export async function upgradeStoreOrderFulfillmentAssignments(db: DbClient, target: RoutinePaymentRuntimeTarget,
  input: StoreOrderFulfillmentAssignmentsAddon, peers: RuntimeGiftPeerDeclarations, reader?: RuntimeAppCashierOriginReaderAddon) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Root assignment maintenance connection required');
  const c = capture(target, input, peers, reader);
  return db.transaction(tx => upgradeStoreOrderFulfillmentAssignmentsInTransaction(tx, c.target,
    c.assignments, c.afterPeers, c.reader), { isolationLevel: 'read committed', accessMode: 'read write' });
}
