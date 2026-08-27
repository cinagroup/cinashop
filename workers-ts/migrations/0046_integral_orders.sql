-- Preserve pre-unification integral orders for historical lookup and migration.
-- Current application writes remain in store_order with type = 4, matching the
-- active PHP flow; these tables are not a second live order system.
CREATE TABLE IF NOT EXISTS "store_integral_order" (
  "id" SERIAL PRIMARY KEY,
  "order_id" VARCHAR(32) DEFAULT '0' NOT NULL,
  "trade_no" VARCHAR(100) DEFAULT '' NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "real_name" VARCHAR(32) DEFAULT '' NOT NULL,
  "user_phone" VARCHAR(18) DEFAULT '' NOT NULL,
  "user_address" VARCHAR(100) DEFAULT '' NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "image" VARCHAR(256) DEFAULT '' NOT NULL,
  "store_name" VARCHAR(128) DEFAULT '' NOT NULL,
  "suk" VARCHAR(128) DEFAULT '' NOT NULL,
  "unique" CHAR(8) DEFAULT '' NOT NULL,
  "cart_info" TEXT,
  "total_num" INTEGER DEFAULT 0 NOT NULL,
  "price" NUMERIC(12, 2) DEFAULT 0.00 NOT NULL,
  "total_price" NUMERIC(12, 2) DEFAULT 0.00 NOT NULL,
  "integral" INTEGER DEFAULT 0 NOT NULL,
  "total_integral" INTEGER DEFAULT 0 NOT NULL,
  "paid" SMALLINT DEFAULT 0 NOT NULL,
  "pay_time" INTEGER DEFAULT 0 NOT NULL,
  "pay_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "delivery_name" VARCHAR(64) DEFAULT '' NOT NULL,
  "delivery_code" VARCHAR(50) DEFAULT '' NOT NULL,
  "delivery_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "delivery_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "fictitious_content" VARCHAR(500) DEFAULT '' NOT NULL,
  "delivery_uid" INTEGER DEFAULT 0 NOT NULL,
  "mark" VARCHAR(512) DEFAULT '' NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "remark" VARCHAR(512) DEFAULT '' NOT NULL,
  "mer_id" INTEGER DEFAULT 0 NOT NULL,
  "is_mer_check" SMALLINT DEFAULT 0 NOT NULL,
  "is_remind" SMALLINT DEFAULT 0 NOT NULL,
  "is_system_del" SMALLINT DEFAULT 0 NOT NULL,
  "channel_type" VARCHAR(255) DEFAULT '' NOT NULL,
  "province" VARCHAR(255) DEFAULT '' NOT NULL,
  "express_dump" TEXT,
  "kuaidi_label" VARCHAR(255) DEFAULT '' NOT NULL,
  "verify_code" VARCHAR(125) DEFAULT '' NOT NULL,
  "product_type" SMALLINT DEFAULT 0 NOT NULL,
  "virtual_info" VARCHAR(255) DEFAULT '' NOT NULL,
  "custom_form" TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS "sio_order_uid_uq"
  ON "store_integral_order" ("order_id", "uid");
CREATE INDEX IF NOT EXISTS "sio_uid" ON "store_integral_order" ("uid");
CREATE INDEX IF NOT EXISTS "sio_add_time" ON "store_integral_order" ("add_time");
CREATE INDEX IF NOT EXISTS "sio_status" ON "store_integral_order" ("status");
CREATE INDEX IF NOT EXISTS "sio_is_del" ON "store_integral_order" ("is_del");
CREATE INDEX IF NOT EXISTS "sio_user_list"
  ON "store_integral_order" ("uid", "paid", "is_del", "is_system_del", "add_time", "id");

-- The PHP source is append-only and has no primary key. Keep that shape so
-- historical duplicates are not silently collapsed during migration.
CREATE TABLE IF NOT EXISTS "store_integral_order_status" (
  "oid" INTEGER DEFAULT 0 NOT NULL,
  "change_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "change_message" VARCHAR(256) DEFAULT '' NOT NULL,
  "change_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sios_oid" ON "store_integral_order_status" ("oid");
CREATE INDEX IF NOT EXISTS "sios_change_type"
  ON "store_integral_order_status" ("change_type");
CREATE INDEX IF NOT EXISTS "sios_oid_time"
  ON "store_integral_order_status" ("oid", "change_time");
