import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { OFFLINE_CATALOG_SQL, OFFLINE_CATALOG_VERSIONS } from './offlineOrderCatalog';

export type PricingRuntimeScope = 'isolated' | 'shared-shop';
export function validatePricingRuntimeScope(scope: PricingRuntimeScope) {
  if (scope !== 'isolated' && scope !== 'shared-shop') throw Error('Invalid pricing runtime scope');
}

/** Explicit shared-identity review, never a function-name allowlist. All 27
 * pinned objects, their safety/ACL envelopes and exact function OID must match.
 * Missing or drifted protocols receive no exception. No function is invoked.
 * Call only inside the caller's catalog snapshot. Ownership is checked by the
 * runtime envelope; the LOGIN must never own or reach the maintenance role. */
export async function reviewedOfflinePricingOid(tx: Pick<DbClient, 'execute'>, schema: string) {
  if (schema !== 'public') return null;
  const rows = await tx.execute(sql.raw(OFFLINE_CATALOG_SQL));
  const expected = OFFLINE_CATALOG_VERSIONS.v1;
  if (rows.length !== 27 || new Set(rows.map(row => row.name)).size !== 27
    || !rows.every(row => typeof row.name === 'string' && Object.hasOwn(expected, row.name)
      && row.present === true && row.safe === true && row.fingerprint === expected[row.name])) return null;
  const capability = rows.find(row => row.kind === 'function' && row.name === 'ooa_lock_pricing');
  return typeof capability?.oid === 'string' && /^\d+$/.test(capability.oid) ? capability.oid : null;
}
