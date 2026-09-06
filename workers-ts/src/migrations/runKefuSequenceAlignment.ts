import { sql } from "drizzle-orm";
import type { DbClient } from "../lib/di";
import { KEFU_SEQUENCE_ALIGNMENT_SQL } from "./kefuSequenceAlignment";

/**
 * Explicit, single-purpose public-schema maintenance operation. The caller owns
 * approval, connection creation and closing. Importing this module does no I/O.
 * Do not substitute runAll(): historical migrations also contain data backfills.
 */
export async function runKefuSequenceAlignment(
  db: Pick<DbClient, "$client" | "transaction">,
): Promise<void> {
  // A nested Drizzle transaction uses a savepoint, not an independent commit;
  // it could leave ACCESS EXCLUSIVE locks held by an unbounded outer transaction.
  if (!db.$client) throw new Error("Sequence alignment requires a root database, not a nested transaction");

  await db.transaction(async (tx) => {
    // Pin resolution before even the settings query; pg_catalog is implicitly
    // searched first and pg_temp is explicitly last.
    await tx.execute(sql.raw("SET LOCAL search_path TO public, pg_temp"));
    // Separate request BEFORE the DO: changing statement_timeout inside that DO
    // cannot arm a deadline for the already-running statement. Zero means off;
    // otherwise retain a stricter session setting. All changes are LOCAL.
    await tx.execute(sql.raw(`SELECT
      pg_catalog.set_config('statement_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),30000)::text || 'ms',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
    await tx.execute(sql.raw(KEFU_SEQUENCE_ALIGNMENT_SQL));
  }, { isolationLevel: "read committed" });
}
