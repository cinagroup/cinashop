-- Preserve distributor applications and every historical relationship change.
-- The source has no uniqueness constraints on these tables, so importing old
-- duplicates must remain possible.
CREATE TABLE IF NOT EXISTS "promoter_apply" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "nickname" VARCHAR(255) DEFAULT '' NOT NULL,
  "real_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "phone" VARCHAR(32) DEFAULT '0' NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "status_time" INTEGER DEFAULT 0 NOT NULL,
  "refusal_reason" VARCHAR(1000) DEFAULT '' NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "pa_uid_active"
  ON "promoter_apply" ("uid", "is_del", "id");
CREATE INDEX IF NOT EXISTS "pa_status_time"
  ON "promoter_apply" ("status", "is_del", "add_time", "id");

CREATE TABLE IF NOT EXISTS "user_spread" (
  "id" SERIAL PRIMARY KEY,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "staff_id" INTEGER DEFAULT 0 NOT NULL,
  "spread_uid" INTEGER DEFAULT 0 NOT NULL,
  "spread_time" INTEGER DEFAULT 0 NOT NULL,
  "admin_id" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "us_uid" ON "user_spread" ("uid");
CREATE INDEX IF NOT EXISTS "us_spread_uid" ON "user_spread" ("spread_uid");
CREATE INDEX IF NOT EXISTS "us_uid_time"
  ON "user_spread" ("uid", "spread_time", "id");
CREATE INDEX IF NOT EXISTS "us_parent_time"
  ON "user_spread" ("spread_uid", "spread_time", "id");
CREATE INDEX IF NOT EXISTS "us_store_staff_time"
  ON "user_spread" ("store_id", "staff_id", "spread_time", "id");

-- This is a legacy/deprecated freeze ledger. The active Worker derives frozen
-- commission from user_brokerage.frozen_time and must not double-count it.
CREATE TABLE IF NOT EXISTS "user_brokerage_frozen" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "price" DECIMAL(12,2) DEFAULT 0 NOT NULL,
  "uill_id" INTEGER DEFAULT 0 NOT NULL,
  "frozen_time" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "order_id" VARCHAR(50) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "ubf_uid_status"
  ON "user_brokerage_frozen" ("uid", "status");
CREATE INDEX IF NOT EXISTS "ubf_uid_frozen_time"
  ON "user_brokerage_frozen" ("uid", "frozen_time", "id");
CREATE INDEX IF NOT EXISTS "ubf_order_id" ON "user_brokerage_frozen" ("order_id");
