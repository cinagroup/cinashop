-- Preserve order-level savings, invoice snapshots, promotion allocation, and write-off evidence.
CREATE TABLE IF NOT EXISTS "store_order_economize" (
  "id" SERIAL PRIMARY KEY,
  "order_id" VARCHAR(32) DEFAULT '' NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "order_type" SMALLINT DEFAULT 1 NOT NULL,
  "pay_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "postage_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "member_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "offline_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "coupon_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "soe_order_uid_uq"
  ON "store_order_economize" ("order_id", "uid");
CREATE INDEX IF NOT EXISTS "soe_uid_time"
  ON "store_order_economize" ("uid", "add_time");
CREATE INDEX IF NOT EXISTS "soe_status_time"
  ON "store_order_economize" ("status", "add_time");

CREATE TABLE IF NOT EXISTS "store_order_invoice" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "category" VARCHAR(10) DEFAULT 'order' NOT NULL,
  "order_id" INTEGER DEFAULT 0 NOT NULL,
  "invoice_id" INTEGER DEFAULT 0 NOT NULL,
  "header_type" SMALLINT DEFAULT 1 NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "duty_number" VARCHAR(50) DEFAULT '' NOT NULL,
  "drawer_phone" VARCHAR(30) DEFAULT '' NOT NULL,
  "email" VARCHAR(100) DEFAULT '' NOT NULL,
  "tell" VARCHAR(30) DEFAULT '' NOT NULL,
  "address" VARCHAR(255) DEFAULT '' NOT NULL,
  "bank" VARCHAR(50) DEFAULT '' NOT NULL,
  "card_number" VARCHAR(50) DEFAULT '' NOT NULL,
  "is_pay" SMALLINT DEFAULT 0 NOT NULL,
  "is_refund" SMALLINT DEFAULT 0 NOT NULL,
  "is_invoice" SMALLINT DEFAULT 0 NOT NULL,
  "invoice_number" VARCHAR(50) DEFAULT '' NOT NULL,
  "invoice_amount" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "remark" VARCHAR(255) DEFAULT '' NOT NULL,
  "invoice_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "soi_order" ON "store_order_invoice" ("order_id");
CREATE INDEX IF NOT EXISTS "soi_uid_state_time"
  ON "store_order_invoice" ("uid", "is_del", "is_refund", "add_time");
CREATE INDEX IF NOT EXISTS "soi_issue_state_time"
  ON "store_order_invoice" ("is_pay", "is_del", "is_invoice", "add_time");

CREATE TABLE IF NOT EXISTS "store_order_promotions" (
  "id" SERIAL PRIMARY KEY,
  "oid" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "promotions_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "promotions_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sop_order_promotion"
  ON "store_order_promotions" ("oid", "promotions_id");
CREATE INDEX IF NOT EXISTS "sop_order_product"
  ON "store_order_promotions" ("oid", "product_id");
CREATE INDEX IF NOT EXISTS "sop_uid_time"
  ON "store_order_promotions" ("uid", "add_time");

CREATE TABLE IF NOT EXISTS "store_order_writeoff" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "oid" INTEGER DEFAULT 0 NOT NULL,
  "order_cart_id" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "staff_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "product_type" SMALLINT DEFAULT 0 NOT NULL,
  "writeoff_num" INTEGER DEFAULT 1 NOT NULL,
  "writeoff_price" NUMERIC(10,2) DEFAULT '0.00' NOT NULL,
  "writeoff_code" VARCHAR(30) DEFAULT '' NOT NULL,
  "is_admin" SMALLINT DEFAULT 0 NOT NULL,
  "admin_id" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sow_order_time"
  ON "store_order_writeoff" ("oid", "add_time");
CREATE INDEX IF NOT EXISTS "sow_cart_time"
  ON "store_order_writeoff" ("order_cart_id", "add_time");
CREATE INDEX IF NOT EXISTS "sow_uid_time"
  ON "store_order_writeoff" ("uid", "add_time");
CREATE INDEX IF NOT EXISTS "sow_code" ON "store_order_writeoff" ("writeoff_code");
CREATE INDEX IF NOT EXISTS "sow_operator_time"
  ON "store_order_writeoff" ("type", "relation_id", "staff_id", "add_time");
