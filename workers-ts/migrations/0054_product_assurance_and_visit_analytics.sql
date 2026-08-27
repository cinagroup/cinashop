-- Preserve the assurance catalog and product visit evidence still used by the
-- PHP product-detail, user-history, supplier and statistics call chains.
CREATE TABLE IF NOT EXISTS "store_product_ensure" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "image" VARCHAR(255) DEFAULT '' NOT NULL,
  "desc" VARCHAR(255) DEFAULT '' NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "spe_type" ON "store_product_ensure" ("type");
CREATE INDEX IF NOT EXISTS "spe_scope_active"
  ON "store_product_ensure" ("type", "relation_id", "status", "sort", "id");

CREATE TABLE IF NOT EXISTS "store_product_log" (
  "id" SERIAL PRIMARY KEY,
  "type" VARCHAR(16) DEFAULT 'visit' NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "visit_num" SMALLINT DEFAULT 0 NOT NULL,
  "cart_num" INTEGER DEFAULT 0 NOT NULL,
  "order_num" INTEGER DEFAULT 0 NOT NULL,
  "pay_num" INTEGER DEFAULT 0 NOT NULL,
  "pay_price" DECIMAL(10,2) DEFAULT 0.00 NOT NULL,
  "cost_price" DECIMAL(10,2) DEFAULT 0.00 NOT NULL,
  "pay_uid" INTEGER DEFAULT 0 NOT NULL,
  "refund_num" INTEGER DEFAULT 0 NOT NULL,
  "refund_price" DECIMAL(10,2) DEFAULT 0.00 NOT NULL,
  "collect_num" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "delete_time" TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "spl_type" ON "store_product_log" ("type");
CREATE INDEX IF NOT EXISTS "spl_product_id" ON "store_product_log" ("product_id");
CREATE INDEX IF NOT EXISTS "spl_uid" ON "store_product_log" ("uid");
CREATE INDEX IF NOT EXISTS "spl_add_time" ON "store_product_log" ("add_time");
CREATE INDEX IF NOT EXISTS "spl_uid_type" ON "store_product_log" ("uid", "type");
CREATE INDEX IF NOT EXISTS "spl_visit_history"
  ON "store_product_log" ("uid", "type", "delete_time", "add_time", "id");

CREATE TABLE IF NOT EXISTS "store_visit" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "product_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "cate_id" INTEGER DEFAULT 0 NOT NULL,
  "type" CHAR(50) DEFAULT '' NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "count" INTEGER DEFAULT 0 NOT NULL,
  "content" VARCHAR(255) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sv_product_id" ON "store_visit" ("product_id");
CREATE INDEX IF NOT EXISTS "sv_user_product"
  ON "store_visit" ("uid", "product_id", "product_type", "id");
