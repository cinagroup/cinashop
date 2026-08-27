-- Persist Cloudflare Queue dead letters beyond the Queue retention window and
-- keep every replay/resolve decision auditable. Sensitive or unknown bodies are
-- archived only after application-level redaction and are never replayable.
CREATE TABLE IF NOT EXISTS "system_queue_dead_letter" (
  "id" SERIAL PRIMARY KEY,
  "queue_name" VARCHAR(128) NOT NULL,
  "message_id" VARCHAR(128) NOT NULL,
  "message_timestamp_ms" BIGINT DEFAULT 0 NOT NULL,
  "dlq_attempts" INTEGER DEFAULT 1 NOT NULL,
  "message_type" VARCHAR(64) DEFAULT 'unknown' NOT NULL,
  "body" JSONB DEFAULT '{}'::jsonb NOT NULL,
  "body_sha256" VARCHAR(64) NOT NULL,
  "replay_policy" VARCHAR(24) DEFAULT 'BLOCK_UNSUPPORTED' NOT NULL,
  "status" VARCHAR(16) DEFAULT 'OPEN' NOT NULL,
  "occurrence_count" INTEGER DEFAULT 1 NOT NULL,
  "replay_count" INTEGER DEFAULT 0 NOT NULL,
  "first_seen_time" INTEGER DEFAULT 0 NOT NULL,
  "last_seen_time" INTEGER DEFAULT 0 NOT NULL,
  "replay_requested_time" INTEGER DEFAULT 0 NOT NULL,
  "replayed_time" INTEGER DEFAULT 0 NOT NULL,
  "resolved_time" INTEGER DEFAULT 0 NOT NULL,
  "replay_lease_until" INTEGER DEFAULT 0 NOT NULL,
  "replay_token" VARCHAR(36) DEFAULT '' NOT NULL,
  "replay_requested_by" INTEGER DEFAULT 0 NOT NULL,
  "resolved_by" INTEGER DEFAULT 0 NOT NULL,
  "replay_reason" VARCHAR(500) DEFAULT '' NOT NULL,
  "resolution_reason" VARCHAR(500) DEFAULT '' NOT NULL,
  "last_error" VARCHAR(1000) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "sqdl_queue_message_uq" UNIQUE ("queue_name", "message_id"),
  CONSTRAINT "sqdl_status_ck" CHECK (
    "status" IN ('OPEN', 'REPLAYING', 'REPLAYED', 'RESOLVED')
  ),
  CONSTRAINT "sqdl_replay_policy_ck" CHECK (
    "replay_policy" IN ('ALLOW', 'BLOCK_SENSITIVE', 'BLOCK_UNSUPPORTED')
  ),
  CONSTRAINT "sqdl_count_ck" CHECK (
    "dlq_attempts" > 0 AND "occurrence_count" > 0 AND "replay_count" >= 0
  ),
  CONSTRAINT "sqdl_time_ck" CHECK (
    "message_timestamp_ms" >= 0 AND "first_seen_time" >= 0
      AND "last_seen_time" >= 0 AND "replay_requested_time" >= 0
      AND "replayed_time" >= 0 AND "resolved_time" >= 0
      AND "replay_lease_until" >= 0
  )
);

CREATE INDEX IF NOT EXISTS "sqdl_open_alerts"
  ON "system_queue_dead_letter" ("status", "first_seen_time", "id");
CREATE INDEX IF NOT EXISTS "sqdl_type_status"
  ON "system_queue_dead_letter" ("message_type", "status", "id");
CREATE INDEX IF NOT EXISTS "sqdl_replay_lease"
  ON "system_queue_dead_letter" ("replay_lease_until", "id")
  WHERE "status" = 'REPLAYING';
