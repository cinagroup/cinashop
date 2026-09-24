import { sql } from "drizzle-orm";
import type { DbClient } from "@/lib/di";

// The existing offline_order protocol reserves this exact number format and
// locks other_order after callback ingress. Its initiation locks other_order
// before reconciliation, so adding this store-order boundary would reverse
// that lock order. Store orders generated here use the separate wx number space.
const OFFLINE_ORDER_NO = /^xx[0-9a-f]{30}$/;

/**
 * Serialize payment evidence with assisted-order writers for one order number.
 * Local writers already hold the store_order row before calling this. Evidence writers
 * must take this transaction-level lock before provider transaction/case locks,
 * and must not then wait on the store_order row in the same transaction. The
 * reserved offline-order domain retains its pre-existing separate lock protocol.
 */
export async function lockStoreOrderPaymentBoundary(tx: DbClient, orderNo: string): Promise<void> {
  if (OFFLINE_ORDER_NO.test(orderNo)) return;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(
    hashtextextended(${`store-order-payment-evidence:v1:${orderNo}`}, 0)
  )`);
}
