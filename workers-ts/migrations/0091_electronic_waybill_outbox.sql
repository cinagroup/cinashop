-- One durable intent covers both the irreversible provider allocation and the
-- local fulfillment commit. Queue messages contain only the job ID/event key.
CREATE TABLE IF NOT EXISTS "order_waybill_job" (
  "id" SERIAL PRIMARY KEY,
  "event_key" VARCHAR(128) NOT NULL,
  "request_key" VARCHAR(36) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "root_order_id" INTEGER NOT NULL,
  "order_id" INTEGER NOT NULL,
  "order_no" VARCHAR(32) NOT NULL,
  "supplier_id" INTEGER NOT NULL,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "actor_type" VARCHAR(16) NOT NULL,
  "actor_id" INTEGER NOT NULL,
  "fulfillment_mode" VARCHAR(16) NOT NULL,
  "cart_selection" VARCHAR(16000) DEFAULT '[]' NOT NULL,
  "carrier_id" INTEGER NOT NULL,
  "carrier_code" VARCHAR(50) NOT NULL,
  "carrier_name" VARCHAR(64) NOT NULL,
  "carrier_config" VARCHAR(2000) DEFAULT '{}' NOT NULL,
  "template_id" VARCHAR(255) NOT NULL,
  "cloud_printer_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "sender_name" VARCHAR(128) NOT NULL,
  "sender_phone" VARCHAR(32) NOT NULL,
  "sender_address" VARCHAR(255) NOT NULL,
  "status" VARCHAR(16) DEFAULT 'PENDING' NOT NULL,
  "dispatch_count" INTEGER DEFAULT 0 NOT NULL,
  "attempt_count" INTEGER DEFAULT 0 NOT NULL,
  "replay_count" INTEGER DEFAULT 0 NOT NULL,
  "available_time" INTEGER DEFAULT 0 NOT NULL,
  "lease_until" INTEGER DEFAULT 0 NOT NULL,
  "lease_token" VARCHAR(36) DEFAULT '' NOT NULL,
  "provider_reference" VARCHAR(255) DEFAULT '' NOT NULL,
  "response_code" VARCHAR(100) DEFAULT '' NOT NULL,
  "tracking_number" VARCHAR(64) DEFAULT '' NOT NULL,
  "label_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "payload_hash" VARCHAR(64) DEFAULT '' NOT NULL,
  "fulfilled_order_id" INTEGER DEFAULT 0 NOT NULL,
  "remaining_order_id" INTEGER DEFAULT 0 NOT NULL,
  "last_error" VARCHAR(1000) DEFAULT '' NOT NULL,
  "sent_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "owj_actor_ck" CHECK (
    "actor_type" IN ('admin', 'supplier') AND "actor_id" > 0 AND "supplier_id" >= 0
  ),
  CONSTRAINT "owj_mode_ck" CHECK ("fulfillment_mode" IN ('whole', 'split')),
  CONSTRAINT "owj_status_ck" CHECK ("status" IN (
    'PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE',
    'SENT', 'UNKNOWN', 'DEAD', 'CLOSED'
  )),
  CONSTRAINT "owj_identity_ck" CHECK (
    "root_order_id" > 0 AND "order_id" > 0 AND "carrier_id" > 0
    AND "store_id" >= 0 AND "fulfilled_order_id" >= 0 AND "remaining_order_id" >= 0
  ),
  CONSTRAINT "owj_time_ck" CHECK (
    "available_time" >= 0 AND "lease_until" >= 0 AND "sent_time" >= 0
    AND "add_time" >= 0 AND "update_time" >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "owj_event_key_uq"
  ON "order_waybill_job" ("event_key");
CREATE UNIQUE INDEX IF NOT EXISTS "owj_request_key_uq"
  ON "order_waybill_job" ("request_key");
CREATE UNIQUE INDEX IF NOT EXISTS "owj_active_root_uq"
  ON "order_waybill_job" ("root_order_id")
  WHERE "status" IN (
    'PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE', 'UNKNOWN', 'DEAD'
  );
CREATE INDEX IF NOT EXISTS "owj_owner_history"
  ON "order_waybill_job" ("supplier_id", "id" DESC);
CREATE INDEX IF NOT EXISTS "owj_order_history"
  ON "order_waybill_job" ("order_id", "id" DESC);
CREATE INDEX IF NOT EXISTS "owj_dispatch_ready"
  ON "order_waybill_job" ("available_time", "id")
  WHERE "status" IN ('PENDING', 'RETRYABLE');
CREATE INDEX IF NOT EXISTS "owj_expired_queue_lease"
  ON "order_waybill_job" ("lease_until", "id")
  WHERE "status" IN ('ENQUEUING', 'ENQUEUED');
CREATE INDEX IF NOT EXISTS "owj_expired_provider_lease"
  ON "order_waybill_job" ("lease_until", "id")
  WHERE "status" = 'PROCESSING';

-- Immutable human decisions. Recipient/sender data and carrier credentials
-- remain only on the job row and are never copied into this audit log.
CREATE TABLE IF NOT EXISTS "order_waybill_job_action" (
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
  "tracking_number" VARCHAR(64) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "owja_action_ck" CHECK (
    "action" IN ('APPLY_EXISTING', 'CONFIRM_ISSUED', 'CONFIRM_RETRY', 'CLOSE_NO_RETRY')
  ),
  CONSTRAINT "owja_actor_ck" CHECK (
    "actor_type" IN ('admin', 'supplier') AND "actor_id" > 0 AND "supplier_id" >= 0
  ),
  CONSTRAINT "owja_time_ck" CHECK ("add_time" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "owja_request_key_uq"
  ON "order_waybill_job_action" ("request_key");
CREATE INDEX IF NOT EXISTS "owja_job"
  ON "order_waybill_job_action" ("job_id", "id");
CREATE INDEX IF NOT EXISTS "owja_actor_time"
  ON "order_waybill_job_action" ("actor_type", "actor_id", "add_time", "id");
