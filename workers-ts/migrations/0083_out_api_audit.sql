-- Privacy-preserving, append-only application audit for sensitive third-party
-- reads and writes. Raw paths, resource IDs, query values, IP addresses,
-- user agents, request bodies and response bodies must never be stored here.
CREATE TABLE IF NOT EXISTS "out_api_audit" (
  "id" BIGSERIAL PRIMARY KEY,
  "out_account_id" INTEGER DEFAULT 0 NOT NULL,
  "appid_snapshot" VARCHAR(50) DEFAULT '' NOT NULL,
  "method" VARCHAR(12) DEFAULT '' NOT NULL,
  "route_template" VARCHAR(128) DEFAULT '' NOT NULL,
  "operation" VARCHAR(16) DEFAULT 'read' NOT NULL,
  "resource_hash" VARCHAR(64) DEFAULT '' NOT NULL,
  "query_fields" VARCHAR(255) DEFAULT '' NOT NULL,
  "ip_hash" VARCHAR(64) DEFAULT '' NOT NULL,
  "user_agent_hash" VARCHAR(64) DEFAULT '' NOT NULL,
  "outcome" VARCHAR(16) DEFAULT 'success' NOT NULL,
  "result_code" INTEGER DEFAULT 200 NOT NULL,
  "duration_ms" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "out_audit_operation_ck" CHECK ("operation" IN ('read', 'write')),
  CONSTRAINT "out_audit_outcome_ck" CHECK ("outcome" IN ('success', 'denied', 'rate_limited', 'error')),
  CONSTRAINT "out_audit_result_code_ck" CHECK ("result_code" BETWEEN 0 AND 999999),
  CONSTRAINT "out_audit_duration_ck" CHECK ("duration_ms" BETWEEN 0 AND 3600000),
  CONSTRAINT "out_audit_add_time_ck" CHECK ("add_time" >= 0),
  CONSTRAINT "out_audit_hashes_ck" CHECK (
    ("resource_hash" = '' OR "resource_hash" ~ '^[0-9a-f]{64}$')
    AND ("ip_hash" = '' OR "ip_hash" ~ '^[0-9a-f]{64}$')
    AND ("user_agent_hash" = '' OR "user_agent_hash" ~ '^[0-9a-f]{64}$')
  )
);

CREATE INDEX IF NOT EXISTS "out_audit_account_time"
  ON "out_api_audit" ("out_account_id", "add_time", "id");
CREATE INDEX IF NOT EXISTS "out_audit_route_time"
  ON "out_api_audit" ("route_template", "add_time", "id");
CREATE INDEX IF NOT EXISTS "out_audit_outcome_time"
  ON "out_api_audit" ("outcome", "add_time", "id");
