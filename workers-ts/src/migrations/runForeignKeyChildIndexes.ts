import { sql } from "drizzle-orm";
import type { DbClient } from "../lib/di";
import { FOREIGN_KEY_CHILD_INDEX_SQL } from "./foreignKeyChildIndexes";

/** Additive, write-blocking maintenance only. Caller owns authorization and connection lifecycle.
 * No I/O at import, no historical data backfill. Both indexes commit or roll back together.
 */
export async function runForeignKeyChildIndexes(
  db: Pick<DbClient, "transaction"> & Partial<Pick<DbClient, "$client">>,
  schema = "public",
): Promise<void> {
  if (!db.$client) throw new Error("Foreign key indexes require a root database, not a nested transaction");
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema) || schema.startsWith("pg_") || schema === "information_schema") {
    throw new Error("Invalid foreign key index schema");
  }
  await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL search_path TO ${sql.identifier(schema)}, pg_temp`);
    // Arm before DO begins; zero is disabled and stricter caller deadlines win.
    await tx.execute(sql.raw(`SELECT
      pg_catalog.set_config('statement_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),30000)::text || 'ms',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
    await tx.execute(sql.raw(FOREIGN_KEY_CHILD_INDEX_SQL));
  }, { isolationLevel: "read committed" });
}
