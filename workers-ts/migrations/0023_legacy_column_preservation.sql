-- Preserve low-cardinality legacy fields that were previously the only
-- source-only column on their shared table. Defaults keep new Worker writes
-- backward compatible while allowing the old values to migrate losslessly.
ALTER TABLE "store_order_refund"
  ADD COLUMN IF NOT EXISTS "refund_goods_type" SMALLINT DEFAULT 1 NOT NULL,
  ALTER COLUMN "refund_phone" TYPE VARCHAR(32),
  ALTER COLUMN "refund_express" TYPE VARCHAR(100),
  ALTER COLUMN "refund_express_name" TYPE VARCHAR(255);

ALTER TABLE "store_product_words"
  ADD COLUMN IF NOT EXISTS "is_del" SMALLINT DEFAULT 0 NOT NULL;

ALTER TABLE "system_admin"
  ADD COLUMN IF NOT EXISTS "is_way" SMALLINT DEFAULT 0 NOT NULL;

ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS "replace_order_num" VARCHAR(32) DEFAULT '' NOT NULL;

ALTER TABLE "user_recharge"
  ADD COLUMN IF NOT EXISTS "auth_code" VARCHAR(50) DEFAULT '' NOT NULL;
