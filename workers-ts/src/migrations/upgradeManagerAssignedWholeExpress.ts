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
import { STORE_ORDER_FULFILLMENT_ASSIGNMENTS_GATE } from './storeOrderFulfillmentAssignment';
import { captureManagerAssignedWholeExpressAddon, inspectManagerAssignedFulfillment,
  MANAGER_ASSIGNED_FULFILLMENT_SQL, MANAGER_ASSIGNED_FULFILLMENT_GATE,
  type ManagerAssignedWholeExpressAddon } from './managerAssignedFulfillment';

type Query = Pick<DbClient, 'execute'>;
export const MANAGER_ASSIGNED_WHOLE_EXPRESS_UPGRADE = 'manager-assigned-whole-express-v1';

/** Detach the complete target, five-profile intent and optional App reader
 * before BEGIN or the first metadata await. Getters, symbols, sparse arrays,
 * exotic prototypes and mutable caller arrays cannot replace an authority. */
function snapshot<T>(value: T): T {
  let nodes = 0, bytes = 0;
  const copy = (v: unknown, depth: number): unknown => {
    if (++nodes > 256 || depth > 8) throw Error('Bounded assigned receipt declaration required');
    if (v === null || v === undefined || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      bytes += v.length;
      if (v.length > 1024 || bytes > 65536) throw Error('Bounded assigned receipt strings required');
      return v;
    }
    if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
    if (!v || typeof v !== 'object' || (Array.isArray(v) ? Object.getPrototypeOf(v) !== Array.prototype
      : ![Object.prototype, null].includes(Object.getPrototypeOf(v)))) throw Error('Plain assigned receipt declaration required');
    const descriptors = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(v);
    if (Array.isArray(v)) {
      if (v.length > 32 || keys.length !== v.length + 1 || keys.some(k => typeof k !== 'string'
        || k !== 'length' && (!/^(0|[1-9][0-9]*)$/u.test(k) || Number(k) >= v.length))) throw Error('Dense assigned receipt declaration arrays required');
      return Array.from({ length: v.length }, (_, i) => {
        const d = descriptors[String(i)];
        if (!d?.enumerable || !('value' in d)) throw Error('Data-only assigned receipt array required');
        return copy(d.value, depth + 1);
      });
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const k of keys) {
      if (typeof k !== 'string' || !descriptors[k]?.enumerable || !('value' in descriptors[k])) throw Error('Data-only assigned receipt fields required');
      result[k] = copy(descriptors[k].value, depth + 1);
    }
    return result;
  };
  return copy(value, 0) as T;
}

function capture(target: RoutinePaymentRuntimeTarget, input: ManagerAssignedWholeExpressAddon,
  peers: RuntimeGiftPeerDeclarations, reader?: RuntimeAppCashierOriginReaderAddon) {
  const raw = snapshot({ target, input, peers, ...(reader === undefined ? {} : { reader }) }), t = raw.target;
  const identity = (v: unknown): string => {
    if (typeof v !== 'string') throw Error('Primitive assigned receipt identity required');
    pricingIdentifier(v); return v;
  };
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw Error('Assigned receipt target required');
  if (t.local !== undefined && (!Array.isArray(t.local) || t.local.length > 16)) throw Error('Bounded assigned receipt local identities required');
  if (t.caseLock !== undefined && (!t.caseLock || typeof t.caseLock !== 'object' || Array.isArray(t.caseLock)
    || Reflect.ownKeys(t.caseLock).some(k => typeof k !== 'string' || !['owner','runtimeRoles'].includes(k))
    || !Array.isArray(t.caseLock.runtimeRoles) || !t.caseLock.runtimeRoles.length || t.caseLock.runtimeRoles.length > 16))
    throw Error('Complete assigned receipt case-lock target required');
  // Existing deployment targets may carry additional bounded, data-only
  // metadata. Extract only the identity contract: extra fields never influence
  // authority and are neither returned nor forwarded to the profile auditors.
  const captured: RoutinePaymentRuntimeTarget = { database: identity(t.database), maintenance: identity(t.maintenance),
    app: identity(t.app), admin: identity(t.admin), ...(t.local ? { local: t.local.map(identity) } : {}),
    ...(t.caseLock ? { caseLock: { owner: identity(t.caseLock.owner), runtimeRoles: t.caseLock.runtimeRoles.map(identity) } } : {}) };
  const identities = [captured.maintenance, captured.app, captured.admin, ...(captured.local ?? [])];
  if (new Set(identities).size !== identities.length || captured.caseLock && (identities.includes(captured.caseLock.owner)
    || new Set(captured.caseLock.runtimeRoles).size !== captured.caseLock.runtimeRoles.length
    || captured.caseLock.runtimeRoles.some(n => !captured.local?.includes(n)))) throw Error('Independent assigned receipt target identities required');
  const receipts = captureManagerAssignedWholeExpressAddon(raw.input);
  const afterPeers = captureRuntimeGiftPeerDeclarations(raw.peers);
  const binding = (v: RoutinePaymentRuntimeTarget) => JSON.stringify([v.database,v.maintenance,v.app,v.admin,
    [...(v.local ?? [])].sort(),v.caseLock ? [v.caseLock.owner,[...v.caseLock.runtimeRoles].sort()] : null]);
  if (binding(captured) !== binding(afterPeers.target) || !afterPeers.fulfillmentAssignments || !afterPeers.managerAssignedWholeExpress
    || JSON.stringify(receipts) !== JSON.stringify(afterPeers.managerAssignedWholeExpress)) throw Error('Exact assigned receipt successor peers required');
  if (!afterPeers.financial || !afterPeers.cashierSecondCard || !afterPeers.manager
    || !captured.local?.includes(CUSTOMER_FINANCIAL_RUNTIME_ROLE) || !captured.local.includes(MANAGER_RUNTIME_ROLE)
    || !captured.local.includes(afterPeers.cashierSecondCard.role)) throw Error('Complete five assigned receipt runtime peers required');
  const { managerAssignedWholeExpress: _, ...basePeers } = afterPeers;
  const beforePeers: RuntimeGiftPeerDeclarations = basePeers;
  return { target: captured, receipts, beforePeers, afterPeers,
    reader: raw.reader === undefined ? undefined : captureRuntimeAppCashierOriginReader(raw.reader) };
}

/** Formal success-only receipt storage forward. It adds no role, delivery,
 * provider request, runtime handler or independently proved Manager authority.
 * Existing catalogs are never replaced or repaired. Caller rollback withdraws
 * the table, immutable function/triggers and exact Manager grants together. */
export async function upgradeManagerAssignedWholeExpressInTransaction(tx: Query, target: RoutinePaymentRuntimeTarget,
  input: ManagerAssignedWholeExpressAddon, peers: RuntimeGiftPeerDeclarations, reader?: RuntimeAppCashierOriginReaderAddon) {
  if (Object.hasOwn(tx, '$client')) throw Error('Existing assigned receipt maintenance transaction required');
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
  if (identity?.ready !== true) throw Error('Actual PG16 assigned receipt maintenance LOGIN/database required');
  // Match the existing cross-profile commissioning order. The new storage gate
  // comes last; neither this forward nor a repeat acquires an order-resource lock.
  for (const [key, subkey] of [[731669,0],[731670,0],[731625,2],[731624,0],[731685,0],[731812,1],
    [731714,0],[731717,0],[731718,0],[731719,0],[731735,0],FULFILLMENT_CITY_CONFLICT_GATE,[731722,0],STORE_ORDER_FULFILLMENT_ASSIGNMENTS_GATE,MANAGER_ASSIGNED_FULFILLMENT_GATE]) {
    const [gate] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(${key},${subkey}) AS locked`);
    if (gate?.locked !== true) throw Error('Assigned receipt commissioning is busy');
  }
  const names = { maintenance: t.maintenance, manager: MANAGER_RUNTIME_ROLE };
  const initial = await inspectManagerAssignedFulfillment(tx, names);
  if (initial.present && !initial.ready) throw Error('Assigned receipt catalog drift; partial state is not repaired: '+initial.failures.join(','));
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
    await tx.execute(sql.raw('LOCK TABLE ONLY public.manager_assigned_fulfillment_request IN ACCESS SHARE MODE NOWAIT'));
    const locked = await inspectManagerAssignedFulfillment(tx, names);
    if (!locked.ready) throw Error('Locked assigned receipt repeat catalog refused: '+locked.failures.join(','));
    const repeated = await inspect(c.afterPeers);
    if (!repeated.ready) throw Error('Complete repeated assigned receipt profiles required: '+repeated.failures.join(','));
    return { operation: MANAGER_ASSIGNED_WHOLE_EXPRESS_UPGRADE, applied: false as const,
      target: t, receipts: c.receipts, peers: c.afterPeers };
  }
  const previous = await inspect(c.beforePeers);
  if (!previous.ready) throw Error('Exact previous assigned receipt profiles required: '+previous.failures.join(','));
  await tx.execute(sql.raw('LOCK TABLE ONLY public.system_admin, ONLY public.system_role, ONLY public.system_store, ONLY public.system_store_staff IN SHARE ROW EXCLUSIVE MODE NOWAIT'));
  await tx.execute(sql.raw(MANAGER_ASSIGNED_FULFILLMENT_SQL));
  const fresh = await inspectManagerAssignedFulfillment(tx, names);
  if (!fresh.catalogReady || !fresh.ownerOnly || !fresh.binding || fresh.binding.database !== t.database
    || fresh.binding.maintenance !== t.maintenance || fresh.binding.manager !== MANAGER_RUNTIME_ROLE)
    throw Error('Assigned receipt owner-only initial catalog refused: '+fresh.failures.join(','));
  await tx.execute(sql.raw('GRANT SELECT,INSERT ON TABLE public.manager_assigned_fulfillment_request TO '+pricingIdentifier(MANAGER_RUNTIME_ROLE)));
  const final = await inspectManagerAssignedFulfillment(tx, names), post = await inspect(c.afterPeers);
  if (!final.ready || !final.binding || final.binding.database !== t.database || !post.ready)
    throw Error('Final assigned receipt contract refused: '+[...final.failures,...post.failures].join(','));
  return { operation: MANAGER_ASSIGNED_WHOLE_EXPRESS_UPGRADE, applied: true as const,
    target: t, receipts: c.receipts, peers: c.afterPeers };
}

export async function upgradeManagerAssignedWholeExpress(db: DbClient, target: RoutinePaymentRuntimeTarget,
  input: ManagerAssignedWholeExpressAddon, peers: RuntimeGiftPeerDeclarations, reader?: RuntimeAppCashierOriginReaderAddon) {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Root assigned receipt maintenance connection required');
  const c = capture(target, input, peers, reader);
  return db.transaction(tx => upgradeManagerAssignedWholeExpressInTransaction(tx, c.target,
    c.receipts, c.afterPeers, c.reader), { isolationLevel: 'read committed', accessMode: 'read write' });
}
