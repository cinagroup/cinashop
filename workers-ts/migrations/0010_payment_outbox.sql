-- 订单支付后置任务 transactional outbox。
-- 不回填历史已支付订单，避免在未完成历史对账前重复分佣或增加支付次数。
CREATE TABLE IF NOT EXISTS "store_order_outbox" (
  "id" SERIAL PRIMARY KEY,
  "event_key" VARCHAR(128) NOT NULL,
  "aggregate_type" VARCHAR(32) DEFAULT 'order' NOT NULL,
  "aggregate_id" INTEGER NOT NULL,
  "event_type" VARCHAR(64) NOT NULL,
  "payload" JSONB DEFAULT '{}'::jsonb NOT NULL,
  "status" VARCHAR(16) DEFAULT 'PENDING' NOT NULL,
  "dispatch_count" INTEGER DEFAULT 0 NOT NULL,
  "attempt_count" INTEGER DEFAULT 0 NOT NULL,
  "replay_count" INTEGER DEFAULT 0 NOT NULL,
  "available_time" INTEGER DEFAULT 0 NOT NULL,
  "lease_until" INTEGER DEFAULT 0 NOT NULL,
  "lease_token" VARCHAR(36) DEFAULT '' NOT NULL,
  "last_error" VARCHAR(1000) DEFAULT '' NOT NULL,
  "enqueued_time" INTEGER DEFAULT 0 NOT NULL,
  "processed_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "soob_event_type_ck" CHECK ("event_type" IN ('order.paid')),
  CONSTRAINT "soob_status_ck" CHECK (
    "status" IN ('PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD')
  ),
  CONSTRAINT "soob_count_ck" CHECK (
    "dispatch_count" >= 0 AND "attempt_count" >= 0 AND "replay_count" >= 0
  ),
  CONSTRAINT "soob_time_ck" CHECK ("available_time" >= 0 AND "lease_until" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "soob_event_key_uq"
  ON "store_order_outbox" ("event_key");
CREATE INDEX IF NOT EXISTS "soob_aggregate"
  ON "store_order_outbox" ("aggregate_type", "aggregate_id");
CREATE INDEX IF NOT EXISTS "soob_dispatch_ready"
  ON "store_order_outbox" ("available_time", "id")
  WHERE "status" IN ('PENDING', 'FAILED');
CREATE INDEX IF NOT EXISTS "soob_expired_lease"
  ON "store_order_outbox" ("lease_until", "id")
  WHERE "status" IN ('ENQUEUING', 'ENQUEUED', 'PROCESSING');
