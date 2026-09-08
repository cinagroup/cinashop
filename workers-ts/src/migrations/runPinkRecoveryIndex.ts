import { sql } from "drizzle-orm";
import type { DbClient } from "../lib/di";
import { PINK_RECOVERY_INDEX_SQL } from "./pinkRecoveryIndex";

/** Single-purpose maintenance; caller owns authorization and connection lifecycle.
 * No I/O at import. Default public; explicit schema supports isolated verification.
 * This is a bounded, write-blocking build, NOT an online/concurrent migration.
 */
export async function runPinkRecoveryIndex(
  db: Pick<DbClient, "transaction"> & Partial<Pick<DbClient, "$client">>,
  schema = "public",
): Promise<void> {
  if (!db.$client) throw new Error("Recovery index requires a root database, not a nested transaction");
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema) || schema.startsWith("pg_") || schema === "information_schema") {
    throw new Error("Invalid recovery index schema");
  }
  await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL search_path TO ${sql.identifier(schema)}, pg_temp`);
    // Arm deadlines BEFORE the DO starts; setting statement_timeout inside it is too late.
    // Zero means disabled; preserve any stricter caller budget. Settings are transaction-local.
    await tx.execute(sql.raw(`SELECT
      pg_catalog.set_config('statement_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),30000)::text || 'ms',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
    await tx.execute(sql.raw(PINK_RECOVERY_INDEX_SQL));
  }, { isolationLevel: "read committed" });
}
