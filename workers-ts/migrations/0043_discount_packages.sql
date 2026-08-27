-- Preserve legacy fixed and mix-and-match discount packages with product snapshots.
CREATE TABLE IF NOT EXISTS "store_discounts" (
  "id" SERIAL PRIMARY KEY,
  "title" VARCHAR(255) DEFAULT '' NOT NULL,
  "image" VARCHAR(500) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "is_limit" SMALLINT DEFAULT 0 NOT NULL,
  "limit_num" INTEGER DEFAULT 0 NOT NULL,
  "link_ids" VARCHAR(255) DEFAULT '' NOT NULL,
  "product_ids" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_time" SMALLINT DEFAULT 0 NOT NULL,
  "start_time" INTEGER DEFAULT 0 NOT NULL,
  "stop_time" INTEGER DEFAULT 0 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "free_shipping" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "is_support_refund" SMALLINT DEFAULT 1 NOT NULL,
  "delivery_type" VARCHAR(10) DEFAULT '' NOT NULL,
  "freight" SMALLINT DEFAULT 2 NOT NULL,
  "custom_form" TEXT
);

CREATE INDEX IF NOT EXISTS "sd_active_window"
  ON "store_discounts" ("status", "is_del", "is_limit", "start_time", "stop_time");
CREATE INDEX IF NOT EXISTS "sd_sort_id" ON "store_discounts" ("sort", "id");

CREATE TABLE IF NOT EXISTS "store_discounts_products" (
  "id" SERIAL PRIMARY KEY,
  "discount_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "product_type" SMALLINT DEFAULT 0 NOT NULL,
  "title" VARCHAR(255) DEFAULT '0' NOT NULL,
  "image" VARCHAR(500) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "temp_id" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sdp_discount_product"
  ON "store_discounts_products" ("discount_id", "product_id");
CREATE INDEX IF NOT EXISTS "sdp_product_discount"
  ON "store_discounts_products" ("product_id", "discount_id");
CREATE INDEX IF NOT EXISTS "sdp_discount_order"
  ON "store_discounts_products" ("discount_id", "id");
