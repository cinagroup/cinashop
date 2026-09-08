import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import { storeBargain } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

/** Checkout/cancel/refund take this boundary before carts, settlement users
 * or SKUs. NO KEY UPDATE permits help's KEY SHARE while it owns a participant;
 * FOR UPDATE would create an activity -> participant -> activity deadlock.
 * Cancellation/refund need the lock, not an active/purchasable activity.
 */
export async function lockBargainInventory(tx: DbClient, activityId: number): Promise<boolean> {
  if (!Number.isInteger(activityId) || activityId <= 0 || activityId > 2_147_483_647) return false;
  const rows = await tx.select({ id: storeBargain.id }).from(storeBargain)
    .where(eq(storeBargain.id, activityId)).limit(1).for("no key update");
  return Boolean(rows[0]);
}

/** Call as the last SQL admission check before returning from a create
 * transaction holding the inventory boundary. Stock/participant/SKU waits can
 * outlive the earlier reservation check; expiry must roll back every write.
 */
export async function assertBargainCheckoutWindow(tx: DbClient, activityId: number): Promise<void> {
  const rows = await tx.select({ id: storeBargain.id }).from(storeBargain).where(and(
    eq(storeBargain.id, activityId), eq(storeBargain.status, 1), eq(storeBargain.isDel, 0),
    sql`(${storeBargain.startTime} IS NULL OR ${storeBargain.startTime} <= (clock_timestamp() AT TIME ZONE 'UTC'))`,
    sql`(${storeBargain.stopTime} IS NULL OR ${storeBargain.stopTime} >= (clock_timestamp() AT TIME ZONE 'UTC'))`,
  )).limit(1);
  if (!rows[0]) throw new ValidateException("砍价活动已结束，请刷新后重试");
}
