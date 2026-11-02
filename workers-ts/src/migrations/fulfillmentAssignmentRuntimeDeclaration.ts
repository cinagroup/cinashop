/** Trusted shared declaration, captured as plain data before any SQL. */
import { captureRuntimeGiftPeerDeclarations, type RuntimeGiftPeerDeclarations } from './customerRuntimeGiftPeers';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from './customerFinancialRuntimePlan';
import { MANAGER_RUNTIME_ROLE } from './managerRuntimePrivilegePlan';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { assignmentRecord, assignmentSnapshot } from '@/services/order/FulfillmentAssignmentProtocol';

export type AssignmentRuntimeDeclaration = Readonly<RuntimeGiftPeerDeclarations>;
export const ASSIGNMENT_SOURCE_TABLES = Object.freeze(['store_order', 'store_order_cart_info', 'store_order_refund',
  'store_order_refund_split', 'store_order_fulfillment_branch', 'store_order_outbox', 'order_waybill_job', 'system_store', 'system_admin', 'system_role']);

/** Call only from trusted composition/configuration, never from request JSON.
 * Missing configuration closes the author. Metadata never learns a target. */
export function captureAssignmentRuntimeDeclaration(value: RuntimeGiftPeerDeclarations): AssignmentRuntimeDeclaration {
  const detached = assignmentSnapshot(value, { nodes: 256, bytes: 65536, string: 1024 }) as RuntimeGiftPeerDeclarations;
  if (detached.target?.caseLock) assignmentRecord(detached.target.caseLock, ['owner', 'runtimeRoles']);
  const peers = captureRuntimeGiftPeerDeclarations(detached), t = peers.target;
  if (!peers.fulfillmentAssignments || !peers.financial || !peers.cashierSecondCard || peers.manager !== true
    || !t.local?.includes(CUSTOMER_FINANCIAL_RUNTIME_ROLE) || !t.local.includes(MANAGER_RUNTIME_ROLE)
    || !t.local.includes(peers.cashierSecondCard.role) || t.local.length > 16) throw Error('Complete explicit assignment runtime declaration required');
  const ids = [t.maintenance, t.app, t.admin, ...(t.local ?? [])];
  for (const id of [t.database, ...ids]) {
    if (typeof id !== 'string') throw Error('Primitive assignment runtime identity required');
    pricingIdentifier(id);
  }
  if (new Set(ids).size !== ids.length || t.caseLock && (ids.includes(t.caseLock.owner)
    || !t.caseLock.runtimeRoles.length || t.caseLock.runtimeRoles.length > 16
    || new Set(t.caseLock.runtimeRoles).size !== t.caseLock.runtimeRoles.length
    || t.caseLock.runtimeRoles.some(n => !t.local?.includes(n)))) throw Error('Independent assignment runtime identities required');
  return assignmentSnapshot(peers, { nodes: 256, bytes: 65536, string: 1024 }) as AssignmentRuntimeDeclaration;
}
