-- Preserve the remaining store-scoped auxiliary tables from the PHP install
-- schema. The branch-product and store-extract tables are dormant historical
-- evidence in the checked-in PHP tree; store_config remains an active scoped
-- override store. No source uniqueness or foreign-key rule is invented here.
CREATE TABLE IF NOT EXISTS "store_config" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "key_name" VARCHAR(100) DEFAULT '' NOT NULL,
  "value" VARCHAR(2000) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "store_config_type_relation"
  ON "store_config" ("type", "relation_id");
CREATE INDEX IF NOT EXISTS "store_config_scope_key"
  ON "store_config" ("type", "relation_id", "key_name", "id");

CREATE TABLE IF NOT EXISTS "store_branch_product" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "image" VARCHAR(255) DEFAULT '' NOT NULL,
  "store_name" VARCHAR(128) DEFAULT '' NOT NULL,
  "store_info" VARCHAR(255) DEFAULT '' NOT NULL,
  "keyword" VARCHAR(255) DEFAULT '' NOT NULL,
  "bar_code" VARCHAR(15) DEFAULT '' NOT NULL,
  "cate_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "sales" INTEGER DEFAULT 0 NOT NULL,
  "stock" INTEGER DEFAULT 0 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "label_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS "store_branch_product_attr_value" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "unique" CHAR(8) DEFAULT '' NOT NULL,
  "sales" INTEGER DEFAULT 0 NOT NULL,
  "stock" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "bar_code" VARCHAR(50) DEFAULT '' NOT NULL,
  "code" VARCHAR(50) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "store_branch_product_attr_value_code"
  ON "store_branch_product_attr_value" ("code");

CREATE TABLE IF NOT EXISTS "store_extract" (
  "id" SERIAL PRIMARY KEY,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "store_staff_id" INTEGER DEFAULT 0 NOT NULL,
  "extract_type" VARCHAR(32) DEFAULT 'bank' NOT NULL,
  "bank_code" VARCHAR(32) DEFAULT '0' NOT NULL,
  "bank_address" VARCHAR(256) DEFAULT '' NOT NULL,
  "alipay_account" VARCHAR(64) DEFAULT '' NOT NULL,
  "wechat" VARCHAR(15) DEFAULT '' NOT NULL,
  "qrcode_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "extract_price" NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  "mark" VARCHAR(512) DEFAULT '' NOT NULL,
  "balance" NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "pay_status" SMALLINT DEFAULT 0 NOT NULL,
  "store_mark" VARCHAR(255) DEFAULT '' NOT NULL,
  "admin_id" INTEGER DEFAULT 0 NOT NULL,
  "fail_msg" VARCHAR(128) DEFAULT '' NOT NULL,
  "fail_time" INTEGER DEFAULT 0 NOT NULL,
  "voucher_image" VARCHAR(255) DEFAULT '' NOT NULL,
  "voucher_title" VARCHAR(255) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "store_extract_store_id"
  ON "store_extract" ("store_id");
CREATE INDEX IF NOT EXISTS "store_extract_extract_type"
  ON "store_extract" ("extract_type");
CREATE INDEX IF NOT EXISTS "store_extract_status"
  ON "store_extract" ("status");
CREATE INDEX IF NOT EXISTS "store_extract_add_time"
  ON "store_extract" ("add_time");
