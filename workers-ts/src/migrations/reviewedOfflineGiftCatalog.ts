import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { OFFLINE_BARCODE_CATALOG_VERSIONS, OFFLINE_CATALOG_SQL, OFFLINE_CATALOG_VERSIONS } from './offlineOrderCatalog';
import { inspectOrderPromotionGiftReceiptCatalog } from './orderPromotionGiftReceipt';

/** The immutable offline v1 catalog includes indexes on the shared user_bill
 * table. 0176 adds exactly one independently reviewed points replay index.
 * Keep the original catalog and hashes intact; only this read-only view can
 * remove that index from the offline shape, and only after 0176 proves it. */
const originalIndexPredicate = 'WHERE i.indrelid=r.oid),';
if (OFFLINE_CATALOG_SQL.split(originalIndexPredicate).length !== 2) {
  throw Error('Offline catalog index projection changed; review gift compatibility');
}
export const REVIEWED_OFFLINE_GIFT_CATALOG_SQL = OFFLINE_CATALOG_SQL.replace(
  originalIndexPredicate,
  "WHERE i.indrelid=r.oid AND NOT (r.name='user_bill' AND ic.relname='ub_order_promotion_gift_uq')),",
);

type Query = Pick<DbClient, 'execute'>;
type CatalogRows = Awaited<ReturnType<Query['execute']>>;
function exactOfflineV1(rows: CatalogRows, requireOwner: boolean) {
  const expected = OFFLINE_CATALOG_VERSIONS.v1;
  return rows.length === 27 && new Set(rows.map(row => row.name)).size === 27
    && rows.every(row => typeof row.name === 'string' && Object.hasOwn(expected, row.name)
      && row.present === true && row.safe === true && (!requireOwner || row.owned === true)
      && (row.fingerprint === expected[row.name]
        || row.fingerprint === OFFLINE_BARCODE_CATALOG_VERSIONS.v1[row.name]));
}

/** Review all 27 original components. A new index is masked only after the
 * exact 0176 table, sequence, points index, and requested owner/ACL envelope
 * have been verified in the same caller transaction. Other drift stays drift. */
export async function inspectReviewedOfflineGiftCatalog(tx: Query, options: {
  requireOwner?: boolean; maintenance?: string; runtime?: { app: string; admin: string };
} = {}) {
  const original = await tx.execute(sql.raw(OFFLINE_CATALOG_SQL));
  // A partially removed 0176 must never masquerade as legacy v1 merely
  // because its points index disappeared and the old user_bill hash returned.
  const [presence] = await tx.execute(sql`SELECT NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c
    WHERE c.relnamespace='public'::regnamespace AND c.relname IN (
      'store_order_promotion_gift_coupon_reward',
      'store_order_promotion_gift_coupon_reward_id_seq',
      'sopgcr_order_aux_uq', 'sopgcr_coupon_user_uq', 'sopgcr_uid_order',
      'ub_order_promotion_gift_uq')) AS absent`);
  if (presence?.absent === true && exactOfflineV1(original, options.requireOwner === true)) {
    return { state: 'v1' as const, rows: original };
  }
  const gift = await inspectOrderPromotionGiftReceiptCatalog(tx, options.maintenance, options.runtime);
  if (!gift.ready) return { state: 'drift' as const, rows: original };
  const normalized = await tx.execute(sql.raw(REVIEWED_OFFLINE_GIFT_CATALOG_SQL));
  return exactOfflineV1(normalized, options.requireOwner === true)
    ? { state: 'v1-gift-index' as const, rows: normalized }
    : { state: 'drift' as const, rows: original };
}
