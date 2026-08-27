-- Preserve order-line promotion/write-off state and the complete PHP group-buy
-- participant snapshot. member_count separates Worker runtime occupancy from
-- PHP store_pink.people, which is the required group size.
ALTER TABLE "store_order_cart_info"
  ADD COLUMN IF NOT EXISTS "promotions_id" TEXT,
  ADD COLUMN IF NOT EXISTS "write_times" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "write_surplus_times" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "write_start" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "write_end" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_advent_sms" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_expire_sms" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_writeoff" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "writeoff_time" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "add_time" INTEGER DEFAULT 0 NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "soci_oid_unique_uq"
  ON "store_order_cart_info" ("oid", "unique");
CREATE INDEX IF NOT EXISTS "soci_cart_refund"
  ON "store_order_cart_info" ("cart_id", "refund_num");
CREATE INDEX IF NOT EXISTS "soci_product"
  ON "store_order_cart_info" ("product_id");

ALTER TABLE "store_pink"
  ADD COLUMN IF NOT EXISTS "nickname" VARCHAR(64) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "avatar" VARCHAR(256) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "total_num" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "total_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_tpl" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_refund" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_virtual" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "member_count" INTEGER DEFAULT 0 NOT NULL;

-- Rows created by the pre-parity Worker used people as the current count and
-- have none of the newly preserved PHP snapshots. Convert only that signature;
-- imported PHP participant rows retain people as the required group size.
UPDATE "store_pink" AS p
SET "member_count" = GREATEST(p."people", 1),
    "people" = CASE WHEN c."people" > 0 THEN c."people" ELSE p."people" END
FROM "store_combination" AS c
WHERE p."combination_id" = c."id"
  AND p."member_count" = 0
  AND p."nickname" = ''
  AND p."avatar" = ''
  AND p."total_num" = 0
  AND p."total_price" = 0
  AND p."price" = 0;

CREATE INDEX IF NOT EXISTS "sp_leader_active"
  ON "store_pink" ("combination_id", "k_id", "status", "add_time" DESC);
CREATE INDEX IF NOT EXISTS "sp_group_member"
  ON "store_pink" ("k_id", "is_refund", "status");
