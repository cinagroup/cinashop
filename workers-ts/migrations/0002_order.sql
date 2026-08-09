-- M3 购物车 + 订单域迁移
-- 对应 eb_store_cart + eb_store_order + eb_store_order_cart_info + eb_user_bill

-- 购物车
CREATE TABLE IF NOT EXISTS "store_cart" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "tourist_uid" VARCHAR(50) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "product_type" SMALLINT DEFAULT 0 NOT NULL,
  "activity_id" INTEGER DEFAULT 0 NOT NULL,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "staff_id" INTEGER DEFAULT 0 NOT NULL,
  "product_attr_unique" VARCHAR(16) DEFAULT '' NOT NULL,
  "cart_num" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "is_pay" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "is_new" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL
);
CREATE INDEX IF NOT EXISTS "sc_product_id_idx" ON "store_cart" ("product_id");
CREATE INDEX IF NOT EXISTS "sc_uid_pay_idx" ON "store_cart" ("uid", "is_pay");
CREATE INDEX IF NOT EXISTS "sc_uid_del_idx" ON "store_cart" ("uid", "is_del");
CREATE INDEX IF NOT EXISTS "sc_type_idx" ON "store_cart" ("type");

-- 订单主表 (含 unique 幂等约束)
CREATE TABLE IF NOT EXISTS "store_order" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "order_id" VARCHAR(32) DEFAULT '0' NOT NULL,
  "trade_no" VARCHAR(100) DEFAULT '' NOT NULL,
  "supplier_id" INTEGER DEFAULT 0 NOT NULL,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "real_name" VARCHAR(32) DEFAULT '' NOT NULL,
  "user_phone" VARCHAR(18) DEFAULT '' NOT NULL,
  "province" VARCHAR(255) DEFAULT '' NOT NULL,
  "user_address" VARCHAR(100) DEFAULT '' NOT NULL,
  "user_location" VARCHAR(30) DEFAULT '' NOT NULL,
  "cart_id" TEXT,
  "pink_id" INTEGER DEFAULT 0 NOT NULL,
  "activity_id" INTEGER DEFAULT 0 NOT NULL,
  "activity_append" VARCHAR(255) DEFAULT '' NOT NULL,
  "freight_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "total_num" INTEGER DEFAULT 0 NOT NULL,
  "total_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "total_postage" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "pay_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "pay_postage" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "pay_integral" INTEGER DEFAULT 0 NOT NULL,
  "deduction_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "coupon_id" INTEGER DEFAULT 0 NOT NULL,
  "coupon_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "promotions_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "first_order_price" NUMERIC(8, 2) DEFAULT '0.00' NOT NULL,
  "change_price" NUMERIC(8, 2) DEFAULT '0.00' NOT NULL,
  "gain_integral" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "use_integral" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "back_integral" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "shipping_type" SMALLINT DEFAULT 1 NOT NULL,
  "verify_code" VARCHAR(12) DEFAULT '' NOT NULL,
  "paid" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "mark" VARCHAR(512) DEFAULT '' NOT NULL,
  "remark" VARCHAR(512) DEFAULT '' NOT NULL,
  "is_channel" SMALLINT DEFAULT 0 NOT NULL,
  "channel_type" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_remind" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "is_system_del" SMALLINT DEFAULT 0 NOT NULL,
  "pay_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "pay_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "unique" VARCHAR(50) DEFAULT '',
  "user_ip" VARCHAR(16) DEFAULT '' NOT NULL,
  "refund_status" SMALLINT DEFAULT 0 NOT NULL,
  "refund_reason" VARCHAR(255) DEFAULT '' NOT NULL,
  "refund_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "so_order_id_uq" ON "store_order" ("order_id");
-- 关键: unique(uid, unique) 幂等约束, 防并发下单重复
CREATE UNIQUE INDEX IF NOT EXISTS "so_unique_uid_uq" ON "store_order" ("unique", "uid");
CREATE INDEX IF NOT EXISTS "so_uid_idx" ON "store_order" ("uid");
CREATE INDEX IF NOT EXISTS "so_paid_idx" ON "store_order" ("paid");
CREATE INDEX IF NOT EXISTS "so_status_idx" ON "store_order" ("status");

-- 订单商品快照
CREATE TABLE IF NOT EXISTS "store_order_cart_info" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "oid" INTEGER DEFAULT 0 NOT NULL,
  "cart_id" VARCHAR(50) DEFAULT '0' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "staff_id" INTEGER DEFAULT 0 NOT NULL,
  "delivery_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "product_type" SMALLINT DEFAULT 0 NOT NULL,
  "sku_unique" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_gift" SMALLINT DEFAULT 0 NOT NULL,
  "is_support_refund" SMALLINT DEFAULT 1 NOT NULL,
  "cart_num" INTEGER DEFAULT 0 NOT NULL,
  "refund_num" INTEGER DEFAULT 0 NOT NULL,
  "surplus_num" INTEGER DEFAULT 0 NOT NULL,
  "cart_info" TEXT,
  "unique" VARCHAR(32) DEFAULT '' NOT NULL
);
CREATE INDEX IF NOT EXISTS "soci_oid_idx" ON "store_order_cart_info" ("oid");
CREATE INDEX IF NOT EXISTS "soci_uid_idx" ON "store_order_cart_info" ("uid");

-- 用户账单 (积分/佣金流水)
CREATE TABLE IF NOT EXISTS "user_bill" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "link_id" VARCHAR(32) DEFAULT '0' NOT NULL,
  "pm" SMALLINT DEFAULT 0 NOT NULL,
  "title" VARCHAR(64) DEFAULT '' NOT NULL,
  "category" VARCHAR(64) DEFAULT '' NOT NULL,
  "type" VARCHAR(64) DEFAULT '' NOT NULL,
  "number" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "balance" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "mark" VARCHAR(512) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "take" SMALLINT DEFAULT 0 NOT NULL,
  "frozen_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "ub_uid_idx" ON "user_bill" ("uid");
CREATE INDEX IF NOT EXISTS "ub_cat_type_link_idx" ON "user_bill" ("category", "type", "link_id");

-- 会员等级表
CREATE TABLE IF NOT EXISTS "system_user_level" (
  "id" SERIAL PRIMARY KEY,
  "mer_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "money" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "valid_date" INTEGER DEFAULT 0 NOT NULL,
  "is_forever" SMALLINT DEFAULT 0 NOT NULL,
  "is_pay" SMALLINT DEFAULT 0 NOT NULL,
  "is_show" SMALLINT DEFAULT 0 NOT NULL,
  "grade" INTEGER DEFAULT 0 NOT NULL,
  "discount" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "image" VARCHAR(255) DEFAULT '' NOT NULL,
  "color" VARCHAR(32) DEFAULT '' NOT NULL,
  "icon" VARCHAR(255) DEFAULT '' NOT NULL,
  "explain" TEXT,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "exp_num" INTEGER DEFAULT 0 NOT NULL
);
