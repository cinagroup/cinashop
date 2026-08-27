-- Supplier 第二批：履约字段、结算快照、财务流水与提现。

ALTER TABLE "store_order"
  ADD COLUMN IF NOT EXISTS "delivery_name" VARCHAR(64) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "delivery_code" VARCHAR(50) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "delivery_type" VARCHAR(32) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "delivery_id" VARCHAR(64) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "fictitious_content" VARCHAR(500) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "delivery_uid" INTEGER DEFAULT 0 NOT NULL;

ALTER TABLE "store_order_cart_info"
  ADD COLUMN IF NOT EXISTS "settle_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL;

-- 仅为尚未形成结算流水的历史订单补当前商品结算价；正式旧库迁移仍应使用旧订单快照。
UPDATE "store_order_cart_info" AS ci
SET "settle_price" = product."settle_price"
FROM "store_product" AS product
WHERE ci."product_id" = product."id"
  AND ci."settle_price" = 0;

CREATE TABLE IF NOT EXISTS "supplier_flowing_water" (
  "id" SERIAL PRIMARY KEY,
  "supplier_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "order_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "link_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "pm" SMALLINT DEFAULT 0 NOT NULL,
  "number" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "pay_type" VARCHAR(20) DEFAULT '' NOT NULL,
  "pay_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "total_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "pay_postage" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "remark" VARCHAR(512) DEFAULT '' NOT NULL,
  "finish_time" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "mark" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "trade_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "sfw_order_id_uq" ON "supplier_flowing_water" ("order_id");
CREATE INDEX IF NOT EXISTS "sfw_supplier_time" ON "supplier_flowing_water" ("supplier_id", "add_time");
CREATE INDEX IF NOT EXISTS "sfw_supplier_status" ON "supplier_flowing_water" ("supplier_id", "status", "is_del");

CREATE TABLE IF NOT EXISTS "supplier_transactions" (
  "id" SERIAL PRIMARY KEY,
  "supplier_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "order_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "link_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "pm" SMALLINT DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "pay_type" VARCHAR(20) DEFAULT '' NOT NULL,
  "pay_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "total_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "pay_postage" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "remark" VARCHAR(512) DEFAULT '' NOT NULL,
  "mark" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "trade_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "stx_order_id_uq" ON "supplier_transactions" ("order_id");
CREATE INDEX IF NOT EXISTS "stx_supplier_time" ON "supplier_transactions" ("supplier_id", "add_time");

CREATE TABLE IF NOT EXISTS "supplier_extract" (
  "id" SERIAL PRIMARY KEY,
  "supplier_id" INTEGER DEFAULT 0 NOT NULL,
  "extract_type" VARCHAR(32) DEFAULT 'bank' NOT NULL,
  "bank_code" VARCHAR(32) DEFAULT '' NOT NULL,
  "bank_address" VARCHAR(256) DEFAULT '' NOT NULL,
  "alipay_account" VARCHAR(64) DEFAULT '' NOT NULL,
  "wechat" VARCHAR(32) DEFAULT '' NOT NULL,
  "qrcode_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "extract_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "mark" VARCHAR(512) DEFAULT '' NOT NULL,
  "balance" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "pay_status" SMALLINT DEFAULT 0 NOT NULL,
  "supplier_mark" VARCHAR(255) DEFAULT '' NOT NULL,
  "admin_id" INTEGER DEFAULT 0 NOT NULL,
  "fail_msg" VARCHAR(128) DEFAULT '' NOT NULL,
  "fail_time" INTEGER DEFAULT 0 NOT NULL,
  "voucher_image" VARCHAR(256) DEFAULT '' NOT NULL,
  "voucher_title" VARCHAR(256) DEFAULT '' NOT NULL,
  "pay_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
ALTER TABLE "supplier_extract"
  ADD COLUMN IF NOT EXISTS "pay_time" INTEGER DEFAULT 0 NOT NULL;
CREATE INDEX IF NOT EXISTS "se_supplier_time" ON "supplier_extract" ("supplier_id", "add_time");
CREATE INDEX IF NOT EXISTS "se_supplier_status" ON "supplier_extract" ("supplier_id", "status", "pay_status");
