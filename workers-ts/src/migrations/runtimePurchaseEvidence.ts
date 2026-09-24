import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { PURCHASE_ORIGIN_STATE_SQL } from './purchaseOriginEvidenceCatalog';
import { PURCHASE_CANCELLATION_STATE_SQL } from './purchaseCancellationEvidenceCatalog';
import { PURCHASE_CANCELLATION_SOURCE_SQL } from './purchaseCancellationEvidenceInstallation';

type Query = Pick<DbClient, 'execute'>;

/** Read the existing canonical metadata contracts under an explicit owner,
 * without SET ROLE, definer privileges, or changing the immutable SQL artifacts.
 * Only their exact catalog-owner comparisons are parameterized; this is not a
 * caller-provided SQL rewriter. Function definitions/fingerprints stay intact. */
function underOwner(source: string, maintenance: string, comparisons: number) {
  const parts = source.split('rolname=current_user');
  if (parts.length !== comparisons + 1) throw Error('Purchase evidence owner contract changed');
  return sql.join(parts.map((part, index) => index === 0 ? sql.raw(part)
    : sql`rolname=${maintenance}${sql.raw(part)}`), sql.raw(''));
}

/** Catalog-only, point-in-time proof for maintenance and independently
 * authenticated runtime auditors. It reads no receipt/business rows, grants
 * nothing, and does not certify all service permissions or historical data. */
export async function inspectRuntimePurchaseEvidence(tx: Query, maintenance: string) {
  pricingIdentifier(maintenance);
  const [row] = await tx.execute(sql`WITH origin AS (${underOwner(PURCHASE_ORIGIN_STATE_SQL, maintenance, 1)}),
    cancellation AS (${underOwner(PURCHASE_CANCELLATION_STATE_SQL, maintenance, 1)}),
    sources AS (${underOwner(PURCHASE_CANCELLATION_SOURCE_SQL, maintenance, 3)})
    SELECT origin.state AS origin, cancellation.state AS cancellation, sources.ready AS sources,
      current_setting('server_version_num')::integer/10000=16
      AND current_setting('session_replication_role')='origin'
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS environment
    FROM origin CROSS JOIN cancellation CROSS JOIN sources`);
  return { origin: row?.origin, cancellation: row?.cancellation, sourcesReady: row?.sources === true,
    ready: row?.origin === 'v1' && row?.cancellation === 'v1' && row?.sources === true && row?.environment === true };
}

/** Fixed maintenance prerequisite, not an installer or repair path. Hold the
 * shared evidence fence and canonical six-table lock order through the caller's
 * grant transaction. Never adopt an ORM table or create missing protection. */
export async function lockRuntimePurchaseEvidenceForGrants(tx: Query, maintenance: string) {
  if (Object.hasOwn(tx, '$client')) throw Error('Purchase evidence grant check requires a transaction');
  pricingIdentifier(maintenance);
  const [environment] = await tx.execute(sql`SELECT current_user=${maintenance} AND session_user=current_user
    AND current_setting('transaction_isolation')='read committed'
    AND current_setting('transaction_read_only')='off' AS ready`);
  if (environment?.ready !== true) throw Error('Purchase evidence grant transaction requires review');
  const [fence] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731611,0) AS locked`);
  if (fence?.locked !== true) throw Error('Purchase evidence maintenance is busy');
  if (!(await inspectRuntimePurchaseEvidence(tx, maintenance)).ready)
    throw Error('Purchase evidence protocols must already be installed');
  await tx.execute(sql`LOCK TABLE ONLY public.store_order IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
  await tx.execute(sql`LOCK TABLE ONLY public.store_order_cart_info IN SHARE MODE NOWAIT`);
  await tx.execute(sql`LOCK TABLE ONLY public.store_order_purchase_origin IN SHARE MODE NOWAIT`);
  await tx.execute(sql`LOCK TABLE ONLY public.store_order_status IN SHARE MODE NOWAIT`);
  await tx.execute(sql`LOCK TABLE ONLY public.user_bill IN SHARE MODE NOWAIT`);
  await tx.execute(sql`LOCK TABLE ONLY public.store_order_purchase_cancellation IN ACCESS EXCLUSIVE MODE NOWAIT`);
  if (!(await inspectRuntimePurchaseEvidence(tx, maintenance)).ready)
    throw Error('Purchase evidence protocol changed during grant locking');
}
