CREATE TABLE IF NOT EXISTS "work_callback_event" (
  "id" serial PRIMARY KEY,
  "event_key" varchar(64) NOT NULL,
  "payload_hash" varchar(64) NOT NULL,
  "subject_key_hash" varchar(64) NOT NULL,
  "corp_id" varchar(64) NOT NULL,
  "msg_type" varchar(64) NOT NULL DEFAULT '',
  "event_type" varchar(64) NOT NULL DEFAULT '',
  "change_type" varchar(64) NOT NULL DEFAULT '',
  "event_time" integer NOT NULL DEFAULT 0,
  "sequence_rank" integer NOT NULL DEFAULT 0,
  "payload" jsonb NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'RECEIVED',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "lease_until" integer NOT NULL DEFAULT 0,
  "lease_token" varchar(36) NOT NULL DEFAULT '',
  "last_error_code" varchar(64) NOT NULL DEFAULT '',
  "received_time" integer NOT NULL DEFAULT 0,
  "processed_time" integer NOT NULL DEFAULT 0,
  "update_time" integer NOT NULL DEFAULT 0,
  CONSTRAINT "wce_hashes_ck" CHECK (
    event_key ~ '^[0-9a-f]{64}$'
    AND payload_hash ~ '^[0-9a-f]{64}$'
    AND subject_key_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "wce_time_ck" CHECK (
    event_time >= 0 AND received_time >= 0 AND processed_time >= 0
    AND update_time >= 0 AND lease_until >= 0 AND attempt_count >= 0
  ),
  CONSTRAINT "wce_status_ck" CHECK (
    status IN ('RECEIVED','PROCESSING','ORDERED','SUPERSEDED','IGNORED','FAILED','DEAD')
  ),
  CONSTRAINT "wce_payload_object_ck" CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS "wce_event_key_uq"
  ON "work_callback_event" ("event_key");
CREATE INDEX IF NOT EXISTS "wce_subject_order"
  ON "work_callback_event" ("subject_key_hash", "event_time", "sequence_rank", "id");
CREATE INDEX IF NOT EXISTS "wce_status_time"
  ON "work_callback_event" ("status", "update_time", "id");

CREATE TABLE IF NOT EXISTS "work_callback_outbox" (
  "id" serial PRIMARY KEY,
  "event_id" integer NOT NULL,
  "event_key" varchar(64) NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'PENDING',
  "dispatch_count" integer NOT NULL DEFAULT 0,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "available_time" integer NOT NULL DEFAULT 0,
  "lease_until" integer NOT NULL DEFAULT 0,
  "lease_token" varchar(36) NOT NULL DEFAULT '',
  "last_error_code" varchar(64) NOT NULL DEFAULT '',
  "enqueued_time" integer NOT NULL DEFAULT 0,
  "processed_time" integer NOT NULL DEFAULT 0,
  "add_time" integer NOT NULL DEFAULT 0,
  "update_time" integer NOT NULL DEFAULT 0,
  CONSTRAINT "wco_event_id_fk" FOREIGN KEY ("event_id")
    REFERENCES "work_callback_event" ("id") ON DELETE CASCADE,
  CONSTRAINT "wco_event_key_ck" CHECK (event_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "wco_time_ck" CHECK (
    dispatch_count >= 0 AND attempt_count >= 0 AND available_time >= 0
    AND lease_until >= 0 AND enqueued_time >= 0 AND processed_time >= 0
    AND add_time >= 0 AND update_time >= 0
  ),
  CONSTRAINT "wco_status_ck" CHECK (
    status IN ('PENDING','ENQUEUING','ENQUEUED','PROCESSING','COMPLETED','FAILED','DEAD')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "wco_event_id_uq"
  ON "work_callback_outbox" ("event_id");
CREATE UNIQUE INDEX IF NOT EXISTS "wco_event_key_uq"
  ON "work_callback_outbox" ("event_key");
CREATE INDEX IF NOT EXISTS "wco_dispatch_ready"
  ON "work_callback_outbox" ("available_time", "id")
  WHERE "status" IN ('PENDING', 'FAILED');
CREATE INDEX IF NOT EXISTS "wco_expired_lease"
  ON "work_callback_outbox" ("lease_until", "id")
  WHERE "status" IN ('ENQUEUING', 'ENQUEUED', 'PROCESSING');

CREATE TABLE IF NOT EXISTS "work_callback_watermark" (
  "subject_key_hash" varchar(64) PRIMARY KEY,
  "event_time" integer NOT NULL DEFAULT 0,
  "sequence_rank" integer NOT NULL DEFAULT 0,
  "event_id" integer NOT NULL,
  "event_key" varchar(64) NOT NULL,
  "update_time" integer NOT NULL DEFAULT 0,
  CONSTRAINT "wcw_hashes_ck" CHECK (
    subject_key_hash ~ '^[0-9a-f]{64}$' AND event_key ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "wcw_time_ck" CHECK (event_time >= 0 AND update_time >= 0)
);
