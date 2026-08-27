-- Superseded product category/brand/label auxiliary rows from the PHP schema.
-- These tables remain importable as historical evidence only. Active product
-- category, brand and label writes use store_product_relation and must not
-- dual-write these obsolete authorities.
CREATE TABLE IF NOT EXISTS "store_product_category_brand" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "cate_id" INTEGER DEFAULT 0 NOT NULL,
  "brand_id" INTEGER DEFAULT 0 NOT NULL,
  "brand_name" VARCHAR(100) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "store_product_category_brand_cate_id"
  ON "store_product_category_brand" ("cate_id");

CREATE TABLE IF NOT EXISTS "store_product_cate" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "cate_id" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "cate_pid" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS "store_product_label_auxiliary" (
  "id" SERIAL PRIMARY KEY,
  "label_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "store_product_label_auxiliary_label_product"
  ON "store_product_label_auxiliary" ("label_id", "product_id");
