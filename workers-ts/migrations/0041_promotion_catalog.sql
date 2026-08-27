-- Preserve promotion rules and their product/coupon/brand/label scope records.
CREATE TABLE IF NOT EXISTS "store_promotions" (
  "id" SERIAL PRIMARY KEY,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "promotions_type" SMALLINT DEFAULT 1 NOT NULL,
  "promotions_cate" SMALLINT DEFAULT 1 NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "title" VARCHAR(255) DEFAULT '' NOT NULL,
  "image" VARCHAR(255) DEFAULT '' NOT NULL,
  "desc" TEXT,
  "threshold_type" SMALLINT DEFAULT 1 NOT NULL,
  "threshold" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "discount_type" SMALLINT DEFAULT 1 NOT NULL,
  "n_piece_n_discount" SMALLINT DEFAULT 1 NOT NULL,
  "discount" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "give_integral" INTEGER DEFAULT 0 NOT NULL,
  "give_coupon_id" TEXT,
  "give_product_id" TEXT,
  "give_product_unique" TEXT,
  "overlay" VARCHAR(255) DEFAULT '' NOT NULL,
  "label_id" TEXT,
  "product_partake_type" SMALLINT DEFAULT 0 NOT NULL,
  "product_id" TEXT,
  "is_limit" SMALLINT DEFAULT 0 NOT NULL,
  "limit_num" INTEGER DEFAULT 0 NOT NULL,
  "start_time" INTEGER DEFAULT 0 NOT NULL,
  "stop_time" INTEGER DEFAULT 0 NOT NULL,
  "sort" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sp_parent" ON "store_promotions" ("pid");
CREATE INDEX IF NOT EXISTS "sp_owner" ON "store_promotions" ("type", "store_id");
CREATE INDEX IF NOT EXISTS "sp_type" ON "store_promotions" ("promotions_type");
CREATE INDEX IF NOT EXISTS "sp_update_time" ON "store_promotions" ("update_time");
CREATE INDEX IF NOT EXISTS "sp_active_window"
  ON "store_promotions" ("pid", "status", "is_del", "start_time", "stop_time");

CREATE TABLE IF NOT EXISTS "store_promotions_auxiliary" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "promotions_id" INTEGER DEFAULT 0 NOT NULL,
  "product_partake_type" SMALLINT DEFAULT 1 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "coupon_id" INTEGER DEFAULT 0 NOT NULL,
  "brand_id" INTEGER DEFAULT 0 NOT NULL,
  "store_label_id" INTEGER DEFAULT 0 NOT NULL,
  "limit_num" INTEGER DEFAULT 0 NOT NULL,
  "surplus_num" INTEGER DEFAULT 0 NOT NULL,
  "is_all" SMALLINT DEFAULT 1 NOT NULL,
  "unique" TEXT
);

CREATE INDEX IF NOT EXISTS "spa_promotion_product"
  ON "store_promotions_auxiliary" ("promotions_id", "product_id");
CREATE INDEX IF NOT EXISTS "spa_promotion_type_product"
  ON "store_promotions_auxiliary" ("promotions_id", "type", "product_id");
CREATE INDEX IF NOT EXISTS "spa_promotion_type_brand"
  ON "store_promotions_auxiliary" ("promotions_id", "type", "brand_id");
CREATE INDEX IF NOT EXISTS "spa_promotion_type_label"
  ON "store_promotions_auxiliary" ("promotions_id", "type", "store_label_id");
