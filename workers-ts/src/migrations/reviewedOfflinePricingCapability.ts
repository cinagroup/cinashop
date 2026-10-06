import type { DbClient } from '../lib/di';
import { inspectReviewedOfflineGiftCatalog } from './reviewedOfflineGiftCatalog';

export type PricingRuntimeScope = 'isolated' | 'shared-shop' | 'customer-work';
export function validatePricingRuntimeScope(scope: PricingRuntimeScope) {
  if (scope !== 'isolated' && scope !== 'shared-shop' && scope !== 'customer-work') throw Error('Invalid pricing runtime scope');
}

/** Explicit shared-identity review, never a function-name allowlist. All 27
 * pinned objects, their safety/ACL envelopes and exact function OID must match.
 * Missing or drifted protocols receive no exception. No function is invoked.
 * Call only inside the caller's catalog snapshot. Ownership is checked by the
 * runtime envelope; the LOGIN must never own or reach the maintenance role. */
export async function reviewedOfflinePricingOid(tx: Pick<DbClient, 'execute'>, schema: string) {
  if (schema !== 'public') return null;
  const reviewed = await inspectReviewedOfflineGiftCatalog(tx);
  if (reviewed.state === 'drift') return null;
  const rows = reviewed.rows;
  const capability = rows.find(row => row.kind === 'function' && row.name === 'ooa_lock_pricing');
  return typeof capability?.oid === 'string' && /^\d+$/.test(capability.oid) ? capability.oid : null;
}
