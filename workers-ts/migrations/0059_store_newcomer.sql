-- Preserve the PHP newcomer-exclusive product catalog. Activity SKU rows remain
-- in store_product_attr_value with type=7 and product_id=store_newcomer.id;
-- base product SKU rows (type=0) remain the stock authority.
CREATE TABLE IF NOT EXISTS "store_newcomer" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "product_type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "price" DECIMAL(12,2) DEFAULT 0.00 NOT NULL,
  "ot_price" DECIMAL(12,2) DEFAULT 0.00 NOT NULL,
  "sales" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "store_newcomer_product_id"
  ON "store_newcomer" ("product_id");
CREATE INDEX IF NOT EXISTS "store_newcomer_active_id"
  ON "store_newcomer" ("is_del", "id");
CREATE INDEX IF NOT EXISTS "store_newcomer_product_active"
  ON "store_newcomer" ("product_id", "is_del", "id");
