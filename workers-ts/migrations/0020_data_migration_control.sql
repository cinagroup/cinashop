-- Resumable MySQL -> PostgreSQL data migration ledger. It stores no credentials.
CREATE TABLE IF NOT EXISTS "data_migration_run" (
  "run_id" VARCHAR(64) PRIMARY KEY,
  "manifest_version" VARCHAR(32) NOT NULL,
  "source_fingerprint" CHAR(64) NOT NULL,
  "source_prefix" VARCHAR(32) DEFAULT 'eb_' NOT NULL,
  "status" VARCHAR(32) DEFAULT 'RUNNING' NOT NULL,
  "started_at" TIMESTAMPTZ DEFAULT now() NOT NULL,
  "completed_at" TIMESTAMPTZ,
  "last_error" TEXT DEFAULT '' NOT NULL,
  CONSTRAINT "dmr_status_ck"
    CHECK ("status" IN ('RUNNING', 'COMPLETED', 'NEEDS_REVIEW', 'FAILED'))
);

CREATE TABLE IF NOT EXISTS "data_migration_checkpoint" (
  "run_id" VARCHAR(64) NOT NULL REFERENCES "data_migration_run" ("run_id") ON DELETE CASCADE,
  "table_name" VARCHAR(64) NOT NULL,
  -- NULL means no source key has committed yet; this avoids skipping valid
  -- negative keys on the first keyset page.
  "last_key" NUMERIC(30,0),
  -- Composite integer keys use a JSON array of decimal strings so cursor
  -- precision is preserved across JavaScript and PostgreSQL.
  "last_key_json" JSONB,
  "source_count" BIGINT DEFAULT 0 NOT NULL,
  "inserted_count" BIGINT DEFAULT 0 NOT NULL,
  "conflict_count" BIGINT DEFAULT 0 NOT NULL,
  "status" VARCHAR(32) DEFAULT 'RUNNING' NOT NULL,
  "updated_at" TIMESTAMPTZ DEFAULT now() NOT NULL,
  PRIMARY KEY ("run_id", "table_name"),
  CONSTRAINT "dmc_counts_ck"
    CHECK ("source_count" >= 0 AND "inserted_count" >= 0 AND "conflict_count" >= 0),
  CONSTRAINT "dmc_status_ck"
    CHECK ("status" IN ('RUNNING', 'COMPLETED', 'CONFLICT', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS "dmc_table_status"
  ON "data_migration_checkpoint" ("table_name", "status", "updated_at");
