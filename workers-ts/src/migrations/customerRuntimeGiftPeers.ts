import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import type { RoutinePaymentRuntimeTarget } from './routinePaymentRuntime';
import { inspectRoutinePaymentRuntime } from './routinePaymentRuntime';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE, customerFinancialRuntimePrivilegePlan } from './customerFinancialRuntimePlan';
import { inspectCustomerFinancialRuntimePrivileges, type CustomerFinancialManualRefundAddon } from './auditCustomerFinancialRuntimePrivileges';
import { captureCustomerFinancialOriginalPaymentReaders, type CustomerFinancialOriginalPaymentReadersAddon } from './customerFinancialOriginalPaymentReaders';
import { MANAGER_RUNTIME_ROLE, managerRuntimePrivilegePlan } from './managerRuntimePrivilegePlan';
import { inspectManagerRuntimePrivileges } from './auditManagerRuntimePrivileges';
import { inspectCustomerCashierSecondCardRuntimePrivileges } from './auditCustomerCashierSecondCardRuntimePrivileges';

/** Explicit maintenance/runtime audit declarations, never learned from ACLs.
 * A gift permission exception follows the entire declared source profile.
 * This verifies the shared append-only gift contract, not every business
 * operation or inherited conditional-write boundary of those profiles. */
export interface RuntimeGiftPeerDeclarations {
  target: RoutinePaymentRuntimeTarget;
  financial?: { manualRefund?: CustomerFinancialManualRefundAddon;
    originalPaymentReaders?: CustomerFinancialOriginalPaymentReadersAddon };
  cashierSecondCard?: { role: string; abandon: true; conditionalGuards?: true; formImages?: true };
  manager?: true;
}
const giftTable = 'store_order_promotion_gift_coupon_reward';
const giftSequence = giftTable + '_id_seq';

export function captureRuntimeGiftPeerDeclarations(value: RuntimeGiftPeerDeclarations): RuntimeGiftPeerDeclarations {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['target', 'financial', 'cashierSecondCard', 'manager'].includes(key))
    || !value.target || ![value.financial, value.cashierSecondCard, value.manager].some(Boolean))
    throw Error('Explicit bounded gift peer declarations required');
  const t = value.target;
  for (const name of [t.database, t.maintenance, t.app, t.admin, ...(t.local ?? []),
    ...(t.caseLock ? [t.caseLock.owner, ...t.caseLock.runtimeRoles] : [])]) pricingIdentifier(name);
  if (value.financial && (Object.keys(value.financial).some(key => !['manualRefund', 'originalPaymentReaders'].includes(key))
    || !t.local?.includes(CUSTOMER_FINANCIAL_RUNTIME_ROLE))) throw Error('Explicit bound Financial gift peer required');
  if (value.financial?.manualRefund) {
    if (Object.keys(value.financial.manualRefund).join(',') !== 'promotionOwner') throw Error('Explicit manual owner required');
    pricingIdentifier(value.financial.manualRefund.promotionOwner);
  }
  if (value.financial?.originalPaymentReaders) captureCustomerFinancialOriginalPaymentReaders(value.financial.originalPaymentReaders);
  const cashier = value.cashierSecondCard;
  if (cashier) {
    pricingIdentifier(cashier.role);
    if (Reflect.ownKeys(cashier).some(key => typeof key !== 'string' || !['role', 'abandon', 'conditionalGuards', 'formImages'].includes(key)) || cashier.abandon !== true
      || cashier.conditionalGuards !== undefined && cashier.conditionalGuards !== true
      || cashier.formImages !== undefined && cashier.formImages !== true
      || !t.local?.includes(cashier.role)
      || [t.maintenance, t.app, t.admin, CUSTOMER_FINANCIAL_RUNTIME_ROLE, MANAGER_RUNTIME_ROLE].includes(cashier.role))
      throw Error('Explicit independent bound cashier gift peer required');
  }
  if (value.manager !== undefined && (value.manager !== true || !t.local?.includes(MANAGER_RUNTIME_ROLE)))
    throw Error('Explicit bound Manager gift peer required');
  return { target: { database: t.database, maintenance: t.maintenance, app: t.app, admin: t.admin,
    ...(t.local ? { local: [...t.local] } : {}),
    ...(t.caseLock ? { caseLock: { owner: t.caseLock.owner, runtimeRoles: [...t.caseLock.runtimeRoles] } } : {}) },
    ...(value.financial ? { financial: {
      ...(value.financial.manualRefund ? { manualRefund: { ...value.financial.manualRefund } } : {}),
      ...(value.financial.originalPaymentReaders ? { originalPaymentReaders: { secondCard: true as const } } : {}),
    } } : {}), ...(cashier ? { cashierSecondCard: { role: cashier.role, abandon: true as const,
      ...(cashier.conditionalGuards ? { conditionalGuards: true as const } : {}),
      ...(cashier.formImages ? { formImages: true as const } : {}) } } : {}),
    ...(value.manager ? { manager: true as const } : {}) };
}

export async function inspectReviewedRuntimeGiftPeers(db: Pick<DbClient, 'execute'>,
  runtime: { app: string; admin: string }, maintenance: string, declaration: RuntimeGiftPeerDeclarations) {
  const peers = captureRuntimeGiftPeerDeclarations(declaration), target = peers.target;
  const failures: string[] = [], grants: Array<{ role: string; oid: string; table: string[]; sequence: string[]; kind: string }> = [];
  if (target.maintenance !== maintenance || target.app !== runtime.app || target.admin !== runtime.admin)
    failures.push('peer_target_identity');
  const [database] = await db.execute<{ ready: boolean }>(sql`SELECT current_database()=${target.database} AS ready`);
  if (database?.ready !== true || !(await inspectRoutinePaymentRuntime(db, target)).ready) failures.push('peer_routine_binding');
  const append = async (kind: string, role: string, table: readonly string[], sequence: readonly string[]) => {
    const rows = await db.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_roles WHERE rolname=${role}`);
    if (rows.length !== 1 || !/^[1-9][0-9]*$/u.test(rows[0].oid) || grants.some(item => item.oid === rows[0].oid)) {
      failures.push('peer_oid:' + kind); return;
    }
    grants.push({ kind, role, oid: rows[0].oid, table: [...table], sequence: [...sequence] });
  };
  // Each peer's catalog inspection calls the gift helper without runtime
  // identities. That proves the canonical objects and terminates recursion;
  // no skip-self or unchecked OID exception is used for a profile comparison.
  if (peers.financial) {
    const proof = await inspectCustomerFinancialRuntimePrivileges(db, { requireLogin: true,
      routine: { target, stage: 'ready' }, ...peers.financial });
    if (!proof.ready) failures.push(...proof.failures.map(name => 'financial:' + name));
    else {
      const privileges = customerFinancialRuntimePrivilegePlan().tables[giftTable];
      if (JSON.stringify(privileges) !== '["SELECT","INSERT"]') throw Error('Financial gift source plan changed');
      await append('financial', CUSTOMER_FINANCIAL_RUNTIME_ROLE, privileges, ['USAGE']);
    }
  }
  if (peers.cashierSecondCard) {
    const proof = await inspectCustomerCashierSecondCardRuntimePrivileges(db, { role: peers.cashierSecondCard.role,
      requireLogin: true, routine: { target, stage: 'ready' }, abandon: true,
      ...(peers.cashierSecondCard.conditionalGuards ? { conditionalGuards: true } : {}),
      ...(peers.cashierSecondCard.formImages ? { formImages: true } : {}) });
    if (!proof.ready) failures.push(...proof.failures.map(name => 'cashier:' + name));
    else {
      const source = proof.giftSourcePrivileges;
      if (!source || source.table !== giftTable || source.sequence !== giftSequence
        || JSON.stringify(source.privileges) !== '["SELECT","INSERT"]'
        || JSON.stringify(source.sequencePrivileges) !== '["USAGE"]') throw Error('Cashier gift source plan changed');
      await append('cashier-second-card', peers.cashierSecondCard.role, source.privileges, source.sequencePrivileges);
    }
  }
  if (peers.manager) {
    const proof = await inspectManagerRuntimePrivileges(db, { requireLogin: true, routine: { target, stage: 'ready' } });
    if (!proof.ready) failures.push(...proof.failures.map(name => 'manager:' + name));
    else {
      const plan = managerRuntimePrivilegePlan('current');
      if (JSON.stringify(plan.tables[giftTable]) !== '["SELECT"]') throw Error('Manager gift source plan changed');
      await append('manager', MANAGER_RUNTIME_ROLE, plan.tables[giftTable], []);
    }
  }
  return { ready: failures.length === 0, failures: [...new Set(failures)].sort(), grants,
    readOnly: true as const, conditionalWriteSemanticsVerified: false as const, completeServiceCoverageVerified: false as const };
}
