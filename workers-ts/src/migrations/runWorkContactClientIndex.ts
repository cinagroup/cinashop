import { sql } from "drizzle-orm";
import type { DbClient } from "../lib/di";
import { WORK_CONTACT_CLIENT_INDEX_SQL } from "./workContactClientIndex";

/** Additive, write-blocking maintenance. Caller owns authorization and connection lifecycle.
 * No import-time I/O, business-row writes, statistics changes or automatic retries.
 */
export async function runWorkContactClientIndex(
  db: Pick<DbClient, "transaction"> & Partial<Pick<DbClient, "$client">>,
  schema = "public",
): Promise<void> {
  if (!db.$client) throw new Error("Customer reference index requires a root database, not a nested transaction");
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema) || schema.startsWith("pg_") || schema === "information_schema") {
    throw new Error("Invalid customer reference index schema");
  }
  await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL search_path TO ${sql.identifier(schema)}, pg_temp`);
    await tx.execute(sql.raw(`SELECT
      pg_catalog.set_config('statement_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),30000)::text || 'ms',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
    await tx.execute(sql.raw(WORK_CONTACT_CLIENT_INDEX_SQL));
  }, { isolationLevel: "read committed" });
}
