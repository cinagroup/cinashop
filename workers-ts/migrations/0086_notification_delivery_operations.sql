-- Keep every manual decision about ambiguous provider outcomes immutable.
-- No notification target or rendered payload is copied into this audit table.
CREATE TABLE IF NOT EXISTS "order_notification_delivery_action" (
  "id" SERIAL PRIMARY KEY,
  "delivery_id" INTEGER NOT NULL,
  "request_key" VARCHAR(36) NOT NULL,
  "action" VARCHAR(32) NOT NULL,
  "previous_status" VARCHAR(16) NOT NULL,
  "next_status" VARCHAR(16) NOT NULL,
  "admin_id" INTEGER NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "provider_reference" VARCHAR(255) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "onda_action_ck" CHECK (
    "action" IN ('CONFIRM_SENT', 'CONFIRM_RETRY', 'CLOSE_NO_RETRY')
  ),
  CONSTRAINT "onda_admin_time_ck" CHECK ("admin_id" > 0 AND "add_time" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "onda_request_key_uq"
  ON "order_notification_delivery_action" ("request_key");
CREATE INDEX IF NOT EXISTS "onda_delivery"
  ON "order_notification_delivery_action" ("delivery_id", "id");
CREATE INDEX IF NOT EXISTS "onda_admin_time"
  ON "order_notification_delivery_action" ("admin_id", "add_time", "id");
