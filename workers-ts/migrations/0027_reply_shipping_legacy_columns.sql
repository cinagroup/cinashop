-- Preserve PHP reply-thread metadata and shipping-template ownership without
-- conflating the legacy owner type with the billing mode.
ALTER TABLE "store_product_reply_comment"
  ADD COLUMN IF NOT EXISTS "type" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "relation_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "pid" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "update_time" INTEGER DEFAULT 0 NOT NULL,
  ALTER COLUMN "content" TYPE VARCHAR(1000);

ALTER TABLE "shipping_templates"
  ADD COLUMN IF NOT EXISTS "owner_type" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "relation_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "appoint" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "no_delivery" SMALLINT DEFAULT 0 NOT NULL,
  ALTER COLUMN "name" TYPE VARCHAR(255);

CREATE INDEX IF NOT EXISTS "sprc_reply_parent"
  ON "store_product_reply_comment" ("reply_id", "pid", "add_time");

CREATE INDEX IF NOT EXISTS "st_owner_active"
  ON "shipping_templates" ("owner_type", "relation_id", "is_del", "sort" DESC);
