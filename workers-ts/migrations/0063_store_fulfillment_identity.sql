-- Preserve pickup stores, store staff identities, scoped delivery personnel,
-- and store-customer relationships. The PHP schema defines only ordinary
-- indexes for relationship lookups; historical duplicates therefore remain
-- importable and runtime writes serialize their own active-row checks.
CREATE TABLE IF NOT EXISTS "system_store" (
  "id" SERIAL PRIMARY KEY,
  "erp_shop_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "introduction" VARCHAR(1000) DEFAULT '' NOT NULL,
  "phone" CHAR(25) DEFAULT '' NOT NULL,
  "address" VARCHAR(255) DEFAULT '' NOT NULL,
  "province" INTEGER DEFAULT 0 NOT NULL,
  "city" INTEGER DEFAULT 0 NOT NULL,
  "area" INTEGER DEFAULT 0 NOT NULL,
  "street" INTEGER DEFAULT 0,
  "detailed_address" VARCHAR(255) DEFAULT '' NOT NULL,
  "image" VARCHAR(255) DEFAULT '' NOT NULL,
  "oblong_image" VARCHAR(255) DEFAULT '' NOT NULL,
  "latitude" CHAR(25) DEFAULT '' NOT NULL,
  "longitude" CHAR(25) DEFAULT '' NOT NULL,
  "bank_code" VARCHAR(32) DEFAULT '0' NOT NULL,
  "bank_address" VARCHAR(256) DEFAULT '' NOT NULL,
  "alipay_account" VARCHAR(64) DEFAULT '' NOT NULL,
  "alipay_qrcode_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "wechat" VARCHAR(15) DEFAULT '' NOT NULL,
  "wechat_qrcode_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "valid_time" VARCHAR(100) DEFAULT '' NOT NULL,
  "valid_range" INTEGER DEFAULT 0 NOT NULL,
  "day_time" VARCHAR(100) DEFAULT '' NOT NULL,
  "day_start" VARCHAR(20) DEFAULT '',
  "day_end" VARCHAR(20) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "is_show" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "is_store" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_store_phone"
  ON "system_store" ("phone");
CREATE INDEX IF NOT EXISTS "system_store_active_show"
  ON "system_store" ("is_del", "is_show", "id");

CREATE TABLE IF NOT EXISTS "system_store_staff" (
  "id" SERIAL PRIMARY KEY,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "account" VARCHAR(50) DEFAULT '' NOT NULL,
  "pwd" VARCHAR(100) DEFAULT '' NOT NULL,
  "avatar" VARCHAR(255) DEFAULT '' NOT NULL,
  "staff_name" VARCHAR(64) DEFAULT '' NOT NULL,
  "phone" CHAR(15) DEFAULT '' NOT NULL,
  "roles" VARCHAR(255) DEFAULT '',
  "last_ip" VARCHAR(16) DEFAULT '' NOT NULL,
  "last_time" INTEGER DEFAULT 0 NOT NULL,
  "login_count" INTEGER DEFAULT 0 NOT NULL,
  "level" SMALLINT DEFAULT 1 NOT NULL,
  "verify_status" SMALLINT DEFAULT 0 NOT NULL,
  "order_status" SMALLINT DEFAULT 1 NOT NULL,
  "is_admin" SMALLINT DEFAULT 0 NOT NULL,
  "is_manager" SMALLINT DEFAULT 0 NOT NULL,
  "is_cashier" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "notify" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_store_staff_uid_status"
  ON "system_store_staff" ("uid", "status", "is_del", "verify_status");
CREATE INDEX IF NOT EXISTS "system_store_staff_store_active"
  ON "system_store_staff" ("store_id", "is_del", "status", "id");
CREATE INDEX IF NOT EXISTS "system_store_staff_store_uid"
  ON "system_store_staff" ("store_id", "uid", "is_del", "id");

CREATE TABLE IF NOT EXISTS "delivery_service" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "avatar" VARCHAR(250) DEFAULT '' NOT NULL,
  "nickname" VARCHAR(50) DEFAULT '' NOT NULL,
  "phone" VARCHAR(20) DEFAULT '0' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL
);

CREATE INDEX IF NOT EXISTS "delivery_service_uid_status"
  ON "delivery_service" ("uid", "is_del", "status");
CREATE INDEX IF NOT EXISTS "delivery_service_scope_active"
  ON "delivery_service" ("type", "relation_id", "is_del", "status", "id");
CREATE INDEX IF NOT EXISTS "delivery_service_scope_phone"
  ON "delivery_service" ("type", "relation_id", "phone", "is_del", "id");

CREATE TABLE IF NOT EXISTS "store_user" (
  "id" SERIAL PRIMARY KEY,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "label_id" TEXT,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "store_user_store_id"
  ON "store_user" ("store_id");
CREATE INDEX IF NOT EXISTS "store_user_uid"
  ON "store_user" ("uid");
CREATE INDEX IF NOT EXISTS "store_user_store_uid_status"
  ON "store_user" ("store_id", "uid", "status", "id");
