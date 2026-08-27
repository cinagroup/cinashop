-- Preserve reusable product metadata and legacy composite configuration.
-- These tables are distinct from per-product store_product_attr* snapshots.
CREATE TABLE IF NOT EXISTS "category" (
  "id" SERIAL PRIMARY KEY,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "owner_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "group" SMALLINT DEFAULT 0 NOT NULL,
  "other" TEXT,
  "is_show" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "integral_min" INTEGER DEFAULT 0 NOT NULL,
  "integral_max" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "legacy_category_pid" ON "category" ("pid");
CREATE INDEX IF NOT EXISTS "legacy_category_name" ON "category" ("name");
CREATE INDEX IF NOT EXISTS "legacy_category_owner_type_id"
  ON "category" ("owner_id", "type", "id");
CREATE INDEX IF NOT EXISTS "legacy_category_group" ON "category" ("group");
CREATE INDEX IF NOT EXISTS "legacy_category_scope_group"
  ON "category" ("type", "relation_id", "group", "is_show", "sort", "id");

CREATE TABLE IF NOT EXISTS "store_product_unit" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "sort" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "spu_scope_active"
  ON "store_product_unit" ("type", "relation_id", "is_del", "status", "sort", "id");
CREATE INDEX IF NOT EXISTS "spu_name" ON "store_product_unit" ("name");

CREATE TABLE IF NOT EXISTS "store_product_rule" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "rule_name" VARCHAR(32) DEFAULT '' NOT NULL,
  "rule_value" TEXT
);

CREATE INDEX IF NOT EXISTS "spr_scope_id"
  ON "store_product_rule" ("type", "relation_id", "id");
CREATE INDEX IF NOT EXISTS "spr_scope_name"
  ON "store_product_rule" ("type", "relation_id", "rule_name");

CREATE TABLE IF NOT EXISTS "store_product_specs" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "temp_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "value" VARCHAR(255) DEFAULT '' NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sps_type" ON "store_product_specs" ("type");
CREATE INDEX IF NOT EXISTS "sps_template_active"
  ON "store_product_specs" ("temp_id", "status", "sort", "id");
CREATE INDEX IF NOT EXISTS "sps_scope_template"
  ON "store_product_specs" ("type", "relation_id", "temp_id", "id");

-- Card numbers/passwords are sensitive fulfillment inventory. They remain a
-- separate table and are not returned by the metadata compatibility APIs.
CREATE TABLE IF NOT EXISTS "store_product_virtual" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "attr_unique" VARCHAR(20) DEFAULT '' NOT NULL,
  "card_no" VARCHAR(255) DEFAULT '' NOT NULL,
  "card_pwd" VARCHAR(255) DEFAULT '' NOT NULL,
  "card_unique" VARCHAR(32) DEFAULT '' NOT NULL,
  "order_id" VARCHAR(255) DEFAULT '' NOT NULL,
  "order_type" SMALLINT DEFAULT 1 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "spv_product_attr_available"
  ON "store_product_virtual" ("product_id", "attr_unique", "uid", "id");
CREATE INDEX IF NOT EXISTS "spv_store_product"
  ON "store_product_virtual" ("store_id", "product_id", "id");
CREATE INDEX IF NOT EXISTS "spv_order" ON "store_product_virtual" ("order_id");
CREATE INDEX IF NOT EXISTS "spv_uid" ON "store_product_virtual" ("uid");
CREATE INDEX IF NOT EXISTS "spv_card_unique" ON "store_product_virtual" ("card_unique");

CREATE TABLE IF NOT EXISTS "system_group" (
  "id" SERIAL PRIMARY KEY,
  "cate_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "info" VARCHAR(256) DEFAULT '' NOT NULL,
  "config_name" VARCHAR(50) DEFAULT '' NOT NULL,
  "fields" TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS "system_group_config_name_uq"
  ON "system_group" ("config_name");
CREATE INDEX IF NOT EXISTS "system_group_cate" ON "system_group" ("cate_id");

CREATE TABLE IF NOT EXISTS "system_group_data" (
  "id" SERIAL PRIMARY KEY,
  "gid" INTEGER DEFAULT 0 NOT NULL,
  "value" TEXT,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_group_data_gid"
  ON "system_group_data" ("gid", "status", "sort", "id");
