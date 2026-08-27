-- Idempotent, auditable customer-service ownership transfer.
-- Message content remains exclusively in store_service_log.
CREATE TABLE IF NOT EXISTS "store_service_transfer" (
  "request_key" VARCHAR(36) PRIMARY KEY,
  "customer_uid" INTEGER NOT NULL,
  "from_kefu_uid" INTEGER NOT NULL,
  "to_kefu_uid" INTEGER NOT NULL,
  "from_service_id" INTEGER NOT NULL,
  "to_service_id" INTEGER NOT NULL,
  "source_record_id" INTEGER NOT NULL,
  "target_record_id" INTEGER NOT NULL,
  "copied_message_count" INTEGER DEFAULT 0 NOT NULL,
  "created_at" INTEGER NOT NULL,
  CONSTRAINT "sst_positive_ids_ck" CHECK (
    "customer_uid" > 0 AND "from_kefu_uid" > 0 AND "to_kefu_uid" > 0
    AND "from_service_id" > 0 AND "to_service_id" > 0
    AND "source_record_id" > 0 AND "target_record_id" > 0
  ),
  CONSTRAINT "sst_distinct_kefu_ck" CHECK ("from_kefu_uid" <> "to_kefu_uid"),
  CONSTRAINT "sst_count_time_ck" CHECK ("copied_message_count" >= 0 AND "created_at" >= 0)
);

CREATE INDEX IF NOT EXISTS "sst_customer_time"
  ON "store_service_transfer" ("customer_uid", "created_at", "request_key");
CREATE INDEX IF NOT EXISTS "sst_target_time"
  ON "store_service_transfer" ("to_kefu_uid", "created_at", "request_key");
