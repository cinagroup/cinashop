-- Preserve PHP coupon issuance semantics. The data manifest swaps PHP type
-- (applicable scope) with coupon_type (discount mode) into their Worker roles.
ALTER TABLE "store_coupon_issue"
  ADD COLUMN IF NOT EXISTS "cid" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "category" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_permanent" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_give_subscribe" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_full_give" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "full_reduction" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_del" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "title" VARCHAR(64) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "integral" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "use_start_time" TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "use_end_time" TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "rule" TEXT,
  ADD COLUMN IF NOT EXISTS "legacy_product_ids" TEXT,
  ADD COLUMN IF NOT EXISTS "legacy_category_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "legacy_brand_id" INTEGER DEFAULT 0 NOT NULL,
  ALTER COLUMN "coupon_title" TYPE VARCHAR(255),
  ALTER COLUMN "receive_limit" SET DEFAULT 0,
  ALTER COLUMN "status" SET DEFAULT 1;

CREATE INDEX IF NOT EXISTS "sci_claim_window"
  ON "store_coupon_issue" ("status", "is_del", "receive_type", "start_time", "end_time");
CREATE INDEX IF NOT EXISTS "sci_scope"
  ON "store_coupon_issue" ("coupon_type", "legacy_category_id", "legacy_brand_id");
