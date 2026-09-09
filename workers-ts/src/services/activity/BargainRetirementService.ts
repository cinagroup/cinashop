import { eq, sql } from "drizzle-orm";
import { withTx, type Container } from "@/lib/di";
import { storeBargain } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

/** PHP deletion is a tombstone, not a deletion of order/participation history. */
export async function retireBargain(container: Container, rawId: unknown): Promise<void> {
  if (typeof rawId !== "string" || !/^[1-9]\d{0,9}$/.test(rawId) || Number(rawId) > 2_147_483_647) {
    throw new ValidateException("砍价活动ID错误");
  }
  await withTx(container, async tx => {
    await tx.execute(sql.raw(`SELECT
      pg_catalog.set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms',true),
      pg_catalog.set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
    // A non-key UPDATE serializes with checkout's NO KEY UPDATE and start's
    // SHARE, but permits help's KEY SHARE. Do not lock participants or SKUs:
    // their transactions perform their own final admission check/compensation.
    const rows = await tx.update(storeBargain).set({ isDel: 1 })
      .where(eq(storeBargain.id, Number(rawId))).returning({ id: storeBargain.id });
    if (!rows[0]) throw new ValidateException("砍价活动不存在");
  });
}
