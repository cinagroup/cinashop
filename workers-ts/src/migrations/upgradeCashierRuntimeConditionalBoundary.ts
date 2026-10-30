import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRuntimeBusinessProfileInTransaction } from './auditRuntimeBusinessPrivileges';
import { inspectCustomerCashierSecondCardRuntimePrivileges } from './auditCustomerCashierSecondCardRuntimePrivileges';
import { captureRuntimeGiftPeerDeclarations, type RuntimeGiftPeerDeclarations } from './customerRuntimeGiftPeers';
import { captureRuntimeAppCashierOriginReader, type RuntimeAppCashierOriginReaderAddon } from './runtimeAppCashierOriginReader';
import { inspectRoutinePaymentRuntime, type RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';
import { captureCashierConditionalTarget, CASHIER_RUNTIME_CONDITIONAL_OPERATION, CASHIER_RUNTIME_CONDITIONAL_TABLES,
  cashierRuntimeConditionalDefinitions, inspectCashierRuntimeConditionalBoundary,
  inspectCashierRuntimeConditionalCatalogs } from './cashierRuntimeConditionalBoundary';

type Query = Pick<DbClient, 'execute'>;
export const CASHIER_RUNTIME_CONDITIONAL_GATES = [[731669, 0], [731670, 0], [731625, 2], [731624, 0], [731685, 0]] as const;
function key(t: RoutinePaymentRuntimeTarget) {
  return JSON.stringify([t.database, t.maintenance, t.app, t.admin, [...(t.local ?? [])].sort(),
    t.caseLock ? [t.caseLock.owner, [...t.caseLock.runtimeRoles].sort()] : null]);
}
function capture(declared: RoutinePaymentRuntimeTarget, value: RuntimeGiftPeerDeclarations, reader?:RuntimeAppCashierOriginReaderAddon) {
  const peers = captureRuntimeGiftPeerDeclarations(value), cashier = peers.cashierSecondCard;
  if (!cashier || cashier.conditionalGuards !== true) throw Error('Explicit successor Cashier conditional gift peer required');
  const target = captureCashierConditionalTarget(declared, cashier.role);
  if (key(target) !== key(peers.target)) throw Error('Cashier conditional peers must bind the complete same routine target');
  const previous = captureRuntimeGiftPeerDeclarations({ ...peers, cashierSecondCard: { role:cashier.role, abandon:true,
    ...(cashier.formImages ? { formImages:true } : {}) } });
  return { target, peers, previous, role:cashier.role, appReader:reader ? captureRuntimeAppCashierOriginReader(reader) : undefined };
}

/** Exact five-function forward, preserving function and trigger OIDs. No
 * grants, LOGIN changes, source installation, row rewrite or drift repair. */
export async function upgradeCashierRuntimeConditionalBoundaryInTransaction(tx:Query, declared:RoutinePaymentRuntimeTarget,
  declaration:RuntimeGiftPeerDeclarations, reader?:RuntimeAppCashierOriginReaderAddon) {
  if (Object.hasOwn(tx, '$client')) throw Error('Cashier conditional forward requires a caller-owned transaction');
  const { target, peers, previous, role, appReader } = capture(declared, declaration, reader);
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
  const [identity] = await tx.execute(sql`SELECT current_database()=${target.database} AND current_user=${target.maintenance}
    AND current_user=session_user AND current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed' AND current_setting('transaction_read_only')='off'
    AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
      WHERE a.pid=pg_backend_pid() AND r.rolname=current_user AND r.rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS ready`);
  if (identity?.ready !== true) throw Error('Cashier conditional maintenance identity refused');
  for (const [key, subkey] of CASHIER_RUNTIME_CONDITIONAL_GATES) {
    const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${key},${subkey}) AS locked`);
    if (gate?.locked !== true) throw Error('Cashier conditional maintenance is busy');
  }
  const complete = async (declaration:RuntimeGiftPeerDeclarations) => {
    const app = await inspectRuntimeBusinessProfileInTransaction(tx, 'app', target, 'current', declaration, appReader);
    const admin = await inspectRuntimeBusinessProfileInTransaction(tx, 'admin', target, 'current', declaration);
    const cashier = await inspectCustomerCashierSecondCardRuntimePrivileges(tx, { role, requireLogin:true,
      routine:{target, stage:'ready'}, abandon:true,
      ...(declaration.cashierSecondCard?.conditionalGuards ? { conditionalGuards:true } : {}),
      ...(declaration.cashierSecondCard?.formImages ? { formImages:true } : {}) });
    return { ready:app.ready && admin.ready && cashier.ready, app, admin, cashier };
  };
  if (!(await inspectRoutinePaymentRuntime(tx, target)).ready) throw Error('Exact Cashier conditional routine target required');
  const candidate = await inspectCashierRuntimeConditionalBoundary(tx, target, role);
  if (candidate.ready) {
    const audit = await complete(peers);
    if (!audit.ready) throw Error('Complete successor Cashier conditional profiles refused');
    return { operation:CASHIER_RUNTIME_CONDITIONAL_OPERATION, changed:false as const, target, role, audit,
      binding:candidate.binding, privilegesChanged:false as const, credentialChanged:false as const,
      historicalRowsReassigned:false as const, completeServiceCoverageVerified:false as const };
  }
  if (!candidate.binding || !(await inspectCashierRuntimeConditionalCatalogs(tx, target)).ready
    || !(await complete(previous)).ready) throw Error('Exact complete prior App, Admin and Cashier profiles required');
  const lockedTables = [...new Set([...CASHIER_RUNTIME_CONDITIONAL_TABLES,
    'routine_identity_witness', 'routine_payment_attempt', 'payment_reconciliation_action', 'payment_reconciliation_case',
    'cashier_second_card_cart_v1', 'cashier_second_card_origin_v1', 'cashier_second_card_payment_v1'])].sort();
  await tx.execute(sql.raw('LOCK TABLE '+lockedTables.map(t => 'ONLY public.'+pricingIdentifier(t)).join(',')+' IN ACCESS EXCLUSIVE MODE NOWAIT'));
  const locked = await inspectCashierRuntimeConditionalBoundary(tx, target, role);
  if (!locked.binding || JSON.stringify(locked.binding) !== JSON.stringify(candidate.binding)
    || JSON.stringify(locked.functions) !== JSON.stringify(candidate.functions)
    || JSON.stringify(locked.triggers) !== JSON.stringify(candidate.triggers)
    || !(await inspectCashierRuntimeConditionalCatalogs(tx, target)).ready
    || !(await complete(previous)).ready || !(await inspectRoutinePaymentRuntime(tx, target)).ready)
    throw Error('Cashier conditional prior binding changed while locking');
  for (const [name, body] of cashierRuntimeConditionalDefinitions(target, locked.binding))
    await tx.execute(sql.raw(`CREATE OR REPLACE FUNCTION public.${pricingIdentifier(name)}() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $cashier_conditional$${body}$cashier_conditional$`));
  const post = await inspectCashierRuntimeConditionalBoundary(tx, target, role), audit = await complete(peers);
  if (!post.ready || !audit.ready || JSON.stringify(post.binding) !== JSON.stringify(candidate.binding)
    || JSON.stringify(post.triggers) !== JSON.stringify(candidate.triggers)
    || JSON.stringify(post.functions.map(f => [f.name,f.oid])) !== JSON.stringify(candidate.functions.map(f => [f.name,f.oid]))
    || !(await inspectRoutinePaymentRuntime(tx, target)).ready) throw Error('Complete Cashier conditional successor verification failed');
  return { operation:CASHIER_RUNTIME_CONDITIONAL_OPERATION, changed:true as const, target, role, audit,
    binding:post.binding, privilegesChanged:false as const, credentialChanged:false as const,
    historicalRowsReassigned:false as const, completeServiceCoverageVerified:false as const };
}

export async function upgradeCashierRuntimeConditionalBoundary(db:DbClient, declared:RoutinePaymentRuntimeTarget,
  declaration:RuntimeGiftPeerDeclarations, reader?:RuntimeAppCashierOriginReaderAddon) {
  if (!Object.hasOwn(db,'$client') || !db.$client) throw Error('Root Cashier conditional maintenance connection required');
  const c = capture(declared, declaration, reader);
  try { return await db.transaction(tx => upgradeCashierRuntimeConditionalBoundaryInTransaction(tx,c.target,c.peers,c.appReader),
    { isolationLevel:'read committed', accessMode:'read write' }); }
  catch { throw Error('Cashier conditional forward outcome not confirmed; inspect the exact profiles before further action'); }
}
