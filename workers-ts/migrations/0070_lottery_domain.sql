-- Preserve the three source lottery tables without adding foreign keys or
-- semantic uniqueness that could reject historical CRMEB rows.
CREATE TABLE IF NOT EXISTS "luck_lottery" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "desc" VARCHAR(255) DEFAULT '' NOT NULL,
  "image" VARCHAR(255) DEFAULT '' NOT NULL,
  "factor" SMALLINT DEFAULT 1 NOT NULL,
  "factor_num" SMALLINT DEFAULT 10 NOT NULL,
  "attends_user" SMALLINT DEFAULT 1 NOT NULL,
  "user_level" TEXT,
  "user_label" TEXT,
  "is_svip" SMALLINT DEFAULT 1 NOT NULL,
  "prize_num" SMALLINT DEFAULT 0 NOT NULL,
  "start_time" INTEGER DEFAULT 0 NOT NULL,
  "end_time" INTEGER DEFAULT 0 NOT NULL,
  "lottery_num_term" SMALLINT DEFAULT 1 NOT NULL,
  "lottery_num" SMALLINT DEFAULT 1 NOT NULL,
  "total_lottery_num" SMALLINT DEFAULT 1 NOT NULL,
  "spread_num" SMALLINT DEFAULT 1 NOT NULL,
  "is_all_record" SMALLINT DEFAULT 1 NOT NULL,
  "is_personal_record" SMALLINT DEFAULT 1 NOT NULL,
  "is_content" SMALLINT DEFAULT 1 NOT NULL,
  "content" TEXT,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "sort" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "luck_lottery_type"
  ON "luck_lottery" ("type");
CREATE INDEX IF NOT EXISTS "luck_lottery_factor_active"
  ON "luck_lottery" ("factor", "status", "is_del", "start_time", "end_time", "id" DESC);

CREATE TABLE IF NOT EXISTS "luck_prize" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "lottery_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "prompt" VARCHAR(255) DEFAULT '' NOT NULL,
  "image" VARCHAR(255) DEFAULT '' NOT NULL,
  "chance" SMALLINT DEFAULT 10 NOT NULL,
  "total" SMALLINT DEFAULT 1 NOT NULL,
  "coupon_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "unique" VARCHAR(20) DEFAULT '' NOT NULL,
  "num" NUMERIC(12, 2) DEFAULT 0.00 NOT NULL,
  "sort" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "luck_prize_lottery"
  ON "luck_prize" ("lottery_id");
CREATE INDEX IF NOT EXISTS "luck_prize_draw"
  ON "luck_prize" ("lottery_id", "status", "is_del", "sort", "id");

CREATE TABLE IF NOT EXISTS "luck_lottery_record" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "oid" INTEGER DEFAULT 0,
  "lottery_id" INTEGER DEFAULT 0 NOT NULL,
  "prize_id" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "prize_info" TEXT,
  "is_receive" SMALLINT DEFAULT 0 NOT NULL,
  "receive_time" INTEGER DEFAULT 0 NOT NULL,
  "receive_info" TEXT,
  "is_deliver" SMALLINT DEFAULT 0 NOT NULL,
  "deliver_time" INTEGER DEFAULT 0 NOT NULL,
  "deliver_info" TEXT,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "luck_lottery_record_uid"
  ON "luck_lottery_record" ("uid");
CREATE INDEX IF NOT EXISTS "luck_lottery_record_prize"
  ON "luck_lottery_record" ("prize_id");
CREATE INDEX IF NOT EXISTS "luck_lottery_record_lottery"
  ON "luck_lottery_record" ("lottery_id");
CREATE INDEX IF NOT EXISTS "luck_lottery_record_user_activity_time"
  ON "luck_lottery_record" ("uid", "lottery_id", "add_time", "id");

-- Worker-only reliability table. PHP kept order/review tickets in a 120-second
-- Redis value that later events overwrote. Source events are instead retained
-- here with an idempotency key and atomically consumed by the draw transaction.
CREATE TABLE IF NOT EXISTS "luck_lottery_entitlement" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER NOT NULL,
  "factor" SMALLINT NOT NULL,
  "source_type" VARCHAR(16) NOT NULL,
  "source_id" VARCHAR(64) NOT NULL,
  "source_key" VARCHAR(128) NOT NULL,
  "amount" INTEGER NOT NULL,
  "remaining" INTEGER NOT NULL,
  "expires_at" INTEGER NOT NULL,
  "add_time" INTEGER NOT NULL,
  "update_time" INTEGER NOT NULL,
  CONSTRAINT "luck_lottery_entitlement_factor_ck" CHECK ("factor" IN (3, 4)),
  CONSTRAINT "luck_lottery_entitlement_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "luck_lottery_entitlement_remaining_ck" CHECK ("remaining" >= 0 AND "remaining" <= "amount")
);

CREATE UNIQUE INDEX IF NOT EXISTS "luck_lottery_entitlement_source_uq"
  ON "luck_lottery_entitlement" ("source_key");
CREATE INDEX IF NOT EXISTS "luck_lottery_entitlement_available"
  ON "luck_lottery_entitlement" ("uid", "factor", "expires_at", "id")
  WHERE "remaining" > 0;
