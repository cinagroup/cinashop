-- Durable receipt-printer side effects. Queue messages contain only the job ID
-- and immutable event key; credentials and rendered order data stay in PostgreSQL.
CREATE TABLE IF NOT EXISTS "order_print_job" (
  "id" SERIAL PRIMARY KEY,
  "event_key" VARCHAR(128) NOT NULL,
  "request_key" VARCHAR(36) DEFAULT '' NOT NULL,
  "order_id" INTEGER NOT NULL,
  "order_no" VARCHAR(32) NOT NULL,
  "printer_id" INTEGER NOT NULL,
  "supplier_id" INTEGER NOT NULL,
  "trigger" VARCHAR(16) NOT NULL,
  "provider" VARCHAR(16) NOT NULL,
  "actor_type" VARCHAR(16) NOT NULL,
  "actor_id" INTEGER DEFAULT 0 NOT NULL,
  "status" VARCHAR(16) DEFAULT 'PENDING' NOT NULL,
  "dispatch_count" INTEGER DEFAULT 0 NOT NULL,
  "attempt_count" INTEGER DEFAULT 0 NOT NULL,
  "replay_count" INTEGER DEFAULT 0 NOT NULL,
  "available_time" INTEGER DEFAULT 0 NOT NULL,
  "lease_until" INTEGER DEFAULT 0 NOT NULL,
  "lease_token" VARCHAR(36) DEFAULT '' NOT NULL,
  "provider_reference" VARCHAR(255) DEFAULT '' NOT NULL,
  "provider_request_id" VARCHAR(255) DEFAULT '' NOT NULL,
  "response_code" VARCHAR(100) DEFAULT '' NOT NULL,
  "content_hash" VARCHAR(64) DEFAULT '' NOT NULL,
  "last_error" VARCHAR(1000) DEFAULT '' NOT NULL,
  "sent_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "opj_trigger_ck" CHECK ("trigger" IN ('created', 'paid', 'manual')),
  CONSTRAINT "opj_provider_ck" CHECK ("provider" IN ('yilianyun', 'feieyun')),
  CONSTRAINT "opj_actor_ck" CHECK (
    ("actor_type" = 'system' AND "actor_id" = 0)
    OR ("actor_type" IN ('admin', 'supplier') AND "actor_id" > 0)
  ),
  CONSTRAINT "opj_status_ck" CHECK ("status" IN (
    'PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE',
    'SENT', 'UNKNOWN', 'DEAD', 'CLOSED'
  )),
  CONSTRAINT "opj_identity_ck" CHECK (
    "order_id" > 0 AND "printer_id" > 0 AND "supplier_id" >= 0
  ),
  CONSTRAINT "opj_time_ck" CHECK (
    "available_time" >= 0 AND "lease_until" >= 0 AND "sent_time" >= 0
    AND "add_time" >= 0 AND "update_time" >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "opj_event_key_uq"
  ON "order_print_job" ("event_key");
CREATE UNIQUE INDEX IF NOT EXISTS "opj_manual_request_printer_uq"
  ON "order_print_job" ("request_key", "printer_id")
  WHERE "request_key" <> '';
CREATE INDEX IF NOT EXISTS "opj_manual_request"
  ON "order_print_job" ("request_key", "id")
  WHERE "request_key" <> '';
CREATE INDEX IF NOT EXISTS "opj_owner_history"
  ON "order_print_job" ("supplier_id", "id" DESC);
CREATE INDEX IF NOT EXISTS "opj_order_history"
  ON "order_print_job" ("order_id", "id" DESC);
CREATE INDEX IF NOT EXISTS "opj_dispatch_ready"
  ON "order_print_job" ("available_time", "id")
  WHERE "status" IN ('PENDING', 'RETRYABLE');
CREATE INDEX IF NOT EXISTS "opj_expired_queue_lease"
  ON "order_print_job" ("lease_until", "id")
  WHERE "status" IN ('ENQUEUING', 'ENQUEUED');
CREATE INDEX IF NOT EXISTS "opj_expired_provider_lease"
  ON "order_print_job" ("lease_until", "id")
  WHERE "status" = 'PROCESSING';

-- Immutable operator decisions for ambiguous or terminal provider outcomes.
-- No rendered receipt, delivery address, phone number, or provider secret is copied here.
CREATE TABLE IF NOT EXISTS "order_print_job_action" (
  "id" SERIAL PRIMARY KEY,
  "job_id" INTEGER NOT NULL,
  "request_key" VARCHAR(36) NOT NULL,
  "action" VARCHAR(32) NOT NULL,
  "previous_status" VARCHAR(16) NOT NULL,
  "next_status" VARCHAR(16) NOT NULL,
  "actor_type" VARCHAR(16) NOT NULL,
  "actor_id" INTEGER NOT NULL,
  "supplier_id" INTEGER NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "provider_reference" VARCHAR(255) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "opja_action_ck" CHECK (
    "action" IN ('CONFIRM_SENT', 'CONFIRM_RETRY', 'CLOSE_NO_RETRY')
  ),
  CONSTRAINT "opja_actor_ck" CHECK (
    "actor_type" IN ('admin', 'supplier') AND "actor_id" > 0 AND "supplier_id" >= 0
  ),
  CONSTRAINT "opja_time_ck" CHECK ("add_time" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "opja_request_key_uq"
  ON "order_print_job_action" ("request_key");
CREATE INDEX IF NOT EXISTS "opja_job"
  ON "order_print_job_action" ("job_id", "id");
CREATE INDEX IF NOT EXISTS "opja_actor_time"
  ON "order_print_job_action" ("actor_type", "actor_id", "add_time", "id");
