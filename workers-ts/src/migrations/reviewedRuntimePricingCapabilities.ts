import type { DbClient } from '../lib/di';
import { sql } from 'drizzle-orm';
import { auditCheckoutPricingLockRuntime, inspectCheckoutPricingLock } from './checkoutPricingLock';
import { reviewedOfflinePricingOid, validatePricingRuntimeScope, type PricingRuntimeScope } from './reviewedOfflinePricingCapability';

/** Only an explicitly shared application identity with both exact installed
 * pricing protocols may exempt these two OIDs from an unrelated permission
 * envelope. Never authorize by function name or invoke either capability. */
export async function reviewedRuntimePricingCapabilities(tx: Pick<DbClient,'execute'>, schema: string, scope: PricingRuntimeScope) {
  validatePricingRuntimeScope(scope);
  if (scope !== 'shared-shop') return { checkout:null, offline:null };
  // PostgreSQL's pg_get_* display qualification depends on search_path. The
  // offline contract was pinned under this fixed trusted path, while the
  // shipping audit deliberately uses pg_catalog. Restore the enclosing audit's
  // path even when verification fails; never use a caller-selected schema here.
  const [previous]=await tx.execute(sql`SELECT current_setting('search_path') AS value`);
  if(typeof previous?.value!=='string')throw Error('Missing catalog inspection search path');
  await tx.execute(sql`SELECT pg_catalog.set_config('search_path','public,pg_temp',true)`);
  try {
    if (!(await auditCheckoutPricingLockRuntime(tx,schema,scope)).ready) return { checkout:null, offline:null };
    return { checkout:(await inspectCheckoutPricingLock(tx,schema)).functionOid, offline:await reviewedOfflinePricingOid(tx,schema) };
  } finally { await tx.execute(sql`SELECT pg_catalog.set_config('search_path',${previous.value},true)`); }
}
