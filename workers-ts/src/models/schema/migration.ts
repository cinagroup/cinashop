import {
  bigint,
  char,
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const dataMigrationRun = pgTable(
  "data_migration_run",
  {
    runId: varchar("run_id", { length: 64 }).primaryKey(),
    manifestVersion: varchar("manifest_version", { length: 32 }).notNull(),
    sourceFingerprint: char("source_fingerprint", { length: 64 }).notNull(),
    sourcePrefix: varchar("source_prefix", { length: 32 }).default("eb_").notNull(),
    status: varchar("status", { length: 32 }).default("RUNNING").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error").default("").notNull(),
  },
  (table) => [
    check(
      "dmr_status_ck",
      sql`${table.status} IN ('RUNNING', 'COMPLETED', 'NEEDS_REVIEW', 'FAILED')`,
    ),
  ],
);

export const dataMigrationCheckpoint = pgTable(
  "data_migration_checkpoint",
  {
    runId: varchar("run_id", { length: 64 })
      .notNull()
      .references(() => dataMigrationRun.runId, { onDelete: "cascade" }),
    tableName: varchar("table_name", { length: 64 }).notNull(),
    lastKey: numeric("last_key", { precision: 30, scale: 0 }),
    lastKeyJson: jsonb("last_key_json").$type<string[]>(),
    sourceCount: bigint("source_count", { mode: "number" }).default(0).notNull(),
    insertedCount: bigint("inserted_count", { mode: "number" }).default(0).notNull(),
    conflictCount: bigint("conflict_count", { mode: "number" }).default(0).notNull(),
    status: varchar("status", { length: 32 }).default("RUNNING").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.tableName] }),
    check(
      "dmc_counts_ck",
      sql`${table.sourceCount} >= 0 AND ${table.insertedCount} >= 0 AND ${table.conflictCount} >= 0`,
    ),
    check(
      "dmc_status_ck",
      sql`${table.status} IN ('RUNNING', 'COMPLETED', 'CONFLICT', 'FAILED')`,
    ),
    index("dmc_table_status").on(table.tableName, table.status, table.updatedAt),
  ],
);
