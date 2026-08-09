-- M5 用户中心 + 营销活动迁移

-- 收货地址
CREATE TABLE IF NOT EXISTS "user_address" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "real_name" VARCHAR(32) DEFAULT '' NOT NULL,
  "phone" VARCHAR(16) DEFAULT '' NOT NULL,
  "province" VARCHAR(64) DEFAULT '' NOT NULL,
  "city" VARCHAR(64) DEFAULT '' NOT NULL,
  "district" VARCHAR(64) DEFAULT '' NOT NULL,
  "street" VARCHAR(100) DEFAULT '' NOT NULL,
  "city_id" INTEGER DEFAULT 0 NOT NULL,
  "detail" VARCHAR(256) DEFAULT '' NOT NULL,
  "post_code" INTEGER DEFAULT 0 NOT NULL,
  "longitude" VARCHAR(16) DEFAULT '' NOT NULL,
  "latitude" VARCHAR(16) DEFAULT '' NOT NULL,
  "is_default" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "ua_uid_idx" ON "user_address" ("uid");

-- 收藏/点赞关系 (修复 PHP 缺失的唯一约束)
CREATE TABLE IF NOT EXISTS "user_relation" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "type" VARCHAR(32) DEFAULT '' NOT NULL,
  "category" VARCHAR(32) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "ur_uid_rel_type_cat_idx" ON "user_relation" ("uid", "relation_id", "type", "category");
CREATE INDEX IF NOT EXISTS "ur_uid_type_idx" ON "user_relation" ("uid", "type");

-- 签到记录
CREATE TABLE IF NOT EXISTS "user_sign" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "title" VARCHAR(255) DEFAULT '' NOT NULL,
  "number" INTEGER DEFAULT 0 NOT NULL,
  "balance" INTEGER DEFAULT 0 NOT NULL,
  "exp_num" INTEGER DEFAULT 0 NOT NULL,
  "exp_balance" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "us_uid_time_idx" ON "user_sign" ("uid", "add_time");

-- 余额流水
CREATE TABLE IF NOT EXISTS "user_money" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "link_id" VARCHAR(32) DEFAULT '0' NOT NULL,
  "type" VARCHAR(64) DEFAULT '' NOT NULL,
  "title" VARCHAR(64) DEFAULT '' NOT NULL,
  "number" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "balance" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "pm" SMALLINT DEFAULT 0 NOT NULL,
  "mark" VARCHAR(512) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "um_uid_idx" ON "user_money" ("uid");

-- 充值订单
CREATE TABLE IF NOT EXISTS "user_recharge" (
  "id" SERIAL PRIMARY KEY,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "staff_id" INTEGER DEFAULT 0 NOT NULL,
  "order_id" VARCHAR(32) DEFAULT '' NOT NULL,
  "trade_no" VARCHAR(100) DEFAULT '' NOT NULL,
  "price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "give_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "recharge_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "paid" SMALLINT DEFAULT 0 NOT NULL,
  "pay_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "refund_price" NUMERIC(10, 2) DEFAULT '0.00' NOT NULL,
  "channel_type" VARCHAR(255) DEFAULT '' NOT NULL,
  "remarks" VARCHAR(255) DEFAULT '' NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "ur_order_id_idx" ON "user_recharge" ("order_id");
CREATE INDEX IF NOT EXISTS "ur_uid_idx" ON "user_recharge" ("uid");

-- 发票
CREATE TABLE IF NOT EXISTS "user_invoice" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
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
  "is_default" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "ui_uid_idx" ON "user_invoice" ("uid");

-- 优惠券模板
CREATE TABLE IF NOT EXISTS "store_coupon_issue" (
  "id" SERIAL PRIMARY KEY,
  "coupon_type" SMALLINT DEFAULT 1 NOT NULL,
  "coupon_title" VARCHAR(64) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "coupon_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "use_min_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "product_id" VARCHAR(500) DEFAULT '0' NOT NULL,
  "category_id" VARCHAR(500) DEFAULT '0' NOT NULL,
  "brand_id" VARCHAR(500) DEFAULT '0' NOT NULL,
  "total_count" INTEGER DEFAULT 0 NOT NULL,
  "remain_count" INTEGER DEFAULT 0 NOT NULL,
  "receive_limit" SMALLINT DEFAULT 1 NOT NULL,
  "receive_type" SMALLINT DEFAULT 0 NOT NULL,
  "start_time" TIMESTAMP,
  "end_time" TIMESTAMP,
  "day" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "app_type" SMALLINT DEFAULT 0 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "sci_status_idx" ON "store_coupon_issue" ("status");

-- 用户优惠券
CREATE TABLE IF NOT EXISTS "store_coupon_user" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "issue_coupon_id" INTEGER DEFAULT 0 NOT NULL,
  "coupon_title" VARCHAR(64) DEFAULT '' NOT NULL,
  "coupon_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "use_min_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "start_time" TIMESTAMP,
  "end_time" TIMESTAMP,
  "use_time" TIMESTAMP,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "receive_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "scu_uid_status_idx" ON "store_coupon_user" ("uid", "status");

-- 秒杀/拼团/砍价/积分商品 (结构相似, 简化建表)
CREATE TABLE IF NOT EXISTS "store_seckill" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "time_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "store_name" VARCHAR(256) DEFAULT '' NOT NULL,
  "image" VARCHAR(256) DEFAULT '' NOT NULL,
  "price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "ot_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "num" INTEGER DEFAULT 0 NOT NULL,
  "quota" INTEGER DEFAULT 0 NOT NULL,
  "quota_show" INTEGER DEFAULT 0 NOT NULL,
  "stock" INTEGER DEFAULT 0 NOT NULL,
  "sales" INTEGER DEFAULT 0 NOT NULL,
  "start_time" TIMESTAMP,
  "stop_time" TIMESTAMP,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "ss_time_idx" ON "store_seckill" ("time_id");

CREATE TABLE IF NOT EXISTS "store_seckill_time" (
  "id" SERIAL PRIMARY KEY,
  "start_time" VARCHAR(8) DEFAULT '' NOT NULL,
  "end_time" VARCHAR(8) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS "store_combination" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "store_name" VARCHAR(256) DEFAULT '' NOT NULL,
  "image" VARCHAR(256) DEFAULT '' NOT NULL,
  "price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "ot_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "people" INTEGER DEFAULT 2 NOT NULL,
  "num" INTEGER DEFAULT 0 NOT NULL,
  "quota" INTEGER DEFAULT 0 NOT NULL,
  "quota_show" INTEGER DEFAULT 0 NOT NULL,
  "stock" INTEGER DEFAULT 0 NOT NULL,
  "sales" INTEGER DEFAULT 0 NOT NULL,
  "start_time" TIMESTAMP,
  "stop_time" TIMESTAMP,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS "store_pink" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "order_id" VARCHAR(32) DEFAULT '' NOT NULL,
  "order_id_key" VARCHAR(32) DEFAULT '' NOT NULL,
  "combination_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "k_id" INTEGER DEFAULT 0 NOT NULL,
  "people" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "stop_time" TIMESTAMP,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "sp_combination_idx" ON "store_pink" ("combination_id");

CREATE TABLE IF NOT EXISTS "store_bargain" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "store_name" VARCHAR(256) DEFAULT '' NOT NULL,
  "image" VARCHAR(256) DEFAULT '' NOT NULL,
  "min_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "quota" INTEGER DEFAULT 0 NOT NULL,
  "quota_show" INTEGER DEFAULT 0 NOT NULL,
  "stock" INTEGER DEFAULT 0 NOT NULL,
  "sales" INTEGER DEFAULT 0 NOT NULL,
  "people" INTEGER DEFAULT 0 NOT NULL,
  "start_time" TIMESTAMP,
  "stop_time" TIMESTAMP,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS "store_integral" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "store_name" VARCHAR(256) DEFAULT '' NOT NULL,
  "image" VARCHAR(256) DEFAULT '' NOT NULL,
  "integral" INTEGER DEFAULT 0 NOT NULL,
  "price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "ot_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "quota" INTEGER DEFAULT 0 NOT NULL,
  "quota_show" INTEGER DEFAULT 0 NOT NULL,
  "stock" INTEGER DEFAULT 0 NOT NULL,
  "sales" INTEGER DEFAULT 0 NOT NULL,
  "num" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
