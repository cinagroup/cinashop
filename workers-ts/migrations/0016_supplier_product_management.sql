-- 供应商实物商品全生命周期：详情、SKU/库存审计与租户查询索引。
CREATE TABLE IF NOT EXISTS "store_product_description" (
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "description" TEXT,
  "type" SMALLINT DEFAULT 0 NOT NULL
);

-- Preserve every existing row. If duplicates exist this statement fails
-- visibly; the read-only migration planner reports duplicate group/excess-row
-- counts so an operator can make an explicit archival or merge decision.
CREATE UNIQUE INDEX IF NOT EXISTS "spd_product_type_unique"
  ON "store_product_description" ("product_id", "type");
CREATE INDEX IF NOT EXISTS "spd_type_product"
  ON "store_product_description" ("type", "product_id");

CREATE TABLE IF NOT EXISTS "store_product_stock_record" (
  "id" SERIAL PRIMARY KEY,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "unique" VARCHAR(32) DEFAULT '' NOT NULL,
  "cost_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "number" INTEGER DEFAULT 0 NOT NULL,
  "pm" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "spsr_product_time"
  ON "store_product_stock_record" ("product_id", "add_time");
CREATE INDEX IF NOT EXISTS "spsr_unique_time"
  ON "store_product_stock_record" ("unique", "add_time");

CREATE INDEX IF NOT EXISTS "sp_supplier_list"
  ON "store_product" ("type", "relation_id", "is_del", "is_show", "id" DESC);
CREATE INDEX IF NOT EXISTS "spc_supplier_tree"
  ON "store_product_category" ("type", "relation_id", "pid", "is_show", "sort" DESC);
CREATE INDEX IF NOT EXISTS "spav_product_type_suk"
  ON "store_product_attr_value" ("product_id", "type", "suk");
CREATE INDEX IF NOT EXISTS "spr_product_type_relation"
  ON "store_product_relation" ("product_id", "type", "relation_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spd_type_ck' AND conrelid = 'store_product_description'::regclass) THEN
    ALTER TABLE "store_product_description" ADD CONSTRAINT "spd_type_ck"
      CHECK ("type" BETWEEN 0 AND 7) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spsr_pm_ck' AND conrelid = 'store_product_stock_record'::regclass) THEN
    ALTER TABLE "store_product_stock_record" ADD CONSTRAINT "spsr_pm_ck"
      CHECK ("pm" BETWEEN 0 AND 1) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spsr_number_ck' AND conrelid = 'store_product_stock_record'::regclass) THEN
    ALTER TABLE "store_product_stock_record" ADD CONSTRAINT "spsr_number_ck"
      CHECK ("number" >= 0) NOT VALID;
  END IF;
END $$;
