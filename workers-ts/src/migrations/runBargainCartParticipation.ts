import { sql } from "drizzle-orm";
import type { DbClient } from "../lib/di";
import { BARGAIN_CART_PARTICIPATION_SQL } from "./bargainCartParticipation";

/** Additive, ACCESS EXCLUSIVE maintenance: apply before deploying the new cart model.
 * Caller owns authorization/connection lifecycle; no historical replay or automatic retries.
 */
export async function runBargainCartParticipation(
  db: Pick<DbClient, "transaction"> & Partial<Pick<DbClient, "$client">>,
  schema = "public",
): Promise<void> {
  if (!db.$client) throw new Error("Bargain cart binding requires a root database, not a nested transaction");
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema) || schema.startsWith("pg_") || schema === "information_schema") {
    throw new Error("Invalid bargain cart binding schema");
  }
  await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL search_path TO ${sql.identifier(schema)}, pg_temp`);
    await tx.execute(sql.raw(`SELECT
      pg_catalog.set_config('statement_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),30000)::text || 'ms',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
    await tx.execute(sql.raw(BARGAIN_CART_PARTICIPATION_SQL));
  }, { isolationLevel: "read committed" });
}
