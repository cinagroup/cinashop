-- Provider side effects are deliberately separated from the root order outbox.
-- A provider call never runs while a PostgreSQL transaction is open.
CREATE TABLE IF NOT EXISTS "order_notification_delivery" (
  "id" SERIAL PRIMARY KEY,
  "outbox_id" INTEGER NOT NULL,
  "event_key" VARCHAR(128) NOT NULL,
  "order_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL,
  "notice_mark" VARCHAR(50) NOT NULL,
  "channel" VARCHAR(32) NOT NULL,
  "target" VARCHAR(255) DEFAULT '' NOT NULL,
  "template_code" VARCHAR(100) DEFAULT '' NOT NULL,
  "payload" JSONB NOT NULL,
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
  "last_error" VARCHAR(1000) DEFAULT '' NOT NULL,
  "sent_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "ond_channel_ck" CHECK ("channel" IN (
    'sms', 'wechat_official', 'wechat_routine', 'wechat_shipping'
  )),
  CONSTRAINT "ond_status_ck" CHECK ("status" IN (
    'PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE',
    'SENT', 'SKIPPED', 'UNKNOWN', 'DEAD'
  )),
  CONSTRAINT "ond_time_ck" CHECK (
    "available_time" >= 0 AND "lease_until" >= 0 AND "sent_time" >= 0
    AND "add_time" >= 0 AND "update_time" >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "ond_event_channel_uq"
  ON "order_notification_delivery" ("event_key", "channel");
CREATE INDEX IF NOT EXISTS "ond_outbox"
  ON "order_notification_delivery" ("outbox_id", "id");
CREATE INDEX IF NOT EXISTS "ond_order"
  ON "order_notification_delivery" ("order_id", "id");
CREATE INDEX IF NOT EXISTS "ond_dispatch_ready"
  ON "order_notification_delivery" ("available_time", "id")
  WHERE "status" IN ('PENDING', 'RETRYABLE');
CREATE INDEX IF NOT EXISTS "ond_expired_queue_lease"
  ON "order_notification_delivery" ("lease_until", "id")
  WHERE "status" IN ('ENQUEUING', 'ENQUEUED');
CREATE INDEX IF NOT EXISTS "ond_expired_provider_lease"
  ON "order_notification_delivery" ("lease_until", "id")
  WHERE "status" = 'PROCESSING';

-- Restore the source lookup indexes needed to resolve a channel target and a
-- provider template without scanning the imported legacy catalogs.
CREATE UNIQUE INDEX IF NOT EXISTS "wu_openid_uq" ON "wechat_user" ("openid");
CREATE INDEX IF NOT EXISTS "wu_unionid" ON "wechat_user" ("unionid");
CREATE INDEX IF NOT EXISTS "wu_uid" ON "wechat_user" ("uid");
CREATE INDEX IF NOT EXISTS "wu_uid_type_latest" ON "wechat_user" ("uid", "user_type", "id");
CREATE INDEX IF NOT EXISTS "nt_enabled_provider_lookup"
  ON "notification_template" ("legacy_type", "mark", "id") WHERE "status" = 1;
